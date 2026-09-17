import { describe, expect, it } from 'vitest';
import {
  periodSummaryQuerySchema,
  periodSummarySchema,
  type PeriodSummary,
} from '../src/period-summary.js';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(): PeriodSummary {
  const unknown = { value: null, knownCount: 0, missingCount: 0 };
  return {
    definitionVersion: 'period-summary-v1',
    observedAt: '2026-09-17T00:00:00Z',
    planVersion: { id: versionId, version: 1, title: 'Plan' },
    currentPlanVersionId: versionId,
    period: {
      id: 'block',
      parentId: 'phase',
      level: 'block',
      title: 'Period',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-11',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    },
    planned: {
      count: 1,
      distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
      durationSeconds: { ...unknown, missingCount: 1 },
    },
    keySessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-09-01',
        localStartTime: null,
        title: 'High priority',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'high',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
    actual: {
      status: 'available',
      totals: {
        count: 1,
        distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
        durationSeconds: {
          timer: { ...unknown, missingCount: 1 },
          elapsed: unknown,
          moving: unknown,
          unknown,
        },
        sources: { manual: 1, fit: 0, fixture: 0 },
        overlayCount: 0,
      },
    },
    dataRevision: { activities: { count: 2, revisionSum: '3' } },
    unplacedActivityCount: 1,
    coverage: 'unknown',
  };
}
describe('S04 version-bound period summary', () => {
  it('bounds and normalizes version identity while rejecting ambiguous query ownership', () => {
    expect(
      periodSummaryQuerySchema.parse({ planVersionId: versionId.toUpperCase(), periodId: 'block' }),
    ).toEqual({ planVersionId: versionId, periodId: 'block' });
    for (const value of [
      { planVersionId: 'not-uuid', periodId: 'block' },
      { planVersionId: versionId, periodId: ' ' },
      { planVersionId: versionId, periodId: 'x'.repeat(201) },
      { planVersionId: versionId, periodId: 'block', athleteId: 'other' },
    ])
      expect(periodSummaryQuerySchema.safeParse(value).success).toBe(false);
  });
  it('keeps zero and missing plan/actual quantities separate with source definitions and observation identity', () => {
    const value = fixture();
    expect(periodSummarySchema.parse(value)).toStrictEqual(value);
    expect(periodSummarySchema.parse(value).period).not.toHaveProperty('constraints');
    expect(value.planned.distanceMeters.value).toBe(0);
    expect(value.planned.durationSeconds.value).toBeNull();
  });
  it('allows an old immutable plan with a different current head without pretending actuals are historical', () => {
    const value = fixture();
    value.currentPlanVersionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(periodSummarySchema.parse(value)).toEqual(value);
  });
  it('rejects invented coverage, inconsistent counts and zero substituted for unknown metrics', () => {
    const value = fixture();
    expect(periodSummarySchema.safeParse({ ...value, coverage: 'complete' }).success).toBe(false);
    expect(
      periodSummarySchema.safeParse({
        ...value,
        dataRevision: { activities: { count: 1, revisionSum: '3' } },
      }).success,
    ).toBe(false);
    expect(
      periodSummarySchema.safeParse({
        ...value,
        planned: {
          ...value.planned,
          durationSeconds: { value: 0, knownCount: 0, missingCount: 1 },
        },
      }).success,
    ).toBe(false);
    expect(
      periodSummarySchema.safeParse({
        ...value,
        dataRevision: { activities: { count: 2, revisionSum: '-1' } },
      }).success,
    ).toBe(false);
  });
  it('requires unique explicitly high priority key sessions inside the selected block and half-open dates', () => {
    const value = fixture(),
      session = value.keySessions[0];
    if (!session) throw new Error('Fixture session');
    for (const change of [
      { priority: 'normal' },
      { blockId: 'elsewhere' },
      { date: '2026-08-31' },
      { date: '2026-09-11' },
    ])
      expect(
        periodSummarySchema.safeParse({ ...value, keySessions: [{ ...session, ...change }] })
          .success,
      ).toBe(false);
    expect(
      periodSummarySchema.safeParse({ ...value, keySessions: [session, session] }).success,
    ).toBe(false);
  });
  it('marks astronomical year-zero actual aggregation unavailable while keeping the original planned period', () => {
    const value = fixture();
    value.period = { ...value.period, startDate: '0000-01-01', endDateExclusive: '0001-01-01' };
    value.keySessions = [];
    expect(periodSummarySchema.safeParse(value).success).toBe(false);
    value.actual = { status: 'unavailable', reason: 'unsupported_calendar' };
    expect(periodSummarySchema.parse(value).period.startDate).toBe('0000-01-01');
    expect(periodSummarySchema.safeParse({ ...fixture(), actual: value.actual }).success).toBe(
      false,
    );
  });
});
