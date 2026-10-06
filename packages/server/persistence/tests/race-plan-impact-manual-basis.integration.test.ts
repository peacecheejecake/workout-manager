import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantOperations, grantRaces } from '../src/migrate.js';
import {
  captureRaceManualBasis,
  requireFreshRaceManualBasis,
  type RaceManualBasis,
} from '../src/race-plan-impact-manual-basis.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Actual PostgreSQL/RLS/locking evidence with explicit synthetic consent heads.
// These tests do not store an owned immutable proposal or approve any plan/event.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `race_manual_basis_${suffix}`;
const ownerRole = `race_manual_owner_${suffix}`;
const runtimeRole = `race_manual_app_${suffix}`;
let owner: Pool;
let runtime: Pool;
let database: Database;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${databaseName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  await grantOperations(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 3 });
  runtime = new Pool({ connectionString: url(runtimeRole), max: 2 });
  database = createDatabase({ connectionString: url(runtimeRole), max: 3 });
  const flags = await admin.query(
    'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)',
    [[ownerRole, runtimeRole]],
  );
  expect(flags.rows).toHaveLength(2);
  for (const row of flags.rows)
    expect(row).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await runtime?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [ownerRole, runtimeRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
async function account() {
  const athlete = randomUUID();
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athlete, 'https://synthetic.invalid', randomUUID()],
  );
  return athlete;
}
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
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
async function consent(
  athlete: string,
  kind: 'app' | 'provider' | 'ai',
  granted: boolean,
  revision: number,
) {
  // Permission head is a synthetic SQL fixture, not a product consent grant flow.
  await owned(athlete, (client) =>
    client.query(
      'INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,$2,$3,$4) ON CONFLICT(athlete_id,kind) DO UPDATE SET granted=EXCLUDED.granted,revision=EXCLUDED.revision',
      [athlete, kind, granted, revision],
    ),
  );
}
const capture = (athlete: string) => database.tenant(athlete, captureRaceManualBasis);
const fresh = (athlete: string, basis: unknown) =>
  database.tenant(athlete, (tx) => requireFreshRaceManualBasis(tx, basis));

