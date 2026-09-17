import { describe, expect, it } from 'vitest';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import type { SessionCompletion } from '@workout/contracts/session-completion';
import { applyPeriodMove } from '../src/period-move';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
function fixture(): PlanDraft {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    title: '  Raw draft  ',
    timezone: 'America/New_York',
    periods: levels.map((level, index) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: ` ${level} `,
      startDate: '2026-03-01',
      endDateExclusive: '2026-04-01',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-03-07',
        localStartTime: null,
        title: '  Raw session  ',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: 'Purpose',
        notes: 'Notes',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [
          { id: 'step', kind: 'work', durationSeconds: null, distanceMeters: 0, repetitions: 1 },
        ],
      },
    ],
  };
}

function run(draft = fixture(), overrides: Partial<Parameters<typeof applyPeriodMove>[0]> = {}) {
  return applyPeriodMove({
    draft,
    baseline: null,
    completionReports: [],
    periodId: 'season',
    newStartDate: '2026-03-02',
    scope: 'descendants_and_sessions',
    ...overrides,
  });
}
function report(draft: PlanDraft): SessionCompletion {
  const session = draft.sessions[0];
  if (!session) throw new Error('Missing fixture');
  return {
    sessionId: session.id,
    revision: 1,
    planVersionId: '00000000-0000-4000-8000-000000000001',
    schedule: {
      blockId: session.blockId,
      date: session.date,
      localStartTime: session.localStartTime,
      timezone: draft.timezone,
    },
    status: 'completed',
    reportedAt: '2026-03-10T00:00:00Z',
    reason: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  };
}
describe('period calendar move', () => {
  it('moves the subtree across DST in one isolated candidate preserving raw values, gaps, partial flags and missing optional fields', () => {
    const draft = fixture();
    draft.periods.forEach((p) => {
      if (p.level === 'block') {
        p.startDate = '2026-03-05';
        p.endDateExclusive = '2026-03-15';
        p.isPartial = true;
      }
    });
    const before = structuredClone(draft);
    const result = run(draft, { newStartDate: '2026-03-03' });
    expect(result.status).toBe('changed');
    if (result.status !== 'changed') throw new Error('Expected changed');
    expect(result.summary).toEqual({
      deltaDays: 2,
      movedPeriodIds: ['season', 'wave', 'phase', 'block'],
      movedSessionIds: ['session'],
      fixedSessionIds: [],
    });
    expect(result.draft.sessions[0]).toEqual({ ...before.sessions[0], date: '2026-03-09' });
    expect(result.draft.title).toBe(before.title);
    expect(result.draft.periods[3]).toMatchObject({
      startDate: '2026-03-07',
      endDateExclusive: '2026-03-17',
      isPartial: true,
    });
    expect(result.draft.periods[0]).not.toHaveProperty('constraints');
    expect(result.draft.sessions[0]?.steps).not.toBe(draft.sessions[0]?.steps);
    expect(planDraftSchema.safeParse(result.draft).success).toBe(true);
    expect(draft).toEqual(before);
  });
  it('fixes active completion and both current/baseline date locks; rejects a fixed session outside the shifted Block', () => {
    const draft = fixture();
    const baseline = structuredClone(draft);
    baseline.sessions.forEach((s) => (s.locks.date = true));
    for (const options of [{ completionReports: [report(draft)] }, { baseline }]) {
      const result = run(draft, options);
      expect(result.status).toBe('changed');
      if (result.status === 'changed') {
        expect(result.summary.fixedSessionIds).toEqual(['session']);
        expect(result.draft.sessions).toEqual(draft.sessions);
      }
    }
    draft.sessions.forEach((s) => (s.locks.date = true));
    expect(run(draft, { newStartDate: '2026-03-08' })).toEqual({
      status: 'rejected',
      reason: 'fixed_session_outside_block',
    });
    draft.sessions.forEach((s) => (s.locks.date = false));
    const retracted = { ...report(draft), status: 'retracted' as const };
    const moved = run(draft, { completionReports: [retracted] });
    if (moved.status !== 'changed') throw new Error('Expected changed');
    expect(moved.summary.movedSessionIds).toEqual(['session']);
  });
  it('leaves selected-only descendants fixed and validates parent containment without partial exemptions', () => {
    expect(run(fixture(), { scope: 'period_only' })).toEqual({
      status: 'rejected',
      reason: 'child_outside_period',
    });
    const draft = fixture();
    draft.periods.forEach((p) => {
      if (p.level === 'block') {
        p.startDate = '2026-03-05';
        p.endDateExclusive = '2026-03-15';
        p.isPartial = true;
      }
    });
    const result = run(draft, {
      periodId: 'block',
      newStartDate: '2026-03-06',
      scope: 'period_only',
    });
    expect(result.status).toBe('changed');
    if (result.status === 'changed') {
      expect(result.draft.sessions).toEqual(draft.sessions);
      expect(result.summary.fixedSessionIds).toEqual(['session']);
    }
    expect(run(draft, { periodId: 'block', newStartDate: '2026-03-25' })).toEqual({
      status: 'rejected',
      reason: 'outside_parent',
    });
  });
  it('allows touching sibling boundaries but rejects overlaps atomically', () => {
    const draft = fixture();
    const block = draft.periods.find((p) => p.id === 'block');
    if (!block) throw new Error('Missing fixture');
    block.endDateExclusive = '2026-03-10';
    draft.periods.push({
      ...block,
      id: 'next',
      startDate: '2026-03-12',
      endDateExclusive: '2026-03-22',
    });
    expect(run(draft, { periodId: 'block', newStartDate: '2026-03-03' }).status).toBe('changed');
    const before = structuredClone(draft);
    expect(run(draft, { periodId: 'block', newStartDate: '2026-03-04' })).toEqual({
      status: 'rejected',
      reason: 'sibling_overlap',
    });
    expect(draft).toEqual(before);
  });
  it('never shifts absolute calendar constraints, preserving explicit zero and empty/absent fields', () => {
    const draft = fixture();
    required(draft.periods[0]).constraints = {
      unavailableDates: ['2026-03-15'],
      dailyTimeLimits: [{ date: '2026-03-16', availableSeconds: 0 }],
    };
    const moved = run(draft);
    expect(moved.status).toBe('changed');
    if (moved.status === 'changed')
      expect(moved.draft.periods[0]?.constraints).toEqual(draft.periods[0]?.constraints);
    required(required(draft.periods[0]).constraints).unavailableDates = ['2026-03-01'];
    expect(run(draft)).toEqual({ status: 'rejected', reason: 'constraints_outside_period' });
  });
  it('uses leap calendar days and four-digit year bounds without numeric year coercion', () => {
    const make = (start: string, end: string, date: string) => {
      const value = fixture();
      value.periods.forEach((p) => {
        p.startDate = start;
        p.endDateExclusive = end;
      });
      value.sessions.forEach((s) => (s.date = date));
      return value;
    };
    const leap = run(make('2024-02-28', '2024-03-02', '2024-02-29'), {
      newStartDate: '2024-02-29',
    });
    if (leap.status !== 'changed') throw new Error('Expected changed');
    expect(leap.draft.sessions[0]?.date).toBe('2024-03-01');
    expect(leap.summary.deltaDays).toBe(1);
    const ancient = run(make('0001-01-01', '0001-01-10', '0001-01-03'), {
      newStartDate: '0001-01-02',
    });
    if (ancient.status !== 'changed') throw new Error('Expected changed');
    expect(ancient.draft.sessions[0]?.date).toBe('0001-01-04');
    expect(
      run(make('9999-12-01', '9999-12-31', '9999-12-10'), { newStartDate: '9999-12-02' }),
    ).toEqual({ status: 'rejected', reason: 'unsupported_calendar' });
    expect(
      run(make('0000-01-01', '0000-02-01', '0000-01-03'), { newStartDate: '0001-01-01' }),
    ).toEqual({ status: 'rejected', reason: 'unsupported_calendar' });
  });
  it('rejects invalid inputs and stale protected schedules, and treats exact valid requests as no-op', () => {
    expect(run(fixture(), { newStartDate: 'not-date' })).toEqual({
      status: 'rejected',
      reason: 'invalid_date',
    });
    expect(run(fixture(), { periodId: 'absent' })).toEqual({
      status: 'rejected',
      reason: 'missing_period',
    });
    expect(
      run({ ...fixture(), sessions: [{ ...required(fixture().sessions[0]), blockId: 'missing' }] }),
    ).toEqual({ status: 'rejected', reason: 'invalid_draft' });
    expect(run(fixture(), { baseline: { ...fixture(), periods: [] } })).toEqual({
      status: 'rejected',
      reason: 'invalid_baseline',
    });
    expect(run(fixture(), { newStartDate: '2026-03-01' })).toEqual({ status: 'unchanged' });
    const draft = fixture();
    const baseline = structuredClone(draft);
    baseline.sessions.forEach((s) => {
      s.locks.date = true;
      s.date = '2026-03-06';
    });
    expect(run(draft, { baseline })).toEqual({ status: 'rejected', reason: 'locked' });
    const stale = report(draft);
    stale.schedule.localStartTime = '12:00';
    expect(run(draft, { completionReports: [stale] })).toEqual({
      status: 'rejected',
      reason: 'completed',
    });
  });
});
