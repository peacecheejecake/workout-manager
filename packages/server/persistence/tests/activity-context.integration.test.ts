import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createActivityRepository } from '../src/activities.js';
import { createPlanningRepository } from '../src/planning.js';
import { createActivityContextRepository } from '../src/activity-context.js';
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
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
function draft(): PlanDraft {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    title: 'Original linked plan',
    timezone: 'America/New_York',
    periods: levels.map((level, i) => ({
      id: level,
      parentId: i === 0 ? null : (levels[i - 1] ?? null),
      level,
      title: level,
      startDate: '2024-03-10',
      endDateExclusive: '2024-03-11',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'planned',
        blockId: 'block',
        date: '2024-03-10',
        localStartTime: null,
        title: 'Planned run',
        sport: 'running',
        durationSeconds: 100,
        distanceMeters: 50,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
}
async function plan(athlete: string) {
  return createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
}
async function actual(
  athlete: string,
  planVersionId: string | null,
  startedAt = '2024-03-10T05:00:00Z',
  distanceMeters: number | null = 0,
) {
  return createActivityRepository(database).createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Actual',
      kind: 'running',
      startedAt,
      timezone: 'UTC',
      distanceMeters,
      durationSeconds: 10,
      durationKind: 'timer',
    },
    report: {
      sessionRpe: null,
      note: null,
      planLink: planVersionId ? { planVersionId, sessionId: 'planned' } : null,
    },
  });
}
it('does not infer links and hides foreign or deleted activities', async () => {
  const athlete = randomUUID();
  await plan(athlete);
  const created = await actual(athlete, null);
  const repository = createActivityContextRepository(database);
  expect((await repository.read(athlete, created.activityId))?.planContext).toEqual({
    status: 'unlinked',
  });
  expect(await repository.read(randomUUID(), created.activityId)).toBeNull();
  await createActivityRepository(database).deleteActivity(athlete, created.activityId, {
    expectedRevision: 1,
  });
  expect(await repository.read(athlete, created.activityId)).toBeNull();
});
it('resolves immutable old plan even when current head changes and preserves zero/null comparisons', async () => {
  const athlete = randomUUID(),
    linked = await plan(athlete),
    created = await actual(athlete, linked.id);
  const plans = createPlanningRepository(database);
  const next = await plans.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: linked.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'New head' },
  });
  const context = await createActivityContextRepository(database).read(athlete, created.activityId);
  expect(context?.planContext).toMatchObject({
    status: 'linked',
    planVersion: { id: linked.id, title: 'Original linked plan' },
    currentPlanVersionId: next.id,
    blockMembership: 'included',
    actualLocalDate: '2024-03-10',
    distanceComparison: { actual: 0, planned: 50, delta: -50, status: 'available' },
    durationComparison: {
      actual: 10,
      actualKind: 'timer',
      planned: 100,
      delta: null,
      status: 'not_comparable',
    },
    blockActual: { count: 1, overlayCount: 0, sources: { manual: 1 } },
  });
  await createActivityRepository(database).updateOverlay(athlete, created.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Unknown distance',
    distanceMeters: null,
  });
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toMatchObject({
    distanceComparison: { actual: null, planned: 50, delta: null, status: 'missing_actual' },
    blockActual: { distanceMeters: { value: null, knownCount: 0, missingCount: 1 } },
  });
});
it('computes partial block actuals over DST boundaries, excluding out-of-period and deleted data', async () => {
  const athlete = randomUUID(),
    linked = await plan(athlete),
    created = await actual(athlete, linked.id);
  await actual(athlete, null, '2024-03-11T03:59:59Z', 20);
  await actual(athlete, null, '2024-03-10T04:59:59Z', 100);
  await actual(athlete, null, '2024-03-11T04:00:00Z', 200);
  const deleted = await actual(athlete, null, '2024-03-10T12:00:00Z', 300);
  await createActivityRepository(database).deleteActivity(athlete, deleted.activityId, {
    expectedRevision: 1,
  });
  const context = await createActivityContextRepository(database).read(athlete, created.activityId);
  expect(context?.activityDataRevision).toEqual({ count: 5, revisionSum: '6' });
  expect(context?.planContext).toMatchObject({
    blockActual: {
      count: 2,
      distanceMeters: { value: 20, knownCount: 2, missingCount: 0 },
      durationSeconds: { timer: { value: 20, knownCount: 2, missingCount: 0 } },
    },
    coverage: 'unknown',
  });
  const activities = createActivityRepository(database);
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Move actual outside Block',
    startedAt: '2024-03-11T04:00:00Z',
    timezone: 'UTC',
  });
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toMatchObject({ blockMembership: 'outside', blockActual: { count: 1 } });
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    reason: 'Unknown start',
    startedAt: null,
    timezone: null,
  });
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toMatchObject({ blockMembership: 'unknown_time', actualLocalDate: null });
});
it('hides foreign or missing stored links and rejects corrupt report data at the storage boundary', async () => {
  const athlete = randomUUID(),
    foreign = await plan(randomUUID()),
    created = await actual(athlete, null);
  async function corrupt(planVersionId: string, sessionId: string) {
    await database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE activity_overlay SET values_json=jsonb_set(values_json,'{userReport,planLink}',$3::jsonb) WHERE athlete_id=$1 AND activity_id=$2",
        [athlete, created.activityId, JSON.stringify({ planVersionId, sessionId })],
      ),
    );
  }
  await corrupt(foreign.id, 'planned');
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toEqual({ status: 'unavailable', reason: 'linked_plan_unavailable' });
  await corrupt('not-a-uuid', 'planned');
  // Impossible through the command schema: do not silently rewrite a corrupt stored report.
  await expect(
    createActivityContextRepository(database).read(athlete, created.activityId),
  ).rejects.toMatchObject({ name: 'ZodError' });
  const owned = await plan(athlete);
  await corrupt(owned.id, 'missing');
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))?.planContext
      .status,
  ).toBe('unavailable');
});
it('keeps activity, block aggregate and revision metadata in one snapshot across a concurrent deletion', async () => {
  const athlete = randomUUID(),
    linked = await plan(athlete),
    created = await actual(athlete, linked.id);
  let reads = 0;
  const wrapped: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: async (sql, args) => {
            reads++;
            const result = await tx.query(sql, args);
            await createActivityRepository(database).deleteActivity(athlete, created.activityId, {
              expectedRevision: 1,
            });
            return result;
          },
        }),
      ),
  };
  const old = await createActivityContextRepository(wrapped).read(athlete, created.activityId);
  expect(reads).toBe(1);
  expect(old?.activity.revision).toBe(1);
  expect(old?.activityDataRevision).toEqual({ count: 1, revisionSum: '1' });
  expect(old?.planContext).toMatchObject({ blockActual: { count: 1 } });
  expect(
    await createActivityContextRepository(database).read(athlete, created.activityId),
  ).toBeNull();
});

