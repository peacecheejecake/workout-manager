import type { PlanDraft } from '@workout/contracts/planning';
import { createPlanningRepository } from '../src/planning.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { ActivityImport, ActivityListQuery } from '@workout/contracts/activity';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createActivityRepository } from '../src/activities.js';
import { createOperationsRepository } from '../src/operations.js';
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

it('persists tags only in overlays, keeps them across correction and reimport, and replays historical receipts without changing current tags', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    source = input();
  const imported = await repo.importActivity(athlete, source);
  const command = {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Organize locally',
    tags: ['  café  ', 'Run', '%_\\'],
  };
  const [first, duplicate] = await Promise.all([
    repo.updateOverlay(athlete, imported.activityId, command),
    repo.updateOverlay(athlete, imported.activityId, command),
  ]);
  expect(duplicate).toEqual(first);
  expect(first.overlay.tags).toEqual(['café', 'Run', '%_\\']);
  expect(first.original).not.toHaveProperty('tags');
  expect(first.effective).not.toHaveProperty('tags');
  expect(first.userReport).toBeNull();
  await expect(
    repo.updateOverlay(athlete, imported.activityId, { ...command, tags: ['different'] }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const corrected = await repo.updateOverlay(athlete, imported.activityId, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    reason: 'Distance known',
    distanceMeters: 0,
  });
  expect(corrected.overlay.tags).toEqual(first.overlay.tags);
  await repo.importActivity(athlete, {
    ...source,
    idempotencyKey: randomUUID(),
    source: { ...source.source, revision: 2, contentHash: 'b'.repeat(64) },
  });
  expect((await repo.getActivity(athlete, imported.activityId))?.overlay.tags).toEqual(
    first.overlay.tags,
  );
  const cleared = await repo.updateOverlay(athlete, imported.activityId, {
    expectedRevision: 4,
    idempotencyKey: randomUUID(),
    reason: 'Clear local tags',
    tags: [],
  });
  expect(cleared.overlay.tags).toEqual([]);
  expect(await repo.updateOverlay(athlete, imported.activityId, command)).toEqual(first);
  expect((await repo.getActivity(athlete, imported.activityId))?.overlay.tags).toEqual([]);
  expect(await ids(athlete, { quality: 'corrected' })).toEqual([imported.activityId]);
});
it('filters exact NFC and case-sensitive literal tags with existing AND filters and stable pagination', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database);
  const all = [];
  for (let i = 0; i < 3; i++) {
    const created = await repo.importActivity(athlete, input());
    await repo.updateOverlay(athlete, created.activityId, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'Tag selection',
      tags: i < 2 ? ['café', 'Run', '%_\\'] : ['run', 'cafeteria'],
    });
    all.push(created.activityId);
  }
  const matches = all.slice(0, 2).sort();
  expect(await ids(athlete, { tag: 'café' })).toEqual(matches);
  expect(await ids(athlete, { tag: 'Run' })).toEqual(matches);
  expect(await ids(athlete, { tag: 'run' })).toEqual([all[2]]);
  expect(await ids(athlete, { tag: '%_\\' })).toEqual(matches);
  expect(await ids(athlete, { tag: '%' })).toEqual([]);
  const query = {
    tag: 'Run',
    from: '2024-01-01',
    toExclusive: '2024-01-02',
    timezone: 'UTC',
    source: 'fixture' as const,
    quality: 'corrected' as const,
  };
  expect(await repo.listActivities(athlete, { ...query, limit: 1, offset: 1 })).toMatchObject({
    total: 2,
    items: [{ id: matches[1] }],
  });
  expect(await repo.listActivities(athlete, { ...query, offset: 99 })).toEqual({
    total: 2,
    items: [],
  });
  expect(await ids(athlete, { ...query, source: 'fit' })).toEqual([]);
  expect(await ids(randomUUID(), { tag: 'Run' })).toEqual([]);
  await repo.deleteActivity(athlete, matches[0] ?? '', { expectedRevision: 2 });
  expect(await ids(athlete, { tag: 'Run' })).toEqual([matches[1]]);
});
it('serializes competing tag revisions, rejects foreign writes and rolls back tags with failed outbox enqueue', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    created = await repo.importActivity(athlete, input());
  const command = {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Tags',
    tags: ['one'],
  };
  await expect(repo.updateOverlay(randomUUID(), created.activityId, command)).rejects.toThrow(
    'ACTIVITY_NOT_FOUND',
  );
  const broken: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: (sql, args) => {
            if (sql.includes('INSERT INTO outbox')) throw new Error('tag injected failure');
            return tx.query(sql, args);
          },
        }),
      ),
  };
  await expect(
    createActivityRepository(broken).updateOverlay(athlete, created.activityId, command),
  ).rejects.toThrow('tag injected failure');
  expect((await repo.getActivity(athlete, created.activityId))?.revision).toBe(1);
  const results = await Promise.allSettled([
    repo.updateOverlay(athlete, created.activityId, command),
    repo.updateOverlay(athlete, created.activityId, {
      ...command,
      idempotencyKey: randomUUID(),
      tags: ['two'],
    }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'REVISION_CONFLICT' },
  });
  await database.tenant(athlete, async (tx) => {
    expect((await tx.query('SELECT * FROM activity_overlay_revision')).rowCount).toBe(1);
    expect((await tx.query('SELECT * FROM command_receipt')).rowCount).toBe(1);
    expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(2);
  });
});
it('exports local tags and erases their history, while deletion suppression prevents tagged activities from returning', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    source = input(),
    created = await repo.importActivity(athlete, source);
  await repo.updateOverlay(athlete, created.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Private local organization',
    tags: ['private-tag'],
  });
  const operations = createOperationsRepository(database),
    exported = await operations.exportAccount(athlete);
  expect(exported.data.overlays).toEqual([
    {
      activity_id: created.activityId,
      values_json: { reason: 'Private local organization', tags: ['private-tag'] },
    },
  ]);
  expect(exported.data.overlayRevisions).toEqual([
    {
      activity_id: created.activityId,
      revision: 2,
      values_json: { reason: 'Private local organization', tags: ['private-tag'] },
    },
  ]);
  expect(exported.data.activities).toEqual([
    expect.objectContaining({ id: created.activityId, revision: 2 }),
  ]);
  await repo.deleteActivity(athlete, created.activityId, { expectedRevision: 2 });
  await repo.importActivity(athlete, {
    ...source,
    idempotencyKey: randomUUID(),
    source: { ...source.source, revision: 2, contentHash: 'c'.repeat(64) },
  });
  expect(await repo.getActivity(athlete, created.activityId)).toBeNull();
  expect(await ids(athlete, { tag: 'private-tag' })).toEqual([]);
  await operations.eraseAccount(athlete);
  for (const table of ['activity_overlay', 'activity_overlay_revision', 'command_receipt'])
    expect(
      (await admin.query(`SELECT * FROM ${table} WHERE athlete_id=$1`, [athlete])).rowCount,
    ).toBe(0);
});

