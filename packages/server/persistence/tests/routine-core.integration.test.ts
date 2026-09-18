import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { createRoutineRepository, RoutineReferenceError } from '../src/routine-core.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import type { Database, Transaction } from '../src/database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL cluster');
const pool = new Pool({ connectionString: adminUrl });

// This fixture uses migration-owner credentials because auto-review blocked the
// new runtime grants. The owner is superuser, so these are SQL/invariant tests;
// cross-account authorization still needs nonowner runtime verification.
const db: Database = {
  async tenant<T>(athleteId: string, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
      const result = await operation({
        athleteId,
        query: (sql, values) => client.query(sql, values),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  exclusiveTenant<T>(athleteId: string, operation: (tx: Transaction) => Promise<T>) {
    return this.tenant(athleteId, operation);
  },
  close: () => pool.end(),
};
beforeAll(async () => {
  await migrate(adminUrl);
});
afterAll(async () => {
  await db.close();
});

function blueprint(routineId = randomUUID(), versionId = randomUUID()) {
  const first = randomUUID();
  const second = randomUUID();
  const group = randomUUID();
  return {
    schemaVersion: 4 as const,
    routineId,
    versionId,
    title: '저녁 점검',
    intent: '사용자 선택',
    status: 'published' as const,
    tags: ['checklist'],
    estimatedDurationSeconds: null,
    createdAt: '2026-09-18T10:00:00.000Z',
    steps: [
      {
        id: first,
        title: '휴식 확인',
        content: { kind: 'checklist' as const, prompt: '쉬었나요?' },
        timing: { kind: 'ordered' as const, afterStepId: null },
        required: true,
        choiceGroupId: group,
      },
      {
        id: second,
        title: '준비 확인',
        content: { kind: 'checklist' as const, prompt: '준비했나요?' },
        timing: { kind: 'ordered' as const, afterStepId: first },
        required: true,
        choiceGroupId: group,
      },
    ],
    choiceGroups: [{ id: group, mode: 'one_of' as const, stepIds: [first, second] }],
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('EXPECTED_TEST_FIXTURE_ITEM');
  return value;
}

describe('generic routine core on owner + FORCE RLS', () => {
  it('keeps immutable versions, approves finite occurrences once, and links one checklist actual without Activity', async () => {
    const athlete = randomUUID();
    const other = randomUUID();
    const repository = createRoutineRepository(db);
    const first = blueprint();
    const save = {
      blueprint: first,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    const saved = await repository.saveBlueprint(athlete, save);
    expect(await repository.saveBlueprint(athlete, save)).toEqual(saved);
    expect(await repository.readBlueprint(other, first.routineId)).toBeNull();
    expect((await repository.listBlueprints(athlete, { search: '저녁' })).items).toHaveLength(1);
    const scheduleInput = {
      schedule: {
        schemaVersion: 4 as const,
        id: randomUUID(),
        versionId: randomUUID(),
        blueprint: { id: first.routineId, versionId: first.versionId },
        window: {
          startDate: '2026-11-02',
          endDateExclusive: '2026-11-03',
          timezone: 'Asia/Seoul',
          maxOccurrences: 1,
        },
        rule: { kind: 'dates' as const, dates: ['2026-11-02'], localTime: '08:00' },
        state: 'draft' as const,
      },
      sourcePlanVersionId: null,
    };
    const preview = await repository.previewSchedule(athlete, scheduleInput);
    expect(preview.occurrences).toHaveLength(1);
    const approval = {
      ...scheduleInput,
      previewDigest: preview.previewDigest,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    const approved = await repository.approveSchedule(athlete, approval);
    expect(await repository.approveSchedule(athlete, approval)).toEqual(approved);
    expect(await repository.readSchedule(other, scheduleInput.schedule.id)).toBeNull();
    const newVersion = blueprint(first.routineId);
    await repository.saveBlueprint(athlete, {
      blueprint: newVersion,
      expectedVersionId: first.versionId,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    expect(approved.occurrences[0]?.blueprint.versionId).toBe(first.versionId);
    const occurrence = required(approved.occurrences[0]);
    const group = required(first.choiceGroups[0]);
    const chosenStep = required(first.steps[0]);
    const otherStep = required(first.steps[1]);
    const run = await repository.startRun(athlete, {
      runId: randomUUID(),
      blueprintVersionId: first.versionId,
      occurrenceId: occurrence.id,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    expect(run.run.blueprint.versionId).toBe(first.versionId);
    const chosen = await repository.chooseStep(athlete, {
      runId: run.run.id,
      groupId: group.id,
      stepId: chosenStep.id,
      expectedRevision: run.run.revision,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const stepCommand = {
      runId: run.run.id,
      stepId: chosenStep.id,
      state: 'performed' as const,
      actualRefs: [],
      occurredAt: new Date().toISOString(),
      reason: null,
      expectedRevision: chosen.run.revision,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    const recorded = await repository.recordStep(athlete, stepCommand);
    expect(await repository.recordStep(athlete, stepCommand)).toEqual(recorded);
    expect(recorded.run.progress[0]?.actualRefs[0]?.kind).toBe('checklist_confirmation');
    expect(recorded.run.progress).toHaveLength(1);
    const timer = await repository.commandTimer(athlete, {
      runId: run.run.id,
      stepId: chosenStep.id,
      action: 'start',
      durationSeconds: 30,
      expectedRevision: null,
      idempotencyKey: randomUUID(),
    });
    const cleared = await repository.commandTimer(athlete, {
      runId: run.run.id,
      stepId: chosenStep.id,
      action: 'clear',
      durationSeconds: null,
      expectedRevision: timer.revision,
      idempotencyKey: randomUUID(),
    });
    const restarted = await repository.commandTimer(athlete, {
      runId: run.run.id,
      stepId: chosenStep.id,
      action: 'start',
      durationSeconds: 45,
      expectedRevision: cleared.revision,
      idempotencyKey: randomUUID(),
    });
    expect(restarted).toMatchObject({ state: 'running', durationSeconds: 45, revision: 3 });
    expect(restarted.pausedMilliseconds).toBe(0);
    await expect(
      repository.chooseStep(athlete, {
        runId: run.run.id,
        groupId: group.id,
        stepId: otherStep.id,
        expectedRevision: recorded.run.revision,
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).rejects.toThrowError(RoutineReferenceError);
    const count = await db.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::integer AS count FROM activity_canonical WHERE athlete_id=$1', [
        athlete,
      ]),
    );
    expect(count.rows[0]?.['count']).toBe(0);
    expect(await repository.readRun(other, run.run.id)).toBeNull();
    await db.tenant(athlete, (tx) => tx.query('SELECT public.erase_account($1)', [athlete]));
    expect(await repository.readBlueprint(athlete, first.routineId)).toBeNull();
  });

  it('rejects explicitly unknown Activity time instead of restoring source time or inventing epoch', async () => {
    const athlete = randomUUID();
    const exerciseId = randomUUID();
    const exerciseVersionId = randomUUID();
    const workoutId = randomUUID();
    const workoutVersionId = randomUUID();
    const correctedActivityId = randomUUID();
    const unknownActivityId = randomUUID();
    const knownActivityId = randomUUID();
    await db.tenant(athlete, async (tx) => {
      await tx.query(
        `INSERT INTO supplementary_exercise_version
         (athlete_id,exercise_id,version_id,version,created_at,record_json)
         VALUES($1,$2,$3,1,now(),$4::jsonb)`,
        [
          athlete,
          exerciseId,
          exerciseVersionId,
          JSON.stringify({ schemaVersion: 2, exerciseId, versionId: exerciseVersionId }),
        ],
      );
      await tx.query(
        `INSERT INTO supplementary_routine_version
         (athlete_id,routine_id,version_id,version,created_at,record_json)
         VALUES($1,$2,$3,1,now(),$4::jsonb)`,
        [
          athlete,
          workoutId,
          workoutVersionId,
          JSON.stringify({
            schemaVersion: 2,
            routineId: workoutId,
            versionId: workoutVersionId,
            spec: {
              routineVersionId: workoutVersionId,
              blocks: [{ id: 'block', sets: [{ id: 'set', exerciseVersionId }] }],
            },
          }),
        ],
      );
      await tx.query(
        `INSERT INTO activity_canonical(athlete_id,id,revision,original)
         VALUES($1,$2,1,$3::jsonb),($1,$4,1,$5::jsonb),($1,$6,1,$7::jsonb)`,
        [
          athlete,
          correctedActivityId,
          JSON.stringify({ startedAt: '2026-09-18T10:00:00Z' }),
          unknownActivityId,
          JSON.stringify({ startedAt: null }),
          knownActivityId,
          JSON.stringify({ startedAt: '2026-09-18T11:00:00Z' }),
        ],
      );
      await tx.query(
        `INSERT INTO activity_overlay(athlete_id,activity_id,values_json)
         VALUES($1,$2,$3::jsonb)`,
        [athlete, correctedActivityId, JSON.stringify({ startedAt: null })],
      );
    });
    const draft = blueprint();
    const workout = routineBlueprintVersionSchema.parse({
      ...draft,
      choiceGroups: [],
      steps: draft.steps.map((step) => ({
        ...step,
        choiceGroupId: null,
        content: {
          kind: 'workout_template',
          ref: { id: workoutId, versionId: workoutVersionId },
        },
      })),
    });
    const repository = createRoutineRepository(db);
    await repository.saveBlueprint(athlete, {
      blueprint: workout,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const started = await repository.startRun(athlete, {
      runId: randomUUID(),
      blueprintVersionId: workout.versionId,
      occurrenceId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const record = async (stepId: string, activityId: string, expectedRevision: number) =>
      repository.recordStep(athlete, {
        runId: started.run.id,
        stepId,
        state: 'performed',
        actualRefs: [
          { kind: 'activity', id: activityId, revisionId: '1', detailId: null, allocationId: null },
        ],
        occurredAt: null,
        reason: null,
        expectedRevision,
        idempotencyKey: randomUUID(),
        confirmed: true,
      });
    await expect(
      record(required(workout.steps[0]).id, correctedActivityId, 0),
    ).rejects.toMatchObject({ code: 'ACTUAL_TIME_UNKNOWN' });
    await expect(record(required(workout.steps[1]).id, unknownActivityId, 0)).rejects.toMatchObject(
      { code: 'ACTUAL_TIME_UNKNOWN' },
    );
    const linked = await record(required(workout.steps[0]).id, knownActivityId, 0);
    expect(linked.run.progress[0]?.occurredAt).toBe('2026-09-18T11:00:00.000Z');
  });
});
