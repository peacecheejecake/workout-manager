import { instantSchema } from './primitives.js';
import {
  trackDistancesSchema,
  trackFormatSchema,
  trackLimits,
  trackParserIdSchema,
  trackSegmentPolicySchema,
  trackSourceKindSchema,
  trackTextSchema,
} from './tracks.js';
import { z } from 'zod';

/**
 * Stored-track lifecycle contract for M2-01c.
 *
 * `tracks.ts` describes what a recorded track *is*; this file describes what the server
 * stores about one, and deliberately carries no coordinates, no sample ids and no storage
 * reference. Geometry lives only in the private objects behind an authenticated download.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest');
const byteSize = z.number().int().min(1).max(trackLimits.fileBytes);
const count = z.number().int().min(0).max(trackLimits.samples);

/** Objects a stored track owns: the untouched original plus two server-built derivatives. */
export const activityTrackArtifactKindSchema = z.enum(['raw', 'normalized', 'map_path']);
export type ActivityTrackArtifactKind = z.infer<typeof activityTrackArtifactKindSchema>;

export const activityTrackUploadStateSchema = z.enum([
  'reserved',
  'prepared',
  'staged',
  'finalized',
  'failed',
]);

/**
 * Reservation input. There is no place here for a parse result, a storage key, an athlete
 * id or a track revision: the server derives the owner from the session, generates every
 * object key itself and re-parses the bytes it stored. `recordedTrackIndex` is the explicit
 * selection a multi-track file requires; it selects, it never merges.
 */
export const activityTrackReserveMetadataSchema = z.strictObject({
  expectedActivityRevision: z.number().int().min(1).max(2147483646),
  recordedTrackIndex: z
    .number()
    .int()
    .min(0)
    .max(trackLimits.tracksPerFile - 1),
});
export type ActivityTrackReserveMetadata = z.infer<typeof activityTrackReserveMetadataSchema>;

export const activityTrackUploadReservationSchema = z.strictObject({
  uploadId: uuid,
  activityId: uuid,
  trackId: uuid,
  state: activityTrackUploadStateSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ActivityTrackUploadReservation = z.infer<typeof activityTrackUploadReservationSchema>;

/** The original file as received. `originalFileName` is already sanitized text. */
export const activityTrackFileDescriptorSchema = z.strictObject({
  originalFileName: trackTextSchema.nullable(),
  format: trackFormatSchema,
  byteSize,
  sha256: sha256Schema,
});
export type ActivityTrackFileDescriptor = z.infer<typeof activityTrackFileDescriptorSchema>;

export const activityTrackDerivativeDescriptorSchema = z.strictObject({
  kind: z.enum(['normalized', 'map_path']),
  byteSize: z.number().int().min(1).max(trackLimits.normalizedBytes),
  sha256: sha256Schema,
});
export type ActivityTrackDerivativeDescriptor = z.infer<
  typeof activityTrackDerivativeDescriptorSchema
>;

/**
 * Sample correspondence identity.
 *
 * `tracks.ts` states the rule — "if a re-parse changes which observation an id denotes,
 * that is a new track revision" — and this digest is what makes it enforceable. It covers
 * the parser identity and every sample's id, source index, instant, position and detail
 * link, so a re-parse that moves any correspondence produces a different digest and the
 * server appends a revision instead of overwriting one.
 */
export const trackCorrespondenceDigestSchema = z.strictObject({
  algorithm: z.literal('track-correspondence-v1'),
  parserId: trackParserIdSchema,
  parserVersion: z.literal(1),
  digest: sha256Schema,
});
export type TrackCorrespondenceDigest = z.infer<typeof trackCorrespondenceDigestSchema>;

/**
 * One stored revision. Aggregate counts and distances are copied from the server's own
 * parse; they are never taken from a client and never recomputed from display geometry.
 */
export const activityTrackRevisionSchema = z.strictObject({
  trackId: uuid,
  activityId: uuid,
  sourceKind: z.enum(['fit', 'fixture', 'manual']),
  sourceId: z.string().min(1).max(200),
  sourceRevision: z.number().int().min(1).max(2147483646),
  trackRevision: z.number().int().min(1).max(2147483646),
  recordedSourceKind: trackSourceKindSchema,
  correspondence: trackCorrespondenceDigestSchema,
  file: activityTrackFileDescriptorSchema,
  derivatives: z.array(activityTrackDerivativeDescriptorSchema).length(2),
  sampleCount: count,
  positionedSampleCount: count,
  segmentCount: z.number().int().min(0).max(trackLimits.segments),
  segmentPolicy: trackSegmentPolicySchema,
  distances: trackDistancesSchema,
  createdAt: instantSchema,
});
export type ActivityTrackRevision = z.infer<typeof activityTrackRevisionSchema>;

export const activityTrackReadResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), track: activityTrackRevisionSchema }),
  z.strictObject({ status: z.literal('unavailable'), activityId: uuid }),
]);
export type ActivityTrackReadResult = z.infer<typeof activityTrackReadResultSchema>;

export const activityTrackDownloadVariantSchema = z.enum(['raw', 'normalized', 'map_path']);
