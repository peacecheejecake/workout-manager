import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  stretchingExerciseReadSchema,
  stretchingExerciseSaveSchema,
  stretchLogCreateSchema,
  stretchPlannedTargetPageSchema,
  stretchLogCorrectSchema,
  stretchLogDeleteSchema,
  stretchLogPageSchema,
  stretchLogReadSchema,
} from '@workout/contracts/stretching';
import {
  StretchingReferenceError,
  type StretchingRepository,
} from '@workout/server-persistence/stretching';
import type { Principal } from './ports.js';
import { command, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const exercisePath = z.strictObject({ exerciseId: uuid });
const logPath = z.strictObject({ logId: uuid });
const logQuery = z.strictObject({ activityId: uuid.optional() });
const targetQuery = z.strictObject({ activityId: uuid });
const emptyQuery = z.strictObject({});
const bodyRecord = z.record(z.string(), z.unknown());
const exercisePage = z.strictObject({
  items: z.array(stretchingExerciseReadSchema).max(100),
  hasMore: z.boolean(),
});

function payload<T>(schema: z.ZodType<T>, body: unknown, additions: Record<string, unknown>): T {
  const value = input(bodyRecord, body);
  if (Object.keys(additions).some((key) => key in value))
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  return input(schema, { ...value, ...additions });
}
function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (!(error instanceof StretchingReferenceError)) return undefined;
    return new ProductRequestError(error.code.endsWith('_NOT_FOUND') ? 404 : 422, error.code);
  });
}
export function registerStretchingRoutes(
  routes: FastifyInstance,
  repository: StretchingRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/stretching/exercises', async (request) => {
    input(emptyQuery, request.query);
    return exercisePage.parse(await repository.listExercises(principal(request).athleteId));
  });
  routes.get('/stretching/exercises/:exerciseId', async (request) => {
    input(emptyQuery, request.query);
    const { exerciseId } = input(exercisePath, request.params);
    const found = await repository.readExercise(principal(request).athleteId, exerciseId);
    if (found === null) throw new ProductRequestError(404, 'EXERCISE_NOT_FOUND');
    return stretchingExerciseReadSchema.parse(found);
  });
  routes.post('/stretching/exercises', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = payload(stretchingExerciseSaveSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return stretchingExerciseReadSchema.parse(
      await execute(() => repository.saveExercise(principal(request).athleteId, body)),
    );
  });
  routes.get('/stretching/logs', async (request) => {
    const { activityId } = input(logQuery, request.query);
    return stretchLogPageSchema.parse(
      await execute(() => repository.listLogs(principal(request).athleteId, activityId ?? null)),
    );
  });
  routes.get('/stretching/targets', async (request) => {
    const { activityId } = input(targetQuery, request.query);
    return stretchPlannedTargetPageSchema.parse(
      await execute(() => repository.listTargets(principal(request).athleteId, activityId)),
    );
  });
  routes.get('/stretching/logs/:logId', async (request) => {
    input(emptyQuery, request.query);
    const { logId } = input(logPath, request.params);
    const found = await repository.readLog(principal(request).athleteId, logId);
    if (found === null) throw new ProductRequestError(404, 'STRETCH_LOG_NOT_FOUND');
    return stretchLogReadSchema.parse(found);
  });
  routes.post('/stretching/logs', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = payload(stretchLogCreateSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return stretchLogReadSchema.parse(
      await execute(() => repository.createLog(principal(request).athleteId, body)),
    );
  });
  routes.patch('/stretching/logs/:logId', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { logId } = input(logPath, request.params);
    const body = payload(stretchLogCorrectSchema, request.body, {
      logId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return stretchLogReadSchema.parse(
      await execute(() => repository.correctLog(principal(request).athleteId, body)),
    );
  });
  routes.delete('/stretching/logs/:logId', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { logId } = input(logPath, request.params);
    const body = payload(stretchLogDeleteSchema, request.body, {
      logId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return stretchLogReadSchema.parse(
      await execute(() => repository.deleteLog(principal(request).athleteId, body)),
    );
  });
}
