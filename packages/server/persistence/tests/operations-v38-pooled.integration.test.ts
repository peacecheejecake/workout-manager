import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { prepareRaceManualApprovalIn } from '../src/race-manual-approval.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { raceManualPublicPrepareSchema } from '@workout/contracts/race-manual-public';
import {
  raceManualStoredApprovalReadSchema,
  raceManualStoredApprovalReferenceSchema,
} from '../src/race-manual-same-tx-approval-continuation.js';
import {
  storeRaceManualReviewChainV2In,
  raceManualReviewMultiOwnedChainReadV3Schema,
} from '../src/race-manual-review-chain-v2.js';
import { decodeRaceManualReviewPooledDatabaseEnvelopeV1 } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { projectRaceManualPublicPreview } from '../src/race-manual-public-preview.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import { toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { installCurrentRuntimeV7 } from '../src/current-runtime-installation-v7.js';
import { grantCurrentRuntimeV7Profile } from '../src/current-runtime-grants-v7.js';
import * as baseline from '../src/migrate.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { createOperationsV38PooledRepository } from '../src/operations.js';
import { readManualPooledPersonalExportBatchV1In } from '../src/manual-pooled-personal-export-batch-reader-v1.js';
import { parseAccountExportV38 } from '@workout/contracts/operations';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual PG only. Public synthetic sources, no private health/event seed.
// Account row is the identity-only foreign-key prerequisite, not source authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `operations_v38_pooled_${suffix}`,
  ownerRole = `operations_v38_pooled_owner_${suffix}`,
  runtimeRole = `operations_v38_pooled_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database;
let athlete: string, foreign: string;
let intent: z.infer<typeof raceManualPublicPrepareSchema>['intent'];

const migration = await readFile(
  new URL('../migrations/139_manual_pooled_personal_export_batch.sql', import.meta.url),
  'utf8',
);
let pending: Promise<void> = Promise.resolve();
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function owner<T>(apply: (p: Pool) => Promise<T>) {
  const p = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    return await apply(p);
  } finally {
    await p.end();
  }
}
// Pool.query releases a failed client. Transactional negative cases must retain
// one acquired connection through expected errors and rollback assertions.
function fixtureIt(label: string, apply: () => Promise<void>) {
  it(
    label,
    async () => {
      const work = pending.then(apply);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    30000,
  );
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await baseline.migrate(url(ownerRole), 107);
  await installCurrentRuntimeV7(url(ownerRole));
  await grantCurrentRuntimeAppBaselineV2(url(ownerRole), runtimeRole, 'core');
  await grantCurrentRuntimeV7Profile(url(ownerRole), runtimeRole);
  await owner(async (p) => {
    await p.query(
      await readFile(
        new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  await owner(async (p) => {
    for (const filename of [
      '135_manual_pooled_store_and_basis.sql',
      '136_manual_pooled_chain_reader_and_ack.sql',
      '137_manual_pooled_application.sql',
      '138_manual_pooled_public_finish_and_preview.sql',
    ])
      await p.query(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'));
    await p.query(migration);
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb), public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb), public.finish_race_manual_pooled_public_review_v1(text,jsonb,uuid), public.read_race_manual_pooled_public_preview_source_v1(uuid), public.read_manual_race_pooled_personal_export_batch_v1(integer) TO "${runtimeRole}"`,
    );
  });
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  athlete = randomUUID();
  await owner((p) =>
    p.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    ),
  );
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic pooled store',
      localDate: '2026-10-06',
      localStartTime: '08:00',
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
  intent = {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' },
    resolutions: { nutrition: [], routines: [] },
  };
  foreign = randomUUID();
  await owner((p) =>
    p.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [foreign, foreign],
    ),
  );
  const nutrition = createNutritionRepository(db);
  const datum = <const U extends string>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: ['順序B', '順序A'],
  });
  const food = await nutrition.saveFood(athlete, {
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    confirmed: true,
    definition: {
      foodId: '食/opaque-𐀀',
      name: 'Synthetic food',
      basis: { kind: 'per_100g' },
      nutrients: {
        energy: datum('kcal'),
        carbohydrate: datum('g'),
        protein: datum('g'),
        fat: datum('g'),
        fluid: datum('mL'),
        sodium: datum('mg'),
      },
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-10-07T00:00:00Z',
        reviewState: 'unreviewed',
      },
    },
  });
  await createNutritionRacePlanWriter(db).savePlanV2(athlete, {
    schemaVersion: 2,
    command: {
      kind: 'create',
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: {
        period: { from: '2026-10-01', toInclusive: '2026-10-31' },
        timezone: 'Asia/Seoul',
        purpose: 'Synthetic plan only',
        linkedTrainingPlanVersionId: null,
        items: [
          {
            id: 'opaque/item',
            category: 'meal',
            title: 'Synthetic meal',
            anchor: {
              kind: 'relative',
              entity: 'race',
              entityId: race.id,
              point: 'start',
              offsetMinutes: -30,
            },
            foods: [
              {
                foodVersionId: food.versionId,
                description: 'zero',
                quantity: 0,
                unit: 'g',
                sourceBasis: 'per_100g',
              },
              {
                foodVersionId: null,
                description: 'unknown',
                quantity: null,
                unit: 'unspecified',
                sourceBasis: 'unknown',
              },
            ],
            targets: [],
            instructions: 'Not actual intake',
            evidenceIds: [],
            source: 'user_confirmed',
          },
        ],
      },
    },
    expectedRaceHeads: [{ namespace: 'race-event', eventId: race.id, revision: race.revision }],
  });
}, 180000);
afterAll(async () => {
  await pending;
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 30000);
async function snapshot<T>(apply: (tx: Transaction) => Promise<T>, tenant = athlete) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(tenant, apply);
}
async function value(tx: Transaction, expression: string, args: unknown[]) {
  return (await tx.query(`SELECT ${expression} AS value`, args)).rows[0]?.['value'];
}
type Ref = z.infer<typeof raceManualStoredApprovalReferenceSchema>;
const records: { mode: 'legacy' | 'pooled'; published: boolean; key: string; reference: Ref }[] =
  [];
