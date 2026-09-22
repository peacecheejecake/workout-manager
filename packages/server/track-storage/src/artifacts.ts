import {
  activitySourceProvenanceSchema,
  mapPathSchema,
  recordedTrackSchema,
  trackAggregatesSchema,
  trackFormatSchema,
  trackLimits,
  trackParserIdSchema,
  trackTextSchema,
} from '@workout/contracts/tracks';
import { z } from 'zod';

/**
 * What one bounded parse produces for storage. Everything here is built inside the parse
 * worker, under its heap ceiling, from the bytes the server itself stored — never from
 * anything a client sent alongside the file.
 */
export const storedTrackSelectionSchema = z.strictObject({
  recordedTrackIndex: z
    .number()
    .int()
    .min(0)
    .max(trackLimits.tracksPerFile - 1),
  provenance: activitySourceProvenanceSchema,
});
export type StoredTrackSelection = z.infer<typeof storedTrackSelectionSchema>;

export const storedTrackArtifactsSchema = z.strictObject({
  format: trackFormatSchema,
  parserId: trackParserIdSchema,
  parserVersion: z.literal(1),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileByteLength: z.number().int().min(1).max(trackLimits.fileBytes),
  originalFilename: trackTextSchema.nullable(),
  /** Recordings found in the file. A file with several still stores exactly the selected one. */
  recordedCount: z.number().int().min(0).max(trackLimits.tracksPerFile),
  requiresSelection: z.boolean(),
  track: recordedTrackSchema,
  mapPath: mapPathSchema,
  aggregates: trackAggregatesSchema,
});
export type StoredTrackArtifacts = z.infer<typeof storedTrackArtifactsSchema>;
