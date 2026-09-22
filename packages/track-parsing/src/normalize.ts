import {
  makeTrackSampleId,
  parsedTrackFileSchema,
  recordedTrackSchema,
  type ParsedTrackFile,
  type RecordedTrack,
  type TrackSample,
  type TrackSegment,
  type TrackSegmentBreak,
} from '@workout/contracts/tracks';
import { crossesAntimeridian, haversineMeters } from './geo';
import {
  ESTIMATED_SAMPLE_BYTES,
  TrackIngestionError,
  type ParseBudget,
  type TrackParseLimits,
} from './limits';
import type { RawSample, RawTrack, RawTrackFile } from './raw';
import { sanitizeMetadataText, sanitizeOptionalMetadataText } from './sanitize';

export interface SegmentPolicy {
  readonly version: 1;
  readonly maxGapSeconds: number;
  readonly maxGapMeters: number;
}

/** Splitting rules are pinned so a stored track records the policy that produced it. */
export const defaultSegmentPolicy: SegmentPolicy = {
  version: 1,
  maxGapSeconds: 60,
  maxGapMeters: 200,
};

export interface NormalizeOptions {
  readonly format: 'fit' | 'gpx';
  readonly parserId: 'fit-track-v1' | 'gpx-track-v1';
  readonly fileSha256: string;
  readonly fileByteLength: number;
  readonly originalFilename?: string | null;
  readonly policy?: SegmentPolicy;
}

const milliseconds = (value: string | null): number | null =>
  value === null ? null : Date.parse(value);

const encoder = new TextEncoder();

/**
 * Exact serialized size of one part, escaping included (`JSON.stringify` does the
 * escaping) and measured in UTF-8 bytes.
 */
function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? '';
  // eslint-disable-next-line no-control-regex
  return /[^\u0000-\u007f]/.test(json) ? encoder.encode(json).byteLength : json.length;
}

/**
 * One element's contribution to an array: its own bytes plus the comma that precedes it.
 * The first element of an array has no separator, so `position` makes the running total
 * exact for arrays instead of one byte high per element.
 */
const elementBytes = (value: unknown, position: number): number =>
  serializedBytes(value) + (position > 0 ? 1 : 0);

function breakReason(
  previous: RawSample | null,
  sample: RawSample,
  policy: SegmentPolicy,
): TrackSegmentBreak | null {
  if (previous === null) return 'stream-start';
  if (sample.boundary !== null) return sample.boundary;
  if (previous.position === null && sample.position === null) return null;
  if (previous.position === null || sample.position === null) return 'missing-position';
  const before = milliseconds(previous.recordedAt);
  const after = milliseconds(sample.recordedAt);
  if (before !== null && after !== null) {
    if (after < before) return 'time-reversal';
    if (after === before) return 'duplicate-timestamp';
    if (after - before > policy.maxGapSeconds * 1000) return 'time-gap';
  }
  if (crossesAntimeridian(previous.position, sample.position)) return 'antimeridian-crossing';
  if (haversineMeters(previous.position, sample.position) > policy.maxGapMeters)
    return 'position-gap';
  return null;
}

function toSample(raw: RawSample, streamIndex: number): TrackSample {
  return {
    sampleId: makeTrackSampleId(streamIndex, raw.sourceIndex),
    sourceIndex: raw.sourceIndex,
    recordedAt: raw.recordedAt,
    position: raw.position,
    elevationMeters: raw.elevationMeters,
    distanceMeters: raw.distanceMeters,
    speedMetersPerSecond: raw.speedMetersPerSecond,
    heartRateBpm: raw.heartRateBpm,
    lapIndex: raw.lapIndex,
    detailLink: null,
  };
}

/**
 * Builds segments without deleting or interpolating anything. A sample with no fix keeps
 * its measurements and its own segment; the neighbours are never joined across it.
 */
