import { courseGpxCreator, type CourseWaypoint } from '@workout/contracts/courses';
import { createParseBudget, defaultTrackParseLimits, parseGpx } from '@workout/track-parsing';
import { describe, expect, it } from 'vitest';

import { courseGpxFileName, writeCourseGpx } from '../src/gpx.js';

const first: [number, number] = [126.9779, 37.5665];
const middle: [number, number] = [126.9789, 37.5668];
const last: [number, number] = [126.9799, 37.5671];
const coordinates: [number, number][] = [first, middle, last];

const waypoints: CourseWaypoint[] = [
  { role: 'start', position: first, name: null, sourceSampleId: '0:0', locked: false },
  { role: 'finish', position: last, name: '광화문', sourceSampleId: '0:2', locked: false },
];

const input = {
  name: 'Seoul loop & back',
  includeNames: true,
  coordinates,
  waypoints,
  coordinateDigits: 7 as const,
};
const document = writeCourseGpx(input);

const parsed = (text = document) =>
  parseGpx(text, defaultTrackParseLimits, createParseBudget(defaultTrackParseLimits));

/**
 * The GPX element/attribute allowlist (M2-01k-o T8, R6): `gpx/metadata/name?`,
 * `wpt[@lat,@lon]/(name?,type)`, `rte/(name?,rtept[@lat,@lon])`. Anything else fails.
 */
function allowlistViolations(text: string): string[] {
  const violations: string[] = [];
  const allowed = new Map<string, readonly string[]>([
    ['gpx', ['version', 'creator', 'xmlns']],
    ['metadata', []],
    ['name', []],
    ['wpt', ['lat', 'lon']],
    ['type', []],
    ['rte', []],
    ['rtept', ['lat', 'lon']],
  ]);
  const parents = new Map<string, readonly string[]>([
    ['metadata', ['gpx']],
    ['wpt', ['gpx']],
    ['rte', ['gpx']],
    ['rtept', ['rte']],
    ['type', ['wpt']],
    ['name', ['metadata', 'wpt', 'rte']],
  ]);
  const stack: string[] = [];
  for (const match of text.matchAll(/<(\/?)([A-Za-z:]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag = '', attributes = '', selfClosing] = match;
    if (tag === 'xml') continue;
    if (closing) {
      stack.pop();
      continue;
    }
    const allowedAttributes = allowed.get(tag);
    if (allowedAttributes === undefined) violations.push(`element ${tag}`);
    const parent = stack.at(-1);
    const expectedParents = parents.get(tag);
    if (expectedParents && (parent === undefined || !expectedParents.includes(parent)))
      violations.push(`${tag} under ${parent ?? 'nothing'}`);
    for (const attribute of attributes.matchAll(/([A-Za-z:]+)="/g))
      if (!allowedAttributes?.includes(attribute[1] ?? ''))
        violations.push(`attribute ${tag}@${attribute[1]}`);
    if (!selfClosing && !attributes.trimEnd().endsWith('?')) stack.push(tag);
  }
  return violations;
}

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

  it('produces the same bytes for the same content', () => {
    expect(writeCourseGpx({ ...input })).toBe(document);
  });

  // M2-01k-o, finding (b) and A-1/R-3/R-6: the file says nothing about itself beyond the
  // allowlist — no description, no time, no id, no revision, no product name.
  it('carries only the allowlisted elements, and no description, time or identity', () => {
    for (const text of [document, writeCourseGpx({ ...input, includeNames: false })]) {
      expect(allowlistViolations(text)).toEqual([]);
      expect(text).not.toContain('<desc>');
      expect(text).not.toContain('<time>');
      expect(text).not.toContain('<extensions>');
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(text).not.toMatch(/revision/i);
      expect(text).not.toContain('workout-manager');
    }
    expect(courseGpxCreator).not.toContain('workout-manager');
    expect(document).toContain(`creator="${courseGpxCreator}"`);
  });

  it('refuses an element outside the allowlist in the checker itself', () => {
    expect(
      allowlistViolations(document.replace('</metadata>', '<desc>x</desc></metadata>')),
    ).toContain('element desc');
    expect(
      allowlistViolations(document.replace('<rte>', '<rte><time>2026-01-01</time>')),
    ).toContain('element time');
  });

  // D6: names are in by default for the owner's GPX, and out entirely when turned off.
  it('writes names only when the owner keeps them', () => {
    expect(document).toContain('<metadata>');
    expect(document.match(/<name>/g)).toHaveLength(3);
    const nameless = writeCourseGpx({ ...input, includeNames: false });
    expect(nameless).not.toContain('<name>');
    expect(nameless).not.toContain('<metadata>');
    expect(nameless).not.toContain('Seoul');
    expect(nameless).not.toContain('광화문');
    expect(parsed(nameless).routes[0]?.points).toHaveLength(3);
  });

  it('writes the precision it is asked for', () => {
    const disclosed = writeCourseGpx({ ...input, coordinateDigits: 5 });
    expect(disclosed).toContain('lat="37.56650" lon="126.97790"');
    expect(document).toContain('lat="37.5665000" lon="126.9779000"');
  });

  it('names the file after the course, never a revision or a storage key', () => {
    expect(courseGpxFileName('Seoul loop & back')).toBe('Seoul-loop-back.gpx');
    expect(courseGpxFileName('../../etc/passwd')).toBe('etc-passwd.gpx');
    expect(courseGpxFileName('   ')).toBe('course.gpx');
    expect(courseGpxFileName(null)).toBe('course.gpx');
  });

  it('refuses a name carrying control or angle-bracket characters', () => {
    expect(() => writeCourseGpx({ ...input, name: 'bad<name>' })).toThrowError();
  });
});
