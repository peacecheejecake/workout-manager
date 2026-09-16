import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  importActivitySchema,
  activityListQuerySchema,
  activityListSchema,
  activitySchema,
  activityOverlayWriteSchema,
  activityDeleteSchema,
  activityImportResultSchema,
  activitySummarySchema,
  manualActivityCreateSchema,
  manualActivityResultSchema,
} from '@workout/contracts/activity';
import {
  ActivityNotFound,
  ActivityValidationError,
  type ActivityRepository,
} from '@workout/server-persistence/activities';
import type { Principal } from './ports.js';
import { input, command, emptyQuery, ProductRequestError } from './product-boundary.js';
const params = z.strictObject({ id: z.uuid() });
function activityCommand<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (error instanceof ActivityNotFound) return new ProductRequestError(404, 'NOT_FOUND');
    if (error instanceof ActivityValidationError) return new ProductRequestError(400, error.code);
    return undefined;
  });
}
export function registerActivityRoutes(
  routes: FastifyInstance,
  activities: ActivityRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/activities', async (request) => {
    input(emptyQuery, request.query);
    const body = input(manualActivityCreateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(manualActivityCreateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return manualActivityResultSchema.parse(
      await activityCommand(() =>
        activities.createManualActivity(principal(request).athleteId, payload),
      ),
    );
  });
  routes.post('/activity-imports', async (request) => {
    input(emptyQuery, request.query);
    const body = input(importActivitySchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(importActivitySchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return activityImportResultSchema.parse(
      await activityCommand(() => activities.importActivity(principal(request).athleteId, payload)),
    );
  });
  routes.get('/activities', async (request) =>
    activityListSchema.parse(
      await activities.listActivities(
        principal(request).athleteId,
        input(activityListQuerySchema, request.query),
      ),
    ),
  );
  routes.get('/activities/summary', async (request) => {
    input(emptyQuery, request.query);
    return activitySummarySchema.parse(await activities.summary(principal(request).athleteId));
  });
  routes.get('/activities/:id', async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const result = await activities.getActivity(principal(request).athleteId, id);
    if (!result) throw new ProductRequestError(404, 'NOT_FOUND');
    return activitySchema.parse(result);
  });
  routes.patch('/activities/:id', async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const body = input(
      z.strictObject({
        ...activityOverlayWriteSchema.shape,
        idempotencyKey: z.never().optional(),
      }),
      request.body,
    );
    const payload = input(activityOverlayWriteSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return activitySchema.parse(
      await activityCommand(() =>
        activities.updateOverlay(principal(request).athleteId, id, payload),
      ),
    );
  });
  routes.delete('/activities/:id', async (request, reply) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const payload = input(activityDeleteSchema, request.body);
    await activityCommand(() =>
      activities.deleteActivity(principal(request).athleteId, id, payload),
    );
    return reply.code(204).send();
  });
}
