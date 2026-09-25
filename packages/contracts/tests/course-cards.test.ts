import { describe, expect, it } from 'vitest';

import {
  courseCardDistanceSchema,
  courseCardElevationSchema,
  courseCardSurfaceSchema,
  courseCardThumbnailSchema,
} from '../src/course-cards.js';
import { courseThumbnailLimits } from '../src/courses.js';

/**
 * The S13 list card contract (M2-01k-a). What it must keep refusing is a card that claims a
 * fact the server does not have: a confirmed surface, a "not deployed" elevation that still
 * names a dataset or a profile, or a thumbnail sample larger than the renderer draws.
 */
describe('course card contract', () => {
  it('admits only an unknown surface', () => {
    expect(courseCardSurfaceSchema.parse({ confirmation: 'unknown' })).toEqual({
      confirmation: 'unknown',
    });
    for (const confirmation of ['confirmed', 'paved', null])
      expect(courseCardSurfaceSchema.safeParse({ confirmation }).success).toBe(false);
  });

  it('keeps not_deployed empty, and a sampled elevation bounded by its sample', () => {
    expect(courseCardElevationSchema.safeParse({ status: 'not_deployed' }).success).toBe(true);
    expect(
      courseCardElevationSchema.safeParse({ status: 'not_deployed', knownCount: 0 }).success,
    ).toBe(false);
    expect(courseCardElevationSchema.safeParse({ status: 'sampled' }).success).toBe(false);
  });

  it('tells actual, estimated and neither apart, with no free-form basis', () => {
    const base = { plannedLineMeters: 1200, privacyTrimmed: false };
    for (const basis of [
      { kind: 'recorded' },
      { kind: 'engine-estimate', engineDistanceMeters: 1250, graphBuildId: '0123456789abcdef' },
      { kind: 'imported-file', sourceKind: 'gpx-trk' },
      { kind: 'unknown' },
    ])
      expect(courseCardDistanceSchema.safeParse({ ...base, basis }).success).toBe(true);
    for (const basis of [
      { kind: 'actual' },
      { kind: 'recorded', deviceDistanceMeters: 1200 },
      { kind: 'engine-estimate' },
    ])
      expect(courseCardDistanceSchema.safeParse({ ...base, basis }).success).toBe(false);
  });

  it('bounds the drawn sample at the renderer budget', () => {
    const state = { status: 'none' };
    const within = Array.from(
      { length: courseThumbnailLimits.vertexBudget },
      (_, index) => [127 + index / 1000, 37.5] as const,
    );
    expect(courseCardThumbnailSchema.safeParse({ state, drawnVertices: within }).success).toBe(
      true,
    );
    expect(
      courseCardThumbnailSchema.safeParse({
        state,
        drawnVertices: [...within, [127.9, 37.6]],
      }).success,
    ).toBe(false);
  });
});
