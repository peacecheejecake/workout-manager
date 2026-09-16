import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PlanningRepository } from '@workout/server-persistence/planning';
import type { Principal } from './ports.js';
import { registerPlanningRoutes } from './planning-routes.js';
export { ProductRequestError } from './product-boundary.js';
export type { PlanningRepository } from '@workout/server-persistence/planning';
export interface ProductRepositories {
  planning?: PlanningRepository;
}
export function registerProductRoutes(
  routes: FastifyInstance,
  repositories: ProductRepositories,
  principal: (request: FastifyRequest) => Principal,
) {
  if (repositories.planning) registerPlanningRoutes(routes, repositories.planning, principal);
}
