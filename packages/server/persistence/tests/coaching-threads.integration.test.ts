import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, TenantErasedError, type Database } from '../src/database.js';
import { migrate, grantOperations, grantCoachingThreads } from '../src/migrate.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createPlanningRepository } from '../src/planning.js';
import { createOperationsRepository } from '../src/operations.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE ON plan_head,plan_snapshot,plan_history,command_receipt,outbox TO workout_runtime',
  );
  await admin.query(
    'GRANT SELECT ON consent,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
async function seed(athlete: string, sessionId = 'session') {
  const draft: PlanDraft = {
    title: 'Completion',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: sessionId,
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Run',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  return createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
}

const command = (version: string) => ({
  planVersionId: version,
  title: 'Synthetic private conversation',
  scope: { kind: 'session' as const, targetId: 'session' },
  message: '  Synthetic user message\n',
  idempotencyKey: randomUUID(),
});
it('pins owned historical plans and preserves user messages, original receipts, and plan state through concurrent append', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    repo = createCoachingThreadRepository(database);
  const newest = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...plan.draft, title: 'Newest' },
  });
  const input = { ...command(plan.id), idempotencyKey: 'k'.repeat(200) };
  const [first, duplicate] = await Promise.all([
    repo.create(athlete, input),
    repo.create(athlete, input),
  ]);
  expect(duplicate).toEqual(first);
  expect(first.message.content).toBe(input.message);
  expect(first.message.role).toBe('user');
  expect(first.thread.planVersionId).toBe(plan.id);
  const append = {
    expectedRevision: 1,
    message: 'Second user message',
    idempotencyKey: randomUUID(),
  };
  const [second, repeated] = await Promise.all([
    repo.append(athlete, first.thread.id, append),
    repo.append(athlete, first.thread.id, append),
  ]);
  expect(second).toEqual(repeated);
  expect(second.thread.revision).toBe(2);
  expect(await repo.create(athlete, input)).toEqual(first);
  expect(await repo.append(athlete, first.thread.id, append)).toEqual(second);
  await expect(
    repo.append(athlete, first.thread.id, { ...append, message: 'changed content' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const competing = await Promise.allSettled(
    ['third A', 'third B'].map((message) =>
      repo.append(athlete, first.thread.id, {
        expectedRevision: 2,
        message,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  expect(competing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(competing.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'CONVERSATION_REVISION_CONFLICT' },
  });
  const page = await repo.messages(athlete, first.thread.id, { limit: 2 });
  expect(page?.messages.map((m) => m.revision)).toEqual([1, 2]);
  expect(page?.thread.revision).toBe(3);
  expect(page?.hasMore).toBe(true);
  expect(
    (await repo.messages(athlete, first.thread.id, { afterRevision: 2 }))?.messages.map(
      (m) => m.revision,
    ),
  ).toEqual([3]);
  expect(await repo.messages(athlete, first.thread.id, { afterRevision: 3 })).toMatchObject({
    messages: [],
    hasMore: false,
  });
  expect((await createPlanningRepository(database).read(athlete)).head?.id).toBe(newest.id);
  await database.tenant(athlete, async (tx) => {
    const rows = await tx.query(
      "SELECT topic,payload FROM outbox WHERE athlete_id=$1 AND topic LIKE 'coaching.%'",
      [athlete],
    );
    expect(rows.rows).toHaveLength(3);
    expect(JSON.stringify(rows.rows)).not.toContain(input.message);
    for (const row of rows.rows)
      expect(Object.keys(row['payload'] as object).sort()).toEqual([
        'messageId',
        'planVersionId',
        'revision',
        'threadId',
      ]);
    expect(
      (
        await tx.query(
          'SELECT count(*)::int AS count FROM activity_canonical WHERE athlete_id=$1',
          [athlete],
        )
      ).rows[0]?.['count'],
    ).toBe(0);
  });
});
it('rejects foreign or mismatched scope, pages owned threads including past-end totals, exports and erases messages', async () => {
  const athlete = randomUUID(),
    other = randomUUID(),
    plan = await seed(athlete),
    repo = createCoachingThreadRepository(database);
  await expect(repo.create(other, command(plan.id))).rejects.toMatchObject({
    code: 'PLAN_VERSION_NOT_FOUND',
  });
  await expect(
    repo.create(athlete, { ...command(plan.id), scope: { kind: 'phase', targetId: 'block' } }),
  ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' });
  await expect(
    repo.create(athlete, { ...command(plan.id), scope: { kind: 'session', targetId: 'missing' } }),
  ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' });
  const first = await repo.create(athlete, command(plan.id));
  await repo.create(athlete, { ...command(plan.id), scope: { kind: 'block', targetId: 'block' } });
  await repo.create(athlete, { ...command(plan.id), scope: { kind: 'phase', targetId: 'phase' } });
  const list = await repo.list(athlete, { limit: 2 });
  expect(list.total).toBe(3);
  expect(list.items).toHaveLength(2);
  const last = await repo.list(athlete, { limit: 2, offset: 2 });
  expect(new Set([...list.items, ...last.items].map((t) => t.id)).size).toBe(3);
  expect(await repo.list(athlete, { offset: 100 })).toEqual({ items: [], total: 3 });
  expect(await repo.read(other, first.thread.id)).toBeNull();
  expect(await repo.messages(other, first.thread.id)).toBeNull();
  expect(await repo.list(other)).toEqual({ items: [], total: 0 });
  await expect(
    repo.append(other, first.thread.id, {
      expectedRevision: 1,
      message: 'foreign',
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
  await database.tenant(other, async (tx) =>
    expect(
      (await tx.query('SELECT * FROM coaching_message WHERE athlete_id=$1', [athlete])).rows,
    ).toEqual([]),
  );
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query("UPDATE coaching_thread SET scope='{}'::jsonb WHERE athlete_id=$1 AND id=$2", [
        athlete,
        first.thread.id,
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query('UPDATE coaching_message SET content=$3 WHERE athlete_id=$1 AND thread_id=$2', [
        athlete,
        first.thread.id,
        'mutated',
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  const exported = await createOperationsRepository(database).exportAccount(athlete);
  expect(exported.schemaVersion).toBe(6);
  if (exported.schemaVersion !== 6) throw new Error('Expected current export schema');
  expect(exported.data.coachingThreads).toHaveLength(3);
  expect(exported.data.coachingMessages).toHaveLength(3);
  expect(JSON.stringify(exported.data.coachingMessages)).toContain('Synthetic user message');
  await createOperationsRepository(database).eraseAccount(athlete);
  await expect(repo.list(athlete)).rejects.toBeInstanceOf(TenantErasedError);
  for (const table of ['coaching_thread', 'coaching_message'])
    expect(
      (
        await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
          athlete,
        ])
      ).rows[0].count,
    ).toBe(0);
});
it('rolls back initial and appended messages together with head and receipt when outbox insertion fails', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete);
  const failing: Database = {
    ...database,
    tenant: (id, op) =>
      database.tenant(id, (tx) =>
        op({
          ...tx,
          query: async (sql, params) => {
            if (sql.includes('INSERT INTO outbox')) throw new Error('Synthetic outbox failure');
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const repo = createCoachingThreadRepository(database),
    broken = createCoachingThreadRepository(failing),
    input = command(plan.id);
  await expect(broken.create(athlete, input)).rejects.toThrow('Synthetic outbox failure');
  expect(await repo.list(athlete)).toEqual({ items: [], total: 0 });
  const first = await repo.create(athlete, input),
    append = { expectedRevision: 1, message: 'Append rollback', idempotencyKey: randomUUID() };
  await expect(broken.append(athlete, first.thread.id, append)).rejects.toThrow(
    'Synthetic outbox failure',
  );
  expect((await repo.read(athlete, first.thread.id))?.revision).toBe(1);
  expect((await repo.messages(athlete, first.thread.id))?.messages).toHaveLength(1);
  expect((await repo.append(athlete, first.thread.id, append)).thread.revision).toBe(2);
});
it('reads page and head from one MVCC statement even when append commits before result decoding', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    repo = createCoachingThreadRepository(database),
    first = await repo.create(athlete, command(plan.id));
  let queries = 0,
    committed = false;
  const observed: Database = {
    ...database,
    tenant: (id, op) =>
      database.tenant(id, (tx) =>
        op({
          ...tx,
          query: async (sql, params) => {
            queries++;
            const result = await tx.query(sql, params);
            if (!committed) {
              await repo.append(athlete, first.thread.id, {
                expectedRevision: 1,
                message: 'Concurrent later message',
                idempotencyKey: randomUUID(),
              });
              committed = true;
            }
            return result;
          },
        }),
      ),
  };
  const snapshot = await createCoachingThreadRepository(observed).messages(
    athlete,
    first.thread.id,
  );
  expect(queries).toBe(1);
  expect(snapshot?.thread.revision).toBe(1);
  expect(snapshot?.messages.map((m) => m.revision)).toEqual([1]);
  expect(snapshot?.hasMore).toBe(false);
  expect((await repo.messages(athlete, first.thread.id))?.messages.map((m) => m.revision)).toEqual([
    1, 2,
  ]);
});