it('captures absent app for retained reads, but processing fails closed', async () => {
  const athlete = await account();
  const basis = await capture(athlete);
  expect(basis.app).toEqual({ state: 'absent' });
  expect(basis.policy).toMatchObject({ id: 'manual-race-date-impact', version: 1 });
  await expect(fresh(athlete, basis)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  expect((await capture(athlete)).app).toEqual({ state: 'absent' });
});
it('provider/AI permission cannot replace absent or withdrawn app permission', async () => {
  const athlete = await account();
  await consent(athlete, 'provider', true, 1);
  await consent(athlete, 'ai', true, 1);
  const absent = await capture(athlete);
  await expect(fresh(athlete, absent)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await consent(athlete, 'app', false, 1);
  const withdrawn = await capture(athlete);
  expect(withdrawn.app).toEqual({ state: 'present', granted: false, revision: 1 });
  await expect(fresh(athlete, withdrawn)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
});
it('true1→false2→true3 keeps original basis stale and accepts only a newly captured basis', async () => {
  const athlete = await account();
  await consent(athlete, 'app', true, 1);
  const original = await capture(athlete);
  await expect(fresh(athlete, original)).resolves.toBeUndefined();
  await consent(athlete, 'app', false, 2);
  const withdrawn = await capture(athlete);
  await expect(fresh(athlete, original)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await consent(athlete, 'app', true, 3);
  await expect(fresh(athlete, original)).rejects.toThrow('STALE_RACE_MANUAL_BASIS');
  await expect(fresh(athlete, withdrawn)).rejects.toThrow('STALE_RACE_MANUAL_BASIS');
  const renewed = await capture(athlete);
  expect(renewed.app).toEqual({ state: 'present', granted: true, revision: 3 });
  expect(renewed.policy).toEqual(original.policy);
  await expect(fresh(athlete, renewed)).resolves.toBeUndefined();
  expect(original.app).toEqual({ state: 'present', granted: true, revision: 1 });
});
it('rejects changed policy digest and unknown fields at every basis level', async () => {
  const athlete = await account();
  await consent(athlete, 'app', true, 1);
  const basis = await capture(athlete);
  await expect(
    fresh(athlete, { ...basis, policy: { ...basis.policy, digest: '0'.repeat(64) } }),
  ).rejects.toThrow('STALE_RACE_MANUAL_POLICY');
  for (const value of [
    { ...basis, verified: true },
    { ...basis, app: { ...basis.app, inferred: true } },
    { ...basis, policy: { ...basis.policy, approved: true } },
    { ...basis, app: { state: 'present', granted: true, revision: 0 } },
    { ...basis, app: { state: 'present', granted: true, revision: 2147483648 } },
  ])
    await expect(fresh(athlete, value)).rejects.toThrow('INVALID_RACE_MANUAL_BASIS');
});
it('tenant RLS hides foreign consent and cannot borrow another tenant live app grant', async () => {
  const granted = await account(),
    absent = await account(),
    withdrawn = await account();
  await consent(granted, 'app', true, 1);
  await consent(withdrawn, 'app', false, 1);
  const basis = await capture(granted);
  await expect(fresh(absent, basis)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await expect(fresh(withdrawn, basis)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await database.tenant(absent, async (tx) => {
    expect(
      (await tx.query('SELECT granted,revision FROM consent WHERE athlete_id=$1', [granted])).rows,
    ).toEqual([]);
    // Deliberately inconsistent adapter identity still cannot bypass the SQL tenant policy.
    const forged: Transaction = { athleteId: granted, query: tx.query };
    expect((await captureRaceManualBasis(forged)).app).toEqual({ state: 'absent' });
    await expect(requireFreshRaceManualBasis(forged, basis)).rejects.toMatchObject({
      code: 'APP_CONSENT_REQUIRED',
    });
  });
  await expect(
    database.tenant(absent, (tx) =>
      tx.query("INSERT INTO consent VALUES($1,'app',true,1)", [granted]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForAdvisoryBlock(pid: number) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const result = await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS blocked",
      [pid],
    );
    if (result.rows[0]?.['blocked'] === true) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('EXPECTED_ACTUAL_ADVISORY_WAIT');
}
it.each([false, true])(
  'actual command lock serializes consent writer with captured %s app head',
  async (hasApp) => {
    const athlete = await account();
    if (hasApp) await consent(athlete, 'app', true, 1);
    const entered = deferred<RaceManualBasis>(),
      release = deferred<undefined>();
    const reading = database.tenant(athlete, async (tx) => {
      const basis = await captureRaceManualBasis(tx);
      if (hasApp) await requireFreshRaceManualBasis(tx, basis);
      entered.resolve(basis);
      await release.promise;
      return basis;
    });
    const basis = await entered.promise;
    const writer = await owner.connect();
    let writing: Promise<void> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await writer.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
        athlete,
      ]);
      const pid = z
        .number()
        .int()
        .parse((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);
      let completed = false;
      writing = (async () => {
        await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
        if (hasApp)
          await writer.query(
            "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
            [athlete],
          );
        else await writer.query("INSERT INTO consent VALUES($1,'app',true,1)", [athlete]);
        await writer.query('COMMIT');
        completed = true;
      })();
      await waitForAdvisoryBlock(pid);
      expect(completed).toBe(false);
      expect(basis.app).toEqual(
        hasApp ? { state: 'present', granted: true, revision: 1 } : { state: 'absent' },
      );
      release.resolve(undefined);
      await reading;
      await writing;
      const after = await capture(athlete);
      expect(after.app).toEqual(
        hasApp
          ? { state: 'present', granted: false, revision: 2 }
          : { state: 'present', granted: true, revision: 1 },
      );
      if (hasApp)
        await expect(fresh(athlete, basis)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
      else {
        await expect(fresh(athlete, basis)).rejects.toThrow('STALE_RACE_MANUAL_BASIS');
        await expect(fresh(athlete, after)).resolves.toBeUndefined();
      }
    } finally {
      release.resolve(undefined);
      await reading;
      await writing?.catch(() => undefined);
      await writer.query('ROLLBACK');
      writer.release();
    }
  },
);
