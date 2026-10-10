import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  migrationFileNames,
  grantCorePlanning,
  grantOperations,
  grantOpenAiBudgetWorker,
} from '../src/migrate.js';
import {
  createGlobalOpenAiBudgetPort,
  decodeGlobalOpenAiBudgetReservation,
  decodeGlobalOpenAiBudgetSettlement,
} from '../src/global-openai-budget.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real accounting/ACL/lock evidence with owner-created synthetic old liabilities.
// No activation=true, actual dispatch, HTTP, vendor usage or complete proof occurs.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10),
  dbName = `global_budget_${suffix}`;
const roles = {
  owner: `budget_owner_${suffix}`,
  runtime: `budget_worker_${suffix}`,
  outside: `budget_public_${suffix}`,
  next: `budget_next_${suffix}`,
};
const pools: Pool[] = [];
let owner: Pool, runtime: Database;
const tenant = randomUUID(),
  foreign = randomUUID();
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
// Test-only finite observation. No SQL, role identity, error message or payload is emitted.
const ownerTransferSqlStates = new Set([
  '42501',
  '53200',
  '40P01',
  '55P03',
  '57014',
  '3D000',
  '42704',
  '42P01',
  '23505',
  'P0001',
  '08006',
  '57P01',
  'XX000',
]);
const ownerTransferErrorNames = new Set([
  'Error',
  'DatabaseError',
  'PostgresError',
  'TimeoutError',
  'TypeError',
  'RangeError',
  'error',
]);
function ownErrorValue(error: unknown, key: 'code' | 'name' | 'message' | 'detail'): unknown {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
// Test-only closed projection: strings are inspected in memory and never emitted.
function classifyOwnerTransfer(error: unknown): string | null {
  if (ownErrorValue(error, 'code') !== '42501') return null;
  const message = ownErrorValue(error, 'message');
  const detail = ownErrorValue(error, 'detail');
  if (typeof message !== 'string' || message.length > 4096) return 'unknown_42501';
  if (message === 'permission denied to reassign objects') {
    if (typeof detail === 'string' && detail.length <= 4096) {
      if (
        /^Only roles with privileges of role ".*" may reassign objects owned by it\.$/.test(detail)
      )
        return 'old_role_privileges';
      if (/^Only roles with privileges of role ".*" may reassign objects to it\.$/.test(detail))
        return 'next_role_privileges';
    }
    return 'reassign_role_privileges';
  }
  if (message.startsWith('must be able to SET ROLE ')) return 'cannot_set_next_role';
  if (message.startsWith('must be owner of schema ')) return 'namespace_not_owner';
  if (message.startsWith('permission denied for database ')) return 'database_privilege_denied';
  if (message.startsWith('permission denied for schema ')) return 'schema_privilege_denied';
  return 'unknown_42501';
}
async function observeOwnerTransfer(
  stage: 'reassign_owned' | 'revoke_membership',
  operation: () => Promise<unknown>,
): Promise<void> {
  const started = performance.now();
  const emit = (outcome: 'success' | 'error', error?: unknown) => {
    const code = ownErrorValue(error, 'code');
    const name = ownErrorValue(error, 'name');
    const elapsed = performance.now() - started;
    // Logging must never replace the SQL result or the original thrown object.
    try {
      console.info(
        JSON.stringify({
          diagnostic: 'global_budget_owner_transfer',
          stage,
          phase: 'terminal',
          outcome,
          elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? Math.floor(elapsed) : null,
          errorClass: outcome === 'error' ? classifyOwnerTransfer(error) : null,
          sqlState: typeof code === 'string' && ownerTransferSqlStates.has(code) ? code : null,
          errorName:
            outcome === 'success'
              ? null
              : typeof name === 'string' && ownerTransferErrorNames.has(name)
                ? name
                : 'unknown',
        }),
      );
    } catch {
      // A console failure is observation failure, not a different database outcome.
    }
  };
  try {
    await operation();
    emit('success');
  } catch (error) {
    emit('error', error);
    throw error;
  }
}
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  u.username = role;
  u.password = 'isolated';
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD');
  return u.toString();
}
async function scoped<T>(id: string, action: (client: PoolClient) => Promise<T>) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    await c.query(
      'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206)),pg_advisory_xact_lock(hashtextextended($1,0))',
      [id],
    );
    const r = await action(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
const port = createGlobalOpenAiBudgetPort({
  completeFreshness: {
    async requireFreshIn() {
      /* Synthetic acceptance seam only; not production complete-manifest evidence. */
    },
  },
});
const tables = [
  'openai_budget_fx_definition',
  'openai_budget_price_definition',
  'openai_budget_activation',
  'openai_budget_month',
  'openai_budget_reservation',
  'openai_budget_journal',
];
interface Liability {
  id: string;
  runId: string;
  key: string;
  digest: string;
  ownerToken: string;
  price: string;
  amount: number;
}
function request(r: Liability) {
  return {
    definitionVersion: 'provider-budget-reservation-v2',
    runId: r.runId,
    key: r.key,
    requestDigest: r.digest,
    priceVersion: r.price,
    inputBound: 1,
    outputBound: 1,
    ownerToken: r.ownerToken,
  };
}
async function liability(
  state: 'reserved' | 'dispatching' | 'completed' = 'dispatching',
  id = tenant,
): Promise<Liability> {
  const r = {
    id: randomUUID(),
    runId: randomUUID(),
    key: hash(randomUUID()),
    digest: hash(randomUUID()),
    ownerToken: randomUUID(),
    price: 'synthetic-price-v1',
    amount: 20,
  };
  await scoped(id, async (c) => {
    await c.query(
      "INSERT INTO openai_budget_month(period_key) VALUES(date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date) ON CONFLICT DO NOTHING",
    );
    await c.query(
      "UPDATE openai_budget_month SET held_krw=held_krw+$1,revision=revision+1 WHERE period_key=date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date",
      [state === 'completed' ? 0 : r.amount],
    );
    if (state === 'completed')
      await c.query(
        "UPDATE openai_budget_month SET debited_krw=debited_krw+$1 WHERE period_key=date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date",
        [r.amount],
      );
    await c.query(
      `INSERT INTO openai_budget_reservation(reservation_id,request_key,request_digest,athlete_id,run_id,subject_digest,period_key,price_version,input_bound,output_bound,reserved_krw,owner_token_digest,state,debit_krw,output_digest,dispatch_committed_at,settled_at)
   VALUES($1,$2,$3,$4,$5,$6,date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,$7,1,1,$8,$9,$10,$11,$12,$13,$14)`,
      [
        r.id,
        r.key,
        r.digest,
        id,
        r.runId,
        hash(id),
        r.price,
        r.amount,
        hash(r.ownerToken),
        state,
        state === 'completed' ? r.amount : null,
        state === 'completed' ? hash('synthetic-output') : null,
        state === 'reserved' ? null : '2026-10-01T00:00:00Z',
        state === 'completed' ? '2026-10-01T00:01:00Z' : null,
      ],
    );
    await c.query(
      "INSERT INTO openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) SELECT reservation_id,period_key,'reserved',reserved_krw,0 FROM openai_budget_reservation WHERE reservation_id=$1",
      [r.id],
    );
    if (state !== 'reserved')
      await c.query(
        "INSERT INTO openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) SELECT reservation_id,period_key,'dispatching',0,0 FROM openai_budget_reservation WHERE reservation_id=$1",
        [r.id],
      );
    if (state === 'completed')
      await c.query(
        "INSERT INTO openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) SELECT reservation_id,period_key,'completed',-reserved_krw,reserved_krw FROM openai_budget_reservation WHERE reservation_id=$1",
        [r.id],
      );
  });
  return r;
}
beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${roles.owner}"`);
  await migrate(url(roles.owner), 102);
  await migrate(url(roles.owner), 103);
  owner = new Pool({ connectionString: url(roles.owner), max: 6 });
  pools.push(owner);
  await grantCorePlanning(url(roles.owner), roles.runtime);
  await grantOperations(url(roles.owner), roles.runtime);
  await grantOpenAiBudgetWorker(url(roles.owner), roles.runtime);
  runtime = createDatabase({ connectionString: url(roles.runtime), max: 6 });
  await owner.query(
    "INSERT INTO openai_budget_fx_definition VALUES('synthetic-fx-v1',1,1,$1,true)",
    [hash('synthetic-fx-not-approved-operational-evidence')],
  );
  await owner.query(
    "INSERT INTO openai_budget_price_definition VALUES('synthetic-price-v1','gpt-6.1-sol','synthetic-fx-v1','synthetic-tokenizer-v1',1,1,$1,1,1,'2020-01-01','2090-01-01',false)",
    [hash('synthetic-price-no-real-provider')],
  );
  for (const id of [tenant, foreign])
    await owner.query(
      'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
      [id, 'https://synthetic.invalid', randomUUID()],
    );
}, 30000);
afterAll(async () => {
  await runtime?.close();
  for (const p of pools) await p.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('fresh normal001→103 installs empty accounting and disabled activation', async () => {
  const name = `budget_fresh_${suffix}`;
  await admin.query(`CREATE DATABASE "${name}" OWNER "${roles.owner}"`);
  const u = new URL(url(roles.owner));
  u.pathname = `/${name}`;
  let p: Pool | null = null;
  try {
    await migrate(u.toString(), 103);
    p = new Pool({ connectionString: u.toString() });
    expect((await p.query('SELECT enabled FROM openai_budget_activation')).rows).toEqual([
      { enabled: false },
    ]);
    for (const table of [
      'openai_budget_month',
      'openai_budget_reservation',
      'openai_budget_journal',
    ])
      expect((await p.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    expect((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows).toEqual([
      { n: 103 },
    ]);
  } finally {
    await p?.end();
    await dropIsolatedDatabase(admin, name);
  }
});
it('normal102→103 checksums/default CLOSED and plain roles', async () => {
  const installed = (
    await owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
  ).rows;
  expect(installed).toHaveLength(103);
  for (const [i, file] of migrationFileNames.slice(0, 103).entries())
    expect(installed[i]).toEqual({
      version: i + 1,
      checksum: createHash('sha256')
        .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
        .digest('hex'),
    });
  expect((await owner.query('SELECT enabled FROM openai_budget_activation')).rows).toEqual([
    { enabled: false },
  ]);
  expect(
    (
      await admin.query(
        'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)',
        [Object.values(roles)],
      )
    ).rows,
  ).toEqual(
    Array.from({ length: 4 }, () => ({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    })),
  );
});
it('runtime/PUBLIC cannot read or mutate global tables or grant themselves activation', async () => {
  for (const role of [roles.runtime, roles.outside]) {
    const p = new Pool({ connectionString: url(role) });
    try {
      for (const table of tables)
        await expect(p.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(
        p.query('UPDATE openai_budget_activation SET enabled=true'),
      ).rejects.toMatchObject({ code: '42501' });
      if (role === roles.outside)
        await expect(
          p.query('SELECT public.reserve_openai_budget($1,$2,$3,$4,1,1,$5)', [
            randomUUID(),
            hash('public'),
            hash('digest'),
            'synthetic-price-v1',
            randomUUID(),
          ]),
        ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await p.end();
    }
  }
});
it('new reservation CLOSED rejection creates no hold/receipt/journal even with synthetic freshness callback', async () => {
  const before = (
    await owner.query(
      'SELECT (SELECT count(*) FROM openai_budget_reservation)::int AS reservations,(SELECT count(*) FROM openai_budget_journal)::int AS journal,(SELECT count(*) FROM openai_budget_month)::int AS months',
    )
  ).rows;
  const r = {
    id: randomUUID(),
    runId: randomUUID(),
    key: hash(randomUUID()),
    digest: hash(randomUUID()),
    ownerToken: randomUUID(),
    price: 'synthetic-price-v1',
    amount: 20,
  };
  await expect(runtime.tenant(tenant, (t) => port.reserveIn(t, request(r)))).rejects.toMatchObject({
    code: 'RESTORE_PROCESSING_CLOSED',
  });
  expect(
    (
      await owner.query(
        'SELECT (SELECT count(*) FROM openai_budget_reservation)::int AS reservations,(SELECT count(*) FROM openai_budget_journal)::int AS journal,(SELECT count(*) FROM openai_budget_month)::int AS months',
      )
    ).rows,
  ).toEqual(before);
});
it('existing reserved liability is busy but cannot begin new dispatch while CLOSED', async () => {
  const r = await liability('reserved');
  expect(await runtime.tenant(tenant, (t) => port.reserveIn(t, request(r)))).toEqual({
    kind: 'busy',
  });
  await expect(
    runtime.tenant(tenant, (t) =>
      port.beginDispatchIn(t, {
        reservationId: r.id,
        ownerToken: r.ownerToken,
        eventId: randomUUID(),
        leaseToken: randomUUID(),
        attempt: 1,
        runId: r.runId,
      }),
    ),
  ).rejects.toMatchObject({ code: 'RESTORE_PROCESSING_CLOSED' });
  expect(
    (
      await owner.query(
        'SELECT state,dispatch_committed_at FROM openai_budget_reservation WHERE reservation_id=$1',
        [r.id],
      )
    ).rows,
  ).toEqual([{ state: 'reserved', dispatch_committed_at: null }]);
});
it('terminal exact receipt replays after CLOSED/app absence/disabled unapproved pricing', async () => {
  const r = await liability('completed');
  expect(await runtime.tenant(tenant, (t) => port.reserveIn(t, request(r)))).toEqual({
    kind: 'replayed',
    reservationId: r.id,
    outcome: 'completed',
    debitMinor: 20,
    outputDigest: hash('synthetic-output'),
  });
  expect(
    await runtime.tenant(tenant, (t) =>
      port.settleIn(t, {
        reservationId: r.id,
        ownerToken: r.ownerToken,
        requestDigest: r.digest,
        outcome: 'completed',
        outputDigest: hash('synthetic-output'),
      }),
    ),
  ).toEqual({ outcome: 'completed', debitMinor: 20, outputDigest: hash('synthetic-output') });
});
it('terminal digest/bound mismatch denies and settlement conflict cannot double charge', async () => {
  const r = await liability('completed');
  for (const changed of [
    { requestDigest: hash('changed') },
    { inputBound: 2 },
    { runId: randomUUID() },
  ])
    expect(
      await runtime.tenant(tenant, (t) => port.reserveIn(t, { ...request(r), ...changed })),
    ).toEqual({ kind: 'denied' });
  await expect(
    runtime.tenant(tenant, (t) =>
      port.settleIn(t, {
        reservationId: r.id,
        ownerToken: r.ownerToken,
        requestDigest: r.digest,
        outcome: 'charged_unknown',
        outputDigest: null,
      }),
    ),
  ).rejects.toMatchObject({ code: 'OPENAI_BUDGET_SETTLEMENT_CONFLICT' });
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM openai_budget_journal WHERE reservation_id=$1',
        [r.id],
      )
    ).rows,
  ).toEqual([{ n: 3 }]);
});
it('retained dispatching liability settles unknown once with full debit and no refund', async () => {
  const r = await liability();
  const command = {
    reservationId: r.id,
    ownerToken: r.ownerToken,
    requestDigest: r.digest,
    outcome: 'charged_unknown',
    outputDigest: null,
  };
  expect(await runtime.tenant(tenant, (t) => port.settleIn(t, command))).toEqual({
    outcome: 'charged_unknown',
    debitMinor: 20,
    outputDigest: null,
  });
  expect(await runtime.tenant(tenant, (t) => port.settleIn(t, command))).toEqual({
    outcome: 'charged_unknown',
    debitMinor: 20,
    outputDigest: null,
  });
  await expect(
    runtime.tenant(tenant, (t) => port.settleIn(t, { ...command, outcome: 'released' })),
  ).rejects.toMatchObject({ code: 'OPENAI_BUDGET_SETTLEMENT_CONFLICT' });
  expect(
    (
      await owner.query(
        'SELECT sum(held_delta)::int AS held,sum(debit_delta)::int AS debit,count(*)::int AS n FROM openai_budget_journal WHERE reservation_id=$1',
        [r.id],
      )
    ).rows,
  ).toEqual([{ held: 0, debit: 20, n: 3 }]);
});
it('undispatched reserved liability can release but never debit unknown without marker', async () => {
  const r = await liability('reserved');
  await expect(
    runtime.tenant(tenant, (t) =>
      port.settleIn(t, {
        reservationId: r.id,
        ownerToken: r.ownerToken,
        requestDigest: r.digest,
        outcome: 'charged_unknown',
        outputDigest: null,
      }),
    ),
  ).rejects.toMatchObject({ code: 'OPENAI_BUDGET_SETTLEMENT_INVALID' });
  expect(
    await runtime.tenant(tenant, (t) =>
      port.settleIn(t, {
        reservationId: r.id,
        ownerToken: r.ownerToken,
        requestDigest: r.digest,
        outcome: 'released',
        outputDigest: null,
      }),
    ),
  ).toEqual({ outcome: 'released', debitMinor: 0, outputDigest: null });
});
it('foreign tenant/token/digest cannot settle or replay another liability', async () => {
  const r = await liability();
  expect(await runtime.tenant(foreign, (t) => port.reserveIn(t, request(r)))).toEqual({
    kind: 'denied',
  });
  for (const [id, token, digest] of [
    [foreign, r.ownerToken, r.digest],
    [tenant, randomUUID(), r.digest],
    [tenant, r.ownerToken, hash('other')],
  ])
    await expect(
      runtime.tenant(z.string().parse(id), (t) =>
        port.settleIn(t, {
          reservationId: r.id,
          ownerToken: token,
          requestDigest: digest,
          outcome: 'charged_unknown',
          outputDigest: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'OPENAI_BUDGET_SETTLEMENT_INVALID' });
});
it('strict v2 decoders preserve flat replay and reject extra fields/invalid liability amounts', () => {
  const id = randomUUID();
  expect(
    decodeGlobalOpenAiBudgetReservation({
      kind: 'replayed',
      reservationId: id,
      outcome: 'released',
      debitMinor: 0,
      outputDigest: null,
    }),
  ).toEqual({
    kind: 'replayed',
    reservationId: id,
    outcome: 'released',
    debitMinor: 0,
    outputDigest: null,
  });
  for (const v of [
    { kind: 'replayed', settlement: {} },
    { kind: 'acquired', reservationId: id, requestDigest: hash('x'), maxDebitMinor: 50001 },
    { kind: 'busy', verified: true },
  ])
    expect(() => decodeGlobalOpenAiBudgetReservation(v)).toThrow('INVALID_OPENAI_BUDGET_RECEIPT');
  expect(() =>
    decodeGlobalOpenAiBudgetSettlement({ outcome: 'released', debitMinor: 1, outputDigest: null }),
  ).toThrow('INVALID_OPENAI_BUDGET_RECEIPT');
});
it('settlement rollback preserves exact liability and journal/month conservation', async () => {
  const r = await liability();
  const before = (
    await owner.query('SELECT held_krw,debited_krw,revision::text FROM openai_budget_month')
  ).rows;
  await expect(
    runtime.tenant(tenant, async (t) => {
      await port.settleIn(t, {
        reservationId: r.id,
        ownerToken: r.ownerToken,
        requestDigest: r.digest,
        outcome: 'charged_unknown',
        outputDigest: null,
      });
      await t.query('SELECT 1/0');
    }),
  ).rejects.toMatchObject({ code: '22012' });
  expect(
    (await owner.query('SELECT held_krw,debited_krw,revision::text FROM openai_budget_month')).rows,
  ).toEqual(before);
  expect(
    (
      await owner.query(
        'SELECT state,debit_krw FROM openai_budget_reservation WHERE reservation_id=$1',
        [r.id],
      )
    ).rows,
  ).toEqual([{ state: 'dispatching', debit_krw: null }]);
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM openai_budget_journal WHERE reservation_id=$1',
        [r.id],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
});
it('aggregate journal/reservation liability equals month counters without hidden refund', async () => {
  const counter = (await owner.query('SELECT held_krw,debited_krw FROM openai_budget_month'))
    .rows[0];
  const journal = (
    await owner.query(
      'SELECT sum(held_delta)::int AS held_krw,sum(debit_delta)::int AS debited_krw FROM openai_budget_journal',
    )
  ).rows[0];
  const liability = (
    await owner.query(
      "SELECT sum(CASE WHEN state IN ('reserved','dispatching') THEN reserved_krw ELSE 0 END)::int AS held_krw,sum(coalesce(debit_krw,0))::int AS debited_krw FROM openai_budget_reservation",
    )
  ).rows[0];
  expect(journal).toEqual(counter);
  expect(liability).toEqual(counter);
});
it('normal account erase scrubs old liability identities and never refunds held money', async () => {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [id, 'https://synthetic.invalid', randomUUID()],
  );
  const r = await liability('dispatching', id);
  const before = (await owner.query('SELECT held_krw,debited_krw FROM openai_budget_month')).rows;
  await runtime.tenant(id, (t) => t.query('SELECT public.erase_account($1)', [id]));
  expect(
    (
      await owner.query(
        'SELECT athlete_id,run_id,subject_digest,state,reserved_krw FROM openai_budget_reservation WHERE reservation_id=$1',
        [r.id],
      )
    ).rows,
  ).toEqual([
    {
      athlete_id: null,
      run_id: null,
      subject_digest: hash(id),
      state: 'dispatching',
      reserved_krw: 20,
    },
  ]);
  expect((await owner.query('SELECT held_krw,debited_krw FROM openai_budget_month')).rows).toEqual(
    before,
  );
  expect(
    (
      await owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
        roles.runtime,
        'public.erase_account_before_global_budget(text)',
      ])
    ).rows,
  ).toEqual([{ allowed: false }]);
  const p = new Pool({ connectionString: url(roles.runtime) });
  try {
    await expect(
      p.query('SELECT public.erase_account_before_global_budget($1)', [tenant]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await p.end();
  }
});
async function waitingGlobal(observer: PoolClient, mode: string, role: string) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const r = await observer.query<{ pid: number }>(
      "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.usename=$1 AND a.datname=$2 AND l.locktype='advisory' AND l.classid=77210 AND l.objid=1 AND l.objsubid=2 AND l.mode=$3 AND NOT l.granted",
      [role, dbName, mode],
    );
    if (r.rows[0]) return r.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('GLOBAL_LOCK_WAIT_NOT_OBSERVED');
}
it('Database tenant acquires global shared before lifecycle/tenant/budget under exclusive fence', async () => {
  const holder = await owner.connect(),
    observer = await owner.connect();
  let pending: Promise<unknown> | null = null;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(77210,1)');
    let entered = false;
    pending = runtime.tenant(tenant, async (t) => {
      entered = true;
      await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);
      return port.reserveIn(t, {
        definitionVersion: 'provider-budget-reservation-v2',
        runId: randomUUID(),
        key: hash(randomUUID()),
        requestDigest: hash(randomUUID()),
        priceVersion: 'synthetic-price-v1',
        inputBound: 1,
        outputBound: 1,
        ownerToken: randomUUID(),
      });
    });
    const denied = expect(pending).rejects.toMatchObject({ code: 'RESTORE_PROCESSING_CLOSED' });
    const pid = await waitingGlobal(observer, 'ShareLock', roles.runtime);
    expect(entered).toBe(false);
    expect(
      (
        await observer.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND objsubid=1",
          [pid],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    await holder.query('ROLLBACK');
    await denied;
  } finally {
    await holder.query('ROLLBACK');
    if (pending) await pending.catch(() => undefined);
    holder.release();
    observer.release();
  }
});
it('retained accounting transaction shared fence blocks owner exclusive until completion', async () => {
  const r = await liability(),
    holder = await owner.connect(),
    observer = await owner.connect();
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let pending: Promise<unknown> | null = null;
  const accounting = runtime.tenant(tenant, async (t) => {
    enter();
    await barrier;
    return port.settleIn(t, {
      reservationId: r.id,
      ownerToken: r.ownerToken,
      requestDigest: r.digest,
      outcome: 'charged_unknown',
      outputDigest: null,
    });
  });
  try {
    await entered;
    await holder.query('BEGIN');
    pending = holder.query('SELECT pg_advisory_xact_lock(77210,1)');
    await waitingGlobal(observer, 'ExclusiveLock', roles.owner);
    release();
    expect(await accounting).toEqual({
      outcome: 'charged_unknown',
      debitMinor: 20,
      outputDigest: null,
    });
    await pending;
    await holder.query('ROLLBACK');
  } finally {
    release();
    await accounting.catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
    await holder.query('ROLLBACK');
    holder.release();
    observer.release();
  }
});
it('REASSIGN and existing retarget preserve live-owner accounting while old owner loses mutation access', async () => {
  const r = await liability();
  const previous = owner;
  await admin.query(`GRANT "${roles.next}" TO "${roles.owner}"`);
  try {
    await observeOwnerTransfer('reassign_owned', async () => {
      const client = await previous.connect();
      try {
        // Passive probe failure never replaces the subsequent original command.
        try {
          const observed = await client.query(
            `WITH fixture AS (
 SELECT (SELECT oid FROM pg_roles WHERE rolname=$1::text) AS old_oid,
        (SELECT oid FROM pg_roles WHERE rolname=$2::text) AS next_oid,
        (SELECT oid FROM pg_database WHERE datname=current_database()) AS db_oid
), owned_namespaces AS (
 SELECT n.oid, n.nspname,
   pg_has_role(current_user,n.nspowner,'USAGE') AS caller_has_owner_privileges
 FROM pg_namespace n,fixture f WHERE n.nspowner=f.old_oid
)
SELECT
 current_user=session_user AS same_session,
 current_user=$1::text AS caller_is_old,
 current_database()=$3::text AS current_database_matches_fixture,
 f.old_oid IS NOT NULL AS old_role_exists,
 f.next_oid IS NOT NULL AS next_role_exists,
 pg_has_role(current_user,f.old_oid,'USAGE') AS caller_has_old_privileges,
 pg_has_role(current_user,f.next_oid,'USAGE') AS caller_has_next_privileges,
 pg_has_role(current_user,f.next_oid,'SET') AS caller_can_set_next,
 (SELECT rolinherit FROM pg_roles WHERE rolname=current_user) AS caller_inherits,
 (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS caller_super,
 (SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS caller_createdb,
 (SELECT datdba=f.old_oid FROM pg_database WHERE oid=f.db_oid) AS database_is_old_owned,
 has_database_privilege(current_user,f.db_oid,'CREATE') AS caller_database_create,
 pg_has_role(current_user,'pg_database_owner','USAGE') AS caller_database_owner_privileges,
 (SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname='pg_database_owner')
  FROM pg_namespace WHERE nspname='public') AS public_schema_database_owner,
 has_schema_privilege(current_user,'public','CREATE') AS caller_public_create,
 has_schema_privilege(f.next_oid,'public','CREATE') AS next_public_create_observed_not_reassign_requirement,
 (SELECT count(*)::int FROM owned_namespaces) AS owned_namespace_count,
 (SELECT count(*)::int FROM owned_namespaces WHERE NOT caller_has_owner_privileges) AS owned_namespace_not_owner_count,
 (SELECT count(*)::int FROM owned_namespaces WHERE nspname NOT IN
    ('identity_private','garmin_private','wm_app_load')) AS unexpected_owned_namespace_count,
 (SELECT count(*)::int FROM pg_database WHERE datdba=f.old_oid) AS old_owned_shared_database_count,
 (SELECT count(*)::int FROM pg_tablespace WHERE spcowner=f.old_oid) AS old_owned_tablespace_count,
 (SELECT count(*)::int FROM pg_auth_members WHERE member=f.old_oid AND roleid=f.next_oid
    AND inherit_option AND set_option) AS direct_inherit_set_grant_count
FROM fixture f`,
            [roles.owner, roles.next, dbName],
          );
          // Validation/logging errors cannot replace REASSIGN's result or original error.
          try {
            const facts = z
              .strictObject({
                same_session: z.boolean(),
                caller_is_old: z.boolean(),
                current_database_matches_fixture: z.boolean(),
                old_role_exists: z.boolean(),
                next_role_exists: z.boolean(),
                caller_has_old_privileges: z.boolean(),
                caller_has_next_privileges: z.boolean(),
                caller_can_set_next: z.boolean(),
                caller_inherits: z.boolean(),
                caller_super: z.boolean(),
                caller_createdb: z.boolean(),
                database_is_old_owned: z.boolean(),
                caller_database_create: z.boolean(),
                caller_database_owner_privileges: z.boolean(),
                public_schema_database_owner: z.boolean(),
                caller_public_create: z.boolean(),
                next_public_create_observed_not_reassign_requirement: z.boolean(),
                owned_namespace_count: z.number().int().min(0).max(1000000),
                owned_namespace_not_owner_count: z.number().int().min(0).max(1000000),
                unexpected_owned_namespace_count: z.number().int().min(0).max(1000000),
                old_owned_shared_database_count: z.number().int().min(0).max(1000000),
                old_owned_tablespace_count: z.number().int().min(0).max(1000000),
                direct_inherit_set_grant_count: z.number().int().min(0).max(1000000),
              })
              .safeParse(observed.rows.length === 1 ? observed.rows[0] : undefined);
            console.info(
              JSON.stringify(
                facts.success
                  ? {
                      diagnostic: 'global_budget_owner_preflight',
                      phase: 'before_reassign',
                      facts: facts.data,
                    }
                  : {
                      diagnostic: 'global_budget_owner_preflight',
                      phase: 'before_reassign',
                      rejected: true,
                    },
              ),
            );
          } catch {
            /* Observation failure is not a changed SQL outcome. */
          }
        } catch {
          try {
            console.info(
              JSON.stringify({
                diagnostic: 'global_budget_owner_preflight',
                phase: 'before_reassign',
                queryFailed: true,
              }),
            );
          } catch {
            /* Preserve command outcome. */
          }
        }
        // REASSIGN follows pg_shdepend physical order, which other suites' churn reshuffles. An
        // object preceding its schema (or, for public, the database) needs next CREATE there, and
        // the 078 publication preceding the database needs next CREATE on the database, or the
        // plain owner gets 42501. Grant them first and drop the leftover public grant after; the
        // database grant merges into next's owner entry once the database itself moves.
        await client.query(
          `DO $grant$ DECLARE s name; BEGIN
             FOR s IN SELECT nspname FROM pg_namespace
               WHERE nspowner='${roles.owner}'::regrole OR nspname='public'
             LOOP EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I', s, '${roles.next}'); END LOOP;
             EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), '${roles.next}');
           END $grant$`,
        );
        const reassigned = await client.query(
          `REASSIGN OWNED BY "${roles.owner}" TO "${roles.next}"`,
        );
        await client.query(`REVOKE CREATE ON SCHEMA public FROM "${roles.next}"`);
        return reassigned;
      } finally {
        client.release();
      }
    });
  } finally {
    await observeOwnerTransfer('revoke_membership', () =>
      admin.query(`REVOKE "${roles.next}" FROM "${roles.owner}"`),
    );
  }
  owner = new Pool({ connectionString: url(roles.next), max: 6 });
  pools.push(owner);
  expect(
    Number((await owner.query('SELECT public.retarget_definer_policies() AS n')).rows[0]?.n),
  ).toBeGreaterThan(0);
  for (const table of tables)
    expect(
      (
        await owner.query(
          'SELECT pg_get_userbyid(relowner) AS owner,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [`public.${table}`],
        )
      ).rows,
    ).toEqual([{ owner: roles.next, relrowsecurity: true, relforcerowsecurity: true }]);
  expect(
    await runtime.tenant(tenant, (t) =>
      port.settleIn(t, {
        reservationId: r.id,
        ownerToken: r.ownerToken,
        requestDigest: r.digest,
        outcome: 'charged_unknown',
        outputDigest: null,
      }),
    ),
  ).toEqual({ outcome: 'charged_unknown', debitMinor: 20, outputDigest: null });
  await expect(previous.query('UPDATE openai_budget_month SET held_krw=0')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(
    previous.query('INSERT INTO openai_budget_fx_definition VALUES($1,1,1,$2,true)', [
      'old-owner',
      hash('x'),
    ]),
  ).rejects.toMatchObject({ code: '42501' });
});
