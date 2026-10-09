import { expect, it } from 'vitest';
import {
  type CoursePosition,
  courseWaypointListSchema,
  type CoursePrivacyZone,
} from '@workout/contracts/courses';
import { disclosureChoices, trimCourseForExportDisclosure } from '../src/disclosure.js';
import { greatCircleMeters } from '../src/geo.js';
import { trimCourseForPrivacy } from '../src/privacy-trim.js';
const center: CoursePosition = [127, 37.5];
const grid: CoursePosition = [127.003, 37.5];
const zone: CoursePrivacyZone = {
  zoneId: '10000000-0000-4000-8000-000000000001',
  name: '합성 구역',
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
  center,
  radiusMeters: greatCircleMeters(center, grid) + 0.2,
};
const ends = (line: CoursePosition[]) =>
  courseWaypointListSchema.parse([
    {
      role: 'start',
      position: line[0],
      name: '합성 시작',
      sourceSampleId: null,
      locked: false,
    },
    {
      role: 'finish',
      position: line.at(-1),
      name: null,
      sourceSampleId: null,
      locked: false,
    },
  ]);
it.each([false, true])(
  'appends exactly the previewed settled line when raw start is inside=%s',
  (inside) => {
    const line: CoursePosition[] = [
      ...(inside ? [center] : []),
      [127.0030049, 37.5],
      [127.01, 37.5],
      [127.02, 37.5],
    ];
    const input = {
      coordinates: line,
      waypoints: ends(line),
      zones: [zone],
      sourceRevision: 2,
      sourceGenerationKind: 'imported-file' as const,
      sourceGraphBuildId: null,
    };
    const preview = disclosureChoices('export', line, input.waypoints, [zone]).options.find(
      (o) => o.exposure === 'trimmed',
    );
    expect(preview).toBeDefined();
    if (!inside) expect(() => trimCourseForPrivacy(input)).toThrow('COURSE_TRIM_CHANGES_NOTHING');
    else expect(trimCourseForPrivacy(input).coordinates[0]).toEqual([127.0030049, 37.5]);
    const appended = trimCourseForExportDisclosure(input);
    expect(appended.coordinates).toEqual(preview?.line.coordinates);
    expect(appended.waypoints).toEqual(preview?.line.waypoints);
    expect(appended.distanceMeters).toBe(preview?.distanceMeters);
    expect(
      disclosureChoices('export', appended.coordinates, appended.waypoints, [zone]).options[0]
        ?.exposure,
    ).toBe('no-zone-intersection');
    expect(input.coordinates).toEqual(line);
  },
);
it('still refuses a genuine unchanged trim and does not manufacture a revision', () => {
  const line: CoursePosition[] = [
    [127.01, 37.5],
    [127.02, 37.5],
  ];
  expect(() =>
    trimCourseForExportDisclosure({
      coordinates: line,
      waypoints: ends(line),
      zones: [zone],
      sourceRevision: 2,
      sourceGenerationKind: 'imported-file',
      sourceGraphBuildId: null,
    }),
  ).toThrow('COURSE_TRIM_CHANGES_NOTHING');
});
