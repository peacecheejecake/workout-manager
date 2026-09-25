import { describe, expect, it } from 'vitest';
import { courseCardSchema } from '@workout/contracts/course-cards';
import {
  courseReadResultSchema,
  courseThumbnailLimits,
  type CourseGeneration,
  type CourseReadResult,
} from '@workout/contracts/courses';
import type { RouteComputationRecord } from '@workout/contracts/routing';

import { courseCard, courseDistanceBasis } from '../src/course-cards.js';
import { createElevationIndex } from '../src/geo-data.js';

/**
 * The S13 list card, derived (M2-01k-a).
 *
 * What these fix: a line cut from a recording is the only one called actual, an engine line
 * is an estimate and carries the engine's own figure, a file's line is neither, and nothing
 * the server cannot know is ever reported as known — no elevation dataset is `not_deployed`
 * (not an empty profile), and surface is `unknown` because there is no source for it.
 */
const courseId = '11111111-1111-4111-8111-111111111111';
const activityId = '33333333-3333-4333-8333-333333333333';
const trackId = '44444444-4444-4444-8444-444444444444';
const createdAt = '2026-03-01T00:00:00.000Z';

const computation: RouteComputationRecord = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 12,
  graph: {
    engine: 'graphhopper',
    identitySource: 'engine',
    engineVersion: '10.0',
    engineArtifactSha256: 'a'.repeat(64),
    profileId: 'foot-v1',
    profileConfigSha256: 'b'.repeat(64),
    extractSha256: 'c'.repeat(64),
    extractRegion: 'seoul',
    graphContentSha256: 'd'.repeat(64),
    graphBuildId: '0123456789abcdef',
    graphImportedAt: '2026-03-01T00:00:00.000Z',
    roadDataAt: '2026-02-01T00:00:00.000Z',
  },
  conditions: {
    profileId: 'foot-v1',
    algorithm: 'flexible',
    contractionHierarchies: false,
    maxVisitedNodes: 1_000_000,
    deadlineMilliseconds: 8_000,
    snapLimitMeters: 120,
    waypointCount: 2,
  },
  computedAt: '2026-03-02T00:00:00.000Z',
  computationMilliseconds: 42,
  warnings: [],
};

const recorded: CourseGeneration = {
  kind: 'recorded-segment',
  activityId,
  trackId,
  trackRevision: 1,
  lineIndex: 0,
  segmentIndex: 0,
  startSampleId: '0:0',
  endSampleId: '0:3',
  vertexCount: 2,
  mapPathContentSha256: 'a'.repeat(64),
  simplificationVersion: 1,
  toleranceMeters: 2.5,
};
const routed: CourseGeneration = {
  kind: 'routed-waypoints',
  computation,
  engineDistanceMeters: 1912.4,
  engineDurationSeconds: 1300,
  maxSnapDistanceMeters: 4,
  waypointCount: 2,
  vertexCount: 2,
};
const imported: CourseGeneration = {
  kind: 'imported-file',
  format: 'gpx',
  sourceKind: 'gpx-trk',
  itemIndex: 0,
  parserId: 'gpx-track-v1',
  parserVersion: 1,
  fileSha256: 'a'.repeat(64),
  fileByteLength: 200,
  originalFilename: null,
  fileCreator: null,
  vertexCount: 2,
  importedWaypointCount: 0,
  ignoredFileWaypointCount: 0,
};
const trimmedFrom = (
  sourceGenerationKind: Extract<
    CourseGeneration,
    { kind: 'privacy-trimmed' }
  >['sourceGenerationKind'],
): CourseGeneration => ({
  kind: 'privacy-trimmed',
  sourceRevision: 1,
  sourceGenerationKind,
  sourceGraphBuildId: sourceGenerationKind === 'routed-waypoints' ? '0123456789abcdef' : null,
  policyVersion: 1,
  zoneSetDigest: 'f'.repeat(64),
  appliedZoneCount: 1,
  removedVertexCount: 1,
  removedLeadingVertexCount: 1,
  removedTrailingVertexCount: 0,
  removedWaypointCount: 0,
  vertexCount: 2,
});

function read(
  generation: CourseGeneration,
  coordinates: [number, number][] = [
    [127.02, 37.5],
    [127.04, 37.52],
  ],
): CourseReadResult {
  return courseReadResultSchema.parse({
    status: 'available',
    course: {
      status: 'available',
      courseId,
      name: '카드 확인',
      visibility: 'private',
      headRevision: 1,
      revisionId: '55555555-5555-4555-8555-555555555555',
      createdAt,
      updatedAt: createdAt,
    },
    revision: {
      courseId,
      courseRevision: 1,
      revisionId: '55555555-5555-4555-8555-555555555555',
      name: '카드 확인',
      geometry: { type: 'LineString', coordinates },
      waypoints: [
        {
          role: 'start',
          position: coordinates[0],
          name: null,
          sourceSampleId: null,
          locked: false,
        },
        {
          role: 'finish',
          position: coordinates[coordinates.length - 1],
          name: null,
          sourceSampleId: null,
          locked: false,
        },
      ],
      generation,
      edit: { kind: 'created' },
      lineage:
        generation.kind === 'recorded-segment' ? [{ activityId, trackId, trackRevision: 1 }] : [],
      distanceMeters: 1830.5,
      contentDigest: 'b'.repeat(64),
      createdAt,
    },
    thumbnail: { status: 'pending', courseRevision: 1, queuedAt: createdAt },
  });
}