export function normalizeRecordedTrack(
  raw: RawTrack,
  options: NormalizeOptions,
  limits: TrackParseLimits,
  budget: ParseBudget,
): RecordedTrack {
  const policy = options.policy ?? defaultSegmentPolicy;
  if (raw.samples.length === 0) throw new TrackIngestionError('TRACK_NO_TRACK_DATA');
  if (raw.samples.length > limits.samples) throw new TrackIngestionError('TRACK_SAMPLE_LIMIT');
  const samples: TrackSample[] = [];
  const segments: TrackSegment[] = [];
  let previous: RawSample | null = null;
  let recomputed: number | null = null;
  for (const rawSample of raw.samples) {
    budget.check();
    // Charged before the normalized sample is built, kept or serialized.
    budget.charge(ESTIMATED_SAMPLE_BYTES);
    const sample = toSample(rawSample, raw.streamIndex);
    budget.chargeOutput(elementBytes(sample, samples.length));
    samples.push(sample);
    const reason = breakReason(previous, rawSample, policy);
    if (reason !== null) {
      if (segments.length >= limits.segments) throw new TrackIngestionError('TRACK_SEGMENT_LIMIT');
      // The segment's own structure is charged exactly; its ids are charged as appended.
      budget.chargeOutput(
        elementBytes(
          { index: segments.length, startReason: reason, sampleIds: [] },
          segments.length,
        ),
      );
      // The first id of a segment has no separator either: quotes only.
      budget.chargeOutput(sample.sampleId.length + 2);
      segments.push({ index: segments.length, startReason: reason, sampleIds: [sample.sampleId] });
    } else {
      const current = segments.at(-1);
      if (!current) throw new TrackIngestionError('TRACK_NORMALIZATION_INVALID');
      budget.chargeOutput(sample.sampleId.length + 3);
      current.sampleIds.push(sample.sampleId);
      if (previous?.position && rawSample.position)
        recomputed = (recomputed ?? 0) + haversineMeters(previous.position, rawSample.position);
    }
    previous = rawSample;
  }
  const track = {
    schemaVersion: 1,
    provenance: {
      kind: 'local-file',
      format: options.format,
      fileSha256: options.fileSha256,
      fileByteLength: options.fileByteLength,
      parserId: options.parserId,
      parserVersion: 1,
      streamIndex: raw.streamIndex,
      sourceItemIndex: raw.sourceItemIndex,
      streamLabel: sanitizeMetadataText(raw.name, limits.metadataTextLength),
    },
    sourceKind: raw.sourceKind,
    name: sanitizeMetadataText(raw.name, limits.metadataTextLength),
    samples,
    segments,
    segmentPolicy: policy,
    distances: {
      deviceReportedMeters: raw.deviceDistanceMeters,
      recomputedFromPositionsMeters: recomputed,
    },
  };
  const parsed = recordedTrackSchema.safeParse(track);
  if (!parsed.success) throw new TrackIngestionError('TRACK_NORMALIZATION_INVALID');
  return parsed.data;
}

/**
 * Normalizes one parsed file. Recorded tracks, planned routes and waypoints stay separate
 * and multiple tracks are never merged: `requiresSelection` asks the caller to choose.
 */
export function normalizeTrackFile(
  raw: RawTrackFile,
  options: NormalizeOptions,
  limits: TrackParseLimits,
  budget: ParseBudget,
): ParsedTrackFile {
  if (raw.tracks.length + raw.routes.length > limits.tracksPerFile)
    throw new TrackIngestionError('TRACK_COUNT_LIMIT');
  const file = {
    schemaVersion: 1,
    format: options.format,
    fileSha256: options.fileSha256,
    fileByteLength: options.fileByteLength,
    parserId: options.parserId,
    parserVersion: 1,
    originalFilename: sanitizeMetadataText(
      options.originalFilename ?? null,
      limits.metadataTextLength,
    ),
    // Best-effort: see `sanitizeOptionalMetadataText`. A `creator` this parser cannot make
    // safe is absent, not a reason to refuse the file — the same bytes go up the activity
    // track upload path, where `creator` is read by nothing at all.
    creator: sanitizeOptionalMetadataText(raw.creator, limits.metadataTextLength),
    recorded: raw.tracks.map((track) => normalizeRecordedTrack(track, options, limits, budget)),
    routes: raw.routes.map((route) => ({
      schemaVersion: 1 as const,
      provenance: {
        kind: 'local-file' as const,
        format: options.format,
        fileSha256: options.fileSha256,
        fileByteLength: options.fileByteLength,
        parserId: options.parserId,
        parserVersion: 1 as const,
        streamIndex: route.streamIndex,
        sourceItemIndex: 0,
        streamLabel: sanitizeMetadataText(route.name, limits.metadataTextLength),
      },
      sourceKind: 'gpx-rte' as const,
      name: sanitizeMetadataText(route.name, limits.metadataTextLength),
      points: route.points.map((point, position) => {
        budget.charge(ESTIMATED_SAMPLE_BYTES);
        const value = {
          sourceIndex: point.sourceIndex,
          position: point.position,
          elevationMeters: point.elevationMeters,
          name: sanitizeMetadataText(point.name, limits.metadataTextLength),
        };
        budget.chargeOutput(elementBytes(value, position));
        return value;
      }),
    })),
    waypoints: raw.waypoints.map((point, position) => {
      budget.charge(ESTIMATED_SAMPLE_BYTES);
      const value = {
        sourceIndex: point.sourceIndex,
        position: point.position,
        elevationMeters: point.elevationMeters,
        name: sanitizeMetadataText(point.name, limits.metadataTextLength),
      };
      budget.chargeOutput(elementBytes(value, position));
      return value;
    }),
    requiresSelection: raw.tracks.length + raw.routes.length > 1,
  };
  // Everything not charged while it was produced is charged now: each track's and route's
  // own structure (name, provenance, policy, distances) and the document skeleton. Each is
  // the exact serialization of that object with its big arrays emptied, plus a separator,
  // so the running total is at or above the real serialized document.
  file.recorded.forEach((track, position) =>
    budget.chargeOutput(elementBytes({ ...track, samples: [], segments: [] }, position)),
  );
  file.routes.forEach((route, position) =>
    budget.chargeOutput(elementBytes({ ...route, points: [] }, position)),
  );
  budget.chargeOutput(serializedBytes({ ...file, recorded: [], routes: [], waypoints: [] }));
  const parsed = parsedTrackFileSchema.safeParse(file);
  if (!parsed.success) throw new TrackIngestionError('TRACK_NORMALIZATION_INVALID');
  return parsed.data;
}
