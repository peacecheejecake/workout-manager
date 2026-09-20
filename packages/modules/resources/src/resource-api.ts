import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  privateResourceDeleteResultSchema,
  privateResourceListSchema,
  privateResourceReadResultSchema,
  privateResourceAccessStateSchema,
  privateUrlResourceIngestionRecordSchema,
  type PrivateFileResourceAppendVersionUploadMetadata,
  type PrivateFileResourceCreateUploadMetadata,
  type PrivateResourceListQuery,
  type PrivateResourceSoftDelete,
  type PrivateTextResourceAppendVersion,
  type PrivateTextResourceCreate,
  type PrivateResourceCoachUseTransition,
  type PrivateResourceReviewedTransition,
  type PrivateResourceShareGrant,
  type PrivateResourceShareRevoke,
  type PrivateUrlResourceCreate,
} from '@workout/contracts/resources';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const uploadReservationSchema = z.strictObject({
  uploadId: z.uuid(),
  resourceId: z.uuid(),
  versionId: z.uuid(),
  state: z.enum(['reserved', 'prepared', 'staged', 'finalized', 'failed']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ResourceUploadReservation = z.infer<typeof uploadReservationSchema>;

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
    list(query: PrivateResourceListQuery, signal?: AbortSignal) {
      const search = new URLSearchParams();
      if (query.query !== undefined) search.set('query', query.query);
      if (query.category !== undefined) search.set('category', query.category);
      if (query.favorite !== undefined) search.set('favorite', String(query.favorite));
      search.set('limit', String(query.limit));
      search.set('offset', String(query.offset));
      return request(
        `/bff/v1/resources?${search.toString()}`,
        'GET',
        privateResourceListSchema,
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
        privateResourceReadResultSchema,
        null,
        null,
        signal,
      );
    },
    createText(input: PrivateTextResourceCreate) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/resources',
        'POST',
        privateResourceReadResultSchema,
        body,
        idempotencyKey,
      );
    },
    appendText(resourceId: string, input: PrivateTextResourceAppendVersion) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/versions`,
        'POST',
        privateResourceReadResultSchema,
        body,
        idempotencyKey,
      );
    },
    reserveCreateUpload(
      input: PrivateFileResourceCreateUploadMetadata & { idempotencyKey: string },
    ) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/resources/uploads',
        'POST',
        uploadReservationSchema,
        body,
        idempotencyKey,
      );
    },
    reserveAppendUpload(
      resourceId: string,
      input: PrivateFileResourceAppendVersionUploadMetadata & { idempotencyKey: string },
    ) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/uploads`,
        'POST',
        uploadReservationSchema,
        body,
        idempotencyKey,
      );
    },
    finalizeUpload(uploadId: string) {
      return request(
        `/bff/v1/resources/uploads/${encodeURIComponent(uploadId)}/finalize`,
        'POST',
        privateResourceReadResultSchema,
      );
    },
    createUrlIngestion(input: PrivateUrlResourceCreate) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/resources/url-ingestions',
        'POST',
        privateUrlResourceIngestionRecordSchema,
        body,
        idempotencyKey,
      );
    },
    getUrlIngestion(ingestionId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/resources/url-ingestions/${encodeURIComponent(ingestionId)}`,
        'GET',
        privateUrlResourceIngestionRecordSchema,
        null,
        null,
        signal,
      );
    },
    cancelUrlIngestion(ingestionId: string) {
      return request(
        `/bff/v1/resources/url-ingestions/${encodeURIComponent(ingestionId)}`,
        'DELETE',
        privateUrlResourceIngestionRecordSchema,
      );
    },
    readAccess(resourceId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/access`,
        'GET',
        privateResourceAccessStateSchema,
        null,
        null,
        signal,
      );
    },
    grantShare(resourceId: string, input: PrivateResourceShareGrant) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/shares`,
        'POST',
        privateResourceAccessStateSchema,
        body,
        idempotencyKey,
      );
    },
    revokeShare(resourceId: string, shareId: string, input: PrivateResourceShareRevoke) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/shares/${encodeURIComponent(shareId)}`,
        'DELETE',
        privateResourceAccessStateSchema,
        body,
        idempotencyKey,
      );
    },
    setReviewed(resourceId: string, input: PrivateResourceReviewedTransition) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/reviewed`,
        'POST',
        privateResourceAccessStateSchema,
        body,
        idempotencyKey,
      );
    },
    setCoachUse(resourceId: string, input: PrivateResourceCoachUseTransition) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/coach-use`,
        'POST',
        privateResourceAccessStateSchema,
        body,
        idempotencyKey,
      );
    },
    delete(resourceId: string, input: PrivateResourceSoftDelete) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}`,
        'DELETE',
        privateResourceDeleteResultSchema,
        body,
        idempotencyKey,
      );
    },
  };
}
