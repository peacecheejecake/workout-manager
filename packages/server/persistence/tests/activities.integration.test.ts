import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import type { ActivityImport, ManualActivityCreate } from '@workout/contracts/activity';

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
function input(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Fixture run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'Asia/Seoul',
      distanceMeters: 0,
    },
  };
}
describe('M1-03 canonical activity transactional ingestion', () => {
  it('advances the integrated activity dependency head across delete and replacement', async () => {
    const athlete = randomUUID();
    const first = await repository.importActivity(athlete, input());
    await repository.deleteActivity(athlete, first.activityId, { expectedRevision: 1 });
    await repository.importActivity(athlete, input());
    const head = await database.tenant(athlete, (tx) =>
      tx.query('SELECT activity_revision FROM integrated_dependency_head WHERE athlete_id=$1', [
        athlete,
      ]),
    );
    expect(head.rows[0]?.['activity_revision']).toBe(3);
  });
  it('concurrent duplicate deliveries and outbox replay apply exactly one canonical and event', async () => {
    const athlete = randomUUID();
    const command = input();
    const results = await Promise.all([
      repository.importActivity(athlete, command),
      repository.importActivity(athlete, command),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await repository.importActivity(athlete, command)).toEqual(results[0]);
    expect((await repository.listActivities(athlete)).total).toBe(1);
    const counts = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM activity_source_revision) AS raw,(SELECT count(*)::int FROM outbox) AS events',
      ),
    );
    expect(counts.rows[0]).toEqual({ raw: 1, events: 1 });
    expect(await repository.summary(athlete)).toEqual({
      count: 1,
      distanceMeters: { value: 0, knownCount: 1 },
      durationSeconds: {
        value: null,
        knownCount: 0,
        byKind: {
          timer: { value: null, knownCount: 0 },
          elapsed: { value: null, knownCount: 0 },
          moving: { value: null, knownCount: 0 },
          unknown: { value: null, knownCount: 0 },
        },
      },
    });
  });
  it('keeps source revision history and user corrections across reordered imports', async () => {
    const athlete = randomUUID();
    const command = input();
    const initial = await repository.importActivity(athlete, command);
    const correction = {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'GPS correction',
      title: 'User title',
      distanceMeters: 1234,
    };
    const changed = await repository.updateOverlay(athlete, initial.activityId, correction);
    expect(await repository.updateOverlay(athlete, initial.activityId, correction)).toEqual(
      changed,
    );
    const newer = {
      ...command,
      idempotencyKey: randomUUID(),
      source: { ...command.source, revision: 3, contentHash: 'c'.repeat(64) },
      activity: { ...command.activity, title: 'Provider new title', distanceMeters: 1500 },
    };
    expect((await repository.importActivity(athlete, newer)).revision).toBe(3);
    const stale = {
      ...command,
      idempotencyKey: randomUUID(),
      source: { ...command.source, revision: 2, contentHash: 'b'.repeat(64) },
      activity: { ...command.activity, distanceMeters: 999 },
    };
    expect((await repository.importActivity(athlete, stale)).outcome).toBe('stale');
    const current = await repository.getActivity(athlete, initial.activityId);
    expect(current?.original.distanceMeters).toBe(1500);
    expect(current?.effective.distanceMeters).toBe(1234);
    expect(current?.effective.title).toBe('User title');
    expect(current?.source.revision).toBe(3);
    expect(current?.revision).toBe(3);
    await expect(
      repository.updateOverlay(athlete, initial.activityId, {
        ...correction,
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const raw = await database.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::int AS count FROM activity_source_revision'),
    );
    expect(raw.rows[0]?.['count']).toBe(3);
  });
  it('rejects changed payloads at the same source revision and idempotency key', async () => {
    const athlete = randomUUID();
    const command = input();
    await repository.importActivity(athlete, command);
    await expect(
      repository.importActivity(athlete, {
        ...command,
        activity: { ...command.activity, distanceMeters: 100 },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      repository.importActivity(athlete, {
        ...command,
        idempotencyKey: randomUUID(),
        activity: { ...command.activity, distanceMeters: 100 },
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(
      (await repository.importActivity(athlete, { ...command, idempotencyKey: randomUUID() }))
        .outcome,
    ).toBe('unchanged');
  });
  it('local deletion suppresses future revisions and repeated deletes without resurrection', async () => {
    const athlete = randomUUID();
    const command = input();
    const created = await repository.importActivity(athlete, command);
    await repository.deleteActivity(athlete, created.activityId, { expectedRevision: 1 });
    await repository.deleteActivity(athlete, created.activityId, { expectedRevision: 1 });
    const future = {
      ...command,
      idempotencyKey: randomUUID(),
      source: { ...command.source, revision: 2 },
    };
    expect((await repository.importActivity(athlete, future)).outcome).toBe('suppressed');
    expect(await repository.getActivity(athlete, created.activityId)).toBeNull();
    expect((await repository.listActivities(athlete)).items).toEqual([]);
    expect((await repository.summary(athlete)).count).toBe(0);
    const raw = await database.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::int AS count FROM activity_source_revision'),
    );
    expect(raw.rows[0]?.['count']).toBe(1);
  });
  it('is tenant isolated including raw records, overlays, deletion and independently shared source IDs', async () => {
    const first = randomUUID(),
      second = randomUUID();
    const command = input();
    const created = await repository.importActivity(first, command);
    expect(await repository.getActivity(second, created.activityId)).toBeNull();
    await expect(
      repository.deleteActivity(second, created.activityId, { expectedRevision: 1 }),
    ).rejects.toThrow('ACTIVITY_NOT_FOUND');
    await expect(
      repository.updateOverlay(second, created.activityId, {
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        reason: 'other',
        title: 'bad',
      }),
    ).rejects.toThrow('ACTIVITY_NOT_FOUND');
    expect(
      (await database.tenant(second, (tx) => tx.query('SELECT * FROM activity_source_revision')))
        .rows,
    ).toEqual([]);
    const own = await repository.importActivity(second, command);
    expect(own.activityId).not.toBe(created.activityId);
  });
  it('rolls back canonical, source, receipt and event atomically when outbox enqueue fails', async () => {
    const athlete = randomUUID();
    const command = input();
    const failing = createActivityRepository({
      close: async () => undefined,
      exclusiveTenant: database.exclusiveTenant,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: async (sql, values) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('simulated outbox failure');
              return tx.query(sql, values);
            },
          }),
        ),
    });
    await expect(failing.importActivity(athlete, command)).rejects.toThrow(
      'simulated outbox failure',
    );
    expect((await repository.listActivities(athlete)).total).toBe(0);
    const rows = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM activity_import_receipt) AS receipts,(SELECT count(*)::int FROM activity_source_revision) AS raw',
      ),
    );
    expect(rows.rows[0]).toEqual({ receipts: 0, raw: 0 });
    expect((await repository.importActivity(athlete, command)).outcome).toBe('imported');
  });
  it('does not merge separate workouts with identical bytes and returns bounded stable pages', async () => {
    const athlete = randomUUID();
    const first = input();
    const second = { ...input(), activity: { ...first.activity, distanceMeters: null } };
    await Promise.all([
      repository.importActivity(athlete, first),
      repository.importActivity(athlete, second),
    ]);
    const page1 = await repository.listActivities(athlete, { limit: 1 });
    const page2 = await repository.listActivities(athlete, { limit: 1, offset: 1 });
    expect(page1.total).toBe(2);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.id).not.toBe(page2.items[0]?.id);
    expect(await repository.listActivities(athlete, { offset: 5 })).toEqual({
      total: 2,
      items: [],
    });
    expect((await repository.summary(athlete)).distanceMeters).toEqual({ value: 0, knownCount: 1 });
  });
});

