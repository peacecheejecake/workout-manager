import { z } from 'zod';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  galleryMediaListQuerySchema,
  galleryMediaListSchema,
  galleryMediaReadResultSchema,
} from '@workout/contracts/gallery';
import {
  privateResourceListQuerySchema,
  privateResourceListSchema,
  privateResourceReadQuerySchema,
  privateResourceReadResultSchema,
} from '@workout/contracts/resources';
import { RaceRequestError } from './race-api';

const errorSchema = z.object({
  error: z.object({
    code: z
      .string()
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/),
  }),
});
const resourceVersionSchema = privateResourceReadQuerySchema.required();
const idSchema = z.uuid().transform((id) => id.toLowerCase());

/** Public descriptor transport only. Availability is not permission to attach or verification of evidence. */
export function createCompetitionsProofApi(transport: AuthenticatedTransport) {
  async function read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const reply = transportReplySchema.parse(
      await transport.request({
        path,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        ...(signal ? { signal } : {}),
      }),
    );
    signal?.throwIfAborted();
    if (reply.status < 200 || reply.status >= 300) {
      const error = errorSchema.safeParse(reply.body);
      throw new RaceRequestError(
        reply.status,
        error.success ? error.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  return {
    gallery: {
      list(input: z.input<typeof galleryMediaListQuerySchema> = {}, signal?: AbortSignal) {
        const query = galleryMediaListQuerySchema.parse(input);
        const search = new URLSearchParams({
          limit: String(query.limit),
          offset: String(query.offset),
        });
        if (query.album !== undefined) search.set('album', query.album);
        if (query.mediaKind !== undefined) search.set('mediaKind', query.mediaKind);
        if (query.activityId !== undefined) search.set('activityId', query.activityId);
        return read(`/bff/v1/gallery/media?${search}`, galleryMediaListSchema, signal);
      },
      async read(id: string, signal?: AbortSignal) {
        const parsedId = idSchema.parse(id);
        const result = await read(
          `/bff/v1/gallery/media/${parsedId}`,
          galleryMediaReadResultSchema,
          signal,
        );
        z.literal(parsedId).parse(
          result.status === 'available' ? result.item.id : result.mediaItemId,
        );
        return result;
      },
    },
    resources: {
      list(input: z.input<typeof privateResourceListQuerySchema> = {}, signal?: AbortSignal) {
        const query = privateResourceListQuerySchema.parse(input);
        const search = new URLSearchParams({
          limit: String(query.limit),
          offset: String(query.offset),
        });
        if (query.query !== undefined) search.set('query', query.query);
        if (query.category !== undefined) search.set('category', query.category);
        if (query.favorite !== undefined) search.set('favorite', String(query.favorite));
        return read(`/bff/v1/resources?${search}`, privateResourceListSchema, signal);
      },
      async read(id: string, input: z.input<typeof resourceVersionSchema>, signal?: AbortSignal) {
        const parsedId = idSchema.parse(id);
        const query = resourceVersionSchema.parse(input);
        const result = await read(
          `/bff/v1/resources/${parsedId}?${new URLSearchParams({ versionId: query.versionId })}`,
          privateResourceReadResultSchema,
          signal,
        );
        if (result.status === 'available') {
          z.literal(parsedId).parse(result.resource.id);
          z.literal(query.versionId).parse(result.version.id);
        } else if (result.status === 'deleted') z.literal(parsedId).parse(result.resourceId);
        return result;
      },
    },
  };
}
export type CompetitionsProofApi = ReturnType<typeof createCompetitionsProofApi>;
