import { expect, it } from 'vitest';
import { restoreGenerationResponseSchema } from '../src/restore-generation.js';

it('accepts only a bounded generation UUID response', () => {
  const generationId = '30000000-0000-4000-8000-000000000001';
  expect(restoreGenerationResponseSchema.parse({ generationId })).toEqual({ generationId });
  expect(restoreGenerationResponseSchema.safeParse({ generationId: 'stale' }).success).toBe(false);
  expect(
    restoreGenerationResponseSchema.safeParse({ generationId, athleteId: 'other' }).success,
  ).toBe(false);
});
