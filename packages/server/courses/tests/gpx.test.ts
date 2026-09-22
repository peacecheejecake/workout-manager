import type { CourseWaypoint } from '@workout/contracts/courses';
import { createParseBudget, defaultTrackParseLimits, parseGpx } from '@workout/track-parsing';
import { describe, expect, it } from 'vitest';

import { courseGpxFileName, writeCourseGpx } from '../src/gpx.js';

const first: [number, number] = [126.9779, 37.5665];
const middle: [number, number] = [126.9789, 37.5668];
const last: [number, number] = [126.9799, 37.5671];
const coordinates: [number, number][] = [first, middle, last];

const waypoints: CourseWaypoint[] = [
  { role: 'start', position: first, name: null, sourceSampleId: '0:0' },
  { role: 'finish', position: last, name: '광화문', sourceSampleId: '0:2' },
];

const document = writeCourseGpx({
  name: 'Seoul loop & back',
  courseId: '11111111-1111-4111-8111-111111111111',
  courseRevision: 2,
  createdAt: '2026-03-01T00:00:00.000Z',
  coordinates,
  waypoints,
});

const parsed = () =>
  parseGpx(document, defaultTrackParseLimits, createParseBudget(defaultTrackParseLimits));

describe('course GPX export', () => {
  it('round-trips through the GPX reader as a route with its waypoints', () => {
    const file = parsed();
    expect(file.routes).toHaveLength(1);
    expect(file.routes[0]?.points.map((point) => point.position)).toEqual(coordinates);
    expect(file.waypoints.map((waypoint) => waypoint.position)).toEqual([first, last]);
  });

  it('is a route and never a recorded track', () => {
    expect(parsed().tracks).toEqual([]);
    expect(document).not.toContain('<trk>');
    expect(document).not.toContain('<trkpt');
    expect(document).not.toContain('<trkseg>');
  });

  it('keeps the course name and a named waypoint through the round trip', () => {
    const file = parsed();
    expect(file.routes[0]?.name).toBe('Seoul loop & back');
    expect(file.waypoints[1]?.name).toBe('광화문');
  });

  it('escapes text so an ampersand survives instead of breaking the document', () => {
    expect(document).toContain('Seoul loop &amp; back');
  });

  it('invents no elevation for a course that has none', () => {
    expect(document).not.toContain('<ele>');
    expect(parsed().waypoints.every((waypoint) => waypoint.elevationMeters === null)).toBe(true);
    expect(parsed().routes[0]?.points.every((point) => point.elevationMeters === null)).toBe(true);
  });

  it('produces the same bytes for the same revision', () => {
    expect(
      writeCourseGpx({
        name: 'Seoul loop & back',
        courseId: '11111111-1111-4111-8111-111111111111',
        courseRevision: 2,
        createdAt: '2026-03-01T00:00:00.000Z',
        coordinates,
        waypoints,
      }),
    ).toBe(document);
  });

  it('names the file after the course and its revision, without a storage key', () => {
    expect(courseGpxFileName('Seoul loop & back', 2)).toBe('Seoul-loop-back-r2.gpx');
    expect(courseGpxFileName('../../etc/passwd', 1)).toBe('etc-passwd-r1.gpx');
    expect(courseGpxFileName('   ', 3)).toBe('course-r3.gpx');
  });

  it('refuses a name carrying control or angle-bracket characters', () => {
    expect(() =>
      writeCourseGpx({
        name: 'bad<name>',
        courseId: '11111111-1111-4111-8111-111111111111',
        courseRevision: 1,
        createdAt: '2026-03-01T00:00:00.000Z',
        coordinates,
        waypoints,
      }),
    ).toThrowError();
  });
});
