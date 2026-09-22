import type { CoursePosition, CoursePrivacyZone, CourseWaypoint } from '@workout/contracts/courses';
import { describe, expect, it } from 'vitest';

import {
  CourseTrimError,
  privacyZoneSetDigest,
  trimCourseForPrivacy,
} from '../src/privacy-trim.js';

/**
 * Privacy trim (M2-01j).
 *
 * The rules under test are the ones the plan states: the trim is a derived revision, it
 * examines the whole line rather than only its ends, it never joins what it removes, and
 * nothing it stores about itself contains a coordinate or a protected-area centre.
 */
const home: CoursePrivacyZone = {
  zoneId: '11111111-1111-4111-8111-111111111111',
  name: '집',
  center: [127.02, 37.5],
  radiusMeters: 200,
  createdAt: '2026-09-19T01:00:00.000Z',
  updatedAt: '2026-09-19T01:00:00.000Z',
};

/** ~0.001° of latitude is about 111 m; 0.01° is about 1.1 km, comfortably outside. */
const line = (points: [number, number][]): CoursePosition[] => points;

const ends = (coordinates: readonly CoursePosition[]): CourseWaypoint[] => {
  const [start] = coordinates;
  const finish = coordinates.at(-1);
  if (start === undefined || finish === undefined) throw new Error('a line needs two ends');
  return [
    { role: 'start', position: start, name: '집 앞', sourceSampleId: '0:0', locked: false },
    { role: 'finish', position: finish, name: null, sourceSampleId: '0:9', locked: false },
  ];
};

function trim(coordinates: CoursePosition[], waypoints = ends(coordinates), zones = [home]) {
  return trimCourseForPrivacy({
    coordinates,
    waypoints,
    zones,
    sourceRevision: 3,
    sourceGenerationKind: 'recorded-segment',
    sourceGraphBuildId: null,
  });
}

