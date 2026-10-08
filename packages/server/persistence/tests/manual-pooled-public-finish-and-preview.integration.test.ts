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
import { reviewRaceManualPublicIn } from '../src/race-manual-public.js';
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
import { installCurrentRuntimeV5 } from '../src/current-runtime-installation-v5.js';
import { grantCurrentRuntimeV5Profile } from '../src/current-runtime-grants-v5.js';
import * as baseline from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual PG only. Public synthetic sources, no private health/event seed.
// Account row is the identity-only foreign-key prerequisite, not source authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_public138_${suffix}`,
  ownerRole = `pooled_public138_owner_${suffix}`,
  runtimeRole = `pooled_public138_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database;
let athlete: string, foreign: string;
let intent: z.infer<typeof raceManualPublicPrepareSchema>['intent'];
let predecessorMetadata: unknown;
const migration = await readFile(
  new URL('../migrations/138_manual_pooled_public_finish_and_preview.sql', import.meta.url),
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
const appRecipe = [
  baseline.grantIdentityFunctions,
  baseline.grantAiSettings,
  baseline.grantOperations,
  baseline.grantNutritionCore,
  baseline.grantSupplementaryCore,
  baseline.grantRoutineCore,
  baseline.grantStretchingCore,
  baseline.grantRecoveryCore,
  baseline.grantCheckIns,
  baseline.grantSessionCompletions,
  baseline.grantPlanScenarios,
  baseline.grantCoachingConstraints,
  baseline.grantCoachingThreads,
  baseline.grantCoreEvidenceSnapshots,
  baseline.grantCoachingRuns,
  baseline.grantCoachingCandidates,
  baseline.grantIntegratedApprovalV4,
  baseline.grantResources,
  baseline.grantResourceRetrieval,
  baseline.grantGalleryMedia,
  baseline.grantActivityTracks,
  baseline.grantCourses,
  baseline.grantRaces,
  baseline.grantCorePlanning,
  baseline.grantGarmin,
  baseline.grantGarminUnofficial,
];

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
  await installCurrentRuntimeV5(url(ownerRole));
  for (const grant of appRecipe) await grant(url(ownerRole), runtimeRole);
  await grantCurrentRuntimeV5Profile(url(ownerRole), runtimeRole);
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
    ])
      await p.query(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'));
    predecessorMetadata = (await p.query(metadataSql)).rows[0]?.['value'];
    await p.query(migration);
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb), public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb), public.finish_race_manual_pooled_public_review_v1(text,jsonb,uuid), public.read_race_manual_pooled_public_preview_source_v1(uuid) TO "${runtimeRole}"`,
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
      localStartTime: null,
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
  await nutrition.savePlan(athlete, {
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
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
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
  });
}, 180000);
afterAll(async () => {
  await pending;
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 30000);
const oldSignatures = [
  'public.finish_race_manual_public_review_v1(text,jsonb,uuid)',
  'public.read_race_manual_public_preview_source_v1(uuid)',
];
const newSignatures = [
  'public.finish_race_manual_pooled_public_review_v1(text,jsonb,uuid)',
  'public.read_race_manual_pooled_public_preview_source_v1(uuid)',
];
const metadataSql = `SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_catalog.pg_proc p WHERE p.oid IN ('public.finish_race_manual_public_review_v1(text,jsonb,uuid)'::regprocedure,'public.read_race_manual_public_preview_source_v1(uuid)'::regprocedure)`;
async function snapshot<T>(apply: (tx: Transaction) => Promise<T>, tenant = athlete) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(tenant, apply);
}
async function value(tx: Transaction, expression: string, args: unknown[]) {
  return (await tx.query(`SELECT ${expression} AS value`, args)).rows[0]?.['value'];
}
async function reject(tx: Transaction, action: () => Promise<unknown>, error: string) {
  await tx.query('SAVEPOINT malformed');
  try {
    await expect(action()).rejects.toThrow(error);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT malformed');
    await tx.query('RELEASE SAVEPOINT malformed');
  }
}
type Ref = z.infer<typeof raceManualStoredApprovalReferenceSchema>;
const records: { mode: 'legacy' | 'pooled'; key: string; reference: Ref }[] = [];
async function createReview(tx: Transaction, mode: 'legacy' | 'pooled') {
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
  const reference = raceManualStoredApprovalReferenceSchema.parse(
    await value(
      tx,
      'public.finish_race_manual_pooled_public_review_v1($1::text,$2::jsonb,$3::uuid)',
      [key, JSON.stringify(command), stored.candidate.candidateId],
    ),
  );
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
  expect(
    await value(tx, 'public.read_race_manual_public_receipt_v1($1::text,$2::text,$3::jsonb)', [
      'review',
      key,
      JSON.stringify(command),
    ]),
  ).toEqual(reference);
  records.push({ mode, key, reference });
  return { reference, command };
}
fixtureIt(
  'preserves both final historical OIDs/body/config/ACL and owner-only named successors',
  async () => {
    await owner(async (p) => {
      expect((await p.query(metadataSql)).rows[0]?.['value']).toEqual(predecessorMetadata);
      const raw = (
        await p.query(
          `SELECT p.proname AS name,p.prosecdef AS definer,p.prokind AS kind,p.proisstrict AS strict,p.proleakproof AS leakproof,p.proparallel::text AS parallel,p.proconfig AS config,p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,has_function_privilege('public',p.oid,'EXECUTE') AS public_execute FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY p.proname`,
          [newSignatures],
        )
      ).rows;
      expect(raw).toHaveLength(2);
      for (const r of raw)
        expect(r).toMatchObject({
          definer: true,
          kind: 'f',
          strict: false,
          leakproof: false,
          parallel: 'u',
          config: ['search_path=pg_catalog, pg_temp'],
          owned: true,
          public_execute: false,
        });
    });
  },
);
fixtureIt(
  'genuine legacy review uses unchanged provenance and returns full retained envelope once',
  async () => {
    await snapshot((tx) => createReview(tx, 'legacy').then(() => undefined));
  },
);
fixtureIt(
  'genuine pooled review keeps original reference and strict decoded frozen public projection',
  async () => {
    await snapshot((tx) => createReview(tx, 'pooled').then(() => undefined));
  },
);
fixtureIt('foreign and absent candidate reads are null, never a fabricated purge', async () => {
  const record = records.find((r) => r.mode === 'pooled');
  if (!record) throw Error('MISSING_FIXTURE');
  await snapshot(async (tx) => {
    expect(
      await value(tx, 'public.read_race_manual_pooled_public_preview_source_v1($1::uuid)', [
        record.reference.candidateId,
      ]),
    ).toBeNull();
    expect(
      await value(tx, 'public.read_race_manual_pooled_public_preview_source_v1($1::uuid)', [
        randomUUID(),
      ]),
    ).toBeNull();
  }, foreign);
});
fixtureIt(
  'existing stored candidates cannot be freshly attached to a new public key in a later xid',
  async () => {
    const r = records[0];
    if (!r) throw Error('MISSING_FIXTURE');
    await snapshot(async (tx) => {
      const key = randomUUID();
      await reject(
        tx,
        () =>
          value(
            tx,
            'public.finish_race_manual_pooled_public_review_v1($1::text,$2::jsonb,$3::uuid)',
            [
              key,
              JSON.stringify({ schemaVersion: 1, idempotencyKey: key, intent }),
              r.reference.candidateId,
            ],
          ),
        'RACE_MANUAL_PUBLIC_PROVENANCE_INVALID',
      );
    });
  },
);
fixtureIt(
  'public command/private extra fields and changed stable-key intent are rejected',
  async () => {
    const r = records[0];
    if (!r) throw Error('MISSING_FIXTURE');
    await snapshot(async (tx) => {
      await reject(
        tx,
        () =>
          value(
            tx,
            'public.finish_race_manual_pooled_public_review_v1($1::text,$2::jsonb,$3::uuid)',
            [
              r.key,
              JSON.stringify({
                schemaVersion: 1,
                idempotencyKey: r.key,
                intent,
                privateBasis: true,
              }),
              r.reference.candidateId,
            ],
          ),
        'RACE_MANUAL_INVALID_COMMAND',
      );
      await reject(
        tx,
        () =>
          value(
            tx,
            'public.finish_race_manual_pooled_public_review_v1($1::text,$2::jsonb,$3::uuid)',
            [
              r.key,
              JSON.stringify({
                schemaVersion: 1,
                idempotencyKey: r.key,
                intent: { ...intent, newLocalDate: '2026-10-09' },
              }),
              r.reference.candidateId,
            ],
          ),
        'RACE_MANUAL_IDEMPOTENCY_CONFLICT',
      );
      await reject(
        tx,
        () =>
          value(tx, 'public.read_race_manual_pooled_public_preview_source_v1($1::uuid)', [null]),
        'RACE_MANUAL_PUBLIC_PREVIEW_INVALID_INPUT',
      );
    });
  },
);
fixtureIt('raw runtime table writes and migration installation remain denied', async () => {
  await snapshot(async (tx) => {
    await reject(
      tx,
      () => tx.query('UPDATE public.manual_race_evidence_v2 SET payload=NULL'),
      'permission denied',
    );
    await reject(tx, () => tx.query(migration), 'POOLED_PUBLIC_INSTALL_OWNER_REQUIRED');
  });
});
fixtureIt('double installation preserves both old and new function metadata', async () => {
  await owner(async (p) => {
    const before = (
      await p.query(
        `SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])`,
        [[...oldSignatures, ...newSignatures]],
      )
    ).rows[0]?.['value'];
    await expect(p.query(migration)).rejects.toThrow('POOLED_PUBLIC_ALREADY_INSTALLED');
    expect(
      (
        await p.query(
          `SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])`,
          [[...oldSignatures, ...newSignatures]],
        )
      ).rows[0]?.['value'],
    ).toEqual(before);
  });
});
for (const drift of [
  'ALTER FUNCTION public.read_race_manual_public_preview_source_v1(uuid) IMMUTABLE',
  'ALTER FUNCTION public.finish_race_manual_public_review_v1(text,jsonb,uuid) SET search_path=public',
  'ALTER FUNCTION wm_manual_pooled.lookup(jsonb,text) STRICT',
]) {
  fixtureIt(
    `exact predecessor/resolver drift rolls back the whole pair: ${drift.split(' ').at(-1)}`,
    async () => {
      await owner(async (p) => {
        const client = await p.connect();
        try {
          await client.query('BEGIN');
          for (const signature of newSignatures) await client.query(`DROP FUNCTION ${signature}`);
          await client.query(drift);
          await client.query('SAVEPOINT install');
          await expect(client.query(migration)).rejects.toThrow(
            /POOLED_PUBLIC_PREDECESSOR_MISMATCH|POOLED_PROTOCOL_RESOLVER_MISMATCH/,
          );
          await client.query('ROLLBACK TO SAVEPOINT install');
          expect(
            (
              await client.query(
                'SELECT to_regprocedure($1) IS NULL AS absent,to_regprocedure($2) IS NULL AS second_absent',
                newSignatures,
              )
            ).rows[0],
          ).toEqual({ absent: true, second_absent: true });
        } finally {
          try {
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        }
      });
    },
  );
}
fixtureIt(
  'withdrawal keeps original minimal receipts and retained mixed previews without new processing',
  async () => {
    expect(records.map((r) => r.mode)).toEqual(['legacy', 'pooled']);
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      for (const r of records) {
        const command = { schemaVersion: 1, idempotencyKey: r.key, intent };
        expect(
          await value(
            tx,
            'public.finish_race_manual_pooled_public_review_v1($1::text,$2::jsonb,$3::uuid)',
            [r.key, JSON.stringify(command), r.reference.candidateId],
          ),
        ).toEqual(r.reference);
        expect(
          await value(tx, 'public.read_race_manual_pooled_public_preview_source_v1($1::uuid)', [
            r.reference.candidateId,
          ]),
        ).toMatchObject({ bodyState: 'present', reference: r.reference });
      }
      await reject(
        tx,
        () =>
          reviewRaceManualPublicIn(tx, { schemaVersion: 1, idempotencyKey: randomUUID(), intent }),
        'APP_CONSENT_REQUIRED',
      );
    });
  },
);
fixtureIt(
  'genuine race deletion purges encoded/legacy envelopes together and preserves original replay',
  async () => {
    expect(records.map((r) => r.mode)).toEqual(['legacy', 'pooled']);
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    await createRaceRepository(db).deleteRaceEvent(athlete, intent.expectedEvent.id, {
      expectedRevision: intent.expectedEvent.revision,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      for (const r of records) {
        expect(
          await value(tx, 'public.read_race_manual_pooled_public_preview_source_v1($1::uuid)', [
            r.reference.candidateId,
          ]),
        ).toEqual({
          readerVersion: 2,
          reference: r.reference,
          bodyState: 'purged',
          candidate: null,
          payloadEncoding: null,
          payload: null,
        });
        expect(
          await value(
            tx,
            'public.finish_race_manual_pooled_public_review_v1($1::text,$2::jsonb,$3::uuid)',
            [
              r.key,
              JSON.stringify({ schemaVersion: 1, idempotencyKey: r.key, intent }),
              r.reference.candidateId,
            ],
          ),
        ).toEqual(r.reference);
      }
    });
  },
);
