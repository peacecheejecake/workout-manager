import { emptyActual, emptyPlanned, summarizeDays } from '../src/dashboard-metrics.js';
import { createPeriodSummaryRepository } from '../src/period-summary.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import type { ActivityImport } from '@workout/contracts/activity';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations, grantCheckIns } from '../src/migrate.js';
import { createDashboardRepository } from '../src/dashboard.js';
import { createActivityRepository } from '../src/activities.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createPlanningRepository } from '../src/planning.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCheckIns(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON plan_head,plan_snapshot,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,command_receipt,outbox TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
const query = { anchor: '2024-03-10', window: 3, timezone: 'America/New_York' };
function activity(
  startedAt: string | null,
  overrides: Partial<ActivityImport['activity']> = {},
): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Synthetic',
      kind: 'running',
      startedAt,
      timezone: 'UTC',
      distanceMeters: null,
      durationSeconds: null,
      durationKind: 'unknown',
      ...overrides,
    },
  };
}
it('counts manual actuals once and projects corrected or cleared start times without changing the original', async () => {
  const athlete = randomUUID();
  const activities = createActivityRepository(database);
  const dashboard = createDashboardRepository(database);
  const created = await activities.createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      ...activity('2024-03-10T12:00:00Z').activity,
      title: 'Manual synthetic activity',
      startedAt: '2024-03-10T12:00:00Z',
      timezone: 'UTC',
      distanceMeters: 0,
    },
    report: { sessionRpe: 0, note: null, planLink: null },
  });
  const initial = await dashboard.read(athlete, query);
  expect(initial.current.actual.sources).toEqual({ fit: 0, fixture: 0, manual: 1 });
  expect(initial.current.actual.distanceMeters).toEqual({
    value: 0,
    knownCount: 1,
    missingCount: 0,
  });
  expect(initial.current.actual.overlayCount).toBe(0);
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Correct synthetic start date',
    startedAt: '2024-03-07T12:00:00Z',
    timezone: 'UTC',
  });
  const corrected = await dashboard.read(athlete, query);
  expect(corrected.current.actual.count).toBe(0);
  expect(corrected.previous.actual.sources.manual).toBe(1);
  expect(corrected.previous.actual.overlayCount).toBe(1);
  expect((await activities.getActivity(athlete, created.activityId))?.original.startedAt).toBe(
    '2024-03-10T12:00:00Z',
  );
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    reason: 'Start time is unknown',
    startedAt: null,
    timezone: null,
  });
  const unplaced = await dashboard.read(athlete, query);
  expect(unplaced.current.actual.count + unplaced.previous.actual.count).toBe(0);
  expect(unplaced.unplacedActivityCount).toBe(1);
  expect(unplaced.availability.actualLoad).toBe('unavailable');
});
function draft(): PlanDraft {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    title: 'Synthetic plan',
    timezone: 'America/New_York',
    periods: levels.map((level, index) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2024-01-01',
      endDateExclusive: '2025-01-01',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: ['2024-03-10', '2024-03-11', '2024-03-17', '2024-03-18'].map((date, index) => ({
      id: `session-${index}`,
      blockId: 'block',
      date,
      localStartTime: null,
      title: 'Planned only',
      sport: 'running',
      durationSeconds: 60,
      distanceMeters: null,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  };
}
async function savePlan(athlete: string, value = draft()) {
  return createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: value,
  });
}
async function checkin(athlete: string, observedAt: string, note = 'self report') {
  return createCheckInRepository(database).createCheckIn(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      observedAt,
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note,
    },
  });
}
it('returns bounded complete empty dates with unknown metrics and no invented coverage', async () => {
  const model = await createDashboardRepository(database, {
    now: () => new Date('2026-01-01T00:00:00Z'),
  }).read(randomUUID(), query);
  expect(model.days.map((d) => d.date)).toEqual(['2024-03-08', '2024-03-09', '2024-03-10']);
  expect(model.current.actual.distanceMeters).toEqual({
    value: null,
    knownCount: 0,
    missingCount: 0,
  });
  expect(model.planVersion).toBeNull();
  expect(model.latestCheckIn).toBeNull();
  expect(model.observedAt).toBe('2026-01-01T00:00:00.000Z');
  expect(model.availability.coverage).toBe('unknown');
  expect(model.connectionFreshness.lastSuccessfulSyncAt).toBeNull();
  expect(
    (
      await createDashboardRepository(database).read(randomUUID(), {
        anchor: '2024-03-01',
        window: 3,
        timezone: 'UTC',
      })
    ).days.map((d) => d.date),
  ).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
  expect(
    (await createDashboardRepository(database).read(randomUUID(), { ...query, window: 90 })).days,
  ).toHaveLength(90);
});
it('groups DST by local calendar date and preserves zero/null and separate duration definitions', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database);
  await repo.importActivity(
    athlete,
    activity('2024-03-10T04:59:59Z', {
      distanceMeters: 0,
      durationSeconds: 0,
      durationKind: 'timer',
    }),
  );
  const fit = activity('2024-03-10T05:00:00Z', { durationSeconds: 120, durationKind: 'elapsed' });
  fit.source.kind = 'fit';
  await repo.importActivity(athlete, fit);
  await repo.importActivity(
    athlete,
    activity('2024-03-11T03:59:59Z', { distanceMeters: 100, durationKind: 'timer' }),
  );
  await repo.importActivity(athlete, activity('2024-03-11T04:00:00Z', { distanceMeters: 999 }));
  await repo.importActivity(athlete, activity('2024-03-07T12:00:00Z', { distanceMeters: 50 }));
  await repo.importActivity(athlete, activity(null));
  const model = await createDashboardRepository(database).read(athlete, query);
  expect(model.days.map((d) => d.actual.count)).toEqual([0, 1, 2]);
  expect(model.current.actual.count).toBe(3);
  expect(model.current.actual.distanceMeters).toEqual({
    value: 100,
    knownCount: 2,
    missingCount: 1,
  });
  expect(model.current.actual.durationSeconds.timer).toEqual({
    value: 0,
    knownCount: 1,
    missingCount: 1,
  });
  expect(model.current.actual.durationSeconds.elapsed).toEqual({
    value: 120,
    knownCount: 1,
    missingCount: 0,
  });
  expect(model.current.actual.sources).toEqual({ fit: 1, fixture: 2, manual: 0 });
  expect(model.previous.actual.distanceMeters.value).toBe(50);
  expect(model.unplacedActivityCount).toBe(1);
  expect(model.dataRevision.activities).toEqual({ count: 6, revisionSum: '6' });
});
it('uses plan timezone and bounded upcoming dates, keeping planned metrics separate', async () => {
  const athlete = randomUUID(),
    plan = await savePlan(athlete);
  await createActivityRepository(database).importActivity(
    athlete,
    activity('2024-03-11T02:00:00Z', { distanceMeters: 0 }),
  );
  const model = await createDashboardRepository(database).read(athlete, {
    ...query,
    timezone: 'Asia/Seoul',
  });
  expect(model.period.timezoneSource).toBe('plan');
  expect(model.period.timezone).toBe('America/New_York');
  expect(model.planVersion).toEqual({ id: plan.id, version: 1 });
  expect(model.currentBlock?.id).toBe('block');
  expect(model.todaySessions.map((s) => s.id)).toEqual(['session-0']);
  expect(model.upcomingSessions.map((s) => s.id)).toEqual(['session-1', 'session-2']);
  expect(model.current.planned.durationSeconds.value).toBe(60);
  expect(model.current.actual.durationSeconds.elapsed.value).toBeNull();
  expect(model.current.actual.count).toBe(1);
});
it('reflects overlays, explicit null correction and tombstone revisions without resurrecting actuals', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    input = activity('2024-03-10T12:00:00Z', {
      distanceMeters: 50,
      durationSeconds: 30,
      durationKind: 'timer',
    });
  const initial = await repo.importActivity(athlete, input);
  await repo.updateOverlay(athlete, initial.activityId, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Correction',
    distanceMeters: null,
    durationSeconds: 70,
    durationKind: 'moving',
  });
  let model = await createDashboardRepository(database).read(athlete, query);
  expect(model.current.actual.distanceMeters).toEqual({
    value: null,
    knownCount: 0,
    missingCount: 1,
  });
  expect(model.current.actual.durationSeconds.moving.value).toBe(70);
  expect(model.current.actual.durationSeconds.timer.knownCount).toBe(0);
  expect(model.current.actual.overlayCount).toBe(1);
  expect(model.dataRevision.activities.revisionSum).toBe('2');
  await repo.deleteActivity(athlete, initial.activityId, { expectedRevision: 2 });
  model = await createDashboardRepository(database).read(athlete, query);
  expect(model.current.actual.count).toBe(0);
  expect(model.dataRevision.activities).toEqual({ count: 1, revisionSum: '3' });
});
it('projects checkins in dashboard timezone, selects latest only within current period and preserves source timezone', async () => {
  const athlete = randomUUID();
  await checkin(athlete, '2024-03-07T12:00:00Z');
  const a = await checkin(athlete, '2024-03-10T23:00:00Z');
  const b = await checkin(athlete, '2024-03-10T23:00:00Z');
  await checkin(athlete, '2024-03-12T12:00:00Z');
  const model = await createDashboardRepository(database).read(athlete, query);
  expect(model.current.checkInCount).toBe(2);
  expect(model.current.checkInDays).toBe(1);
  expect(model.previous.checkInCount).toBe(1);
  expect(model.latestCheckIn?.id).toBe([a.id, b.id].sort()[0]);
  expect(model.latestCheckIn?.localDate).toBe('2024-03-11');
  expect(model.latestCheckIn?.values.timezone).toBe('Asia/Seoul');
  expect(model.dataRevision.checkIns).toBe(4);
  const other = await createDashboardRepository(database).read(randomUUID(), query);
  expect(other.current.checkInCount).toBe(0);
  expect(other.latestCheckIn).toBeNull();
});
it('reads every component in one SELECT while concurrent commits remain visible only to the next read', async () => {
  const athlete = randomUUID();
  let selects = 0;
  const wrapped: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: async (sql, args) => {
            selects++;
            const result = await tx.query(sql, args);
            await createActivityRepository(database).importActivity(
              athlete,
              activity('2024-03-10T12:00:00Z', { distanceMeters: 42 }),
            );
            await checkin(athlete, '2024-03-10T12:00:00Z');
            await savePlan(athlete);
            return result;
          },
        }),
      ),
  };
  const old = await createDashboardRepository(wrapped).read(athlete, query);
  expect(selects).toBe(1);
  expect(old.planVersion).toBeNull();
  expect(old.current.actual.count).toBe(0);
  expect(old.dataRevision.activities.count).toBe(0);
  expect(old.dataRevision.checkIns).toBe(0);
  expect(old.latestCheckIn).toBeNull();
  const fresh = await createDashboardRepository(database).read(athlete, query);
  expect(fresh.planVersion?.version).toBe(1);
  expect(fresh.current.actual.count).toBe(1);
  expect(fresh.dataRevision.activities.count).toBe(1);
  expect(fresh.dataRevision.checkIns).toBe(1);
  expect(fresh.latestCheckIn).not.toBeNull();
});

