import { describe, expect, it } from 'vitest';
import {
  planDraftSchema,
  plannedSessionSchema,
  planSnapshotSchema,
  preservesSessionLocks,
} from '../src/planning.js';

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
const locked = {
  ...legacy,
  sessions: legacy.sessions.map((session) => ({
    ...session,
    locks: { ...session.locks, attendance: true },
  })),
};

describe('S06 attendance locks protect session presence only', () => {
  it('preserves absence, false and true without defaulting historical snapshots', () => {
    for (const patch of [{}, { attendance: false }, { attendance: true }]) {
      const draft = {
        ...legacy,
        sessions: legacy.sessions.map((session) => ({
          ...session,
          locks: { ...session.locks, ...patch },
        })),
      };
      const snapshot = { id: 'snapshot', version: 1, createdAt: '2026-09-17T00:00:00Z', draft };
      expect(planSnapshotSchema.parse(snapshot)).toStrictEqual(snapshot);
    }
    expect(legacy.sessions[0]?.locks).not.toHaveProperty('attendance');
    for (const attendance of [null, 0, 1, 'true', [], {}]) {
      const session = legacy.sessions[0];
      expect(
        plannedSessionSchema.safeParse({ ...session, locks: { ...session?.locks, attendance } })
          .success,
      ).toBe(false);
    }
  });

  it('requires a separately saved unlock before removal and rejects replacement by another id', () => {
    const deleted = { ...legacy, sessions: [] };
    expect(preservesSessionLocks(legacy, deleted)).toBe(true);
    expect(preservesSessionLocks(locked, deleted)).toBe(false);
    const unlocked = {
      ...locked,
      sessions: locked.sessions.map((session) => ({
        ...session,
        locks: { ...session.locks, attendance: false },
      })),
    };
    expect(preservesSessionLocks(locked, unlocked)).toBe(true);
    expect(preservesSessionLocks(unlocked, deleted)).toBe(true);
    expect(
      preservesSessionLocks(locked, {
        ...unlocked,
        sessions: unlocked.sessions.map((session) => ({ ...session, id: 'replacement' })),
      }),
    ).toBe(false);
  });

  it('allows schedule, timezone and content edits with attendance alone', () => {
    const changed = {
      ...locked,
      timezone: 'Asia/Seoul',
      periods: locked.periods.map((period) => ({
        ...period,
        timezone: 'Asia/Seoul',
        id: period.id === 'block' ? 'new-block' : period.id,
      })),
      sessions: locked.sessions.map((session) => ({
        ...session,
        blockId: 'new-block',
        date: '2080-01-06',
        localStartTime: '09:30',
        title: 'Changed',
        sport: 'cycling' as const,
        targetRpe: 4,
        durationSeconds: 60,
        distanceMeters: 1000,
        paceTarget: { minSecondsPerKm: 300, maxSecondsPerKm: 360 },
        heartRateTarget: { minBpm: 120, maxBpm: 150 },
        notes: 'Edited',
      })),
    };
    expect(planDraftSchema.safeParse(changed).success).toBe(true);
    expect(preservesSessionLocks(locked, changed)).toBe(true);
  });

  it('keeps every existing lock deletion restriction when attendance is missing or false', () => {
    for (const key of ['date', 'time', 'intensity'] as const) {
      for (const patch of [{}, { attendance: false }]) {
        const before = {
          ...legacy,
          sessions: legacy.sessions.map((session) => ({
            ...session,
            locks: { ...session.locks, ...patch, [key]: true },
          })),
        };
        expect(preservesSessionLocks(before, { ...legacy, sessions: [] })).toBe(false);
      }
    }
  });
});
