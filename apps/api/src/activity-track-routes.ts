import { Readable } from 'node:stream';

import {
  activityTrackDownloadVariantSchema,
  activityTrackReadResultSchema,
  activityTrackReserveMetadataSchema,
  activityTrackUploadReservationSchema,
} from '@workout/contracts/activity-tracks';
import { trackLimits, trackTextSchema } from '@workout/contracts/tracks';
import {
  createActivityTrackTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
} from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import {
  ActivityTrackNotFoundError,
  ActivityTrackUploadStateError,
  type ActivityTrackRepository,
} from '@workout/server-persistence/activity-tracks';
import type { BoundedTrackParser } from '@workout/server-track-storage/parse-host';
import {
  serializeMapPath,
  serializeNormalizedTrack,
  trackCorrespondenceDigest,
} from '@workout/server-track-storage/derive';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  ActivityTrackUploadValidationError,
  activityTrackObjectKeys,
  createValidatedTrackUploadStream,
  readStoredObject,
} from './activity-track-upload.js';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const TRACK_METADATA_BODY_LIMIT = 4 * 1024;
const TRACK_CONTENT_TYPES = ['application/octet-stream'] as const;

const activityParamsSchema = z.strictObject({
  activityId: z.uuid().transform((value) => value.toLowerCase()),
});
const uploadParamsSchema = z.strictObject({
  uploadId: z.uuid().transform((value) => value.toLowerCase()),
});
const variantQuerySchema = z.strictObject({
  variant: activityTrackDownloadVariantSchema.default('raw'),
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

export interface ActivityTrackServices {
  tracks: ActivityTrackRepository;
  storage: ObjectStorage;
  parser: BoundedTrackParser;
}

function trackError(error: unknown): ProductRequestError | undefined {
  if (error instanceof ActivityTrackNotFoundError)
    return new ProductRequestError(404, 'ACTIVITY_TRACK_NOT_FOUND');
  if (error instanceof ActivityTrackUploadStateError)
    return new ProductRequestError(409, error.code);
  if (isObjectStorageConflict(error))
    return new ProductRequestError(409, 'OBJECT_STORAGE_CONFLICT');
  if (error instanceof ActivityTrackUploadValidationError)
    return new ProductRequestError(error.code === 'FILE_TOO_LARGE' ? 413 : 422, error.code);
  return undefined;
}

function isObjectStorageConflict(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'OBJECT_STORAGE_CONFLICT';
}

function isObjectDeleteInProgress(error: unknown): boolean {
  return error instanceof Error && error.message === 'OBJECT_DELETE_IN_PROGRESS';
}

type UploadPhase = 'receiving' | 'parsed' | 'prepared' | 'published';

function transientUploadError(error: unknown, phase: UploadPhase): ProductRequestError {
  if (error instanceof ProductRequestError && error.statusCode < 500) return error;
  if (isObjectDeleteInProgress(error)) return new ProductRequestError(409, 'UPLOAD_RETRY_REQUIRED');
  return new ProductRequestError(
    503,
    phase === 'prepared' || phase === 'published'
      ? 'UPLOAD_RETRY_REQUIRED'
      : 'UPLOAD_RESUME_REQUIRED',
  );
}

function execute<T>(operation: () => Promise<T>) {
  return command(operation, trackError);
}

function decodedFileName(value: unknown): string | null {
  if (value === undefined) return null;
  const encoded = input(encodedFileNameSchema, value);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  }
  if (encodeURIComponent(decoded) !== encoded)
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  // Control, bidirectional-override and angle-bracket characters never reach storage.
  return input(trackTextSchema, decoded);
}

function bodyStream(value: unknown): AsyncIterable<Uint8Array> {
  if (value instanceof Readable) return value;
  throw new ProductRequestError(400, 'INVALID_REQUEST');
}

function declaredContentLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = input(z.coerce.number().int().positive(), value);
  if (parsed > trackLimits.fileBytes) throw new ProductRequestError(413, 'FILE_TOO_LARGE');
  return parsed;
}

function contentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Private recorded-track storage.
 *
 * The owner comes from the session on every route; there is no athlete id in any path,
 * query or body. There is deliberately no deletion endpoint: a stored track is reclaimed
 * by deleting its activity, which keeps the existing source/canonical/overlay and
 * suppression semantics and queues the objects in the durable cleanup manifest.
 */
