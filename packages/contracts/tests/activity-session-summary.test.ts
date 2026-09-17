import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/fit-activity-summary-export.json';
import legacy from '../../../tests/fixtures/fit-activity-details-export.json';
import { activityDetailsSchema } from '../src/activity-details.js';
import { activityExportSchema } from '../src/activity.js';

describe('versioned FIT session summary', () => {
  const details = fixture.imports[0]?.details;
  if (!details) throw new Error('Missing synthetic FIT detail');
  const legacyDetails = legacy.imports[0]?.details;
  if (!legacyDetails) throw new Error('Missing legacy FIT detail');
  it('accepts the binary FIT exporter fixture and preserves session provenance', () => {
    expect(activityExportSchema.parse(fixture)).toEqual(fixture);
    expect(fixture.schemaVersion).toBe(3);
    expect(fixture.imports[0]?.source.revision).toBe(3);
    expect(details.sessionSummary).toEqual({ averageHeartRateBpm: 146, maximumHeartRateBpm: 181 });
    expect(details.records[0]?.heartRateBpm).toBe(120);
  });
  it('retains legacy absence without populating new fields', () => {
    expect(activityExportSchema.parse(legacy)).toEqual(legacy);
    expect(activityDetailsSchema.parse(legacyDetails)).not.toHaveProperty('sessionSummary');
  });
  it('preserves independent zero, null and inconsistent raw readings', () => {
    for (const sessionSummary of [
      { averageHeartRateBpm: 0, maximumHeartRateBpm: null },
      { averageHeartRateBpm: null, maximumHeartRateBpm: 0 },
      { averageHeartRateBpm: 200, maximumHeartRateBpm: 100 },
    ])
      expect(activityDetailsSchema.parse({ ...details, sessionSummary })).toMatchObject({
        sessionSummary,
      });
  });
  it.each([-1, 256, 0.5, Infinity, NaN, '100', undefined])(
    'rejects invalid summary values %s',
    (value) => {
      for (const field of ['averageHeartRateBpm', 'maximumHeartRateBpm']) {
        expect(
          activityDetailsSchema.safeParse({
            ...details,
            sessionSummary: { ...details.sessionSummary, [field]: value },
          }).success,
        ).toBe(false);
      }
    },
  );
  it('rejects missing summaries, extra fields and wrong envelope/detail version pairs', () => {
    for (const patch of [
      { sessionSummary: undefined },
      { sessionSummary: { ...details.sessionSummary, derived: true } },
      { schemaVersion: 1 },
    ]) {
      expect(activityDetailsSchema.safeParse({ ...details, ...patch }).success).toBe(false);
    }
    expect(activityExportSchema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(false);
    expect(activityExportSchema.safeParse({ ...legacy, schemaVersion: 3 }).success).toBe(false);
  });
});
