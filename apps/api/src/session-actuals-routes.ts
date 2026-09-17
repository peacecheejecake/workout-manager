import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  sessionActualsQuerySchema,
  sessionActualsSchema,
} from '@workout/contracts/session-actuals';
import type { SessionActualsRepository } from '@workout/server-persistence/session-actuals';
import type { Principal } from './ports.js';
import { input, emptyQuery, ProductRequestError } from './product-boundary.js';
export function registerSessionActualsRoutes(
  routes: FastifyInstance,
  repository: SessionActualsRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/plans/versions/:planVersionId/session-actuals', async (request) => {
    input(emptyQuery, request.query);
    const query = input(sessionActualsQuerySchema, request.params);
    const result = await repository.read(principal(request).athleteId, query);
    if (result === null) throw new ProductRequestError(404, 'PLAN_VERSION_NOT_FOUND');
    return sessionActualsSchema.parse(result);
  });
}
