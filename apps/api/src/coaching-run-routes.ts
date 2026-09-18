import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  coachingRunCreateCommandV1Schema,
  coachingRunListQuerySchema,
  coachingRunListSchema,
  coachingRunV1Schema,
} from '@workout/contracts/coaching-runs';
import {
  CoachingRunError,
  type CoachingRunRepository,
} from '@workout/server-persistence/coaching-runs';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const threadParams = z.strictObject({ threadId: uuid });
const runParams = z.strictObject({ runId: uuid });

function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (!(error instanceof CoachingRunError)) return undefined;
    const statusCode = ['THREAD_NOT_FOUND', 'RUN_NOT_FOUND'].includes(error.code)
      ? 404
      : error.code === 'EVIDENCE_UNAVAILABLE'
        ? 422
        : 409;
    return new ProductRequestError(statusCode, error.code);
  });
}

export function registerCoachingRunRoutes(
  routes: FastifyInstance,
  repository: CoachingRunRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/coaching-threads/:threadId/runs', { bodyLimit: 16 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { threadId } = input(threadParams, request.params);
    const body = input(
      coachingRunCreateCommandV1Schema.omit({ idempotencyKey: true }),
      request.body,
    );
    const payload = input(coachingRunCreateCommandV1Schema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return coachingRunV1Schema.parse(
      await execute(() => repository.create(principal(request).athleteId, threadId, payload)),
    );
  });

  routes.get('/coaching-threads/:threadId/runs', async (request) => {
    const { threadId } = input(threadParams, request.params);
    const query = input(coachingRunListQuerySchema, request.query);
    const result = await execute(() =>
      repository.list(principal(request).athleteId, threadId, query),
    );
    if (!result) throw new ProductRequestError(404, 'THREAD_NOT_FOUND');
    return coachingRunListSchema.parse(result);
  });

  routes.get('/coaching-runs/:runId', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runParams, request.params);
    const result = await execute(() => repository.read(principal(request).athleteId, runId));
    if (!result) throw new ProductRequestError(404, 'RUN_NOT_FOUND');
    return coachingRunV1Schema.parse(result);
  });

  routes.post('/coaching-runs/:runId/cancel', async (request) => {
    input(emptyQuery, request.query);
    if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
    const { runId } = input(runParams, request.params);
    const result = await execute(() => repository.cancel(principal(request).athleteId, runId));
    if (!result) throw new ProductRequestError(404, 'RUN_NOT_FOUND');
    return coachingRunV1Schema.parse(result);
  });
}
