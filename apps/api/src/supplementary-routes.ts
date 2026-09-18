import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
} from '@workout/contracts/supplementary-core';
import {
  SupplementaryReferenceError,
  type SupplementaryRepository,
} from '@workout/server-persistence/supplementary-core';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const exercisePath = z.strictObject({ exerciseId: uuid });
const routinePath = z.strictObject({ routineId: uuid });
const routineVersionPath = z.strictObject({ versionId: uuid });
const executionPath = z.strictObject({ executionId: uuid });
const setPath = z.strictObject({ executionId: uuid, logId: uuid });
const timerPath = z.strictObject({ timerId: uuid });
const record = z.record(z.string(), z.unknown());
const exercisePage = z.strictObject({
  items: z.array(exerciseVersionReadSchema).max(100),
  hasMore: z.boolean(),
});
const routinePage = z.strictObject({
  items: z.array(routineTemplateReadSchema).max(100),
  hasMore: z.boolean(),
});
const executionPage = z.strictObject({
  items: z.array(supplementaryExecutionSchema).max(100),
  hasMore: z.boolean(),
});
const setPage = z.strictObject({
  items: z.array(setLogReadSchema).max(100),
  hasMore: z.boolean(),
});
const timerPage = z.strictObject({
  items: z.array(restTimerStateSchema).max(100),
  hasMore: z.boolean(),
});

function payload<T>(schema: z.ZodType<T>, body: unknown, additions: Record<string, unknown>): T {
  const value = input(record, body);
  if (Object.keys(additions).some((key) => key in value)) {
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  }
  return input(schema, { ...value, ...additions });
}
function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (!(error instanceof SupplementaryReferenceError)) return undefined;
    const statusCode = error.code.endsWith('_NOT_FOUND') ? 404 : 422;
    return new ProductRequestError(statusCode, error.code);
  });
}

