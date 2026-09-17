import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createPeriodSummaryRepository } from '../src/period-summary.js';
import { createPlanningRepository } from '../src/planning.js';
import type { ActivityImport } from '@workout/contracts/activity';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let repository: ActivityRepository;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,outbox,command_receipt,plan_snapshot,plan_head,plan_history TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
  repository = createActivityRepository(database);
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

async function seed(athlete: string, startDate = '2026-01-01', endDateExclusive = '2027-01-01') {
  return createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      title: 'Period summary',
      timezone: 'America/New_York',
      periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
        id: level,
        parentId: index === 0 ? null : (levels[index - 1] ?? null),
        level,
        title: level,
        startDate,
        endDateExclusive,
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'high',
          blockId: 'block',
          date: startDate,
          localStartTime: null,
          title: 'Key',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: 0,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'high',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
        {
          id: 'normal',
          blockId: 'block',
          date: startDate,
          localStartTime: null,
          title: 'Other',
          sport: 'running',
          durationSeconds: 0,
          distanceMeters: null,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
}
function command(startedAt: string | null): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: null,
      kind: 'running',
      startedAt,
      timezone: null,
      durationSeconds: 0,
      durationKind: 'timer',
      distanceMeters: null,
    },
  };
}
describe('owned immutable period summaries', () => {
  it('covers a full year, descendants once, null/zero, exact owned old version and no plan-link dependency', async () => {
    const athlete = randomUUID();
    const saved = await seed(athlete);
    await repository.importActivity(athlete, command('2026-07-01T12:00:00Z'));
    await repository.importActivity(athlete, command(null));
    const later = await createPlanningRepository(database).save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: saved.id,
      idempotencyKey: randomUUID(),
      draft: { ...saved.draft, title: 'New', sessions: [] },
    });
    const reader = createPeriodSummaryRepository(database);
    const result = await reader.read(athlete, {
      planVersionId: saved.id.toUpperCase(),
      periodId: 'season',
    });
    expect(result?.currentPlanVersionId).toBe(later.id);
    expect(result?.planned).toEqual({
      count: 2,
      distanceMeters: { value: 0, knownCount: 1, missingCount: 1 },
      durationSeconds: { value: 0, knownCount: 1, missingCount: 1 },
    });
    expect(result?.keySessions.map((session) => session.id)).toEqual(['high']);
    expect(result?.unplacedActivityCount).toBe(1);
    expect(result?.actual).toMatchObject({
      status: 'available',
      totals: {
        count: 1,
        distanceMeters: { value: null, knownCount: 0, missingCount: 1 },
        durationSeconds: { timer: { value: 0, knownCount: 1, missingCount: 0 } },
        sources: { fixture: 1 },
      },
    });
    expect(
      await reader.read(randomUUID(), { planVersionId: saved.id, periodId: 'season' }),
    ).toBeNull();
    expect(
      await reader.read(athlete, { planVersionId: randomUUID(), periodId: 'season' }),
    ).toBeNull();
    expect(await reader.read(athlete, { planVersionId: saved.id, periodId: 'missing' })).toBeNull();
  });
  it('projects effective start across DST, excludes the end boundary, and retains tombstone revisions', async () => {
    const athlete = randomUUID();
    const saved = await seed(athlete, '2026-03-08', '2026-03-09');
    const included = await repository.importActivity(athlete, {
      ...command('2026-03-09T03:59:59Z'),
      activity: {
        ...command(null).activity,
        startedAt: '2026-03-09T03:59:59Z',
        distanceMeters: 0,
        durationKind: 'elapsed',
      },
    });
    await repository.importActivity(athlete, command('2026-03-09T04:00:00Z'));
    await repository.importActivity(athlete, command('2026-03-08T04:59:59Z'));
    const moved = await repository.importActivity(athlete, command('2026-03-09T04:00:00Z'));
    await repository.updateOverlay(athlete, moved.activityId, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'Time correction',
      startedAt: '2026-03-08T05:00:00Z',
      timezone: 'America/New_York',
      distanceMeters: 10,
    });
    const reader = createPeriodSummaryRepository(database),
      query = { planVersionId: saved.id, periodId: 'block' };
    const before = await reader.read(athlete, query);
    expect(before?.actual).toMatchObject({
      status: 'available',
      totals: {
        count: 2,
        distanceMeters: { value: 10 },
        durationSeconds: { elapsed: { knownCount: 1 }, timer: { knownCount: 1 } },
        overlayCount: 1,
      },
    });
    await repository.deleteActivity(athlete, included.activityId, { expectedRevision: 1 });
    const after = await reader.read(athlete, query);
    expect(after?.actual).toMatchObject({
      status: 'available',
      totals: { count: 1, distanceMeters: { value: 10 } },
    });
    expect(after?.dataRevision.activities).toEqual({ count: 4, revisionSum: '6' });
    await repository.updateOverlay(athlete, moved.activityId, {
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      reason: 'Start observation unavailable',
      startedAt: null,
      timezone: null,
    });
    const unplaced = await reader.read(athlete, query);
    expect(unplaced?.unplacedActivityCount).toBe(1);
    expect(unplaced?.actual).toMatchObject({
      status: 'available',
      totals: { count: 0, distanceMeters: { value: null, knownCount: 0, missingCount: 0 } },
    });
    expect(unplaced?.dataRevision.activities).toEqual({ count: 4, revisionSum: '7' });
  });
  it('reports unsupported year-zero periods without a database cast error', async () => {
    const athlete = randomUUID();
    const saved = await seed(athlete, '0000-01-01', '0000-02-01');
    await repository.importActivity(athlete, command('0000-01-02T00:00:00Z'));
    expect(
      (
        await createPeriodSummaryRepository(database).read(athlete, {
          planVersionId: saved.id,
          periodId: 'season',
        })
      )?.actual,
    ).toEqual({ status: 'unavailable', reason: 'unsupported_calendar' });
  });
  it('observes canonical counts and aggregates from one snapshot while imports race reads', async () => {
    const athlete = randomUUID();
    const saved = await seed(athlete);
    const reader = createPeriodSummaryRepository(database);
    const writes = Promise.all(
      Array.from({ length: 8 }, () =>
        repository.importActivity(athlete, command('2026-06-01T12:00:00Z')),
      ),
    );
    const reads = await Promise.all(
      Array.from({ length: 8 }, () =>
        reader.read(athlete, { planVersionId: saved.id, periodId: 'season' }),
      ),
    );
    await writes;
    for (const result of reads) {
      expect(result?.actual.status).toBe('available');
      if (result?.actual.status === 'available') {
        expect(result.actual.totals.count).toBe(result.dataRevision.activities.count);
        expect(result.dataRevision.activities.revisionSum).toBe(String(result.actual.totals.count));
      }
    }
  });
});