export function registerActivityTrackRoutes(
  routes: FastifyInstance,
  services: ActivityTrackServices,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (trackRoutes) => {
    trackRoutes.addContentTypeParser([...TRACK_CONTENT_TYPES], (_request, payload, done) =>
      done(null, payload),
    );

    trackRoutes.post(
      '/activities/:activityId/track-uploads',
      { bodyLimit: TRACK_METADATA_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const { activityId } = input(activityParamsSchema, request.params);
        const metadata = input(activityTrackReserveMetadataSchema, request.body);
        const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
        return activityTrackUploadReservationSchema.parse(
          await execute(() =>
            services.tracks.reserve(principal(request).athleteId, activityId, metadata, key),
          ),
        );
      },
    );

    trackRoutes.put(
      '/activity-track-uploads/:uploadId/content',
      { bodyLimit: trackLimits.fileBytes },
      async (request) => {
        input(emptyQuery, request.query);
        const athleteId = principal(request).athleteId;
        const { uploadId } = input(uploadParamsSchema, request.params);
        const context = await execute(() => services.tracks.getUploadContext(athleteId, uploadId));
        if (context.state === 'failed') throw new ProductRequestError(409, 'UPLOAD_FAILED');
        const fileName = decodedFileName(request.headers['x-track-file-name']);
        const declaredLength = declaredContentLength(request.headers['content-length']);
        // The temporary key is known before a byte arrives — it was recorded at
        // reservation — while the final key needs the digest of the stored bytes.
        const rawTemporary = createActivityTrackTemporaryObjectKey({
          tenantId: athleteId,
          activityId: context.activityId,
          trackId: context.trackId,
          uploadId,
          artifactKind: 'raw',
        });
        let phase: UploadPhase = 'receiving';
        let temporaryOwned = false;
        let durablyPrepared = false;
        let failureRecorded = false;
        let fenceClosed = false;
        const publishedTemporaries: (typeof rawTemporary)[] = [];
        try {
          const validated = createValidatedTrackUploadStream(bodyStream(request.body));
          const stored = await services.storage.writeTemporary(rawTemporary, validated.body);
          temporaryOwned = true;
          const upload = await validated.result;
          if (stored.sizeBytes !== upload.sizeBytes)
            throw new Error('TRACK_TEMPORARY_SIZE_MISMATCH');
          if (declaredLength !== undefined && declaredLength !== upload.sizeBytes) {
            await execute(() =>
              services.tracks.fail(athleteId, uploadId, 'CONTENT_LENGTH_MISMATCH'),
            );
            failureRecorded = true;
            throw new ProductRequestError(400, 'CONTENT_LENGTH_MISMATCH');
          }
          // The server never trusts a client parse result — there is no place in this API
          // to send one. It re-parses the bytes it stored, under the same contract limits
          // and a real heap ceiling, and every stored fact comes from that parse.
          const bytes = await readStoredObject(services.storage, rawTemporary, upload.sizeBytes);
          const parsed = await services.parser.parse(
            bytes,
            {
              recordedTrackIndex: context.recordedTrackIndex,
              provenance: {
                kind: 'activity-source',
                activityId: context.activityId,
                sourceId: context.sourceId,
                sourceRevision: context.sourceRevision,
                trackRevision: context.trackRevision,
              },
            },
            { filename: fileName },
          );
          if (!parsed.ok) {
            await execute(() => services.tracks.fail(athleteId, uploadId, parsed.code));
            failureRecorded = true;
            throw new ProductRequestError(422, parsed.code);
          }
          phase = 'parsed';
          const artifacts = parsed.artifacts;
          if (artifacts.fileSha256 !== upload.sha256) throw new Error('TRACK_DIGEST_MISMATCH');
          const normalized = serializeNormalizedTrack(artifacts.track);
          const mapPath = serializeMapPath(artifacts.mapPath);
          const keys = {
            raw: activityTrackObjectKeys({
              tenantId: athleteId,
              activityId: context.activityId,
              trackId: context.trackId,
              uploadId,
              artifactKind: 'raw',
              sha256: upload.sha256,
              extension: artifacts.format,
            }),
            normalized: activityTrackObjectKeys({
              tenantId: athleteId,
              activityId: context.activityId,
              trackId: context.trackId,
              uploadId,
              artifactKind: 'normalized',
              sha256: normalized.sha256,
              extension: 'json',
            }),
            mapPath: activityTrackObjectKeys({
              tenantId: athleteId,
              activityId: context.activityId,
              trackId: context.trackId,
              uploadId,
              artifactKind: 'map_path',
              sha256: mapPath.sha256,
              extension: 'json',
            }),
          };
          if (keys.raw.temporary !== rawTemporary) throw new Error('TRACK_TEMPORARY_REF_MISMATCH');
          await services.storage.writeTemporary(
            keys.normalized.temporary,
            (async function* () {
              yield normalized.bytes;
            })(),
          );
          publishedTemporaries.push(keys.normalized.temporary);
          await services.storage.writeTemporary(
            keys.mapPath.temporary,
            (async function* () {
              yield mapPath.bytes;
            })(),
          );
          publishedTemporaries.push(keys.mapPath.temporary);
          const correspondence = trackCorrespondenceDigest(artifacts.track, {
            parserId: artifacts.parserId,
            parserVersion: artifacts.parserVersion,
          });
          // Every final reference is durable before any of the three objects is published.
          await execute(() =>
            services.tracks.prepareObjects(athleteId, uploadId, {
              raw: {
                storageRef: keys.raw.final,
                sizeBytes: upload.sizeBytes,
                sha256: upload.sha256,
                format: artifacts.format,
                originalFileName: artifacts.originalFilename,
              },
              normalized: {
                storageRef: keys.normalized.final,
                sizeBytes: normalized.bytes.byteLength,
                sha256: normalized.sha256,
              },
              mapPath: {
                storageRef: keys.mapPath.final,
                sizeBytes: mapPath.bytes.byteLength,
                sha256: mapPath.sha256,
              },
              parse: {
                parserId: correspondence.parserId,
                parserVersion: 1,
                recordedSourceKind: artifacts.track.sourceKind,
                correspondenceDigest: correspondence.digest,
                sampleCount: artifacts.aggregates.sampleCount,
                positionedSampleCount: artifacts.aggregates.positionedSampleCount,
                segmentCount: artifacts.aggregates.segmentCount,
                segmentPolicy: artifacts.track.segmentPolicy,
                distances: artifacts.track.distances,
              },
            }),
          );
          durablyPrepared = true;
          phase = 'prepared';
          // Publication happens inside the window preparation granted, and not otherwise.
          // Object cleanup defers only while that window is open, so the fence is re-checked
          // before *each* object is made visible: a request that stalled past it stops here
          // instead of publishing into a manifest that has already accounted for it.
          const publish = async (
            keys_: { temporary: typeof rawTemporary; final: string },
            expectation: { sizeBytes: number; sha256: string },
          ) => {
            if (!(await services.tracks.publicationFenceOpen(athleteId, uploadId))) {
              fenceClosed = true;
              throw new ProductRequestError(409, 'UPLOAD_RETRY_REQUIRED');
            }
            await services.storage.publishTemporary(
              keys_.temporary,
              keys_.final as typeof keys.raw.final,
              expectation,
            );
          };
          await publish(keys.raw, { sizeBytes: upload.sizeBytes, sha256: upload.sha256 });
          await publish(keys.normalized, {
            sizeBytes: normalized.bytes.byteLength,
            sha256: normalized.sha256,
          });
          await publish(keys.mapPath, {
            sizeBytes: mapPath.bytes.byteLength,
            sha256: mapPath.sha256,
          });
          phase = 'published';
          return activityTrackUploadReservationSchema.parse(
            await execute(() => services.tracks.markStaged(athleteId, uploadId)),
          );
        } catch (error) {
          // Before the references are durable, a half-written temporary object is this
          // request's own garbage and is removed here. Afterwards it belongs to the
          // durable manifest, which re-verifies live references before deleting anything.
          if (temporaryOwned && !durablyPrepared) {
            await services.storage.delete(rawTemporary).catch(() => undefined);
            for (const key of publishedTemporaries)
              await services.storage.delete(key).catch(() => undefined);
          }
          // This request may have published objects and only then discovered that its
          // upload was cancelled — an activity deleted while the bytes were in flight. The
          // objects exist and their queue rows may already be completed, so they are
          // handed back to the manifest explicitly. A still-live upload is left untouched
          // by the database function, so a slow-but-valid publication is never reclaimed.
          if (durablyPrepared)
            await services.tracks.requeueObjects(athleteId, uploadId).catch(() => undefined);
          // An upload whose fence closed can never be completed: it is closed here so its
          // references — including anything that became visible before the fence check
          // caught up — are queued at once rather than waiting for the expiry reaper.
          if (fenceClosed && !failureRecorded) {
            await services.tracks
              .fail(athleteId, uploadId, 'UPLOAD_FENCE_EXPIRED')
              .catch(() => undefined);
            failureRecorded = true;
          }
          if (
            !failureRecorded &&
            context.state !== 'finalized' &&
            (error instanceof ActivityTrackUploadValidationError || isObjectStorageConflict(error))
          ) {
            const code =
              error instanceof ActivityTrackUploadValidationError
                ? error.code
                : 'OBJECT_STORAGE_CONFLICT';
            await services.tracks.fail(athleteId, uploadId, code).catch(() => undefined);
          }
          throw trackError(error) ?? transientUploadError(error, phase);
        }
      },
    );

    trackRoutes.post(
      '/activity-track-uploads/:uploadId/finalize',
      { bodyLimit: 1024 },
      async (request) => {
        input(emptyQuery, request.query);
        if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
        const { uploadId } = input(uploadParamsSchema, request.params);
        const result = activityTrackReadResultSchema.parse(
          await execute(() => services.tracks.finalize(principal(request).athleteId, uploadId)),
        );
        if (result.status !== 'available')
          throw new ProductRequestError(404, 'ACTIVITY_TRACK_NOT_FOUND');
        return result;
      },
    );

    trackRoutes.get('/activities/:activityId/track', async (request) => {
      input(emptyQuery, request.query);
      const { activityId } = input(activityParamsSchema, request.params);
      const result = activityTrackReadResultSchema.parse(
        await execute(() => services.tracks.read(principal(request).athleteId, activityId)),
      );
      if (result.status !== 'available')
        throw new ProductRequestError(404, 'ACTIVITY_TRACK_NOT_FOUND');
      z.literal(activityId).parse(result.track.activityId);
      return result;
    });

    trackRoutes.get('/activities/:activityId/track/content', async (request, reply) => {
      const athleteId = principal(request).athleteId;
      const { activityId } = input(activityParamsSchema, request.params);
      const { variant } = input(variantQuerySchema, request.query);
      const resolved = await execute(() =>
        services.tracks.resolveObject(athleteId, activityId, variant),
      );
      if (resolved === null) throw new ProductRequestError(404, 'ACTIVITY_TRACK_NOT_FOUND');
      const objectKey = validateObjectKey(resolved.storageRef);
      const parsedKey = parseObjectKey(objectKey);
      // The stored reference must still describe this tenant, this activity and this
      // artifact before a byte is opened. A reference that does not is a server fault,
      // not a download.
      if (
        parsedKey.kind !== 'track_final' ||
        parsedKey.tenantId !== athleteId ||
        parsedKey.activityId !== activityId ||
        parsedKey.trackId !== resolved.trackId ||
        parsedKey.artifactKind !== variant ||
        parsedKey.sha256 !== resolved.sha256
      )
        throw new Error('INVALID_ACTIVITY_TRACK_STORAGE_REF');
      const object = await services.storage.open(objectKey);
      if (object === null || object.sizeBytes !== resolved.byteSize)
        throw new ProductRequestError(503, 'ACTIVITY_TRACK_CONTENT_UNAVAILABLE');
      const downloadName =
        variant === 'raw'
          ? (resolved.originalFileName ?? `track.${parsedKey.extension}`)
          : `${variant}.json`;
      return reply
        .header('content-type', resolved.mediaType)
        .header('content-length', object.sizeBytes)
        .header('cache-control', 'private, no-store')
        .header('content-disposition', contentDisposition(downloadName))
        .send(Readable.from(object.body));
    });
  });
}
