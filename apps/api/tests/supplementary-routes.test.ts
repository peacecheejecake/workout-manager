import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  exerciseVersionReadSchema,
  restTimerStateSchema,
  routineTemplateReadSchema,
  setLogReadSchema,
  supplementaryExecutionSchema,
} from '@workout/contracts/supplementary-core';
import { SupplementaryReferenceError } from '@workout/server-persistence/supplementary-core';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';

const base = '/bff/v1/supplementary';
const ids = {
  exercise: '11111111-1111-4111-8111-111111111111',
  exerciseVersion: '22222222-2222-4222-8222-222222222222',
  routine: '33333333-3333-4333-8333-333333333333',
  routineVersion: '44444444-4444-4444-8444-444444444444',
  activity: '55555555-5555-4555-8555-555555555555',
  execution: '66666666-6666-4666-8666-666666666666',
  log: '77777777-7777-4777-8777-777777777777',
  logRevision: '88888888-8888-4888-8888-888888888888',
  timer: '99999999-9999-4999-8999-999999999999',
  foreignExecution: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const startedAt = '2026-09-18T09:00:00+09:00';
const endedAt = '2026-09-18T09:01:00+09:00';
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'session-current',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'supplementary-command-1',
};
const datum = (unit: 'count' | 's', value: number | null) => ({
  unit,
  value,
  status: value === null ? 'unknown' : 'reported',
  evidenceIds: [],
});
const countDefinition = {
  kind: 'repetitions',
  basis: 'per_side',
  definitionId: 'reps-per-side-v1',
};
const exercise = exerciseVersionReadSchema.parse({
  definition: {
    schemaVersion: 2,
    exerciseId: ids.exercise,
    versionId: ids.exerciseVersion,
    name: 'Balance',
    family: 'balance_stability',
    equipment: ['bodyweight'],
    tags: [],
    countDefinitions: [countDefinition],
    mediaAssetIds: [],
    resourceVersionIds: [],
    reviewState: 'unreviewed',
    description: 'User-defined balance movement',
    safetyNotes: '',
    supportedMetrics: ['count'],
    createdAt: startedAt,
  },
  version: 1,
});
const routine = routineTemplateReadSchema.parse({
  template: {
    schemaVersion: 2,
    routineId: ids.routine,
    versionId: ids.routineVersion,
    title: 'Balance routine',
    purpose: '',
    requiredEquipment: ['bodyweight'],
    spec: {
      schemaVersion: 2,
      kind: 'supplementary',
      routineVersionId: ids.routineVersion,
      blocks: [
        {
          id: 'block-1',
          mode: 'single',
          rounds: 1,
          sets: [
            {
              id: 'target-1',
              exerciseVersionId: ids.exerciseVersion,
              side: 'left',
              count: {
                target: {
                  min: 8,
                  max: 10,
                  unit: 'count',
                  basis: 'user_confirmed',
                  evidenceIds: [],
                },
                definition: countDefinition,
              },
              durationSeconds: null,
              externalResistance: { kind: 'no_added_load' },
              restAfterSeconds: 60,
              tempo: null,
              effort: null,
            },
          ],
          restBetweenRoundsSeconds: null,
        },
      ],
    },
    createdAt: startedAt,
  },
  version: 1,
});
const execution = supplementaryExecutionSchema.parse({
  schemaVersion: 2,
  executionId: ids.execution,
  activityId: ids.activity,
  plannedSession: null,
  revision: 1,
  status: 'active',
  startedAt,
  endedAt: null,
});
const values = {
  targetSetId: null,
  blockId: null,
  roundIndex: null,
  exerciseVersionId: ids.exerciseVersion,
  side: 'left',
  state: 'partial',
  count: { actual: datum('count', 4), definition: countDefinition },
  durationSeconds: datum('s', null),
  externalResistance: { kind: 'no_added_load' },
  effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
  occurredAt: startedAt,
  reason: null,
};
const setLog = setLogReadSchema.parse({
  status: 'active',
  current: {
    ...values,
    logId: ids.log,
    revisionId: ids.logRevision,
    activityId: ids.activity,
    executionId: ids.execution,
    revision: 1,
    source: 'user',
    recordedAt: endedAt,
  },
});
if (setLog.status !== 'active') throw new Error('Expected an active set log fixture');
const timer = restTimerStateSchema.parse({
  timerId: ids.timer,
  executionId: ids.execution,
  revision: 1,
  durationSeconds: 60,
  startedAt,
  deadlineAt: endedAt,
  pausedAt: null,
  remainingWhenPausedSeconds: null,
  status: 'running',
});
const exerciseCommand = {
  definition: exercise.definition,
  expectedVersionId: null,
  confirmed: true,
};
const routineCommand = { template: routine.template, expectedVersionId: null, confirmed: true };
const executionCommand = {
  schemaVersion: 2,
  executionId: ids.execution,
  plannedSession: null,
  activity: { kind: 'match_existing', activityId: ids.activity },
  confirmed: true,
};
const completionCommand = {
  schemaVersion: 2,
  expectedRevision: 1,
  status: 'finished',
  endedAt,
  confirmed: true,
};
const setCreateCommand = {
  schemaVersion: 2,
  logId: ids.log,
  expectedExecutionRevision: 1,
  confirmation: 'user_confirmed',
  values,
};
const setCorrectCommand = {
  schemaVersion: 2,
  expectedRevision: 1,
  confirmation: 'user_confirmed',
  values,
};
const setDeleteCommand = {
  schemaVersion: 2,
  expectedRevision: 1,
  confirmed: true,
  reason: 'Incorrect record',
};
const timerCommand = {
  action: 'start',
  executionId: ids.execution,
  timerId: ids.timer,
  durationSeconds: 60,
  at: startedAt,
};

