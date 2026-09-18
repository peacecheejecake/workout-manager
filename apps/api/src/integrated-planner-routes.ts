import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  integratedPlannerQuerySchema,
  integratedPlannerReadSchema,
} from '@workout/contracts/integrated-planner';
import {
  IntegratedPlannerLimitError,
  type IntegratedPlannerRepository,
} from '@workout/server-persistence/integrated-planner';
import type { Principal } from './ports.js';
import { input, ProductRequestError } from './product-boundary.js';

export function registerIntegratedPlannerRoutes(
  routes: FastifyInstance,
  planner: IntegratedPlannerRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/planner/integrated', async (request) => {
    const query = input(integratedPlannerQuerySchema, request.query);
    try {
      return integratedPlannerReadSchema.parse(
        await planner.read(principal(request).athleteId, query),
      );
    } catch (error) {
      if (error instanceof IntegratedPlannerLimitError)
        throw new ProductRequestError(422, error.code);
      throw error;
    }
  });
}
