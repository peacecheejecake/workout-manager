import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { ActivityImport } from '@workout/contracts/activity';
import { activityExportSchema } from '@workout/contracts/activity';
import mixedFitFixture from '../../../../tests/fixtures/fit-activity-bout-export.json' with { type: 'json' };
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
  // Account export reads consent even when this fixture creates no consent rows.
  await admin.query('GRANT SELECT ON consent TO workout_runtime');
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

const detail1 = {
  schemaVersion: 1 as const,
  streamIndex: 0,
  sessionIndex: 0,
  startedAt: '2024-01-01T12:00:00Z',
  recordedAt: '2024-01-01T12:10:05Z',
  elapsedSeconds: 600,
  records: [{ index: 0, timestamp: null, distanceMeters: 0, heartRateBpm: null }],
  laps: [],
};
const detail2 = {
  ...detail1,
  schemaVersion: 2 as const,
  sessionSummary: { averageHeartRateBpm: 0, maximumHeartRateBpm: null },
};
it('upgrades source revisions in place, preserves reports/tags and legacy receipts, and exports all exact source history', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    legacy = input();
  const first = await repo.importActivity(athlete, legacy);
  const report = await repo.updateOverlay(athlete, first.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Synthetic report',
    tags: ['local'],
    distanceMeters: 0,
    report: { sessionRpe: 0, note: 'Keep report', planLink: null },
  });
  const rev2 = {
    ...legacy,
    idempotencyKey: randomUUID(),
    source: { ...legacy.source, revision: 2 },
    details: detail1,
  };
  const second = await repo.importActivity(athlete, rev2);
  const rev3 = {
    ...legacy,
    idempotencyKey: randomUUID(),
    source: { ...legacy.source, revision: 3 },
    details: detail2,
  };
  const [third, repeat] = await Promise.all([
    repo.importActivity(athlete, rev3),
    repo.importActivity(athlete, rev3),
  ]);
  expect(repeat).toEqual(third);
  expect(third.activityId).toBe(first.activityId);
  expect(third.revision).toBe(4);
  expect(await repo.importActivity(athlete, legacy)).toEqual(first);
  expect(await repo.importActivity(athlete, rev2)).toEqual(second);
  const current = await repo.getActivity(athlete, first.activityId);
  expect(current?.overlay).toEqual(report.overlay);
  expect(current?.userReport).toEqual(report.userReport);
  expect(current?.effective.distanceMeters).toBe(0);
  expect(await repo.getActivityDetails(athlete, first.activityId)).toEqual({
    activityId: first.activityId,
    activityRevision: 4,
    source: rev3.source,
    details: detail2,
  });
  expect((await repo.listActivities(athlete)).total).toBe(1);
  expect((await repo.summary(athlete)).count).toBe(1);
  await repo.importActivity(athlete, { ...rev3, idempotencyKey: randomUUID() });
  await expect(
    repo.importActivity(athlete, {
      ...rev3,
      idempotencyKey: randomUUID(),
      details: {
        ...detail2,
        sessionSummary: { averageHeartRateBpm: 1, maximumHeartRateBpm: null },
      },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(
    (await repo.importActivity(athlete, { ...rev2, idempotencyKey: randomUUID() })).outcome,
  ).toBe('unchanged');
  expect((await repo.getActivityDetails(athlete, first.activityId))?.details).toEqual(detail2);
  const exported = await createOperationsRepository(database).exportAccount(athlete);
  expect(exported.schemaVersion).toBe(15);
  expect(
    exported.data.sourceRevisions.map((row) => ({
      revision: row['source_revision'],
      details: row['details_json'],
    })),
  ).toEqual([
    { revision: 1, details: null },
    { revision: 2, details: detail1 },
    { revision: 3, details: detail2 },
  ]);
  await database.tenant(athlete, async (tx) => {
    expect((await tx.query('SELECT * FROM activity_source_revision')).rowCount).toBe(3);
    expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(4);
  });
});
it('rolls back summary enrichment on outbox failure and retries with the original command', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    legacy = input(),
    base = await repo.importActivity(athlete, {
      ...legacy,
      source: { ...legacy.source, revision: 2 },
      details: detail1,
    });
  const command = {
    ...legacy,
    idempotencyKey: randomUUID(),
    source: { ...legacy.source, revision: 3 },
    details: detail2,
  };
  const broken: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: (sql, args) => {
            if (sql.includes('INSERT INTO outbox')) throw new Error('session summary rollback');
            return tx.query(sql, args);
          },
        }),
      ),
  };
  await expect(createActivityRepository(broken).importActivity(athlete, command)).rejects.toThrow(
    'session summary rollback',
  );
  expect((await repo.getActivityDetails(athlete, base.activityId))?.details).toEqual(detail1);
  await database.tenant(athlete, async (tx) => {
    expect((await tx.query('SELECT * FROM activity_source_revision')).rowCount).toBe(1);
    expect((await tx.query('SELECT * FROM activity_import_receipt')).rowCount).toBe(1);
    expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(1);
  });
  const result = await repo.importActivity(athlete, command);
  expect(result.revision).toBe(2);
  expect((await repo.getActivityDetails(athlete, base.activityId))?.details).toEqual(detail2);
  // Revision 1 was never stored for this source: a late arrival is historical-only, unlike a
  // known revision's unchanged replay above.
  const late = await repo.importActivity(athlete, { ...legacy, idempotencyKey: randomUUID() });
  expect(late.outcome).toBe('stale');
  expect(await repo.getActivityDetails(athlete, base.activityId)).toMatchObject({
    activityRevision: 2,
    source: { revision: 3 },
    details: detail2,
  });
  await database.tenant(athlete, async (tx) => {
    expect((await tx.query('SELECT * FROM activity_source_revision')).rowCount).toBe(3);
    expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(2);
  });
});
it('enforces ownership and suppression for session summaries and erases immutable source history', async () => {
  const athlete = randomUUID(),
    repo = createActivityRepository(database),
    command = { ...input(), details: detail2 },
    first = await repo.importActivity(athlete, command);
  expect(await repo.getActivityDetails(randomUUID(), first.activityId)).toBeNull();
  await repo.deleteActivity(athlete, first.activityId, { expectedRevision: 1 });
  expect(await repo.getActivityDetails(athlete, first.activityId)).toBeNull();
  expect(await repo.importActivity(athlete, command)).toEqual(first);
  expect(
    (
      await repo.importActivity(athlete, {
        ...command,
        idempotencyKey: randomUUID(),
        source: { ...command.source, revision: 4 },
      })
    ).outcome,
  ).toBe('suppressed');
  expect((await repo.listActivities(athlete)).total).toBe(0);
  await createOperationsRepository(database).eraseAccount(athlete);
  expect(
    (await admin.query('SELECT * FROM activity_source_revision WHERE athlete_id=$1', [athlete]))
      .rowCount,
  ).toBe(0);
  expect(
    (await admin.query('SELECT * FROM activity_import_receipt WHERE athlete_id=$1', [athlete]))
      .rowCount,
  ).toBe(0);
});

