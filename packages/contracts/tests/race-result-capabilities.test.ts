import { describe, expect, it } from 'vitest';
import { raceResultCapabilitiesSchema } from '../src/race-result-capabilities.js';

describe('race result capabilities structural contract', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('keeps independent legacy %s / proof %s support', (legacyResults, proofResultsV2) => {
    const value = { schemaVersion: 1, legacyResults, proofResultsV2 };
    expect(raceResultCapabilitiesSchema.parse(value)).toEqual(value);
  });
  it.each([
    {},
    { schemaVersion: 2, legacyResults: true, proofResultsV2: true },
    { schemaVersion: 1, legacyResults: 'true', proofResultsV2: false },
    { schemaVersion: 1, legacyResults: true, proofResultsV2: null },
    { schemaVersion: 1, legacyResults: true, proofResultsV2: true, approvalAllowed: true },
  ])('rejects invalid or authority-bearing wire fields', (value) => {
    expect(raceResultCapabilitiesSchema.safeParse(value).success).toBe(false);
  });
});
