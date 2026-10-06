import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  migrate,
  migrationFileNames,
  grantOperations,
  grantResources,
  grantNutritionCore,
} from '../src/migrate.js';
import {
  readRestoreProcessingAdmission,
  requireRestoreProcessingAdmission,
  lockRestoreProcessingShared,
  decodeRestoreProcessingAdmission,
  createRestoreProcessingOwnerPort,
  type RestoreProcessingAdmission,
} from '../src/restore-processing-admission.js';
import type { Transaction } from '../src/database.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real PostgreSQL primitive evidence only. Existing producers are not yet globally
// gated and no full proof, owner loader, independent authority, or reopen is tested.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `processing_closed_${suffix}`;
const roles = {
  owner: `processing_owner_${suffix}`,
  next: `processing_next_${suffix}`,
  runtime: `processing_app_${suffix}`,
  outside: `processing_public_${suffix}`,
};
const roleNames = Object.values(roles);
const clients: PoolClient[] = [];
let owner: PoolClient, runtime: PoolClient, outside: PoolClient, existingAthlete: string;
const ownerPool = new Pool({ connectionString: url(roles.owner), max: 5 });
const runtimePool = new Pool({ connectionString: url(roles.runtime), max: 5 });
const outsidePool = new Pool({ connectionString: url(roles.outside), max: 1 });
const nextPool = new Pool({ connectionString: url(roles.next), max: 1 });
const tenant = randomUUID(),
  foreign = randomUUID(),
  key = 'synthetic-replay';
let revision = '1';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const error = (message: string) => ({ message });
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function connect(role: string) {
  const pool =
    role === roles.owner
      ? ownerPool
      : role === roles.runtime
        ? runtimePool
        : role === roles.next
          ? nextPool
          : outsidePool;
  const client = await pool.connect();
  clients.push(client);
  return client;
}
async function scoped<T>(client: PoolClient, id: string, action: () => Promise<T>) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const result = await action();
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
function tx(client: PoolClient): Transaction {
  return {
    athleteId: tenant,
    query: (sql, values) => client.query<Record<string, unknown>>(sql, values),
  };
}
const read = (client: PoolClient): Promise<RestoreProcessingAdmission> =>
  readRestoreProcessingAdmission(tx(client));
const close = (
  client: PoolClient,
  rev: string | number,
  id: string,
  nonce: string | null = null,
  incarnation: string | null = null,
) =>
  createRestoreProcessingOwnerPort(client).close({
    expectedRevision: String(rev),
    commandId: id,
    targetNonce: nonce,
    targetIncarnation: incarnation,
  });
