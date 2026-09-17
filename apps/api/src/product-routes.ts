import type { SessionCompletionRepository } from '@workout/server-persistence/session-completions';
import { registerSessionCompletionRoutes } from './session-completion-routes.js';
import type { PeriodSummaryRepository } from '@workout/server-persistence/period-summary';
import { registerPeriodSummaryRoutes } from './period-summary-routes.js';
import type { ActivityContextRepository } from '@workout/server-persistence/activity-context';
import { registerActivityContextRoutes } from './activity-context-routes.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PlanningRepository } from '@workout/server-persistence/planning';
import type { ActivityRepository } from '@workout/server-persistence/activities';
import type { CheckInRepository } from '@workout/server-persistence/check-ins';
import { registerCheckInRoutes } from './check-in-routes.js';
import type { DashboardRepository } from '@workout/server-persistence/dashboard';
import { registerDashboardRoutes } from './dashboard-routes.js';
import type { Principal } from './ports.js';
import { registerPlanningRoutes } from './planning-routes.js';
import { registerActivityRoutes } from './activity-routes.js';
import { registerOperationsRoutes } from './operations-routes.js';
import type { OperationsRepository } from '@workout/server-persistence/operations';
export { ProductRequestError } from './product-boundary.js';
export type { PlanningRepository } from '@workout/server-persistence/planning';
export interface ProductRepositories {
  planning?: PlanningRepository;
  sessionCompletions?: SessionCompletionRepository;
  periodSummary?: PeriodSummaryRepository;
  activities?: ActivityRepository;
  activityContext?: ActivityContextRepository;
  checkIns?: CheckInRepository;
  dashboard?: DashboardRepository;
  operations?: OperationsRepository;
}
export function registerProductRoutes(
  routes: FastifyInstance,
  repositories: ProductRepositories,
  principal: (request: FastifyRequest) => Principal,
) {
  if (repositories.sessionCompletions)
    registerSessionCompletionRoutes(routes, repositories.sessionCompletions, principal);
  if (repositories.periodSummary)
    registerPeriodSummaryRoutes(routes, repositories.periodSummary, principal);
  if (repositories.activityContext)
    registerActivityContextRoutes(routes, repositories.activityContext, principal);
  if (repositories.planning) registerPlanningRoutes(routes, repositories.planning, principal);
  if (repositories.activities) registerActivityRoutes(routes, repositories.activities, principal);
  if (repositories.checkIns) registerCheckInRoutes(routes, repositories.checkIns, principal);
  if (repositories.dashboard) registerDashboardRoutes(routes, repositories.dashboard, principal);
  if (repositories.operations) registerOperationsRoutes(routes, repositories.operations, principal);
}
