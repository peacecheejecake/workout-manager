import { describe, expect, it } from 'vitest';
import {
  manualPlanCommandSchema,
  planDraftSchema,
  plannedSessionSchema,
  planSnapshotSchema,
  projectPlan,
  preservesSessionLocks,
  type PlanDraft,
  type PlannedSession,
} from '../src/planning.js';
function draft(): PlanDraft {
  return {
    title: 'Spring',
    timezone: 'America/New_York',
    periods: [
      {
        id: 'season',
        parentId: null,
        level: 'season',
        title: 'Season',
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'America/New_York',
        intent: 'Build',
        isPartial: false,
      },
      {
        id: 'wave',
        parentId: 'season',
        level: 'wave',
        title: 'Wave',
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'America/New_York',
        intent: 'Build',
        isPartial: false,
      },
      {
        id: 'phase',
        parentId: 'wave',
        level: 'phase',
        title: 'Phase',
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'America/New_York',
        intent: 'Build',
        isPartial: false,
      },
      {
        id: 'block',
        parentId: 'phase',
        level: 'block',
        title: '10 days',
        startDate: '2026-03-01',
        endDateExclusive: '2026-03-11',
        timezone: 'America/New_York',
        intent: 'Build',
        isPartial: false,
      },
      {
        id: 'block2',
        parentId: 'phase',
        level: 'block',
        title: 'Variable block',
        startDate: '2026-03-11',
        endDateExclusive: '2026-04-01',
        timezone: 'America/New_York',
        intent: 'Build',
        isPartial: false,
      },
    ],
    sessions: [],
  };
}
function session(): PlannedSession {
  return {
    id: 'session',
    blockId: 'block',
    date: '2026-03-08',
    localStartTime: null,
    title: 'Run',
    sport: 'running',
    durationSeconds: null,
    distanceMeters: 0,
    targetRpe: null,
    purpose: 'Easy',
    notes: '',
    priority: 'normal',
    locks: { date: false, time: false, intensity: false },
    steps: [],
  };
}
describe('M1-02 planned snapshots V2-A07..11', () => {
  it('preserves missing legacy intensity labels without changing historical command JSON', () => {
    const value = draft();
    value.sessions = [session()];
    const command = {
      source: 'manual',
      confirmed: true,
      expectedVersionId: null,
      draft: value,
      idempotencyKey: 'legacy-save-0001',
    };
    expect(manualPlanCommandSchema.parse(command)).toStrictEqual(command);
    const snapshot = {
      id: 'legacy-v1',
      version: 1,
      createdAt: '2026-03-01T00:00:00.000Z',
      draft: value,
    };
    expect(planSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(planSnapshotSchema.parse(snapshot).draft.sessions[0]).not.toHaveProperty(
      'intensityLabel',
    );
  });
  it.each(['A', 'B', 'C', null] as const)(
    'accepts independent intensity label %s without inferring numeric targets',
    (intensityLabel) => {
      const original = { ...session(), durationSeconds: 0, targetRpe: 0 };
      const parsed = plannedSessionSchema.parse({ ...original, intensityLabel });
      expect(parsed).toEqual({ ...original, intensityLabel });
    },
  );
  it.each(['D', 'a', '', ' A ', 0, {}, ['A']])('rejects invalid label %j', (intensityLabel) => {
    expect(plannedSessionSchema.safeParse({ ...session(), intensityLabel }).success).toBe(false);
  });
  it('protects labels using the saved intensity lock and treats missing/null as unspecified', () => {
    const previous = draft();
    previous.sessions = [{ ...session(), locks: { date: false, time: false, intensity: true } }];
    const unspecified = structuredClone(previous);
    unspecified.sessions = unspecified.sessions.map((item) => ({ ...item, intensityLabel: null }));
    expect(preservesSessionLocks(previous, unspecified)).toBe(true);
    expect(preservesSessionLocks(unspecified, previous)).toBe(true);
    const labelled = structuredClone(previous);
    labelled.sessions = labelled.sessions.map((item) => ({ ...item, intensityLabel: 'A' }));
    expect(preservesSessionLocks(previous, labelled)).toBe(false);
    for (const intensityLabel of ['B', 'C', null, undefined] as const) {
      const next = structuredClone(labelled);
      next.sessions = next.sessions.map((item) => ({
        ...item,
        intensityLabel,
        locks: { ...item.locks, intensity: false },
      }));
      expect(preservesSessionLocks(labelled, next)).toBe(false);
    }
    const unlocked = structuredClone(labelled);
    unlocked.sessions = unlocked.sessions.map((item) => ({
      ...item,
      locks: { ...item.locks, intensity: false },
    }));
    expect(preservesSessionLocks(labelled, unlocked)).toBe(true);
    const changed = structuredClone(unlocked);
    changed.sessions = changed.sessions.map((item) => ({ ...item, intensityLabel: 'B' }));
    expect(preservesSessionLocks(unlocked, changed)).toBe(true);
  });
  it('accepts variable blocks, explicit partial status and null distinct from zero', () => {
    const value = draft();
    value.sessions = [session()];
    expect(planDraftSchema.parse(value)).toEqual(value);
  });
  it('rejects sibling overlap, missing level parents and parent overflow', () => {
    for (const patch of [
      { parentId: 'season' },
      { startDate: '2026-02-28' },
      { endDateExclusive: '2026-04-02' },
    ]) {
      const value = draft();
      value.periods = value.periods.map((period) =>
        period.id === 'block' ? { ...period, ...patch } : period,
      );
      expect(planDraftSchema.safeParse(value).success).toBe(false);
    }
    const value = draft();
    value.periods.push(
      ...value.periods
        .filter((period) => period.id === 'block')
        .map((period) => ({ ...period, id: 'duplicate-sibling' })),
    );
    expect(planDraftSchema.safeParse(value).success).toBe(false);
  });
  it('does not silently expand shortened periods or move out-of-block sessions', () => {
    const value = draft();
    value.sessions = [{ ...session(), date: '2026-03-11' }];
    expect(planDraftSchema.safeParse(value).success).toBe(false);
  });
  it('rejects duplicate session IDs and unconstrained plan ranges', () => {
    const value = draft();
    value.sessions = [session(), session()];
    expect(planDraftSchema.safeParse(value).success).toBe(false);
    const long = draft();
    long.periods = long.periods.map((period) => ({ ...period, endDateExclusive: '2040-01-01' }));
    expect(planDraftSchema.safeParse(long).success).toBe(false);
  });
  it('projects rolling across two blocks and DST without duplicating sessions or producing actuals', () => {
    const value = draft();
    value.sessions = [
      session(),
      { ...session(), id: 'second', blockId: 'block2', date: '2026-03-12' },
    ];
    const result = projectPlan(value, { kind: 'rolling', anchorDate: '2026-03-12', days: 10 });
    expect(result).toHaveLength(10);
    expect(result[0]?.date).toBe('2026-03-03');
    expect(result.at(-1)?.date).toBe('2026-03-12');
    expect(new Set(result.map((day) => day.blockId))).toEqual(new Set(['block', 'block2']));
    expect(result.flatMap((day) => day.plannedSessionIds)).toEqual(['session', 'second']);
    expect(result.every((day) => day.activityIds.length === 0 && !day.knownRest)).toBe(true);
  });
  it('calendar ranges are independent of block length and allow multiple sessions per day', () => {
    const value = draft();
    value.sessions = [
      { ...session(), id: 'b', localStartTime: '10:00' },
      { ...session(), id: 'a', localStartTime: '08:00' },
    ];
    const days = projectPlan(value, {
      kind: 'calendar',
      from: '2026-03-02',
      toExclusive: '2026-03-09',
    });
    expect(days).toHaveLength(7);
    expect(days.at(-1)?.plannedSessionIds).toEqual(['a', 'b']);
  });
  it('rejects AI or unconfirmed input on manual save path', () => {
    const command = {
      source: 'manual',
      confirmed: true,
      expectedVersionId: null,
      draft: draft(),
      idempotencyKey: 'save-0001',
    };
    expect(manualPlanCommandSchema.safeParse(command).success).toBe(true);
    expect(manualPlanCommandSchema.safeParse({ ...command, confirmed: false }).success).toBe(false);
    expect(manualPlanCommandSchema.safeParse({ ...command, source: 'proposal' }).success).toBe(
      false,
    );
  });
  it('requires unlocking as prior saved state before changing protected fields', () => {
    const previous = draft();
    previous.sessions = [{ ...session(), locks: { date: true, time: true, intensity: true } }];
    const next = structuredClone(previous);
    next.sessions = next.sessions.map((item) => ({
      ...item,
      locks: { date: false, time: false, intensity: false },
    }));
    expect(preservesSessionLocks(previous, next)).toBe(true);
    const moved = structuredClone(next);
    moved.sessions = moved.sessions.map((item) => ({ ...item, date: '2026-03-09' }));
    expect(preservesSessionLocks(previous, moved)).toBe(false);
    expect(preservesSessionLocks(next, moved)).toBe(true);
    expect(preservesSessionLocks(previous, { ...next, sessions: [] })).toBe(false);
    expect(preservesSessionLocks(previous, { ...next, timezone: 'UTC' })).toBe(false);
    const reassigned = structuredClone(next);
    reassigned.periods = reassigned.periods.map((period) =>
      period.id === 'block' ? { ...period, id: 'replacement-block' } : period,
    );
    reassigned.sessions = reassigned.sessions.map((item) => ({
      ...item,
      blockId: 'replacement-block',
    }));
    expect(planDraftSchema.safeParse(reassigned).success).toBe(true);
    expect(preservesSessionLocks(previous, reassigned)).toBe(false);
    expect(preservesSessionLocks(next, reassigned)).toBe(true);
  });
});
