import {
  galleryAlbumCreateCommandV1Schema,
  galleryAlbumDeleteCommandV1Schema,
  galleryAlbumDeleteResultV1Schema,
  galleryAlbumListPageV1Schema,
  galleryAlbumListQueryV1Schema,
  galleryAlbumRenameCommandV1Schema,
  galleryAlbumV1Schema,
  galleryMediaMembershipCommandV2Schema,
  galleryMediaNavigationQueryV2Schema,
  galleryNavigationIdempotencyKeySchema,
  galleryNavigationV2Limits,
  type GalleryAlbumCreateCommandV1,
  type GalleryAlbumDeleteCommandV1,
  type GalleryAlbumListQueryV1,
  type GalleryAlbumRenameCommandV1,
  type GalleryMediaMembershipCommandV2,
  type GalleryMediaNavigationQueryV2,
} from '@workout/contracts/gallery-navigation-v2';
import {
  galleryMediaNavigationPageV3Schema,
  galleryMediaNavigationV3Schema,
} from '@workout/contracts/gallery-navigation-v3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { principalSchema, type Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

/** Register inside the existing authenticated product plugin (including cookie CSRF guards). */
export interface GalleryNavigationServices {
  navigate(athleteId: string, query: GalleryMediaNavigationQueryV2): Promise<unknown>;
  listAlbums(athleteId: string, query: GalleryAlbumListQueryV1): Promise<unknown>;
  createAlbum(athleteId: string, value: GalleryAlbumCreateCommandV1, key: string): Promise<unknown>;
  renameAlbum(athleteId: string, value: GalleryAlbumRenameCommandV1, key: string): Promise<unknown>;
  deleteAlbum(athleteId: string, value: GalleryAlbumDeleteCommandV1, key: string): Promise<unknown>;
  updateMembership(
    athleteId: string,
    value: GalleryMediaMembershipCommandV2,
    key: string,
  ): Promise<unknown>;
}

export class GalleryNavigationServiceError extends Error {
  constructor(
    readonly code:
      | 'ALBUM_NOT_FOUND'
      | 'MEDIA_NOT_FOUND'
      | 'COURSE_NOT_FOUND'
      | 'ALBUM_CONFLICT'
      | 'MEDIA_ACCESS_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'GALLERY_NAVIGATION_UNAVAILABLE',
  ) {
    super(code);
  }
}
const albumParams = z.strictObject({ albumId: z.uuid().transform((v) => v.toLowerCase()) });
const mediaParams = z.strictObject({ mediaItemId: z.uuid().transform((v) => v.toLowerCase()) });
const jsonQuery = z.strictObject({
  query: z.string().min(1).max(galleryNavigationV2Limits.encodedBytes),
});

function canonicalQuery<T>(schema: z.ZodType<T>, raw: unknown): T {
  const { query } = input(jsonQuery, raw);
  if (Buffer.byteLength(query, 'utf8') > galleryNavigationV2Limits.encodedBytes)
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  let parsed: unknown;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  }
  const value = input(schema, parsed);
  // Reject ambiguous duplicate keys, noncanonical numbers/order/whitespace and
  // normalization changes; the module adapter serializes the parsed schema value.
  if (JSON.stringify(value) !== query) throw new ProductRequestError(400, 'INVALID_REQUEST');
  return value;
}
function output<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ProductRequestError(502, 'INVALID_REPLY');
  return result.data;
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function correlated(matches: boolean) {
  if (!matches) throw new ProductRequestError(502, 'INVALID_REPLY');
}
function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (!(error instanceof GalleryNavigationServiceError)) return undefined;
    const status =
      error.code === 'GALLERY_NAVIGATION_UNAVAILABLE'
        ? 503
        : error.code === 'ALBUM_NOT_FOUND' ||
            error.code === 'MEDIA_NOT_FOUND' ||
            error.code === 'COURSE_NOT_FOUND'
          ? 404
          : 409;
    return new ProductRequestError(status, error.code);
  });
}

