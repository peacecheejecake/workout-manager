import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import { toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { captureRaceManualReviewLifecycleInventoryV2In } from '../src/race-manual-review-lifecycle-inventory-v2.js';
import { installCurrentRuntimeV7 } from '../src/current-runtime-installation-v7.js';
import { grantCurrentRuntimeV7Profile } from '../src/current-runtime-grants-v7.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import * as baseline from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual PG only. Public synthetic sources, no private health/event seed.
// Account row is the identity-only foreign-key prerequisite, not source authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_local140_${suffix}`,
  ownerRole = `pooled_local140_owner_${suffix}`,
  runtimeRole = `pooled_local140_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database,
  envelope: ReturnType<typeof toDatabase>;
let athlete: string;
let legacyRetained: unknown;
let current: Awaited<ReturnType<typeof prepareRaceManualSemanticBasisV2In>>;
let lifecycle: Awaited<ReturnType<typeof captureRaceManualReviewLifecycleInventoryV2In>>;
let predecessorMetadata: unknown;
let targetMetadata: unknown;
let privateHelperOid: string;
const migration = await readFile(
  new URL('../migrations/140_manual_pooled_same_invocation_lookup.sql', import.meta.url),
  'utf8',
);
const targetMetaSql =
  "SELECT jsonb_agg(to_jsonb(p)-'prosrc' ORDER BY p.oid) AS value FROM pg_proc p WHERE p.oid IN ('public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,'public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)'::regprocedure)";
let pending: Promise<void> = Promise.resolve();
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function owner<T>(apply: (p: PoolClient) => Promise<T>) {
  const p = new Pool({ connectionString: url(ownerRole), max: 1 });
  const client = await p.connect();
  try {
    return await apply(client);
  } finally {
    client.release();
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
    // Fixture-only old validator access precedes the exact historical metadata
    // baseline. Later successor comparisons include this actual unchanged ACL.
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.validate_race_manual_multi_owned_basis_v3(jsonb,jsonb,jsonb) TO "${runtimeRole}"`,
    );
    const before = await p.query(
      "SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_catalog.pg_proc p WHERE p.oid IN ('public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,'public.validate_race_manual_multi_owned_basis_v3(jsonb,jsonb,jsonb)'::regprocedure)",
    );
    predecessorMetadata = before.rows[0]?.['value'];
    await p.query(
      await readFile(
        new URL('../migrations/135_manual_pooled_store_and_basis.sql', import.meta.url),
        'utf8',
      ),
    );
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb), public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb) TO "${runtimeRole}"`,
    );
    for (const filename of [
      '136_manual_pooled_chain_reader_and_ack.sql',
      '137_manual_pooled_application.sql',
      '138_manual_pooled_public_finish_and_preview.sql',
      '139_manual_pooled_personal_export_batch.sql',
    ])
      await p.query(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'));
    targetMetadata = (await p.query(targetMetaSql)).rows[0]?.['value'];
    await p.query(migration);
    expect((await p.query(targetMetaSql)).rows[0]?.['value']).toEqual(targetMetadata);
    privateHelperOid = z
      .string()
      .regex(/^[0-9]+$/)
      .parse(
        (
          await p.query(
            "SELECT oid::text AS oid FROM pg_proc WHERE oid='wm_manual_pooled.lookup_validated_local(jsonb,text)'::regprocedure",
          )
        ).rows[0]?.['oid'],
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
    legacyRetained = prepared.prepared.retained;
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
  if (current.status !== 'current_dependencies_captured') throw Error('BASIS_UNAVAILABLE');
  return current.basis;
}
const storedIds = { evidenceId: randomUUID(), decisionId: randomUUID(), proposalId: randomUUID() };
const stableKey = randomUUID();
function command(key: string) {
  return { schemaVersion: 2, idempotencyKey: key, intent: basis().intent, expectedBasis: basis() };
}
async function store(
  tx: Transaction,
  key = randomUUID(),
  raw: unknown = envelope,
  observed: unknown = basis(),
  parents: unknown = lifecycle,
  ids = storedIds,
) {
  return tx.query(
    'SELECT public.store_manual_race_pooled_chain_v1($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) AS value',
    [
      ids.evidenceId,
      ids.decisionId,
      ids.proposalId,
      key,
      JSON.stringify(command(key)),
      JSON.stringify(raw),
      JSON.stringify(observed),
      JSON.stringify(parents),
    ],
  );
}
async function validate(
  tx: Transaction,
  raw: unknown = envelope,
  observed: unknown = basis(),
  parents: unknown = lifecycle,
) {
  return tx.query(
    'SELECT public.validate_race_manual_pooled_application_basis_v1($1::jsonb,$2::jsonb,$3::jsonb)',
    [JSON.stringify(raw), JSON.stringify(observed), JSON.stringify(parents)],
  );
}
async function snapshot<T>(operation: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(athlete, operation);
}
async function rejected(tx: Transaction, operation: () => Promise<unknown>, message?: string) {
  await tx.query('SAVEPOINT malformed');
  try {
    await expect(operation()).rejects.toThrow(message);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT malformed');
    await tx.query('RELEASE SAVEPOINT malformed');
  }
}
fixtureIt(
  'genuine encoded sources store atomically and fresh basis validation keeps all original guards',
  async () => {
    await snapshot(async (tx) => {
      await validate(tx);
      const result = await store(tx, stableKey);
      expect(result.rows[0]?.value).toMatchObject({
        schemaVersion: 2,
        ...storedIds,
        applicable: false,
        approvalAllowed: false,
      });
    });
    await owner(async (p) => {
      const metadata = await p.query(
        "SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_catalog.pg_proc p WHERE p.oid IN ('public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,'public.validate_race_manual_multi_owned_basis_v3(jsonb,jsonb,jsonb)'::regprocedure)",
      );
      expect(metadata.rows[0]?.['value']).toEqual(predecessorMetadata);
      const rows = await p.query(
        'SELECT payload FROM public.manual_race_evidence_v2 WHERE athlete_id=$1 AND id=$2',
        [athlete, storedIds.evidenceId],
      );
      // Owner metadata inspection respects forced RLS through an explicit tenant scope below.
      expect(rows.rows).toHaveLength(0);
      await p.query('BEGIN');
      try {
        await p.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
        const observed = await p.query(
          'SELECT payload FROM public.manual_race_evidence_v2 WHERE athlete_id=$1 AND id=$2',
          [athlete, storedIds.evidenceId],
        );
        expect(observed.rows[0]?.['payload']).toEqual(envelope);
      } finally {
        await p.query('ROLLBACK');
      }
    });
  },
);
fixtureIt(
  'stored original receipt replays without duplicate evidence and rejects changed request',
  async () => {
    await snapshot(async (tx) => {
      const one = await store(tx, stableKey);
      const two = await store(tx, stableKey);
      expect(two.rows).toEqual(one.rows);
      const altered = {
        ...command(stableKey),
        intent: { ...basis().intent, newLocalDate: '2026-10-09' },
      };
      await rejected(
        tx,
        () =>
          tx.query('SELECT public.store_manual_race_pooled_chain_v1($1,$2,$3,$4,$5,$6,$7,$8)', [
            storedIds.evidenceId,
            storedIds.decisionId,
            storedIds.proposalId,
            stableKey,
            JSON.stringify(altered),
            JSON.stringify(envelope),
            JSON.stringify(basis()),
            JSON.stringify(lifecycle),
          ]),
        'IDEMPOTENCY',
      );
    });
  },
);
fixtureIt(
  'copied pooled body forgery and malformed slot fail authoritative DTO comparison',
  async () => {
    await snapshot(async (tx) => {
      const changed = structuredClone(envelope);
      const body = changed.payload.preparation.sourcePool[0]?.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw Error('BODY_REQUIRED');
      Object.assign(body, { unexpected: 'forged' });
      await rejected(tx, () => validate(tx, changed), 'MANUAL_CHAIN_COPIED_BODY_CHANGED');
      const malformed = structuredClone(envelope);
      const slot = malformed.payload.preparation.substitutions[0];
      if (!slot) throw Error('SLOT_REQUIRED');
      slot.sourceOrdinal = 5000;
      await rejected(tx, () => validate(tx, malformed), 'POOLED_SLOT_REJECTED');
    });
  },
);
fixtureIt(
  'actual SQL observer and parent groups reject partial or mutated captured facts',
  async () => {
    await snapshot(async (tx) => {
      const changed = structuredClone(envelope);
      if (
        changed.payload.sqlObservations === null ||
        typeof changed.payload.sqlObservations !== 'object' ||
        Array.isArray(changed.payload.sqlObservations)
      )
        throw Error('SQL_OBSERVATIONS_REQUIRED');
      changed.payload.sqlObservations = { ...changed.payload.sqlObservations, rows: [] };
      await rejected(tx, () => validate(tx, changed), 'MANUAL_CHAIN_SOURCE_CHANGED');
      const parent = structuredClone(lifecycle);
      parent.facts = [];
      await rejected(
        tx,
        () => validate(tx, envelope, basis(), parent),
        'MANUAL_CHAIN_PARENT_MISMATCH',
      );
      const stale = structuredClone(basis());
      stale.restoreGeneration = randomUUID();
      await rejected(tx, () => validate(tx, envelope, stale), 'MANUAL_CHAIN_STALE_BASIS');
    });
  },
);
fixtureIt(
  'foreign tenant cannot validate or persist an otherwise genuine encoded body',
  async () => {
    if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
    await expect(db.snapshotTenant(randomUUID(), (tx) => validate(tx))).rejects.toThrow();
  },
);
fixtureIt(
  'successful store then callback failure rolls back evidence receipt seal refs and outbox',
  async () => {
    const ids = { evidenceId: randomUUID(), decisionId: randomUUID(), proposalId: randomUUID() };
    const key = randomUUID();
    await expect(
      snapshot(async (tx) => {
        await store(tx, key, envelope, basis(), lifecycle, ids);
        throw Error('FORCED_POOLED_ROLLBACK');
      }),
    ).rejects.toThrow('FORCED_POOLED_ROLLBACK');
    await snapshot(async (tx) => {
      const receipt = await tx.query(
        'SELECT public.read_manual_race_chain_receipt_v2($1,$2) AS value',
        [key, JSON.stringify(command(key))],
      );
      expect(receipt.rows[0]?.['value']).toBeNull();
      const read = await tx.query('SELECT public.read_manual_race_chain_v2($1) AS value', [
        ids.evidenceId,
      ]);
      expect(read.rows[0]?.['value']).toBeNull();
    });
  },
);
fixtureIt(
  'new named roots have exact definer config but no PUBLIC or accidental role grants',
  async () => {
    await owner(async (p) => {
      const row = await p.query(
        "SELECT p.prosecdef,p.proconfig,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_catalog.pg_proc p WHERE p.oid IN ('public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,'public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)'::regprocedure)",
      );
      expect(row.rows).toHaveLength(2);
      for (const r of row.rows) {
        expect(r['prosecdef']).toBe(true);
        expect(r['proconfig']).toEqual([
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC',
          'DateStyle=ISO,YMD',
        ]);
        expect(r['public_execute']).toBe(false);
      }
    });
  },
);
fixtureIt(
  'genuine legacy validator and patched pooled validator preserve the same owned sources',
  async () => {
    await snapshot(async (tx) => {
      await tx.query(
        'SELECT public.validate_race_manual_multi_owned_basis_v3($1::jsonb,$2::jsonb,$3::jsonb)',
        [JSON.stringify(legacyRetained), JSON.stringify(basis()), JSON.stringify(lifecycle)],
      );
      await validate(tx);
    });
  },
);
fixtureIt(
  'same-invocation helper preserves genuine selected roots, zero/null and every saved copied location',
  async () => {
    await owner(async (p) => {
      const locations = envelope.payload.inventory.refs.flatMap((r) => r.copiedLocations);
      for (const path of ['context', 'candidate', ...locations]) {
        const compared = await p.query(
          'SELECT wm_manual_pooled.lookup($1::jsonb,$2::text) IS NOT DISTINCT FROM wm_manual_pooled.lookup_validated_local($1::jsonb,$2::text) AS equal',
          [JSON.stringify(envelope), path],
        );
        expect(compared.rows[0]?.['equal']).toBe(true);
      }
      expect((await p.query(targetMetaSql)).rows[0]?.['value']).toEqual(targetMetadata);
    });
  },
);
fixtureIt(
  'runtime cannot directly use private helper or schema despite allowed public roots',
  async () => {
    await snapshot(async (tx) => {
      await rejected(
        tx,
        () =>
          tx.query('SELECT wm_manual_pooled.lookup_validated_local($1::jsonb,$2)', [
            JSON.stringify(envelope),
            'context',
          ]),
        'permission denied',
      );
      const acl = await tx.query(
        "SELECT has_function_privilege(current_user,$1::oid,'EXECUTE') AS allowed, has_schema_privilege(current_user,'wm_manual_pooled','USAGE') AS schema_allowed",
        [privateHelperOid],
      );
      expect(acl.rows[0]).toEqual({ allowed: false, schema_allowed: false });
    });
  },
);
fixtureIt(
  'full initial validation still rejects unknown frame, orphan pool, overlap and deep body before cached lookup',
  async () => {
    await snapshot(async (tx) => {
      const unknown = { ...envelope, unexpected: true };
      await rejected(tx, () => validate(tx, unknown));
      const orphan = structuredClone(envelope);
      const row = orphan.payload.preparation.sourcePool[0];
      if (!row) throw Error('POOL_REQUIRED');
      orphan.payload.preparation.sourcePool.push(structuredClone(row));
      await rejected(tx, () => validate(tx, orphan));
      const overlap = structuredClone(envelope);
      const slot = overlap.payload.preparation.substitutions[0];
      if (!slot) throw Error('SLOT_REQUIRED');
      overlap.payload.preparation.substitutions.push(structuredClone(slot));
      await rejected(tx, () => validate(tx, overlap));
      const deep = structuredClone(envelope);
      const deepRow = deep.payload.preparation.sourcePool[0];
      if (!deepRow) throw Error('POOL_REQUIRED');
      let body: typeof deepRow.body = null;
      for (let i = 0; i < 65; i++) body = { nested: body };
      deepRow.body = body;
      await rejected(tx, () => validate(tx, deep));
    });
  },
);
// Revert only fixture-owned changes inside one acquired owner transaction. The
// actual migration must reject drift atomically without leaving its helper.
const driftCommands = [
  "ALTER FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) SET DateStyle='German,DMY'",
  'ALTER FUNCTION public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb) SECURITY INVOKER',
  'ALTER FUNCTION wm_manual_pooled.lookup(jsonb,text) IMMUTABLE',
  'ALTER FUNCTION wm_manual_pooled.lookup(jsonb,text) COST 101',
  'ALTER FUNCTION wm_manual_pooled.lookup(jsonb,text) STRICT',
  'ALTER FUNCTION wm_manual_pooled.lookup(jsonb,text) PARALLEL SAFE',
  `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) TO "${runtimeRole}" WITH GRANT OPTION`,
  'GRANT EXECUTE ON FUNCTION wm_manual_pooled.check_encoded(jsonb) TO PUBLIC',
  `GRANT EXECUTE ON FUNCTION wm_manual_pooled.at_exact(jsonb,text[]) TO "${runtimeRole}"`,
];
driftCommands.push('body_drift', 'missing_end139');
for (const [index, drift] of driftCommands.entries())
  fixtureIt(
    `predecessor metadata drift ${index + 1} rejects before helper creation and preserves rollback`,
    async () => {
      await owner(async (p) => {
        await p.query('BEGIN');
        try {
          await p.query('DROP FUNCTION wm_manual_pooled.lookup_validated_local(jsonb,text)');
          // Restore both exact pre140 sources from their independently pinned installed SQL definitions.
          for (const [signature, arg] of [
            [
              'public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
              '$6',
            ],
            ['public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)', '$1'],
          ]) {
            const definition = (
              await p.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS definition', [
                signature,
              ])
            ).rows[0]?.['definition'];
            if (typeof definition !== 'string' || typeof arg !== 'string')
              throw Error('DEFINITION_REQUIRED');
            await p.query(
              definition.replaceAll(
                `wm_manual_pooled.lookup_validated_local(${arg},`,
                `wm_manual_pooled.lookup(${arg},`,
              ),
            );
          }
          if (drift === 'body_drift') {
            const row = (
              await p.query(
                "SELECT pg_get_functiondef('wm_manual_pooled.lookup(jsonb,text)'::regprocedure) AS definition,prosrc AS body FROM pg_proc WHERE oid='wm_manual_pooled.lookup(jsonb,text)'::regprocedure",
              )
            ).rows[0];
            if (typeof row?.['definition'] !== 'string' || typeof row?.['body'] !== 'string')
              throw Error('BODY_REQUIRED');
            await p.query(
              row['definition'].replace(row['body'], row['body'] + '\n-- fixture body drift'),
            );
          } else if (drift === 'missing_end139') {
            await p.query(
              'DROP FUNCTION public.read_manual_race_pooled_personal_export_batch_v1(integer)',
            );
          } else await p.query(drift);
          await p.query('SAVEPOINT expected_reject');
          await expect(p.query(migration)).rejects.toThrow(
            drift === 'missing_end139'
              ? 'POOLED_LOCAL_PREDECESSOR_MISSING'
              : 'POOLED_LOCAL_PREDECESSOR_DRIFT',
          );
          await p.query('ROLLBACK TO SAVEPOINT expected_reject');
          expect(
            (
              await p.query(
                "SELECT to_regprocedure('wm_manual_pooled.lookup_validated_local(jsonb,text)') IS NULL AS absent",
              )
            ).rows[0]?.['absent'],
          ).toBe(true);
        } finally {
          await p.query('ROLLBACK');
        }
        expect((await p.query(targetMetaSql)).rows[0]?.['value']).toEqual(targetMetadata);
      });
    },
  );
fixtureIt('repeated installation is rejected without changing exact target metadata', async () => {
  await owner(async (p) => {
    await p.query('BEGIN');
    try {
      await p.query('SAVEPOINT expected_reject');
      await expect(p.query(migration)).rejects.toThrow('POOLED_LOCAL_ALREADY_INSTALLED');
      await p.query('ROLLBACK TO SAVEPOINT expected_reject');
      expect((await p.query(targetMetaSql)).rows[0]?.['value']).toEqual(targetMetadata);
    } finally {
      await p.query('ROLLBACK');
    }
  });
});
fixtureIt(
  'withdrawal preserves receipt replay while fresh basis processing fails closed',
  async () => {
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      await store(tx, stableKey);
      await rejected(tx, () => validate(tx), 'APP_CONSENT_REQUIRED');
      await rejected(tx, () => store(tx, randomUUID()), 'APP_CONSENT_REQUIRED');
    });
  },
);

fixtureIt(
  'genuine source deletion nulls the entire encoded pool while original receipt remains minimal',
  async () => {
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    await createRaceRepository(db).deleteRaceEvent(athlete, basis().event.id, {
      expectedRevision: basis().event.revision,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      const read = await tx.query('SELECT public.read_manual_race_chain_v2($1) AS value', [
        storedIds.evidenceId,
      ]);
      expect(read.rows[0]?.['value']).toMatchObject({ payload: null });
      const replay = await store(tx, stableKey);
      expect(replay.rows[0]?.['value']).toMatchObject({
        ...storedIds,
        applicable: false,
        approvalAllowed: false,
      });
      await rejected(tx, () => validate(tx));
    });
  },
);