it('serializes competing overlay corrections and retains immutable reasons while null differs from omission', async () => {
  const athlete = randomUUID();
  const created = await repository.importActivity(athlete, input());
  const command = {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Unknown sensor distance',
    distanceMeters: null,
  };
  const outcomes = await Promise.allSettled([
    repository.updateOverlay(athlete, created.activityId, command),
    repository.updateOverlay(athlete, created.activityId, {
      ...command,
      idempotencyKey: randomUUID(),
      reason: 'Competing correction',
      distanceMeters: 10,
    }),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const current = await repository.getActivity(athlete, created.activityId);
  expect(current?.revision).toBe(2);
  const corrected = await repository.updateOverlay(athlete, created.activityId, {
    ...command,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    distanceMeters: null,
  });
  expect(corrected.effective.distanceMeters).toBeNull();
  expect(corrected.effective.title).toBe('Fixture run');
  expect(corrected.original.distanceMeters).toBe(0);
  const revisions = await database.tenant(athlete, (tx) =>
    tx.query('SELECT revision, values_json FROM activity_overlay_revision ORDER BY revision'),
  );
  expect(revisions.rows).toHaveLength(2);
  expect(revisions.rows[1]?.['values_json']).toMatchObject({
    reason: 'Unknown sensor distance',
    distanceMeters: null,
  });
  await repository.deleteActivity(athlete, created.activityId, { expectedRevision: 3 });
  expect(await repository.getActivity(athlete, created.activityId)).toBeNull();
});

it('keeps timer and elapsed totals separate instead of silently adding different measurement definitions', async () => {
  const athlete = randomUUID();
  const first = input();
  first.activity.durationSeconds = 60;
  first.activity.durationKind = 'timer';
  const second = input();
  second.activity.durationSeconds = 90;
  second.activity.durationKind = 'elapsed';
  await repository.importActivity(athlete, first);
  expect((await repository.summary(athlete)).durationSeconds.value).toBe(60);
  await repository.importActivity(athlete, second);
  expect((await repository.summary(athlete)).durationSeconds).toMatchObject({
    value: null,
    knownCount: 2,
    byKind: { timer: { value: 60, knownCount: 1 }, elapsed: { value: 90, knownCount: 1 } },
  });
});

it('pins a corrected duration definition across newer source revisions and preserves aggregate semantics', async () => {
  const athlete = randomUUID();
  const command = input();
  command.activity.durationSeconds = 100;
  command.activity.durationKind = 'timer';
  const initial = await repository.importActivity(athlete, command);
  await repository.updateOverlay(athlete, initial.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Corrected timer reading',
    durationSeconds: 80,
    durationKind: 'timer',
  });
  await repository.importActivity(athlete, {
    ...command,
    idempotencyKey: randomUUID(),
    source: { ...command.source, revision: 2, contentHash: 'b'.repeat(64) },
    activity: { ...command.activity, durationSeconds: 140, durationKind: 'elapsed' },
  });
  const current = await repository.getActivity(athlete, initial.activityId);
  expect(current?.original).toMatchObject({ durationSeconds: 140, durationKind: 'elapsed' });
  expect(current?.effective).toMatchObject({ durationSeconds: 80, durationKind: 'timer' });
  expect((await repository.summary(athlete)).durationSeconds).toMatchObject({
    value: 80,
    byKind: { timer: { value: 80, knownCount: 1 }, elapsed: { value: null, knownCount: 0 } },
  });
  const other = input();
  other.activity.durationKind = 'elapsed';
  other.activity.durationSeconds = 50;
  await repository.importActivity(athlete, other);
  expect((await repository.summary(athlete)).durationSeconds).toMatchObject({
    value: null,
    byKind: { timer: { value: 80, knownCount: 1 }, elapsed: { value: 50, knownCount: 1 } },
  });
});

it('combines timezone DST date, kind, source and literal title filters with one filtered total', async () => {
  const athlete = randomUUID();
  async function add(
    startedAt: string | null,
    title: string,
    kind: ActivityImport['activity']['kind'] = 'running',
    source: 'fit' | 'fixture' = 'fit',
  ) {
    const command = input();
    command.activity = { ...command.activity, startedAt, title, kind };
    command.source.kind = source;
    return repository.importActivity(athlete, command);
  }
  const start = await add('2024-03-10T05:00:00Z', 'MiXeD 100%_ effort');
  const end = await add('2024-03-11T03:59:59Z', 'mixed 100%_ effort');
  await add('2024-03-10T04:59:59Z', 'mixed 100%_ effort');
  await add('2024-03-11T04:00:00Z', 'mixed 100%_ effort');
  await add(null, 'mixed 100%_ effort');
  await add('2024-03-10T12:00:00Z', 'mixed 100XX effort');
  await add('2024-03-10T12:00:00Z', 'mixed 100%_ effort', 'cycling');
  await add('2024-03-10T12:00:00Z', 'mixed 100%_ effort', 'running', 'fixture');
  const filter = {
    from: '2024-03-10',
    toExclusive: '2024-03-11',
    timezone: 'America/New_York',
    kind: 'running' as const,
    source: 'fit' as const,
    search: 'MIXED 100%_',
    sort: 'started_asc' as const,
  };
  const result = await repository.listActivities(athlete, filter);
  expect(result.total).toBe(2);
  expect(result.items.map((item) => item.id)).toEqual([start.activityId, end.activityId]);
  expect(await repository.listActivities(athlete, { ...filter, offset: 50 })).toEqual({
    total: 2,
    items: [],
  });
  expect((await repository.listActivities(athlete)).total).toBe(8);
  expect((await repository.listActivities(athlete, { search: "%' OR 1=1 --" })).total).toBe(0);
  expect((await repository.listActivities(randomUUID(), filter)).total).toBe(0);
});

it('sorts effective zero and null distances with nulls last in both directions and finds corrected titles', async () => {
  const athlete = randomUUID();
  const imported = [];
  for (const distanceMeters of [0, 10, 20]) {
    const command = input();
    command.activity.distanceMeters = distanceMeters;
    imported.push(await repository.importActivity(athlete, command));
  }
  const [zero, ten, cleared] = imported;
  if (!zero || !ten || !cleared) throw new Error('Missing fixture');
  await repository.updateOverlay(athlete, cleared.activityId, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Clear unknown distance',
    distanceMeters: null,
    title: 'Corrected 100%_ \\ title',
  });
  const asc = await repository.listActivities(athlete, { sort: 'distance_asc' });
  const desc = await repository.listActivities(athlete, { sort: 'distance_desc' });
  expect(asc.items.map((item) => item.id)).toEqual([
    zero.activityId,
    ten.activityId,
    cleared.activityId,
  ]);
  expect(desc.items.map((item) => item.id)).toEqual([
    ten.activityId,
    zero.activityId,
    cleared.activityId,
  ]);
  expect(asc.items.at(-1)?.effective.distanceMeters).toBeNull();
  expect(
    (await repository.listActivities(athlete, { search: '100%_ \\' })).items.map((item) => item.id),
  ).toEqual([cleared.activityId]);
  expect((await repository.listActivities(athlete, { search: 'Fixture run' })).total).toBe(2);
  await repository.deleteActivity(athlete, cleared.activityId, { expectedRevision: 2 });
  expect((await repository.listActivities(athlete, { search: 'Corrected' })).total).toBe(0);
});

