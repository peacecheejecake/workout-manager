import type { FastifyInstance, FastifyRequest } from 'fastify';
import { dashboardQuerySchema, dashboardReadModelSchema } from '@workout/contracts/dashboard';
import type { DashboardRepository } from '@workout/server-persistence/dashboard';
import type { Principal } from './ports.js';
import { input } from './product-boundary.js';

export function registerDashboardRoutes(
  routes: FastifyInstance,
  dashboard: DashboardRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/dashboard', async (request) =>
    dashboardReadModelSchema.parse(
      await dashboard.read(
        principal(request).athleteId,
        input(dashboardQuerySchema, request.query),
      ),
    ),
  );
}
