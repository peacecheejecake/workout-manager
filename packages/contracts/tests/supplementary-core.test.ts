import { describe, expect, it } from 'vitest';

import {
  executionCreateCommandSchema,
  executionStatusCommandSchema,
  exerciseVersionReadSchema,
  exerciseVersionSaveCommandSchema,
  restTimerCommandSchema,
  restTimerStateSchema,
  routineTemplateReadSchema,
  routineTemplateSaveCommandSchema,
  setLogCorrectCommandSchema,
  setLogCreateCommandSchema,
  setLogDeleteCommandSchema,
  setLogReadSchema,
  supplementaryExecutionSchema,
  supplementaryExerciseVersionSchema,
  supplementarySessionLinkSchema,
  supplementarySpecSchema,
} from '../src/supplementary-core.js';

const start = '2026-09-18T09:00:00+09:00';
const end = '2026-09-18T09:01:00+09:00';
const key = 'supplementary-command-1';
const ids = {
  exercise: '11111111-1111-4111-8111-111111111111',
  exerciseVersion: '22222222-2222-4222-8222-222222222222',
  routine: '33333333-3333-4333-8333-333333333333',
  routineVersion: '44444444-4444-4444-8444-444444444444',
  planVersion: '55555555-5555-4555-8555-555555555555',
  activity: '66666666-6666-4666-8666-666666666666',
  execution: '77777777-7777-4777-8777-777777777777',
  log: '88888888-8888-4888-8888-888888888888',
  revision: '99999999-9999-4999-8999-999999999999',
  timer: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nextVersion: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  otherActivity: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const datum = (unit: string, value: number | null) => ({
  unit,
  value,
  status: value === null ? 'unknown' : 'reported',
  evidenceIds: [],
});
const target = {
  id: 'target-1',
  exerciseVersionId: ids.exerciseVersion,
  side: 'left',
  count: {
    target: { min: 8, max: 10, unit: 'count', basis: 'user_confirmed', evidenceIds: [] },
    definition: { kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' },
  },
  durationSeconds: null,
  externalResistance: { kind: 'no_added_load' },
  restAfterSeconds: 60,
  tempo: null,
  effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
};
const spec = {
  schemaVersion: 2,
  kind: 'supplementary',
  routineVersionId: ids.routineVersion,
  blocks: [
    {
      id: 'block-1',
      mode: 'single',
      rounds: 2,
      sets: [target],
      restBetweenRoundsSeconds: null,
    },
  ],
};
const definition = {
  schemaVersion: 2,
  exerciseId: ids.exercise,
  versionId: ids.exerciseVersion,
  name: 'Single-leg balance',
  family: 'balance_stability',
  equipment: ['bodyweight'],
  tags: ['balance'],
  countDefinitions: [{ kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' }],
  mediaAssetIds: [],
  resourceVersionIds: [],
  reviewState: 'unreviewed',
  description: 'User-defined movement',
  safetyNotes: '',
  supportedMetrics: ['count', 'duration', 'effort'],
  createdAt: start,
};
const template = {
  schemaVersion: 2,
  routineId: ids.routine,
  versionId: ids.routineVersion,
  title: 'Balance routine',
  purpose: 'User-defined practice',
  requiredEquipment: ['bodyweight'],
  spec,
  createdAt: start,
};
const plannedSession = {
  schemaVersion: 2,
  plannedSessionId: 'session-1',
  planVersionId: ids.planVersion,
  content: { kind: 'routine_version', routineVersionId: ids.routineVersion },
};
const values = {
  targetSetId: 'target-1',
  blockId: 'block-1',
  roundIndex: 1,
  exerciseVersionId: ids.exerciseVersion,
  side: 'left',
  state: 'partial',
  count: {
    actual: datum('count', 4),
    definition: { kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' },
  },
  durationSeconds: datum('s', null),
  externalResistance: { kind: 'no_added_load' },
  effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
  occurredAt: start,
  reason: null,
};
const createSetLog = {
  schemaVersion: 2,
  executionId: ids.execution,
  logId: ids.log,
  expectedExecutionRevision: 1,
  idempotencyKey: key,
  confirmation: 'user_confirmed',
  values,
};

describe('supplementary catalog and frozen planning links', () => {
  it('accepts independent family, equipment, side, count definition and zero RIR', () => {
    expect(supplementaryExerciseVersionSchema.parse(definition)).toEqual(definition);
    expect(supplementarySpecSchema.parse(spec)).toEqual(spec);
    expect(
      exerciseVersionSaveCommandSchema.safeParse({
        definition,
        expectedVersionId: null,
        idempotencyKey: key,
        confirmed: true,
      }).success,
    ).toBe(true);
  });

  it('rejects conflicting metric/definition and forged or unknown catalog fields', () => {
    expect(
      supplementaryExerciseVersionSchema.safeParse({
        ...definition,
        supportedMetrics: ['duration'],
      }).success,
    ).toBe(false);
    expect(
      supplementaryExerciseVersionSchema.safeParse({
        ...definition,
        countDefinitions: [definition.countDefinitions[0], definition.countDefinitions[0]],
      }).success,
    ).toBe(false);
    expect(
      supplementaryExerciseVersionSchema.safeParse({
        ...definition,
        countDefinitions: [],
      }).success,
    ).toBe(false);
    expect(
      supplementaryExerciseVersionSchema.safeParse({ ...definition, approved: true }).success,
    ).toBe(false);
    expect(
      exerciseVersionSaveCommandSchema.safeParse({
        definition: { ...definition, reviewState: 'reviewed' },
        expectedVersionId: null,
        idempotencyKey: key,
        confirmed: true,
      }).success,
    ).toBe(false);
  });

  it('uses each exercise head version ID for CAS and rejects non-UUID persisted IDs', () => {
    const command = {
      definition,
      expectedVersionId: ids.nextVersion,
      idempotencyKey: key,
      confirmed: true,
    };
    expect(exerciseVersionSaveCommandSchema.safeParse(command).success).toBe(true);
    expect(
      exerciseVersionSaveCommandSchema.safeParse({
        ...command,
        expectedVersionId: ids.exerciseVersion,
      }).success,
    ).toBe(false);
    expect(
      exerciseVersionSaveCommandSchema.safeParse({
        ...command,
        expectedVersionId: 'not-a-uuid',
      }).success,
    ).toBe(false);
    expect(
      supplementaryExerciseVersionSchema.safeParse({ ...definition, exerciseId: 'exercise-1' })
        .success,
    ).toBe(false);
    expect(exerciseVersionReadSchema.safeParse({ definition, version: 1 }).success).toBe(true);
    expect(exerciseVersionReadSchema.safeParse({ definition, version: 0 }).success).toBe(false);
  });

  it('requires a version-matched immutable routine and unique structured target IDs', () => {
    expect(
      routineTemplateSaveCommandSchema.safeParse({
        template,
        expectedVersionId: null,
        idempotencyKey: key,
        confirmed: true,
      }).success,
    ).toBe(true);
    expect(
      routineTemplateSaveCommandSchema.safeParse({
        template: { ...template, versionId: ids.nextVersion },
        expectedVersionId: ids.routineVersion,
        idempotencyKey: key,
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      supplementarySpecSchema.safeParse({
        ...spec,
        blocks: [{ ...spec.blocks[0], sets: [target, target] }],
      }).success,
    ).toBe(false);
    expect(
      supplementarySpecSchema.safeParse({
        ...spec,
        blocks: [{ ...spec.blocks[0], sets: [{ ...target, count: null }] }],
      }).success,
    ).toBe(false);
  });

  it('uses the routine head version ID and bounds local block and set IDs', () => {
    const command = {
      template,
      expectedVersionId: ids.nextVersion,
      idempotencyKey: key,
      confirmed: true,
    };
    expect(routineTemplateSaveCommandSchema.safeParse(command).success).toBe(true);
    expect(
      routineTemplateSaveCommandSchema.safeParse({
        ...command,
        expectedVersionId: ids.routineVersion,
      }).success,
    ).toBe(false);
    expect(
      routineTemplateSaveCommandSchema.safeParse({ ...command, expectedVersionId: 'old-routine' })
        .success,
    ).toBe(false);
    expect(
      supplementarySpecSchema.safeParse({
        ...spec,
        blocks: [{ ...spec.blocks[0], id: 'x'.repeat(201) }],
      }).success,
    ).toBe(false);
    expect(
      supplementarySpecSchema.safeParse({
        ...spec,
        blocks: [{ ...spec.blocks[0], sets: [{ ...target, id: 'x'.repeat(201) }] }],
      }).success,
    ).toBe(false);
    expect(
      supplementarySpecSchema.safeParse({
        ...spec,
        blocks: [{ ...spec.blocks[0], sets: [{ ...target, exerciseVersionId: 'version-1' }] }],
      }).success,
    ).toBe(false);
    expect(routineTemplateReadSchema.safeParse({ template, version: 1 }).success).toBe(true);
  });

  it('preserves per-side counts, unknown resistance and known zero assistance', () => {
    expect(supplementarySpecSchema.parse(spec).blocks[0]?.sets[0]?.count?.definition.basis).toBe(
      'per_side',
    );
    expect(
      supplementarySpecSchema.safeParse({
        ...spec,
        blocks: [
          {
            ...spec.blocks[0],
            sets: [
              {
                ...target,
                externalResistance: { kind: 'assisted', assistanceKg: datum('kg', 0) },
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      supplementarySpecSchema.safeParse({
        ...spec,
        blocks: [
          { ...spec.blocks[0], sets: [{ ...target, externalResistance: { kind: 'unknown' } }] },
        ],
      }).success,
    ).toBe(true);
  });

  it('keeps supplementary content in a separate explicit training session link', () => {
    expect(supplementarySessionLinkSchema.parse(plannedSession)).toEqual(plannedSession);
    expect(
      supplementarySessionLinkSchema.safeParse({
        ...plannedSession,
        content: { kind: 'embedded', spec: { ...spec, routineVersionId: null } },
      }).success,
    ).toBe(true);
    expect(
      supplementarySessionLinkSchema.safeParse({
        ...plannedSession,
        content: { kind: 'embedded', spec },
      }).success,
    ).toBe(false);
    expect(
      supplementarySessionLinkSchema.safeParse({ ...plannedSession, planVersionId: 'old-plan' })
        .success,
    ).toBe(false);
    expect(
      supplementarySessionLinkSchema.safeParse({
        ...plannedSession,
        content: { kind: 'routine_version', routineVersionId: 'latest' },
      }).success,
    ).toBe(false);
  });
});

describe('canonical execution and set actuals', () => {
  it('links one execution to one existing canonical activity', () => {
    const command = {
      schemaVersion: 2,
      executionId: ids.execution,
      plannedSession,
      activity: { kind: 'match_existing', activityId: ids.activity },
      idempotencyKey: key,
      confirmed: true,
    };
    expect(executionCreateCommandSchema.parse(command)).toEqual(command);
    const execution = {
      schemaVersion: 2,
      executionId: ids.execution,
      activityId: ids.activity,
      plannedSession,
      revision: 1,
      status: 'active',
      startedAt: start,
      endedAt: null,
    };
    expect(supplementaryExecutionSchema.parse(execution)).toEqual(execution);
    expect(
      supplementaryExecutionSchema.safeParse({ ...execution, secondActivityId: ids.otherActivity })
        .success,
    ).toBe(false);
    expect(
      supplementaryExecutionSchema.safeParse({ ...execution, status: 'finished', endedAt: null })
        .success,
    ).toBe(false);
    expect(
      executionCreateCommandSchema.safeParse({
        ...command,
        activity: { kind: 'match_existing', activityId: 'activity-1' },
      }).success,
    ).toBe(false);
  });

  it('requires a strength Activity when execution creates a manual canonical row', () => {
    const command = {
      schemaVersion: 2,
      executionId: ids.execution,
      plannedSession: null,
      activity: {
        kind: 'create_manual',
        values: {
          title: 'Balance set',
          kind: 'strength',
          startedAt: start,
          durationSeconds: null,
          durationKind: 'unknown',
          timezone: 'Asia/Seoul',
          distanceMeters: null,
        },
        report: { sessionRpe: null, note: null, planLink: null },
      },
      idempotencyKey: key,
      confirmed: true,
    };
    expect(executionCreateCommandSchema.safeParse(command).success).toBe(true);
    expect(
      executionCreateCommandSchema.safeParse({
        ...command,
        activity: { ...command.activity, values: { ...command.activity.values, kind: 'running' } },
      }).success,
    ).toBe(false);
    expect(
      executionCreateCommandSchema.safeParse({
        ...command,
        activity: {
          ...command.activity,
          report: {
            ...command.activity.report,
            planLink: {
              planVersionId: '00000000-0000-4000-8000-000000000001',
              sessionId: 'other-session',
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('requires explicit revision-checked confirmation to finish or stop an execution', () => {
    const command = {
      schemaVersion: 2,
      executionId: ids.execution,
      expectedRevision: 3,
      status: 'finished',
      endedAt: end,
      idempotencyKey: key,
      confirmed: true,
    };
    expect(executionStatusCommandSchema.parse(command)).toEqual(command);
    expect(executionStatusCommandSchema.safeParse({ ...command, status: 'stopped' }).success).toBe(
      true,
    );
    expect(executionStatusCommandSchema.safeParse({ ...command, status: 'active' }).success).toBe(
      false,
    );
    expect(executionStatusCommandSchema.safeParse({ ...command, confirmed: false }).success).toBe(
      false,
    );
    expect(
      executionStatusCommandSchema.safeParse({ ...command, expectedRevision: 0 }).success,
    ).toBe(false);
  });

  it('separates draft, partial, skipped and stopped instead of copying planned reps', () => {
    expect(setLogCreateCommandSchema.parse(createSetLog)).toEqual(createSetLog);
    const unconfirmed = {
      ...createSetLog,
      confirmation: 'draft',
      values: { ...values, state: 'unconfirmed', count: null },
    };
    expect(setLogCreateCommandSchema.safeParse(unconfirmed).success).toBe(true);
    expect(
      setLogCreateCommandSchema.safeParse({ ...unconfirmed, confirmation: 'user_confirmed' })
        .success,
    ).toBe(false);
    expect(
      setLogCreateCommandSchema.safeParse({
        ...createSetLog,
        values: { ...values, state: 'performed', count: null },
      }).success,
    ).toBe(false);
    expect(
      setLogCreateCommandSchema.safeParse({
        ...createSetLog,
        values: { ...values, state: 'confirmed_skipped' },
      }).success,
    ).toBe(false);
    expect(
      setLogCreateCommandSchema.safeParse({
        ...createSetLog,
        values: { ...values, state: 'stopped', reason: null },
      }).success,
    ).toBe(false);
    expect(setLogCreateCommandSchema.safeParse({ ...createSetLog, logId: 'log-1' }).success).toBe(
      false,
    );
    expect(
      setLogCreateCommandSchema.safeParse({
        ...createSetLog,
        values: { ...values, targetSetId: 'x'.repeat(201) },
      }).success,
    ).toBe(false);
  });

  it('requires revision checks for corrections and deletion, and distinguishes tombstones', () => {
    expect(
      setLogCorrectCommandSchema.safeParse({
        ...createSetLog,
        expectedExecutionRevision: undefined,
        expectedRevision: 1,
      }).success,
    ).toBe(false);
    const correction = {
      schemaVersion: 2,
      executionId: ids.execution,
      logId: ids.log,
      expectedRevision: 1,
      idempotencyKey: key,
      confirmation: 'user_confirmed',
      values,
    };
    expect(setLogCorrectCommandSchema.parse(correction)).toEqual(correction);
    expect(
      setLogDeleteCommandSchema.safeParse({
        schemaVersion: 2,
        executionId: ids.execution,
        logId: ids.log,
        expectedRevision: 2,
        idempotencyKey: key,
        confirmed: true,
        reason: 'Incorrect exercise',
      }).success,
    ).toBe(true);
    expect(
      setLogReadSchema.safeParse({
        status: 'deleted',
        executionId: ids.execution,
        logId: ids.log,
        revision: 3,
        deletedAt: end,
      }).success,
    ).toBe(true);
    expect(
      setLogReadSchema.safeParse({
        status: 'active',
        current: {
          ...values,
          state: 'performed',
          count: null,
          logId: ids.log,
          revisionId: ids.revision,
          activityId: ids.activity,
          executionId: ids.execution,
          revision: 1,
          source: 'user',
          recordedAt: end,
        },
      }).success,
    ).toBe(false);
  });
});

describe('reference-time rest timer', () => {
  it('accepts pause/resume with expected revision and never carries set actuals', () => {
    const timer = {
      timerId: ids.timer,
      executionId: ids.execution,
      revision: 1,
      durationSeconds: 60,
      startedAt: start,
      deadlineAt: end,
      pausedAt: null,
      remainingWhenPausedSeconds: null,
      status: 'running',
    };
    expect(restTimerStateSchema.parse(timer)).toEqual(timer);
    expect(
      restTimerStateSchema.safeParse({
        ...timer,
        status: 'paused',
        deadlineAt: null,
        pausedAt: start,
        remainingWhenPausedSeconds: 60,
      }).success,
    ).toBe(true);
    expect(
      restTimerCommandSchema.safeParse({
        action: 'pause',
        executionId: ids.execution,
        timerId: ids.timer,
        expectedRevision: 1,
        at: start,
        idempotencyKey: key,
      }).success,
    ).toBe(true);
    expect(
      restTimerCommandSchema.safeParse({
        action: 'resume',
        executionId: ids.execution,
        timerId: ids.timer,
        at: end,
        idempotencyKey: key,
      }).success,
    ).toBe(false);
    expect(restTimerStateSchema.safeParse({ ...timer, setLogId: 'made-up' }).success).toBe(false);
    expect(restTimerStateSchema.safeParse({ ...timer, deadlineAt: start }).success).toBe(false);
    expect(restTimerStateSchema.safeParse({ ...timer, timerId: 'timer-1' }).success).toBe(false);
    expect(
      restTimerCommandSchema.safeParse({
        action: 'start',
        executionId: ids.execution,
        timerId: ids.timer,
        durationSeconds: 86_401,
        at: start,
        idempotencyKey: key,
      }).success,
    ).toBe(false);
  });
});