it('keeps stable ID ties across pages and places unknown start times last without date filters', async () => {
  const athlete = randomUUID();
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const command = input();
    command.activity.startedAt = '2024-01-01T00:00:00Z';
    ids.push((await repository.importActivity(athlete, command)).activityId);
  }
  const unknownInput = input();
  unknownInput.activity.startedAt = null;
  const unknown = await repository.importActivity(athlete, unknownInput);
  ids.sort();
  for (const sort of ['started_asc', 'started_desc'] as const) {
    const first = await repository.listActivities(athlete, { sort, limit: 2 });
    const second = await repository.listActivities(athlete, { sort, limit: 2, offset: 2 });
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual([
      ...ids,
      unknown.activityId,
    ]);
  }
  expect(
    (await repository.listActivities(athlete, { sort: 'title_asc' })).items.map((item) => item.id),
  ).toEqual([...ids, unknown.activityId].sort());
  expect((await repository.listActivities(athlete)).items.map((item) => item.id)).toEqual(
    [...ids, unknown.activityId].sort(),
  );
});

function manualInput(): ManualActivityCreate {
  return {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      ...input().activity,
      title: 'User actual',
      startedAt: '2026-01-01T10:00:00Z',
      timezone: 'UTC',
    },
    report: { sessionRpe: null, note: null, planLink: null },
  };
}
it('creates manual actuals atomically once with server provenance and metadata-only replay after deletion', async () => {
  const athlete = randomUUID(),
    command = manualInput();
  command.report = { sessionRpe: 0, note: '건강메모'.repeat(1000), planLink: null };
  const fixed = createActivityRepository(database, { now: () => new Date('2026-01-02T00:00:00Z') });
  const [a, b] = await Promise.all([
    fixed.createManualActivity(athlete, command),
    fixed.createManualActivity(athlete, command),
  ]);
  expect(a).toEqual(b);
  const activity = await repository.getActivity(athlete, a.activityId);
  expect(activity?.source.kind).toBe('manual');
  expect(activity?.userReport).toMatchObject({
    sessionRpe: 0,
    rpeReportedAt: '2026-01-02T00:00:00.000Z',
    source: 'user',
    method: 'self_report',
    definitionVersion: 'activity-report-v1',
  });
  const facts = await database.tenant(athlete, (tx) =>
    tx.query(
      'SELECT (SELECT count(*)::int FROM outbox) AS events,(SELECT count(*)::int FROM activity_overlay_revision) AS history,(SELECT result FROM command_receipt LIMIT 1) AS receipt',
    ),
  );
  expect(facts.rows[0]).toEqual({ events: 1, history: 1, receipt: a });
  await expect(
    repository.createManualActivity(athlete, {
      ...command,
      report: { ...command.report, sessionRpe: 1 },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await repository.deleteActivity(athlete, a.activityId, { expectedRevision: 1 });
  expect(await fixed.createManualActivity(athlete, command)).toEqual(a);
  expect(await repository.getActivity(athlete, a.activityId)).toBeNull();
});
it('preserves RPE timestamp on note correction, stamps changed RPE and clears null without default zero', async () => {
  const athlete = randomUUID();
  let time = new Date('2026-01-02T00:00:00Z');
  const fixed = createActivityRepository(database, { now: () => time });
  const created = await fixed.createManualActivity(athlete, manualInput());
  expect(
    (await fixed.getActivity(athlete, created.activityId))?.userReport?.rpeReportedAt,
  ).toBeNull();
  const correct = (expectedRevision: number, sessionRpe: number | null, note: string | null) =>
    fixed.updateOverlay(athlete, created.activityId, {
      idempotencyKey: randomUUID(),
      expectedRevision,
      reason: 'Self-report correction',
      report: { sessionRpe, note, planLink: null },
    });
  const zero = await correct(1, 0, null);
  time = new Date('2026-01-03T00:00:00Z');
  const note = await correct(2, 0, 'new note');
  expect(note.userReport?.rpeReportedAt).toBe(zero.userReport?.rpeReportedAt);
  const changed = await correct(3, 5, null);
  expect(changed.userReport?.rpeReportedAt).toBe(time.toISOString());
  const cleared = await correct(4, null, null);
  expect(cleared.userReport).toMatchObject({
    sessionRpe: null,
    note: null,
    planLink: null,
    rpeReportedAt: null,
  });
});
it('validates future corrected times and uses effective kind/start in list filters', async () => {
  const athlete = randomUUID(),
    fixed = createActivityRepository(database, { now: () => new Date('2026-01-02T00:00:00Z') });
  const command = manualInput();
  await expect(
    fixed.createManualActivity(athlete, {
      ...command,
      activity: { ...command.activity, startedAt: '2026-01-02T00:05:01Z' },
    }),
  ).rejects.toMatchObject({ code: 'STARTED_AT_IN_FUTURE' });
  const created = await fixed.createManualActivity(athlete, command);
  await expect(
    fixed.updateOverlay(athlete, created.activityId, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      reason: 'future',
      startedAt: '2026-01-02T00:05:01Z',
      timezone: 'UTC',
    }),
  ).rejects.toMatchObject({ code: 'STARTED_AT_IN_FUTURE' });
  await fixed.updateOverlay(athlete, created.activityId, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Correct recorded activity',
    kind: 'cycling',
    startedAt: '2026-01-02T00:00:00Z',
    timezone: 'Asia/Seoul',
  });
  expect(
    (
      await fixed.listActivities(athlete, {
        source: 'manual',
        kind: 'cycling',
        from: '2026-01-02',
        toExclusive: '2026-01-03',
        timezone: 'Asia/Seoul',
      })
    ).total,
  ).toBe(1);
  expect((await fixed.listActivities(athlete, { kind: 'running' })).total).toBe(0);
  await fixed.updateOverlay(athlete, created.activityId, {
    idempotencyKey: randomUUID(),
    expectedRevision: 2,
    reason: 'Unknown observation time',
    startedAt: null,
    timezone: null,
  });
  expect(
    (
      await fixed.listActivities(athlete, {
        from: '2026-01-02',
        toExclusive: '2026-01-03',
        timezone: 'UTC',
      })
    ).total,
  ).toBe(0);
});
it('validates immutable owned plan session links without advancing the plan or duplicating actuals', async () => {
  const athlete = randomUUID(),
    plans = createPlanningRepository(database);
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const draft = {
    title: 'Linked plan',
    timezone: 'UTC',
    periods: levels.map((level, i) => ({
      id: level,
      parentId: i === 0 ? null : (levels[i - 1] ?? null),
      level,
      title: level,
      startDate: '2026-01-01',
      endDateExclusive: '2026-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'planned-session',
        blockId: 'block',
        date: '2026-01-01',
        localStartTime: null,
        title: 'Planned',
        sport: 'running' as const,
        durationSeconds: null,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal' as const,
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const first = await plans.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  const latest = await plans.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: first.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft, title: 'New head' },
  });
  const command = manualInput();
  command.report.planLink = { planVersionId: first.id, sessionId: 'planned-session' };
  const actual = await repository.createManualActivity(athlete, command);
  expect((await repository.getActivity(athlete, actual.activityId))?.userReport?.planLink).toEqual(
    command.report.planLink,
  );
  expect((await plans.read(athlete)).head?.id).toBe(latest.id);
  await expect(
    repository.createManualActivity(randomUUID(), { ...command, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'PLAN_LINK_INVALID' });
  await expect(
    repository.createManualActivity(athlete, {
      ...command,
      idempotencyKey: randomUUID(),
      report: { ...command.report, planLink: { planVersionId: first.id, sessionId: 'missing' } },
    }),
  ).rejects.toMatchObject({ code: 'PLAN_LINK_INVALID' });
  expect((await repository.listActivities(athlete)).total).toBe(1);
});
it('keeps imported user reports and kind/time corrections through newer source revisions and old overlay receipts', async () => {
  const athlete = randomUUID(),
    command = input();
  const created = await repository.importActivity(athlete, command);
  const correction = {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'User report',
    kind: 'walking' as const,
    startedAt: '2026-01-01T00:00:00Z',
    timezone: 'UTC',
    report: { sessionRpe: 0, note: 'confirmed user note', planLink: null },
  };
  const corrected = await repository.updateOverlay(athlete, created.activityId, correction);
  await repository.importActivity(athlete, {
    ...command,
    idempotencyKey: randomUUID(),
    source: { ...command.source, revision: 2, contentHash: 'b'.repeat(64) },
    activity: { ...command.activity, kind: 'cycling' },
  });
  const current = await repository.getActivity(athlete, created.activityId);
  expect(current?.userReport).toEqual(corrected.userReport);
  expect(current?.effective.kind).toBe('walking');
  expect(current?.effective.startedAt).toBe('2026-01-01T00:00:00Z');
  expect(await repository.updateOverlay(athlete, created.activityId, correction)).toEqual(
    corrected,
  );
});
it('rolls back all manual rows and receipt when outbox fails', async () => {
  const athlete = randomUUID();
  const broken: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: (sql, args) => {
            if (sql.includes('INSERT INTO outbox')) throw new Error('manual injected failure');
            return tx.query(sql, args);
          },
        }),
      ),
  };
  await expect(
    createActivityRepository(broken).createManualActivity(athlete, manualInput()),
  ).rejects.toThrow('manual injected failure');
  const counts = await database.tenant(athlete, (tx) =>
    tx.query(
      'SELECT (SELECT count(*)::int FROM activity_canonical) AS actual,(SELECT count(*)::int FROM activity_overlay_revision) AS history,(SELECT count(*)::int FROM command_receipt) AS receipts',
    ),
  );
  expect(counts.rows[0]).toEqual({ actual: 0, history: 0, receipts: 0 });
});

