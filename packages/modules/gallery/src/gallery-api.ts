import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  galleryMediaDeleteResultSchema,
  galleryMediaListSchema,
  galleryMediaReadResultSchema,
  galleryUploadReservationSchema,
  type GalleryMediaCreateUploadMetadata,
  type GalleryMediaListQuery,
  type GalleryMediaPreviewUploadMetadata,
  type GalleryMediaSoftDelete,
  type GalleryMediaUpdate,
} from '@workout/contracts/gallery';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export class GalleryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'GalleryRequestError';
  }
}

export function createGalleryApi(transport: AuthenticatedTransport) {
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
      throw new GalleryRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }

  return {
    list(query: GalleryMediaListQuery, signal?: AbortSignal) {
      const search = new URLSearchParams();
      if (query.album !== undefined) search.set('album', query.album);
      if (query.mediaKind !== undefined) search.set('mediaKind', query.mediaKind);
      if (query.activityId !== undefined) search.set('activityId', query.activityId);
      search.set('limit', String(query.limit));
      search.set('offset', String(query.offset));
      return request(
        `/bff/v1/gallery/media?${search.toString()}`,
        'GET',
        galleryMediaListSchema,
        null,
        null,
        signal,
      );
    },
    read(mediaItemId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/gallery/media/${encodeURIComponent(mediaItemId)}`,
        'GET',
        galleryMediaReadResultSchema,
        null,
        null,
        signal,
      );
    },
    reserveUpload(input: GalleryMediaCreateUploadMetadata & { idempotencyKey: string }) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/gallery/media/uploads',
        'POST',
        galleryUploadReservationSchema,
        body,
        idempotencyKey,
      );
    },
    reservePreviewUpload(
      mediaItemId: string,
      input: GalleryMediaPreviewUploadMetadata & { idempotencyKey: string },
    ) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/gallery/media/${encodeURIComponent(mediaItemId)}/preview-uploads`,
        'POST',
        galleryUploadReservationSchema,
        body,
        idempotencyKey,
      );
    },
    finalizeUpload(uploadId: string) {
      return request(
        `/bff/v1/gallery/media/uploads/${encodeURIComponent(uploadId)}/finalize`,
        'POST',
        galleryMediaReadResultSchema,
      );
    },
    update(mediaItemId: string, input: GalleryMediaUpdate) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/gallery/media/${encodeURIComponent(mediaItemId)}`,
        'PATCH',
        galleryMediaReadResultSchema,
        body,
        idempotencyKey,
      );
    },
    delete(mediaItemId: string, input: GalleryMediaSoftDelete) {
      const { idempotencyKey, ...body } = input;
      return request(
        `/bff/v1/gallery/media/${encodeURIComponent(mediaItemId)}`,
        'DELETE',
        galleryMediaDeleteResultSchema,
        body,
        idempotencyKey,
      );
    },
  };
}

export type GalleryApi = ReturnType<typeof createGalleryApi>;
