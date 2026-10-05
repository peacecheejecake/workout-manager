import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  healthKitDeregisterWorkoutSchema,
  healthKitDeregistrationResultSchema,
  healthKitDeregistrationStatusQuerySchema,
} from '@workout/contracts/healthkit-registration';
import {
  HealthKitDeregistrationError,
  type HealthKitDeregistrationRepository,
} from '@workout/server-persistence/healthkit-deregistration';
import type { Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

export function registerHealthKitDeregistrationRoutes(
  routes: FastifyInstance,
  repository: Pick<HealthKitDeregistrationRepository, 'deregisterWorkout' | 'getStatus'>,
  principal: (request: FastifyRequest) => Principal,
) {
  function owner(request: FastifyRequest) {
    const authenticated = principal(request);
    if (authenticated.method !== 'bearer') throw new ProductRequestError(403, 'BEARER_REQUIRED');
    return authenticated.athleteId;
  }
  function mapError(error: unknown): never {
    if (error instanceof HealthKitDeregistrationError) {
      const status =
        error.code === 'CONSENT_REQUIRED'
          ? 403
          : error.code === 'DEREGISTRATION_NOT_FOUND'
            ? 404
            : error.code === 'INVALID_REQUEST'
              ? 400
              : 409;
      throw new ProductRequestError(status, error.code);
    }
    throw error;
  }
  routes.post('/healthkit/workout-deregistrations', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const athleteId = owner(request);
    input(emptyQuery, request.query);
    const command = input(healthKitDeregisterWorkoutSchema, request.body);
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(
          healthKitDeregistrationResultSchema.parse(
            await repository.deregisterWorkout(athleteId, command),
          ),
        );
    } catch (error) {
      return mapError(error);
    }
  });
  routes.get('/healthkit/workout-deregistrations', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const athleteId = owner(request);
    const query = input(healthKitDeregistrationStatusQuerySchema, request.query);
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(
          healthKitDeregistrationResultSchema.parse(
            await repository.getStatus(athleteId, query.operationId),
          ),
        );
    } catch (error) {
      return mapError(error);
    }
  });
}
