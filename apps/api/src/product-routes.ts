import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PlanningRepository } from '@workout/server-persistence/planning';
import type { ActivityRepository } from '@workout/server-persistence/activities';
import type { Principal } from './ports.js';
import { registerPlanningRoutes } from './planning-routes.js';
import { registerActivityRoutes } from './activity-routes.js';
import { registerOperationsRoutes } from './operations-routes.js';
import type { OperationsRepository } from '@workout/server-persistence/operations';
export { ProductRequestError } from './product-boundary.js';
export type { PlanningRepository } from '@workout/server-persistence/planning';
export interface ProductRepositories {
  planning?: PlanningRepository;
  activities?: ActivityRepository;
  operations?: OperationsRepository;
}
export function registerProductRoutes(
  routes: FastifyInstance,
  repositories: ProductRepositories,
  principal: (request: FastifyRequest) => Principal,
) {
  if (repositories.planning) registerPlanningRoutes(routes, repositories.planning, principal);
  if (repositories.activities) registerActivityRoutes(routes, repositories.activities, principal);
  if (repositories.operations) registerOperationsRoutes(routes, repositories.operations, principal);
}
