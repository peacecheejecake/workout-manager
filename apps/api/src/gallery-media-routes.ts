import { Readable } from 'node:stream';

import {
  GALLERY_VIDEO_MAX_BYTES,
  galleryMediaCreateUploadMetadataSchema,
  galleryMediaDeleteResultSchema,
  galleryMediaDescriptorSchema,
  galleryMediaExtension,
  galleryMediaListQuerySchema,
  galleryMediaListSchema,
  galleryMediaPreviewUploadMetadataSchema,
  galleryMediaReadResultSchema,
  galleryMediaSoftDeleteSchema,
  galleryMediaTypeSchema,
  galleryMediaUpdateSchema,
  galleryUploadReservationSchema,
} from '@workout/contracts/gallery';
import {
  createGalleryTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
} from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import {
  GalleryMediaNotFoundError,
  GalleryUploadStateError,
  type GalleryMediaRepository,
} from '@workout/server-persistence/gallery-media';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  GalleryUploadValidationError,
  resolveGalleryUploadPolicy,
  storeValidatedGalleryUpload,
  type GalleryUploadPolicy,
} from './gallery-media-upload.js';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const GALLERY_METADATA_BODY_LIMIT = 16 * 1024;
const GALLERY_CONTENT_BODY_LIMIT = GALLERY_VIDEO_MAX_BYTES;
const GALLERY_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;

