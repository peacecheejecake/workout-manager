import { describe, expect, it } from 'vitest';
import {
  distanceRangeSchema,
  durationRangeSchema,
  planDraftSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  sessionDistanceBounds,
  sessionDurationBounds,
  sumTargetQuantities,
} from '../src/planning.js';
import { dashboardPlannedSchema, plannedTargetMetricSchema } from '../src/dashboard.js';
import { activityDistanceComparisonSchema } from '../src/activity-context.js';
import { evaluatePlanConstraints } from '../src/planning-constraints.js';

const legacy = planDraftSchema.parse({
  title: 'Synthetic attendance',
  timezone: 'UTC',
  periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
    id: level,
    parentId: index ? levels[index - 1] : null,
    level,
    title: level,
    startDate: '2080-01-01',
    endDateExclusive: '2080-02-01',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [
    {
      id: 'run',
      blockId: 'block',
      date: '2080-01-05',
      localStartTime: null,
      title: 'Synthetic run',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: 0,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    },
  ],
});

const ranged = {
  ...legacy,
  sessions: legacy.sessions.map((session) => ({
    ...session,
    distanceMeters: null,
    distanceRange: { minMeters: 0, maxMeters: 1000.25 },
    durationRange: { minSeconds: 60.125, maxSeconds: 120.25 },
  })),
};
describe('S05 distance/time target ranges', () => {
  it('sums canonical decimal bounds without a floating-point false capacity conflict', () => {
    expect(sumTargetQuantities([0.1, 0.2])).toBe(0.3);
    expect(sumTargetQuantities([1e-7, 2e-7])).toBe(3e-7);
    expect(sumTargetQuantities([Number.MIN_VALUE, Number.MIN_VALUE])).toBe(1e-323);
    expect(sumTargetQuantities([1e21, 1e21])).toBe(2e21);
    const plan = {
      ...ranged,
      periods: ranged.periods.map((p) => ({
        ...p,
        constraints: {
          unavailableDates: [],
          dailyTimeLimits: [{ date: '2080-01-05', availableSeconds: 2 }],
        },
      })),
      sessions: Array.from({ length: 20 }, (_, index) => ({
        ...ranged.sessions[0],
        id: `decimal-${index}`,
        durationRange: { minSeconds: 0.1, maxSeconds: 0.1 },
      })),
    };
    expect(evaluatePlanConstraints(planDraftSchema.parse(plan))[0]).toMatchObject({
      durationRangeSeconds: { min: 2, max: 2 },
      status: 'no_conflict',
      exceedsAvailableTime: false,
    });
    for (const value of [-1, NaN, Infinity]) expect(() => sumTargetQuantities([value])).toThrow();
  });
  it('preserves absent/null/range and zero/fractional values in immutable snapshots', () => {
    for (const draft of [
      legacy,
      ranged,
      {
        ...legacy,
        sessions: legacy.sessions.map((s) => ({ ...s, distanceRange: null, durationRange: null })),
      },
    ]) {
      const snapshot = { id: 'one', version: 1, createdAt: '2026-09-17T00:00:00Z', draft };
      expect(planSnapshotSchema.parse(snapshot)).toStrictEqual(snapshot);
    }
    expect(legacy.sessions[0]).not.toHaveProperty('durationRange');
    expect(legacy.sessions[0]).not.toHaveProperty('distanceRange');
    const [old] = legacy.sessions,
      [range] = ranged.sessions;
    if (!old || !range) throw new Error('Missing synthetic session');
    expect(sessionDistanceBounds(old)).toEqual({ min: 0, max: 0 });
    expect(sessionDurationBounds(old)).toBeNull();
    expect(sessionDistanceBounds(range)).toEqual({ min: 0, max: 1000.25 });
    expect(sessionDurationBounds(range)).toEqual({ min: 60.125, max: 120.25 });
  });

  it('rejects ambiguous scalar/range combinations and malformed or unbounded ranges', () => {
    for (const patch of [{ durationSeconds: 0 }, { distanceMeters: 0 }])
      expect(
        planDraftSchema.safeParse({
          ...ranged,
          sessions: ranged.sessions.map((s) => ({ ...s, ...patch })),
        }).success,
      ).toBe(false);
    for (const invalid of [-1, NaN, Infinity, '1', null]) {
      expect(durationRangeSchema.safeParse({ minSeconds: invalid, maxSeconds: 100 }).success).toBe(
        false,
      );
      expect(distanceRangeSchema.safeParse({ minMeters: 0, maxMeters: invalid }).success).toBe(
        false,
      );
    }
    for (const value of [
      { minSeconds: 2, maxSeconds: 1 },
      { minSeconds: 0 },
      { minSeconds: 0, maxSeconds: 604801 },
      { minSeconds: 0, maxSeconds: 1, extra: 0 },
    ])
      expect(durationRangeSchema.safeParse(value).success).toBe(false);
    expect(distanceRangeSchema.safeParse({ minMeters: 0, maxMeters: 10000001 }).success).toBe(
      false,
    );
    expect(durationRangeSchema.parse({ minSeconds: 0, maxSeconds: 604800 })).toEqual({
      minSeconds: 0,
      maxSeconds: 604800,
    });
  });

  it('requires a separate intensity unlock for changes to either range or its representation', () => {
    const locked = {
      ...ranged,
      sessions: ranged.sessions.map((s) => ({ ...s, locks: { ...s.locks, intensity: true } })),
    };
    for (const patch of [
      { durationRange: { minSeconds: 60, maxSeconds: 120.25 } },
      { durationRange: { minSeconds: 60.125, maxSeconds: 121 } },
      { distanceRange: { minMeters: 1, maxMeters: 1000.25 } },
      { distanceRange: { minMeters: 0, maxMeters: 1001 } },
      { durationRange: null },
      { distanceRange: null },
      { durationRange: null, durationSeconds: 60 },
    ]) {
      const next = { ...ranged, sessions: ranged.sessions.map((s) => ({ ...s, ...patch })) };
      expect(preservesSessionLocks(locked, next)).toBe(false);
      expect(preservesSessionLocks(ranged, next)).toBe(true);
    }
    expect(preservesSessionLocks(locked, ranged)).toBe(true);
    const order = {
      ...locked,
      sessions: locked.sessions.map((s) => ({
        ...s,
        durationRange: { maxSeconds: 120.25, minSeconds: 60.125 },
      })),
    };
    expect(preservesSessionLocks(locked, order)).toBe(true);
  });

  it('distinguishes guaranteed excess, possible excess, zero and unknown without counting steps', () => {
    const constrained = (availableSeconds: number) => ({
      ...ranged,
      periods: ranged.periods.map((p) =>
        p.id === 'block'
          ? {
              ...p,
              constraints: {
                unavailableDates: [],
                dailyTimeLimits: [{ date: '2080-01-05', availableSeconds }],
              },
            }
          : p,
      ),
    });
    expect(evaluatePlanConstraints(constrained(60))[0]).toMatchObject({
      status: 'conflict',
      exceedsAvailableTime: true,
      possibleTimeExcess: false,
    });
    expect(evaluatePlanConstraints(constrained(100))[0]).toMatchObject({
      status: 'unknown',
      exceedsAvailableTime: false,
      possibleTimeExcess: true,
      durationRangeSeconds: { min: 60.125, max: 120.25 },
      rangeDurationSessionIds: ['run'],
      unknownDurationSessionIds: [],
    });
    expect(evaluatePlanConstraints(constrained(121))[0]).toMatchObject({
      status: 'no_conflict',
      possibleTimeExcess: false,
    });
    const mixed = {
      ...constrained(121),
      sessions: [...ranged.sessions, ...legacy.sessions.map((s) => ({ ...s, id: 'unknown' }))],
    };
    expect(evaluatePlanConstraints(mixed)[0]).toMatchObject({
      status: 'unknown',
      unknownDurationSessionIds: ['unknown'],
    });
    const zero = {
      ...constrained(0),
      sessions: ranged.sessions.map((s) => ({
        ...s,
        durationRange: { minSeconds: 0, maxSeconds: 0 },
      })),
    };
    expect(evaluatePlanConstraints(zero)[0]).toMatchObject({
      status: 'no_conflict',
      durationRangeSeconds: { min: 0, max: 0 },
      rangeDurationSessionIds: ['run'],
    });
  });

  it('validates additive range aggregate counts and keeps legacy aggregate contracts usable', () => {
    const exact = { value: 10, knownCount: 1, missingCount: 2 };
    const target = { min: 20, max: 40, knownCount: 2, missingCount: 1, rangeCount: 1 };
    const old = { count: 3, distanceMeters: exact, durationSeconds: exact };
    expect(dashboardPlannedSchema.parse(old)).toStrictEqual(old);
    const aggregate = {
      ...old,
      targets: {
        definitionVersion: 'planned-targets-v1',
        distanceMeters: target,
        durationSeconds: target,
      },
    };
    expect(dashboardPlannedSchema.parse(aggregate)).toStrictEqual(aggregate);
    for (const patch of [{ min: null }, { max: 19 }, { rangeCount: 3 }, { knownCount: 0 }])
      expect(plannedTargetMetricSchema.safeParse({ ...target, ...patch }).success).toBe(false);
    expect(
      dashboardPlannedSchema.safeParse({
        ...aggregate,
        targets: { ...aggregate.targets, distanceMeters: { ...target, rangeCount: 0 } },
      }).success,
    ).toBe(false);
    expect(
      plannedTargetMetricSchema.parse({
        min: 0,
        max: 0,
        knownCount: 1,
        missingCount: 0,
        rangeCount: 1,
      }),
    ).toMatchObject({ min: 0, max: 0 });
  });

  it('compares distance to both inclusive bounds without inventing a scalar delta', () => {
    for (const [actual, rangePosition] of [
      [0, 'below'],
      [10, 'within'],
      [20, 'within'],
      [21, 'above'],
      [null, 'unknown'],
    ] as const) {
      const value = {
        actual,
        planned: null,
        plannedRange: { minMeters: 10, maxMeters: 20 },
        delta: null,
        rangePosition,
        status: actual === null ? 'range_missing_actual' : 'range_available',
      };
      expect(activityDistanceComparisonSchema.parse(value)).toStrictEqual(value);
      expect(activityDistanceComparisonSchema.safeParse({ ...value, delta: 0 }).success).toBe(
        false,
      );
      expect(activityDistanceComparisonSchema.safeParse({ ...value, planned: 15 }).success).toBe(
        false,
      );
      expect(
        activityDistanceComparisonSchema.safeParse({
          ...value,
          rangePosition: actual === null ? 'within' : 'unknown',
        }).success,
      ).toBe(false);
    }
  });
});
