import { sessionCompletionRequestError } from './session-completion-routes.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  manualPlanCommandSchema,
  planReadSchema,
  planSnapshotSchema,
} from '@workout/contracts/planning';
import { PlanLockedError, type PlanningRepository } from '@workout/server-persistence/planning';
import type { Principal } from './ports.js';
import { input, command, emptyQuery, ProductRequestError } from './product-boundary.js';
export function registerPlanningRoutes(
  routes: FastifyInstance,
  planning: PlanningRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/plans/versions/:versionId', async (request) => {
    input(emptyQuery, request.query);
    const { versionId } = input(
      z.strictObject({ versionId: z.uuid().transform((value) => value.toLowerCase()) }),
      request.params,
    );
    const version = await planning.readVersion(principal(request).athleteId, versionId);
    if (version === null) throw new ProductRequestError(404, 'PLAN_VERSION_NOT_FOUND');
    return planSnapshotSchema.parse(version);
  });
  routes.get('/plans/current', async (request) => {
    input(emptyQuery, request.query);
    return planReadSchema.parse(await planning.read(principal(request).athleteId));
  });
  routes.put('/plans/current', { bodyLimit: 1024 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(manualPlanCommandSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(manualPlanCommandSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return planSnapshotSchema.parse(
      await command(
        () => planning.save(principal(request).athleteId, payload),
        (error) =>
          error instanceof PlanLockedError
            ? new ProductRequestError(409, 'PLAN_LOCKED')
            : sessionCompletionRequestError(error),
      ),
    );
  });
}