it('imports one mixed FIT parent with run, strength and unallocated bouts without multiplying Activity totals', async () => {
  const exported = activityExportSchema.parse(mixedFitFixture);
  if (exported.schemaVersion !== 4) throw new Error('Expected V4 synthetic FIT export');
  const command = exported.imports[0];
  if (!command) throw new Error('Missing FIT parent');
  const athlete = randomUUID();
  const repository = createActivityRepository(database);
  const first = await repository.importActivity(athlete, command);
  expect(first.outcome).toBe('imported');
  expect(await repository.importActivity(athlete, command)).toEqual(first);
  expect(
    (
      await repository.importActivity(athlete, {
        ...command,
        idempotencyKey: randomUUID(),
      })
    ).outcome,
  ).toBe('unchanged');
  expect((await repository.listActivities(athlete)).total).toBe(1);
  const summary = await repository.summary(athlete);
  expect(summary.count).toBe(1);
  expect(summary.durationSeconds.value).toBe(3600);
  expect(summary.durationSeconds.knownCount).toBe(1);
  expect(summary.durationSeconds.byKind.timer.value).toBe(3600);
  expect((await repository.getActivityDetails(athlete, first.activityId))?.details).toEqual(
    command.details,
  );
  expect(await repository.getActivityDetails(randomUUID(), first.activityId)).toBeNull();
  await repository.deleteActivity(athlete, first.activityId, { expectedRevision: 1 });
  expect((await repository.listActivities(athlete)).total).toBe(0);
  expect(
    (
      await repository.importActivity(athlete, {
        ...command,
        source: { ...command.source, revision: 5 },
        idempotencyKey: randomUUID(),
      })
    ).outcome,
  ).toBe('suppressed');
});
