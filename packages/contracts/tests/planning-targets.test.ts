import { describe, expect, it } from 'vitest';
import {
  heartRateTargetSchema,
  manualPlanCommandSchema,
  paceTargetSchema,
  planDraftSchema,
  plannedSessionSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  type PlannedSession,
} from '../src/planning.js';

const session: PlannedSession = {
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
  locks: { date: false, time: false, intensity: true },
  steps: [],
};
const draft = planDraftSchema.parse({
  title: 'Synthetic targets',
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
  sessions: [session],
});
const targets = {
  paceTarget: { minSecondsPerKm: 240.125, maxSecondsPerKm: 300.25 },
  heartRateTarget: { minBpm: 120, maxBpm: 140 },
};

describe('S06 user-entered session targets', () => {
  it('preserves legacy absence, explicit null, fractional pace and independent zero/null fields', () => {
    for (const patch of [{}, { paceTarget: null, heartRateTarget: null }, targets]) {
      const value = { ...session, ...patch };
      expect(plannedSessionSchema.parse(value)).toStrictEqual(value);
      const plan = { ...draft, sessions: [value] };
      const command = {
        source: 'manual',
        confirmed: true,
        expectedVersionId: null,
        idempotencyKey: 'targets-command',
        draft: plan,
      };
      expect(manualPlanCommandSchema.parse(command)).toStrictEqual(command);
      const snapshot = { id: 'saved', version: 1, createdAt: '2026-09-17T00:00:00Z', draft: plan };
      expect(planSnapshotSchema.parse(snapshot)).toStrictEqual(snapshot);
    }
    expect(plannedSessionSchema.parse(session)).not.toHaveProperty('paceTarget');
    expect(plannedSessionSchema.parse(session)).not.toHaveProperty('heartRateTarget');
  });

  it('accepts exact single targets and technical boundaries without assigning a recommendation', () => {
    for (const value of [Number.MIN_VALUE, 1, 300.125, 86400])
      expect(paceTargetSchema.parse({ minSecondsPerKm: value, maxSecondsPerKm: value })).toEqual({
        minSecondsPerKm: value,
        maxSecondsPerKm: value,
      });
    for (const value of [1, 120, 1000])
      expect(heartRateTargetSchema.parse({ minBpm: value, maxBpm: value })).toEqual({
        minBpm: value,
        maxBpm: value,
      });
  });

  it('rejects partial, reversed, unknown, non-finite, zero and out-of-range targets', () => {
    for (const value of [
      {},
      { minSecondsPerKm: 240 },
      { maxSecondsPerKm: 300 },
      { minSecondsPerKm: 300, maxSecondsPerKm: 240 },
      { ...targets.paceTarget, unit: 'minutes_per_km' },
      ...[0, -1, 86400.1, NaN, Infinity, -Infinity, '300', null].map((value) => ({
        minSecondsPerKm: value,
        maxSecondsPerKm: 86400,
      })),
    ])
      expect(paceTargetSchema.safeParse(value).success).toBe(false);
    for (const value of [
      {},
      { minBpm: 120 },
      { maxBpm: 140 },
      { minBpm: 140, maxBpm: 120 },
      { ...targets.heartRateTarget, observed: true },
      ...[0, -1, 120.5, 1001, NaN, Infinity, '120', null].map((value) => ({
        minBpm: value,
        maxBpm: 1000,
      })),
    ])
      expect(heartRateTargetSchema.safeParse(value).success).toBe(false);
    expect(plannedSessionSchema.safeParse({ ...session, paceTarget: 300 }).success).toBe(false);
    expect(plannedSessionSchema.safeParse({ ...session, heartRateTarget: 120 }).success).toBe(
      false,
    );
  });

  it('protects each target under the saved intensity lock, including clearing and simultaneous unlock', () => {
    const before = { ...draft, sessions: [{ ...session, ...targets }] };
    for (const patch of [
      { paceTarget: { ...targets.paceTarget, minSecondsPerKm: 250 } },
      { paceTarget: { ...targets.paceTarget, maxSecondsPerKm: 310 } },
      { heartRateTarget: { ...targets.heartRateTarget, minBpm: 125 } },
      { heartRateTarget: { ...targets.heartRateTarget, maxBpm: 145 } },
      { paceTarget: null },
      { heartRateTarget: null },
      { paceTarget: undefined },
      { heartRateTarget: undefined },
    ]) {
      const next = {
        ...draft,
        sessions: [
          { ...session, ...targets, ...patch, locks: { ...session.locks, intensity: false } },
        ],
      };
      expect(preservesSessionLocks(before, next)).toBe(false);
    }
    const unlock = {
      ...draft,
      sessions: [{ ...session, ...targets, locks: { ...session.locks, intensity: false } }],
    };
    expect(preservesSessionLocks(before, unlock)).toBe(true);
    expect(
      preservesSessionLocks(unlock, {
        ...draft,
        sessions: [
          {
            ...session,
            locks: { ...session.locks, intensity: false },
            paceTarget: null,
            heartRateTarget: null,
          },
        ],
      }),
    ).toBe(true);
  });

  it('normalizes missing/null only for locks and ignores object key insertion order', () => {
    const empty = { ...draft, sessions: [{ ...session, paceTarget: null, heartRateTarget: null }] };
    expect(preservesSessionLocks(draft, empty)).toBe(true);
    expect(preservesSessionLocks(empty, draft)).toBe(true);
    const before = { ...draft, sessions: [{ ...session, ...targets }] };
    const reordered = {
      ...draft,
      sessions: [
        {
          ...session,
          paceTarget: { maxSecondsPerKm: 300.25, minSecondsPerKm: 240.125 },
          heartRateTarget: { maxBpm: 140, minBpm: 120 },
        },
      ],
    };
    expect(preservesSessionLocks(before, reordered)).toBe(true);
    expect(preservesSessionLocks(draft, before)).toBe(false);
    expect(preservesSessionLocks(before, draft)).toBe(false);
  });
});