it('aggregates explicit ranges and scalar targets consistently across SQL days and immutable whole-period summaries', async () => {
  const athlete = randomUUID();
  const input = draft();
  const base = input.sessions[0];
  if (!base) throw new Error('Missing fixture');
  input.sessions = [
    {
      ...base,
      id: 'range',
      date: '2024-03-08',
      durationSeconds: null,
      distanceMeters: null,
      durationRange: { minSeconds: 10, maxSeconds: 20 },
      distanceRange: { minMeters: 100, maxMeters: 200 },
    },
    { ...base, id: 'scalar', date: '2024-03-09', durationSeconds: 30, distanceMeters: 50 },
    { ...base, id: 'unknown', date: '2024-03-10', durationSeconds: null, distanceMeters: null },
    {
      ...base,
      id: 'range-zero',
      date: '2024-03-10',
      durationSeconds: null,
      distanceMeters: null,
      durationRange: { minSeconds: 0, maxSeconds: 0 },
      distanceRange: { minMeters: 0, maxMeters: 0 },
    },
  ];
  const saved = await savePlan(athlete, input);
  const model = await createDashboardRepository(database).read(athlete, query);
  const targets = {
    definitionVersion: 'planned-targets-v1',
    distanceMeters: { min: 150, max: 250, knownCount: 3, missingCount: 1, rangeCount: 2 },
    durationSeconds: { min: 40, max: 50, knownCount: 3, missingCount: 1, rangeCount: 2 },
  };
  expect(model.current.planned.targets).toEqual(targets);
  expect(model.current.planned.distanceMeters).toEqual({
    value: 50,
    knownCount: 1,
    missingCount: 3,
  });
  expect(model.current.planned.durationSeconds).toEqual({
    value: 30,
    knownCount: 1,
    missingCount: 3,
  });
  expect(model.days[2]?.planned.targets?.durationSeconds).toEqual({
    min: 0,
    max: 0,
    knownCount: 1,
    missingCount: 1,
    rangeCount: 1,
  });
  expect(model.previous.planned.targets?.distanceMeters).toEqual({
    min: null,
    max: null,
    knownCount: 0,
    missingCount: 0,
    rangeCount: 0,
  });
  const period = await createPeriodSummaryRepository(database).read(athlete, {
    planVersionId: saved.id,
    periodId: 'season',
  });
  expect(period?.planned).toEqual(model.current.planned);
  expect(
    (await createDashboardRepository(database).read(randomUUID(), query)).current.planned.targets
      ?.distanceMeters,
  ).toEqual({ min: null, max: null, knownCount: 0, missingCount: 0, rangeCount: 0 });
  expect(model.current.actual.count).toBe(0);
});

