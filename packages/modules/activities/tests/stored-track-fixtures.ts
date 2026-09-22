import {
  activityTrackRevisionSchema,
  type ActivityTrackRevision,
} from '@workout/contracts/activity-tracks';
import type { ActivityDetails } from '@workout/contracts/activity-details';
import { mapPathSchema, recordedTrackSchema } from '@workout/contracts/tracks';
import type { MapPath, RecordedTrack } from '@workout/contracts/tracks';

export const activityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const trackId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const sourceId = 'source-a';

const base = Date.parse('2026-03-01T00:00:00Z');
export const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
export const instant = (seconds: number) => base + seconds * 1000;

/** Seoul, inside the bounds of the self-hosted basemap deployment. */
const position = (offset: number): [number, number] => [
  127.02 + offset / 1000,
  37.5 + offset / 1000,
];

/**
 * A recording with a real gap: sample `0:2` has no fix, so the parser split the recording
 * into three segments and the middle one contributes no drawn vertex. Laps 0 and 1 are
 * carried on the samples, as a FIT recording does.
 */
export function storedTrack(
  overrides: { sourceRevision?: number; trackRevision?: number } = {},
): RecordedTrack {
  return recordedTrackSchema.parse({
    schemaVersion: 1,
    provenance: {
      kind: 'activity-source',
      activityId,
      sourceId,
      sourceRevision: overrides.sourceRevision ?? 1,
      trackRevision: overrides.trackRevision ?? 1,
    },
    sourceKind: 'fit-session',
    name: '저장된 기록',
    samples: [
      sample(0, position(0), 0, 140),
      sample(1, position(1), 0, 142),
      sample(2, null, 0, 144),
      sample(3, position(3), 1, 146),
      sample(4, position(4), 1, 148),
    ],
    segments: [
      { index: 0, startReason: 'stream-start', sampleIds: ['0:0', '0:1'] },
      { index: 1, startReason: 'missing-position', sampleIds: ['0:2'] },
      { index: 2, startReason: 'missing-position', sampleIds: ['0:3', '0:4'] },
    ],
    segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
    distances: { deviceReportedMeters: 250, recomputedFromPositionsMeters: 248 },
  });
}

function sample(
  sourceIndex: number,
  where: [number, number] | null,
  lapIndex: number,
  heartRateBpm: number,
) {
  return {
    sampleId: `0:${sourceIndex}`,
    sourceIndex,
    recordedAt: at(sourceIndex * 10),
    position: where,
    elevationMeters: null,
    distanceMeters: sourceIndex * 50,
    speedMetersPerSecond: null,
    heartRateBpm,
    lapIndex,
    detailLink: null,
  };
}

/** Display geometry exactly as the server builds it at tolerance 0: every fix is a vertex. */
export function storedMapPath(
  overrides: { sourceRevision?: number; trackRevision?: number } = {},
): MapPath {
  return mapPathSchema.parse({
    schemaVersion: 1,
    role: 'recorded',
    sourceRevision: {
      kind: 'activity-source',
      activityId,
      sourceId,
      sourceRevision: overrides.sourceRevision ?? 1,
      trackRevision: overrides.trackRevision ?? 1,
    },
    simplificationVersion: 1,
    toleranceMeters: 0,
    geometry: {
      type: 'MultiLineString',
      coordinates: [
        [position(0), position(1)],
        [position(3), position(4)],
      ],
    },
    vertexSampleIds: [
      ['0:0', '0:1'],
      ['0:3', '0:4'],
    ],
    lineSegmentIndices: [0, 2],
    points: [],
    insufficient: [{ segmentIndex: 1, reason: 'no-position', sampleIds: ['0:2'] }],
    displayedPolylineLengthMeters: 240,
    crossesAntimeridian: false,
    outsideDisplayLatitude: false,
  });
}

export function storedRevision(
  overrides: Partial<{
    sourceRevision: number;
    trackRevision: number;
    positionedSampleCount: number;
  }> = {},
): ActivityTrackRevision {
  return activityTrackRevisionSchema.parse({
    trackId,
    activityId,
    sourceKind: 'fit',
    sourceId,
    sourceRevision: overrides.sourceRevision ?? 1,
    trackRevision: overrides.trackRevision ?? 1,
    recordedSourceKind: 'fit-session',
    correspondence: {
      algorithm: 'track-correspondence-v1',
      parserId: 'fit-track-v1',
      parserVersion: 1,
      digest: 'd'.repeat(64),
    },
    file: { originalFileName: 'run.fit', format: 'fit', byteSize: 2048, sha256: 'a'.repeat(64) },
    derivatives: [
      { kind: 'normalized', byteSize: 1024, sha256: 'b'.repeat(64) },
      { kind: 'map_path', byteSize: 512, sha256: 'c'.repeat(64) },
    ],
    sampleCount: 5,
    positionedSampleCount: overrides.positionedSampleCount ?? 4,
    segmentCount: 3,
    segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
    distances: { deviceReportedMeters: 250, recomputedFromPositionsMeters: 248 },
    createdAt: at(0),
  });
}

/** Detail observations from the same source stream, so instants line up sample by sample. */
export function storedDetails(): ActivityDetails {
  return {
    schemaVersion: 1,
    streamIndex: 0,
    sessionIndex: 0,
    startedAt: at(0),
    recordedAt: at(40),
    elapsedSeconds: 40,
    records: [0, 1, 2, 3, 4].map((index) => ({
      index,
      timestamp: at(index * 10),
      distanceMeters: index * 50,
      heartRateBpm: 140 + index * 2,
    })),
    laps: [
      {
        index: 0,
        startedAt: at(0),
        recordedAt: at(20),
        elapsedSeconds: 20,
        timerSeconds: 20,
        distanceMeters: 100,
        averageHeartRateBpm: 142,
        maximumHeartRateBpm: 144,
      },
      {
        index: 1,
        startedAt: at(30),
        recordedAt: at(40),
        elapsedSeconds: 10,
        timerSeconds: 10,
        distanceMeters: 100,
        averageHeartRateBpm: 147,
        maximumHeartRateBpm: 148,
      },
    ],
  };
}