function details(): NonNullable<ActivityImport['details']> {
  return {
    schemaVersion: 1,
    streamIndex: 0,
    sessionIndex: 0,
    startedAt: '2026-09-15T23:00:00Z',
    recordedAt: '2026-09-15T23:02:00Z',
    elapsedSeconds: 120,
    records: [
      { index: 0, timestamp: null, distanceMeters: 0, heartRateBpm: null },
      { index: 1, timestamp: '2026-09-15T23:00:10Z', distanceMeters: null, heartRateBpm: 0 },
    ],
    laps: [
      {
        index: 0,
        startedAt: '2026-09-15T23:00:00Z',
        recordedAt: '2026-09-15T23:02:01Z',
        elapsedSeconds: 120,
        timerSeconds: 100,
        distanceMeters: 0,
        averageHeartRateBpm: null,
        maximumHeartRateBpm: null,
      },
    ],
  };
}
describe('M1-04x source revision activity details', () => {
  it('enriches the same canonical once under concurrent delivery and replays the old summary receipt', async () => {
    const athlete = randomUUID();
    const legacy = input();
    const first = await repository.importActivity(athlete, legacy);
    expect((await repository.getActivityDetails(athlete, first.activityId))?.details).toBeNull();
    const enriched = {
      ...legacy,
      idempotencyKey: randomUUID(),
      source: { ...legacy.source, revision: 2 },
      details: details(),
    };
    const [second, duplicate] = await Promise.all([
      repository.importActivity(athlete, enriched),
      repository.importActivity(athlete, enriched),
    ]);
    expect(second).toEqual(duplicate);
    expect(second).toMatchObject({ activityId: first.activityId, revision: 2 });
    expect(await repository.importActivity(athlete, legacy)).toEqual(first);
    expect(await repository.getActivityDetails(athlete, first.activityId)).toEqual({
      activityId: first.activityId,
      activityRevision: 2,
      source: enriched.source,
      details: enriched.details,
    });
    expect((await repository.listActivities(athlete)).total).toBe(1);
    expect(await repository.getActivity(athlete, first.activityId)).not.toHaveProperty('details');
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM activity_source_revision')).rowCount).toBe(2);
      expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(2);
    });
    await expect(
      repository.importActivity(athlete, {
        ...enriched,
        idempotencyKey: randomUUID(),
        details: { ...details(), elapsedSeconds: 121 },
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      repository.importActivity(athlete, {
        ...enriched,
        idempotencyKey: randomUUID(),
        details: undefined,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('reads exactly the current source revision, never falls back, and keeps source clocks through overlays', async () => {
    const athlete = randomUUID();
    const command = { ...input(), details: details() };
    const first = await repository.importActivity(athlete, command);
    await repository.updateOverlay(athlete, first.activityId, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'Correct local start',
      startedAt: '2026-09-16T09:00:00+09:00',
      timezone: 'Asia/Seoul',
    });
    expect((await repository.getActivityDetails(athlete, first.activityId))?.details).toEqual(
      command.details,
    );
    const noDetails = input();
    const third = {
      ...noDetails,
      source: { ...command.source, revision: 3 },
      activity: command.activity,
    };
    await repository.importActivity(athlete, third);
    expect((await repository.getActivityDetails(athlete, first.activityId))?.details).toBeNull();
    expect(
      (
        await repository.importActivity(athlete, {
          ...command,
          idempotencyKey: randomUUID(),
          source: { ...command.source, revision: 2 },
        })
      ).outcome,
    ).toBe('stale');
    expect((await repository.getActivityDetails(athlete, first.activityId))?.source.revision).toBe(
      3,
    );
    expect((await repository.getActivityDetails(athlete, first.activityId))?.details).toBeNull();
    expect((await repository.getActivity(athlete, first.activityId))?.effective.startedAt).toBe(
      '2026-09-16T09:00:00+09:00',
    );
    expect(await repository.getActivityDetails(randomUUID(), first.activityId)).toBeNull();
  });
  it('hides deleted details and suppresses later enrichment without rewriting source history', async () => {
    const athlete = randomUUID();
    const command = { ...input(), details: details() };
    const first = await repository.importActivity(athlete, command);
    await repository.deleteActivity(athlete, first.activityId, { expectedRevision: 1 });
    expect(await repository.getActivityDetails(athlete, first.activityId)).toBeNull();
    expect(await repository.importActivity(athlete, command)).toEqual(first);
    expect(
      (
        await repository.importActivity(athlete, {
          ...command,
          idempotencyKey: randomUUID(),
          source: { ...command.source, revision: 2 },
        })
      ).outcome,
    ).toBe('suppressed');
    expect(await repository.getActivityDetails(athlete, first.activityId)).toBeNull();
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT details_json FROM activity_source_revision')).rows).toEqual([
        { details_json: details() },
      ]);
    });
  });
});

