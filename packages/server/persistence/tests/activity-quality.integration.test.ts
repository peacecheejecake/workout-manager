import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { ActivityImport, ActivityListQuery } from '@workout/contracts/activity';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createActivityRepository } from '../src/activities.js';
import { createPlanningRepository } from '../src/planning.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON plan_head,plan_snapshot,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,command_receipt,outbox TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
function input(values: Partial<ActivityImport['activity']> = {}): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Quality fixture',
      kind: 'running',
      startedAt: '2024-01-01T12:00:00Z',
      timezone: 'UTC',
      distanceMeters: null,
      durationSeconds: null,
      durationKind: 'unknown',
      ...values,
    },
  };
}
async function ids(athlete: string, query: Partial<ActivityListQuery>) {
  return (await createActivityRepository(database).listActivities(athlete, query)).items.map(
    (item) => item.id,
  );
}
it('uses effective null rather than zero for distance and duration, including both overlay directions', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database);
  const missing = await repo.importActivity(athlete, input());
  const zero = await repo.importActivity(athlete, input({ distanceMeters: 0, durationSeconds: 0 }));
  const knownUnknown = await repo.importActivity(
    athlete,
    input({ distanceMeters: 10, durationSeconds: 20, durationKind: 'unknown' }),
  );
  expect(await ids(athlete, { quality: 'missing_distance' })).toEqual([missing.activityId]);
  expect(await ids(athlete, { quality: 'missing_duration' })).toEqual([missing.activityId]);
  await repo.updateOverlay(athlete, missing.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Known zero',
    distanceMeters: 0,
    durationSeconds: 0,
    durationKind: 'timer',
  });
  await repo.updateOverlay(athlete, zero.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Actually unknown',
    distanceMeters: null,
    durationSeconds: null,
    durationKind: 'unknown',
  });
  expect(await ids(athlete, { quality: 'missing_distance' })).toEqual([zero.activityId]);
  expect(await ids(athlete, { quality: 'missing_duration' })).toEqual([zero.activityId]);
  expect((await repo.getActivity(athlete, knownUnknown.activityId))?.effective.durationKind).toBe(
    'unknown',
  );
});
it('treats only null effective start as missing while preserving year-zero observations', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database);
  const unknown = await repo.importActivity(athlete, input({ startedAt: null }));
  const ancient = await repo.importActivity(athlete, input({ startedAt: '0000-02-29T00:00:00Z' }));
  expect(await ids(athlete, { quality: 'missing_start' })).toEqual([unknown.activityId]);
  await repo.updateOverlay(athlete, unknown.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Known start',
    startedAt: '2024-01-01T12:00:00Z',
    timezone: 'UTC',
  });
  await repo.updateOverlay(athlete, ancient.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Unknown observation',
    startedAt: null,
    timezone: null,
  });
  expect(await ids(athlete, { quality: 'missing_start' })).toEqual([ancient.activityId]);
  expect(
    (
      await repo.listActivities(athlete, {
        quality: 'missing_start',
        from: '2024-01-01',
        toExclusive: '2024-01-02',
        timezone: 'UTC',
      })
    ).total,
  ).toBe(0);
});
it('uses explicit correction reasons rather than canonical revision or an initial manual report', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    command = input({ distanceMeters: 0 });
  const imported = await repo.importActivity(athlete, command);
  await repo.importActivity(athlete, {
    ...command,
    idempotencyKey: randomUUID(),
    source: { ...command.source, revision: 2, contentHash: 'b'.repeat(64) },
  });
  const manual = await repo.createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      ...command.activity,
      title: 'Manual',
      startedAt: '2024-01-01T12:00:00Z',
      timezone: 'UTC',
    },
    report: { sessionRpe: 0, note: 'Initial report', planLink: null },
  });
  expect(await ids(athlete, { quality: 'corrected' })).toEqual([]);
  await repo.updateOverlay(athlete, imported.activityId, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    reason: 'Confirmed same value',
    distanceMeters: 0,
  });
  expect(await ids(athlete, { quality: 'corrected' })).toEqual([imported.activityId]);
  await repo.updateOverlay(athlete, manual.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Revise report',
    report: { sessionRpe: null, note: null, planLink: null },
  });
  expect((await ids(athlete, { quality: 'corrected' })).sort()).toEqual(
    [imported.activityId, manual.activityId].sort(),
  );
});
it('combines quality with explicit Block, date and source without multiplying rows or changing count across pages', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    levels = ['season', 'wave', 'phase', 'block'] as const;
  const draft: PlanDraft = {
    title: 'Quality plan',
    timezone: 'UTC',
    periods: levels.map((level, i) => ({
      id: level,
      parentId: i === 0 ? null : (levels[i - 1] ?? null),
      level,
      title: level,
      startDate: '2024-01-01',
      endDateExclusive: '2024-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'planned',
        blockId: 'block',
        date: '2024-01-01',
        localStartTime: null,
        title: 'Planned',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const plan = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  const matching: string[] = [];
  for (const startedAt of [
    '2024-01-01T12:00:00Z',
    '2024-01-01T12:00:00Z',
    '2024-02-02T12:00:00Z',
  ]) {
    const created = await repo.importActivity(athlete, input({ startedAt }));
    await repo.updateOverlay(athlete, created.activityId, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'Explicit link',
      report: {
        sessionRpe: null,
        note: null,
        planLink: { planVersionId: plan.id, sessionId: 'planned' },
      },
    });
    if (startedAt.startsWith('2024-01')) matching.push(created.activityId);
  }
  await repo.importActivity(athlete, input());
  const filter: Partial<ActivityListQuery> = {
    quality: 'missing_distance',
    linkedPlanVersionId: plan.id,
    linkedBlockId: 'block',
    source: 'fixture',
    from: '2024-01-01',
    toExclusive: '2024-02-01',
    timezone: 'UTC',
    sort: 'started_asc',
  };
  const first = await repo.listActivities(athlete, { ...filter, limit: 1 }),
    second = await repo.listActivities(athlete, { ...filter, limit: 1, offset: 1 });
  expect(first.total).toBe(2);
  expect(second.total).toBe(2);
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual(matching.sort());
  expect(await repo.listActivities(athlete, { ...filter, offset: 99 })).toEqual({
    total: 2,
    items: [],
  });
  expect((await repo.listActivities(athlete, { ...filter, source: 'manual' })).total).toBe(0);
  expect((await repo.listActivities(randomUUID(), filter)).total).toBe(0);
  const deleted = matching[0];
  if (!deleted) throw new Error('Missing fixture');
  await repo.deleteActivity(athlete, deleted, { expectedRevision: 2 });
  expect((await repo.listActivities(athlete, filter)).total).toBe(1);
});