it('replays a pre-tag receipt with absent tags while preserving the latest tags and complete user report', async () => {
  const athlete = randomUUID();
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const plan: PlanDraft = {
    title: 'Synthetic report link',
    timezone: 'UTC',
    periods: levels.map((level, index) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
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
        id: 'session',
        blockId: 'block',
        date: '2024-01-01',
        localStartTime: null,
        title: 'Synthetic planned session',
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
  const saved = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: plan,
  });
  const repo = createActivityRepository(database, { now: () => new Date('2024-01-02T00:00:00Z') });
  const source = input(),
    created = await repo.importActivity(athlete, source);
  const legacy = {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'User confirms own report',
    report: {
      sessionRpe: 0,
      note: 'Keep this report',
      planLink: { planVersionId: saved.id, sessionId: 'session' },
    },
  };
  const first = await repo.updateOverlay(athlete, created.activityId, legacy);
  expect(first.overlay).not.toHaveProperty('tags');
  const tagged = await repo.updateOverlay(athlete, created.activityId, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    reason: 'Tag only',
    tags: ['local'],
  });
  expect(tagged.userReport).toEqual(first.userReport);
  expect(tagged.userReport).toMatchObject({
    sessionRpe: 0,
    note: 'Keep this report',
    planLink: legacy.report.planLink,
    rpeReportedAt: '2024-01-02T00:00:00.000Z',
  });
  const replay = await repo.updateOverlay(athlete, created.activityId, legacy);
  expect(replay).toEqual(first);
  expect(replay.overlay).not.toHaveProperty('tags');
  const latest = await repo.getActivity(athlete, created.activityId);
  expect(latest).toEqual(tagged);
  expect(latest?.overlay.tags).toEqual(['local']);
  await repo.importActivity(athlete, {
    ...source,
    idempotencyKey: randomUUID(),
    source: { ...source.source, revision: 2, contentHash: 'd'.repeat(64) },
  });
  const imported = await repo.getActivity(athlete, created.activityId);
  expect(imported?.userReport).toEqual(first.userReport);
  expect(imported?.overlay.tags).toEqual(['local']);
});
