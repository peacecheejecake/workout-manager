import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  privateTextResourceAppendVersionSchema,
  privateTextResourceCreateSchema,
  privateTextResourceDeleteResultSchema,
  privateTextResourceListQuerySchema,
  privateTextResourceListSchema,
  privateTextResourceReadQuerySchema,
  privateTextResourceReadResultSchema,
  privateTextResourceSoftDeleteSchema,
} from '@workout/contracts/resources';
import {
  ResourceNotFoundError,
  ResourceValidationError,
  type PrivateTextResourceRepository,
} from '@workout/server-persistence/resources';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const resourceParams = z.strictObject({
  resourceId: z.uuid().transform((value) => value.toLowerCase()),
});
const RESOURCE_WRITE_BODY_LIMIT = 192 * 1024;

function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (error instanceof ResourceNotFoundError) return new ProductRequestError(404, error.code);
    if (error instanceof ResourceValidationError) return new ProductRequestError(422, error.code);
    return undefined;
  });
}

function readable(result: unknown, expected?: { resourceId: string; versionId?: string }) {
  const parsed = privateTextResourceReadResultSchema.parse(result);
  if (parsed.status === 'unavailable') throw new ProductRequestError(404, 'RESOURCE_NOT_FOUND');
  if (expected !== undefined) {
    const returnedResourceId =
      parsed.status === 'available' ? parsed.resource.id : parsed.resourceId;
    z.literal(expected.resourceId).parse(returnedResourceId);
    if (expected.versionId !== undefined && parsed.status === 'available')
      z.literal(expected.versionId).parse(parsed.version.id);
  }
  return parsed;
}

export function registerResourceRoutes(
  routes: FastifyInstance,
  repository: PrivateTextResourceRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/resources', async (request) =>
    privateTextResourceListSchema.parse(
      await execute(() =>
        repository.list(
          principal(request).athleteId,
          input(privateTextResourceListQuerySchema, request.query),
        ),
      ),
    ),
  );

  routes.get('/resources/:resourceId', async (request) => {
    const { resourceId } = input(resourceParams, request.params);
    const query = input(privateTextResourceReadQuerySchema, request.query);
    return readable(
      await execute(() => repository.read(principal(request).athleteId, resourceId, query)),
      {
        resourceId,
        ...(query.versionId === undefined ? {} : { versionId: query.versionId }),
      },
    );
  });

  routes.post('/resources', { bodyLimit: RESOURCE_WRITE_BODY_LIMIT }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(
      privateTextResourceCreateSchema.omit({ idempotencyKey: true }),
      request.body,
    );
    const payload = input(privateTextResourceCreateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return readable(await execute(() => repository.create(principal(request).athleteId, payload)));
  });

  routes.post(
    '/resources/:resourceId/versions',
    { bodyLimit: RESOURCE_WRITE_BODY_LIMIT },
    async (request) => {
      input(emptyQuery, request.query);
      const { resourceId } = input(resourceParams, request.params);
      const body = input(
        privateTextResourceAppendVersionSchema.omit({ idempotencyKey: true }),
        request.body,
      );
      const payload = input(privateTextResourceAppendVersionSchema, {
        ...body,
        idempotencyKey: request.headers['idempotency-key'],
      });
      return readable(
        await execute(() =>
          repository.appendVersion(principal(request).athleteId, resourceId, payload),
        ),
        { resourceId },
      );
    },
  );

  routes.delete('/resources/:resourceId', { bodyLimit: 16 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { resourceId } = input(resourceParams, request.params);
    const body = input(
      privateTextResourceSoftDeleteSchema.omit({ idempotencyKey: true }),
      request.body,
    );
    const payload = input(privateTextResourceSoftDeleteSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    const result = privateTextResourceDeleteResultSchema.parse(
      await execute(() => repository.softDelete(principal(request).athleteId, resourceId, payload)),
    );
    z.literal(resourceId).parse(result.resourceId);
    return result;
  });
}