it('does not compare unlike duration kinds or replace missing planned distance with zero', async () => {
  const athlete = randomUUID(),
    value = draft();
  value.sessions = value.sessions.map((session) => ({ ...session, distanceMeters: null }));
  const linked = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: value,
  });
  const created = await actual(athlete, linked.id),
    other = await actual(athlete, null);
  await createActivityRepository(database).updateOverlay(athlete, other.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Elapsed definition',
    durationSeconds: 20,
    durationKind: 'elapsed',
  });
  const context = await createActivityContextRepository(database).read(athlete, created.activityId);
  expect(context?.planContext).toMatchObject({
    distanceComparison: { actual: 0, planned: null, delta: null, status: 'missing_plan' },
    blockActual: {
      durationSeconds: {
        timer: { value: 10, knownCount: 1 },
        elapsed: { value: 20, knownCount: 1 },
        moving: { value: null, knownCount: 0 },
      },
    },
  });
  await createActivityRepository(database).updateOverlay(athlete, created.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Unknown distance',
    distanceMeters: null,
  });
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toMatchObject({ distanceComparison: { status: 'missing_both', delta: null } });
});

it('reports unsupported legacy year-zero activity and linked plan calendars without casting them as PostgreSQL dates', async () => {
  const athlete = randomUUID(),
    linked = await plan(athlete),
    created = await actual(athlete, linked.id);
  await createActivityRepository(database).importActivity(athlete, {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Legacy',
      kind: 'unknown',
      startedAt: '0000-01-01T00:00:00Z',
      timezone: 'UTC',
      distanceMeters: null,
      durationSeconds: null,
      durationKind: 'unknown',
    },
  });
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toEqual({ status: 'unavailable', reason: 'unsupported_calendar' });
  const second = randomUUID(),
    value = draft();
  value.periods = value.periods.map((period) => ({
    ...period,
    startDate: '0000-01-01',
    endDateExclusive: '0001-01-01',
  }));
  value.sessions = value.sessions.map((session) => ({ ...session, date: '0000-01-01' }));
  const ancient = await createPlanningRepository(database).save(second, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: value,
  });
  const observation = await actual(second, ancient.id);
  expect(
    (await createActivityContextRepository(database).read(second, observation.activityId))
      ?.planContext,
  ).toEqual({ status: 'unavailable', reason: 'unsupported_calendar' });
});

it('resolves an explicitly linked uppercase UUID without casting malformed strings', async () => {
  const athlete = randomUUID(),
    linked = await plan(athlete),
    created = await actual(athlete, linked.id.toUpperCase());
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toMatchObject({ status: 'linked', planVersion: { id: linked.id } });
});

it('rejects a supported UTC year whose linked timezone projection crosses into BCE', async () => {
  const athlete = randomUUID(),
    linked = await plan(athlete),
    created = await actual(athlete, linked.id, '0001-01-01T00:00:00Z');
  expect(
    (await createActivityContextRepository(database).read(athlete, created.activityId))
      ?.planContext,
  ).toEqual({ status: 'unavailable', reason: 'unsupported_calendar' });
});
