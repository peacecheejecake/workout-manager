import type { z } from 'zod';
import {
  transportReplySchema,
  transportRequestDtoSchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  galleryAlbumCreateCommandV1Schema,
  galleryAlbumListQueryV1Schema,
  galleryAlbumListPageV1Schema,
  galleryAlbumDeleteCommandV1Schema,
  galleryAlbumDeleteResultV1Schema,
  galleryAlbumRenameCommandV1Schema,
  galleryAlbumV1Schema,
  galleryMediaMembershipCommandV2Schema,
  galleryMediaNavigationQueryV2Schema,
  galleryNavigationIdempotencyKeySchema,
} from '@workout/contracts/gallery-navigation-v2';
import {
  galleryMediaNavigationPageV3Schema,
  galleryMediaNavigationV3Schema,
} from '@workout/contracts/gallery-navigation-v3';

export type GalleryNavigationErrorCode =
  'INVALID_INPUT' | 'INVALID_REPLY' | 'REQUEST_FAILED' | 'TRANSPORT_FAILED' | 'ABORTED';

/** Deliberately excludes server text, arbitrary error codes and raw response bodies. */
export class GalleryNavigationRequestError extends Error {
  constructor(
    readonly code: GalleryNavigationErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = 'GalleryNavigationRequestError';
  }
}

function validated<T>(schema: z.ZodType<T>, raw: unknown, code: GalleryNavigationErrorCode): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new GalleryNavigationRequestError(code);
  return result.data;
}

/** Inspect descriptors before reading the untrusted envelope or walking a body. */
function replyFields(raw: unknown) {
  if (typeof raw !== 'object' || raw === null || Object.getPrototypeOf(raw) !== Object.prototype)
    throw new GalleryNavigationRequestError('INVALID_REPLY');
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 3 || !['status', 'body', 'traceId'].every((key) => keys.includes(key)))
    throw new GalleryNavigationRequestError('INVALID_REPLY');
  function field(key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw new GalleryNavigationRequestError('INVALID_REPLY');
    return descriptor.value;
  }
  return {
    status: validated(transportReplySchema.shape.status, field('status'), 'INVALID_REPLY'),
    body: field('body'),
    traceId: validated(transportReplySchema.shape.traceId, field('traceId'), 'INVALID_REPLY'),
  };
}

/** Authentication, ownership and policy remain in the supplied transport and server. */
export function createGalleryNavigationApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: TransportRequest['method'],
    responseSchema: z.ZodType<T>,
    body: unknown,
    idempotencyKey: string | null,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new GalleryNavigationRequestError('INVALID_INPUT');
    if (signal?.aborted) throw new GalleryNavigationRequestError('ABORTED');
    const dto = validated(
      transportRequestDtoSchema,
      { path, method, body, idempotencyKey },
      'INVALID_INPUT',
    );
    let raw: unknown;
    try {
      raw = await transport.request({ ...dto, ...(signal === undefined ? {} : { signal }) });
    } catch {
      throw new GalleryNavigationRequestError(signal?.aborted ? 'ABORTED' : 'TRANSPORT_FAILED');
    }
    if (signal?.aborted) throw new GalleryNavigationRequestError('ABORTED');
    let envelope: ReturnType<typeof replyFields>;
    try {
      envelope = replyFields(raw);
    } catch {
      throw new GalleryNavigationRequestError('INVALID_REPLY');
    }
    if (envelope.status < 200 || envelope.status >= 300)
      throw new GalleryNavigationRequestError('REQUEST_FAILED', envelope.status);
    // Public DTO schemas enforce plain-object, size, depth and exact field bounds first.
    const value = validated(responseSchema, envelope.body, 'INVALID_REPLY');
    validated(transportReplySchema, { ...envelope, body: value }, 'INVALID_REPLY');
    return value;
  }
  const key = (raw: unknown) =>
    validated(galleryNavigationIdempotencyKeySchema, raw, 'INVALID_INPUT');
  return {
    navigate(raw: unknown, signal?: AbortSignal) {
      const query = validated(galleryMediaNavigationQueryV2Schema, raw, 'INVALID_INPUT');
      const search = new URLSearchParams({ query: JSON.stringify(query) });
      return request(
        `/bff/v1/gallery/media/navigation?${search.toString()}`,
        'GET',
        galleryMediaNavigationPageV3Schema.refine(
          (page) => JSON.stringify(page.query) === JSON.stringify(query),
        ),
        null,
        null,
        signal,
      );
    },
    listAlbums(raw: unknown, signal?: AbortSignal) {
      const query = validated(galleryAlbumListQueryV1Schema, raw, 'INVALID_INPUT');
      const search = new URLSearchParams({ query: JSON.stringify(query) });
      return request(
        `/bff/v1/gallery/albums?${search.toString()}`,
        'GET',
        galleryAlbumListPageV1Schema.refine(
          (page) => JSON.stringify(page.query) === JSON.stringify(query),
        ),
        null,
        null,
        signal,
      );
    },
    createAlbum(raw: unknown, idempotencyKey: unknown, signal?: AbortSignal) {
      const command = validated(galleryAlbumCreateCommandV1Schema, raw, 'INVALID_INPUT');
      return request(
        '/bff/v1/gallery/albums',
        'POST',
        galleryAlbumV1Schema.refine(
          (album) => album.title === command.title && album.revision === 1,
        ),
        command,
        key(idempotencyKey),
        signal,
      );
    },
    renameAlbum(raw: unknown, idempotencyKey: unknown, signal?: AbortSignal) {
      const command = validated(galleryAlbumRenameCommandV1Schema, raw, 'INVALID_INPUT');
      return request(
        `/bff/v1/gallery/albums/${encodeURIComponent(command.albumId)}`,
        'PATCH',
        galleryAlbumV1Schema.refine(
          (album) =>
            album.id === command.albumId &&
            album.title === command.title &&
            album.revision === command.expectedRevision + 1,
        ),
        command,
        key(idempotencyKey),
        signal,
      );
    },
    deleteAlbum(raw: unknown, idempotencyKey: unknown, signal?: AbortSignal) {
      const command = validated(galleryAlbumDeleteCommandV1Schema, raw, 'INVALID_INPUT');
      return request(
        `/bff/v1/gallery/albums/${encodeURIComponent(command.albumId)}`,
        'DELETE',
        galleryAlbumDeleteResultV1Schema.refine(
          (result) =>
            result.albumId === command.albumId && result.revision === command.expectedRevision + 1,
        ),
        command,
        key(idempotencyKey),
        signal,
      );
    },
    updateMembership(raw: unknown, idempotencyKey: unknown, signal?: AbortSignal) {
      const command = validated(galleryMediaMembershipCommandV2Schema, raw, 'INVALID_INPUT');
      return request(
        `/bff/v1/gallery/media/${encodeURIComponent(command.mediaItemId)}/membership`,
        'PUT',
        galleryMediaNavigationV3Schema.refine(
          (media) =>
            media.item.id === command.mediaItemId &&
            media.item.accessRevision === command.expectedAccessRevision + 1 &&
            JSON.stringify(media.albumMembership) === JSON.stringify(command.albumMembership) &&
            JSON.stringify(media.courseLink) === JSON.stringify(command.courseLink),
        ),
        command,
        key(idempotencyKey),
        signal,
      );
    },
  };
}
export type GalleryNavigationApi = ReturnType<typeof createGalleryNavigationApi>;