describe('privacy trim', () => {
  it('removes the vertices inside a protected area from both ends', () => {
    const coordinates = line([
      [127.02, 37.5],
      [127.0205, 37.5005],
      [127.03, 37.51],
      [127.04, 37.52],
      [127.0205, 37.5006],
      [127.02, 37.5001],
    ]);
    const result = trim(coordinates);
    expect(result.coordinates).toEqual([
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
    if (result.generation.kind !== 'privacy-trimmed') throw new Error('unreachable');
    expect(result.generation.removedLeadingVertexCount).toBe(2);
    expect(result.generation.removedTrailingVertexCount).toBe(2);
    expect(result.generation.removedVertexCount).toBe(4);
    expect(result.generation.sourceRevision).toBe(3);
    expect(result.generation.policyVersion).toBe(1);
  });

  it('refuses a course that re-enters the area rather than joining across it', () => {
    // Out, back into the protected area in the middle, out again. A start/finish trim
    // would miss this entirely; removing the middle would draw a straight line through the
    // area the owner is protecting.
    const coordinates = line([
      [127.03, 37.51],
      [127.04, 37.52],
      [127.02, 37.5],
      [127.05, 37.53],
      [127.06, 37.54],
    ]);
    expect(() => trim(coordinates)).toThrow(new CourseTrimError('COURSE_TRIM_SPLITS_THE_LINE'));
  });

  it('refuses a line that crosses the area between two vertices that are both outside it', () => {
    // The defect this fixes: only vertex membership was tested, so a straight run through
    // the centre came back as a successful trim and its coordinates went into the response
    // and the GPX. Both endpoints are ~1.1 km out; the line passes over the centre.
    const centre: CoursePrivacyZone = { ...home, center: [0, 0], radiusMeters: 200 };
    const coordinates = line([
      [0, 0.02],
      [0.01, 0],
      [-0.01, 0],
    ]);
    // Its own code: nothing re-enters here, so the owner is not told that it does.
    expect(() => trim(coordinates, ends(coordinates), [centre])).toThrow(
      new CourseTrimError('COURSE_TRIM_LINE_CROSSES_AREA'),
    );
  });

  it('refuses a course whose vertices are all outside but whose line still crosses', () => {
    // No vertex is inside at all, so the old code answered "this course never enters a
    // protected area". It does enter it — between the two vertices.
    const centre: CoursePrivacyZone = { ...home, center: [0, 0], radiusMeters: 200 };
    const coordinates = line([
      [0.01, 0],
      [-0.01, 0],
    ]);
    expect(() => trim(coordinates, ends(coordinates), [centre])).toThrow(
      new CourseTrimError('COURSE_TRIM_LINE_CROSSES_AREA'),
    );
  });

  it('treats a line that just grazes the edge as entering it', () => {
    // A tangent: the closest approach is the radius itself. Inclusive, like the vertex
    // test — the boundary belongs to the protected area.
    const centre: CoursePrivacyZone = { ...home, center: [0, 0], radiusMeters: 200 };
    // 200 m north of the centre is 0.0017986° of latitude.
    const grazing = 200 / ((Math.PI / 180) * 6_371_008.8);
    const coordinates = line([
      [-0.01, grazing],
      [0.01, grazing],
    ]);
    expect(() => trim(coordinates, ends(coordinates), [centre])).toThrow(
      new CourseTrimError('COURSE_TRIM_LINE_CROSSES_AREA'),
    );
    // A line a little further out is genuinely clear of it, and is reported as such.
    const clear = line([
      [-0.01, grazing * 1.5],
      [0.01, grazing * 1.5],
    ]);
    expect(() => trim(clear, ends(clear), [centre])).toThrow(
      new CourseTrimError('COURSE_TRIM_CHANGES_NOTHING'),
    );
  });

  it('keeps a trim whose remaining line stays clear of every area', () => {
    const centre: CoursePrivacyZone = { ...home, center: [0, 0], radiusMeters: 200 };
    const coordinates = line([
      [0, 0],
      [0.01, 0.01],
      [0.02, 0.02],
    ]);
    const result = trim(coordinates, ends(coordinates), [centre]);
    expect(result.coordinates).toEqual([
      [0.01, 0.01],
      [0.02, 0.02],
    ]);
  });

  it('says a course never enters a protected area instead of writing a copy of it', () => {
    const coordinates = line([
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
    expect(() => trim(coordinates)).toThrow(new CourseTrimError('COURSE_TRIM_CHANGES_NOTHING'));
  });

  it('refuses a trim that would leave nothing', () => {
    const coordinates = line([
      [127.02, 37.5],
      [127.0201, 37.5001],
    ]);
    expect(() => trim(coordinates)).toThrow(new CourseTrimError('COURSE_TRIM_REMOVES_EVERYTHING'));
  });

  it('refuses a trim with no protected area at all', () => {
    const coordinates = line([
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
    expect(() => trim(coordinates, ends(coordinates), [])).toThrow(
      new CourseTrimError('COURSE_TRIM_NO_PROTECTED_AREA'),
    );
  });

  it('removes a waypoint that falls inside a protected area, name and all', () => {
    const coordinates = line([
      [127.02, 37.5],
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
    const waypoints: CourseWaypoint[] = [
      {
        role: 'start',
        position: [127.02, 37.5],
        name: '우리집',
        sourceSampleId: '0:0',
        locked: false,
      },
      {
        role: 'via',
        position: [127.0201, 37.5002],
        name: '집 앞 골목',
        sourceSampleId: null,
        locked: false,
      },
      { role: 'via', position: [127.03, 37.51], name: '공원', sourceSampleId: null, locked: true },
      {
        role: 'finish',
        position: [127.04, 37.52],
        name: '도착',
        sourceSampleId: '0:9',
        locked: false,
      },
    ];
    const result = trim(coordinates, waypoints);
    const serialized = JSON.stringify(result.waypoints);
    expect(serialized).not.toContain('우리집');
    expect(serialized).not.toContain('집 앞 골목');
    expect(result.waypoints.map((waypoint) => waypoint.name)).toEqual([null, '공원', null]);
    // The new ends are ends of the trimmed line, not the waypoints the owner placed.
    expect(result.waypoints[0]?.position).toEqual([127.03, 37.51]);
    expect(result.waypoints[0]?.sourceSampleId).toBeNull();
    if (result.generation.kind !== 'privacy-trimmed') throw new Error('unreachable');
    expect(result.generation.removedWaypointCount).toBe(2);
  });

  it('carries no coordinate and no protected-area centre in what it stores', () => {
    const coordinates = line([
      [127.02, 37.5],
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
    const serialized = JSON.stringify(trim(coordinates).generation);
    expect(serialized).not.toContain('127.02');
    expect(serialized).not.toContain('37.5');
    expect(serialized).toContain(privacyZoneSetDigest([home]));
  });

  /**
   * Ids and radii, never a centre — and the consequence, stated rather than implied.
   *
   * Because a moved centre leaves this digest unchanged, an acknowledged-set guard cannot
   * see one. That is safe only while nothing can move a centre, which is why the product
   * has no such path and the runtime role is granted no UPDATE on `course_privacy_zone`
   * (`migrate.ts`). Adding a move means changing this digest first; this test is where
   * that decision has to be made rather than discovered.
   */
  it('identifies an area set by its ids and radii, never by where it is', () => {
    const moved: CoursePrivacyZone = { ...home, center: [126.5, 37.1] };
    expect(privacyZoneSetDigest([moved])).toBe(privacyZoneSetDigest([home]));
    const resized: CoursePrivacyZone = { ...home, radiusMeters: 500 };
    expect(privacyZoneSetDigest([resized])).not.toBe(privacyZoneSetDigest([home]));
    const second: CoursePrivacyZone = { ...home, zoneId: '22222222-2222-4222-8222-222222222222' };
    // Order does not change the identity of a set.
    expect(privacyZoneSetDigest([home, second])).toBe(privacyZoneSetDigest([second, home]));
    expect(privacyZoneSetDigest([home, second])).not.toBe(privacyZoneSetDigest([home]));
  });

  it('keeps the graph that computed the line it trimmed', () => {
    const coordinates = line([
      [127.02, 37.5],
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
    const result = trimCourseForPrivacy({
      coordinates,
      waypoints: ends(coordinates),
      zones: [home],
      sourceRevision: 4,
      sourceGenerationKind: 'routed-waypoints',
      sourceGraphBuildId: '0123456789abcdef',
    });
    if (result.generation.kind !== 'privacy-trimmed') throw new Error('unreachable');
    expect(result.generation.sourceGraphBuildId).toBe('0123456789abcdef');
    expect(result.generation.sourceGenerationKind).toBe('routed-waypoints');
  });

  it('measures the trimmed line rather than keeping the original length', () => {
    const coordinates = line([
      [127.02, 37.5],
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
    const result = trim(coordinates);
    expect(result.coordinates).toHaveLength(2);
    expect(result.distanceMeters).toBeGreaterThan(1_000);
    expect(result.distanceMeters).toBeLessThan(2_000);
  });
});
