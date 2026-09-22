import { createHash } from 'node:crypto';

import type { TrackCorrespondenceDigest } from '@workout/contracts/activity-tracks';
import { trackParserIdSchema, type MapPath, type RecordedTrack } from '@workout/contracts/tracks';

/**
 * Sample correspondence, reduced to one digest.
 *
 * M2-01a declared the rule in a contract comment and carried the enforcement here: "if a
 * re-parse changes which observation an id denotes, that is a new track revision, not a
 * mutation". Enforcing it needs a value the database can compare, so this digest covers
 * exactly the things that decide correspondence:
 *
 * - the parser identity and version (a different parser is a different correspondence),
 * - every sample's id, source index, instant, position and detail link,
 * - the segment split (which samples are connected, and why the split happened),
 * - the split policy that produced it.
 *
 * It deliberately excludes values that can change without moving any correspondence, such
 * as the track name and the device/recomputed distances. Those are stored as their own
 * columns, so a reviewer can see what is inside the digest and what is not.
 *
 * Instants keep their exact wire text and absent values stay `null`: nothing here is
 * coerced, defaulted or rounded, because that would make two different recordings collide.
 */
export function trackCorrespondenceDigest(
  track: RecordedTrack,
  /**
   * Parser identity is an input, not something read back from the track: a stored track
   * carries `activity-source` provenance, which has no parser field, and silently
   * defaulting one would let two parsers share a digest.
   */
  parser: { readonly parserId: string; readonly parserVersion: 1 },
): TrackCorrespondenceDigest {
  const parserId = trackParserIdSchema.parse(parser.parserId);
  const parserVersion = parser.parserVersion;
  const material = {
    algorithm: 'track-correspondence-v1',
    parserId,
    parserVersion,
    sourceKind: track.sourceKind,
    segmentPolicy: [
      track.segmentPolicy.version,
      track.segmentPolicy.maxGapSeconds,
      track.segmentPolicy.maxGapMeters,
    ],
    samples: track.samples.map((sample) => [
      sample.sampleId,
      sample.sourceIndex,
      sample.recordedAt,
      sample.position,
      sample.detailLink === null
        ? null
        : [
            sample.detailLink.detailSchemaVersion,
            sample.detailLink.streamIndex,
            sample.detailLink.sessionIndex,
            sample.detailLink.recordIndex,
          ],
    ]),
    segments: track.segments.map((segment) => [
      segment.index,
      segment.startReason,
      segment.sampleIds,
    ]),
  };
  return {
    algorithm: 'track-correspondence-v1',
    parserId,
    parserVersion,
    digest: createHash('sha256').update(JSON.stringify(material)).digest('hex'),
  };
}

export interface SerializedTrackArtifact {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

function serialize(value: unknown): SerializedTrackArtifact {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The two derived objects. Both are plain JSON documents of contract values: the
 * normalized recording with its stored provenance, and the display geometry. Neither is
 * a substitute for the original file, which is stored untouched and never rewritten.
 */
export function serializeNormalizedTrack(track: RecordedTrack): SerializedTrackArtifact {
  return serialize(track);
}

export function serializeMapPath(path: MapPath): SerializedTrackArtifact {
  return serialize(path);
}