const mediaParamsSchema = z.strictObject({
  mediaItemId: z.uuid().transform((value) => value.toLowerCase()),
});
const uploadParamsSchema = z.strictObject({
  uploadId: z.uuid().transform((value) => value.toLowerCase()),
});
const variantQuerySchema = z.strictObject({
  variant: z.enum(['original', 'preview']).default('original'),
});
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const encodedFileNameSchema = z
  .string()
  .min(1)
  .max(765)
  .regex(/^[A-Za-z0-9!'()*._~%-]+$/);

export interface GalleryMediaServices {
  media: GalleryMediaRepository;
  storage: ObjectStorage;
}

function galleryError(error: unknown): ProductRequestError | undefined {
  if (error instanceof GalleryMediaNotFoundError)
    return new ProductRequestError(404, 'MEDIA_NOT_FOUND');
  if (error instanceof GalleryUploadStateError) return new ProductRequestError(409, error.code);
  if (isObjectStorageConflict(error))
    return new ProductRequestError(409, 'OBJECT_STORAGE_CONFLICT');
  if (error instanceof GalleryUploadValidationError)
    return new ProductRequestError(
      error.code === 'UNSUPPORTED_FILE_TYPE' ? 415 : error.code === 'FILE_TOO_LARGE' ? 413 : 422,
      error.code,
    );
  return undefined;
}

function isObjectStorageConflict(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'OBJECT_STORAGE_CONFLICT';
}

function isObjectDeleteInProgress(error: unknown): boolean {
  return error instanceof Error && error.message === 'OBJECT_DELETE_IN_PROGRESS';
}

type UploadPhase = 'receiving' | 'prepared' | 'published';

function transientUploadError(error: unknown, phase: UploadPhase): ProductRequestError {
  if (error instanceof ProductRequestError && error.statusCode < 500) return error;
  if (isObjectDeleteInProgress(error)) return new ProductRequestError(409, 'UPLOAD_RETRY_REQUIRED');
  return new ProductRequestError(
    503,
    phase === 'prepared' ? 'UPLOAD_RETRY_REQUIRED' : 'UPLOAD_RESUME_REQUIRED',
  );
}

function execute<T>(operation: () => Promise<T>) {
  return command(operation, galleryError);
}

function decodedFileName(value: unknown): string {
  const encoded = input(encodedFileNameSchema, value);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  }
  if (encodeURIComponent(decoded) !== encoded)
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  return decoded;
}

function bodyStream(value: unknown): AsyncIterable<Uint8Array> {
  if (value instanceof Readable) return value;
  throw new ProductRequestError(400, 'INVALID_REQUEST');
}

function declaredContentLength(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = input(z.coerce.number().int().positive(), value);
  if (parsed > maximum) throw new ProductRequestError(413, 'FILE_TOO_LARGE');
  return parsed;
}

function contentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function registerGalleryMediaRoutes(
  routes: FastifyInstance,
  services: GalleryMediaServices,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (galleryRoutes) => {
    galleryRoutes.addContentTypeParser([...GALLERY_CONTENT_TYPES], (_request, payload, done) =>
      done(null, payload),
    );

    galleryRoutes.get('/gallery/media', async (request) =>
      galleryMediaListSchema.parse(
        await execute(() =>
          services.media.list(
            principal(request).athleteId,
            input(galleryMediaListQuerySchema, request.query),
          ),
        ),
      ),
    );

    galleryRoutes.get('/gallery/media/:mediaItemId', async (request) => {
      const { mediaItemId } = input(mediaParamsSchema, request.params);
      input(emptyQuery, request.query);
      const result = galleryMediaReadResultSchema.parse(
        await execute(() => services.media.read(principal(request).athleteId, mediaItemId)),
      );
      if (result.status !== 'available') throw new ProductRequestError(404, 'MEDIA_NOT_FOUND');
      z.literal(mediaItemId).parse(result.item.id);
      return result;
    });

    galleryRoutes.post(
      '/gallery/media/uploads',
      { bodyLimit: GALLERY_METADATA_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const metadata = input(galleryMediaCreateUploadMetadataSchema, request.body);
        const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
        return galleryUploadReservationSchema.parse(
          await execute(() =>
            services.media.reserveCreate(principal(request).athleteId, metadata, key),
          ),
        );
      },
    );

    galleryRoutes.post(
      '/gallery/media/:mediaItemId/preview-uploads',
      { bodyLimit: GALLERY_METADATA_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const { mediaItemId } = input(mediaParamsSchema, request.params);
        const metadata = input(galleryMediaPreviewUploadMetadataSchema, request.body);
        const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
        return galleryUploadReservationSchema.parse(
          await execute(() =>
            services.media.reservePreview(principal(request).athleteId, mediaItemId, metadata, key),
          ),
        );
      },
    );

    galleryRoutes.put(
      '/gallery/media/uploads/:uploadId/content',
      { bodyLimit: GALLERY_CONTENT_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const athleteId = principal(request).athleteId;
        const { uploadId } = input(uploadParamsSchema, request.params);
        const reservation = galleryUploadReservationSchema.parse(
          await execute(() => services.media.getUpload(athleteId, uploadId)),
        );
        if (reservation.state === 'failed') throw new ProductRequestError(409, 'UPLOAD_FAILED');
        const fileName = decodedFileName(request.headers['x-gallery-file-name']);
        let policy: GalleryUploadPolicy;
        try {
          policy = resolveGalleryUploadPolicy({
            fileName,
            declaredMimeType: z.string().parse(request.headers['content-type'] ?? ''),
            operation: reservation.operation,
          });
        } catch (error) {
          throw galleryError(error) ?? error;
        }
        const declaredLength = declaredContentLength(
          request.headers['content-length'],
          policy.maxBytes,
        );
        let phase: UploadPhase = 'receiving';
        let failureRecorded = false;
        try {
          const stored = await storeValidatedGalleryUpload({
            storage: services.storage,
            tenantId: athleteId,
            mediaItemId: reservation.mediaItemId,
            uploadId,
            policy,
            body: bodyStream(request.body),
            onPrepared: async (prepared) => {
              const expectedTemporaryKey = createGalleryTemporaryObjectKey({
                tenantId: athleteId,
                mediaItemId: reservation.mediaItemId,
                uploadId,
              });
              if (prepared.temporaryKey !== expectedTemporaryKey)
                throw new Error('UPLOAD_TEMPORARY_REF_MISMATCH');
              const file = galleryMediaDescriptorSchema.parse({
                originalFileName: fileName,
                mediaType: prepared.mediaType,
                byteSize: prepared.sizeBytes,
                sha256: prepared.sha256,
              });
              await execute(() =>
                services.media.prepareObject(athleteId, uploadId, {
                  storageRef: prepared.finalKey,
                  file,
                }),
              );
              phase = 'prepared';
            },
          });
          phase = 'published';
          if (declaredLength !== undefined && declaredLength !== stored.sizeBytes) {
            await execute(() =>
              services.media.fail(athleteId, uploadId, 'CONTENT_LENGTH_MISMATCH'),
            );
            failureRecorded = true;
            throw new ProductRequestError(400, 'CONTENT_LENGTH_MISMATCH');
          }
          return galleryUploadReservationSchema.parse(
            await execute(() => services.media.markStaged(athleteId, uploadId)),
          );
        } catch (error) {
          if (
            !failureRecorded &&
            reservation.state !== 'finalized' &&
            (error instanceof GalleryUploadValidationError || isObjectStorageConflict(error))
          ) {
            const code =
              error instanceof GalleryUploadValidationError
                ? error.code
                : 'OBJECT_STORAGE_CONFLICT';
            await services.media.fail(athleteId, uploadId, code).catch(() => undefined);
          }
          throw galleryError(error) ?? transientUploadError(error, phase);
        }
      },
    );

    galleryRoutes.post(
      '/gallery/media/uploads/:uploadId/finalize',
      { bodyLimit: 1024 },
      async (request) => {
        input(emptyQuery, request.query);
        if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
        const { uploadId } = input(uploadParamsSchema, request.params);
        const result = galleryMediaReadResultSchema.parse(
          await execute(() => services.media.finalize(principal(request).athleteId, uploadId)),
        );
        if (result.status !== 'available') throw new ProductRequestError(404, 'MEDIA_NOT_FOUND');
        return result;
      },
    );

    galleryRoutes.patch(
      '/gallery/media/:mediaItemId',
      { bodyLimit: GALLERY_METADATA_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const { mediaItemId } = input(mediaParamsSchema, request.params);
        const body = input(galleryMediaUpdateSchema.omit({ idempotencyKey: true }), request.body);
        const payload = input(galleryMediaUpdateSchema, {
          ...body,
          idempotencyKey: request.headers['idempotency-key'],
        });
        const result = galleryMediaReadResultSchema.parse(
          await execute(() =>
            services.media.update(principal(request).athleteId, mediaItemId, payload),
          ),
        );
        if (result.status !== 'available') throw new ProductRequestError(404, 'MEDIA_NOT_FOUND');
        z.literal(mediaItemId).parse(result.item.id);
        return result;
      },
    );

    galleryRoutes.delete(
      '/gallery/media/:mediaItemId',
      { bodyLimit: GALLERY_METADATA_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const { mediaItemId } = input(mediaParamsSchema, request.params);
        const body = input(
          galleryMediaSoftDeleteSchema.omit({ idempotencyKey: true }),
          request.body,
        );
        const payload = input(galleryMediaSoftDeleteSchema, {
          ...body,
          idempotencyKey: request.headers['idempotency-key'],
        });
        const result = galleryMediaDeleteResultSchema.parse(
          await execute(() =>
            services.media.softDelete(principal(request).athleteId, mediaItemId, payload),
          ),
        );
        z.literal(mediaItemId).parse(result.mediaItemId);
        return result;
      },
    );

    galleryRoutes.get('/gallery/media/:mediaItemId/content', async (request, reply) => {
      const athleteId = principal(request).athleteId;
      const { mediaItemId } = input(mediaParamsSchema, request.params);
      const { variant } = input(variantQuerySchema, request.query);
      const resolved = await execute(() =>
        services.media.resolveObject(athleteId, mediaItemId, variant),
      );
      if (resolved === null) throw new ProductRequestError(404, 'MEDIA_NOT_FOUND');
      const objectKey = validateObjectKey(resolved.storageRef);
      const parsedKey = parseObjectKey(objectKey);
      const mediaType = galleryMediaTypeSchema.parse(resolved.mediaType);
      if (
        parsedKey.kind !== 'gallery_final' ||
        parsedKey.tenantId !== athleteId ||
        parsedKey.mediaItemId !== mediaItemId ||
        parsedKey.sha256 !== resolved.sha256 ||
        parsedKey.extension !== galleryMediaExtension(mediaType)
      )
        throw new Error('INVALID_GALLERY_STORAGE_REF');
      const object = await services.storage.open(objectKey);
      if (object === null || object.sizeBytes !== resolved.byteSize)
        throw new ProductRequestError(503, 'MEDIA_CONTENT_UNAVAILABLE');
      return reply
        .header('content-type', mediaType)
        .header('content-length', object.sizeBytes)
        .header('cache-control', 'private, no-store')
        .header('content-disposition', contentDisposition(resolved.originalFileName))
        .send(Readable.from(object.body));
    });
  });
}
