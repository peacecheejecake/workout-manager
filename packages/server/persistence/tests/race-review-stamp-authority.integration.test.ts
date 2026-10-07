import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import type { RaceResultValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantCorePlanning, grantOperations, grantRaces } from '../src/migrate.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createConsentRepository } from '../src/repositories.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// SQL107 runtime write authority, rollback and owner maintenance boundaries.
// Synthetic offline stamps are not official verification.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const dbName = `stamp_${suffix}`;
const ownerRole = `stamp_owner_${suffix}`;
const nextOwnerRole = `stamp_next_${suffix}`;
const runtimeRole = `stamp_app_${suffix}`;
let owner: Pool;
let nextOwner: Pool;
let inspector: Pool;
let database: Database;
let races: RaceRepository;
let createdDatabase = false;
const createdRoles: string[] = [];
const stamp = '2026-10-07T00:00:00.000Z';
const values: RaceResultValues = {
  kind: 'race-result',
  raceEventId: null,
  localDate: '2026-10-07',
  timezone: 'UTC',
  source: {
    kind: 'official',
    authority: 'Synthetic unverified source',
    resultUrl: 'https://example.invalid/result',
  },
  chipSeconds: null,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: null,
  linkedActivityId: null,
  weatherNote: null,
};
function url(role: string) {
  const result = new URL(adminUrl);
  result.pathname = `/${dbName}`;
  result.username = role;
  result.password = 'isolated';
  return result.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, nextOwnerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  createdDatabase = true;
  await migrate(url(ownerRole), 107);
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 2 });
  nextOwner = new Pool({ connectionString: url(nextOwnerRole), max: 1 });
  const inspectorUrl = new URL(adminUrl);
  inspectorUrl.pathname = `/${dbName}`;
  inspector = new Pool({ connectionString: inspectorUrl.toString(), max: 1 });
  database = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  races = createRaceRepository(database);
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS count,max(version) AS version FROM schema_migrations',
      )
    ).rows,
  ).toEqual([{ count: 107, version: 107 }]);
  const roles = await admin.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
    [[ownerRole, nextOwnerRole, runtimeRole]],
  );
  expect(roles.rows).toHaveLength(3);
  for (const role of roles.rows) expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await nextOwner?.end();
  await inspector?.end();
  if (createdDatabase) await dropIsolatedDatabase(admin, dbName);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function owned<T>(
  pool: Pool,
  athlete: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athlete,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function fixture() {
  const athlete = randomUUID();
  await createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const input = { idempotencyKey: randomUUID(), values };
  const saved = await races.createRaceResult(athlete, input);
  return { athlete, input, saved };
}
const snapshotSchema = z.strictObject({
  heads: z.number().int(),
  history: z.number().int(),
  receipts: z.number().int(),
  outbox: z.number().int(),
  head_hash: z.string().regex(/^[a-f0-9]{64}$/),
  history_hash: z.string().regex(/^[a-f0-9]{64}$/),
  receipt_hash: z.string().regex(/^[a-f0-9]{64}$/),
  outbox_hash: z.string().regex(/^[a-f0-9]{64}$/),
  collection_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
async function snapshot(athlete: string) {
  return database.tenant(athlete, async (tx) =>
    snapshotSchema.parse(
      (
        await tx.query(
          `SELECT
    (SELECT count(*)::int FROM race_result WHERE athlete_id=$1) AS heads,
    (SELECT count(*)::int FROM race_result_revision WHERE athlete_id=$1) AS history,
    (SELECT count(*)::int FROM race_command_receipt WHERE athlete_id=$1) AS receipts,
    (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox,
    (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(h) ORDER BY id)::text,'[]'),'UTF8')),'hex') FROM race_result h WHERE athlete_id=$1) AS head_hash,
    (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(h) ORDER BY entity_id,revision)::text,'[]'),'UTF8')),'hex') FROM race_result_revision h WHERE athlete_id=$1) AS history_hash,
    (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(h) ORDER BY idempotency_key)::text,'[]'),'UTF8')),'hex') FROM race_command_receipt h WHERE athlete_id=$1) AS receipt_hash,
    (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(h) ORDER BY id)::text,'[]'),'UTF8')),'hex') FROM outbox h WHERE athlete_id=$1) AS outbox_hash,
    (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(h) ORDER BY kind)::text,'[]'),'UTF8')),'hex') FROM race_collection_head h WHERE athlete_id=$1) AS collection_hash`,
          [athlete],
        )
      ).rows[0],
    ),
  );
}
async function provisionalWrites(tx: Transaction, id: string) {
  await tx.query(
    "UPDATE race_collection_head SET revision=revision+1 WHERE athlete_id=$1 AND kind='race-result'",
    [tx.athleteId],
  );
  await tx.query(
    'INSERT INTO race_command_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
    [tx.athleteId, randomUUID(), '0'.repeat(64), JSON.stringify({ id, revision: 1 })],
  );
  await tx.query(
    'INSERT INTO outbox(athlete_id,id,idempotency_key,topic,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
    [tx.athleteId, randomUUID(), randomUUID(), 'synthetic.stamp-rollback', '{}'],
  );
}
const modes = ['head_insert', 'head_update', 'history_insert'] as const;
type Mode = (typeof modes)[number];
async function forge(tx: Transaction, id: string, mode: Mode, body: unknown) {
  const json = JSON.stringify(body);
  if (mode === 'head_insert')
    return tx.query(
      'INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) SELECT athlete_id,$3::uuid,1,$4::jsonb,recorded_at,updated_at FROM race_result WHERE athlete_id=$1 AND id=$2',
      [tx.athleteId, id, randomUUID(), json],
    );
  if (mode === 'head_update')
    return tx.query('UPDATE race_result SET values_json=$3::jsonb WHERE athlete_id=$1 AND id=$2', [
      tx.athleteId,
      id,
      json,
    ]);
  return tx.query(
    'INSERT INTO race_result_revision(athlete_id,entity_id,revision,values_json,created_at) SELECT athlete_id,id,2,$3::jsonb,updated_at FROM race_result WHERE athlete_id=$1 AND id=$2',
    [tx.athleteId, id, json],
  );
}
for (const mode of modes) {
  it.each([
    { label: 'string', value: stamp },
    { label: 'number', value: 0 },
    { label: 'boolean', value: false },
    { label: 'object', value: {} },
    { label: 'array', value: [] },
  ])(`denies ${mode} nonnull $label with complete transaction rollback`, async ({ value }) => {
    const { athlete, saved } = await fixture();
    const before = await snapshot(athlete);
    await expect(
      database.tenant(athlete, async (tx) => {
        await provisionalWrites(tx, saved.id);
        await forge(tx, saved.id, mode, {
          ...values,
          source: { ...values.source, verifiedAt: value },
        });
      }),
    ).rejects.toMatchObject({
      code: '42501',
      message: 'RACE_REVIEW_STAMP_OWNER_REQUIRED',
    });
    expect(await snapshot(athlete)).toEqual(before);
  });
  it(`does not trust source kind in ${mode}`, async () => {
    const { athlete, saved } = await fixture();
    const before = await snapshot(athlete);
    await expect(
      database.tenant(athlete, (tx) =>
        forge(tx, saved.id, mode, {
          ...values,
          source: { kind: 'device', verifiedAt: stamp },
        }),
      ),
    ).rejects.toMatchObject({
      code: '42501',
      message: 'RACE_REVIEW_STAMP_OWNER_REQUIRED',
    });
    expect(await snapshot(athlete)).toEqual(before);
  });
}
it('allows missing/JSON null normal writes, owner historical stamps and runtime null correction', async () => {
  const { athlete, saved } = await fixture();
  expect((await races.getRaceResult(athlete, saved.id))?.source).toMatchObject({
    verifiedAt: null,
  });
  await database.tenant(athlete, (tx) => forge(tx, saved.id, 'head_update', values));
  await database.tenant(athlete, (tx) =>
    forge(tx, saved.id, 'head_update', {
      ...values,
      source: { ...values.source, verifiedAt: null },
    }),
  );
  // Named synthetic historical metadata; not an official-review command.
  await owned(owner, athlete, (client) =>
    client.query(
      "UPDATE race_result SET values_json=jsonb_set(values_json,'{source,verifiedAt}',to_jsonb($3::text)) WHERE athlete_id=$1 AND id=$2",
      [athlete, saved.id, stamp],
    ),
  );
  const historical = await fixture();
  await owned(owner, historical.athlete, (client) =>
    client.query(
      "INSERT INTO race_result_revision(athlete_id,entity_id,revision,values_json,created_at) SELECT athlete_id,id,2,jsonb_set(values_json,'{source,verifiedAt}',to_jsonb($3::text)),updated_at FROM race_result WHERE athlete_id=$1 AND id=$2",
      [historical.athlete, historical.saved.id, stamp],
    ),
  );
  expect(
    await database.tenant(
      historical.athlete,
      async (tx) =>
        (
          await tx.query(
            "SELECT values_json#>>'{source,verifiedAt}' AS stamp FROM race_result_revision WHERE athlete_id=$1 AND entity_id=$2 AND revision=2",
            [historical.athlete, historical.saved.id],
          )
        ).rows,
    ),
  ).toEqual([{ stamp }]);
  const corrected = await races.updateRaceResult(athlete, saved.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...values, chipSeconds: 0 },
  });
  expect(corrected.revision).toBe(2);
  expect((await races.getRaceResult(athlete, saved.id))?.source).toMatchObject({
    verifiedAt: null,
  });
});
it('replays committed receipt before revoke gate; new writes denied and deletion/read permitted', async () => {
  const { athlete, input, saved } = await fixture();
  await createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const before = await snapshot(athlete);
  expect(await races.createRaceResult(athlete, input)).toEqual(saved);
  expect(await snapshot(athlete)).toEqual(before);
  await expect(
    races.createRaceResult(athlete, { ...input, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await expect(
    races.createRaceResult(athlete, {
      ...input,
      values: { ...values, chipSeconds: 0 },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await races.getRaceResult(athlete, saved.id)).not.toBeNull();
  expect((await races.listRaceResults(athlete)).items).toHaveLength(1);
  await races.deleteRaceResult(athlete, saved.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
  });
  expect(await races.getRaceResult(athlete, saved.id)).toBeNull();
});
it('populated foreign tenant cannot read or mutate another result', async () => {
  const own = await fixture();
  const foreign = await fixture();
  const before = await snapshot(own.athlete);
  const updated = await database.tenant(foreign.athlete, (tx) =>
    tx.query(
      "UPDATE race_result SET values_json=jsonb_set(values_json,'{source,verifiedAt}',to_jsonb($3::text)) WHERE athlete_id=$1 AND id=$2",
      [own.athlete, own.saved.id, stamp],
    ),
  );
  expect(updated.rowCount).toBe(0);
  expect(await races.getRaceResult(foreign.athlete, own.saved.id)).toBeNull();
  await expect(
    database.tenant(foreign.athlete, (tx) =>
      tx.query(
        'INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
        [
          own.athlete,
          randomUUID(),
          JSON.stringify({
            ...values,
            source: { ...values.source, verifiedAt: null },
          }),
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: 'P0001', message: 'RACE_TENANT_MISMATCH' });
  expect(await snapshot(own.athlete)).toEqual(before);
});
it('COPY FROM STDIN is rejected by native RLS before any stamp write', async () => {
  const { athlete } = await fixture();
  const before = await snapshot(athlete);
  const u = new URL(url(runtimeRole));
  const program = join(z.string().min(1).parse(process.env['PG_BIN']), 'psql');
  // stdin/stderr stay in memory; never print source body, tenant IDs or credentials.
  const script = `\\set VERBOSITY verbose\nBEGIN;\nSELECT pg_advisory_xact_lock_shared(77210,1);\nDO $$ BEGIN PERFORM set_config('app.athlete_id','${athlete}',true); END $$;\nCOPY public.race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) FROM STDIN;\n${athlete}\t${randomUUID()}\t1\t${JSON.stringify({ ...values, source: { ...values.source, verifiedAt: stamp } })}\t${stamp}\t${stamp}\n\\.\nCOMMIT;\n`;
  const result = spawnSync(program, ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
    input: script,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
    env: {
      ...process.env,
      PGHOST: decodeURIComponent(u.searchParams.get('host') ?? u.hostname),
      PGPORT: u.port || '5432',
      PGDATABASE: dbName,
      PGUSER: runtimeRole,
      PGPASSWORD: 'isolated',
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(3);
  // PostgreSQL rejects COPY FROM on RLS-protected tables before row triggers.
  // This is native COPY denial, not evidence of the stamp trigger branch.
  expect(result.stderr).toMatch(/ERROR:\s+0A000:/);
  expect(result.stderr).toContain('COPY FROM not supported with row-level security');
  expect(await snapshot(athlete)).toEqual(before);
});
it('follows actual table owner after transfer, without trusting super/admin callers', async () => {
  const { athlete, saved } = await fixture();
  await expect(
    owned(inspector, athlete, (client) =>
      client.query(
        "UPDATE race_result SET values_json=jsonb_set(values_json,'{source,verifiedAt}',to_jsonb($3::text)) WHERE athlete_id=$1 AND id=$2",
        [athlete, saved.id, stamp],
      ),
    ),
  ).rejects.toMatchObject({
    code: '42501',
    message: 'RACE_REVIEW_STAMP_OWNER_REQUIRED',
  });
  await inspector.query(`ALTER TABLE public.race_result OWNER TO "${nextOwnerRole}"`);
  try {
    expect(
      (
        await inspector.query(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.race_result'::regclass",
        )
      ).rows,
    ).toEqual([{ owner: nextOwnerRole }]);
    await owned(nextOwner, athlete, (client) =>
      client.query(
        "UPDATE race_result SET values_json=jsonb_set(values_json,'{source,verifiedAt}',to_jsonb($3::text)) WHERE athlete_id=$1 AND id=$2",
        [athlete, saved.id, stamp],
      ),
    );
    // Previous owner may fail at ACL before the trigger: do not label that as
    // evidence of the trigger branch. No extra GRANT is added for this test.
    await expect(
      owned(owner, athlete, (client) =>
        client.query(
          "UPDATE race_result SET values_json=jsonb_set(values_json,'{source,verifiedAt}',to_jsonb($3::text)) WHERE athlete_id=$1 AND id=$2",
          [athlete, saved.id, stamp],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await inspector.query(`ALTER TABLE public.race_result OWNER TO "${ownerRole}"`);
  }
  expect((await races.getRaceResult(athlete, saved.id))?.source).toMatchObject({
    verifiedAt: stamp,
  });
});
