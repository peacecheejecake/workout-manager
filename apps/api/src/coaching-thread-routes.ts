import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  coachingThreadSchema,
  coachingThreadCreateSchema,
  coachingMessageAppendSchema,
  coachingMessageResultSchema,
  coachingThreadListQuerySchema,
  coachingThreadListSchema,
  coachingMessagesQuerySchema,
  coachingMessagesSchema,
} from '@workout/contracts/coaching-threads';
import {
  CoachingThreadError,
  type CoachingThreadRepository,
} from '@workout/server-persistence/coaching-threads';
import type { Principal } from './ports.js';
import { input, command, emptyQuery, ProductRequestError } from './product-boundary.js';
const params = z.strictObject({ threadId: z.uuid().transform((value) => value.toLowerCase()) });
function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (!(error instanceof CoachingThreadError)) return undefined;
    return new ProductRequestError(
      ['THREAD_NOT_FOUND', 'PLAN_VERSION_NOT_FOUND', 'SCOPE_NOT_FOUND'].includes(error.code)
        ? 404
        : 409,
      error.code,
    );
  });
}
export function registerCoachingThreadRoutes(
  routes: FastifyInstance,
  repository: CoachingThreadRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/coaching-threads', async (request) =>
    coachingThreadListSchema.parse(
      await execute(() =>
        repository.list(
          principal(request).athleteId,
          input(coachingThreadListQuerySchema, request.query),
        ),
      ),
    ),
  );
  routes.get('/coaching-threads/:threadId', async (request) => {
    input(emptyQuery, request.query);
    const { threadId } = input(params, request.params);
    const result = await execute(() => repository.read(principal(request).athleteId, threadId));
    if (!result) throw new ProductRequestError(404, 'THREAD_NOT_FOUND');
    return coachingThreadSchema.parse(result);
  });
  routes.get('/coaching-threads/:threadId/messages', async (request) => {
    const { threadId } = input(params, request.params);
    const query = input(coachingMessagesQuerySchema, request.query);
    const result = await execute(() =>
      repository.messages(principal(request).athleteId, threadId, query),
    );
    if (!result) throw new ProductRequestError(404, 'THREAD_NOT_FOUND');
    return coachingMessagesSchema.parse(result);
  });
  routes.post('/coaching-threads', { bodyLimit: 64 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(coachingThreadCreateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(coachingThreadCreateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return coachingMessageResultSchema.parse(
      await execute(() => repository.create(principal(request).athleteId, payload)),
    );
  });
  routes.post('/coaching-threads/:threadId/messages', { bodyLimit: 64 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { threadId } = input(params, request.params);
    const body = input(coachingMessageAppendSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(coachingMessageAppendSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return coachingMessageResultSchema.parse(
      await execute(() => repository.append(principal(request).athleteId, threadId, payload)),
    );
  });
}
