import {
  privateResourceAccessStateSchema,
  privateResourceCoachUseTransitionSchema,
  privateResourceReviewedTransitionSchema,
  privateResourceShareGrantSchema,
  privateResourceShareRevokeSchema,
  privateSharedResourceListQuerySchema,
  privateSharedResourceListSchema,
  privateSharedResourceReadSchema,
} from '@workout/contracts/resources';
import {
  ResourceAccessError,
  type ResourceAccessRepository,
} from '@workout/server-persistence/resource-access';
import { ResourceNotFoundError } from '@workout/server-persistence/resources';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const resourceParamsSchema = z.strictObject({
  resourceId: z.uuid().transform((value) => value.toLowerCase()),
});
const shareParamsSchema = z.strictObject({
  resourceId: z.uuid().transform((value) => value.toLowerCase()),
  shareId: z.uuid().transform((value) => value.toLowerCase()),
});
const sharedReadParamsSchema = z.strictObject({
  ownerPrincipalId: z.string().min(1).max(200),
  resourceId: z.uuid().transform((value) => value.toLowerCase()),
});
const ACCESS_COMMAND_BODY_LIMIT = 16 * 1024;

const conflictCodes = new Set([
  'COACH_USE_REVIEW_REQUIRED',
  'COACH_USE_CONSENT_REQUIRED',
  'REVIEW_WITHDRAWAL_BLOCKED',
  'SHARE_LIMIT_EXCEEDED',
]);

function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (error instanceof ResourceNotFoundError) return new ProductRequestError(404, error.code);
    if (error instanceof ResourceAccessError) {
      if (error.code === 'SHARE_NOT_FOUND') return new ProductRequestError(404, error.code);
      if (conflictCodes.has(error.code)) return new ProductRequestError(409, error.code);
      return new ProductRequestError(422, error.code);
    }
    // Database-enforced preconditions must not surface as internal errors.
    if (error instanceof Error && error.message.includes('COACH_USE_CONSENT_REQUIRED'))
      return new ProductRequestError(409, 'COACH_USE_CONSENT_REQUIRED');
    if (error instanceof Error && error.message.includes('REVIEW_WITHDRAWAL_BLOCKED'))
      return new ProductRequestError(409, 'REVIEW_WITHDRAWAL_BLOCKED');
    return undefined;
  });
}

function withKey<T>(schema: z.ZodType<T>, body: unknown, request: FastifyRequest): T {
  const parsed = schema.safeParse({
    ...(typeof body === 'object' && body !== null ? body : {}),
    idempotencyKey: request.headers['idempotency-key'],
  });
  if (!parsed.success) throw new ProductRequestError(400, 'INVALID_REQUEST');
  return parsed.data;
}

export function registerResourceAccessRoutes(
  routes: FastifyInstance,
  repository: ResourceAccessRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/resources/:resourceId/access', async (request) => {
    input(emptyQuery, request.query);
    const { resourceId } = input(resourceParamsSchema, request.params);
    const state = privateResourceAccessStateSchema.parse(
      await execute(() => repository.readAccess(principal(request).athleteId, resourceId)),
    );
    z.literal(resourceId).parse(state.resourceId);
    return state;
  });

  routes.post(
    '/resources/:resourceId/shares',
    { bodyLimit: ACCESS_COMMAND_BODY_LIMIT },
    async (request) => {
      input(emptyQuery, request.query);
      const { resourceId } = input(resourceParamsSchema, request.params);
      const payload = withKey(privateResourceShareGrantSchema, request.body, request);
      return privateResourceAccessStateSchema.parse(
        await execute(() =>
          repository.grantShare(principal(request).athleteId, resourceId, payload),
        ),
      );
    },
  );

  routes.delete(
    '/resources/:resourceId/shares/:shareId',
    { bodyLimit: ACCESS_COMMAND_BODY_LIMIT },
    async (request) => {
      input(emptyQuery, request.query);
      const { resourceId, shareId } = input(shareParamsSchema, request.params);
      const payload = withKey(privateResourceShareRevokeSchema, request.body, request);
      return privateResourceAccessStateSchema.parse(
        await execute(() =>
          repository.revokeShare(principal(request).athleteId, resourceId, shareId, payload),
        ),
      );
    },
  );

  // Review curation and coach use are deliberately separate endpoints so no
  // single request can promote content into coaching input.
  routes.post(
    '/resources/:resourceId/reviewed',
    { bodyLimit: ACCESS_COMMAND_BODY_LIMIT },
    async (request) => {
      input(emptyQuery, request.query);
      const { resourceId } = input(resourceParamsSchema, request.params);
      const payload = withKey(privateResourceReviewedTransitionSchema, request.body, request);
      return privateResourceAccessStateSchema.parse(
        await execute(() =>
          repository.setReviewed(principal(request).athleteId, resourceId, payload),
        ),
      );
    },
  );

  routes.post(
    '/resources/:resourceId/coach-use',
    { bodyLimit: ACCESS_COMMAND_BODY_LIMIT },
    async (request) => {
      input(emptyQuery, request.query);
      const { resourceId } = input(resourceParamsSchema, request.params);
      const payload = withKey(privateResourceCoachUseTransitionSchema, request.body, request);
      return privateResourceAccessStateSchema.parse(
        await execute(() =>
          repository.setCoachUse(principal(request).athleteId, resourceId, payload),
        ),
      );
    },
  );

  // The grantee identity always comes from authentication, never from the path.
  routes.get('/resources/shared-with-me', async (request) => {
    const query = input(privateSharedResourceListQuerySchema, request.query);
    return privateSharedResourceListSchema.parse(
      await execute(() => repository.listSharedWithMe(principal(request).athleteId, query)),
    );
  });

  routes.get('/resources/shared-with-me/:ownerPrincipalId/:resourceId', async (request) => {
    input(emptyQuery, request.query);
    const { ownerPrincipalId, resourceId } = input(sharedReadParamsSchema, request.params);
    const result = privateSharedResourceReadSchema.parse(
      await execute(() =>
        repository.readSharedWithMe(principal(request).athleteId, ownerPrincipalId, resourceId),
      ),
    );
    if (result.status === 'unavailable')
      throw new ProductRequestError(404, 'SHARED_RESOURCE_NOT_FOUND');
    return result;
  });
}
