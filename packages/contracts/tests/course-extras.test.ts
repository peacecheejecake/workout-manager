import { describe, expect, it } from 'vitest';

import {
  courseGenerationSchema,
  courseImportRequestSchema,
  courseLimits,
  coursePreferenceUpdateSchema,
  coursePrivacyZoneCreateSchema,
  courseRevisionSchema,
  courseUpdateRequestSchema,
} from '../src/courses.js';
import { placeSearchRequestSchema } from '../src/geo-data.js';

/**
 * Contract rules for the rest of S13/S14 (M2-01j).
 *
 * The ones worth fixing here are the ones a later change could quietly undo: a client
 * cannot hand in geometry on any of these paths, a preference is exactly two fields, and
 * the conditions a trimmed or imported revision stores have no coordinate in them.
 */
const importRequest = {
  name: '가져온 코스',
  originalFilename: 'course.gpx',
  selection: null,
  // A tiny well-formed payload. The contracts package has no Node types, so the encoding
  // is done with the platform's own base64 rather than with `Buffer`.
  fileBase64: btoa('<gpx/>'),
};

describe('course import contract', () => {
  it('accepts a file, a name and a selection, and nothing that describes a line', () => {
    expect(courseImportRequestSchema.parse(importRequest).name).toBe('가져온 코스');
    for (const extra of [
      { geometry: { type: 'LineString', coordinates: [] } },
      { coordinates: [[127.02, 37.5]] },
      { distanceMeters: 10 },
      { vertexCount: 2 },
      { waypoints: [] },
      { parsed: {} },
    ])
      expect(courseImportRequestSchema.safeParse({ ...importRequest, ...extra }).success).toBe(
        false,
      );
  });

  it('bounds the encoded file and refuses anything that is not base64', () => {
    expect(
      courseImportRequestSchema.safeParse({ ...importRequest, fileBase64: 'not base64!' }).success,
    ).toBe(false);
    const tooLong = 'A'.repeat(Math.ceil((courseLimits.importFileBytes / 3) * 4) + 64);
    expect(
      courseImportRequestSchema.safeParse({ ...importRequest, fileBase64: tooLong }).success,
    ).toBe(false);
  });

  it('refuses a selection that names something outside the file bound', () => {
    expect(
      courseImportRequestSchema.safeParse({
        ...importRequest,
        selection: { sourceKind: 'gpx-trk', itemIndex: 99 },
      }).success,
    ).toBe(false);
    expect(
      courseImportRequestSchema.safeParse({
        ...importRequest,
        selection: { sourceKind: 'fit-session', itemIndex: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('imported and trimmed generation conditions', () => {
  const imported = {
    kind: 'imported-file',
    format: 'gpx',
    sourceKind: 'gpx-rte',
    itemIndex: 0,
    parserId: 'gpx-track-v1',
    parserVersion: 1,
    fileSha256: 'a'.repeat(64),
    fileByteLength: 200,
    originalFilename: 'course.gpx',
    fileCreator: 'workout-manager/course-v1',
    vertexCount: 2,
    importedWaypointCount: 2,
    ignoredFileWaypointCount: 0,
  };
  const trimmed = {
    kind: 'privacy-trimmed',
    sourceRevision: 3,
    sourceGenerationKind: 'recorded-segment',
    sourceGraphBuildId: null,
    policyVersion: 1,
    zoneSetDigest: 'b'.repeat(64),
    appliedZoneCount: 1,
    removedVertexCount: 2,
    removedLeadingVertexCount: 2,
    removedTrailingVertexCount: 0,
    removedWaypointCount: 1,
    vertexCount: 4,
  };

  it('keeps which GPX element the coordinates came from', () => {
    expect(courseGenerationSchema.parse(imported)).toMatchObject({ sourceKind: 'gpx-rte' });
    expect(
      courseGenerationSchema.safeParse({ ...imported, sourceKind: 'fit-session' }).success,
    ).toBe(false);
    // A course is imported from GPX; a different format needs its own conditions.
    expect(courseGenerationSchema.safeParse({ ...imported, format: 'fit' }).success).toBe(false);
  });

  it('leaves no place for a coordinate in either kind', () => {
    for (const base of [imported, trimmed])
      for (const extra of [
        { coordinates: [[127.02, 37.5]] },
        { center: [127.02, 37.5] },
        { positions: [] },
      ])
        expect(courseGenerationSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });

  it('requires a trim to have removed something', () => {
    expect(courseGenerationSchema.safeParse({ ...trimmed, removedVertexCount: 0 }).success).toBe(
      false,
    );
    expect(courseGenerationSchema.safeParse({ ...trimmed, appliedZoneCount: 0 }).success).toBe(
      false,
    );
  });

  it('lets an imported course carry no recording lineage while others still can', () => {
    const revision = {
      courseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      courseRevision: 1,
      revisionId: '99999999-9999-4999-8999-999999999999',
      name: '가져온 코스',
      geometry: {
        type: 'LineString',
        coordinates: [
          [127.02, 37.5],
          [127.021, 37.501],
        ],
      },
      waypoints: [
        { role: 'start', position: [127.02, 37.5], name: null, sourceSampleId: null },
        { role: 'finish', position: [127.021, 37.501], name: null, sourceSampleId: null },
      ],
      generation: imported,
      edit: { kind: 'imported' },
      lineage: [],
      distanceMeters: 140,
      contentDigest: 'c'.repeat(64),
      createdAt: '2026-09-19T01:00:00.000Z',
    };
    expect(courseRevisionSchema.parse(revision).lineage).toEqual([]);
    const withLineage = courseRevisionSchema.parse({
      ...revision,
      lineage: [
        {
          activityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          trackId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          trackRevision: 1,
        },
      ],
    });
    expect(withLineage.lineage).toHaveLength(1);
  });
});

describe('privacy trim request', () => {
  it('carries the area set it acknowledged and nothing else', () => {
    const request = {
      expectedRevision: 2,
      change: { kind: 'privacy-trim', acknowledgedZoneSetDigest: 'a'.repeat(64) },
    };
    expect(courseUpdateRequestSchema.parse(request).change.kind).toBe('privacy-trim');
    for (const extra of [
      { geometry: { type: 'LineString', coordinates: [] } },
      { waypoints: [] },
      { zones: [] },
      { center: [127.02, 37.5] },
    ])
      expect(
        courseUpdateRequestSchema.safeParse({
          ...request,
          change: { ...request.change, ...extra },
        }).success,
      ).toBe(false);
  });
});

describe('preferences and protected areas', () => {
  it('is exactly a favourite mark and a use, and refuses anything else', () => {
    expect(coursePreferenceUpdateSchema.parse({ favourite: true })).toEqual({ favourite: true });
    expect(coursePreferenceUpdateSchema.parse({ markUsed: true })).toEqual({ markUsed: true });
    for (const update of [
      {},
      { markUsed: false },
      { note: '집 근처' },
      { lastUsedAt: '2026-09-19T01:00:00.000Z' },
      { favourite: 'yes' },
      // An allowlisted field alongside one that is not: the extra is refused rather than
      // quietly stripped, which is what keeps the allowlist a rule and not a filter.
      { favourite: true, note: '집 근처' },
      { markUsed: true, lastUsedAt: '2026-09-19T01:00:00.000Z' },
    ])
      expect(coursePreferenceUpdateSchema.safeParse(update).success).toBe(false);
  });

  it('bounds a protected area so it protects something and not everything', () => {
    const zone = { name: '집', center: [127.02, 37.5], radiusMeters: 300 };
    expect(coursePrivacyZoneCreateSchema.parse(zone).radiusMeters).toBe(300);
    expect(
      coursePrivacyZoneCreateSchema.safeParse({
        ...zone,
        radiusMeters: courseLimits.privacyZoneMinRadiusMeters - 1,
      }).success,
    ).toBe(false);
    expect(
      coursePrivacyZoneCreateSchema.safeParse({
        ...zone,
        radiusMeters: courseLimits.privacyZoneMaxRadiusMeters + 1,
      }).success,
    ).toBe(false);
    expect(coursePrivacyZoneCreateSchema.safeParse({ ...zone, name: '<script>' }).success).toBe(
      false,
    );
  });
});

describe('place search request', () => {
  it('refuses a query with markup or control characters and bounds its length', () => {
    expect(placeSearchRequestSchema.parse({ query: '남산', near: null }).query).toBe('남산');
    expect(placeSearchRequestSchema.safeParse({ query: '<b>남산</b>', near: null }).success).toBe(
      false,
    );
    expect(
      placeSearchRequestSchema.safeParse({
        query: 'a'.repeat(courseLimits.placeQueryLength + 1),
        near: null,
      }).success,
    ).toBe(false);
    expect(placeSearchRequestSchema.safeParse({ query: '남산', near: [200, 0] }).success).toBe(
      false,
    );
  });
});