const elevation = createElevationIndex({
  identity: {
    kind: 'elevation',
    datasetId: 'beef0123cafe',
    datasetVersion: 1,
    region: 'Seoul',
    sourceExtractSha256: 'a'.repeat(64),
    licence: 'ODbL-1.0',
    licenceUrl: 'https://www.openstreetmap.org/copyright',
    attribution: '© OpenStreetMap contributors',
    updateCadence: '월 1회',
    builtAt: createdAt,
    featureCount: 1,
    bbox: [126.734, 37.413, 127.269, 37.715],
  },
  maxSourceDistanceMeters: 150,
  points: [{ position: [127.02, 37.5], elevationMeters: 42 }],
});

describe('course card distance', () => {
  it('calls only a line cut from our own recording actual', () => {
    expect(courseDistanceBasis(recorded)).toEqual({ kind: 'recorded' });
    expect(courseDistanceBasis(trimmedFrom('recorded-segment'))).toEqual({ kind: 'recorded' });
  });

  it('keeps an engine line an estimate, with the engine figure beside the planned length', () => {
    const card = courseCard(read(routed), null);
    assert(card.status === 'available');
    expect(card.distance).toEqual({
      plannedLineMeters: 1830.5,
      basis: {
        kind: 'engine-estimate',
        engineDistanceMeters: 1912.4,
        graphBuildId: '0123456789abcdef',
      },
      privacyTrimmed: false,
    });
  });

  it('drops the engine figure once a trim changed the line it described', () => {
    expect(courseDistanceBasis(trimmedFrom('routed-waypoints'))).toEqual({
      kind: 'engine-estimate',
      engineDistanceMeters: null,
      graphBuildId: '0123456789abcdef',
    });
    const card = courseCard(read(trimmedFrom('routed-waypoints')), null);
    assert(card.status === 'available');
    expect(card.distance.privacyTrimmed).toBe(true);
  });

  it('calls a file line neither actual nor estimated, and a trim of a trim unknown', () => {
    expect(courseDistanceBasis(imported)).toEqual({ kind: 'imported-file', sourceKind: 'gpx-trk' });
    expect(courseDistanceBasis(trimmedFrom('imported-file'))).toEqual({
      kind: 'imported-file',
      sourceKind: null,
    });
    expect(courseDistanceBasis(trimmedFrom('privacy-trimmed'))).toEqual({ kind: 'unknown' });
  });
});

describe('course card elevation and surface', () => {
  it('says not_deployed when there is no dataset, never an empty profile', () => {
    const card = courseCard(read(recorded), null);
    assert(card.status === 'available');
    expect(card.elevation).toEqual({ status: 'not_deployed' });
  });

  it('names the dataset and how much of the course it covers', () => {
    const card = courseCard(read(recorded), elevation);
    assert(card.status === 'available');
    assert(card.elevation.status === 'sampled');
    expect(card.elevation.dataset.datasetId).toBe('beef0123cafe');
    expect(card.elevation.sampledCount).toBe(2);
    // One vertex sits on the dataset's only fact; the other is unknown, not zero.
    expect(card.elevation.knownCount).toBe(1);
  });

  it('says outside_region for a course the dataset does not cover', () => {
    const card = courseCard(
      read(recorded, [
        [2.35, 48.85],
        [2.36, 48.86],
      ]),
      elevation,
    );
    assert(card.status === 'available');
    expect(card.elevation.status).toBe('outside_region');
  });

  it('reports surface as unknown, and the contract refuses anything else', () => {
    const card = courseCard(read(recorded), elevation);
    assert(card.status === 'available');
    expect(card.surface).toEqual({ confirmation: 'unknown' });
    expect(
      courseCardSchema.safeParse({ ...card, surface: { confirmation: 'confirmed' } }).success,
    ).toBe(false);
  });
});

describe('course card thumbnail', () => {
  it('carries the thumbnail state and a sample no larger than the renderer budget', () => {
    const long: [number, number][] = Array.from({ length: 1000 }, (_, index) => [
      127 + index / 10_000,
      37.5 + index / 20_000,
    ]);
    const card = courseCard(read(recorded, long), null);
    assert(card.status === 'available');
    expect(card.thumbnail.state.status).toBe('pending');
    expect(card.thumbnail.drawnVertices).toHaveLength(courseThumbnailLimits.vertexBudget);
    expect(card.thumbnail.drawnVertices[0]).toEqual(long[0]);
    expect(card.thumbnail.drawnVertices.at(-1)).toEqual(long.at(-1));
  });

  it('describes an unavailable course by its reference only', () => {
    const card = courseCard(
      {
        status: 'unavailable',
        course: {
          status: 'unavailable',
          courseId,
          name: '삭제된 원본',
          visibility: 'private',
          reason: 'source_activity_deleted',
          reclaimedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        },
      },
      elevation,
    );
    expect(card).toEqual({ status: 'unavailable', course: expect.objectContaining({ courseId }) });
    expect(Object.keys(card)).toEqual(['status', 'course']);
  });
});

function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error('assertion failed');
}
