import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  planScenarioSchema,
  planScenarioListQuerySchema,
  planScenarioListSchema,
  planScenarioCreateSchema,
  planScenarioSaveSchema,
  planScenarioApplySchema,
  planScenarioApplyResultSchema,
} from '@workout/contracts/plan-scenarios';
import {
  PlanScenarioError,
  type PlanScenarioRepository,
} from '@workout/server-persistence/plan-scenarios';
import { PlanLockedError } from '@workout/server-persistence/planning';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';
import { sessionCompletionRequestError } from './session-completion-routes.js';

const pathSchema = z.strictObject({
  scenarioId: z.uuid().transform((value) => value.toLowerCase()),
});
const revisionPathSchema = pathSchema.extend({
  revision: z.coerce.number().int().min(1).max(2147483646),
});
function requestError(error: unknown): ProductRequestError | undefined {
  if (error instanceof PlanScenarioError)
    return new ProductRequestError(
      error.code === 'SCENARIO_NOT_FOUND' || error.code === 'PLAN_VERSION_NOT_FOUND' ? 404 : 409,
      error.code,
    );
  if (error instanceof PlanLockedError) return new ProductRequestError(409, 'PLAN_LOCKED');
  return sessionCompletionRequestError(error);
}
export function registerPlanScenarioRoutes(
  routes: FastifyInstance,
  repository: PlanScenarioRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/plan-scenarios', async (request) => {
    const query = input(planScenarioListQuerySchema, request.query);
    return planScenarioListSchema.parse(await repository.list(principal(request).athleteId, query));
  });
  routes.get('/plan-scenarios/:scenarioId', async (request) => {
    input(emptyQuery, request.query);
    const { scenarioId } = input(pathSchema, request.params);
    const result = await command(
      () => repository.read(principal(request).athleteId, scenarioId),
      requestError,
    );
    if (result === null) throw new ProductRequestError(404, 'SCENARIO_NOT_FOUND');
    return planScenarioSchema.parse(result);
  });
  routes.get('/plan-scenarios/:scenarioId/revisions/:revision', async (request) => {
    input(emptyQuery, request.query);
    const { scenarioId, revision } = input(revisionPathSchema, request.params);
    const result = await command(
      () => repository.readRevision(principal(request).athleteId, scenarioId, revision),
      requestError,
    );
    if (result === null) throw new ProductRequestError(404, 'SCENARIO_NOT_FOUND');
    return planScenarioSchema.parse(result);
  });
  routes.post('/plan-scenarios', async (request) => {
    input(emptyQuery, request.query);
    const body = input(planScenarioCreateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(planScenarioCreateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return planScenarioSchema.parse(
      await command(() => repository.create(principal(request).athleteId, payload), requestError),
    );
  });
  routes.put('/plan-scenarios/:scenarioId', { bodyLimit: 1024 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { scenarioId } = input(pathSchema, request.params);
    const body = input(planScenarioSaveSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(planScenarioSaveSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return planScenarioSchema.parse(
      await command(
        () => repository.save(principal(request).athleteId, scenarioId, payload),
        requestError,
      ),
    );
  });
  routes.post('/plan-scenarios/:scenarioId/apply', async (request) => {
    input(emptyQuery, request.query);
    const { scenarioId } = input(pathSchema, request.params);
    const body = input(planScenarioApplySchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(planScenarioApplySchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return planScenarioApplyResultSchema.parse(
      await command(
        () => repository.apply(principal(request).athleteId, scenarioId, payload),
        requestError,
      ),
    );
  });
}
