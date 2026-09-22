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
};
const finishWaypoint: CourseWaypoint = {
  role: 'finish',
  position: [126.9799, 37.5671],
  name: null,
  sourceSampleId: '0:3',
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