it('rolls back source detail enrichment and its head when outbox delivery cannot be enqueued', async () => {
  const athlete = randomUUID();
  const legacy = input();
  const first = await repository.importActivity(athlete, legacy);
  const before = await repository.getActivity(athlete, first.activityId);
  const enrichment = {
    ...legacy,
    idempotencyKey: randomUUID(),
    source: { ...legacy.source, revision: 2 },
    details: details(),
  };
  const failing = createActivityRepository({
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: (sql, args) => {
            if (sql.includes('INSERT INTO outbox'))
              throw new Error('detail enrichment outbox failure');
            return tx.query(sql, args);
          },
        }),
      ),
  });
  await expect(failing.importActivity(athlete, enrichment)).rejects.toThrow(
    'detail enrichment outbox failure',
  );
  expect(await repository.getActivity(athlete, first.activityId)).toEqual(before);
  expect(await repository.getActivityDetails(athlete, first.activityId)).toEqual({
    activityId: first.activityId,
    activityRevision: 1,
    source: legacy.source,
    details: null,
  });
  await database.tenant(athlete, async (tx) => {
    expect(
      (await tx.query('SELECT source_revision,details_json FROM activity_source_revision')).rows,
    ).toEqual([{ source_revision: 1, details_json: null }]);
    expect((await tx.query('SELECT * FROM activity_import_receipt')).rowCount).toBe(1);
    expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(1);
  });
  expect((await repository.importActivity(athlete, enrichment)).revision).toBe(2);
});

