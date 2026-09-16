import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createCheckInRepository, type CheckInRepository } from '../src/check-ins.js';
import { migrate, grantOperations, grantCheckIns } from '../src/migrate.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let repository: CheckInRepository;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCheckIns(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  repository = createCheckInRepository(database);
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
const values = () => ({
  observedAt: '2026-01-02T23:00:00Z',
  timezone: 'Asia/Seoul',
  fatigue: 0,
  discomfort: null,
  bodyLocation: null,
  note: 'private health note',
});
const create = () => ({ idempotencyKey: randomUUID(), values: values() });
const query = { from: '2026-01-03', toExclusive: '2026-01-04', limit: 50, offset: 0 };
it('concurrent replay creates once, preserves zero/null and local date, and conflicts on changed input', async () => {
  const athlete = randomUUID(),
    input = create();
  const [a, b] = await Promise.all([
    repository.createCheckIn(athlete, input),
    repository.createCheckIn(athlete, input),
  ]);
  expect(a).toEqual(b);
  expect(await repository.getCheckIn(athlete, a.id)).toMatchObject({
    revision: 1,
    localDate: '2026-01-03',
    values: { fatigue: 0, discomfort: null },
    source: 'user',
    method: 'self_report',
    definitionVersion: 'checkin-v1',
  });
  expect(await repository.listCheckIns(athlete, query)).toMatchObject({
    total: 1,
    collectionRevision: 1,
  });
  await expect(
    repository.createCheckIn(athlete, { ...input, values: { ...input.values, fatigue: 1 } }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const counts = await database.tenant(athlete, (tx) =>
    tx.query(
      'SELECT (SELECT count(*)::int FROM check_in_revision) AS revisions,(SELECT count(*)::int FROM outbox) AS events',
    ),
  );
  expect(counts.rows[0]).toEqual({ revisions: 1, events: 1 });
});
it('serializes competing corrections and returns historical receipt without overwriting current values', async () => {
  const athlete = randomUUID(),
    initial = await repository.createCheckIn(athlete, create());
  const input = {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'corrected observation',
    values: { ...values(), fatigue: 3 },
  };
  const results = await Promise.allSettled([
    repository.updateCheckIn(athlete, initial.id, input),
    repository.updateCheckIn(athlete, initial.id, {
      ...input,
      idempotencyKey: randomUUID(),
      values: { ...values(), fatigue: 4 },
    }),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
  const current = await repository.getCheckIn(athlete, initial.id);
  expect(current?.revision).toBe(2);
  const history = await database.tenant(athlete, (tx) =>
    tx.query('SELECT count(*)::int AS count FROM check_in_revision'),
  );
  expect(history.rows[0]?.['count']).toBe(2);
});
it('deletion scrubs payload history and safely replays old receipts without resurrection', async () => {
  const athlete = randomUUID(),
    input = create(),
    created = await repository.createCheckIn(athlete, input);
  const deletion = { idempotencyKey: randomUUID(), expectedRevision: 1 };
  const deleted = await repository.deleteCheckIn(athlete, created.id, deletion);
  expect(deleted).toMatchObject({ deleted: true, revision: 2, collectionRevision: 2 });
  expect(await repository.deleteCheckIn(athlete, created.id, deletion)).toEqual(deleted);
  expect(await repository.createCheckIn(athlete, input)).toEqual(created);
  expect(await repository.getCheckIn(athlete, created.id)).toBeNull();
  const raw = await database.tenant(athlete, (tx) =>
    tx.query(
      'SELECT (SELECT jsonb_agg(c) FROM check_in c) AS current,(SELECT count(*)::int FROM check_in_revision) AS history,(SELECT jsonb_agg(r) FROM check_in_receipt r) AS receipts',
    ),
  );
  expect(raw.rows[0]?.['history']).toBe(0);
  expect(JSON.stringify(raw.rows)).not.toContain('private health note');
  expect(JSON.stringify(raw.rows)).not.toContain('Asia/Seoul');
  await expect(
    repository.updateCheckIn(athlete, created.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
      reason: 'late',
      values: values(),
    }),
  ).rejects.toThrow('CHECK_IN_NOT_FOUND');
});
it('isolates tenants in reads, writes, RLS and empty collection revision', async () => {
  const athlete = randomUUID(),
    other = randomUUID(),
    created = await repository.createCheckIn(athlete, create());
  expect(await repository.getCheckIn(other, created.id)).toBeNull();
  expect(await repository.listCheckIns(other, query)).toEqual({
    items: [],
    total: 0,
    collectionRevision: 0,
  });
  await expect(
    repository.deleteCheckIn(other, created.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    }),
  ).rejects.toThrow('CHECK_IN_NOT_FOUND');
  const rows = await database.tenant(other, (tx) =>
    tx.query('SELECT * FROM check_in WHERE athlete_id=$1', [athlete]),
  );
  expect(rows.rowCount).toBe(0);
});
it('rolls back all writes when outbox persistence fails', async () => {
  const athlete = randomUUID();
  const broken: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: (sql, args) => {
            if (sql.includes('INSERT INTO outbox')) throw new Error('injected outbox failure');
            return tx.query(sql, args);
          },
        }),
      ),
  };
  await expect(createCheckInRepository(broken).createCheckIn(athlete, create())).rejects.toThrow(
    'injected',
  );
  expect(await repository.listCheckIns(athlete, query)).toEqual({
    items: [],
    total: 0,
    collectionRevision: 0,
  });
  const rows = await database.tenant(athlete, (tx) =>
    tx.query('SELECT count(*)::int AS count FROM check_in_receipt'),
  );
  expect(rows.rows[0]?.['count']).toBe(0);
});
it('validates future time, report ranges and bounded date windows', async () => {
  const athlete = randomUUID();
  await expect(
    repository.createCheckIn(athlete, {
      ...create(),
      values: { ...values(), observedAt: new Date(Date.now() + 600000).toISOString() },
    }),
  ).rejects.toMatchObject({ code: 'OBSERVED_AT_IN_FUTURE' });
  await expect(
    repository.createCheckIn(athlete, { ...create(), values: { ...values(), fatigue: 11 } }),
  ).rejects.toThrow();
  await expect(
    repository.listCheckIns(athlete, { ...query, toExclusive: '2027-01-01' }),
  ).rejects.toThrow();
  expect(
    (
      await repository.listCheckIns(athlete, {
        ...query,
        from: '2026-01-02',
        toExclusive: '2026-01-03',
      })
    ).total,
  ).toBe(0);
});
it('account erasure removes all rows and blocks stale creation', async () => {
  const athlete = randomUUID(),
    input = create();
  await repository.createCheckIn(athlete, input);
  await database.exclusiveTenant(athlete, (tx) =>
    tx.query('SELECT public.erase_account($1)', [athlete]),
  );
  const counts = await admin.query(
    'SELECT (SELECT count(*)::int FROM check_in WHERE athlete_id=$1)+(SELECT count(*)::int FROM check_in_revision WHERE athlete_id=$1)+(SELECT count(*)::int FROM check_in_receipt WHERE athlete_id=$1)+(SELECT count(*)::int FROM check_in_collection_head WHERE athlete_id=$1) AS count',
    [athlete],
  );
  expect(counts.rows[0].count).toBe(0);
  await expect(repository.createCheckIn(athlete, input)).rejects.toThrow('ACCOUNT_ERASED');
});

