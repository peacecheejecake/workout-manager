import { mapPathSchema, type MapPath } from '@workout/contracts/tracks';
import { haversineMeters } from '@workout/track-parsing';
import { describe, expect, it } from 'vitest';

import {
  CourseSegmentError,
  deriveCourseFromRecordedSegment,
  plannedLineLengthMeters,
} from '../src/segment.js';

const sha = 'a'.repeat(64);

/**
 * Two drawn runs separated by a gap, exactly as a recording with a break produces: the
 * stored map path never joins them, and neither may a course cut from it.
 */
const storedPath: MapPath = mapPathSchema.parse({
  schemaVersion: 1,
  role: 'recorded',
  sourceRevision: {
    kind: 'activity-source',
    activityId: 'activity-1',
    sourceId: 'source-1',
    sourceRevision: 3,
    trackRevision: 2,
  },
  simplificationVersion: 1,
  toleranceMeters: 2.5,
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [126.9779, 37.5665],
        [126.9789, 37.5668],
        [126.9799, 37.5671],
        [126.9809, 37.5674],
      ],
      [
        [126.99, 37.575],
        [126.991, 37.5753],
      ],
    ],
  },
  vertexSampleIds: [
    ['0:0', '0:1', '0:2', '0:3'],
    ['0:8', '0:9'],
  ],
  lineSegmentIndices: [0, 1],
  points: [],
  insufficient: [],
  displayedPolylineLengthMeters: 400,
  crossesAntimeridian: false,
  outsideDisplayLatitude: false,
});

const source = {
  activityId: '11111111-1111-4111-8111-111111111111',
  trackId: '22222222-2222-4222-8222-222222222222',
  trackRevision: 2,
  mapPathContentSha256: sha,
};

const derive = (startSampleId: string, endSampleId: string) =>
  deriveCourseFromRecordedSegment({
    path: storedPath,
    selection: { startSampleId, endSampleId },
    source,
  });

describe('deriving a course from an explicitly selected segment', () => {
  it('cuts the inclusive vertex range named by two sample ids', () => {
    const derived = derive('0:1', '0:2');
    expect(derived.coordinates).toEqual([
      [126.9789, 37.5668],
      [126.9799, 37.5671],
    ]);
    expect(derived.generation).toMatchObject({
      kind: 'recorded-segment',
      lineIndex: 0,
      segmentIndex: 0,
      startSampleId: '0:1',
      endSampleId: '0:2',
      vertexCount: 2,
      mapPathContentSha256: sha,
      trackRevision: 2,
      toleranceMeters: 2.5,
    });
  });

  it('carries the recorded sample of each end as a waypoint, not a display index', () => {
    const derived = derive('0:0', '0:3');
    expect(derived.waypoints.map((waypoint) => [waypoint.role, waypoint.sourceSampleId])).toEqual([
      ['start', '0:0'],
      ['finish', '0:3'],
    ]);
    expect(derived.waypoints[0]?.position).toEqual([126.9779, 37.5665]);
    expect(derived.waypoints[1]?.position).toEqual([126.9809, 37.5674]);
  });

  it('cuts a reversed selection in recording order rather than refusing it', () => {
    expect(derive('0:2', '0:0').coordinates).toEqual(derive('0:0', '0:2').coordinates);
    expect(derive('0:2', '0:0').generation).toEqual(derive('0:0', '0:2').generation);
  });

  it('refuses a selection whose ends lie in different drawn runs instead of joining them', () => {
    expect(() => derive('0:2', '0:9')).toThrowError(
      expect.objectContaining({ code: 'SEGMENT_SPANS_A_GAP' }),
    );
  });

  it('refuses an end that was never drawn', () => {
    expect(() => derive('0:0', '0:5')).toThrowError(
      expect.objectContaining({ code: 'SEGMENT_ENDPOINT_NOT_DRAWN' }),
    );
  });

  it('refuses a single point rather than storing a course with one vertex', () => {
    expect(() => derive('0:1', '0:1')).toThrowError(
      expect.objectContaining({ code: 'SEGMENT_TOO_SHORT' }),
    );
  });

  it('refuses an end whose sample id names more than one vertex', () => {
    const ambiguous: MapPath = {
      ...storedPath,
      vertexSampleIds: [
        ['0:0', '0:1', '0:1', '0:3'],
        ['0:8', '0:9'],
      ],
    };
    expect(() =>
      deriveCourseFromRecordedSegment({
        path: ambiguous,
        selection: { startSampleId: '0:0', endSampleId: '0:1' },
        source,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SEGMENT_ENDPOINT_AMBIGUOUS' }));
  });

  it('refuses a path that is not a recording', () => {
    expect(() =>
      deriveCourseFromRecordedSegment({
        path: { ...storedPath, role: 'planned' },
        selection: { startSampleId: '0:0', endSampleId: '0:1' },
        source,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SEGMENT_NOT_A_RECORDING' }));
  });

  it('reports every refusal as a course segment error, never as a silent empty course', () => {
    const outcomes = [
      () => derive('0:2', '0:9'),
      () => derive('0:0', '0:5'),
      () => derive('0:1', '0:1'),
    ].map((attempt) => {
      try {
        attempt();
        return 'no-error';
      } catch (error) {
        return error instanceof CourseSegmentError ? error.code : 'other';
      }
    });
    expect(outcomes).toEqual([
      'SEGMENT_SPANS_A_GAP',
      'SEGMENT_ENDPOINT_NOT_DRAWN',
      'SEGMENT_TOO_SHORT',
    ]);
  });
});

describe('planned line length', () => {
  it('matches the recorded-track great-circle formula it deliberately does not import', () => {
    const coordinates = storedPath.geometry.coordinates[0] ?? [];
    let expected = 0;
    for (let index = 1; index < coordinates.length; index += 1)
      expected += haversineMeters(
        coordinates[index - 1] as [number, number],
        coordinates[index] as [number, number],
      );
    expect(plannedLineLengthMeters(coordinates as [number, number][])).toBeCloseTo(expected, 9);
    expect(expected).toBeGreaterThan(0);
  });

  it('measures only the vertices the course carries, not the whole recording', () => {
    const whole = plannedLineLengthMeters(
      (storedPath.geometry.coordinates[0] ?? []) as [number, number][],
    );
    expect(derive('0:0', '0:1').distanceMeters).toBeLessThan(whole);
    expect(derive('0:0', '0:3').distanceMeters).toBeCloseTo(whole, 9);
  });
});
