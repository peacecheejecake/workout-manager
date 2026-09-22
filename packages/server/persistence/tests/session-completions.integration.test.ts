import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations, grantSessionCompletions } from '../src/migrate.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';
import { createPlanningRepository } from '../src/planning.js';
import { createOperationsRepository } from '../src/operations.js';
import type { PlanDraft } from '@workout/contracts/planning';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated PostgreSQL harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantSessionCompletions(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE ON plan_snapshot,plan_head,plan_history,command_receipt,outbox TO workout_runtime',
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
  action: 'complete' as const,
  confirmed: true as const,
  expectedPlanVersionId: version,
  expectedRevision: null,
  reason: null,
  idempotencyKey: randomUUID(),
});
describe('user session completion ledger', () => {
  it('records future-session confirmation, duplicate replay, correction history and export without creating actuals', async () => {
    const athlete = randomUUID(),
      saved = await seed(athlete);
    const repo = createSessionCompletionRepository(database, {
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const input = command(saved.id);
    expect((await repo.read(athlete, 'session'))?.report).toBeNull();
    const [first, duplicate] = await Promise.all([
      repo.write(athlete, 'session', input),
      repo.write(athlete, 'session', input),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.report).toMatchObject({
      status: 'completed',
      reportedAt: '2026-01-01T00:00:00.000Z',
      schedule: { date: '2080-01-02' },
      source: 'user',
      method: 'self_report',
    });
    await expect(
      repo.write(athlete, 'session', { ...input, reason: 'changed' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      repo.write(athlete, 'session', {
        ...command(saved.id),
        expectedRevision: 1,
        reason: 'duplicate state',
      }),
    ).rejects.toMatchObject({ code: 'COMPLETION_STATE_CONFLICT' });
    const retract = {
      ...command(saved.id),
      action: 'retract' as const,
      expectedRevision: 1,
      reason: 'Incorrect confirmation',
    };
    const second = await repo.write(athlete, 'session', retract);
    expect(second.report.status).toBe('retracted');
    expect(await repo.write(athlete, 'session', input)).toEqual(first);
    expect((await repo.read(athlete, 'session'))?.report).toEqual(second.report);
    const third = await repo.write(athlete, 'session', {
      ...command(saved.id),
      expectedRevision: 2,
      reason: 'Confirmed again',
    });
    expect(third.collectionRevision).toBe(3);
    expect((await repo.read(athlete, 'session'))?.history.map((item) => item.revision)).toEqual([
      3, 2, 1,
    ]);
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    if (exported.schemaVersion !== 19) throw new Error('Expected completion export v19');
    expect(exported.data.sessionCompletions).toHaveLength(1);
    expect(exported.data.sessionCompletionRevisions).toHaveLength(3);
    expect(
      (await admin.query('SELECT * FROM activity_canonical WHERE athlete_id=$1', [athlete]))
        .rowCount,
    ).toBe(0);
    await createOperationsRepository(database).eraseAccount(athlete);
    for (const table of [
      'session_completion',
      'session_completion_revision',
      'session_completion_receipt',
      'session_completion_collection_head',
    ]) {
      expect(
        (await admin.query(`SELECT * FROM ${table} WHERE athlete_id=$1`, [athlete])).rowCount,
      ).toBe(0);
    }
  });
  it('blocks schedule identity changes and deletion while allowing new clone IDs and independent retraction', async () => {
    const athlete = randomUUID(),
      saved = await seed(athlete);
    const repo = createSessionCompletionRepository(database);
    const planner = createPlanningRepository(database);
    await repo.write(athlete, 'session', command(saved.id));
    const source = saved.draft.sessions[0];
    if (!source) throw new Error('Missing fixture');
    const drafts: PlanDraft[] = [
      { ...saved.draft, sessions: [] },
      { ...saved.draft, sessions: [{ ...source, date: '2080-01-03' }] },
      { ...saved.draft, sessions: [{ ...source, localStartTime: '12:00' }] },
      {
        ...saved.draft,
        timezone: 'Asia/Seoul',
        periods: saved.draft.periods.map((period) => ({ ...period, timezone: 'Asia/Seoul' })),
      },
      {
        ...saved.draft,
        periods: saved.draft.periods.map((period) =>
          period.id === 'block' ? { ...period, id: 'new-block' } : period,
        ),
        sessions: [{ ...source, blockId: 'new-block' }],
      },
    ];
    for (const draft of drafts)
      await expect(
        planner.save(athlete, {
          source: 'manual',
          confirmed: true,
          expectedVersionId: saved.id,
          idempotencyKey: randomUUID(),
          draft,
        }),
      ).rejects.toMatchObject({ code: 'PLAN_COMPLETED_SESSION' });
    const cloned = await planner.save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: saved.id,
      idempotencyKey: randomUUID(),
      draft: { ...saved.draft, sessions: [source, { ...source, id: 'clone' }] },
    });
    expect((await repo.read(athlete, 'clone'))?.report).toBeNull();
    expect((await repo.list(athlete)).items).toHaveLength(1);
    await repo.write(athlete, 'session', {
      ...command(cloned.id),
      action: 'retract',
      expectedRevision: 1,
      reason: 'Correct report',
    });
    const moved = await planner.save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: cloned.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...cloned.draft,
        sessions: cloned.draft.sessions.map((item) =>
          item.id === 'session' ? { ...item, date: '2080-01-03' } : item,
        ),
      },
    });
    expect(moved.draft.sessions[0]?.date).toBe('2080-01-03');
  });
  it('serializes competing completion and plan movement, and isolates tenants', async () => {
    const athlete = randomUUID(),
      saved = await seed(athlete);
    const repo = createSessionCompletionRepository(database);
    const planner = createPlanningRepository(database);
    const race = await Promise.allSettled([
      repo.write(athlete, 'session', command(saved.id)),
      planner.save(athlete, {
        source: 'manual',
        confirmed: true,
        expectedVersionId: saved.id,
        idempotencyKey: randomUUID(),
        draft: {
          ...saved.draft,
          sessions: saved.draft.sessions.map((session) => ({ ...session, date: '2080-01-03' })),
        },
      }),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const other = randomUUID();
    expect(await repo.read(other, 'session')).toBeNull();
    expect((await repo.list(other)).items).toEqual([]);
    await expect(repo.write(other, 'session', command(saved.id))).rejects.toMatchObject({
      code: 'SESSION_COMPLETION_NOT_FOUND',
    });
    await expect(
      repo.write(athlete, 'missing', command((await planner.read(athlete)).head?.id ?? saved.id)),
    ).rejects.toMatchObject({ code: 'SESSION_COMPLETION_NOT_FOUND' });
  });
  it('rolls back the entire report, collection and receipt if outbox insertion fails', async () => {
    const athlete = randomUUID(),
      saved = await seed(athlete, 'x'.repeat(200));
    const broken = createSessionCompletionRepository({
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, args) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('outbox failure');
              return tx.query(sql, args);
            },
          }),
        ),
    });
    const input = command(saved.id);
    await expect(broken.write(athlete, 'x'.repeat(200), input)).rejects.toThrow('outbox failure');
    const repo = createSessionCompletionRepository(database);
    expect((await repo.list(athlete)).collectionRevision).toBe(0);
    expect((await repo.read(athlete, 'x'.repeat(200)))?.history).toEqual([]);
    expect((await repo.write(athlete, 'x'.repeat(200), input)).report.revision).toBe(1);
  });
});

