import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { raceManualReviewMultiOwnedRetainedPayloadV3Schema } from '../src/race-manual-review-retained-payload-v2.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import { toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { captureRaceManualReviewLifecycleInventoryV2In } from '../src/race-manual-review-lifecycle-inventory-v2.js';
import { installCurrentRuntimeV7 } from '../src/current-runtime-installation-v7.js';
import { grantCurrentRuntimeV7Profile } from '../src/current-runtime-grants-v7.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { parseRaceManualPooledParentDeltaV1 as parseDelta } from '../src/race-manual-pooled-parent-delta-v1.js';
import * as baseline from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual PG only. Public synthetic sources, no private health/event seed.
// Account row is the identity-only foreign-key prerequisite, not source authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_parent_delta142_${suffix}`,
  ownerRole = `pooled_parent_delta142_owner_${suffix}`,
  runtimeRole = `pooled_parent_delta142_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database,
  envelope: ReturnType<typeof toDatabase>;
let athlete: string;
let current: Awaited<ReturnType<typeof prepareRaceManualSemanticBasisV2In>>;
let lifecycle: Awaited<ReturnType<typeof captureRaceManualReviewLifecycleInventoryV2In>>;
let predecessorMetadata: unknown;
let originalResult: unknown;
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
const migrationSql = await readFile(
  new URL('../migrations/142_manual_pooled_parent_delta.sql', import.meta.url),
  'utf8',
);
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
    for (const filename of [
      '134_manual_pooled_preparation_resolver.sql',
      '135_manual_pooled_store_and_basis.sql',
      '136_manual_pooled_chain_reader_and_ack.sql',
      '137_manual_pooled_application.sql',
      '138_manual_pooled_public_finish_and_preview.sql',
      '139_manual_pooled_personal_export_batch.sql',
      '140_manual_pooled_same_invocation_lookup.sql',
      '141_manual_pooled_application_local_validation.sql',
    ])
      await p.query(await readFile(new URL('../migrations/' + filename, import.meta.url), 'utf8'));
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb),public.read_manual_race_pooled_chain_v1(uuid) TO "${runtimeRole}"`,
    );
    predecessorMetadata = (
      await p.query(
        "SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wm_manual_pooled' OR n.nspname='public' AND p.proname IN ('store_manual_race_pooled_chain_v1','validate_race_manual_pooled_application_basis_v1','read_manual_race_pooled_chain_v1','ack_manual_race_pooled_same_tx_parent_v1','race_manual_pooled_relative_membership_v1','race_manual_pooled_routine_expansion_v1','race_manual_pooled_validate_recipes_v1','prepare_race_manual_pooled_application_v1','begin_race_manual_pooled_application_v1','finish_race_manual_pooled_public_review_v1','read_race_manual_pooled_public_preview_source_v1','read_manual_race_pooled_personal_export_batch_v1','assert_manual_race_v2_caller','manual_race_v2_assert_json_bound','assert_manual_review_global_lock','assert_manual_review_lifecycle_lock')",
      )
    ).rows[0]?.value;
    await p.query(migrationSql);
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb),public.read_manual_race_pooled_chain_v1(uuid),public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) TO "${runtimeRole}"`,
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
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  envelope = await db.snapshotTenant(athlete, async (tx) => {
    const prepared = await prepareRaceManualSemanticBasisV2In(
      tx,
      {
        expectedEvent: { id: race.id, revision: race.revision },
        newLocalDate: '2026-10-08',
        selection: { kind: 'keep_plan' },
      },
      null,
      { bytes: 0n, sources: 0 },
    );
    if (prepared.status !== 'current_dependencies_captured')
      throw Error('GENUINE_PREPARATION_UNAVAILABLE');
    current = prepared;
    lifecycle = await captureRaceManualReviewLifecycleInventoryV2In(
      tx,
      prepared.prepared.retained,
      { bytes: 0n, sources: 0 },
    );
    if (lifecycle.status !== 'dependency_correspondence') throw Error('LIFECYCLE_UNAVAILABLE');
    return toDatabase(encode(prepared.prepared.retained));
  });
  expect(envelope.payload.preparation.sourcePool.length).toBeGreaterThan(0);
}, 180000);
afterAll(async () => {
  await pending;
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 30000);

function basis() {
  if (current.status !== 'current_dependencies_captured') throw Error('CURRENT_REQUIRED');
  return current.basis;
}
function logical() {
  if (current.status !== 'current_dependencies_captured') throw Error('CURRENT_REQUIRED');
  return current.prepared.retained;
}
const ids = { evidenceId: randomUUID(), decisionId: randomUUID(), proposalId: randomUUID() };
const legacyIds = { evidenceId: randomUUID(), decisionId: randomUUID(), proposalId: randomUUID() };
async function snapshot<T>(apply: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(athlete, apply);
}
async function store(tx: Transaction, pooled = true) {
  const target = pooled ? ids : legacyIds;
  const key = randomUUID();
  return (
    await tx.query(
      `SELECT public.${pooled ? 'store_manual_race_pooled_chain_v1' : 'store_manual_race_multi_owned_chain_v3'}($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) AS value`,
      [
        target.evidenceId,
        target.decisionId,
        target.proposalId,
        key,
        JSON.stringify({
          schemaVersion: 2,
          idempotencyKey: key,
          intent: basis().intent,
          expectedBasis: basis(),
        }),
        JSON.stringify(pooled ? envelope : logical()),
        JSON.stringify(basis()),
        JSON.stringify(lifecycle),
      ],
    )
  ).rows[0]?.value;
}
async function read(tx: Transaction, id = ids.evidenceId, base: unknown = envelope) {
  return (
    await tx.query(
      'SELECT public.read_manual_race_pooled_parent_delta_v1($1::uuid,$2::jsonb) AS value',
      [id, JSON.stringify(base)],
    )
  ).rows[0]?.value;
}
async function rejected(tx: Transaction, apply: () => Promise<unknown>, message?: string) {
  await tx.query('SAVEPOINT bad');
  try {
    await expect(apply()).rejects.toThrow(message);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT bad');
    await tx.query('RELEASE SAVEPOINT bad');
  }
}
fixtureIt(
  'genuine public source preparation stores pooled parent and delta reconstructs exact old reader result',
  async () => {
    await snapshot(async (tx) => {
      originalResult = await store(tx);
      const old = (
        await tx.query('SELECT public.read_manual_race_pooled_chain_v1($1::uuid) AS value', [
          ids.evidenceId,
        ])
      ).rows[0]?.value;
      const wire = await read(tx);
      const parsed = parseDelta(envelope, wire);
      expect(parsed).toMatchObject({
        result: originalResult,
        payload: logical(),
        authority: 'none',
        approvalAllowed: false,
      });
      expect(z.strictObject({ payload: z.unknown() }).passthrough().parse(old).payload).toEqual(
        envelope,
      );
      expect(z.object({ delta: z.unknown(), deltaNodes: z.number() }).parse(wire)).toEqual({
        delta: { kind: 'same' },
        deltaNodes: 1,
      });
      const bytes = (
        await tx.query(
          'SELECT octet_length($1::jsonb::text) AS parent_bytes,octet_length($2::jsonb::text) AS delta_bytes',
          [JSON.stringify(old), JSON.stringify(wire)],
        )
      ).rows[0];
      const numeric = z
        .strictObject({ parent_bytes: z.number().positive(), delta_bytes: z.number().positive() })
        .parse(bytes);
      expect(numeric.delta_bytes).toBeLessThan(numeric.parent_bytes);
    });
  },
);
fixtureIt(
  'honest historical legacy parent remains explicit legacy and reconstructs losslessly',
  async () => {
    await snapshot(async (tx) => {
      await store(tx, false);
      const wire = await read(tx, legacyIds.evidenceId);
      expect(parseDelta(envelope, wire)).toMatchObject({
        payloadEncoding: 'legacy-retained-v2',
        payload: logical(),
      });
    });
  },
);
fixtureIt(
  'typed changed dictionary is compression only: exact prior parent is recovered with no current authorization',
  async () => {
    await snapshot(async (tx) => {
      const sibling = await prepareRaceManualSemanticBasisV2In(tx, basis().intent, null, {
        bytes: 0n,
        sources: 0,
      });
      if (sibling.status !== 'current_dependencies_captured')
        throw Error('GENUINE_SIBLING_PREPARATION_UNAVAILABLE');
      const actualRetained = raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(
        sibling.prepared.retained,
      );
      const base = toDatabase(encode(actualRetained));
      expect(base).not.toEqual(envelope);
      const wire = await read(tx, ids.evidenceId, base);
      expect(parseDelta(base, wire)?.payload).toEqual(logical());
    });
  },
);
fixtureIt(
  'missing/foreign IDs return no parent; wrong dictionary ownership and malformed encoding reject',
  async () => {
    await snapshot(async (tx) => {
      expect(await read(tx, randomUUID())).toBeNull();
      await rejected(tx, () => read(tx, ids.evidenceId, {}));
      const broken = structuredClone(envelope);
      broken.payload.preparation.logicalDigest = '0'.repeat(64);
      // SQL preserves the explicit Node digest namespace and validates its format;
      // the full Node codec verifies its canonical value before reconstruction.
      const response = await read(tx, ids.evidenceId, broken);
      expect(response).not.toBeNull();
      expect(() => parseDelta(broken, response)).toThrow();
      const malformed = structuredClone(envelope);
      const malformedPreparation = z
        .record(z.string(), z.json())
        .parse(malformed.payload.preparation);
      malformedPreparation['encodingVersion'] = 2;
      await rejected(tx, () =>
        read(tx, ids.evidenceId, {
          ...malformed,
          payload: { ...malformed.payload, preparation: malformedPreparation },
        }),
      );
    });
    if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
    await expect(db.snapshotTenant(randomUUID(), (tx) => read(tx))).rejects.toThrow(
      'POOLED_PARENT_DELTA_INPUT',
    );
  },
);
fixtureIt(
  'base and node/depth/whole response bounds are finite, and direct runtime private helper is denied',
  async () => {
    await snapshot(async (tx) => {
      await rejected(tx, () => read(tx, ids.evidenceId, '界'.repeat(1400000)));
      await rejected(
        tx,
        () => tx.query("SELECT wm_manual_pooled.parent_delta_node_v1('{}','{}',0,5000)"),
        'permission denied',
      );
    });
    await owner(async (p) => {
      await expect(
        p.query("SELECT wm_manual_pooled.parent_delta_node_v1('{}','{}',65,5000)"),
      ).rejects.toThrow('POOLED_PARENT_DELTA_BOUND');
    });
  },
);
fixtureIt(
  'new reader refuses owner and non-snapshot runtime while old24 bodies/OIDs/security/ACL stay unchanged',
  async () => {
    await owner(async (p) => {
      await expect(
        p.query('SELECT public.read_manual_race_pooled_parent_delta_v1($1,$2)', [
          ids.evidenceId,
          JSON.stringify(envelope),
        ]),
      ).rejects.toThrow('MANUAL_CHAIN_CALLER_REQUIRED');
      const after = (
        await p.query(
          "SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wm_manual_pooled' AND p.proname<>'parent_delta_node_v1' OR n.nspname='public' AND p.proname IN ('store_manual_race_pooled_chain_v1','validate_race_manual_pooled_application_basis_v1','read_manual_race_pooled_chain_v1','ack_manual_race_pooled_same_tx_parent_v1','race_manual_pooled_relative_membership_v1','race_manual_pooled_routine_expansion_v1','race_manual_pooled_validate_recipes_v1','prepare_race_manual_pooled_application_v1','begin_race_manual_pooled_application_v1','finish_race_manual_pooled_public_review_v1','read_race_manual_pooled_public_preview_source_v1','read_manual_race_pooled_personal_export_batch_v1','assert_manual_race_v2_caller','manual_race_v2_assert_json_bound','assert_manual_review_global_lock','assert_manual_review_lifecycle_lock')",
        )
      ).rows[0]?.value;
      expect(after).toEqual(predecessorMetadata);
    });
    await expect(db.tenant(athlete, (tx) => read(tx))).rejects.toThrow(
      'MANUAL_CHAIN_SNAPSHOT_REQUIRED',
    );
  },
);
fixtureIt(
  'installation repeat and valid predecessor body/config/ACL drift deny atomically with both new roots absent',
  async () => {
    await owner(async (p) => {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query(migrationSql)).rejects.toThrow(
          'POOLED_PARENT_DELTA_ALREADY_INSTALLED',
        );
        await client.query('ROLLBACK');
        for (const mutation of [
          'body',
          'config',
          'acl',
          'guard-body',
          'guard-config',
          'guard-acl',
        ] as const) {
          await client.query('BEGIN');
          try {
            await client.query(
              'DROP FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)',
            );
            await client.query(
              'DROP FUNCTION wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)',
            );
            const signature = mutation.startsWith('guard-')
              ? 'public.assert_manual_review_global_lock()'
              : 'public.read_manual_race_pooled_chain_v1(uuid)';
            if (mutation === 'body' || mutation === 'guard-body') {
              const row = z
                .strictObject({ body: z.string(), definition: z.string() })
                .parse(
                  (
                    await client.query(
                      'SELECT prosrc AS body,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid=$1::regprocedure',
                      [signature],
                    )
                  ).rows[0],
                );
              await client.query(
                row.definition.replace(row.body, () => row.body + '\n-- valid drift'),
              );
            } else if (mutation === 'config' || mutation === 'guard-config')
              await client.query(`ALTER FUNCTION ${signature} SET search_path=public,pg_temp`);
            else await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`);
            await client.query('SAVEPOINT migration');
            await expect(client.query(migrationSql)).rejects.toThrow(
              'POOLED_PARENT_DELTA_PREDECESSOR_DRIFT',
            );
            await client.query('ROLLBACK TO SAVEPOINT migration');
            expect(
              (
                await client.query(
                  "SELECT to_regprocedure('public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)') IS NULL AND to_regprocedure('wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)') IS NULL AS absent",
                )
              ).rows,
            ).toEqual([{ absent: true }]);
          } finally {
            await client.query('ROLLBACK');
          }
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  },
);
fixtureIt(
  'successful new installation then transaction failure removes both new functions atomically',
  async () => {
    await owner(async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DROP FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)',
        );
        await client.query(
          'DROP FUNCTION wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)',
        );
        await client.query('SAVEPOINT install_boundary');
        await client.query(migrationSql);
        await expect(client.query('SELECT 1/0')).rejects.toThrow('division by zero');
        await client.query('ROLLBACK TO SAVEPOINT install_boundary');
        expect(
          (
            await client.query(
              "SELECT to_regprocedure('public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)') IS NULL AND to_regprocedure('wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)') IS NULL AS absent",
            )
          ).rows,
        ).toEqual([{ absent: true }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  },
);
fixtureIt(
  'withdrawal retains owned parent reading and genuine race deletion purges delta without resurrection',
  async () => {
    const consents = createConsentRepository(db);
    await consents.setConsent(athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      expect(parseDelta(envelope, await read(tx))?.payload).toEqual(logical());
    });
    await consents.setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    await createRaceRepository(db).deleteRaceEvent(athlete, basis().intent.expectedEvent.id, {
      expectedRevision: basis().intent.expectedEvent.revision,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      const wire = await read(tx);
      expect(parseDelta(envelope, wire)).toMatchObject({
        payload: null,
        payloadEncoding: null,
        bodyState: 'purged',
        result: originalResult,
      });
      expect(z.object({ delta: z.null(), deltaNodes: z.literal(0) }).parse(wire)).toEqual({
        delta: null,
        deltaNodes: 0,
      });
    });
  },
);
