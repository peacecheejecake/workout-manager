import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  healthKitListRegisteredWorkoutsQuerySchema,
  healthKitListRegisteredWorkoutsResultSchema,
  healthKitRegisterWorkoutsResultSchema,
  healthKitRegisterWorkoutsSchema,
} from '@workout/contracts/healthkit-registration';
import {
  HealthKitRegistrationError,
  type HealthKitRegistrationRepository,
} from '@workout/server-persistence/healthkit-registration';
import type { Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

export function registerHealthKitRegistrationRoutes(
  routes: FastifyInstance,
  repository: Pick<HealthKitRegistrationRepository, 'registerWorkouts' | 'listWorkouts'>,
  principal: (request: FastifyRequest) => Principal,
) {
  function owner(request: FastifyRequest) {
    const authenticated = principal(request);
    if (authenticated.method !== 'bearer') throw new ProductRequestError(403, 'BEARER_REQUIRED');
    return authenticated.athleteId;
  }
  function mapError(error: unknown): never {
    if (error instanceof HealthKitRegistrationError)
      throw new ProductRequestError(error.code === 'CONSENT_REQUIRED' ? 403 : 409, error.code);
    throw error;
  }
  routes.post('/healthkit/workout-registrations', { bodyLimit: 16_384 }, async (request) => {
    const athleteId = owner(request);
    input(emptyQuery, request.query);
    const command = input(healthKitRegisterWorkoutsSchema, request.body);
    try {
      return healthKitRegisterWorkoutsResultSchema.parse(
        await repository.registerWorkouts(athleteId, command),
      );
    } catch (error) {
      return mapError(error);
    }
  });
  routes.get('/healthkit/workout-registrations', async (request, reply) => {
    const athleteId = owner(request);
    const query = input(healthKitListRegisteredWorkoutsQuerySchema, request.query);
    try {
      return reply.header('cache-control', 'no-store').send(
        healthKitListRegisteredWorkoutsResultSchema.parse(
          await repository.listWorkouts(athleteId, {
            ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        ),
      );
    } catch (error) {
      return mapError(error);
    }
  });
}
