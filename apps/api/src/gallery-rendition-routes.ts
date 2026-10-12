import { Readable } from 'node:stream';

import {
  galleryRenditionKindV1Schema,
  galleryRenditionListV1Schema,
} from '@workout/contracts/gallery-rendition';
import { parseObjectKey, validateObjectKey } from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import type { GalleryRenditionReader } from '@workout/server-persistence/gallery-renditions';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { principalSchema, type Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

export interface GalleryRenditionServices {
  reader: Pick<GalleryRenditionReader, 'list' | 'resolveObject'>;
  storage: Pick<ObjectStorage, 'open'>;
}

const params = z.strictObject({
  mediaItemId: z.uuid().transform((value) => value.toLowerCase()),
});
const contentParams = params.extend({ kind: galleryRenditionKindV1Schema });

/**
 * S17 derived renditions (M2-03c). Register inside the authenticated /bff/v1 product plugin.
 * State replies carry presentation metadata only; bytes are served solely for a ready
 * receipt whose exact rendition key, tenant, media, kind and digest all agree.
 */
export function registerGalleryRenditionRoutes(
  routes: FastifyInstance,
  services: GalleryRenditionServices | undefined,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (renditionRoutes) => {
    renditionRoutes.get('/gallery/media/:mediaItemId/renditions', async (request, reply) => {
      const athleteId = principalSchema.parse(principal(request)).athleteId;
      const { mediaItemId } = input(params, request.params);
      input(emptyQuery, request.query);
      if (!services) throw new ProductRequestError(503, 'GALLERY_RENDITIONS_UNAVAILABLE');
      const listed = await services.reader.list(athleteId, mediaItemId);
      if (listed === null) throw new ProductRequestError(404, 'MEDIA_NOT_FOUND');
      const result = galleryRenditionListV1Schema.parse(listed);
      if (result.mediaItemId !== mediaItemId) throw new Error('INVALID_GALLERY_RENDITION_REPLY');
      return reply.header('cache-control', 'private, no-store').send(result);
    });

    renditionRoutes.get(
      '/gallery/media/:mediaItemId/renditions/:kind/content',
      async (request, reply) => {
        const athleteId = principalSchema.parse(principal(request)).athleteId;
        const { mediaItemId, kind } = input(contentParams, request.params);
        input(emptyQuery, request.query);
        if (!services) throw new ProductRequestError(503, 'GALLERY_RENDITIONS_UNAVAILABLE');
        const resolved = await services.reader.resolveObject(athleteId, mediaItemId, kind);
        if (resolved === null) throw new ProductRequestError(404, 'RENDITION_NOT_READY');
        const key = validateObjectKey(resolved.storageRef);
        const parsed = parseObjectKey(key);
        if (
          parsed.kind !== 'gallery_rendition' ||
          parsed.tenantId !== athleteId ||
          parsed.mediaItemId !== mediaItemId ||
          parsed.renditionKind !== kind ||
          parsed.sha256 !== resolved.sha256 ||
          resolved.mediaType !== (kind === 'video_playback' ? 'video/mp4' : 'image/webp')
        )
          throw new Error('INVALID_GALLERY_RENDITION_STORAGE_REF');
        const object = await services.storage.open(key);
        if (object === null || object.sizeBytes !== resolved.byteSize)
          throw new ProductRequestError(503, 'RENDITION_CONTENT_UNAVAILABLE');
        return reply
          .header('content-type', resolved.mediaType)
          .header('content-length', object.sizeBytes)
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .send(Readable.from(object.body));
      },
    );
  });
}
