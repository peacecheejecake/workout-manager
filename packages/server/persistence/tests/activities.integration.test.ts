import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import { migrate } from '../src/migrate.js';
import type { ActivityImport } from '@workout/contracts/activity';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let repository: ActivityRepository;
beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,outbox,command_receipt TO workout_runtime',
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
