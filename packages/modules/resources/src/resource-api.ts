import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  privateTextResourceDeleteResultSchema,
  privateTextResourceListSchema,
  privateTextResourceReadResultSchema,
  type PrivateTextResourceAppendVersion,
  type PrivateTextResourceCreate,
  type PrivateTextResourceListQuery,
  type PrivateTextResourceSoftDelete,
} from '@workout/contracts/resources';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export class ResourceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function createResourceApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: TransportRequest['method'],
    schema: z.ZodType<T>,
    body: unknown = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
  ) {
    const transportBody = body === null ? null : z.json().parse(body);
    const reply = transportReplySchema.parse(
      await transport.request({
        path,
        method,
        body: transportBody,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      }),
    );
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = errorSchema.safeParse(reply.body);
      throw new ResourceRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }

  return {
    list(query: PrivateTextResourceListQuery, signal?: AbortSignal) {
      const search = new URLSearchParams();
      if (query.query !== undefined) search.set('query', query.query);
      if (query.category !== undefined) search.set('category', query.category);
      if (query.favorite !== undefined) search.set('favorite', String(query.favorite));
      search.set('limit', String(query.limit));
      search.set('offset', String(query.offset));
      return request(
        `/bff/v1/resources?${search.toString()}`,
        'GET',
        privateTextResourceListSchema,
        null,
        null,
        signal,
      );
    },
    read(resourceId: string, versionId?: string, signal?: AbortSignal) {
      const suffix = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}${suffix}`,
        'GET',
        privateTextResourceReadResultSchema,
        null,
        null,
        signal,
      );
    },
    create(input: PrivateTextResourceCreate) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/resources',
        'POST',
        privateTextResourceReadResultSchema,
        body,
        idempotencyKey,
      );
    },
    append(resourceId: string, input: PrivateTextResourceAppendVersion) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/versions`,
        'POST',
        privateTextResourceReadResultSchema,
        body,
        idempotencyKey,
      );
    },
    delete(resourceId: string, input: PrivateTextResourceSoftDelete) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}`,
        'DELETE',
        privateTextResourceDeleteResultSchema,
        body,
        idempotencyKey,
      );
    },
  };
}
