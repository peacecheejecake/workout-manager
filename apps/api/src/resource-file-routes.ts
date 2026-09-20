import { Readable } from 'node:stream';

import {
  privateFileResourceAppendVersionUploadMetadataSchema,
  privateFileResourceCreateUploadMetadataSchema,
  privateFileResourceDescriptorSchema,
  privateFileResourceNameSchema,
  privateResourceReadResultSchema,
} from '@workout/contracts/resources';
import {
  createTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
} from '@workout/server-media/keys';
import { type ObjectStorage } from '@workout/server-media/object-storage';
import { storeValidatedUpload } from '@workout/server-media/upload';
import { resolveUploadPolicy, UploadValidationError } from '@workout/server-media/validation';
import {
  ResourceFileUploadStateError,
  type ResourceFileUploadRepository,
} from '@workout/server-persistence/resource-file-uploads';
import type { ResourceAccessRepository } from '@workout/server-persistence/resource-access';
import { ResourceNotFoundError } from '@workout/server-persistence/resources';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uploadParamsSchema = z.strictObject({
  uploadId: z.uuid().transform((value) => value.toLowerCase()),
});
const resourceParamsSchema = z.strictObject({
  resourceId: z.uuid().transform((value) => value.toLowerCase()),
});
const sharedContentParamsSchema = z.strictObject({
  ownerPrincipalId: z.string().min(1).max(200),
  resourceId: z.uuid().transform((value) => value.toLowerCase()),
});
const contentQuerySchema = z.strictObject({
  versionId: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
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
const uploadReservationSchema = z.strictObject({
  uploadId: z.uuid(),
  resourceId: z.uuid(),
  versionId: z.uuid(),
  state: z.enum(['reserved', 'prepared', 'staged', 'finalized', 'failed']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export interface ResourceFileServices {
  uploads: ResourceFileUploadRepository;
  storage: ObjectStorage;
  /** Present when explicit sharing is configured; enables grantee file reads. */
  sharedAccess?: ResourceAccessRepository;
}

function fileError(error: unknown): ProductRequestError | undefined {
  if (error instanceof ResourceNotFoundError)
    return new ProductRequestError(404, 'RESOURCE_NOT_FOUND');
  if (error instanceof ResourceFileUploadStateError)
    return new ProductRequestError(409, error.code);
  if (isObjectStorageConflict(error))
    return new ProductRequestError(409, 'OBJECT_STORAGE_CONFLICT');
  if (error instanceof UploadValidationError) {
    return new ProductRequestError(error.code === 'UNSUPPORTED_FILE_TYPE' ? 415 : 422, error.code);
  }
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
  if (error instanceof ProductRequestError) {
    if (error.statusCode < 500) return error;
  }
  if (isObjectDeleteInProgress(error)) return new ProductRequestError(409, 'UPLOAD_RETRY_REQUIRED');
  return new ProductRequestError(
    503,
    phase === 'prepared' ? 'UPLOAD_RETRY_REQUIRED' : 'UPLOAD_RESUME_REQUIRED',
  );
}

function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    return fileError(error);
  });
}

function publicReservation(value: unknown) {
  return uploadReservationSchema.parse(value);
}

function encodedFileName(value: unknown): string {
  const encoded = input(encodedFileNameSchema, value);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  }
  if (encodeURIComponent(decoded) !== encoded)
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  return input(privateFileResourceNameSchema, decoded);
}

function contentType(value: unknown): 'application/pdf' | 'text/markdown' {
  return input(z.enum(['application/pdf', 'text/markdown']), value);
}

function bodyStream(value: unknown): AsyncIterable<Uint8Array> {
  if (value instanceof Readable) return value;
  throw new ProductRequestError(400, 'INVALID_REQUEST');
}

function contentLength(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = input(z.coerce.number().int().positive(), value);
  if (parsed > maximum) throw new ProductRequestError(413, 'FILE_TOO_LARGE');
  return parsed;
}

function fileExtension(fileName: string): 'pdf' | 'md' | 'markdown' {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return input(z.enum(['pdf', 'md', 'markdown']), extension);
}

function contentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function registerResourceFileRoutes(
  routes: FastifyInstance,
  services: ResourceFileServices,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (fileRoutes) => {
    fileRoutes.addContentTypeParser(
      ['application/pdf', 'text/markdown'],
      (_request, payload, done) => done(null, payload),
    );

    fileRoutes.post('/resources/uploads', { bodyLimit: 16 * 1024 }, async (request) => {
      input(emptyQuery, request.query);
      const metadata = input(privateFileResourceCreateUploadMetadataSchema, request.body);
      const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
      return publicReservation(
        await execute(() =>
          services.uploads.reserveCreate(principal(request).athleteId, metadata, key),
        ),
      );
    });

    fileRoutes.post('/resources/:resourceId/uploads', { bodyLimit: 16 * 1024 }, async (request) => {
      input(emptyQuery, request.query);
      const { resourceId } = input(resourceParamsSchema, request.params);
      const metadata = input(privateFileResourceAppendVersionUploadMetadataSchema, request.body);
      const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
      return publicReservation(
        await execute(() =>
          services.uploads.reserveAppend(principal(request).athleteId, resourceId, metadata, key),
        ),
      );
    });

    fileRoutes.put(
      '/resources/uploads/:uploadId/content',
      { bodyLimit: 10 * 1024 * 1024 },
      async (request) => {
        input(emptyQuery, request.query);
        const athleteId = principal(request).athleteId;
        const { uploadId } = input(uploadParamsSchema, request.params);
        const reservation = uploadReservationSchema.parse(
          await execute(() => services.uploads.get(athleteId, uploadId)),
        );
        if (reservation.state === 'failed') throw new ProductRequestError(409, 'UPLOAD_FAILED');
        const fileName = encodedFileName(request.headers['x-resource-file-name']);
        const declaredMimeType = contentType(request.headers['content-type']);
        let policy: ReturnType<typeof resolveUploadPolicy>;
        try {
          policy = resolveUploadPolicy({ fileName, declaredMimeType });
        } catch (error) {
          throw fileError(error) ?? error;
        }
        const declaredLength = contentLength(request.headers['content-length'], policy.maxBytes);
        let phase: UploadPhase = 'receiving';
        let failureRecorded = false;
        try {
          const stored = await storeValidatedUpload({
            storage: services.storage,
            tenantId: athleteId,
            resourceId: reservation.resourceId,
            uploadId,
            fileName,
            declaredMimeType,
            body: bodyStream(request.body),
            onPrepared: async (prepared) => {
              const expectedTemporaryKey = createTemporaryObjectKey({
                tenantId: athleteId,
                resourceId: reservation.resourceId,
                uploadId,
              });
              if (prepared.temporaryKey !== expectedTemporaryKey)
                throw new Error('UPLOAD_TEMPORARY_REF_MISMATCH');
              const file = privateFileResourceDescriptorSchema.parse({
                originalFileName: fileName,
                extension: fileExtension(fileName),
                mediaType: prepared.mimeType,
                byteSize: prepared.sizeBytes,
                sha256: prepared.sha256,
              });
              await execute(() =>
                services.uploads.prepareObject(athleteId, uploadId, {
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
              services.uploads.fail(athleteId, uploadId, 'CONTENT_LENGTH_MISMATCH'),
            );
            failureRecorded = true;
            throw new ProductRequestError(400, 'CONTENT_LENGTH_MISMATCH');
          }
          return publicReservation(
            await execute(() => services.uploads.markStaged(athleteId, uploadId)),
          );
        } catch (error) {
          if (
            !failureRecorded &&
            reservation.state !== 'finalized' &&
            (error instanceof UploadValidationError || isObjectStorageConflict(error))
          ) {
            const code =
              error instanceof UploadValidationError ? error.code : 'OBJECT_STORAGE_CONFLICT';
            await services.uploads.fail(athleteId, uploadId, code).catch(() => undefined);
          }
          throw fileError(error) ?? transientUploadError(error, phase);
        }
      },
    );

    fileRoutes.post(
      '/resources/uploads/:uploadId/finalize',
      { bodyLimit: 1024 },
      async (request) => {
        input(emptyQuery, request.query);
        if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
        const { uploadId } = input(uploadParamsSchema, request.params);
        return privateResourceReadResultSchema.parse(
          await execute(() => services.uploads.finalize(principal(request).athleteId, uploadId)),
        );
      },
    );

    fileRoutes.get('/resources/:resourceId/content', async (request, reply) => {
      const athleteId = principal(request).athleteId;
      const { resourceId } = input(resourceParamsSchema, request.params);
      const { versionId } = input(contentQuerySchema, request.query);
      const resolved = await execute(() =>
        services.uploads.resolveObject(athleteId, resourceId, versionId),
      );
      if (resolved === null) throw new ProductRequestError(404, 'RESOURCE_NOT_FOUND');
      const objectKey = validateObjectKey(resolved.storageRef);
      const parsedKey = parseObjectKey(objectKey);
      const expectedExtension = resolved.file.mediaType === 'application/pdf' ? 'pdf' : 'md';
      if (
        parsedKey.kind !== 'final' ||
        parsedKey.tenantId !== athleteId ||
        parsedKey.resourceId !== resourceId ||
        parsedKey.sha256 !== resolved.file.sha256 ||
        parsedKey.extension !== expectedExtension
      )
        throw new Error('INVALID_RESOURCE_STORAGE_REF');
      const object = await services.storage.open(objectKey);
      if (object === null || object.sizeBytes !== resolved.file.byteSize)
        throw new ProductRequestError(503, 'RESOURCE_CONTENT_UNAVAILABLE');
      return reply
        .header('content-type', resolved.file.mediaType)
        .header('content-length', object.sizeBytes)
        .header('content-disposition', contentDisposition(resolved.file.originalFileName))
        .send(Readable.from(object.body));
    });

    // Grantee file reads stream through the server. The active share is
    // re-validated at the start of every request and no storage reference,
    // owner key or signed URL ever reaches the client. Authorization is
    // request-start only: revocation blocks every subsequent request but does
    // not abort a transfer already in flight. Shared files are bounded at
    // 10 MiB and the object is opened immediately after authorization, so the
    // window stays one bounded response body.
    const sharedAccess = services.sharedAccess;
    if (sharedAccess)
      fileRoutes.get(
        '/resources/shared-with-me/:ownerPrincipalId/:resourceId/content',
        async (request, reply) => {
          input(emptyQuery, request.query);
          const granteeId = principal(request).athleteId;
          const { ownerPrincipalId, resourceId } = input(sharedContentParamsSchema, request.params);
          const resolved = await execute(() =>
            sharedAccess.resolveSharedObject(granteeId, ownerPrincipalId, resourceId),
          );
          if (resolved === null) throw new ProductRequestError(404, 'SHARED_RESOURCE_NOT_FOUND');
          const objectKey = validateObjectKey(resolved.storageRef);
          const parsedKey = parseObjectKey(objectKey);
          const expectedExtension = resolved.file.mediaType === 'application/pdf' ? 'pdf' : 'md';
          if (
            parsedKey.kind !== 'final' ||
            parsedKey.tenantId !== resolved.ownerPrincipalId ||
            parsedKey.resourceId !== resolved.resourceId ||
            parsedKey.sha256 !== resolved.file.sha256 ||
            parsedKey.extension !== expectedExtension
          )
            throw new Error('INVALID_RESOURCE_STORAGE_REF');
          const object = await services.storage.open(objectKey);
          if (object === null || object.sizeBytes !== resolved.file.byteSize)
            throw new ProductRequestError(503, 'RESOURCE_CONTENT_UNAVAILABLE');
          return reply
            .header('content-type', resolved.file.mediaType)
            .header('content-length', object.sizeBytes)
            .header('content-disposition', contentDisposition(resolved.file.originalFileName))
            .send(Readable.from(object.body));
        },
      );
  });
}