async function createReview(
  tx: Transaction,
  mode: 'legacy' | 'pooled',
  published = true,
  chainOnly = false,
) {
  const key = randomUUID();
  const normalized = raceManualPublicPrepareSchema.parse({ schemaVersion: 1, intent });
  const command = Object.freeze({ ...normalized, idempotencyKey: key });
  // The public namespace uses the actual PostgreSQL JSONB canonical algorithm.
  // It is fixed before generating internal rows and reused after rollback.
  const namespace = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(
      await value(
        tx,
        "encode(sha256(convert_to(jsonb_build_object('tenant',$1::text,'operation','review','publicKey',$2::text)::text,'UTF8')),'hex')",
        [tx.athleteId, key],
      ),
    );
  const internalKey = `race_public_review_v1_${namespace}`;
  // Trusted internal use cases derive all candidate/basis/retained facts from
  // actual public sources. Public finish122 is deliberately NOT invoked inside
  // a SAVEPOINT: its exact top-xid xmin guard rightly rejects child tuples.
  await tx.query('SAVEPOINT genuine_candidate');
  const budget = { bytes: 0n, sources: 0 };
  const current = await prepareRaceManualSemanticBasisV2In(tx, command.intent, null, budget);
  if (current.status !== 'current_dependencies_captured') throw Error('GENUINE_BASIS_UNAVAILABLE');
  const originalChain = await storeRaceManualReviewChainV2In(
    tx,
    {
      schemaVersion: 2,
      idempotencyKey: internalKey,
      intent: command.intent,
      expectedBasis: current.basis,
    },
    budget,
  );
  if (originalChain.status === 'blocked') throw Error('GENUINE_CHAIN_UNAVAILABLE');
  const application = await prepareRaceManualApprovalIn(
    tx,
    {
      schemaVersion: 1,
      chain: {
        evidenceId: originalChain.result.evidenceId,
        decisionId: originalChain.result.decisionId,
        proposalId: originalChain.result.proposalId,
        readonlyCandidateDigest: originalChain.result.candidateDigest,
      },
      intent: command.intent,
      expectedBasis: current.basis,
    },
    budget,
  );
  if (application.status !== 'prepared') throw Error('GENUINE_APPLICATION_UNAVAILABLE');
  const stored = raceManualStoredApprovalReadSchema.parse(
    await value(tx, 'public.read_race_manual_public_candidate_v1($1::uuid)', [
      application.candidate.candidateId,
    ]),
  );
  const chain = raceManualReviewMultiOwnedChainReadV3Schema.parse(
    await value(tx, 'public.read_manual_race_chain_v2($1::uuid)', [
      originalChain.result.evidenceId,
    ]),
  );
  if (stored.bodyState !== 'present' || chain.payload?.state !== 'present')
    throw Error('GENUINE_BODY_UNAVAILABLE');
  await tx.query('ROLLBACK TO SAVEPOINT genuine_candidate');
  await tx.query('RELEASE SAVEPOINT genuine_candidate');
  const request = {
    schemaVersion: 2,
    idempotencyKey: internalKey,
    intent: command.intent,
    expectedBasis: stored.basis,
  };
  const payload = mode === 'pooled' ? toDatabase(encode(chain.payload)) : chain.payload;
  const storeName =
    mode === 'pooled'
      ? 'store_manual_race_pooled_chain_v1'
      : 'store_manual_race_multi_owned_chain_v3';
  expect(
    await value(
      tx,
      `public.${storeName}($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [
        chain.result.evidenceId,
        chain.result.decisionId,
        chain.result.proposalId,
        internalKey,
        JSON.stringify(request),
        JSON.stringify(payload),
        JSON.stringify(stored.basis),
        JSON.stringify(stored.lifecycle),
      ],
    ),
  ).toMatchObject({ ...chain.result, createdAt: expect.any(String) });
  if (chainOnly) return { reference: stored.reference, command };
  const prepareName =
    mode === 'pooled'
      ? 'prepare_race_manual_pooled_application_v1'
      : 'prepare_race_manual_application_v1';
  expect(
    await value(tx, `public.${prepareName}($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb)`, [
      JSON.stringify(stored.candidate),
      JSON.stringify(stored.basis),
      JSON.stringify(payload),
      JSON.stringify(stored.lifecycle),
    ]),
  ).toEqual(stored.candidate);
  const reference = published
    ? raceManualStoredApprovalReferenceSchema.parse(
        await value(
          tx,
          'public.finish_race_manual_pooled_public_review_v1($1::text,$2::jsonb,$3::uuid)',
          [key, JSON.stringify(command), stored.candidate.candidateId],
        ),
      )
    : stored.reference;
  expect(reference).toEqual(stored.reference);
  const result = await value(
    tx,
    'public.read_race_manual_pooled_public_preview_source_v1($1::uuid)',
    [reference.candidateId],
  );
  const output = z
    .strictObject({
      readerVersion: z.literal(2),
      reference: raceManualStoredApprovalReferenceSchema,
      bodyState: z.literal('present'),
      candidate: raceManualStoredApprovalReadSchema.options[0].shape.candidate,
      payloadEncoding: z.enum(['legacy-retained-v2', 'pooled-database-envelope-v1']),
      payload: z.unknown(),
    })
    .parse(result);
  expect(output.payloadEncoding).toBe(
    mode === 'pooled' ? 'pooled-database-envelope-v1' : 'legacy-retained-v2',
  );
  expect(output.payload).toEqual(payload);
  expect(output.candidate).toEqual(stored.candidate);
  const logical =
    mode === 'pooled'
      ? decodeRaceManualReviewPooledDatabaseEnvelopeV1(output.payload)
      : chain.payload;
  expect(logical).toEqual(chain.payload);
  if (logical.state !== 'present') throw Error('BODY_UNAVAILABLE');
  const preview = projectRaceManualPublicPreview({
    reference,
    bodyState: 'present',
    candidate: output.candidate,
    preparation: logical.payload.preparation,
  });
  expect(preview.status).toBe('present');
  if (published) {
    expect(
      await value(tx, 'public.read_race_manual_public_receipt_v1($1::text,$2::text,$3::jsonb)', [
        'review',
        key,
        JSON.stringify(command),
      ]),
    ).toEqual(reference);
  }
  records.push({ mode, published, key, reference });
  return { reference, command };
}

async function auditCount() {
  return owner(async (p) => {
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      const n = z
        .number()
        .int()
        .parse(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM public.operations_audit WHERE athlete_id=$1 AND action='export_requested'",
              [athlete],
            )
          ).rows[0]?.['n'],
        );
      await c.query('ROLLBACK');
      return n;
    } finally {
      c.release();
    }
  });
}
fixtureIt(
  'genuine legacy/pooled/public/internal-only census exports once with one audit and no old full-body RPC',
  async () => {
    await snapshot(async (tx) => {
      await createReview(tx, 'legacy');
      await createReview(tx, 'pooled');
      await createReview(tx, 'pooled', false);
      await createReview(tx, 'pooled', false, true);
    });
    const before = await auditCount(),
      calls: string[] = [];
    const wrapped: Database = {
      ...db,
      snapshotTenant: async (t, apply) => {
        if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
        return db.snapshotTenant(t, (tx) =>
          apply({
            ...tx,
            query: async (sql, args) => {
              calls.push(sql);
              return tx.query(sql, args);
            },
          }),
        );
      },
    };
    const result = parseAccountExportV38(
      await createOperationsV38PooledRepository(wrapped).exportAccount(athlete),
    );
    expect(result.data.manualInternalChains).toHaveLength(4);
    expect(result.data.manualInternalCandidates).toHaveLength(3);
    expect(result.data.manualRaceReviews).toHaveLength(2);
    expect(result.data.manualSourceChains).toHaveLength(4);
    expect(result.data.manualSavedSourceRefs.length).toBeGreaterThan(4);
    expect(await auditCount()).toBe(before + 1);
    expect(
      calls.filter(
        (s) =>
          s.includes('AS source') &&
          s.includes('read_manual_race_pooled_personal_export_batch_v1($1'),
      ),
    ).toHaveLength(1);
    expect(
      calls.some((s) =>
        /read_(?:race_manual_personal_export|manual_race_internal_personal_export|manual_race_retained_source_batch)_v1\(\$/.test(
          s,
        ),
      ),
    ).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(8388608);
  },
);
fixtureIt('foreign own empty census has no retained bodies from another tenant', async () => {
  const result = await createOperationsV38PooledRepository(db).exportAccount(foreign);
  expect(result.data.manualInternalChains).toEqual([]);
  expect(result.data.manualRaceReviews).toEqual([]);
  expect(result.data.manualSavedSourceRefs).toEqual([]);
});
fixtureIt('actual response cap and required RR reject without success audit', async () => {
  const before = await auditCount();
  await expect(
    snapshot((tx) => readManualPooledPersonalExportBatchV1In(tx, 1024)),
  ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  await expect(
    db.tenant(athlete, (tx) => readManualPooledPersonalExportBatchV1In(tx)),
  ).rejects.toMatchObject({ code: 'CORRUPT' });
  expect(await auditCount()).toBe(before);
});
fixtureIt('shared measured exhaustion rolls back the whole account export/audit', async () => {
  const before = await auditCount();
  const wrapped: Database = {
    ...db,
    snapshotTenant: async (t, apply) => {
      if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
      return db.snapshotTenant(t, (tx) =>
        apply({
          ...tx,
          query: async (sql, args) => {
            if (sql.includes('read_manual_race_pooled_personal_export_batch_v1($1'))
              return tx.query(sql, [1]);
            return tx.query(sql, args);
          },
        }),
      );
    },
  };
  await expect(
    createOperationsV38PooledRepository(wrapped).exportAccount(athlete),
  ).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  expect(await auditCount()).toBe(before);
});
fixtureIt(
  'RR read remains old while genuine source deletion is blocked, then purged export keeps original receipts',
  async () => {
    const race = await createRaceRepository(db).getRaceEvent(athlete, intent.expectedEvent.id);
    if (!race) throw Error('MISSING_RACE');
    const deleting = createDatabase({ connectionString: url(runtimeRole), max: 1 });
    let deletion: Promise<unknown> | undefined;
    let deleted = false;
    const wrapped: Database = {
      ...db,
      snapshotTenant: async (t, apply) => {
        if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
        return db.snapshotTenant(t, async (tx) => {
          const result = await apply({
            ...tx,
            query: async (sql, args) => {
              const row = await tx.query(sql, args);
              if (sql.includes('read_manual_race_pooled_personal_export_batch_v1($1')) {
                deletion = createRaceRepository(deleting)
                  .deleteRaceEvent(athlete, race.id, {
                    expectedRevision: race.revision,
                    idempotencyKey: randomUUID(),
                  })
                  .then((v) => {
                    deleted = true;
                    return v;
                  });
                // pg_locks is public metadata; unlike wait_event_type, its wait is
                // visible to a plain owner observing another runtime role.
                // Keep the writer blocked until the original RR export commits.
                await owner(async (p) => {
                  for (let i = 0; i < 200; i++) {
                    const n = z
                      .number()
                      .parse(
                        (
                          await p.query(
                            "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.usename=$1 AND l.locktype='advisory' AND NOT l.granted",
                            [runtimeRole],
                          )
                        ).rows[0]?.['n'],
                      );
                    if (n > 0) return;
                  }
                  throw Error('WRITER_NOT_BLOCKED');
                });
                expect(deleted).toBe(false);
              }
              return row;
            },
          });
          return result;
        });
      },
    };
    try {
      const old = await createOperationsV38PooledRepository(wrapped).exportAccount(athlete);
      expect(old.data.manualRaceReviews.every((r) => r.bodyState === 'present')).toBe(true);
      if (!deletion) throw Error('DELETION_NOT_STARTED');
      await deletion;
      const purged = await createOperationsV38PooledRepository(db).exportAccount(athlete);
      expect(
        purged.data.manualRaceReviews.every((r) => r.bodyState === 'purged' && r.preview === null),
      ).toBe(true);
      expect(purged.data.manualInternalChains.every((c) => c.body.state === 'purged')).toBe(true);
      expect(purged.data.manualRaceCommandResults).toEqual(old.data.manualRaceCommandResults);
      expect(
        purged.data.manualSavedSourceRefs.every(
          (r) => r.location.state === 'unavailable' && r.location.reason === 'payload_purged',
        ),
      ).toBe(true);
    } finally {
      if (deletion) await deletion;
      await deleting.close();
    }
  },
);
fixtureIt(
  'app withdrawal keeps purged immutable history export and original public receipt facts',
  async () => {
    const old = await createOperationsV38PooledRepository(db).exportAccount(athlete);
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const next = await createOperationsV38PooledRepository(db).exportAccount(athlete);
    expect(next.data.manualInternalChains).toEqual(old.data.manualInternalChains);
    expect(next.data.manualRaceCommandResults).toEqual(old.data.manualRaceCommandResults);
    expect(next.data.manualSavedSourceSuppressions).toEqual(old.data.manualSavedSourceSuppressions);
  },
);
fixtureIt('missing execute capability has no old-reader fallback and no audit', async () => {
  const before = await auditCount();
  await owner((p) =>
    p.query(
      `REVOKE EXECUTE ON FUNCTION public.read_manual_race_pooled_personal_export_batch_v1(integer) FROM "${runtimeRole}"`,
    ),
  );
  try {
    await expect(
      createOperationsV38PooledRepository(db).exportAccount(athlete),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(await auditCount()).toBe(before);
  } finally {
    await owner((p) =>
      p.query(
        `GRANT EXECUTE ON FUNCTION public.read_manual_race_pooled_personal_export_batch_v1(integer) TO "${runtimeRole}"`,
      ),
    );
  }
});
