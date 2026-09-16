import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import { createActivityRepository } from '../src/activities.js';
import { createIdentityRepository } from '../src/identity.js';
import { migrate, grantIdentityFunctions } from '../src/migrate.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let operations: OperationsRepository;
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
beforeAll(async () => {
  await migrate(adminUrl);
  await grantIdentityFunctions(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT ON tenant_erasure TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON operations_audit TO workout_runtime');
  await admin.query('GRANT EXECUTE ON FUNCTION public.erase_account(text) TO workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,outbox,command_receipt,plan_snapshot,plan_head,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
  operations = createOperationsRepository(database);
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
async function seed(athlete: string) {
  const imported = await createActivityRepository(database).importActivity(athlete, {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: hash() },
    activity: {
      title: 'Private fixture',
      kind: 'running',
      startedAt: null,
      timezone: null,
      durationSeconds: null,
      durationKind: 'unknown',
      distanceMeters: 0,
    },
  });
  await database.tenant(athlete, async (tx) => {
    const id = randomUUID();
    await tx.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
      [athlete, id, JSON.stringify({ fixture: 'private-plan' })],
    );
    await tx.query('INSERT INTO plan_head(athlete_id,version_id) VALUES($1,$2)', [athlete, id]);
    await tx.query(
      "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
      [athlete, id],
    );
    await tx.query("INSERT INTO consent VALUES($1,'ai',true,1)", [athlete]);
  });
  return imported;
}
const sessionInput = () => ({
  tokenHash: hash(),
  csrfToken: hash(),
  issuer: 'https://identity.example',
  subject: randomUUID(),
  now: new Date(),
  expiresAt: new Date(Date.now() + 60000),
});
async function waitForBlockedLogin() {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const result = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%auth_create_session%' AND pid<>pg_backend_pid()",
    );
    if (result.rowCount) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected login to wait on erasure lock');
}

describe('M1-06a scoped export, operational status and durable erasure', () => {
  it('exports a complete allowlisted tenant snapshot without credentials, receipts or outbox internals', async () => {
    const first = randomUUID(),
      second = randomUUID();
    await seed(first);
    await seed(second);
    await database.tenant(first, (tx) =>
      tx.query('INSERT INTO command_receipt VALUES($1,$2,$3::jsonb,$3::jsonb)', [
        first,
        randomUUID(),
        JSON.stringify({ token: 'MUST_NOT_EXPORT' }),
      ]),
    );
    const artifact = await operations.exportAccount(first);
    expect(artifact.data.activities).toHaveLength(1);
    expect(artifact.data.planSnapshots).toHaveLength(1);
    expect(artifact.data.sourceRevisions).toHaveLength(1);
    expect(artifact.athleteId).toBe(first);
    expect(JSON.stringify(artifact)).not.toContain(second);
    expect(JSON.stringify(artifact)).not.toContain('MUST_NOT_EXPORT');
    expect(Object.keys(artifact.data)).not.toContain('outbox');
    const status = await operations.status(first);
    expect(status.outbox.pending).toBe(1);
    expect(status.audit[0]?.action).toBe('export_requested');
    expect((await operations.status(second)).audit).toEqual([]);
  });
  it('rejects more than1000 rows or oversized exports rather than returning a truncated success', async () => {
    const athlete = randomUUID();
    await database.tenant(athlete, (tx) =>
      tx.query(
        "INSERT INTO activity_canonical(athlete_id,id,revision,original) SELECT $1,gen_random_uuid(),1,'{}'::jsonb FROM generate_series(1,1001)",
        [athlete],
      ),
    );
    await expect(operations.exportAccount(athlete)).rejects.toMatchObject({
      code: 'EXPORT_TOO_LARGE',
    });
    expect((await operations.status(athlete)).audit).toEqual([]);
    const big = randomUUID();
    await database.tenant(big, (tx) =>
      tx.query(
        "INSERT INTO plan_snapshot(athlete_id,id,version,draft) SELECT $1,gen_random_uuid(),n,jsonb_build_object('body',repeat('x',950000)) FROM generate_series(1,9) n",
        [big],
      ),
    );
    await expect(operations.exportAccount(big)).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  });
  it('erases all health/history/source/auth records and blocks stale writes while keeping only bounded audit facts', async () => {
    const identities = createIdentityRepository({ connectionString: runtimeUrl });
    try {
      const input = sessionInput();
      const identity = await identities.createSession(input);
      await seed(identity.athleteId);
      const other = randomUUID();
      await seed(other);
      expect(await operations.eraseAccount(identity.athleteId)).toEqual({ erased: true });
      expect(await operations.eraseAccount(identity.athleteId)).toEqual({ erased: true });
      expect(await identities.findSession(input.tokenHash, new Date())).toBeNull();
      const account = await admin.query(
        'SELECT * FROM identity_private.account WHERE athlete_id=$1',
        [identity.athleteId],
      );
      expect(account.rows).toEqual([]);
      for (const table of [
        'activity_canonical',
        'activity_source_head',
        'activity_source_revision',
        'activity_overlay',
        'activity_overlay_revision',
        'activity_suppression',
        'activity_import_receipt',
        'plan_head',
        'plan_snapshot',
        'plan_history',
        'consent',
        'command_receipt',
        'outbox',
      ]) {
        const result = await admin.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`,
          [identity.athleteId],
        );
        expect(result.rows[0].count).toBe(0);
      }
      const facts = await admin.query('SELECT action FROM operations_audit WHERE athlete_id=$1', [
        identity.athleteId,
      ]);
      expect(facts.rows).toEqual([{ action: 'account_erased' }]);
      await expect(
        database.tenant(identity.athleteId, (tx) =>
          tx.query("INSERT INTO consent VALUES($1,'ai',true,1)", [identity.athleteId]),
        ),
      ).rejects.toThrow('ACCOUNT_ERASED');
      expect((await operations.exportAccount(other)).data.activities).toHaveLength(1);
      const newIdentity = await identities.createSession({ ...input, tokenHash: hash() });
      expect(newIdentity.athleteId).not.toBe(identity.athleteId);
    } finally {
      await identities.close();
    }
  });
  it('rejects cross-tenant erasure and direct runtime deletion of immutable plan history', async () => {
    const first = randomUUID(),
      second = randomUUID();
    await seed(first);
    await expect(
      database.exclusiveTenant(second, (tx) =>
        tx.query('SELECT public.erase_account($1)', [first]),
      ),
    ).rejects.toThrow('ERASURE_TENANT_MISMATCH');
    await expect(
      database.tenant(first, (tx) =>
        tx.query('DELETE FROM plan_history WHERE athlete_id=$1', [first]),
      ),
    ).rejects.toThrow('IMMUTABLE_PLAN_RECORD');
    expect((await operations.exportAccount(first)).data.planHistory).toHaveLength(1);
  });
  it('rolls back erasure of health, identity, audit and tombstone together', async () => {
    const identities = createIdentityRepository({ connectionString: runtimeUrl });
    try {
      const input = sessionInput();
      const identity = await identities.createSession(input);
      await seed(identity.athleteId);
      await expect(
        database.exclusiveTenant(identity.athleteId, async (tx) => {
          await tx.query('SELECT public.erase_account($1)', [identity.athleteId]);
          throw new Error('simulate commit failure');
        }),
      ).rejects.toThrow('simulate commit failure');
      expect((await operations.exportAccount(identity.athleteId)).data.activities).toHaveLength(1);
      expect(await identities.findSession(input.tokenHash, new Date())).not.toBeNull();
      const erased = await admin.query('SELECT * FROM tenant_erasure WHERE athlete_id=$1', [
        identity.athleteId,
      ]);
      expect(erased.rows).toEqual([]);
    } finally {
      await identities.close();
    }
  });
  it('a login waiting behind deletion creates a fresh identity and cannot restore the retired athlete', async () => {
    const identities = createIdentityRepository({ connectionString: runtimeUrl });
    try {
      const input = sessionInput();
      const original = await identities.createSession(input);
      await seed(original.athleteId);
      let pending: ReturnType<typeof identities.createSession> | undefined;
      await database.exclusiveTenant(original.athleteId, async (tx) => {
        pending = identities.createSession({ ...input, tokenHash: hash() });
        await waitForBlockedLogin();
        await tx.query('SELECT public.erase_account($1)', [original.athleteId]);
      });
      const loggedIn = await pending;
      expect(loggedIn?.athleteId).not.toBe(original.athleteId);
      if (!loggedIn) throw new Error('Missing concurrent login');
      expect((await operations.exportAccount(loggedIn.athleteId)).data.activities).toEqual([]);
    } finally {
      await identities.close();
    }
  });
  it('deletion waits for an active tenant writer and removes its committed result before retiring the account', async () => {
    const athlete = randomUUID();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = database.tenant(athlete, async (tx) => {
      started();
      await resume;
      await tx.query("INSERT INTO consent VALUES($1,'ai',true,1)", [athlete]);
    });
    await ready;
    const erase = operations.eraseAccount(athlete);
    release();
    await Promise.all([write, erase]);
    expect(
      (await admin.query('SELECT * FROM consent WHERE athlete_id=$1', [athlete])).rows,
    ).toEqual([]);
    await expect(operations.exportAccount(athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
});

it('honors FORCE RLS tombstones when the authentication definer is not a superuser', async () => {
  const identities = createIdentityRepository({ connectionString: runtimeUrl });
  const role = `auth_owner_${randomUUID().replaceAll('-', '')}`;
  const signature = 'public.auth_create_session(text,text,text,text,timestamptz,timestamptz,text)';
  const result = await admin.query(
    'SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',
    [signature],
  );
  const owner = String(result.rows[0].owner).replaceAll('"', '""');
  try {
    const input = sessionInput();
    const identity = await identities.createSession(input);
    await admin.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [identity.athleteId]);
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public,identity_private TO ${role}`);
    await admin.query(
      `GRANT SELECT,INSERT,DELETE ON identity_private.account,identity_private.session TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON tenant_erasure TO ${role}`);
    await admin.query(`ALTER FUNCTION ${signature} OWNER TO ${role}`);
    await expect(identities.createSession({ ...input, tokenHash: hash() })).rejects.toThrow(
      'IDENTITY_RETRY_REQUIRED',
    );
    const fresh = sessionInput();
    expect((await identities.createSession(fresh)).athleteId).not.toBe(identity.athleteId);
  } finally {
    await admin.query(`ALTER FUNCTION ${signature} OWNER TO "${owner}"`);
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE ${role}`);
    await identities.close();
  }
});

it('reports lease and retry backlog facts without claiming first-attempt processing failed', async () => {
  const athlete = randomUUID();
  await seed(athlete);
  await database.tenant(athlete, (tx) =>
    tx.query(
      "UPDATE outbox SET attempts=1,lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE athlete_id=$1",
      [athlete, randomUUID()],
    ),
  );
  expect((await operations.status(athlete)).outbox).toEqual({
    pending: 0,
    leased: 1,
    retrying: 0,
    completed: 0,
  });
  await database.tenant(athlete, (tx) =>
    tx.query('UPDATE outbox SET lease_token=NULL,lease_until=NULL WHERE athlete_id=$1', [athlete]),
  );
  expect((await operations.status(athlete)).outbox).toEqual({
    pending: 1,
    leased: 0,
    retrying: 1,
    completed: 0,
  });
  await database.tenant(athlete, (tx) =>
    tx.query(
      "INSERT INTO operations_audit(athlete_id,id,action) SELECT $1,gen_random_uuid(),'export_requested' FROM generate_series(1,12)",
      [athlete],
    ),
  );
  expect((await operations.status(athlete)).audit).toHaveLength(10);
});
