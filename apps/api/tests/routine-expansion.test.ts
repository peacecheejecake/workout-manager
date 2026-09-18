import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RoutineScheduleVersion } from '@workout/contracts/routines';
import {
  expandRoutineSchedule,
  resolveLocalTime,
  RoutineExpansionError,
} from '@workout/server-persistence/routine-expansion';

function schedule(
  rule: RoutineScheduleVersion['rule'],
  maxOccurrences = 5,
): RoutineScheduleVersion {
  return {
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: randomUUID(), versionId: randomUUID() },
    window: {
      startDate: '2026-11-01',
      endDateExclusive: '2026-11-08',
      timezone: 'America/New_York',
      maxOccurrences,
    },
    rule,
    state: 'draft',
  };
}

describe('finite generic routine expansion', () => {
  it('keeps ambiguous DST anchors unresolved instead of inventing one instant', () => {
    expect(resolveLocalTime('2026-11-01', '01:30', 'America/New_York')).toBeNull();
    expect(resolveLocalTime('2026-11-02', '07:30', 'America/New_York')).toBe(
      '2026-11-02T12:30:00.000Z',
    );
    const input = schedule({ kind: 'dates', dates: ['2026-11-01'], localTime: '01:30' });
    const [unresolved] = expandRoutineSchedule(input, null);
    expect(unresolved).toMatchObject({ scheduledAt: null, timingStatus: 'unresolved' });
    expect(expandRoutineSchedule(input, null)).toEqual([unresolved]);
  });

  it('caps recurrence, rejects outside windows and has stable distinct occurrence IDs', () => {
    const weekly = schedule({ kind: 'weekdays', weekdays: [1, 3], localTime: '08:00' });
    const expanded = expandRoutineSchedule(weekly, null);
    expect(expanded.map((item) => item.anchorKey)).toEqual(['2026-11-02', '2026-11-04']);
    expect(new Set(expanded.map((item) => item.id)).size).toBe(2);
    expect(() =>
      expandRoutineSchedule(
        schedule({ kind: 'weekdays', weekdays: [1, 3], localTime: null }, 1),
        null,
      ),
    ).toThrowError(RoutineExpansionError);
    expect(() =>
      expandRoutineSchedule(
        schedule({ kind: 'dates', dates: ['2026-11-08'], localTime: null }),
        null,
      ),
    ).toThrow();
  });

  it('preserves missing session end time as an unresolved anchor', () => {
    const input = schedule({
      kind: 'session_links',
      sessionIds: ['session-1'],
      point: 'end',
      offsetMinutes: 10,
    });
    const plan = {
      timezone: 'America/New_York',
      title: 'Test',
      periods: [],
      sessions: [
        { id: 'session-1', date: '2026-11-02', localStartTime: '08:00', durationSeconds: null },
      ],
    };
    const [occurrence] = expandRoutineSchedule(input, plan);
    expect(occurrence).toMatchObject({ anchorKey: 'session-1:end', timingStatus: 'unresolved' });
  });
});
