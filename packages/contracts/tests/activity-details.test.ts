import { describe, expect, it } from 'vitest';
import exportedFitFixture from '../../../tests/fixtures/fit-activity-details-export.json';
import {
  activityDetailsSchema,
  activityDetailLimits,
  type ActivityDetails,
} from '../src/activity-details.js';
import {
  activityDetailsReadSchema,
  activityExportSchema,
  importActivitySchema,
} from '../src/activity.js';

const details: ActivityDetails = {
  schemaVersion: 1,
  streamIndex: 0,
  sessionIndex: 0,
  startedAt: '2026-09-01T00:00:00Z',
  recordedAt: '2026-09-02T00:00:00Z',
  elapsedSeconds: 60,
  records: [
    { index: 0, timestamp: null, distanceMeters: 0, heartRateBpm: null },
    { index: 2, timestamp: '2026-09-01T00:00:10Z', distanceMeters: null, heartRateBpm: 120 },
    { index: 3, timestamp: '2026-09-01T00:00:10Z', distanceMeters: 10, heartRateBpm: 0 },
  ],
  laps: [
    {
      index: 0,
      startedAt: null,
      recordedAt: '2026-09-02T00:00:00Z',
      elapsedSeconds: null,
      timerSeconds: 0,
      distanceMeters: null,
      averageHeartRateBpm: null,
      maximumHeartRateBpm: 150,
    },
  ],
};
const legacy = {
  idempotencyKey: 'legacy-import-0001',
  source: { kind: 'fit', sourceId: 'session-1', revision: 1, contentHash: 'a'.repeat(64) },
  activity: {
    title: null,
    kind: 'running',
    startedAt: null,
    durationSeconds: null,
    durationKind: 'unknown',
    distanceMeters: 0,
    timezone: null,
  },
};

describe('S09 bounded source observations', () => {
  it('accepts the actual synthetic Python FIT export without dropping source detail', () => {
    const raw: unknown = exportedFitFixture;
    const parsed = activityExportSchema.parse(raw);
    expect(parsed).toEqual(raw);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.imports[0]?.source.revision).toBe(2);
    expect(parsed.imports[0]?.details?.records[0]?.heartRateBpm).toBe(120);
    expect(parsed.imports[0]?.details?.laps[0]?.startedAt).toBeNull();
  });
  it('preserves null, zero, duplicate timestamps and original message indices without interpolation', () => {
    expect(activityDetailsSchema.parse(details)).toStrictEqual(details);
  });
  it('does not turn the summary write timestamp into an interval end', () => {
    const parsed = activityDetailsSchema.parse(details);
    expect(parsed.recordedAt).toBe('2026-09-02T00:00:00Z');
    expect(parsed.elapsedSeconds).toBe(60);
    expect(parsed.laps[0]?.startedAt).toBeNull();
    expect(parsed.laps[0]?.elapsedSeconds).toBeNull();
  });
  it.each(['records', 'laps'] as const)(
    'rejects duplicate or reordered source %s indices',
    (key) => {
      const first = details[key][0];
      if (!first) throw new Error('Missing fixture');
      for (const indices of [
        [1, 1],
        [2, 1],
      ]) {
        const invalid = { ...details, [key]: indices.map((index) => ({ ...first, index })) };
        expect(activityDetailsSchema.safeParse(invalid).success).toBe(false);
      }
    },
  );
  it.each([-1, 256, 1.5, Infinity, NaN])('rejects invalid heart rate %s', (heartRateBpm) => {
    expect(
      activityDetailsSchema.safeParse({
        ...details,
        records: [{ ...details.records[0], heartRateBpm }],
      }).success,
    ).toBe(false);
  });
  it('rejects excess samples or laps instead of silently truncating', () => {
    for (const key of ['records', 'laps'] as const) {
      const first = details[key][0];
      if (!first) throw new Error('Missing fixture');
      expect(
        activityDetailsSchema.safeParse({
          ...details,
          [key]: Array.from({ length: activityDetailLimits[key] + 1 }, (_, index) => ({
            ...first,
            index,
          })),
        }).success,
      ).toBe(false);
    }
  });
  it('rejects invalid timestamps, provenance indices and unreviewed fields such as GPS', () => {
    for (const patch of [
      { schemaVersion: 2 },
      { streamIndex: 128 },
      { sessionIndex: 100 },
      { elapsedSeconds: -1 },
      { recordedAt: 'yesterday' },
      { latitude: 37.5 },
    ]) {
      expect(activityDetailsSchema.safeParse({ ...details, ...patch }).success).toBe(false);
    }
  });
  it('retains legacy command shape and permits details only in v2 files', () => {
    const parsed = importActivitySchema.parse(legacy);
    expect(parsed).toStrictEqual(legacy);
    expect(parsed).not.toHaveProperty('details');
    expect(activityExportSchema.parse({ schemaVersion: 1, imports: [legacy] }).imports).toEqual([
      legacy,
    ]);
    const enriched = { ...legacy, details };
    expect(importActivitySchema.parse(enriched).details).toEqual(details);
    expect(activityExportSchema.safeParse({ schemaVersion: 1, imports: [enriched] }).success).toBe(
      false,
    );
    expect(activityExportSchema.safeParse({ schemaVersion: 2, imports: [legacy] }).success).toBe(
      false,
    );
    expect(activityExportSchema.parse({ schemaVersion: 2, imports: [enriched] }).imports).toEqual([
      enriched,
    ]);
  });
  it('represents unavailable current-revision detail explicitly while retaining source identity', () => {
    const value = {
      activityId: '29d4290e-d100-4fea-bdec-014420292181',
      activityRevision: 2,
      source: legacy.source,
      details: null,
    };
    expect(activityDetailsReadSchema.parse(value)).toStrictEqual(value);
    expect(activityDetailsReadSchema.safeParse({ ...value, details: undefined }).success).toBe(
      false,
    );
    expect(activityDetailsReadSchema.parse({ ...value, details }).details).toEqual(details);
  });
});
