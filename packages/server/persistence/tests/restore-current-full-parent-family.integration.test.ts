import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import {
  migrate,
  grantOperations,
  grantCorePlanning,
  grantNutritionCore,
  grantRecoveryCore,
  grantRoutineCore,
  grantSupplementaryCore,
  grantCheckIns,
  grantCourses,
  grantRaces,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root-only actual gate. Public producers create source/permission/chain facts;
// owner queries below capture catalog/physical child rows, never seed those rows.
// Empty relation census is tested, not claimed as nonempty producer acceptance.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `current_parent_load_${suffix}`,
  ownerRole = `current_parent_load_owner_${suffix}`,
  runtimeRole = `current_parent_load_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
let targetCreated = false;
const targetName = `${name}_target`;
function targetUrl(role: string) {
  const u = new URL(url(role));
  u.pathname = `/${targetName}`;
  return u.toString();
}
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
const migrations = [
  '108_nutrition_race_disconnection.sql',
  '109_race_result_proof_lifecycle.sql',
  '110_nutrition_disconnection_lineage.sql',
  '111_race_result_preserved_proof_updates.sql',
  '112_training_plan_aggregate_history.sql',
  '113_race_media_cleanup_source.sql',
  '114_manual_review_owned_source_bindings_v2.sql',
  '115_manual_review_full_owned_source_bindings_v2.sql',
  '116_manual_race_chain_v2.sql',
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
  await migrate(url(ownerRole), 107);
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    for (const file of migrations)
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    for (const signature of [
      'public.observe_manual_review_full_owned_source_bindings_v2(jsonb)',
      'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.read_manual_race_chain_receipt_v2(text,jsonb)',
      'public.read_manual_race_chain_v2(uuid)',
    ])
      await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantOperations,
    grantCorePlanning,
    grantNutritionCore,
    grantRecoveryCore,
    grantRoutineCore,
    grantSupplementaryCore,
    grantCheckIns,
    grantCourses,
    grantRaces,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
  ])
    await grant(url(ownerRole), runtimeRole);
  await admin.query(`CREATE DATABASE "${targetName}" OWNER "${ownerRole}"`);
  targetCreated = true;
  await migrate(targetUrl(ownerRole), 107);
  const target = new Pool({ connectionString: targetUrl(ownerRole) });
  try {
    for (const file of [...migrations, '117_restore_current_full_parent_family_loader.sql'])
      await target.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    await expect(target.query('SELECT wm_current_app_load.configure_target()')).rejects.toThrow(
      'CURRENT_LOAD_TARGET_BINDING_REQUIRED',
    );
    await target.query(
      `SELECT public.close_restore_processing_exact(
        (public.read_restore_processing_admission()->>'localRevision')::bigint,$1,$2,$3)`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    await target.query('SELECT wm_current_app_load.configure_target()');
  } finally {
    await target.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
}, 60000);
afterAll(async () => {
  await db?.close();
  if (targetCreated) await dropIsolatedDatabase(admin, targetName);
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
// Actual bounded SQL protocol acceptance, not host byte authentication. Source
// rows and originals come from public producers. Factory/operational adapter
// authority and unsupported parent partitions remain separate release gates.
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const rowSchema = z.record(z.string(), z.unknown());
const profileSchema = z.array(
  z.object({ relation: z.string(), schema: z.string(), table: z.string() }),
);
type Physical = {
  ordinal: number;
  relation: string;
  row: Record<string, unknown>;
  rowDigest: string;
};
async function capture(athlete: string) {
  const pool = new Pool({ connectionString: url(ownerRole) }),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    // Use the exact installed target profile, never caller-selected tables.
    const target = new Pool({ connectionString: targetUrl(ownerRole) });
    let profile: z.infer<typeof profileSchema>;
    try {
      profile = profileSchema.parse(
        (await target.query('SELECT wm_current_app_load.relation_profile() AS value')).rows[0]?.[
          'value'
        ],
      );
    } finally {
      await target.end();
    }
    const rows: Physical[] = [];
    const census: Record<string, number> = {};
    let bytes = 0n;
    for (const relation of profile) {
      const columns = z
        .array(z.object({ name: z.string(), type: z.string() }))
        .parse(
          (
            await c.query(
              `SELECT attname AS name,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,
              [`${quote(relation.schema)}.${quote(relation.table)}`],
            )
          ).rows,
        );
      const fields = columns.flatMap((column) => {
        const value = `s.${quote(column.name)}`;
        const expression =
          column.type === 'timestamp with time zone'
            ? `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
            : column.type === 'bigint' || column.type === 'name' || column.type === 'numeric'
              ? `${value}::text`
              : column.type === 'bytea'
                ? `CASE WHEN ${value} IS NULL THEN NULL ELSE chr(92)||'x'||encode(${value},'hex') END`
                : value;
        return [`'${column.name.replaceAll("'", "''")}'`, expression];
      });
      const bounded = z
        .object({ count: z.string(), bytes: z.string() })
        .parse(
          (
            await c.query(
              `SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(s)::text)),0)::text AS bytes FROM ${quote(relation.schema)}.${quote(relation.table)} s WHERE s.athlete_id::text=$1`,
              [athlete],
            )
          ).rows[0],
        );
      bytes += BigInt(bounded.bytes);
      if (rows.length + Number(bounded.count) > 5000 || bytes > 16n * 1024n * 1024n)
        throw Error('FIXTURE_CAPTURE_LIMIT');
      const body = await c.query(
        `SELECT jsonb_build_object(${fields.join(',')}) AS row FROM ${quote(relation.schema)}.${quote(relation.table)} s WHERE s.athlete_id::text=$1 ORDER BY to_jsonb(s)::text`,
        [athlete],
      );
      census[relation.relation] = body.rows.length;
      for (const raw of body.rows)
        rows.push({
          ordinal: rows.length + 1,
          relation: relation.relation,
          row: rowSchema.parse(raw['row']),
          rowDigest: '',
        });
    }
    await c.query('COMMIT');
    return { rows, census };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
