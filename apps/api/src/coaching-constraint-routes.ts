import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  coachingConstraintListSchema,
  coachingConstraintCreateSchema,
  coachingConstraintUpdateSchema,
  coachingConstraintDeleteSchema,
  coachingConstraintCommandResultSchema,
} from '@workout/contracts/coaching-constraints';
import {
  CoachingConstraintError,
  type CoachingConstraintRepository,
} from '@workout/server-persistence/coaching-constraints';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const params = z.strictObject({ id: z.uuid().transform((value) => value.toLowerCase()) });
function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (!(error instanceof CoachingConstraintError)) return undefined;
    return new ProductRequestError(
      error.code === 'COACHING_CONSTRAINT_NOT_FOUND'
        ? 404
        : error.code === 'COACHING_CONSTRAINT_LIMIT'
          ? 413
          : 409,
      error.code,
    );
  });
}
export function registerCoachingConstraintRoutes(
  routes: FastifyInstance,
  repository: CoachingConstraintRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/coaching-constraints', async (request) => {
    input(emptyQuery, request.query);
    return coachingConstraintListSchema.parse(
      await execute(() => repository.list(principal(request).athleteId)),
    );
  });
  routes.post('/coaching-constraints', { bodyLimit: 16 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(coachingConstraintCreateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(coachingConstraintCreateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return coachingConstraintCommandResultSchema.parse(
      await execute(() => repository.create(principal(request).athleteId, payload)),
    );
  });
  routes.put('/coaching-constraints/:id', { bodyLimit: 16 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const body = input(coachingConstraintUpdateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(coachingConstraintUpdateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return coachingConstraintCommandResultSchema.parse(
      await execute(() => repository.update(principal(request).athleteId, id, payload)),
    );
  });
  routes.delete('/coaching-constraints/:id', { bodyLimit: 16 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const body = input(coachingConstraintDeleteSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(coachingConstraintDeleteSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return coachingConstraintCommandResultSchema.parse(
      await execute(() => repository.remove(principal(request).athleteId, id, payload)),
    );
  });
}
