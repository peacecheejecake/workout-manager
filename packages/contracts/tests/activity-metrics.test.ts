import { describe, expect, it } from 'vitest';
import { calculateActivityPace } from '../src/activity-metrics.js';
import { activityValuesSchema } from '../src/activity.js';

const values = activityValuesSchema.parse({
  title: null,
  kind: 'running',
  startedAt: null,
  timezone: null,
  durationSeconds: 1500,
  durationKind: 'timer',
  distanceMeters: 5000,
});
describe('versioned activity duration/distance pace', () => {
  it.each(['timer', 'elapsed', 'moving'] as const)(
    'preserves the %s time basis',
    (durationKind) => {
      expect(calculateActivityPace({ ...values, durationKind })).toEqual({
        state: 'available',
        secondsPerKilometer: 300,
        durationKind,
        definitionVersion: 'activity-duration-distance-pace-v1',
      });
    },
  );
  it.each(['running', 'walking', 'cycling'] as const)('supports %s without rounding', (kind) => {
    expect(
      calculateActivityPace({ ...values, kind, durationSeconds: 300.6, distanceMeters: 1000 }),
    ).toMatchObject({ state: 'available', secondsPerKilometer: 300.6 });
  });
  it.each([
    [{ kind: 'strength' }, 'unsupported_sport'],
    [{ kind: 'other' }, 'unsupported_sport'],
    [{ kind: 'unknown' }, 'unsupported_sport'],
    [{ durationKind: 'unknown' }, 'unknown_duration_kind'],
    [{ durationSeconds: null }, 'missing_duration'],
    [{ distanceMeters: null }, 'missing_distance'],
    [{ durationSeconds: 0 }, 'zero_duration'],
    [{ distanceMeters: 0 }, 'zero_distance'],
    [{ distanceMeters: Number.MIN_VALUE }, 'unrepresentable'],
    [{ durationSeconds: Number.MIN_VALUE, distanceMeters: 1e9 }, 'unrepresentable'],
  ])('keeps unavailable reason for %j', (patch, reason) => {
    const result = calculateActivityPace(activityValuesSchema.parse({ ...values, ...patch }));
    expect(result).toMatchObject({ state: 'unavailable', reason });
    expect(result).not.toHaveProperty('secondsPerKilometer');
  });
  it('keeps independent raw and corrected values without mutating input', () => {
    const original = Object.freeze({ ...values });
    const corrected = Object.freeze({
      ...values,
      durationSeconds: 750,
      durationKind: 'moving' as const,
    });
    expect(calculateActivityPace(original)).toMatchObject({
      secondsPerKilometer: 300,
      durationKind: 'timer',
    });
    expect(calculateActivityPace(corrected)).toMatchObject({
      secondsPerKilometer: 150,
      durationKind: 'moving',
    });
    expect(original).toEqual(values);
  });
});