/**
 * P8-contract-parser (map plan §8): "구버전 상세 replay 동일" and "날짜 경계". Details written in
 * an older schema version are read back and replayed exactly as they were written — never
 * upgraded, never re-rendered — including instants that sit on a UTC midnight, a local
 * midnight in another offset, a year end and a leap day (M2-01k-g).
 */
describe('M2-01k-g old-version detail replay across date boundaries', () => {
  const boundaryRecords = [
    { index: 0, timestamp: '2027-12-31T23:59:59Z', distanceMeters: 0, heartRateBpm: 120 },
    { index: 1, timestamp: '2028-01-01T09:00:00+09:00', distanceMeters: 3.5, heartRateBpm: null },
    { index: 2, timestamp: '2027-12-31T19:00:01.250-05:00', distanceMeters: null, heartRateBpm: 0 },
    { index: 3, timestamp: '2028-02-29T23:59:59.999Z', distanceMeters: 7, heartRateBpm: 121 },
    { index: 4, timestamp: null, distanceMeters: 0, heartRateBpm: null },
  ];
  const boundaryLaps = [
    {
      index: 0,
      startedAt: '2028-01-01T08:59:59+09:00',
      recordedAt: '2028-01-01T00:00:02Z',
      elapsedSeconds: 3.25,
      timerSeconds: 0,
      distanceMeters: 0,
      averageHeartRateBpm: null,
      maximumHeartRateBpm: 0,
    },
  ];
  const legacyDetails = {
    schemaVersion: 1,
    streamIndex: 0,
    sessionIndex: 0,
    startedAt: '2028-01-01T08:59:59+09:00',
    recordedAt: '2028-03-01T00:00:00Z',
    elapsedSeconds: 5_184_000.75,
    records: boundaryRecords,
    laps: boundaryLaps,
  } as const;
  const summaryDetails = {
    ...legacyDetails,
    schemaVersion: 2,
    sessionSummary: { averageHeartRateBpm: 0, maximumHeartRateBpm: null },
  } as const;

  it.each([
    ['v1', legacyDetails],
    ['v2', summaryDetails],
  ] as const)('reads and replays %s details exactly as written', async (_version, written) => {
    const athlete = randomUUID();
    const command: ActivityImport = { ...input(), details: written };
    const first = await repository.importActivity(athlete, command);
    const read = await repository.getActivityDetails(athlete, first.activityId);
    // Same version, same fields, same instant text — no upgrade and no re-rendering.
    expect(read?.details).toEqual(written);
    expect(read?.details?.schemaVersion).toBe(written.schemaVersion);
    expect(read?.details?.records.map((record) => record.timestamp)).toEqual(
      boundaryRecords.map((record) => record.timestamp),
    );
    expect(read?.details?.laps.map((lap) => [lap.startedAt, lap.recordedAt])).toEqual([
      ['2028-01-01T08:59:59+09:00', '2028-01-01T00:00:02Z'],
    ]);
    // A replay under the same key is the original answer; the same payload under a new key
    // is recognised as the stored revision, not as a conflict or a new revision.
    expect(await repository.importActivity(athlete, command)).toEqual(first);
    expect(
      await repository.importActivity(athlete, { ...command, idempotencyKey: randomUUID() }),
    ).toEqual({ ...first, outcome: 'unchanged' });
    expect(await repository.getActivityDetails(athlete, first.activityId)).toEqual(read);
    await database.tenant(athlete, async (tx) => {
      expect(
        (await tx.query('SELECT source_revision,details_json FROM activity_source_revision')).rows,
      ).toEqual([{ source_revision: 1, details_json: written }]);
    });
  });

  it('keeps an old-version revision replayable after a newer version supersedes it', async () => {
    const athlete = randomUUID();
    const legacy: ActivityImport = { ...input(), details: legacyDetails };
    const first = await repository.importActivity(athlete, legacy);
    const newer: ActivityImport = {
      ...legacy,
      idempotencyKey: randomUUID(),
      source: { ...legacy.source, revision: 2 },
      details: summaryDetails,
    };
    const second = await repository.importActivity(athlete, newer);
    expect(second).toMatchObject({ activityId: first.activityId, revision: 2 });
    expect((await repository.getActivityDetails(athlete, first.activityId))?.details).toEqual(
      summaryDetails,
    );
    // The old command replays to its own answer and leaves the old revision untouched.
    expect(await repository.importActivity(athlete, legacy)).toEqual(first);
    await database.tenant(athlete, async (tx) => {
      expect(
        (
          await tx.query(
            'SELECT source_revision,details_json FROM activity_source_revision ORDER BY source_revision',
          )
        ).rows,
      ).toEqual([
        { source_revision: 1, details_json: legacyDetails },
        { source_revision: 2, details_json: summaryDetails },
      ]);
    });
  });
});
