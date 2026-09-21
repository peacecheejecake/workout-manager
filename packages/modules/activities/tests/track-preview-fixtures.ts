/**
 * Preview fixtures built from the shared track contract.
 *
 * Every fixture is validated by `parsedTrackFileSchema`, so a test can never assert
 * behaviour against a shape the contract would reject. These are contract-valid values,
 * not parser output: no FIT or GPX bytes are produced here.
 */
import {
  makeTrackSampleId,
  parsedTrackFileSchema,
  type ParsedTrackFile,
  type RecordedTrack,
  type TrackPosition,
  type TrackSample,
  type TrackSegment,
} from '@workout/contracts/tracks';

export const fixtureSha256 = 'a'.repeat(64);

/** Indexing helper so fixtures and tests never need a non-null assertion. */
export function requireItem<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`Fixture item ${index} is missing`);
  return value;
}

export function previewSample(
  sourceIndex: number,
  options: {
    position?: TrackPosition | null;
    recordedAt?: string | null;
    heartRateBpm?: number | null;
    distanceMeters?: number | null;
  } = {},
): TrackSample {
  return {
    sampleId: makeTrackSampleId(0, sourceIndex),
    sourceIndex,
    recordedAt:
      options.recordedAt === undefined
        ? `2026-03-01T00:${String(sourceIndex).padStart(2, '0')}:00Z`
        : options.recordedAt,
    position:
      options.position === undefined ? [127.02 + sourceIndex / 1000, 37.5] : options.position,
    elevationMeters: null,
    distanceMeters: options.distanceMeters ?? null,
    speedMetersPerSecond: null,
    heartRateBpm: options.heartRateBpm ?? null,
    lapIndex: null,
    detailLink: null,
  };
}

export function previewTrack(
  samples: TrackSample[],
  segments: TrackSegment[],
  options: {
    name?: string | null;
    deviceMeters?: number | null;
    recomputedMeters?: number | null;
    sourceItemIndex?: number;
  } = {},
): RecordedTrack {
  return {
    schemaVersion: 1,
    provenance: {
      kind: 'local-file',
      format: 'gpx',
      fileSha256: fixtureSha256,
      fileByteLength: 1024,
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      streamIndex: 0,
      sourceItemIndex: options.sourceItemIndex ?? 0,
      streamLabel: options.name ?? null,
    },
    sourceKind: 'gpx-trk',
    name: options.name ?? null,
    samples,
    segments,
    segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
    distances: {
      deviceReportedMeters: options.deviceMeters ?? null,
      recomputedFromPositionsMeters: options.recomputedMeters ?? null,
    },
  };
}

export function previewFile(recorded: RecordedTrack[]): ParsedTrackFile {
  return parsedTrackFileSchema.parse({
    schemaVersion: 1,
    format: 'gpx',
    fileSha256: fixtureSha256,
    fileByteLength: 1024,
    parserId: 'gpx-track-v1',
    parserVersion: 1,
    originalFilename: 'run.gpx',
    recorded,
    routes: [],
    waypoints: [],
    requiresSelection: recorded.length > 1,
  });
}

/** One continuous recording: every sample positioned, one segment. */
export function normalPreviewFile(): ParsedTrackFile {
  const samples = [0, 1, 2, 3].map((index) =>
    previewSample(index, { heartRateBpm: 140 + index, distanceMeters: index * 100 }),
  );
  return previewFile([
    previewTrack(
      samples,
      [{ index: 0, startReason: 'stream-start', sampleIds: samples.map((s) => s.sampleId) }],
      { name: '아침 러닝', deviceMeters: 400, recomputedMeters: 398 },
    ),
  ]);
}

/** A recording split by a time gap. The two pieces must never be joined. */
export function gappedPreviewFile(): ParsedTrackFile {
  const samples = [0, 1, 2, 3].map((index) => previewSample(index));
  return previewFile([
    previewTrack(samples, [
      {
        index: 0,
        startReason: 'stream-start',
        sampleIds: [requireItem(samples, 0).sampleId, requireItem(samples, 1).sampleId],
      },
      {
        index: 1,
        startReason: 'time-gap',
        sampleIds: [requireItem(samples, 2).sampleId, requireItem(samples, 3).sampleId],
      },
    ]),
  ]);
}

/** A recording with measurements but no fix at all. */
export function noGpsPreviewFile(): ParsedTrackFile {
  const samples = [0, 1].map((index) =>
    previewSample(index, { position: null, heartRateBpm: 150 }),
  );
  return previewFile([
    previewTrack(samples, [
      { index: 0, startReason: 'missing-position', sampleIds: samples.map((s) => s.sampleId) },
    ]),
  ]);
}

/** Two recordings in one file: the consumer must choose, never merge. */
export function multiTrackPreviewFile(): ParsedTrackFile {
  const first = [0, 1].map((index) => previewSample(index));
  const second = [2, 3].map((index) => previewSample(index));
  return previewFile([
    previewTrack(
      first,
      [{ index: 0, startReason: 'stream-start', sampleIds: first.map((s) => s.sampleId) }],
      { name: '세션 1', sourceItemIndex: 0 },
    ),
    previewTrack(
      second,
      [{ index: 0, startReason: 'stream-start', sampleIds: second.map((s) => s.sampleId) }],
      { name: '세션 2', sourceItemIndex: 1 },
    ),
  ]);
}

/** A single recording long enough that a bounded list cannot reach its last sample. */
export function longPreviewFile(count: number): ParsedTrackFile {
  const samples = Array.from({ length: count }, (_unused, index) =>
    previewSample(index, {
      position: [127.02 + index / 10_000, 37.5 + index / 10_000],
      recordedAt: new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString(),
    }),
  );
  return previewFile([
    previewTrack(samples, [
      {
        index: 0,
        startReason: 'stream-start',
        sampleIds: samples.map((sample) => sample.sampleId),
      },
    ]),
  ]);
}
