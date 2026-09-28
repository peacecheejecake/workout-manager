import { expect, it } from 'vitest';
import {
  healthKitWorkoutReviewQuerySchema,
  healthKitWorkoutReviewResponseSchema,
} from '../src/healthkit-review.js';

it('accepts only bounded, uncoerced review query values', () => {
  expect(healthKitWorkoutReviewQuerySchema.parse({})).toEqual({});
  expect(healthKitWorkoutReviewQuerySchema.parse({ limit: '100' })).toEqual({ limit: 100 });
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { limit: '01' },
    { limit: '1.5' },
    { limit: '-1' },
    { limit: ['1', '2'] },
    { athleteId: 'other' },
  ]) {
    expect(healthKitWorkoutReviewQuerySchema.safeParse(query).success).toBe(false);
  }
});

it('exposes only decision facts with validated times and without raw provider fields', () => {
  const item = {
    sampleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedSampleDigest: 'b'.repeat(64),
    kind: 'running',
    observedFrom: '2026-09-20T00:00:00.000Z',
    observedTo: '2026-09-20T00:35:00.000Z',
    durationSeconds: 2100,
    distanceMeters: null,
  };
  expect(healthKitWorkoutReviewResponseSchema.parse({ items: [item] })).toEqual({ items: [item] });
  for (const invalid of [
    { ...item, observedTo: '2026-09-19T23:59:00Z' },
    { ...item, distanceMeters: -1 },
    { ...item, expectedSampleDigest: 'bad' },
    { ...item, sourceBundleId: 'private' },
    { ...item, energyKilocalories: 200 },
  ]) {
    expect(healthKitWorkoutReviewResponseSchema.safeParse({ items: [invalid] }).success).toBe(
      false,
    );
  }
});
