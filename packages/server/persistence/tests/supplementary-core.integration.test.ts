import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SetLogCorrectCommand } from '@workout/contracts/supplementary-core';
import { activityExportSchema, type ActivityImport } from '@workout/contracts/activity';
import mixedFitFixture from '../../../../tests/fixtures/fit-activity-bout-export.json' with { type: 'json' };

import { createActivityRepository } from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations, grantSupplementaryCore } from '../src/migrate.js';
import {
  createSupplementaryRepository,
  insertSupplementarySessionLink,
} from '../src/supplementary-core.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const happenedAt = '2026-01-01T08:00:00.000Z';
const laterAt = '2026-01-01T08:01:00.000Z';
const expectedDefinition = {
  kind: 'repetitions' as const,
  basis: 'per_side' as const,
  definitionId: 'rep-per-side-v1',
};

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantSupplementaryCore(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON command_receipt,outbox TO workout_runtime');
  await admin.query('GRANT UPDATE(idempotency_key) ON outbox TO workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO workout_runtime',
  );
  await admin.query('GRANT SELECT,INSERT ON plan_snapshot,plan_history TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON plan_head TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

function exercise(exerciseId = randomUUID(), versionId = randomUUID()) {
  return {
    definition: {
      schemaVersion: 2 as const,
      exerciseId,
      versionId,
      name: 'Single-leg balance',
      family: 'balance_stability' as const,
      equipment: ['bodyweight' as const],
      tags: ['balance'],
      countDefinitions: [expectedDefinition],
      mediaAssetIds: [],
      resourceVersionIds: [],
      reviewState: 'unreviewed' as const,
      description: 'User-defined movement',
      safetyNotes: '',
      supportedMetrics: ['count' as const, 'effort' as const],
      createdAt: happenedAt,
    },
    expectedVersionId: null as string | null,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
}
function routine(
  exerciseVersionId: string,
  routineId: string = randomUUID(),
  versionId: string = randomUUID(),
) {
  return {
    template: {
      schemaVersion: 2 as const,
      routineId,
      versionId,
      title: 'Balance routine',
      purpose: 'User-defined practice',
      requiredEquipment: ['bodyweight' as const],
      spec: {
        schemaVersion: 2 as const,
        kind: 'supplementary' as const,
        routineVersionId: versionId,
        blocks: [
          {
            id: 'block-1',
            mode: 'single' as const,
            rounds: 2,
            sets: [
              {
                id: 'target-1',
                exerciseVersionId,
                side: 'left' as const,
                count: {
                  target: {
                    min: 8,
                    max: 10,
                    unit: 'count' as const,
                    basis: 'user_confirmed' as const,
                    evidenceIds: [],
                  },
                  definition: expectedDefinition,
                },
                durationSeconds: null,
                externalResistance: { kind: 'no_added_load' as const },
                restAfterSeconds: 60,
                tempo: null,
                effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
              },
            ],
            restBetweenRoundsSeconds: null,
          },
        ],
      },
      createdAt: happenedAt,
    },
    expectedVersionId: null as string | null,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
}
function setValues(exerciseVersionId: string) {
  return {
    targetSetId: 'target-1',
    blockId: 'block-1',
    roundIndex: 1,
    exerciseVersionId,
    side: 'left' as const,
    state: 'partial' as const,
    count: {
      actual: { value: 4, unit: 'count' as const, status: 'reported' as const, evidenceIds: [] },
      definition: expectedDefinition,
    },
    durationSeconds: {
      value: null,
      unit: 's' as const,
      status: 'unknown' as const,
      evidenceIds: [],
    },
    externalResistance: { kind: 'no_added_load' as const },
    effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
    occurredAt: happenedAt,
    reason: null,
  };
}
async function seededPlan(athlete: string, routineVersionId: string) {
  const planVersionId = randomUUID();
  const link = {
    schemaVersion: 2 as const,
    planVersionId,
    plannedSessionId: 'strength-1',
    content: { kind: 'routine_version' as const, routineVersionId },
  };
  await database.tenant(athlete, async (tx) => {
    // The helper is intentionally used inside the new PlanVersion write transaction.
    const draft = {
      title: 'Strength plan',
      timezone: 'UTC',
      periods: [],
      sessions: [{ id: 'strength-1', sport: 'strength' }],
    };
    await tx.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
      [athlete, planVersionId, JSON.stringify(draft)],
    );
    await tx.query('INSERT INTO plan_head(athlete_id,version_id) VALUES($1,$2)', [
      athlete,
      planVersionId,
    ]);
    await tx.query(
      "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
      [athlete, planVersionId],
    );
    await insertSupplementarySessionLink(tx, link);
  });
  return link;
}
async function seededActivity(athlete: string, kind: 'strength' | 'running' = 'strength') {
  return createActivityRepository(database).createManualActivity(athlete, {
    confirmed: true,
    activity: {
      title: 'Balance session',
      kind,
      startedAt: happenedAt,
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'UTC',
      distanceMeters: null,
    },
    report: { sessionRpe: null, note: null, planLink: null },
    idempotencyKey: randomUUID(),
  });
}

describe('supplementary core real PostgreSQL ledger', () => {
  it('links a confirmed strength bout and a user set to the one mixed FIT parent Activity', async () => {
    const exported = activityExportSchema.parse(mixedFitFixture);
    if (exported.schemaVersion !== 4) throw new Error('Expected V4 synthetic FIT export');
    const source = exported.imports[0];
    if (!source) throw new Error('Missing mixed parent');
    const athlete = randomUUID();
    const activityRepository = createActivityRepository(database);
    const activity = await activityRepository.importActivity(athlete, source);
    const repository = createSupplementaryRepository(database);
    const savedExercise = await repository.saveExercise(athlete, exercise());
    const execution = await repository.createExecution(athlete, {
      schemaVersion: 2,
      executionId: randomUUID(),
      plannedSession: null,
      activity: { kind: 'match_existing', activityId: activity.activityId },
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const log = await repository.createSetLog(athlete, {
      schemaVersion: 2,
      executionId: execution.executionId,
      logId: randomUUID(),
      expectedExecutionRevision: 1,
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed',
      values: {
        ...setValues(savedExercise.definition.versionId),
        targetSetId: null,
        blockId: null,
        roundIndex: null,
        occurredAt: '2024-11-08T12:14:20Z',
      },
    });
    expect(execution.activityId).toBe(activity.activityId);
    expect(log.status).toBe('active');
    expect((await activityRepository.listActivities(athlete)).total).toBe(1);
    expect((await activityRepository.summary(athlete)).durationSeconds.value).toBe(3600);
    expect((await repository.listExecutions(athlete)).items).toHaveLength(1);

    const { allocation: _allocation, ...v2 } = source.details;
    const older: ActivityImport = {
      ...source,
      source: { ...source.source, sourceId: `${source.source.sourceId}:legacy`, revision: 3 },
      idempotencyKey: randomUUID(),
      details: {
        ...v2,
        schemaVersion: 2,
        laps: v2.laps.map(({ sport: _sport, ...lap }) => lap),
      },
    };
    const olderActivity = await activityRepository.importActivity(athlete, older);
    await expect(
      repository.createExecution(athlete, {
        schemaVersion: 2,
        executionId: randomUUID(),
        plannedSession: null,
        activity: { kind: 'match_existing', activityId: olderActivity.activityId },
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_INVALID' });
    const unallocated = await activityRepository.importActivity(athlete, {
      ...source,
      source: { ...source.source, sourceId: `${source.source.sourceId}:unallocated` },
      idempotencyKey: randomUUID(),
      details: {
        ...source.details,
        allocation: {
          parent: source.details.allocation.parent,
          bouts: [
            {
              sourceLapIndex: null,
              ...source.details.allocation.parent,
              kind: 'mixed_unallocated',
            },
          ],
        },
      },
    });
    await expect(
      repository.createExecution(athlete, {
        schemaVersion: 2,
        executionId: randomUUID(),
        plannedSession: null,
        activity: { kind: 'match_existing', activityId: unallocated.activityId },
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_INVALID' });
  });
  it('bounds the exercise catalog at 100 stable head rows and reports truncation', async () => {
    const athlete = randomUUID();
    const records = Array.from({ length: 101 }, () => exercise().definition);
    await database.tenant(athlete, async (tx) => {
      for (const definition of records) {
        await tx.query(
          `INSERT INTO supplementary_exercise_version
           (athlete_id,exercise_id,version_id,version,created_at,record_json)
           VALUES($1,$2,$3,1,$4,$5::jsonb)`,
          [
            athlete,
            definition.exerciseId,
            definition.versionId,
            definition.createdAt,
            JSON.stringify(definition),
          ],
        );
        await tx.query(
          `INSERT INTO supplementary_exercise_head(athlete_id,exercise_id,version,version_id)
           VALUES($1,$2,1,$3)`,
          [athlete, definition.exerciseId, definition.versionId],
        );
      }
    });
    const listed = await createSupplementaryRepository(database).listExercises(athlete);
    expect(listed.hasMore).toBe(true);
    expect(listed.items).toHaveLength(100);
    expect(listed.items.map((item) => item.definition.exerciseId)).toEqual(
      records
        .map((item) => item.exerciseId)
        .sort()
        .slice(0, 100),
    );
  });

  it('restores at most 100 tenant-owned reference-time timers in a stable order', async () => {
    const repository = createSupplementaryRepository(database);
    const athlete = randomUUID();
    const activity = await seededActivity(athlete);
    const execution = await repository.createExecution(athlete, {
      schemaVersion: 2,
      executionId: randomUUID(),
      plannedSession: null,
      activity: { kind: 'match_existing', activityId: activity.activityId },
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const timerIds = Array.from({ length: 101 }, () => randomUUID());
    const startedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
    await database.tenant(athlete, async (tx) => {
      for (const timerId of timerIds) {
        await tx.query(
          `INSERT INTO supplementary_rest_timer
           (athlete_id,id,execution_id,revision,duration_seconds,status,started_at,deadline_at)
           VALUES($1,$2,$3,1,60,'running',$4,$5)`,
          [athlete, timerId, execution.executionId, startedAt, deadlineAt],
        );
      }
    });
    const listed = await repository.listRestTimers(athlete, execution.executionId);
    expect(listed.hasMore).toBe(true);
    expect(listed.items).toHaveLength(100);
    expect(listed.items.map((timer) => timer.timerId)).toEqual(timerIds.sort().slice(0, 100));
    expect((await repository.listSetLogs(athlete, execution.executionId)).items).toEqual([]);
    await expect(
      repository.listRestTimers(randomUUID(), execution.executionId),
    ).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' });
  });

  it('rejects linking a non-strength canonical Activity', async () => {
    const repository = createSupplementaryRepository(database);
    const athlete = randomUUID();
    const activity = await seededActivity(athlete, 'running');
    await expect(
      repository.createExecution(athlete, {
        schemaVersion: 2,
        executionId: randomUUID(),
        plannedSession: null,
        activity: { kind: 'match_existing', activityId: activity.activityId },
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_INVALID' });
  });

  it('saves immutable per-aggregate versions with CAS, replay and tenant-owned exercise references', async () => {
    const repository = createSupplementaryRepository(database);
    const athlete = randomUUID(),
      other = randomUUID();
    const first = exercise();
    const saved = await repository.saveExercise(athlete, first);
    expect(saved.version).toBe(1);
    expect(await repository.saveExercise(athlete, first)).toEqual(saved);
    expect(await repository.readExercise(other, first.definition.exerciseId)).toBeNull();
    await expect(
      repository.saveExercise(athlete, {
        ...first,
        definition: {
          ...first.definition,
          versionId: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const update = {
      ...exercise(first.definition.exerciseId),
      expectedVersionId: saved.definition.versionId,
    };
    const stale = {
      ...exercise(first.definition.exerciseId),
      expectedVersionId: saved.definition.versionId,
    };
    const [a, b] = await Promise.allSettled([
      repository.saveExercise(athlete, update),
      repository.saveExercise(athlete, stale),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((await repository.readExercise(athlete, first.definition.exerciseId))?.version).toBe(2);
    const independent = await repository.saveExercise(athlete, exercise());
    expect(independent.version).toBe(1);
    expect((await repository.listExercises(other)).items).toEqual([]);
    const exerciseList = await repository.listExercises(athlete);
    expect(exerciseList).toMatchObject({ hasMore: false });
    expect(exerciseList.items.map((item) => item.definition.exerciseId)).toEqual(
      [first.definition.exerciseId, independent.definition.exerciseId].sort(),
    );
    await expect(
      repository.saveRoutine(other, routine(saved.definition.versionId)),
    ).rejects.toMatchObject({
      code: 'TARGET_LINK_INVALID',
    });
    const savedRoutine = await repository.saveRoutine(athlete, routine(saved.definition.versionId));
    expect(savedRoutine.version).toBe(1);
    expect(await repository.readRoutineVersion(athlete, savedRoutine.template.versionId)).toEqual(
      savedRoutine,
    );
    expect(await repository.readRoutineVersion(other, savedRoutine.template.versionId)).toBeNull();
    const nextRoutine = {
      ...routine(saved.definition.versionId, savedRoutine.template.routineId),
      expectedVersionId: savedRoutine.template.versionId,
    };
    expect((await repository.saveRoutine(athlete, nextRoutine)).version).toBe(2);
    expect(await repository.readRoutineVersion(athlete, savedRoutine.template.versionId)).toEqual(
      savedRoutine,
    );
    expect((await repository.readRoutine(athlete, savedRoutine.template.routineId))?.version).toBe(
      2,
    );
    expect((await repository.listRoutines(athlete)).items).toMatchObject([{ version: 2 }]);
    expect((await repository.listRoutines(other)).items).toEqual([]);
    await expect(
      repository.saveRoutine(athlete, {
        ...routine(saved.definition.versionId, savedRoutine.template.routineId),
        expectedVersionId: savedRoutine.template.versionId,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await database.tenant(athlete, async (tx) => {
      expect(
        (
          await tx.query(
            'SELECT exercise_revision,routine_revision FROM integrated_dependency_head',
          )
        ).rows[0],
      ).toEqual({ exercise_revision: 3, routine_revision: 2 });
      expect(
        (await tx.query('SELECT count(*)::int AS count FROM supplementary_exercise_version'))
          .rows[0]?.['count'],
      ).toBe(3);
      expect(
        (await tx.query('SELECT count(*)::int AS count FROM supplementary_routine_target_ref'))
          .rows[0]?.['count'],
      ).toBe(2);
    });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE supplementary_exercise_version SET created_at=now()'),
      ),
    ).rejects.toThrow('permission denied');
    await expect(
      admin.query(
        'UPDATE supplementary_exercise_version SET created_at=now() WHERE athlete_id=$1',
        [athlete],
      ),
    ).rejects.toThrow('IMMUTABLE_SUPPLEMENTARY_RECORD');
    await expect(
      admin.query('UPDATE supplementary_routine_version SET created_at=now() WHERE athlete_id=$1', [
        athlete,
      ]),
    ).rejects.toThrow('IMMUTABLE_SUPPLEMENTARY_RECORD');
  });

  it('records one canonical Activity and set revision, then timer, correction, tombstone and Activity deletion', async () => {
    const repository = createSupplementaryRepository(database, { now: () => new Date(happenedAt) });
    const athlete = randomUUID();
    const savedExercise = await repository.saveExercise(athlete, exercise());
    const savedRoutine = await repository.saveRoutine(
      athlete,
      routine(savedExercise.definition.versionId),
    );
    const link = await seededPlan(athlete, savedRoutine.template.versionId);
    const activity = await seededActivity(athlete);
    const command = {
      schemaVersion: 2 as const,
      executionId: randomUUID(),
      plannedSession: link,
      activity: { kind: 'match_existing' as const, activityId: activity.activityId },
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    const execution = await repository.createExecution(athlete, command);
    expect(await repository.createExecution(athlete, command)).toEqual(execution);
    expect((await repository.readExecution(athlete, command.executionId))?.activityId).toBe(
      activity.activityId,
    );
    expect(await repository.readExecution(randomUUID(), command.executionId)).toBeNull();
    expect((await repository.listExecutions(athlete)).items).toEqual([execution]);
    expect((await repository.listExecutions(randomUUID())).items).toEqual([]);
    await expect(
      repository.createExecution(athlete, {
        ...command,
        executionId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const createLog = {
      schemaVersion: 2 as const,
      executionId: execution.executionId,
      logId: randomUUID(),
      expectedExecutionRevision: 1,
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed' as const,
      values: setValues(savedExercise.definition.versionId),
    };
    const first = await repository.createSetLog(athlete, createLog);
    expect(first.status).toBe('active');
    expect(await repository.createSetLog(athlete, createLog)).toEqual(first);
    await expect(
      repository.createSetLog(athlete, {
        ...createLog,
        logId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const correctionCommand: SetLogCorrectCommand = {
      schemaVersion: 2,
      executionId: execution.executionId,
      logId: createLog.logId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed',
      values: {
        ...setValues(savedExercise.definition.versionId),
        state: 'performed',
        count: {
          ...setValues(savedExercise.definition.versionId).count,
          actual: { value: 8, unit: 'count', status: 'reported', evidenceIds: [] },
        },
      },
    };
    const correction = await repository.correctSetLog(athlete, correctionCommand);
    expect(correction.status === 'active' ? correction.current.revision : 0).toBe(2);
    const timerId = randomUUID();
    const started = await repository.commandRestTimer(athlete, {
      action: 'start',
      executionId: execution.executionId,
      timerId,
      durationSeconds: 60,
      at: happenedAt,
      idempotencyKey: randomUUID(),
    });
    expect(started.status).toBe('running');
    const paused = await repository.commandRestTimer(athlete, {
      action: 'pause',
      executionId: execution.executionId,
      timerId,
      expectedRevision: 1,
      at: laterAt,
      idempotencyKey: randomUUID(),
    });
    expect(paused).toMatchObject({ status: 'paused', remainingWhenPausedSeconds: 0 });
    const resumed = await repository.commandRestTimer(athlete, {
      action: 'resume',
      executionId: execution.executionId,
      timerId,
      expectedRevision: 2,
      at: laterAt,
      idempotencyKey: randomUUID(),
    });
    expect(resumed.status).toBe('running');
    expect(await repository.listRestTimers(athlete, execution.executionId)).toEqual({
      items: [resumed],
      hasMore: false,
    });
    const deleted = await repository.deleteSetLog(athlete, {
      schemaVersion: 2,
      executionId: execution.executionId,
      logId: createLog.logId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      confirmed: true,
      reason: 'Incorrect set',
    });
    expect(deleted.status).toBe('deleted');
    await expect(repository.createSetLog(athlete, createLog)).rejects.toMatchObject({
      code: 'SET_LOG_NOT_FOUND',
    });
    await expect(repository.correctSetLog(athlete, correctionCommand)).rejects.toMatchObject({
      code: 'SET_LOG_NOT_FOUND',
    });
    expect(await repository.readSetLog(athlete, createLog.logId)).toEqual(deleted);
    expect(await repository.listSetLogs(athlete, execution.executionId)).toEqual({
      items: [deleted],
      hasMore: false,
    });
    await expect(repository.listSetLogs(randomUUID(), execution.executionId)).rejects.toMatchObject(
      { code: 'EXECUTION_NOT_FOUND' },
    );
    const completion = {
      schemaVersion: 2 as const,
      executionId: execution.executionId,
      expectedRevision: 4,
      status: 'finished' as const,
      endedAt: laterAt,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    const finished = await repository.completeExecution(athlete, completion);
    expect(finished).toMatchObject({ revision: 5, status: 'finished', endedAt: laterAt });
    expect(await repository.completeExecution(athlete, completion)).toEqual(finished);
    await expect(
      repository.completeExecution(athlete, {
        ...completion,
        status: 'stopped',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      repository.commandRestTimer(athlete, {
        action: 'finish',
        executionId: execution.executionId,
        timerId,
        expectedRevision: 3,
        at: laterAt,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await repository.readRestTimer(athlete, timerId))?.status).toBe('running');
    const executionHeadBeforeDelete = Number(
      await database.tenant(
        athlete,
        async (tx) =>
          (await tx.query('SELECT execution_revision FROM integrated_dependency_head')).rows[0]?.[
            'execution_revision'
          ],
      ),
    );
    expect(executionHeadBeforeDelete).toBeGreaterThan(0);
    await database.tenant(athlete, async (tx) => {
      expect(
        (await tx.query('SELECT set_revision FROM integrated_dependency_head')).rows[0],
      ).toEqual({ set_revision: 3 });
      expect(
        (await tx.query('SELECT count(*)::int AS count FROM activity_canonical')).rows[0]?.[
          'count'
        ],
      ).toBe(1);
      expect(
        (await tx.query('SELECT count(*)::int AS count FROM supplementary_set_log_revision'))
          .rows[0]?.['count'],
      ).toBe(3);
      expect(
        (
          await tx.query(
            "SELECT count(*)::int AS count FROM outbox WHERE topic LIKE 'supplementary.%'",
          )
        ).rows[0]?.['count'],
      ).toBeGreaterThan(0);
    });
    await createActivityRepository(database).deleteActivity(athlete, activity.activityId, {
      expectedRevision: 1,
    });
    expect(await repository.readExecution(athlete, execution.executionId)).toBeNull();
    expect(await repository.readSetLog(athlete, createLog.logId)).toBeNull();
    expect(await repository.readRestTimer(athlete, timerId)).toBeNull();
    await expect(repository.listRestTimers(athlete, execution.executionId)).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    });
    expect((await repository.listExecutions(athlete)).items).toEqual([]);
    await expect(repository.createExecution(athlete, command)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(repository.createSetLog(athlete, createLog)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(repository.correctSetLog(athlete, correctionCommand)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(repository.completeExecution(athlete, completion)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await database.tenant(athlete, async (tx) => {
      expect(
        Number(
          (await tx.query('SELECT execution_revision FROM integrated_dependency_head')).rows[0]?.[
            'execution_revision'
          ],
        ),
      ).toBeGreaterThan(executionHeadBeforeDelete);
      expect(
        (await tx.query('SELECT set_revision FROM integrated_dependency_head')).rows[0],
      ).toEqual({ set_revision: 4 });
      const receipt = await tx.query(
        'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
        [athlete, `supplementary-set:${createLog.idempotencyKey}`],
      );
      expect(receipt.rows[0]).toEqual({
        request: { purged: 'activity_deleted' },
        result: { purged: true },
      });
    });
  });

  it('records an explicitly stopped execution without inventing a performed set', async () => {
    const repository = createSupplementaryRepository(database, { now: () => new Date(happenedAt) });
    const athlete = randomUUID();
    const activity = await seededActivity(athlete);
    const started = await repository.createExecution(athlete, {
      schemaVersion: 2,
      executionId: randomUUID(),
      plannedSession: null,
      activity: { kind: 'match_existing', activityId: activity.activityId },
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const stopped = await repository.completeExecution(athlete, {
      schemaVersion: 2,
      executionId: started.executionId,
      expectedRevision: 1,
      status: 'stopped',
      endedAt: laterAt,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    expect(stopped.status).toBe('stopped');
    expect((await repository.listSetLogs(athlete, started.executionId)).items).toEqual([]);
  });

  it('erases linked supplementary content before Activity and Plan foreign keys', async () => {
    const repository = createSupplementaryRepository(database);
    const athlete = randomUUID();
    const savedExercise = await repository.saveExercise(athlete, exercise());
    const savedRoutine = await repository.saveRoutine(
      athlete,
      routine(savedExercise.definition.versionId),
    );
    const link = await seededPlan(athlete, savedRoutine.template.versionId);
    const activity = await seededActivity(athlete);
    await repository.createExecution(athlete, {
      schemaVersion: 2,
      executionId: randomUUID(),
      plannedSession: link,
      activity: { kind: 'match_existing', activityId: activity.activityId },
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    await database.exclusiveTenant(athlete, (tx) =>
      tx.query('SELECT public.erase_account($1)', [athlete]),
    );
    const result = await admin.query(
      'SELECT count(*)::int AS count FROM supplementary_exercise_version WHERE athlete_id=$1',
      [athlete],
    );
    expect(result.rows[0]?.['count']).toBe(0);
    expect(
      (await admin.query('SELECT * FROM supplementary_execution WHERE athlete_id=$1', [athlete]))
        .rowCount,
    ).toBe(0);
    expect(
      (await admin.query('SELECT * FROM activity_canonical WHERE athlete_id=$1', [athlete]))
        .rowCount,
    ).toBe(0);
  });
});