async function scenario() {
  const athlete = randomUUID(),
    owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await owner.end();
  }
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic current parent load',
      localDate: '2026-10-08',
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
  const intent = {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' as const },
  };
  const basis = await createRaceManualSemanticBasisV2Service(db).prepare(athlete, intent);
  if (basis.status !== 'current_dependencies_captured') throw Error('BASIS_UNAVAILABLE');
  const command = {
    schemaVersion: 2 as const,
    idempotencyKey: randomUUID(),
    intent: basis.basis.intent,
    expectedBasis: basis.basis,
  };
  const repository = createRaceManualReviewChainV2Repository(db),
    stored = await repository.store(athlete, command);
  if (stored.status !== 'stored') throw Error('CHAIN_UNAVAILABLE');
  return { athlete, race, command, stored, repository };
}

async function withTarget<T>(athlete: string, work: (c: PoolClient) => Promise<T>) {
  const pool = new Pool({ connectionString: targetUrl(ownerRole) }),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
async function stage(
  c: PoolClient,
  athlete: string,
  snapshot: Awaited<ReturnType<typeof capture>>,
) {
  const run = randomUUID();
  for (const row of snapshot.rows)
    row.rowDigest = z
      .string()
      .parse(
        (
          await c.query('SELECT wm_current_app_load.hash_json($1::jsonb) AS digest', [
            JSON.stringify(row.row),
          ])
        ).rows[0]?.['digest'],
      );
  const expectedRowsDigest = z
    .string()
    .parse(
      (
        await c.query(
          `SELECT wm_current_app_load.hash_json(jsonb_agg(jsonb_build_object('ordinal',(r->>'ordinal')::int,'relation',r->>'relation','rowDigest',r->>'rowDigest') ORDER BY (r->>'ordinal')::int)) AS digest FROM jsonb_array_elements($1::jsonb) r`,
          [JSON.stringify(snapshot.rows)],
        )
      ).rows[0]?.['digest'],
    );
  const originalRowsDigest = z
    .string()
    .parse(
      (
        await c.query(
          `SELECT wm_current_app_load.hash_json(coalesce(jsonb_agg(jsonb_build_object('ordinal',(r->>'ordinal')::int,'rowDigest',r->>'rowDigest') ORDER BY (r->>'ordinal')::int),'[]'::jsonb)) AS digest FROM jsonb_array_elements($1::jsonb) r WHERE r->>'relation'='restore_suppression_event'`,
          [JSON.stringify(snapshot.rows)],
        )
      ).rows[0]?.['digest'],
    );
  const target = rowSchema.parse(
    (
      await c.query(
        `SELECT jsonb_build_object('catalogHash',catalog_hash,'nonce',nonce,'incarnation',incarnation,'generationId',generation_id,'controlRevision',control_revision::text,'state',state) AS value FROM wm_current_app_load.target`,
      )
    ).rows[0]?.['value'],
  );
  const descriptor = {
    profileVersion: 1,
    source: {
      systemIdentifier: '1',
      databaseOid: 1,
      captureId: randomUUID(),
      generationId: randomUUID(),
      registrySha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      baselineThroughLsn: '0/0',
    },
    parentArtifactDigest: 'a'.repeat(64),
    childArtifactDigest: 'b'.repeat(64),
    tailWitnessDigest: 'c'.repeat(64),
    originalRowsDigest,
    athleteId: athlete,
    expectedCount: snapshot.rows.length,
    expectedCensus: snapshot.census,
    expectedRowsDigest,
    target,
  };
  // Descriptor digest strings are correspondence fields, never factory claims.
  await c.query('SELECT wm_current_app_load.begin_stage($1,$2::jsonb)', [
    run,
    JSON.stringify(descriptor),
  ]);
  for (const row of snapshot.rows)
    await c.query('SELECT wm_current_app_load.stage_row($1,$2,$3,$4::jsonb,$5)', [
      run,
      row.ordinal,
      row.relation,
      JSON.stringify(row.row),
      row.rowDigest,
    ]);
  await c.query('SELECT wm_current_app_load.seal_stage($1)', [run]);
  return run;
}
async function load(c: PoolClient, run: string) {
  await c.query('SELECT wm_current_app_load.load_family($1)', [run]);
  await c.query('SELECT wm_current_app_load.post_replay($1)', [run]);
  await c.query('SELECT wm_current_app_load.finish_stage($1)', [run]);
}
it('loads actual public parent/child rows into CLOSED plain owner target, validates deferred constraints and preserves immutable chain/minimal receipt', async () => {
  const f = await scenario(),
    snapshot = await capture(f.athlete);
  expect(snapshot.census['manual_race_evidence_v2']).toBe(1);
  expect(snapshot.census['manual_race_v2_live_transition']).toBe(0);
  await withTarget(f.athlete, async (c) => {
    const run = await stage(c, f.athlete, snapshot);
    await load(c, run);
    const source = snapshot.rows.find((r) => r.relation === 'manual_race_evidence_v2');
    expect(source).toBeDefined();
    const row = (
      await c.query(
        "SELECT wm_current_app_load.encode_row('manual_race_evidence_v2',to_jsonb(h)) AS value FROM manual_race_evidence_v2 h WHERE athlete_id=$1",
        [f.athlete],
      )
    ).rows[0]?.['value'];
    expect(row).toEqual(source?.row);
    expect(
      (await c.query('SELECT finished FROM wm_current_app_load.descriptor WHERE run_id=$1', [run]))
        .rows[0]?.['finished'],
    ).toBe(true);
    expect(
      (await c.query('SELECT state FROM restore_processing_admission WHERE singleton')).rows[0]?.[
        'state'
      ],
    ).toBe('CLOSED');
  });
});
it('already installed genuine race original repurges restored body while preserving original event/time and minimal receipt', async () => {
  const f = await scenario(),
    snapshot = await capture(f.athlete);
  await createRaceRepository(db).deleteRaceEvent(f.athlete, f.race.id, {
    expectedRevision: f.race.revision,
    idempotencyKey: randomUUID(),
  });
  const deleted = await capture(f.athlete);
  const originals = deleted.rows.filter((r) => r.relation === 'restore_suppression_event');
  snapshot.rows = snapshot.rows.filter((r) => r.relation !== 'restore_suppression_event');
  snapshot.rows.push(...originals);
  snapshot.rows.forEach((r, i) => (r.ordinal = i + 1));
  snapshot.census['restore_suppression_event'] = originals.length;
  expect(originals.some((r) => r.row['kind'] === 'race_event_deleted')).toBe(true);
  await withTarget(f.athlete, async (c) => {
    const run = await stage(c, f.athlete, snapshot);
    await load(c, run);
    const evidence = (
      await c.query(
        'SELECT payload,purged_event_id FROM manual_race_evidence_v2 WHERE athlete_id=$1',
        [f.athlete],
      )
    ).rows[0];
    expect(evidence?.['payload']).toBeNull();
    expect(evidence?.['purged_event_id']).toBe(
      originals.find((r) => r.row['kind'] === 'race_event_deleted')?.row['event_id'],
    );
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS count FROM manual_race_chain_receipt_v2 WHERE athlete_id=$1',
          [f.athlete],
        )
      ).rows[0]?.['count'],
    ).toBe(1);
  });
});
it('rolls all loaded parents/children back when caller callback fails after load; no descriptor or source event leaks', async () => {
  const f = await scenario(),
    snapshot = await capture(f.athlete);
  await expect(
    withTarget(f.athlete, async (c) => {
      const run = await stage(c, f.athlete, snapshot);
      await load(c, run);
      throw Error('CALLBACK_FAILURE');
    }),
  ).rejects.toThrow('CALLBACK_FAILURE');
  await withTarget(f.athlete, async (c) =>
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS count FROM identity_private.account WHERE athlete_id=$1::uuid',
          [f.athlete],
        )
      ).rows[0]?.['count'],
    ).toBe(0),
  );
});
it('rejects unprivileged runtime GUC/hash claims without private grants or target mutation', async () => {
  const runtime = new Pool({ connectionString: targetUrl(runtimeRole) });
  try {
    await expect(
      runtime.query('SELECT wm_current_app_load.configure_target()'),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await runtime.end();
  }
});

it('loads two genuine tenants in exact UTF16 order within one CLOSED transaction without mixing original rows', async () => {
  const fixtures = await Promise.all([scenario(), scenario()]);
  fixtures.sort((a, b) => (a.athlete < b.athlete ? -1 : 1));
  const snapshots = await Promise.all(fixtures.map((f) => capture(f.athlete)));
  const pool = new Pool({ connectionString: targetUrl(ownerRole) }),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    for (const [i, f] of fixtures.entries()) {
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
      const snapshot = snapshots[i];
      if (!snapshot) throw Error('FIXTURE_MISSING');
      await load(c, await stage(c, f.athlete, snapshot));
      expect(
        (
          await c.query(
            'SELECT count(*)::int AS count FROM manual_race_evidence_v2 WHERE athlete_id=$1',
            [f.athlete],
          )
        ).rows[0]?.['count'],
      ).toBe(1);
    }
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
});
it('reuses the actual UTF16 key for opaque tenant ordering, including supplementary-plane versus BMP private-use codepoints', async () => {
  const c = new Pool({ connectionString: targetUrl(ownerRole) });
  try {
    const ids = ['\u{10000}', '\uE000'];
    expect([...ids].sort()).toEqual(ids);
    const rows = await c.query(
      'SELECT value FROM unnest($1::text[]) value ORDER BY public.nutrition_copy_utf16_key(value)',
      [[...ids].reverse()],
    );
    expect(rows.rows.map((row) => row['value'])).toEqual(ids);
  } finally {
    await c.end();
  }
});
it('rejects foreign physical tuple before loading and rolls back complete staged inventory', async () => {
  const f = await scenario(),
    snapshot = await capture(f.athlete);
  const row = snapshot.rows.find((r) => r.relation === 'manual_race_evidence_v2');
  if (!row) throw Error('FIXTURE_MISSING');
  row.row = { ...row.row, athlete_id: randomUUID() };
  await expect(withTarget(f.athlete, (c) => stage(c, f.athlete, snapshot))).rejects.toThrow(
    'CURRENT_LOAD_ROW_REJECTED',
  );
  await withTarget(f.athlete, async (c) =>
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS count FROM wm_current_app_load.descriptor WHERE athlete_id=$1',
          [f.athlete],
        )
      ).rows[0]?.['count'],
    ).toBe(0),
  );
});
it('rejects physical timestamp precision truncation and missing nullable columns before any parent load', async () => {
  const f = await scenario(),
    snapshot = await capture(f.athlete);
  const row = snapshot.rows.find((r) => r.relation === 'manual_race_evidence_v2');
  if (!row) throw Error('FIXTURE_MISSING');
  const created = z.string().parse(row.row['created_at']);
  row.row = { ...row.row, created_at: created.replace(/\.\d{6}Z$/, '.000Z') };
  await expect(withTarget(f.athlete, (c) => stage(c, f.athlete, snapshot))).rejects.toThrow(
    'CURRENT_LOAD_PHYSICAL_ENCODING_REJECTED',
  );
  const missing = await capture(f.athlete);
  const header = missing.rows.find((r) => r.relation === 'manual_race_evidence_v2');
  if (!header) throw Error('FIXTURE_MISSING');
  delete header.row['purged_at'];
  await expect(withTarget(f.athlete, (c) => stage(c, f.athlete, missing))).rejects.toThrow(
    'CURRENT_LOAD_COLUMN_REJECTED',
  );
});

it('preserves numeric privacy-generation decimal-string precision and scale instead of driver JSON number coercion', async () => {
  const c = new Pool({ connectionString: targetUrl(ownerRole) });
  try {
    const row = {
      athlete_id: randomUUID(),
      kind: 'race-event',
      revision: 1,
      privacy_generation: '9007199254740993.125000',
    };
    const value = (
      await c.query(
        "SELECT wm_current_app_load.physical_row('race_collection_head',$1::jsonb) AS value",
        [JSON.stringify(row)],
      )
    ).rows[0]?.['value'];
    expect(value).toEqual(row);
    await expect(
      c.query("SELECT wm_current_app_load.physical_row('race_collection_head',$1::jsonb)", [
        JSON.stringify({ ...row, privacy_generation: 9007199254740992 }),
      ]),
    ).rejects.toThrow('CURRENT_LOAD_PHYSICAL_ENCODING_REJECTED');
  } finally {
    await c.end();
  }
});
