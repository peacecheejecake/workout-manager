import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { prepareRaceManualApprovalIn } from '../src/race-manual-approval.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { reviewRaceManualPublicIn, approveRaceManualPublicIn } from '../src/race-manual-public.js';
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
import {
  raceManualInternalPersonalExportSourceSchema,
  renderRaceManualInternalPersonalExport,
} from '../src/race-manual-internal-personal-export-renderer.js';
import {
  manualSourcePersonalExportRawSchemaV1,
  mapManualSourcePersonalExportV1,
} from '../src/manual-source-personal-export.js';
import { raceManualReviewRetainedPayloadV2Schema } from '../src/race-manual-review-retained-payload-v2.js';
import { createOperationsRepository } from '../src/operations.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual PG only. Public synthetic sources, no private health/event seed.
// Account row is the identity-only foreign-key prerequisite, not source authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_export139_${suffix}`,
  ownerRole = `pooled_export139_owner_${suffix}`,
  runtimeRole = `pooled_export139_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database;
let athlete: string, foreign: string;
let intent: z.infer<typeof raceManualPublicPrepareSchema>['intent'];
let predecessorMetadata: unknown;
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
async function ownerConnection<T>(apply: (client: PoolClient) => Promise<T>) {
  return owner(async (pool) => {
    const client = await pool.connect();
    try {
      return await apply(client);
    } finally {
      client.release();
    }
  });
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
    predecessorMetadata = (await p.query(metadataSql)).rows[0]?.['value'];
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
const oldSignatures = [
  'public.read_race_manual_personal_export_v1(integer)',
  'public.read_manual_race_internal_personal_export_v1(integer)',
  'public.read_manual_race_source_personal_export_v1(integer)',
  'public.read_manual_race_retained_source_batch_v1(integer)',
];
const newSignatures = [
  'wm_manual_pooled.read_internal_export_v2(integer)',
  'wm_manual_pooled.read_public_export_metadata_v2(integer)',
  'public.read_manual_race_pooled_personal_export_batch_v1(integer)',
];
const metadataSql = `SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_catalog.pg_proc p WHERE p.oid=ANY(ARRAY['public.read_race_manual_personal_export_v1(integer)'::regprocedure,'public.read_manual_race_internal_personal_export_v1(integer)'::regprocedure,'public.read_manual_race_source_personal_export_v1(integer)'::regprocedure,'public.read_manual_race_retained_source_batch_v1(integer)'::regprocedure])`;
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
const old = raceManualInternalPersonalExportSourceSchema;
const chainCommon = old.shape.chains.element.options[0].omit({
  preparation: true,
  bodyState: true,
  purge: true,
});
const wireChain = z.discriminatedUnion('bodyState', [
  chainCommon.extend({
    bodyState: z.literal('present'),
    payloadEncoding: z.enum(['legacy-retained-v2', 'pooled-database-envelope-v1']),
    payload: z.unknown(),
    purge: z.null(),
  }),
  chainCommon.extend({
    bodyState: z.literal('purged'),
    payloadEncoding: z.null(),
    payload: z.null(),
    purge: old.shape.chains.element.options[1].shape.purge,
  }),
]);
const binding = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('present'),
    digestMethod: z.literal('postgres-retained-envelope-jsonb-v1'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    state: z.literal('purged'),
    digestMethod: z.literal('postgres-retained-envelope-jsonb-v1'),
    digest: z.null(),
  }),
]);
const batchSchema = z.strictObject({
  batchVersion: z.literal(2),
  internal: old.extend({ schemaVersion: z.literal(2), chains: z.array(wireChain).max(1000) }),
  sourceMetadata: manualSourcePersonalExportRawSchemaV1.extend({
    schemaVersion: z.literal(2),
    chains: z
      .array(
        manualSourcePersonalExportRawSchemaV1.shape.chains.element
          .omit({ preparation: true })
          .extend({ payloadBinding: binding }),
      )
      .max(1000),
  }),
  publicMetadata: z.strictObject({
    schemaVersion: z.literal(2),
    status: z.literal('ready'),
    sources: z
      .array(
        z.strictObject({
          candidateId: z.uuid(),
          evidenceId: z.uuid(),
          reference: raceManualStoredApprovalReferenceSchema,
          bodyState: z.enum(['present', 'purged']),
        }),
      )
      .max(1000),
    approvalHistory: old.shape.approvalHistory,
    commandResults: z.array(z.unknown()).max(1000),
    trainingAggregateMappings: z
      .array(z.strictObject({ version_id: z.uuid(), aggregate_id: z.uuid() }))
      .max(1000),
  }),
});
async function verifyBindings(batch: z.infer<typeof batchSchema>) {
  await owner(async (p) => {
    const client = await p.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      const bindings = z
        .array(
          z.strictObject({
            evidenceId: z.uuid(),
            digest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          }),
        )
        .parse(
          (
            await client.query(
              `SELECT e.id AS "evidenceId",CASE WHEN e.payload IS NULL THEN NULL ELSE encode(sha256(convert_to(e.payload::text,'UTF8')),'hex') END AS digest FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=$1::text ORDER BY e.id`,
              [athlete],
            )
          ).rows,
        );
      expect(bindings).toHaveLength(batch.sourceMetadata.chains.length);
      for (const chain of batch.sourceMetadata.chains) {
        expect(chain.payloadBinding.digest).toBe(
          bindings.find((b) => b.evidenceId === chain.evidenceId)?.digest,
        );
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
}
// Runtime has no private table SELECT. Measure the response normally; source
// digest comparison independently uses owner-only actual physical rows.
async function runtimeBatch(tx: Transaction, limit = 8388608) {
  const row = z
    .strictObject({ bytes: z.string().regex(/^\d+$/), body: z.unknown() })
    .parse(
      (
        await tx.query(
          `WITH batch AS MATERIALIZED (SELECT public.read_manual_race_pooled_personal_export_batch_v1($1::integer) AS body) SELECT octet_length(body::text)::text AS bytes,body FROM batch`,
          [limit],
        )
      ).rows[0],
    );
  expect(Number(row.bytes)).toBeLessThanOrEqual(limit);
  return batchSchema.parse(row.body);
}
function hydrateInternal(batch: z.infer<typeof batchSchema>) {
  return old.parse({
    ...batch.internal,
    schemaVersion: 1,
    chains: batch.internal.chains.map(({ payload, payloadEncoding, ...common }) => {
      if (common.bodyState === 'purged') return { ...common, preparation: null };
      const logical =
        payloadEncoding === 'pooled-database-envelope-v1'
          ? decodeRaceManualReviewPooledDatabaseEnvelopeV1(payload)
          : raceManualReviewRetainedPayloadV2Schema.parse(payload);
      if (logical.state !== 'present') throw Error('FULL_BODY_UNAVAILABLE');
      return { ...common, preparation: logical.payload.preparation };
    }),
  });
}
async function assertHydrated(tx: Transaction, batch: z.infer<typeof batchSchema>) {
  const hydrated = hydrateInternal(batch);
  const rendered = renderRaceManualInternalPersonalExport(hydrated);
  expect(rendered.manualInternalChains).toHaveLength(batch.internal.chains.length);
  const chains = batch.sourceMetadata.chains.map(({ payloadBinding, ...chain }) => {
    const source = hydrated.chains.find((c) => c.evidenceId === chain.evidenceId);
    if (
      !source ||
      source.decisionId !== chain.decisionId ||
      source.proposalId !== chain.proposalId ||
      source.bodyState !== payloadBinding.state
    )
      throw Error('BATCH_CORRESPONDENCE');
    return { ...chain, preparation: source.preparation };
  });
  const nutrition = await value(
    tx,
    'public.read_nutrition_disconnection_personal_export_v1($1::integer)',
    [8388608],
  );
  const safe = mapManualSourcePersonalExportV1(
    { ...batch.sourceMetadata, schemaVersion: 1, chains },
    nutrition,
  );
  expect(safe.manualSourceChains).toHaveLength(batch.internal.chains.length);
  for (const entry of batch.publicMetadata.sources) {
    const candidate = hydrated.candidates.find((c) => c.candidateId === entry.candidateId);
    const chain = hydrated.chains.find((c) => c.evidenceId === entry.evidenceId);
    if (!candidate || !chain) throw Error('PUBLIC_SUBSET_MISSING');
    expect(candidate.chain).toEqual({
      evidenceId: chain.evidenceId,
      decisionId: chain.decisionId,
      proposalId: chain.proposalId,
    });
    expect(candidate.bodyState).toBe(entry.bodyState);
    const preview = projectRaceManualPublicPreview({
      reference: entry.reference,
      bodyState: entry.bodyState,
      candidate: candidate.candidate,
      preparation: chain.preparation,
    });
    if (entry.bodyState === 'purged') {
      expect(candidate.candidate).toBeNull();
      expect(chain.preparation).toBeNull();
      expect(preview).toEqual({
        schemaVersion: 1,
        status: 'unavailable',
        reference: entry.reference,
        reason: 'review_body_purged',
        preview: null,
      });
    } else {
      expect(preview.status).toBe('present');
      expect(preview.reference).toEqual(entry.reference);
    }
  }
  expect(JSON.stringify(safe)).not.toMatch(/dtoDigest|copiedLocations|sql_relations|receipt_key/);
  return { hydrated, rendered, safe };
}
fixtureIt(
  'exact historical OIDs/bodies/config/ACL unchanged; only ONE public batch root and owner-private helpers',
  async () => {
    await owner(async (p) => {
      expect((await p.query(metadataSql)).rows[0]?.['value']).toEqual(predecessorMetadata);
      for (const signature of newSignatures) {
        const r = (
          await p.query(
            `SELECT p.prosecdef AS definer,p.proconfig AS config,has_function_privilege('public',p.oid,'EXECUTE') AS public_execute,has_function_privilege($2,p.oid,'EXECUTE') AS runtime_execute FROM pg_proc p WHERE p.oid=$1::regprocedure`,
            [signature, runtimeRole],
          )
        ).rows[0];
        expect(r).toMatchObject({
          definer: true,
          public_execute: false,
          runtime_execute: signature.startsWith('public.'),
          config: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        });
      }
    });
  },
);
fixtureIt(
  'genuine legacy + pooled + internal-only candidate + chain-only bodies are each emitted once, with strict hydration',
  async () => {
    await snapshot(async (tx) => {
      await createReview(tx, 'legacy');
      await createReview(tx, 'pooled');
      await createReview(tx, 'pooled', false);
      await createReview(tx, 'pooled', false, true);
      const batch = await runtimeBatch(tx);
      expect(batch.internal.chains).toHaveLength(4);
      expect(batch.internal.candidates).toHaveLength(3);
      expect(batch.publicMetadata.sources).toHaveLength(2);
      expect(batch.internal.approvalResults).toEqual([]);
      expect(batch.internal.approvalHistory).toEqual([]);
      expect(
        batch.internal.chains.filter((c) => c.payloadEncoding === 'legacy-retained-v2'),
      ).toHaveLength(1);
      expect(
        batch.internal.chains.filter((c) => c.payloadEncoding === 'pooled-database-envelope-v1'),
      ).toHaveLength(3);
      for (const chain of batch.internal.chains) expect(chain).not.toHaveProperty('preparation');
      for (const chain of batch.sourceMetadata.chains)
        expect(chain).not.toHaveProperty('preparation');
      for (const source of batch.publicMetadata.sources) {
        expect(source).not.toHaveProperty('candidate');
        expect(source).not.toHaveProperty('payload');
      }
      await assertHydrated(tx, batch);
    });
    // Owner performs independent actual SQL JSONB whole-payload binding comparison;
    // no credential/raw row is logged or returned to the browser.
    await verifyBindings(await snapshot((tx) => runtimeBatch(tx)));
  },
);
fixtureIt(
  'public original success/results/history remain an exact internal subset; equal aliases never add approvals',
  async () => {
    const legacy = records.find((r) => r.published && r.mode === 'legacy');
    if (!legacy) throw Error('MISSING_FIXTURE');
    const key = randomUUID();
    const result = await snapshot((tx) =>
      approveRaceManualPublicIn(tx, {
        schemaVersion: 1,
        idempotencyKey: key,
        candidateId: legacy.reference.candidateId,
        applicationDigest: legacy.reference.applicationDigest,
        confirmed: true,
      }),
    );
    expect(result.status).toBe('committed');
    const replay = await snapshot((tx) =>
      approveRaceManualPublicIn(tx, {
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        candidateId: legacy.reference.candidateId,
        applicationDigest: legacy.reference.applicationDigest,
        confirmed: true,
      }),
    );
    expect(replay).toEqual(result);
    await snapshot(async (tx) => {
      const batch = await runtimeBatch(tx);
      expect(batch.internal.approvalResults).toEqual([result]);
      expect(
        batch.publicMetadata.commandResults.filter(
          (r) => z.object({ operation: z.string() }).parse(r).operation === 'approve',
        ),
      ).toEqual([{ operation: 'approve', candidateId: legacy.reference.candidateId, result }]);
      expect(batch.publicMetadata.approvalHistory).toEqual(batch.internal.approvalHistory);
      expect(batch.internal.approvalHistory).toHaveLength(1);
      expect(batch.internal.approvalHistory[0]?.domain).toBe('nutrition');
      await assertHydrated(tx, batch);
    });
  },
);
fixtureIt(
  'foreign empty account is a true empty census, without leaked review/source metadata',
  async () => {
    await snapshot(async (tx) => {
      expect(await runtimeBatch(tx)).toEqual({
        batchVersion: 2,
        internal: {
          schemaVersion: 2,
          chains: [],
          candidates: [],
          approvalResults: [],
          approvalHistory: [],
        },
        sourceMetadata: { schemaVersion: 2, chains: [], refs: [], parents: [], suppressions: [] },
        publicMetadata: {
          schemaVersion: 2,
          status: 'ready',
          sources: [],
          approvalHistory: [],
          commandResults: [],
          trainingAggregateMappings: [],
        },
      });
    }, foreign);
  },
);
fixtureIt(
  'invalid bound, insufficient actual response budget and runtime private access fail closed',
  async () => {
    await snapshot(async (tx) => {
      for (const limit of [null, 0, 8388609])
        await reject(
          tx,
          () =>
            value(tx, 'public.read_manual_race_pooled_personal_export_batch_v1($1::integer)', [
              limit,
            ]),
          'MANUAL_SOURCE_EXPORT_INVALID_BOUND',
        );
      await reject(tx, () => runtimeBatch(tx, 1024), 'MANUAL_SOURCE_EXPORT_TOO_LARGE');
      await reject(
        tx,
        () => tx.query('SELECT * FROM public.manual_race_evidence_v2'),
        'permission denied',
      );
      for (const signature of ['read_internal_export_v2', 'read_public_export_metadata_v2'])
        await reject(
          tx,
          () => value(tx, `wm_manual_pooled.${signature}($1::integer)`, [8388608]),
          'permission denied',
        );
      await reject(tx, () => tx.query(migration), 'POOLED_EXPORT_INSTALL_OWNER_REQUIRED');
    });
    await db.tenant(athlete, async (tx) => {
      await reject(tx, () => runtimeBatch(tx), 'MANUAL_SOURCE_EXPORT_SNAPSHOT_REQUIRED');
    });
  },
);
fixtureIt(
  'repeat installation is rejected and old plus new full metadata remain unchanged',
  async () => {
    await owner(async (p) => {
      const q =
        'SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])';
      const args = [[...oldSignatures, ...newSignatures]];
      const before = (await p.query(q, args)).rows[0]?.['value'];
      await expect(p.query(migration)).rejects.toThrow('POOLED_EXPORT_ALREADY_INSTALLED');
      expect((await p.query(q, args)).rows[0]?.['value']).toEqual(before);
    });
  },
);
for (const drift of [
  'ALTER FUNCTION public.read_race_manual_personal_export_v1(integer) IMMUTABLE',
  'ALTER FUNCTION public.read_manual_race_internal_personal_export_v1(integer) SET search_path=public',
  'ALTER FUNCTION public.read_manual_race_source_personal_export_v1(integer) STRICT',
  'ALTER FUNCTION wm_manual_pooled.lookup(jsonb,text) PARALLEL SAFE',
  'GRANT EXECUTE ON FUNCTION public.read_manual_race_retained_source_batch_v1(integer) TO PUBLIC',
])
  fixtureIt(
    `metadata/security drift rolls back ALL three new functions: ${drift.split(' ').at(-1)}`,
    async () => {
      await ownerConnection(async (p) => {
        await p.query('BEGIN');
        try {
          for (const signature of newSignatures) await p.query(`DROP FUNCTION ${signature}`);
          await p.query(drift);
          await p.query('SAVEPOINT install');
          await expect(p.query(migration)).rejects.toThrow(
            /POOLED_EXPORT_PREDECESSOR_MISMATCH|POOLED_PROTOCOL_RESOLVER_MISMATCH/,
          );
          await p.query('ROLLBACK TO SAVEPOINT install');
          for (const signature of newSignatures)
            expect(
              (await p.query('SELECT to_regprocedure($1) IS NULL AS absent', [signature])).rows[0],
            ).toEqual({ absent: true });
        } finally {
          await p.query('ROLLBACK');
        }
      });
    },
  );
fixtureIt(
  'actual predecessor body drift denies and atomically leaves all successors absent',
  async () => {
    await ownerConnection(async (p) => {
      await p.query('BEGIN');
      try {
        for (const signature of newSignatures) await p.query(`DROP FUNCTION ${signature}`);
        const definition = z
          .string()
          .parse(
            (
              await p.query(
                "SELECT pg_get_functiondef('public.read_manual_race_retained_source_batch_v1(integer)'::regprocedure) AS definition",
              )
            ).rows[0]?.['definition'],
          );
        expect(definition).toContain('BEGIN');
        await p.query(definition.replace('BEGIN', 'BEGIN\n -- exact source drift'));
        await p.query('SAVEPOINT install');
        await expect(p.query(migration)).rejects.toThrow('POOLED_EXPORT_PREDECESSOR_MISMATCH');
        await p.query('ROLLBACK TO SAVEPOINT install');
        for (const signature of newSignatures)
          expect(
            (await p.query('SELECT to_regprocedure($1) IS NULL AS absent', [signature])).rows[0],
          ).toEqual({ absent: true });
      } finally {
        await p.query('ROLLBACK');
      }
    });
  },
);
fixtureIt(
  'plain owner cannot impersonate a runtime tenant through the new definer reader',
  async () => {
    await ownerConnection(async (p) => {
      await p.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        await p.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
        await expect(
          p.query('SELECT public.read_manual_race_pooled_personal_export_batch_v1(8388608)'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await p.query('ROLLBACK');
      }
    });
  },
);
fixtureIt(
  'app withdrawal retains original histories/receipts and frozen bodies without new processing',
  async () => {
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      const batch = await runtimeBatch(tx);
      expect(batch.internal.chains).toHaveLength(4);
      await assertHydrated(tx, batch);
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
  'genuine public deletion purges legacy/pool entirely; US6/event/NULL tuples and original successes survive',
  async () => {
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    const race = await createRaceRepository(db).getRaceEvent(athlete, intent.expectedEvent.id);
    if (!race) throw Error('MISSING_RACE');
    const deletingDb = createDatabase({ connectionString: url(runtimeRole), max: 1 });
    let deletion: Promise<unknown> = Promise.resolve();
    try {
      await snapshot(async (tx) => {
        const before = await runtimeBatch(tx);
        deletion = createRaceRepository(deletingDb).deleteRaceEvent(athlete, race.id, {
          expectedRevision: race.revision,
          idempotencyKey: randomUUID(),
        });
        // Actual competing public delete must wait for the current export fence;
        // poll only finite lock metadata, never user query text or body values.
        let blocked = false;
        await owner(async (p) => {
          for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
            blocked = z
              .boolean()
              .parse(
                (
                  await p.query(
                    `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND a.usename=$2 AND l.locktype='advisory' AND NOT l.granted) AS blocked`,
                    [name, runtimeRole],
                  )
                ).rows[0]?.['blocked'],
              );
          }
        });
        expect(blocked).toBe(true);
        expect(await runtimeBatch(tx)).toEqual(before);
      });
    } finally {
      await deletion;
      await deletingDb.close();
    }
    await snapshot(async (tx) => {
      const batch = await runtimeBatch(tx);
      for (const chain of batch.internal.chains) {
        expect(chain.bodyState).toBe('purged');
        expect(chain.payload).toBeNull();
        expect(chain.payloadEncoding).toBeNull();
        expect(chain.purge?.purgedAt).toMatch(/\.\d{6}Z$/);
      }
      for (const chain of batch.sourceMetadata.chains)
        expect(chain.payloadBinding).toEqual({
          state: 'purged',
          digestMethod: 'postgres-retained-envelope-jsonb-v1',
          digest: null,
        });
      for (const source of batch.publicMetadata.sources) expect(source.bodyState).toBe('purged');
      expect(batch.internal.approvalResults).toHaveLength(1);
      expect(batch.sourceMetadata.suppressions.length).toBeGreaterThan(0);
      await assertHydrated(tx, batch);
      for (const r of records.filter((r) => r.published)) {
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
fixtureIt(
  'actual account erasure rejects retained enumeration instead of fabricated empty census',
  async () => {
    await createOperationsRepository(db).eraseAccount(athlete);
    await expect(snapshot((tx) => runtimeBatch(tx))).rejects.toThrow('ACCOUNT_ERASED');
  },
);
