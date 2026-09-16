import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
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
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
function draft(): PlanDraft {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    title: 'Explicit links',
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
        title: 'Session',
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
}
async function plan(athlete: string, previous: string | null = null) {
  return createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: previous,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
}
async function actual(athlete: string, version: string | null, startedAt = '2024-01-01T12:00:00Z') {
  return createActivityRepository(database).createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Actual',
      kind: 'running',
      startedAt,
      timezone: 'UTC',
      distanceMeters: 0,
      durationSeconds: null,
      durationKind: 'unknown',
    },
    report: {
      sessionRpe: null,
      note: null,
      planLink: version ? { planVersionId: version, sessionId: 'planned' } : null,
    },
  });
}
it('filters immutable explicit version/block links, never current-head or date-inferred membership', async () => {
  const athlete = randomUUID(),
    old = await plan(athlete),
    linked = await actual(athlete, old.id.toUpperCase());
  await actual(athlete, null);
  const current = await plan(athlete, old.id);
  await actual(athlete, current.id);
  const repository = createActivityRepository(database);
  const filter = { linkedPlanVersionId: old.id.toUpperCase(), linkedBlockId: 'block' };
  const result = await repository.listActivities(athlete, filter);
  expect(result.total).toBe(1);
  expect(result.items[0]?.id).toBe(linked.activityId);
  expect(
    (
      await repository.listActivities(athlete, {
        linkedPlanVersionId: current.id,
        linkedBlockId: 'block',
      })
    ).total,
  ).toBe(1);
  expect(
    (await repository.listActivities(athlete, { ...filter, linkedBlockId: 'season' })).total,
  ).toBe(0);
  expect(
    (await repository.listActivities(athlete, { ...filter, linkedBlockId: 'missing' })).total,
  ).toBe(0);
});
it('includes linked outside-period and unknown-time actuals until a separate date filter excludes them', async () => {
  const athlete = randomUUID(),
    owned = await plan(athlete),
    repository = createActivityRepository(database);
  const inside = await actual(athlete, owned.id),
    outside = await actual(athlete, owned.id, '2024-03-01T00:00:00Z'),
    unknown = await actual(athlete, owned.id);
  await repository.updateOverlay(athlete, unknown.activityId, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Unknown start',
    startedAt: null,
    timezone: null,
  });
  const filter = { linkedPlanVersionId: owned.id, linkedBlockId: 'block' };
  expect(
    (await repository.listActivities(athlete, filter)).items.map((item) => item.id).sort(),
  ).toEqual([inside.activityId, outside.activityId, unknown.activityId].sort());
  const dated = await repository.listActivities(athlete, {
    ...filter,
    from: '2024-01-01',
    toExclusive: '2024-02-01',
    timezone: 'UTC',
  });
  expect(dated.total).toBe(1);
  expect(dated.items[0]?.id).toBe(inside.activityId);
});
it('reflects link replacement, clearing and deletion while preserving filtered page counts and stable ties', async () => {
  const athlete = randomUUID(),
    old = await plan(athlete),
    repository = createActivityRepository(database);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await actual(athlete, old.id)).activityId);
  const filter = {
    linkedPlanVersionId: old.id,
    linkedBlockId: 'block',
    sort: 'started_asc' as const,
  };
  const first = await repository.listActivities(athlete, { ...filter, limit: 1 }),
    second = await repository.listActivities(athlete, { ...filter, limit: 2, offset: 1 });
  expect(first.total).toBe(3);
  expect(second.total).toBe(3);
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual([...ids].sort());
  expect(await repository.listActivities(athlete, { ...filter, offset: 99 })).toEqual({
    items: [],
    total: 3,
  });
  const [a, b, c] = ids;
  if (!a || !b || !c) throw new Error('Missing fixtures');
  const next = await plan(athlete, old.id);
  await repository.updateOverlay(athlete, a, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Change explicit link',
    report: {
      sessionRpe: null,
      note: null,
      planLink: { planVersionId: next.id, sessionId: 'planned' },
    },
  });
  await repository.updateOverlay(athlete, b, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Clear explicit link',
    report: { sessionRpe: null, note: null, planLink: null },
  });
  await repository.deleteActivity(athlete, c, { expectedRevision: 1 });
  expect((await repository.listActivities(athlete, filter)).total).toBe(0);
  expect(
    (
      await repository.listActivities(athlete, { ...filter, linkedPlanVersionId: next.id })
    ).items.map((item) => item.id),
  ).toEqual([a]);
});
it('does not expose foreign versions, missing sessions or malformed stored link IDs', async () => {
  const athlete = randomUUID(),
    foreign = await plan(randomUUID()),
    repository = createActivityRepository(database),
    created = await actual(athlete, null);
  const owned = await plan(athlete);
  const corrupt = async (version: string, session = 'planned') =>
    database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE activity_overlay SET values_json=jsonb_set(values_json,'{userReport,planLink}',$3::jsonb) WHERE athlete_id=$1 AND activity_id=$2",
        [
          athlete,
          created.activityId,
          JSON.stringify({ planVersionId: version, sessionId: session }),
        ],
      ),
    );
  await corrupt(foreign.id);
  expect(
    (
      await repository.listActivities(athlete, {
        linkedPlanVersionId: foreign.id,
        linkedBlockId: 'block',
      })
    ).total,
  ).toBe(0);
  await corrupt(owned.id, 'missing');
  expect(
    (
      await repository.listActivities(athlete, {
        linkedPlanVersionId: owned.id,
        linkedBlockId: 'block',
      })
    ).total,
  ).toBe(0);
  await corrupt('not-a-uuid');
  expect(
    (
      await repository.listActivities(athlete, {
        linkedPlanVersionId: owned.id,
        linkedBlockId: 'block',
      })
    ).total,
  ).toBe(0);
  await corrupt(owned.id);
  expect(
    (
      await repository.listActivities(randomUUID(), {
        linkedPlanVersionId: owned.id,
        linkedBlockId: 'block',
      })
    ).total,
  ).toBe(0);
});