export function registerSupplementaryRoutes(
  routes: FastifyInstance,
  repository: SupplementaryRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/supplementary/exercises', async (request) => {
    input(emptyQuery, request.query);
    return exercisePage.parse(await repository.listExercises(principal(request).athleteId));
  });
  routes.get('/supplementary/exercises/:exerciseId', async (request) => {
    input(emptyQuery, request.query);
    const { exerciseId } = input(exercisePath, request.params);
    const result = await repository.readExercise(principal(request).athleteId, exerciseId);
    if (result === null) throw new ProductRequestError(404, 'EXERCISE_NOT_FOUND');
    return exerciseVersionReadSchema.parse(result);
  });
  routes.post('/supplementary/exercises', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = payload(exerciseVersionSaveCommandSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return exerciseVersionReadSchema.parse(
      await execute(() => repository.saveExercise(principal(request).athleteId, body)),
    );
  });

  routes.get('/supplementary/routines', async (request) => {
    input(emptyQuery, request.query);
    return routinePage.parse(await repository.listRoutines(principal(request).athleteId));
  });
  routes.get('/supplementary/routines/:routineId', async (request) => {
    input(emptyQuery, request.query);
    const { routineId } = input(routinePath, request.params);
    const result = await repository.readRoutine(principal(request).athleteId, routineId);
    if (result === null) throw new ProductRequestError(404, 'ROUTINE_NOT_FOUND');
    return routineTemplateReadSchema.parse(result);
  });
  routes.get('/supplementary/routine-versions/:versionId', async (request) => {
    input(emptyQuery, request.query);
    const { versionId } = input(routineVersionPath, request.params);
    const result = await repository.readRoutineVersion(principal(request).athleteId, versionId);
    if (result === null) throw new ProductRequestError(404, 'ROUTINE_NOT_FOUND');
    return routineTemplateReadSchema.parse(result);
  });
  routes.post('/supplementary/routines', { bodyLimit: 1024 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = payload(routineTemplateSaveCommandSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineTemplateReadSchema.parse(
      await execute(() => repository.saveRoutine(principal(request).athleteId, body)),
    );
  });

  routes.get('/supplementary/executions', async (request) => {
    input(emptyQuery, request.query);
    return executionPage.parse(await repository.listExecutions(principal(request).athleteId));
  });
  routes.post('/supplementary/executions', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = payload(executionCreateCommandSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return supplementaryExecutionSchema.parse(
      await execute(() => repository.createExecution(principal(request).athleteId, body)),
    );
  });
  routes.get('/supplementary/executions/:executionId', async (request) => {
    input(emptyQuery, request.query);
    const { executionId } = input(executionPath, request.params);
    const result = await repository.readExecution(principal(request).athleteId, executionId);
    if (result === null) throw new ProductRequestError(404, 'EXECUTION_NOT_FOUND');
    return supplementaryExecutionSchema.parse(result);
  });
  routes.post('/supplementary/executions/:executionId/completion', async (request) => {
    input(emptyQuery, request.query);
    const { executionId } = input(executionPath, request.params);
    const body = payload(executionStatusCommandSchema, request.body, {
      executionId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return supplementaryExecutionSchema.parse(
      await execute(() => repository.completeExecution(principal(request).athleteId, body)),
    );
  });

  routes.get('/supplementary/executions/:executionId/sets', async (request) => {
    input(emptyQuery, request.query);
    const { executionId } = input(executionPath, request.params);
    return setPage.parse(
      await execute(() => repository.listSetLogs(principal(request).athleteId, executionId)),
    );
  });
  routes.post(
    '/supplementary/executions/:executionId/sets',
    { bodyLimit: 128 * 1024 },
    async (request) => {
      input(emptyQuery, request.query);
      const { executionId } = input(executionPath, request.params);
      const body = payload(setLogCreateCommandSchema, request.body, {
        executionId,
        idempotencyKey: request.headers['idempotency-key'],
      });
      return setLogReadSchema.parse(
        await execute(() => repository.createSetLog(principal(request).athleteId, body)),
      );
    },
  );
  routes.get('/supplementary/executions/:executionId/sets/:logId', async (request) => {
    input(emptyQuery, request.query);
    const { executionId, logId } = input(setPath, request.params);
    const result = await repository.readSetLog(principal(request).athleteId, logId);
    if (
      result === null ||
      (result.status === 'deleted' && result.executionId !== executionId) ||
      (result.status === 'active' && result.current.executionId !== executionId)
    ) {
      throw new ProductRequestError(404, 'SET_LOG_NOT_FOUND');
    }
    return setLogReadSchema.parse(result);
  });
  routes.patch(
    '/supplementary/executions/:executionId/sets/:logId',
    { bodyLimit: 128 * 1024 },
    async (request) => {
      input(emptyQuery, request.query);
      const { executionId, logId } = input(setPath, request.params);
      const body = payload(setLogCorrectCommandSchema, request.body, {
        executionId,
        logId,
        idempotencyKey: request.headers['idempotency-key'],
      });
      return setLogReadSchema.parse(
        await execute(() => repository.correctSetLog(principal(request).athleteId, body)),
      );
    },
  );
  routes.delete('/supplementary/executions/:executionId/sets/:logId', async (request) => {
    input(emptyQuery, request.query);
    const { executionId, logId } = input(setPath, request.params);
    const body = payload(setLogDeleteCommandSchema, request.body, {
      executionId,
      logId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return setLogReadSchema.parse(
      await execute(() => repository.deleteSetLog(principal(request).athleteId, body)),
    );
  });

  routes.post('/supplementary/rest-timers', async (request) => {
    input(emptyQuery, request.query);
    const body = payload(restTimerCommandSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return restTimerStateSchema.parse(
      await execute(() => repository.commandRestTimer(principal(request).athleteId, body)),
    );
  });
  routes.get('/supplementary/executions/:executionId/rest-timers', async (request) => {
    input(emptyQuery, request.query);
    const { executionId } = input(executionPath, request.params);
    return timerPage.parse(
      await execute(() => repository.listRestTimers(principal(request).athleteId, executionId)),
    );
  });
  routes.get('/supplementary/rest-timers/:timerId', async (request) => {
    input(emptyQuery, request.query);
    const { timerId } = input(timerPath, request.params);
    const result = await repository.readRestTimer(principal(request).athleteId, timerId);
    if (result === null) throw new ProductRequestError(404, 'TIMER_NOT_FOUND');
    return restTimerStateSchema.parse(result);
  });
}
