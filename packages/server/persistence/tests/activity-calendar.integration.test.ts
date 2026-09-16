import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations, grantCheckIns } from '../src/migrate.js';
import { createActivityRepository } from '../src/activities.js';
import { createDashboardRepository } from '../src/dashboard.js';
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
    'GRANT SELECT,INSERT,UPDATE,DELETE ON plan_head,plan_snapshot,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,command_receipt,outbox TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
async function add(athlete: string, startedAt: string | null, distanceMeters = 1) {
  return createActivityRepository(database).importActivity(athlete, {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Calendar fixture',
      kind: 'running',
      startedAt,
      timezone: 'UTC',
      durationSeconds: null,
      durationKind: 'unknown',
      distanceMeters,
    },
  });
}
it('preserves year-zero leap days, offsets and raw values while sorting equal instants by ID', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database);
  const leap = await add(athlete, '0000-02-29T12:34:56.123456+09:00');
  const march = await add(athlete, '0000-03-01T00:00:00+09:00');
  const before = await add(athlete, '0001-01-01T00:30:00+01:00');
  const crossing = await add(athlete, '0000-12-31T23:30:00-01:00');
  const equal = await add(athlete, '0001-01-01T00:30:00Z');
  const modern = await add(athlete, '2026-01-01T00:00:00Z');
  const unknown = await add(athlete, null);
  const ties = [crossing.activityId, equal.activityId].sort();
  const ascending = [
    leap.activityId,
    march.activityId,
    before.activityId,
    ...ties,
    modern.activityId,
    unknown.activityId,
  ];
  expect(
    (await repo.listActivities(athlete, { sort: 'started_asc' })).items.map((item) => item.id),
  ).toEqual(ascending);
  expect(
    (await repo.listActivities(athlete, { sort: 'started_desc' })).items.map((item) => item.id),
  ).toEqual([
    modern.activityId,
    ...ties,
    before.activityId,
    march.activityId,
    leap.activityId,
    unknown.activityId,
  ]);
  const page = await repo.listActivities(athlete, { sort: 'started_asc', limit: 2, offset: 3 });
  expect(page.total).toBe(7);
  expect(page.items.map((item) => item.id)).toEqual(ties);
  const original = await repo.getActivity(athlete, leap.activityId);
  expect(original?.original.startedAt).toBe('0000-02-29T12:34:56.123456+09:00');
  expect(original?.effective.startedAt).toBe(original?.original.startedAt);
});
it('filters AD date boundaries after preserving offset and IANA historical timezone projection', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database);
  const before = await add(athlete, '0001-01-01T00:30:00+01:00');
  const crossed = await add(athlete, '0000-12-31T23:30:00-01:00');
  const later = await add(athlete, '0001-01-01T06:00:00Z');
  await add(athlete, null);
  const query = { from: '0001-01-01', toExclusive: '0001-01-02', sort: 'started_asc' as const };
  expect(
    (await repo.listActivities(athlete, { ...query, timezone: 'UTC' })).items.map(
      (item) => item.id,
    ),
  ).toEqual([crossed.activityId, later.activityId]);
  expect(
    (await repo.listActivities(athlete, { ...query, timezone: 'Asia/Seoul' })).items.map(
      (item) => item.id,
    ),
  ).toEqual([before.activityId, crossed.activityId, later.activityId]);
  expect(
    (await repo.listActivities(athlete, { ...query, timezone: 'America/New_York' })).items.map(
      (item) => item.id,
    ),
  ).toEqual([later.activityId]);
});
it('uses corrected or explicitly cleared start times without rewriting a legacy original', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    created = await add(athlete, '0000-02-29T00:00:00Z');
  await repo.updateOverlay(athlete, created.activityId, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Correct source calendar',
    startedAt: '2026-01-01T00:00:00Z',
    timezone: 'UTC',
  });
  expect(
    (
      await repo.listActivities(athlete, {
        from: '2026-01-01',
        toExclusive: '2026-01-02',
        timezone: 'UTC',
      })
    ).total,
  ).toBe(1);
  expect((await repo.getActivity(athlete, created.activityId))?.original.startedAt).toBe(
    '0000-02-29T00:00:00Z',
  );
  expect(
    (
      await createDashboardRepository(database).read(athlete, {
        anchor: '2026-01-01',
        window: 3,
        timezone: 'UTC',
      })
    ).current.actual.count,
  ).toBe(1);
  await repo.updateOverlay(athlete, created.activityId, {
    idempotencyKey: randomUUID(),
    expectedRevision: 2,
    reason: 'Unknown start',
    startedAt: null,
    timezone: null,
  });
  expect((await repo.listActivities(athlete)).items[0]?.effective.startedAt).toBeNull();
  const dashboard = await createDashboardRepository(database).read(athlete, {
    anchor: '2026-01-01',
    window: 3,
    timezone: 'UTC',
  });
  expect(dashboard.current.actual.count).toBe(0);
  expect(dashboard.unplacedActivityCount).toBe(1);
});
it('aggregates an AD boundary-crossing year-zero instant without classifying ancient observations as missing', async () => {
  const athlete = randomUUID();
  await add(athlete, '0000-02-29T00:00:00Z', 100);
  await add(athlete, '0001-01-01T00:30:00+01:00', 200);
  await add(athlete, '0000-12-31T23:30:00-01:00', 0);
  await add(athlete, '0001-01-02T00:00:00Z', 5);
  await add(athlete, null, 999);
  // Six valid AD dates cover previous/current windows: Jan1 belongs to previous.
  const model = await createDashboardRepository(database).read(athlete, {
    anchor: '0001-01-06',
    window: 3,
    timezone: 'UTC',
  });
  expect(model.previous.actual.count).toBe(2);
  expect(model.previous.actual.distanceMeters).toEqual({
    value: 5,
    knownCount: 2,
    missingCount: 0,
  });
  expect(model.current.actual.count).toBe(0);
  expect(model.unplacedActivityCount).toBe(1);
  expect(model.dataRevision.activities).toEqual({ count: 5, revisionSum: '5' });
  const modern = await createDashboardRepository(database).read(athlete, {
    anchor: '2026-01-06',
    window: 3,
    timezone: 'UTC',
  });
  expect(modern.current.actual.count).toBe(0);
  expect(modern.unplacedActivityCount).toBe(1);
});
