import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantCorePlanning, grantOperations } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `snapshot_tenant_${suffix}`,
  ownerRole = `snapshot_owner_${suffix}`,
  runtimeRole = `snapshot_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl }),
  createdRoles: string[] = [];
let created = false,
  db: Database;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole));
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
function snapshot<T>(athlete: string, operation: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_CAPABILITY_REQUIRED');
  return db.snapshotTenant(athlete, operation);
}
function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
async function grant(athlete: string) {
  return createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
}
// Bounded metadata fixture using actual public runtime grants, NOT a product
// audit producer or health/approval artifact. It models a non-cooperating worker.
const insert = (tx: Transaction) =>
  tx.query("INSERT INTO operations_audit(athlete_id,id,action) VALUES($1,$2,'export_requested')", [
    tx.athleteId,
    randomUUID(),
  ]);
const counts = async (tx: Transaction) =>
  z
    .number()
    .int()
    .parse(
      (
        await tx.query('SELECT count(*)::int AS n FROM operations_audit WHERE athlete_id=$1', [
          tx.athleteId,
        ])
      ).rows[0]?.['n'],
    );
it('snapshot starts repeatable read read-write and supports actual FOR SHARE/UPDATE locking readers', async () => {
  const athlete = randomUUID();
  await grant(athlete);
  await snapshot(athlete, async (tx) => {
    expect((await tx.query('SHOW transaction_isolation')).rows).toEqual([
      { transaction_isolation: 'repeatable read' },
    ]);
    expect((await tx.query('SHOW transaction_read_only')).rows).toEqual([
      { transaction_read_only: 'off' },
    ]);
    expect((await tx.query('SHOW statement_timeout')).rows).toEqual([{ statement_timeout: '5s' }]);
    expect((await tx.query('SHOW lock_timeout')).rows).toEqual([{ lock_timeout: '3s' }]);
    expect(
      (await tx.query('SELECT kind FROM consent WHERE athlete_id=$1 FOR SHARE', [athlete])).rows,
    ).toEqual([{ kind: 'app' }]);
    expect(
      (await tx.query('SELECT kind FROM consent WHERE athlete_id=$1 FOR UPDATE', [athlete])).rows,
    ).toEqual([{ kind: 'app' }]);
  });
});
it('cooperating tenant command writer waits at the exact lock until snapshot callback completes', async () => {
  const athlete = randomUUID();
  await grant(athlete);
  const locked = barrier(),
    release = barrier(),
    entered = barrier();
  let writerPid = 0;
  const reader = snapshot(athlete, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    locked.release();
    await release.ready;
    expect(await counts(tx)).toBe(0);
  });
  await locked.ready;
  const writer = db.tenant(athlete, async (tx) => {
    writerPid = z
      .number()
      .int()
      .parse((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);
    entered.release();
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await insert(tx);
  });
  try {
    await entered.ready;
    await expect
      .poll(
        async () =>
          z
            .number()
            .int()
            .parse(
              (
                await admin.query(
                  "SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                  [writerPid],
                )
              ).rows[0]?.['n'],
            ),
        { timeout: 2000 },
      )
      .toBe(1);
  } finally {
    release.release();
    await Promise.all([reader, writer]);
  }
  expect(await db.tenant(athlete, counts)).toBe(1);
});
it('non-cooperating worker commit cannot introduce a phantom after scalar preflight or split two snapshot reads', async () => {
  const athlete = randomUUID(),
    firstRead = barrier(),
    workerDone = barrier();
  await db.tenant(athlete, insert);
  const reader = snapshot(athlete, async (tx) => {
    const before = await counts(tx);
    expect(before).toBe(1);
    const preflight = z
      .string()
      .regex(/^\d+$/)
      .parse(
        (
          await tx.query(
            'SELECT coalesce(sum(octet_length(action)+128),0)::text AS bytes FROM operations_audit WHERE athlete_id=$1',
            [athlete],
          )
        ).rows[0]?.['bytes'],
      );
    firstRead.release();
    await workerDone.ready;
    expect(await counts(tx)).toBe(before);
    expect(
      (await tx.query('SELECT action FROM operations_audit WHERE athlete_id=$1', [athlete])).rows,
    ).toEqual([{ action: 'export_requested' }]);
    expect(
      (
        await tx.query(
          'SELECT coalesce(sum(octet_length(action)+128),0)::text AS bytes FROM operations_audit WHERE athlete_id=$1',
          [athlete],
        )
      ).rows[0]?.['bytes'],
    ).toBe(preflight);
  });
  await firstRead.ready;
  try {
    await db.tenant(athlete, insert);
  } finally {
    workerDone.release();
  }
  await reader;
  expect(await db.tenant(athlete, counts)).toBe(2);
});
it('ordinary tenant and exclusiveTenant retain read committed and see concurrent new metadata', async () => {
  const athlete = randomUUID();
  await db.tenant(athlete, async (tx) => {
    expect((await tx.query('SHOW transaction_isolation')).rows).toEqual([
      { transaction_isolation: 'read committed' },
    ]);
    expect(await counts(tx)).toBe(0);
    await db.tenant(athlete, insert);
    expect(await counts(tx)).toBe(1);
  });
  await db.exclusiveTenant(athlete, async (tx) =>
    expect((await tx.query('SHOW transaction_isolation')).rows).toEqual([
      { transaction_isolation: 'read committed' },
    ]),
  );
});
it('callback error rolls back writes and leaked committed/aborted transaction ports are closed', async () => {
  const athlete = randomUUID();
  let aborted: Transaction | undefined, committed: Transaction | undefined;
  await expect(
    snapshot(athlete, async (tx) => {
      aborted = tx;
      await insert(tx);
      throw Error('SYNTHETIC_CALLBACK_FAILURE');
    }),
  ).rejects.toThrow('SYNTHETIC_CALLBACK_FAILURE');
  expect(await db.tenant(athlete, counts)).toBe(0);
  await expect(
    snapshot(athlete, async (tx) => {
      try {
        await tx.query('SELECT 1/0');
      } catch {
        return 'CALLER_SWALLOWED_SQL_ERROR';
      }
      return 'UNEXPECTED_SQL_SUCCESS';
    }),
  ).rejects.toThrow('TRANSACTION_NOT_COMMITTED');
  await snapshot(athlete, async (tx) => {
    committed = tx;
    await insert(tx);
  });
  expect(await db.tenant(athlete, counts)).toBe(1);
  for (const tx of [aborted, committed]) {
    if (!tx) throw Error('FIXTURE_PORT_MISSING');
    await expect(tx.query('SELECT 1')).rejects.toThrow('TRANSACTION_CLOSED');
  }
});
it('snapshot enforces tenant RLS and rejects unsafe plain table owner/superadmin before callbacks', async () => {
  const alice = randomUUID(),
    bob = randomUUID();
  await db.tenant(alice, insert);
  await db.tenant(bob, insert);
  await snapshot(alice, async (tx) => {
    expect((await tx.query('SELECT count(*)::int AS n FROM operations_audit')).rows).toEqual([
      { n: 1 },
    ]);
    expect(
      (await tx.query('SELECT action FROM operations_audit WHERE athlete_id=$1', [bob])).rows,
    ).toEqual([]);
  });
  for (const role of [ownerRole, new URL(adminUrl).username]) {
    const adminEndpoint = new URL(adminUrl);
    adminEndpoint.pathname = `/${name}`;
    const unsafe = createDatabase({
      connectionString: role === ownerRole ? url(ownerRole) : adminEndpoint.toString(),
    });
    let called = false;
    try {
      if (!unsafe.snapshotTenant) throw Error('SNAPSHOT_CAPABILITY_REQUIRED');
      await expect(
        unsafe.snapshotTenant(alice, async () => {
          called = true;
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(called).toBe(false);
    } finally {
      await unsafe.close();
    }
  }
});