export function registerGalleryNavigationRoutes(
  routes: FastifyInstance,
  services: GalleryNavigationServices | undefined,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (gallery) => {
    function owner(request: FastifyRequest) {
      return input(principalSchema, principal(request)).athleteId;
    }
    function service() {
      if (!services) throw new ProductRequestError(503, 'GALLERY_NAVIGATION_UNAVAILABLE');
      return services;
    }
    function write(request: FastifyRequest) {
      const athleteId = owner(request);
      input(emptyQuery, request.query);
      const key = input(galleryNavigationIdempotencyKeySchema, request.headers['idempotency-key']);
      return { athleteId, key };
    }
    gallery.get('/gallery/media/navigation', async (request) => {
      const athleteId = owner(request);
      const query = canonicalQuery(galleryMediaNavigationQueryV2Schema, request.query);
      const page = output(
        galleryMediaNavigationPageV3Schema,
        await execute(() => service().navigate(athleteId, query)),
      );
      correlated(same(page.query, query));
      return page;
    });
    gallery.get('/gallery/albums', async (request) => {
      const athleteId = owner(request);
      const query = canonicalQuery(galleryAlbumListQueryV1Schema, request.query);
      const page = output(
        galleryAlbumListPageV1Schema,
        await execute(() => service().listAlbums(athleteId, query)),
      );
      correlated(same(page.query, query));
      return page;
    });
    const options = { bodyLimit: galleryNavigationV2Limits.encodedBytes };
    gallery.post('/gallery/albums', options, async (request) => {
      const { athleteId, key } = write(request);
      const value = input(galleryAlbumCreateCommandV1Schema, request.body);
      const album = output(
        galleryAlbumV1Schema,
        await execute(() => service().createAlbum(athleteId, value, key)),
      );
      correlated(album.title === value.title && album.revision === 1);
      return album;
    });
    gallery.patch('/gallery/albums/:albumId', options, async (request) => {
      const { athleteId, key } = write(request);
      const { albumId } = input(albumParams, request.params);
      const value = input(galleryAlbumRenameCommandV1Schema, request.body);
      if (albumId !== value.albumId) throw new ProductRequestError(400, 'INVALID_REQUEST');
      const album = output(
        galleryAlbumV1Schema,
        await execute(() => service().renameAlbum(athleteId, value, key)),
      );
      correlated(
        album.id === albumId &&
          album.title === value.title &&
          album.revision === value.expectedRevision + 1,
      );
      return album;
    });
    gallery.delete('/gallery/albums/:albumId', options, async (request) => {
      const { athleteId, key } = write(request);
      const { albumId } = input(albumParams, request.params);
      const value = input(galleryAlbumDeleteCommandV1Schema, request.body);
      if (albumId !== value.albumId) throw new ProductRequestError(400, 'INVALID_REQUEST');
      const result = output(
        galleryAlbumDeleteResultV1Schema,
        await execute(() => service().deleteAlbum(athleteId, value, key)),
      );
      correlated(result.albumId === albumId && result.revision === value.expectedRevision + 1);
      return result;
    });
    gallery.put('/gallery/media/:mediaItemId/membership', options, async (request) => {
      const { athleteId, key } = write(request);
      const { mediaItemId } = input(mediaParams, request.params);
      const value = input(galleryMediaMembershipCommandV2Schema, request.body);
      if (mediaItemId !== value.mediaItemId) throw new ProductRequestError(400, 'INVALID_REQUEST');
      const result = output(
        galleryMediaNavigationV3Schema,
        await execute(() => service().updateMembership(athleteId, value, key)),
      );
      correlated(
        result.item.id === mediaItemId &&
          result.item.accessRevision === value.expectedAccessRevision + 1 &&
          same(result.albumMembership, value.albumMembership) &&
          same(result.courseLink, value.courseLink),
      );
      return result;
    });
  });
}