const apps: ReturnType<typeof createApi>[] = [];
function setup() {
  const supplementary = {
    saveExercise: vi.fn().mockResolvedValue(exercise),
    readExercise: vi.fn().mockResolvedValue(exercise),
    listExercises: vi.fn().mockResolvedValue({ items: [exercise], hasMore: false }),
    saveRoutine: vi.fn().mockResolvedValue(routine),
    readRoutine: vi.fn().mockResolvedValue(routine),
    readRoutineVersion: vi.fn().mockResolvedValue(routine),
    listRoutines: vi.fn().mockResolvedValue({ items: [routine], hasMore: false }),
    readSessionLink: vi.fn().mockResolvedValue(null),
    createExecution: vi.fn().mockResolvedValue(execution),
    completeExecution: vi.fn().mockResolvedValue(execution),
    readExecution: vi.fn().mockResolvedValue(execution),
    listExecutions: vi.fn().mockResolvedValue({ items: [execution], hasMore: false }),
    createSetLog: vi.fn().mockResolvedValue(setLog),
    correctSetLog: vi.fn().mockResolvedValue(setLog),
    deleteSetLog: vi.fn().mockResolvedValue(setLog),
    readSetLog: vi.fn().mockResolvedValue(setLog),
    listSetLogs: vi.fn().mockResolvedValue({ items: [setLog], hasMore: false }),
    commandRestTimer: vi.fn().mockResolvedValue(timer),
    readRestTimer: vi.fn().mockResolvedValue(timer),
    listRestTimers: vi.fn().mockResolvedValue({ items: [timer], hasMore: false }),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () => ({
        athleteId: 'owner',
        sessionId: 'session-current',
        csrfToken: headers['x-csrf-token'],
        method: 'cookie' as const,
      }),
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    supplementary,
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, supplementary };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it('takes idempotency keys only from headers and binds commands to the authenticated owner and path', async () => {
  const { app, supplementary } = setup();
  const cases = [
    {
      method: 'POST',
      url: `${base}/exercises`,
      payload: exerciseCommand,
      call: supplementary.saveExercise,
    },
    {
      method: 'POST',
      url: `${base}/routines`,
      payload: routineCommand,
      call: supplementary.saveRoutine,
    },
    {
      method: 'POST',
      url: `${base}/executions`,
      payload: executionCommand,
      call: supplementary.createExecution,
    },
    {
      method: 'POST',
      url: `${base}/executions/${ids.execution}/completion`,
      payload: completionCommand,
      call: supplementary.completeExecution,
    },
    {
      method: 'POST',
      url: `${base}/executions/${ids.execution}/sets`,
      payload: setCreateCommand,
      call: supplementary.createSetLog,
    },
    {
      method: 'PATCH',
      url: `${base}/executions/${ids.execution}/sets/${ids.log}`,
      payload: setCorrectCommand,
      call: supplementary.correctSetLog,
    },
    {
      method: 'DELETE',
      url: `${base}/executions/${ids.execution}/sets/${ids.log}`,
      payload: setDeleteCommand,
      call: supplementary.deleteSetLog,
    },
    {
      method: 'POST',
      url: `${base}/rest-timers`,
      payload: timerCommand,
      call: supplementary.commandRestTimer,
    },
  ] as const;
  for (const item of cases) {
    const response = await app.inject({ ...item, headers });
    expect(response.statusCode, `${item.method} ${item.url}`).toBe(200);
    expect(item.call).toHaveBeenCalledWith('owner', {
      ...item.payload,
      ...(item.url.includes('/completion') || item.url.includes('/sets')
        ? { executionId: ids.execution }
        : {}),
      ...(item.url.includes(`/sets/${ids.log}`) ? { logId: ids.log } : {}),
      idempotencyKey: headers['idempotency-key'],
    });
    const forged = await app.inject({
      method: item.method,
      url: item.url,
      headers,
      payload: { ...item.payload, idempotencyKey: 'body-key-forbidden' },
    });
    expect(forged.statusCode, `${item.method} ${item.url}`).toBe(400);
    expect(forged.json().error.code).toBe('INVALID_REQUEST');
    expect(item.call).toHaveBeenCalledTimes(1);
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/exercises`,
        headers: { ...headers, 'idempotency-key': '' },
        payload: exerciseCommand,
      })
    ).statusCode,
  ).toBe(400);
  expect(supplementary.saveExercise).toHaveBeenCalledTimes(1);
});

it('rejects body IDs that conflict with the route before a repository call', async () => {
  const { app, supplementary } = setup();
  const cases = [
    {
      method: 'POST',
      url: `${base}/executions/${ids.execution}/completion`,
      payload: { ...completionCommand, executionId: ids.foreignExecution },
      call: supplementary.completeExecution,
    },
    {
      method: 'POST',
      url: `${base}/executions/${ids.execution}/sets`,
      payload: { ...setCreateCommand, executionId: ids.foreignExecution },
      call: supplementary.createSetLog,
    },
    {
      method: 'PATCH',
      url: `${base}/executions/${ids.execution}/sets/${ids.log}`,
      payload: { ...setCorrectCommand, logId: ids.timer },
      call: supplementary.correctSetLog,
    },
    {
      method: 'DELETE',
      url: `${base}/executions/${ids.execution}/sets/${ids.log}`,
      payload: { ...setDeleteCommand, executionId: ids.foreignExecution },
      call: supplementary.deleteSetLog,
    },
  ] as const;
  for (const item of cases) {
    const response = await app.inject({ ...item, headers });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(item.call).not.toHaveBeenCalled();
  }
});

it('scopes list and read routes and checks a set against its parent execution', async () => {
  const { app, supplementary } = setup();
  const reads = [
    [`${base}/exercises`, supplementary.listExercises, [exercise], []],
    [`${base}/exercises/${ids.exercise}`, supplementary.readExercise, exercise, [ids.exercise]],
    [`${base}/routines`, supplementary.listRoutines, [routine], []],
    [`${base}/routines/${ids.routine}`, supplementary.readRoutine, routine, [ids.routine]],
    [
      `${base}/routine-versions/${ids.routineVersion}`,
      supplementary.readRoutineVersion,
      routine,
      [ids.routineVersion],
    ],
    [`${base}/executions`, supplementary.listExecutions, [execution], []],
    [
      `${base}/executions/${ids.execution}`,
      supplementary.readExecution,
      execution,
      [ids.execution],
    ],
    [
      `${base}/executions/${ids.execution}/sets`,
      supplementary.listSetLogs,
      [setLog],
      [ids.execution],
    ],
    [
      `${base}/executions/${ids.execution}/sets/${ids.log}`,
      supplementary.readSetLog,
      setLog,
      [ids.log],
    ],
    [
      `${base}/executions/${ids.execution}/rest-timers`,
      supplementary.listRestTimers,
      [timer],
      [ids.execution],
    ],
    [`${base}/rest-timers/${ids.timer}`, supplementary.readRestTimer, timer, [ids.timer]],
  ] as const;
  for (const [url, call, result, args] of reads) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode, url).toBe(200);
    expect(response.json()).toEqual(
      Array.isArray(result) ? { items: result, hasMore: false } : result,
    );
    expect(call).toHaveBeenCalledWith('owner', ...args);
  }
  for (const foreign of [
    { status: 'active', current: { ...setLog.current, executionId: ids.foreignExecution } },
    {
      status: 'deleted',
      executionId: ids.foreignExecution,
      logId: ids.log,
      revision: 2,
      deletedAt: endedAt,
    },
  ]) {
    supplementary.readSetLog.mockResolvedValueOnce(foreign);
    const response = await app.inject({
      url: `${base}/executions/${ids.execution}/sets/${ids.log}`,
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('SET_LOG_NOT_FOUND');
  }
});

it('maps malformed requests, missing references, invalid links, and concurrency conflicts to stable errors', async () => {
  const { app, supplementary } = setup();
  expect((await app.inject({ url: `${base}/exercises?unexpected=1`, headers })).statusCode).toBe(
    400,
  );
  expect((await app.inject({ url: `${base}/exercises/not-a-uuid`, headers })).statusCode).toBe(400);
  expect(supplementary.listExercises).not.toHaveBeenCalled();
  expect(supplementary.readExercise).not.toHaveBeenCalled();

  supplementary.readExercise.mockResolvedValueOnce(null);
  const missing = await app.inject({ url: `${base}/exercises/${ids.exercise}`, headers });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe('EXERCISE_NOT_FOUND');

  supplementary.createExecution.mockRejectedValueOnce(
    new SupplementaryReferenceError('ACTIVITY_NOT_FOUND'),
  );
  const noActivity = await app.inject({
    method: 'POST',
    url: `${base}/executions`,
    headers,
    payload: executionCommand,
  });
  expect(noActivity.statusCode).toBe(404);
  expect(noActivity.json().error.code).toBe('ACTIVITY_NOT_FOUND');

  supplementary.createSetLog.mockRejectedValueOnce(
    new SupplementaryReferenceError('TARGET_LINK_INVALID'),
  );
  const badTarget = await app.inject({
    method: 'POST',
    url: `${base}/executions/${ids.execution}/sets`,
    headers,
    payload: setCreateCommand,
  });
  expect(badTarget.statusCode).toBe(422);
  expect(badTarget.json().error.code).toBe('TARGET_LINK_INVALID');

  supplementary.saveRoutine.mockRejectedValueOnce(new PersistenceConflict('REVISION_CONFLICT'));
  const stale = await app.inject({
    method: 'POST',
    url: `${base}/routines`,
    headers,
    payload: routineCommand,
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe('REVISION_CONFLICT');
});
