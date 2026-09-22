import type { CourseGeneration, CourseLineage, CourseWaypoint } from '@workout/contracts/courses';
import { describe, expect, it } from 'vitest';

import { courseContentDigest, type CourseContent } from '../src/digest.js';

const generation: CourseGeneration = {
  kind: 'recorded-segment',
  activityId: '11111111-1111-4111-8111-111111111111',
  trackId: '22222222-2222-4222-8222-222222222222',
  trackRevision: 2,
  lineIndex: 0,
  segmentIndex: 0,
  startSampleId: '0:0',
  endSampleId: '0:3',
  vertexCount: 2,
  mapPathContentSha256: 'a'.repeat(64),
  simplificationVersion: 1,
  toleranceMeters: 2.5,
};

const firstSource: CourseLineage = {
  activityId: '11111111-1111-4111-8111-111111111111',
  trackId: '22222222-2222-4222-8222-222222222222',
  trackRevision: 2,
};
const lineage: CourseLineage[] = [firstSource];

const startWaypoint: CourseWaypoint = {
  role: 'start',
  position: [126.9779, 37.5665],
  name: null,
  sourceSampleId: '0:0',
  locked: false,
};
const finishWaypoint: CourseWaypoint = {
  role: 'finish',
  position: [126.9799, 37.5671],
  name: null,
  sourceSampleId: '0:3',
  locked: false,
};
const waypoints: CourseWaypoint[] = [startWaypoint, finishWaypoint];

const content: CourseContent = {
  name: 'Seoul loop',
  coordinates: [
    [126.9779, 37.5665],
    [126.9799, 37.5671],
  ],
  waypoints,
  generation,
  lineage,
};

describe('course content digest', () => {
  it('is the same for the same content', () => {
    expect(courseContentDigest(content)).toBe(courseContentDigest({ ...content }));
  });

  it('changes when the name, geometry, a waypoint or the lineage changes', () => {
    const base = courseContentDigest(content);
    expect(courseContentDigest({ ...content, name: 'Other loop' })).not.toBe(base);
    expect(
      courseContentDigest({
        ...content,
        coordinates: [
          [126.9779, 37.5665],
          [126.98, 37.5671],
        ],
      }),
    ).not.toBe(base);
    expect(
      courseContentDigest({
        ...content,
        waypoints: [startWaypoint, { ...finishWaypoint, name: 'end' }],
      }),
    ).not.toBe(base);
    expect(
      courseContentDigest({
        ...content,
        lineage: [{ ...firstSource, trackRevision: 3 }],
      }),
    ).not.toBe(base);
  });

  it('changes when the selection the geometry was cut from changes', () => {
    expect(
      courseContentDigest({ ...content, generation: { ...generation, endSampleId: '0:2' } }),
    ).not.toBe(courseContentDigest(content));
  });

  it('does not depend on the order lineage is listed in', () => {
    const second: CourseLineage = {
      activityId: '33333333-3333-4333-8333-333333333333',
      trackId: '44444444-4444-4444-8444-444444444444',
      trackRevision: 1,
    };
    expect(courseContentDigest({ ...content, lineage: [firstSource, second] })).toBe(
      courseContentDigest({ ...content, lineage: [second, firstSource] }),
    );
  });
});

/**
 * The waypoint editor adds two things to the material a digest covers: whether a waypoint
 * is locked, and — for a routed revision — what computed it. Both have to change the
 * digest when they change, and neither may change the digest of anything written before
 * the editor existed.
 */
describe('course content digest with waypoint locking and routed conditions', () => {
  it('gives an unlocked waypoint the digest a revision without the field already had', () => {
    // A revision stored by M2-01f has no `locked` key at all. If the digest covered the
    // field unconditionally, every one of those revisions would suddenly hash differently
    // and a rename that changed nothing would append a version.
    const beforeLocking = {
      ...content,
      waypoints: waypoints.map((waypoint) => {
        const copy: Record<string, unknown> = { ...waypoint };
        delete copy['locked'];
        return copy as unknown as CourseWaypoint;
      }),
    };
    expect(courseContentDigest(beforeLocking)).toBe(courseContentDigest(content));
  });

  it('changes when a waypoint is locked', () => {
    const locked = {
      ...content,
      waypoints: [{ ...startWaypoint, locked: true }, finishWaypoint],
    };
    expect(courseContentDigest(locked)).not.toBe(courseContentDigest(content));
  });

  it('identifies a routed revision by what answered it, not by when it was asked', () => {
    const routed: CourseGeneration = {
      kind: 'routed-waypoints',
      computation: {
        schemaVersion: 1,
        requestId: 'req-1',
        requestRevision: 3,
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
      },
      engineDistanceMeters: 1234.5,
      engineDurationSeconds: 900,
      maxSnapDistanceMeters: 4,
      waypointCount: 2,
      vertexCount: 2,
    };
    const base = { ...content, generation: routed };
    // Asking again for the same waypoints on the same graph is the same course.
    const askedAgain = {
      ...base,
      generation: {
        ...routed,
        computation: {
          ...routed.computation,
          requestId: 'req-2',
          requestRevision: 9,
          computedAt: '2026-03-09T00:00:00.000Z',
          computationMilliseconds: 7,
        },
      } as CourseGeneration,
    };
    expect(courseContentDigest(askedAgain)).toBe(courseContentDigest(base));
    // A different graph is a different answer, even for the same waypoints.
    const otherGraph = {
      ...base,
      generation: {
        ...routed,
        computation: {
          ...routed.computation,
          graph: { ...routed.computation.graph, graphBuildId: 'fedcba9876543210' },
        },
      } as CourseGeneration,
    };
    expect(courseContentDigest(otherGraph)).not.toBe(courseContentDigest(base));
    // And a routed revision is never the same content as a cut one.
    expect(courseContentDigest(base)).not.toBe(courseContentDigest(content));
  });
});
