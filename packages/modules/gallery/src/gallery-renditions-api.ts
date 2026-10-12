import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  galleryRenditionListV1Schema,
  type GalleryRenditionListV1,
} from '@workout/contracts/gallery-rendition';

export type GalleryRenditionsErrorCode = 'INVALID_REPLY' | 'REQUEST_FAILED' | 'ABORTED';

/** Finite failure only; no server text, storage key or bytes are retained. */
export class GalleryRenditionsRequestError extends Error {
  constructor(
    readonly code: GalleryRenditionsErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = 'GalleryRenditionsRequestError';
  }
}

/** Reads S17 derived-rendition state (M2-03c). Authority stays with the transport/server. */
export function createGalleryRenditionsApi(transport: AuthenticatedTransport) {
  return {
    async list(input: {
      mediaItemId: string;
      signal: AbortSignal;
    }): Promise<GalleryRenditionListV1> {
      if (input.signal.aborted) throw new GalleryRenditionsRequestError('ABORTED');
      const reply = transportReplySchema.safeParse(
        await transport.request({
          path: `/bff/v1/gallery/media/${encodeURIComponent(input.mediaItemId)}/renditions`,
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal: input.signal,
        }),
      );
      if (!reply.success) throw new GalleryRenditionsRequestError('INVALID_REPLY');
      if (reply.data.status < 200 || reply.data.status >= 300)
        throw new GalleryRenditionsRequestError('REQUEST_FAILED', reply.data.status);
      const parsed = galleryRenditionListV1Schema.safeParse(reply.data.body);
      if (!parsed.success || parsed.data.mediaItemId !== input.mediaItemId.toLowerCase())
        throw new GalleryRenditionsRequestError('INVALID_REPLY');
      return parsed.data;
    },
  };
}
export type GalleryRenditionsApi = ReturnType<typeof createGalleryRenditionsApi>;
