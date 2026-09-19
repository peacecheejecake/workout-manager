import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  integratedPlannerQuerySchema,
  integratedPlannerReadV4Schema,
  integratedPlannerReadSchema,
} from '@workout/contracts/integrated-planner';
import {
  IntegratedPlannerLimitError,
  type IntegratedPlannerRepository,
} from '@workout/server-persistence/integrated-planner';
import type { Principal } from './ports.js';
import { input, ProductRequestError } from './product-boundary.js';

const integratedPlannerVersionedQuerySchema = integratedPlannerQuerySchema.safeExtend({
  maxSchemaVersion: z.coerce.number().int().min(1).max(4).optional(),
});

export function registerIntegratedPlannerRoutes(
  routes: FastifyInstance,
  planner: IntegratedPlannerRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/planner/integrated', async (request) => {
    const { maxSchemaVersion = 1, ...query } = input(
      integratedPlannerVersionedQuerySchema,
      request.query,
    );
    if (maxSchemaVersion === 2 || maxSchemaVersion === 3)
      throw new ProductRequestError(409, 'UNSUPPORTED_SCHEMA_VERSION');
    try {
      if (maxSchemaVersion === 4) {
        return integratedPlannerReadV4Schema.parse(
          await planner.readV4(principal(request).athleteId, query),
        );
      }
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
