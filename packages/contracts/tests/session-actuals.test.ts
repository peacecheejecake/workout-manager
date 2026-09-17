import { describe, expect, it } from 'vitest';
import {
  compareSessionDistance,
  sessionActualSchema,
  sessionActualsQuerySchema,
  sessionActualsSchema,
  type SessionActual,
  type SessionActuals,
} from '../src/session-actuals.js';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const empty = () => ({ value: null, knownCount: 0, missingCount: 0 });
function session(value: number | null = 0, missingCount = 0): SessionActual {
  const knownCount = value === null ? 0 : 1;
  const count = knownCount + missingCount;
  return {
    sessionId: 'session',
    distanceTarget: { minMeters: 10, maxMeters: 10 },
    actual: {
      count,
      distanceMeters: { value, knownCount, missingCount },
      durationSeconds: {
        timer: { value: null, knownCount: 0, missingCount: count },
        elapsed: empty(),
        moving: empty(),
        unknown: empty(),
      },
      sources: { fit: count, fixture: 0, manual: 0 },
      overlayCount: 0,
    },
  };
}
function result(sessions = [session()]): SessionActuals {
  return {
    definitionVersion: 'session-actuals-v1',
    observedAt: '2026-09-17T00:00:00Z',
    planVersion: { id: versionId, version: 1, title: 'Saved' },
    currentPlanVersionId: versionId,
    sessions,
    activityDataRevision: {
      count: sessions.reduce((sum, row) => sum + row.actual.count, 0),
      revisionSum: '8',
    },
    coverage: 'unknown',
  };
}
describe('session actuals boundary', () => {
  it('normalizes only the version query and rejects extra fields and invalid IDs', () => {
    expect(sessionActualsQuerySchema.parse({ planVersionId: versionId.toUpperCase() })).toEqual({
      planVersionId: versionId,
    });
    for (const value of [
      {},
      { planVersionId: 'wrong' },
      { planVersionId: versionId, athleteId: 'foreign' },
    ])
      expect(sessionActualsQuerySchema.safeParse(value).success).toBe(false);
    expect(sessionActualsSchema.safeParse({ ...result(), athleteId: 'foreign' }).success).toBe(
      false,
    );
    expect(sessionActualSchema.safeParse({ ...session(), completion: true }).success).toBe(false);
    expect(
      sessionActualSchema.safeParse({
        ...session(),
        distanceTarget: { minMeters: 0, maxMeters: 1, unit: 'km' },
      }).success,
    ).toBe(false);
    expect(sessionActualsSchema.safeParse({ ...result(), coverage: 'complete' }).success).toBe(
      false,
    );
  });
  it('enforces unique bounded session rows and canonical count coverage', () => {
    expect(sessionActualsSchema.safeParse(result([session(), session()])).success).toBe(false);
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      ...session(null),
      sessionId: String(index),
    }));
    expect(sessionActualsSchema.safeParse(result(rows)).success).toBe(true);
    expect(
      sessionActualsSchema.safeParse(result([...rows, { ...session(null), sessionId: 'extra' }]))
        .success,
    ).toBe(false);
    expect(
      sessionActualsSchema.safeParse({
        ...result(),
        activityDataRevision: { count: 0, revisionSum: '8' },
      }).success,
    ).toBe(false);
    expect(
      sessionActualsSchema.safeParse({
        ...result(),
        activityDataRevision: { count: 3, revisionSum: '08' },
      }).success,
    ).toBe(false);
    expect(sessionActualsSchema.safeParse(result([])).success).toBe(true);
  });
  it('rejects inconsistent metric, duration, source and overlay counts', () => {
    const value = session();
    const malformed = [
      { ...value.actual, distanceMeters: { value: 0, knownCount: 0, missingCount: 1 } },
      { ...value.actual, distanceMeters: { value: null, knownCount: 1, missingCount: 0 } },
      { ...value.actual, distanceMeters: { value: 0, knownCount: 2, missingCount: 0 } },
      { ...value.actual, durationSeconds: { ...value.actual.durationSeconds, timer: empty() } },
      { ...value.actual, sources: { fit: 2, fixture: 0, manual: 0 } },
      { ...value.actual, overlayCount: 2 },
    ];
    for (const actual of malformed)
      expect(sessionActualSchema.safeParse({ ...value, actual }).success).toBe(false);
  });
  it('rejects nonfinite observations and invalid target ranges', () => {
    for (const number of [NaN, Infinity, -Infinity, -1])
      expect(sessionActualSchema.safeParse(session(number)).success).toBe(false);
    for (const distanceTarget of [
      { minMeters: 2, maxMeters: 1 },
      { minMeters: -1, maxMeters: 1 },
      { minMeters: 0, maxMeters: Infinity },
    ])
      expect(sessionActualSchema.safeParse({ ...session(), distanceTarget }).success).toBe(false);
  });
});
describe('explicit saved distance comparison', () => {
  it.each([
    [null, 0, 'no_linked_activities'],
    [null, 1, 'missing_actual'],
    [0, 1, 'partial_actual'],
  ] as const)('distinguishes value %s and missing count %s', (value, missing, status) => {
    const parsed = sessionActualSchema.parse(session(value, missing));
    expect(compareSessionDistance(parsed)).toEqual({ status });
  });
  it('keeps known zero and missing targets distinct', () => {
    expect(compareSessionDistance(session())).toEqual({ status: 'exact', deltaMeters: -10 });
    expect(compareSessionDistance({ ...session(), distanceTarget: null })).toEqual({
      status: 'missing_target',
    });
  });
  it.each([
    [5, 'below', -5],
    [10, 'within', 0],
    [15, 'within', 0],
    [20, 'within', 0],
    [25, 'above', 5],
  ] as const)(
    'compares %s against both inclusive bounds',
    (actual, position, distanceToRangeMeters) => {
      expect(
        compareSessionDistance({
          ...session(actual),
          distanceTarget: { minMeters: 10, maxMeters: 20 },
        }),
      ).toEqual({ status: 'range', position, distanceToRangeMeters });
    },
  );
  it('handles equal boundaries and finite fractional deltas without rounding the raw result', () => {
    const value = sessionActualSchema.parse({
      ...session(10.3),
      distanceTarget: { minMeters: 10.1, maxMeters: 10.1 },
    });
    const comparison = compareSessionDistance(value);
    expect(comparison.status).toBe('exact');
    if (comparison.status !== 'exact') throw new Error('Expected exact comparison');
    expect(comparison.deltaMeters).toBeCloseTo(0.2);
    expect(Number.isFinite(comparison.deltaMeters)).toBe(true);
    expect(
      compareSessionDistance({ ...session(0), distanceTarget: { minMeters: 0, maxMeters: 0 } }),
    ).toEqual({ status: 'exact', deltaMeters: 0 });
  });
});