beforeAll(async () => {
  for (const role of roleNames)
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${roles.owner}"`);
  // Explicit upgrade fixture starts at100;101 is installed only by normal migrate.
  await migrate(url(roles.owner), 100);
  owner = await connect(roles.owner);
  runtime = await connect(roles.runtime);
  outside = await connect(roles.outside);
  existingAthlete = randomUUID();
  await scoped(owner, existingAthlete, () =>
    owner.query("INSERT INTO consent VALUES($1,'app',true,1)", [existingAthlete]),
  );
  await migrate(url(roles.owner));
  await grantOperations(url(roles.owner), roles.runtime);
  await grantResources(url(roles.owner), roles.runtime);
  await grantNutritionCore(url(roles.owner), roles.runtime);
  const installed = await owner.query(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  expect(installed.rows).toHaveLength(101);
  expect(migrationFileNames).toHaveLength(101);
  for (const [index, file] of migrationFileNames.entries())
    expect(installed.rows[index]).toEqual({
      version: index + 1,
      checksum: sha(await readFile(new URL(`../migrations/${file}`, import.meta.url))),
    });
  await scoped(owner, tenant, () =>
    owner.query('INSERT INTO command_receipt VALUES($1,$2,$3,$4)', [
      tenant,
      key,
      { hash: 'a'.repeat(64) },
      { id: randomUUID(), revision: 1 },
    ]),
  );
});
afterAll(async () => {
  for (const client of clients) client.release();
  await Promise.all([ownerPool.end(), runtimePool.end(), outsidePool.end(), nextPool.end()]);
  await dropIsolatedDatabase(admin, dbName);
  for (const role of roleNames) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('registered101 upgrade has CLOSED revision1, target absent, existing generation retained', async () => {
  const r = await read(runtime);
  assert.equal(r.state, 'CLOSED');
  assert.equal(r.localRevision, '1');
  assert.equal(r.targetNonce, null);
  assert.equal(r.targetIncarnation, null);
  assert.equal(r.admissionAllowed, false);
  assert.equal(r.targetAttested, false);
  assert.equal(
    (await runtime.query('SELECT current_restore_generation() AS id')).rows[0].id,
    r.generationId,
  );
  assert.equal(Buffer.byteLength(JSON.stringify(r)) < 512, true);
  assert.deepEqual(
    (
      await scoped(runtime, existingAthlete, () =>
        runtime.query("SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind='app'", [
          existingAthlete,
        ]),
      )
    ).rows,
    [{ granted: true, revision: 1 }],
  );
  await expect(requireRestoreProcessingAdmission(tx(runtime))).rejects.toMatchObject({
    code: 'RESTORE_PROCESSING_CLOSED',
  });
});
it('all owner/runtime roles plain and PUBLIC/function/directDML boundary', async () => {
  const flags = (
    await admin.query(
      'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)',
      [roleNames],
    )
  ).rows;
  assert.equal(flags.length, 4);
  for (const flag of flags)
    assert.deepEqual(flag, {
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  for (const c of [runtime, outside])
    for (const sql of [
      'SELECT * FROM restore_processing_admission',
      'INSERT INTO restore_processing_admission(singleton,generation_id) VALUES(true,gen_random_uuid())',
      "UPDATE restore_processing_admission SET state='ADMITTED'",
      'DELETE FROM restore_processing_admission',
      'SELECT * FROM restore_processing_close_receipt',
      'SELECT close_restore_processing_exact(1,gen_random_uuid())',
      'SELECT assert_restore_processing_closed(1)',
    ])
      await assert.rejects(c.query(sql), { code: '42501' });
  for (const fn of [
    'lock_restore_processing_shared()',
    'read_restore_processing_admission()',
    'require_restore_processing_admission()',
  ])
    await assert.rejects(outside.query(`SELECT ${fn}`), { code: '42501' });
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('admit_restore_processing_exact','open_restore_processing_admission')",
      )
    ).rows[0].n,
    0,
  );
});

it('successful receipt replay itself/retained reads allowed; new check denied independently', async () => {
  const expected = await scoped(owner, tenant, () =>
    owner.query('SELECT result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2', [
      tenant,
      key,
    ]),
  );
  const replay = await scoped(runtime, tenant, async () => {
    await lockRestoreProcessingShared(tx(runtime));
    await runtime.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      tenant,
    ]);
    await runtime.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);
    return runtime.query(
      'SELECT result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
      [tenant, key],
    );
  });
  assert.deepEqual(replay.rows, expected.rows);
  assert.equal(
    (
      await scoped(runtime, foreign, () =>
        runtime.query('SELECT result FROM command_receipt WHERE athlete_id=$1', [tenant]),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    scoped(runtime, tenant, () => runtime.query('SELECT require_restore_processing_admission()')),
    error('RESTORE_PROCESSING_CLOSED'),
  );
});
it('bool/GUC and owner ordinary DML cannot create an ADMITTED state', async () => {
  await scoped(runtime, tenant, async () => {
    await runtime.query(
      "SELECT set_config('app.restore_processing_admitted','true',true),set_config('app.verified','true',true),set_config('app.restore_target_nonce',$1,true)",
      [randomUUID()],
    );
    await expect(requireRestoreProcessingAdmission(tx(runtime))).rejects.toMatchObject({
      code: 'RESTORE_PROCESSING_CLOSED',
    });
    // Expected gate error aborts this read transaction; roll back rather than commit it.
    await runtime.query('ROLLBACK');
  });
  await assert.rejects(owner.query("UPDATE restore_processing_admission SET state='ADMITTED'"), {
    code: '23514',
  });
  await assert.rejects(runtime.query('SELECT require_restore_processing_admission(true)'), {
    code: '42883',
  });
  assert.equal((await read(runtime)).state, 'CLOSED');
});

it('owner exact close stores minimal immutable receipt and exact retry returns original', async () => {
  const id = randomUUID(),
    nonce = randomUUID(),
    incarnation = randomUUID();
  const first = await close(owner, 1, id, nonce, incarnation);
  assert.equal(first.localRevision, '2');
  assert.equal(first.targetNonce, nonce);
  assert.equal(first.targetAttested, false);
  assert.deepEqual(await close(owner, 1, id, nonce, incarnation), first);
  await assert.rejects(
    close(owner, 1, id, randomUUID(), incarnation),
    error('RESTORE_PROCESSING_CLOSE_CONFLICT'),
  );
  await assert.rejects(close(owner, 1, randomUUID()), error('RESTORE_PROCESSING_CONTROL_CONFLICT'));
  await assert.rejects(
    owner.query('UPDATE restore_processing_close_receipt SET expected_revision=expected_revision'),
    error('IMMUTABLE_RESTORE_PROCESSING_CLOSE_RECEIPT'),
  );
  assert.equal(
    (await owner.query('SELECT count(*)::int n FROM restore_processing_close_receipt')).rows[0].n,
    1,
  );
  const assertion = await createRestoreProcessingOwnerPort(owner).assertClosed({
    expectedRevision: '2',
    targetNonce: nonce,
    targetIncarnation: incarnation,
  });
  assert.deepEqual(assertion, first);
  await assert.rejects(
    owner.query('SELECT assert_restore_processing_closed($1,$2,$3)', [
      2,
      randomUUID(),
      incarnation,
    ]),
    error('RESTORE_PROCESSING_CONTROL_CONFLICT'),
  );
  revision = '2';
});
it('rollback leaves control revision/identity/generation/receipt unchanged', async () => {
  const before = await read(runtime),
    id = randomUUID();
  await owner.query('BEGIN');
  await close(owner, revision, id);
  await owner.query('SELECT rotate_restore_generation()');
  await owner.query('ROLLBACK');
  assert.deepEqual(await read(runtime), before);
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int n FROM restore_processing_close_receipt WHERE command_id=$1',
        [id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await runtime.query('SELECT current_restore_generation() id')).rows[0].id,
    before.generationId,
  );
});
it('overflow and missing control fail closed without assuming default admission', async () => {
  await owner.query('BEGIN');
  await owner.query('UPDATE restore_processing_admission SET local_revision=9223372036854775807');
  await assert.rejects(
    close(owner, '9223372036854775807', randomUUID()),
    error('RESTORE_PROCESSING_REVISION_EXHAUSTED'),
  );
  await owner.query('ROLLBACK');
  await owner.query('BEGIN');
  await owner.query('DELETE FROM restore_processing_admission');
  await assert.rejects(read(owner), error('RESTORE_PROCESSING_CONTROL_MISSING'));
  await owner.query('ROLLBACK');
  assert.equal((await read(runtime)).localRevision, revision);
});
it('committed missing control rejects runtime; fresh default row still CLOSED', async () => {
  const before = await read(runtime);
  await owner.query('DELETE FROM restore_processing_admission');
  await assert.rejects(read(runtime), error('RESTORE_PROCESSING_CONTROL_MISSING'));
  await assert.rejects(
    runtime.query('SELECT require_restore_processing_admission()'),
    error('RESTORE_PROCESSING_CONTROL_MISSING'),
  );
  assert.equal(
    (await runtime.query('SELECT current_restore_generation() id')).rows[0].id,
    before.generationId,
  );
  await owner.query('BEGIN');
  await owner.query(
    'INSERT INTO restore_processing_admission(singleton,generation_id) VALUES(true,$1)',
    [before.generationId],
  );
  assert.equal((await read(owner)).state, 'CLOSED');
  assert.equal((await read(owner)).localRevision, '1');
  await owner.query('ROLLBACK');
  await owner.query(
    'INSERT INTO restore_processing_admission(singleton,local_revision,generation_id,target_nonce,target_incarnation) VALUES(true,$1,$2,$3,$4)',
    [before.localRevision, before.generationId, before.targetNonce, before.targetIncarnation],
  );
  assert.deepEqual(await read(runtime), before);
});
it('actual global exclusive blocks shared before lifecycle77206/tenant0', async () => {
  const held = await connect(roles.owner),
    waiter = await connect(roles.runtime);
  await held.query('BEGIN');
  await held.query('SELECT assert_restore_processing_closed($1,$2,$3)', [
    revision,
    (await read(owner)).targetNonce,
    (await read(owner)).targetIncarnation,
  ]);
  await waiter.query('BEGIN');
  const pid = z
    .number()
    .int()
    .parse((await waiter.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
  let gotGlobal = false;
  const waiting = (async () => {
    await waiter.query('SELECT lock_restore_processing_shared()');
    gotGlobal = true;
    await waiter.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [tenant]);
    await waiter.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);
  })();
  const deadline = Date.now() + 2000;
  let observed = false;
  while (Date.now() < deadline) {
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const q = await admin.query(
      "SELECT classid::int,objid::int,objsubid,granted FROM pg_locks WHERE pid=$1 AND locktype='advisory'",
      [pid],
    );
    if (
      q.rows.some(
        (x: Record<string, unknown>) =>
          x['classid'] === 77210 && x['objid'] === 1 && x['objsubid'] === 2 && !x['granted'],
      )
    ) {
      assert.equal(q.rows.length, 1);
      observed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(observed, true);
  assert.equal(gotGlobal, false);
  await held.query('COMMIT');
  await waiting;
  await waiter.query('ROLLBACK');
});
it('global shared holder forces close to wait, then close remains CLOSED', async () => {
  const held = await connect(roles.runtime),
    waiter = await connect(roles.owner);
  await held.query('BEGIN');
  await held.query('SELECT lock_restore_processing_shared()');
  await held.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [tenant]);
  await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);
  const pid = z
    .number()
    .int()
    .parse((await waiter.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
  let done = false;
  const waiting = close(waiter, revision, randomUUID()).then((value) => {
    done = true;
    return value;
  });
  const deadline = Date.now() + 2000;
  let observed = false;
  while (Date.now() < deadline) {
    const q = await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) blocked",
      [pid],
    );
    if (q.rows[0].blocked) {
      observed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(observed, true);
  assert.equal(done, false);
  await held.query('COMMIT');
  const value = await waiting;
  assert.equal(value.state, 'CLOSED');
  revision = value.localRevision;
});
it('REASSIGN plus existing retarget preserves live owner checks and denies old owner', async () => {
  const reassignmentUrl = new URL(url(roles.owner));
  const authorityUrl = new URL(adminUrl);
  reassignmentUrl.username = authorityUrl.username;
  reassignmentUrl.password = authorityUrl.password;
  const bootstrap = new Pool({ connectionString: reassignmentUrl.toString() });
  try {
    await bootstrap.query(`GRANT "${roles.next}" TO "${roles.owner}"`);
    await owner.query(`REASSIGN OWNED BY "${roles.owner}" TO "${roles.next}"`);
  } finally {
    await bootstrap.query(`REVOKE "${roles.next}" FROM "${roles.owner}"`);
    await bootstrap.end();
  }
  const next = await connect(roles.next);
  await next.query('SELECT retarget_definer_policies()');
  const ownership = (
    await next.query(
      "SELECT relname,pg_get_userbyid(relowner) owner FROM pg_class WHERE relname IN ('restore_processing_admission','restore_processing_close_receipt','restore_generation')",
    )
  ).rows;
  assert.equal(ownership.length, 3);
  assert.ok(ownership.every((x) => x.owner === roles.next));
  const funcs = (
    await next.query(
      "SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig FROM pg_proc WHERE proname IN ('read_restore_processing_admission','close_restore_processing_exact','assert_restore_processing_closed')",
    )
  ).rows;
  assert.equal(funcs.length, 3);
  assert.ok(
    funcs.every(
      (x) =>
        x.owner === roles.next &&
        x.prosecdef &&
        x.proconfig.includes('search_path=pg_catalog, pg_temp'),
    ),
  );
  await close(next, revision, randomUUID());
  await assert.rejects(
    owner.query('SELECT close_restore_processing_exact($1,$2)', [revision, randomUUID()]),
    { code: '42501' },
  );
  // Even an explicit erroneous EXECUTE grant cannot forge the live session-owner authority.
  await next.query(
    `GRANT EXECUTE ON FUNCTION close_restore_processing_exact(bigint,uuid,uuid,uuid) TO "${roles.owner}"`,
  );
  await assert.rejects(
    close(owner, revision, randomUUID()),
    error('RESTORE_PROCESSING_OWNER_REQUIRED'),
  );
  await expect(requireRestoreProcessingAdmission(tx(runtime))).rejects.toMatchObject({
    code: 'RESTORE_PROCESSING_CLOSED',
  });
  assert.equal((await read(runtime)).admissionAllowed, false);
});

it('strict decoder preserves bigint revision strings and rejects unknown/open/invalid target facts', () => {
  const value = {
    state: 'CLOSED',
    localRevision: '9223372036854775807',
    generationId: randomUUID(),
    targetNonce: null,
    targetIncarnation: null,
    admissionAllowed: false,
    targetAttested: false,
  };
  expect(decodeRestoreProcessingAdmission(value).localRevision).toBe(value.localRevision);
  for (const input of [
    { ...value, state: 'ADMITTED' },
    { ...value, localRevision: '0' },
    { ...value, localRevision: '01' },
    { ...value, localRevision: '9223372036854775808' },
    { ...value, localRevision: 1 },
    { ...value, targetNonce: randomUUID() },
    { ...value, generationId: 'invalid' },
    { ...value, admissionAllowed: true },
    { ...value, verified: true },
  ])
    expect(() => decodeRestoreProcessingAdmission(input)).toThrow(
      'INVALID_RESTORE_PROCESSING_CONTROL',
    );
});
it('runtime owner-port wiring and malformed owner commands fail before owner mutation', async () => {
  const port = createRestoreProcessingOwnerPort(runtime);
  await expect(
    port.close({
      expectedRevision: '1',
      commandId: randomUUID(),
      targetNonce: null,
      targetIncarnation: null,
    }),
  ).rejects.toThrow('RESTORE_PROCESSING_OWNER_REQUIRED');
  await expect(
    port.assertClosed({
      expectedRevision: '1',
      targetNonce: null,
      targetIncarnation: null,
      verified: true,
    }),
  ).rejects.toThrow('INVALID_RESTORE_PROCESSING_CONTROL');
  await expect(
    port.close({
      expectedRevision: '0',
      commandId: randomUUID(),
      targetNonce: null,
      targetIncarnation: null,
    }),
  ).rejects.toThrow('INVALID_RESTORE_PROCESSING_CLOSE');
});
