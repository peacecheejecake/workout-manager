import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantCorePlanning, grantOperations } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { requireAppAdmission } from '../src/app-admission.js';
import { createOperationsRepository } from '../src/operations.js';
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

// Real producer functions behind a transaction barrier, not fake SQL results.
function fencedProducer(kind: 'command' | 'lifecycle') {
  const ready = barrier(),
    release = barrier();
  const controlled: Database = {
    ...db,
    tenant: (athlete, operation) =>
      db.tenant(athlete, async (tx) => {
        if (kind === 'command') {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
          ready.release();
          await release.ready;
        }
        return operation(tx);
      }),
    exclusiveTenant: (athlete, operation) =>
      db.exclusiveTenant(athlete, async (tx) => {
        if (kind === 'lifecycle') {
          ready.release();
          await release.ready;
        }
        return operation(tx);
      }),
  };
  return { database: controlled, ready: ready.ready, release: release.release };
}
const sessionFenceSql = {
  global: 'SELECT pg_advisory_lock_shared(77210,1)',
  lifecycle: 'SELECT pg_advisory_lock_shared(hashtextextended($1,77206))',
  tenant: 'SELECT pg_advisory_lock(hashtextextended($1,0))',
} as const;
async function waitingSnapshot(fence: keyof typeof sessionFenceSql) {
  const rows = async () =>
    (
      await admin.query(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
     WHERE a.datname=$1 AND a.usename=$2 AND a.query=$3
     AND l.locktype='advisory' AND NOT l.granted`,
        [name, runtimeRole, sessionFenceSql[fence]],
      )
    ).rows;
  await expect.poll(async () => (await rows()).length, { timeout: 2000 }).toBe(1);
  return z
    .number()
    .int()
    .positive()
    .parse((await rows())[0]?.['pid']);
}
async function backendGone(pid: number) {
  await expect
    .poll(
      async () =>
        z
          .number()
          .int()
          .parse(
            (
              await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1', [
                pid,
              ])
            ).rows[0]?.['n'],
          ),
      { timeout: 2000 },
    )
    .toBe(0);
  expect(
    (await admin.query('SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1', [pid])).rows,
  ).toEqual([{ n: 0 }]);
}
const backendPid = async (tx: Transaction) =>
  z
    .number()
    .int()
    .positive()
    .parse((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);

it('lifecycle wait completes actual public erasure before the RR snapshot and never invokes the stale callback', async () => {
  const athlete = randomUUID();
  await grant(athlete);
  await db.tenant(athlete, insert);
  const producer = fencedProducer('lifecycle');
  const erased = createOperationsRepository(producer.database).eraseAccount(athlete);
  await producer.ready;
  let called = false;
  const reading = snapshot(athlete, async () => {
    called = true;
    return 'STALE_BODY';
  });
  const rejected = expect(reading).rejects.toThrow('ACCOUNT_ERASED');
  let pid = 0;
  try {
    pid = await waitingSnapshot('lifecycle');
  } finally {
    producer.release();
    await Promise.allSettled([erased, reading]);
  }
  expect(await erased).toEqual({ erased: true });
  await rejected;
  expect(called).toBe(false);
  await backendGone(pid);
});
it('tenant0 wait observes the committed public app withdrawal before purpose-specific admission', async () => {
  const athlete = randomUUID();
  await grant(athlete);
  const producer = fencedProducer('command');
  const writing = createConsentRepository(producer.database).setConsent(athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await producer.ready;
  let processed = false;
  const reading = snapshot(athlete, async (tx) => {
    await requireAppAdmission(tx);
    processed = true;
  });
  const rejected = expect(reading).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  let pid = 0;
  try {
    pid = await waitingSnapshot('tenant');
  } finally {
    producer.release();
    await Promise.allSettled([writing, reading]);
  }
  expect(await writing).toMatchObject({ granted: false, revision: 2 });
  await rejected;
  expect(processed).toBe(false);
  await backendGone(pid);
});
it('tenant0 wait observes an actual first app grant rather than an absent pre-lock snapshot', async () => {
  const athlete = randomUUID(),
    producer = fencedProducer('command');
  const writing = createConsentRepository(producer.database).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await producer.ready;
  const reading = snapshot(athlete, requireAppAdmission);
  let pid = 0;
  try {
    pid = await waitingSnapshot('tenant');
  } finally {
    producer.release();
    await Promise.allSettled([writing, reading]);
  }
  expect(await writing).toMatchObject({ granted: true, revision: 1 });
  expect(await reading).toEqual({ kind: 'app', granted: true, revision: 1 });
  await backendGone(pid);
});
it('global wait captures the actual committed restore-control revision without claiming open admission', async () => {
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 }),
    client = await owner.connect();
  let reading: Promise<unknown> | undefined,
    pid = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(77210,1)');
    const before = z
      .object({ local_revision: z.string() })
      .parse(
        (
          await client.query(
            'SELECT local_revision::text FROM restore_processing_admission WHERE singleton',
          )
        ).rows[0],
      );
    reading = snapshot(
      randomUUID(),
      async (tx) =>
        (await tx.query('SELECT public.read_restore_processing_admission() AS state')).rows[0]?.[
          'state'
        ],
    );
    pid = await waitingSnapshot('global');
    // Real plain-owner coordinator, not a synthetic runtime admission flag.
    const closed = (
      await client.query(
        'SELECT public.close_restore_processing_exact($1::bigint,$2::uuid) AS state',
        [before.local_revision, randomUUID()],
      )
    ).rows[0]?.['state'];
    await client.query('COMMIT');
    expect(await reading).toEqual(closed);
    expect(await reading).toMatchObject({
      state: 'CLOSED',
      admissionAllowed: false,
      targetAttested: false,
      localRevision: (BigInt(before.local_revision) + 1n).toString(),
    });
    await backendGone(pid);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await owner.end();
    if (reading) await Promise.allSettled([reading]);
  }
});
it.each(['global', 'lifecycle', 'tenant'] as const)(
  'snapshot %s acquisition timeout releases only its own earlier session fences and destroys its backend',
  async (fence) => {
    const athlete = randomUUID(),
      holder = new Pool({ connectionString: url(runtimeRole), max: 1 }),
      client = await holder.connect();
    let reading: Promise<unknown> | undefined,
      pid = 0;
    try {
      await client.query('BEGIN');
      if (fence === 'global') await client.query('SELECT pg_advisory_xact_lock(77210,1)');
      else {
        await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
        await client.query(
          fence === 'lifecycle'
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,77206))'
            : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))',
          [athlete],
        );
        if (fence === 'tenant')
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      }
      const holderPid = z
        .number()
        .int()
        .positive()
        .parse((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);
      let called = false;
      reading = snapshot(athlete, async () => {
        called = true;
      });
      const rejected = expect(reading).rejects.toMatchObject({ code: '55P03' });
      pid = await waitingSnapshot(fence);
      await rejected;
      expect(called).toBe(false);
      await backendGone(pid);
      // Reader cleanup must not unlock another backend's fixture fence.
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted",
            [holderPid],
          )
        ).rows[0]?.['n'],
      ).toBeGreaterThan(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await holder.end();
      if (reading) await Promise.allSettled([reading]);
    }
    await snapshot(athlete, async (tx) => expect(await counts(tx)).toBe(0));
  },
);
it.each(['callback', 'swallowed_sql', 'success'] as const)(
  'snapshot %s completion closes its backend and leaves no session locks or reusable tenant settings',
  async (outcome) => {
    const athlete = randomUUID();
    let pid = 0;
    const reading = snapshot(athlete, async (tx) => {
      pid = await backendPid(tx);
      await insert(tx);
      if (outcome === 'callback') throw Error('SYNTHETIC_CALLBACK_FAILURE');
      if (outcome === 'swallowed_sql') {
        try {
          await tx.query('SELECT 1/0');
        } catch {
          return 'ABORTED';
        }
      }
      return 'COMMITTED';
    });
    if (outcome === 'callback') await expect(reading).rejects.toThrow('SYNTHETIC_CALLBACK_FAILURE');
    else if (outcome === 'swallowed_sql')
      await expect(reading).rejects.toThrow('TRANSACTION_NOT_COMMITTED');
    else expect(await reading).toBe('COMMITTED');
    await backendGone(pid);
    await db.tenant(athlete, async (tx) => {
      expect(await counts(tx)).toBe(outcome === 'success' ? 1 : 0);
      expect((await tx.query('SHOW transaction_isolation')).rows).toEqual([
        { transaction_isolation: 'read committed' },
      ]);
      expect((await tx.query("SELECT current_setting('app.athlete_id') AS athlete")).rows).toEqual([
        { athlete },
      ]);
    });
  },
);
it('a lost own snapshot connection fails closed and its backend/session fences disappear without pooling it', async () => {
  const athlete = randomUUID(),
    ready = barrier();
  let pid = 0;
  const reading = snapshot(athlete, async (tx) => {
    pid = await backendPid(tx);
    ready.release();
    await tx.query('SELECT pg_sleep(10)');
    return 'UNEXPECTED_SUCCESS';
  });
  const rejected = expect(reading).rejects.toMatchObject({ code: '57P01' });
  await ready.ready;
  await expect
    .poll(
      async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND query='SELECT pg_sleep(10)' AND state='active'",
            [pid],
          )
        ).rows[0]?.['n'],
      { timeout: 2000 },
    )
    .toBe(1);
  // Observer terminates only the exact own runtime fixture backend, never a
  // service/provider backend or a guessed PID from outside this isolated DB.
  expect(
    (
      await admin.query(
        `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
    WHERE pid=$1 AND datname=$2 AND usename=$3`,
        [pid, name, runtimeRole],
      )
    ).rows,
  ).toEqual([{ ended: true }]);
  await rejected;
  await backendGone(pid);
  await snapshot(athlete, async (tx) => expect(await counts(tx)).toBe(0));
});