it('serializes correction against deletion without resurrecting deleted data', async () => {
  const athlete = randomUUID(),
    created = await repository.createCheckIn(athlete, create());
  const results = await Promise.allSettled([
    repository.updateCheckIn(athlete, created.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      reason: 'correction race',
      values: { ...values(), fatigue: 5 },
    }),
    repository.deleteCheckIn(athlete, created.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const current = await repository.getCheckIn(athlete, created.id);
  if (current) expect(current.revision).toBe(2);
  expect((await repository.listCheckIns(athlete, query)).collectionRevision).toBe(2);
});
it('fences a concurrent create against account erasure', async () => {
  const athlete = randomUUID();
  const results = await Promise.allSettled([
    repository.createCheckIn(athlete, create()),
    database.exclusiveTenant(athlete, (tx) =>
      tx.query('SELECT public.erase_account($1)', [athlete]),
    ),
  ]);
  expect(results[1]?.status).toBe('fulfilled');
  const count = await admin.query(
    'SELECT count(*)::int AS count FROM check_in WHERE athlete_id=$1',
    [athlete],
  );
  expect(count.rows[0].count).toBe(0);
  await expect(repository.createCheckIn(athlete, create())).rejects.toThrow('ACCOUNT_ERASED');
});

it('uses an injected clock for the exact future boundary and pads ancient local years', async () => {
  const fixed = createCheckInRepository(database, { now: () => new Date('2026-01-03T00:00:00Z') });
  const athlete = randomUUID();
  const boundary = await fixed.createCheckIn(athlete, {
    ...create(),
    values: { ...values(), observedAt: '2026-01-03T00:05:00Z' },
  });
  expect(boundary.revision).toBe(1);
  await expect(
    fixed.createCheckIn(athlete, {
      ...create(),
      values: { ...values(), observedAt: '2026-01-03T00:05:00.001Z' },
    }),
  ).rejects.toMatchObject({ code: 'OBSERVED_AT_IN_FUTURE' });
  const ancient = await fixed.createCheckIn(athlete, {
    ...create(),
    values: { ...values(), observedAt: '0001-01-02T00:00:00Z', timezone: 'UTC' },
  });
  expect((await fixed.getCheckIn(athlete, ancient.id))?.localDate).toBe('0001-01-02');
});
