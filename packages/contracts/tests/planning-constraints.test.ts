import { describe, expect, it } from 'vitest';
import { periodConstraintsSchema } from '../src/period-constraints.js';
import { evaluatePlanConstraints } from '../src/planning-constraints.js';
import {
  planDraftSchema,
  planSnapshotSchema,
  manualPlanCommandSchema,
  preservesSessionLocks,
  projectPlan,
  type PlanDraft,
  type PeriodDraft,
  type PlannedSession,
} from '../src/planning.js';

const date = '2026-03-08'; // DST transition: this feature is a quantity, never elapsed midnight arithmetic.
const empty = () => ({ unavailableDates: [], dailyTimeLimits: [] });
function fixture(): PlanDraft {
  return {
    title: 'Constraints',
    timezone: 'America/New_York',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, i, levels) => ({
      id: level,
      parentId: i ? (levels[i - 1] ?? null) : null,
      level,
      title: level,
      startDate: '2026-03-01',
      endDateExclusive: '2026-03-11',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [],
  };
}
function addSession(draft: PlanDraft, id: string, durationSeconds: number | null, day = date) {
  const session: PlannedSession = {
    id,
    blockId: 'block',
    date: day,
    localStartTime: null,
    title: id,
    sport: 'running',
    durationSeconds,
    distanceMeters: null,
    targetRpe: null,
    purpose: '',
    notes: '',
    priority: 'normal',
    locks: { date: true, time: true, intensity: true },
    steps: [{ id: 'step', kind: 'work', durationSeconds: 600, distanceMeters: 0, repetitions: 3 }],
  };
  draft.sessions.push(session);
}
function constrain(
  draft: PlanDraft,
  id: string,
  constraints: NonNullable<PeriodDraft['constraints']>,
) {
  const period = draft.periods.find((item) => item.id === id);
  if (!period) throw new Error('Fixture period missing');
  period.constraints = constraints;
}
function limit(draft: PlanDraft, id: string, seconds: number, day = date) {
  constrain(draft, id, {
    unavailableDates: [],
    dailyTimeLimits: [{ date: day, availableSeconds: seconds }],
  });
}

describe('S04 period constraints and immutable compatibility', () => {
  it('preserves omitted legacy constraints, explicit empty lists and zero quantities in snapshots and commands', () => {
    const draft = fixture();
    expect(planDraftSchema.parse(draft)).toStrictEqual(draft);
    expect(planDraftSchema.parse(draft).periods[0]).not.toHaveProperty('constraints');
    constrain(draft, 'season', empty());
    constrain(draft, 'block', {
      unavailableDates: [date],
      dailyTimeLimits: [{ date, availableSeconds: 0 }],
    });
    const snapshot = { id: 'saved', version: 1, createdAt: '2026-09-17T00:00:00Z', draft };
    expect(planSnapshotSchema.parse(snapshot)).toStrictEqual(snapshot);
    const command = {
      source: 'manual',
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: 'constraints-1',
      draft,
    };
    expect(manualPlanCommandSchema.parse(command)).toStrictEqual(command);
  });
  it('rejects malformed, duplicate, unbounded or ambiguous quantity input without coercion', () => {
    for (const seconds of [-1, 0.5, 86401, Infinity, NaN, null, '60'])
      expect(
        periodConstraintsSchema.safeParse({
          unavailableDates: [],
          dailyTimeLimits: [{ date, availableSeconds: seconds }],
        }).success,
      ).toBe(false);
    for (const bad of [
      null,
      {},
      { ...empty(), clockStart: '09:00' },
      { ...empty(), unavailableDates: [date, date] },
      { ...empty(), unavailableDates: ['2026-02-30'] },
      { ...empty(), unavailableDates: Array.from({ length: 3661 }, () => date) },
      {
        ...empty(),
        dailyTimeLimits: [
          { date, availableSeconds: 1 },
          { date, availableSeconds: 2 },
        ],
      },
    ])
      expect(periodConstraintsSchema.safeParse(bad).success).toBe(false);
    expect(
      periodConstraintsSchema.parse({
        ...empty(),
        dailyTimeLimits: [{ date, availableSeconds: 86400 }],
      }).dailyTimeLimits[0]?.availableSeconds,
    ).toBe(86400);
  });
  it('requires all constraint dates inside their own half-open period and refuses silent pruning after shrinking', () => {
    for (const day of ['2026-02-28', '2026-03-11']) {
      const draft = fixture();
      constrain(draft, 'block', {
        unavailableDates: [day],
        dailyTimeLimits: [{ date: day, availableSeconds: 60 }],
      });
      const before = structuredClone(draft);
      expect(planDraftSchema.safeParse(draft).success).toBe(false);
      expect(() => evaluatePlanConstraints(draft)).toThrow();
      expect(draft).toStrictEqual(before);
    }
    const draft = fixture();
    limit(draft, 'block', 60);
    const block = draft.periods.find((p) => p.id === 'block');
    if (!block) throw new Error('Fixture');
    block.endDateExclusive = date;
    expect(planDraftSchema.safeParse(draft).success).toBe(false);
    expect(block.constraints?.dailyTimeLimits[0]?.date).toBe(date);
  });
  it('combines ancestor unavailability and the minimum daily budget with sources and multiple sessions counted once', () => {
    const draft = fixture();
    limit(draft, 'season', 3600);
    limit(draft, 'wave', 1800);
    limit(draft, 'block', 2400);
    constrain(draft, 'phase', { unavailableDates: [date], dailyTimeLimits: [] });
    addSession(draft, 'a', 1200);
    addSession(draft, 'b', 900);
    addSession(draft, 'c', null);
    const [result] = evaluatePlanConstraints(draft);
    expect(result).toMatchObject({
      date,
      unavailablePeriodIds: ['phase'],
      availableSeconds: 1800,
      sessionIds: ['a', 'b', 'c'],
      knownDurationSeconds: 2100,
      unknownDurationSessionIds: ['c'],
      unavailableConflict: true,
      exceedsAvailableTime: true,
      status: 'conflict',
    });
    expect(result?.timeLimitSources).toEqual([
      { periodId: 'block', availableSeconds: 2400 },
      { periodId: 'season', availableSeconds: 3600 },
      { periodId: 'wave', availableSeconds: 1800 },
    ]);
  });
  it('distinguishes exact fit, unknown duration, known excess, explicit zero and no constraint', () => {
    const draft = fixture();
    addSession(draft, 'a', 0);
    expect(evaluatePlanConstraints(draft)).toEqual([]);
    limit(draft, 'block', 0);
    expect(evaluatePlanConstraints(draft)[0]).toMatchObject({
      availableSeconds: 0,
      knownDurationSeconds: 0,
      status: 'no_conflict',
    });
    addSession(draft, 'b', null);
    expect(evaluatePlanConstraints(draft)[0]?.status).toBe('unknown');
    addSession(draft, 'c', 1);
    expect(evaluatePlanConstraints(draft)[0]?.status).toBe('conflict');
    limit(draft, 'block', 1);
    expect(evaluatePlanConstraints(draft)[0]?.status).toBe('unknown');
    draft.sessions = draft.sessions.filter((session) => session.id !== 'b');
    expect(evaluatePlanConstraints(draft)[0]?.status).toBe('no_conflict');
  });
  it('flags even zero or unknown planned sessions on unavailable dates but does not infer actual rest on an empty day', () => {
    const draft = fixture();
    constrain(draft, 'season', { unavailableDates: [date], dailyTimeLimits: [] });
    expect(evaluatePlanConstraints(draft)[0]).toMatchObject({
      sessionIds: [],
      status: 'no_conflict',
    });
    addSession(draft, 'a', 0);
    addSession(draft, 'b', null);
    expect(evaluatePlanConstraints(draft)[0]).toMatchObject({
      unavailableConflict: true,
      availableSeconds: null,
      status: 'conflict',
    });
  });
  it('keeps constraints scoped by local date across adjacent blocks and DST, with deterministic nonmutating results', () => {
    const draft = fixture();
    const block = draft.periods.find((p) => p.id === 'block');
    if (!block) throw new Error('Fixture');
    block.endDateExclusive = '2026-03-09';
    draft.periods.push({
      ...block,
      id: 'next-block',
      startDate: '2026-03-09',
      endDateExclusive: '2026-03-11',
    });
    limit(draft, 'block', 1);
    limit(draft, 'next-block', 86400, '2026-03-09');
    addSession(draft, 'a', 2);
    const session = draft.sessions[0];
    if (!session) throw new Error('Fixture');
    draft.sessions.push({
      ...session,
      id: 'b',
      blockId: 'next-block',
      date: '2026-03-09',
      durationSeconds: 2,
    });
    const before = structuredClone(draft);
    const results = evaluatePlanConstraints(draft);
    expect(results.map((day) => [day.date, day.status, day.sessionIds])).toEqual([
      [date, 'conflict', ['a']],
      ['2026-03-09', 'no_conflict', ['b']],
    ]);
    expect(
      evaluatePlanConstraints({
        ...draft,
        periods: [...draft.periods].reverse(),
        sessions: [...draft.sessions].reverse(),
      }),
    ).toEqual(results);
    expect(draft).toStrictEqual(before);
  });
  it('allows explicit conflicted manual snapshots without changing projections, locks or original input', () => {
    const before = fixture();
    addSession(before, 'locked', 3600);
    const after = structuredClone(before);
    limit(after, 'season', 60);
    expect(evaluatePlanConstraints(after)[0]?.status).toBe('conflict');
    expect(planDraftSchema.parse(after)).toStrictEqual(after);
    expect(preservesSessionLocks(before, after)).toBe(true);
    const lens = { kind: 'calendar', from: '2026-03-01', toExclusive: '2026-03-11' } as const;
    expect(projectPlan(after, lens)).toEqual(projectPlan(before, lens));
    expect(after.sessions).toStrictEqual(before.sessions);
  });
});
