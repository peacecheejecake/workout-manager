import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  healthKitWorkoutReviewQuerySchema,
  healthKitWorkoutReviewResponseSchema,
} from '@workout/contracts/healthkit-review';
import {
  HealthKitReviewError,
  type HealthKitReviewRepository,
} from '@workout/server-persistence/healthkit-projection';
import type { Principal } from './ports.js';
import { input, ProductRequestError } from './product-boundary.js';

export function registerHealthKitReviewRoutes(
  routes: FastifyInstance,
  repository: HealthKitReviewRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/healthkit/workout-review', async (request) => {
    const { limit = 50 } = input(healthKitWorkoutReviewQuerySchema, request.query);
    const owner = principal(request);
    try {
      return healthKitWorkoutReviewResponseSchema.parse(
        await repository.listPendingWorkouts(owner.athleteId, limit),
      );
    } catch (error) {
      if (error instanceof HealthKitReviewError) throw new ProductRequestError(403, error.code);
      throw error;
    }
  });
}
