import type { FastifyInstance, FastifyRequest } from 'fastify';
import { periodSummaryQuerySchema, periodSummarySchema } from '@workout/contracts/period-summary';
import type { PeriodSummaryRepository } from '@workout/server-persistence/period-summary';
import type { Principal } from './ports.js';
import { input, emptyQuery, ProductRequestError } from './product-boundary.js';
export function registerPeriodSummaryRoutes(
  routes: FastifyInstance,
  repository: PeriodSummaryRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/plans/versions/:planVersionId/periods/:periodId/summary', async (request) => {
    input(emptyQuery, request.query);
    const query = input(periodSummaryQuerySchema, request.params);
    const summary = await repository.read(principal(request).athleteId, query);
    if (!summary) throw new ProductRequestError(404, 'PLAN_PERIOD_NOT_FOUND');
    return periodSummarySchema.parse(summary);
  });
}
