import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  coachingRunGroundingSchema,
  resourceRetrievalQuerySchema,
  resourceRetrievalResultSchema,
} from '@workout/contracts/resource-retrieval';
import {
  ResourceRetrievalError,
  type ResourceRetrievalRepository,
} from '@workout/server-persistence/resource-retrieval';
import { ResourceAccessError } from '@workout/server-persistence/resource-access';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const runParams = z.strictObject({ runId: uuid });

function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (error instanceof ResourceAccessError) return new ProductRequestError(409, error.code);
    // Retrieval failures are conflicts on the caller's own access state, never
    // internal detail: the codes carry no content and no storage reference.
    if (error instanceof ResourceRetrievalError)
      return new ProductRequestError(error.code === 'GROUNDING_NOT_FOUND' ? 404 : 409, error.code);
    return undefined;
  });
}

/**
 * Retrieval is a user-facing read over the caller's own reviewed resources.
 * The tenant comes from authentication only, and the server decides what is
 * authorized: no request field can widen the corpus.
 */
export function registerResourceRetrievalRoutes(
  routes: FastifyInstance,
  repository: ResourceRetrievalRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/retrieval/queries', { bodyLimit: 4 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(resourceRetrievalQuerySchema, request.body);
    return resourceRetrievalResultSchema.parse(
      await execute(() => repository.retrieve(principal(request).athleteId, body)),
    );
  });

  routes.get('/coaching-runs/:runId/grounding', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runParams, request.params);
    return coachingRunGroundingSchema.parse(
      await execute(() => repository.readGrounding(principal(request).athleteId, runId)),
    );
  });
}