it('serializes distinct confirmation keys and rejects stale report or plan revisions', async () => {
  const athlete = randomUUID(),
    saved = await seed(athlete);
  const repo = createSessionCompletionRepository(database);
  const results = await Promise.allSettled([
    repo.write(athlete, 'session', command(saved.id)),
    repo.write(athlete, 'session', command(saved.id)),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failed = results.find((result) => result.status === 'rejected');
  expect(failed).toMatchObject({
    status: 'rejected',
    reason: { code: 'COMPLETION_REVISION_CONFLICT' },
  });
  const later = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: saved.id,
    idempotencyKey: randomUUID(),
    draft: { ...saved.draft, title: 'Later plan' },
  });
  await expect(
    repo.write(athlete, 'session', {
      ...command(saved.id),
      action: 'retract',
      expectedRevision: 1,
      reason: 'Old plan reference',
    }),
  ).rejects.toMatchObject({ code: 'PLAN_REVISION_CONFLICT' });
  await expect(
    repo.write(athlete, 'session', {
      ...command(later.id),
      action: 'retract',
      expectedRevision: 2,
      reason: 'Stale revision',
    }),
  ).rejects.toMatchObject({ code: 'COMPLETION_REVISION_CONFLICT' });
  expect((await repo.read(athlete, 'session'))?.history).toHaveLength(1);
  expect((await repo.list(athlete)).collectionRevision).toBe(1);
});

it('bounds history to the latest 100 reports and retains retracted history after removing the planned session', async () => {
  const athlete = randomUUID(),
    saved = await seed(athlete);
  const repo = createSessionCompletionRepository(database);
  let revision: number | null = null;
  for (let next = 1; next <= 102; next++) {
    const result = await repo.write(athlete, 'session', {
      ...command(saved.id),
      action: next % 2 === 1 ? 'complete' : 'retract',
      expectedRevision: revision,
      reason: next === 1 ? null : 'Synthetic correction',
    });
    revision = result.report.revision;
  }
  const read = await repo.read(athlete, 'session');
  expect(read?.totalHistory).toBe(102);
  expect(read?.history).toHaveLength(100);
  expect(read?.history.map((item) => item.revision)).toEqual(
    Array.from({ length: 100 }, (_, index) => 102 - index),
  );
  expect(read?.report).toEqual(read?.history[0]);
  expect(read?.report?.status).toBe('retracted');
  const other = randomUUID();
  await database.tenant(other, async (tx) => {
    for (const table of [
      'session_completion',
      'session_completion_revision',
      'session_completion_receipt',
      'session_completion_collection_head',
    ])
      expect(
        (await tx.query(`SELECT * FROM ${table} WHERE athlete_id=$1`, [athlete])).rows,
      ).toEqual([]);
  });
  await expect(
    database.tenant(other, (tx) =>
      tx.query('INSERT INTO session_completion_collection_head(athlete_id,revision) VALUES($1,1)', [
        athlete,
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: saved.id,
    idempotencyKey: randomUUID(),
    draft: { ...saved.draft, sessions: [] },
  });
  expect(await repo.read(athlete, 'session')).toBeNull();
  expect((await repo.list(athlete)).items).toEqual([]);
  const artifact = await createOperationsRepository(database).exportAccount(athlete);
  if (artifact.schemaVersion !== 19) throw new Error('Expected export v19');
  expect(artifact.data.sessionCompletions).toHaveLength(1);
  expect(artifact.data.sessionCompletionRevisions).toHaveLength(102);
});
