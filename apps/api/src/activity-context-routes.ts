import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { activityContextSchema } from '@workout/contracts/activity-context';
import type { ActivityContextRepository } from '@workout/server-persistence/activity-context';
import type { Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

const params = z.strictObject({ id: z.uuid() });
export function registerActivityContextRoutes(
  routes: FastifyInstance,
  repository: ActivityContextRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/activities/:id/context', async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const result = await repository.read(principal(request).athleteId, id);
    if (!result) throw new ProductRequestError(404, 'NOT_FOUND');
    return activityContextSchema.parse(result);
  });
}