it('does not infer range bounds when a legacy daily aggregate lacks target evidence', () => {
  const legacy = emptyPlanned();
  delete legacy.targets;
  const mixed = summarizeDays([
    { date: '2024-03-09', actual: emptyActual(), planned: legacy, checkInCount: 0 },
    { date: '2024-03-10', actual: emptyActual(), planned: emptyPlanned(), checkInCount: 0 },
  ]);
  expect(mixed.planned).not.toHaveProperty('targets');
  expect(mixed.planned.distanceMeters.value).toBeNull();
  expect(summarizeDays([]).planned.targets?.distanceMeters).toEqual({
    min: null,
    max: null,
    knownCount: 0,
    missingCount: 0,
    rangeCount: 0,
  });
});

it('matches SQL decimal day sums and JavaScript period/window target sums for fractional ranges and scalars', async () => {
  const athlete = randomUUID(),
    input = draft(),
    base = input.sessions[0];
  if (!base) throw new Error('Missing fixture');
  input.sessions = [0.1, 0.2].flatMap((value, index) => [
    {
      ...base,
      id: `range-${index}`,
      date: '2024-03-10',
      durationSeconds: null,
      distanceMeters: null,
      durationRange: { minSeconds: value, maxSeconds: value },
      distanceRange: { minMeters: value, maxMeters: value },
    },
    {
      ...base,
      id: `scalar-${index}`,
      date: '2024-03-10',
      durationSeconds: value,
      distanceMeters: value,
    },
  ]);
  const saved = await savePlan(athlete, input);
  const dashboard = await createDashboardRepository(database).read(athlete, query);
  const period = await createPeriodSummaryRepository(database).read(athlete, {
    planVersionId: saved.id,
    periodId: 'season',
  });
  expect(dashboard.days[2]?.planned).toEqual(period?.planned);
  expect(dashboard.current.planned).toEqual(period?.planned);
  expect(period?.planned.distanceMeters.value).toBe(0.3);
  expect(period?.planned.targets?.distanceMeters).toEqual({
    min: 0.6,
    max: 0.6,
    knownCount: 4,
    missingCount: 0,
    rangeCount: 2,
  });
  const plans = createPlanningRepository(database);
  const scalars = {
    ...input,
    sessions: input.sessions.filter((session) => session.id.startsWith('scalar')),
  };
  await plans.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: saved.id,
    idempotencyKey: randomUUID(),
    draft: scalars,
  });
  expect(
    (await createDashboardRepository(database).read(athlete, query)).current.planned.targets
      ?.durationSeconds,
  ).toEqual({ min: 0.3, max: 0.3, knownCount: 2, missingCount: 0, rangeCount: 0 });
});
