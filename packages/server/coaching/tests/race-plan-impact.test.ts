import { expect, it } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { projectRacePlanImpact, type RacePlanImpactInput } from '../src/race-plan-impact.js';
const id = '10000000-0000-4000-8000-000000000001';
const historical = '10000000-0000-4000-8000-000000000002';
function fixture(): RacePlanImpactInput {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    event: { localDate: '2026-03-07', planVersionId: id },
    newLocalDate: '2026-03-09',
    currentPlan: planSnapshotSchema.parse({
      id,
      version: 2,
      createdAt: '2026-03-01T00:00:00Z',
      draft: {
        title: 'Synthetic',
        timezone: 'America/New_York',
        periods: levels.map((level, index) => ({
          id: level,
          parentId: index === 0 ? null : levels[index - 1],
          level,
          title: level,
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
            title: 'Planned',
            sport: 'running',
            durationSeconds: null,
            distanceMeters: 0,
            targetRpe: null,
            purpose: '',
            notes: '',
            priority: 'normal',
            locks: { date: false, time: false, intensity: false },
            steps: [],
          },
        ],
      },
    }),
    completionReports: [],
    selection: {
      kind: 'move_period',
      expectedCurrentPlanVersionId: id,
      periodId: 'season',
      newStartDate: '2026-03-03',
      scope: 'descendants_and_sessions',
    },
  };
}
function required<T>(input: T | null | undefined): T {
  if (input === null || input === undefined) throw Error('Missing fixture');
  return input;
}
function projected(input: unknown) {
  const result = projectRacePlanImpact(input);
  if (result.status !== 'projected') throw Error(`Rejected ${result.reason}`);
  return result;
}
it('projects DST civil dates deterministically without creating local time, quantities or modifying input', () => {
  const input = fixture(),
    before = structuredClone(input);
  const result = projected(input);
  expect(result.eventDate).toEqual({
    before: '2026-03-07',
    after: '2026-03-09',
    deltaCalendarDays: 2,
  });
  expect(result.sessionDiffs).toEqual([
    { id: 'session', beforeDate: '2026-03-07', afterDate: '2026-03-09' },
  ]);
  expect(result.plan?.sessions[0]).toEqual({
    ...before.currentPlan?.draft.sessions[0],
    date: '2026-03-09',
  });
  expect(result.plan?.timezone).toBe('America/New_York');
  expect(result.periodDiffs.map((diff) => diff.id)).toEqual(['block', 'phase', 'season', 'wave']);
  expect(result.approval.status).toBe('blocked');
  expect(result.approval.reasons).toContain('affected_schedule_collection_missing');
  expect(projectRacePlanImpact(input)).toEqual(result);
  expect(input).toEqual(before);
});
it('keeps a historical immutable link distinct from the explicit current version', () => {
  const input = fixture();
  input.event.planVersionId = historical;
  input.selection = { kind: 'keep_plan' };
  const result = projected(input);
  expect(result.linkedPlan).toEqual({ versionId: historical, relationship: 'historical_or_other' });
  expect(result.currentPlanVersionId).toBe(id);
  expect(result.plan).toEqual(input.currentPlan?.draft);
  expect(result.periodDiffs).toEqual([]);
  expect(result.sessionDiffs).toEqual([]);
});
it('accepts explicit keep with an absent head but cannot move an absent or different current version', () => {
  const input = fixture();
  input.currentPlan = null;
  input.selection = { kind: 'keep_plan' };
  expect(projected(input)).toMatchObject({
    plan: null,
    currentPlanVersionId: null,
    approval: { status: 'blocked' },
  });
  input.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: id,
    periodId: 'season',
    newStartDate: '2026-03-03',
    scope: 'descendants_and_sessions',
  };
  expect(projectRacePlanImpact(input)).toEqual({
    status: 'rejected',
    reason: 'missing_current_plan',
  });
  const wrong = fixture();
  if (wrong.selection.kind !== 'move_period') throw Error('fixture');
  wrong.selection.expectedCurrentPlanVersionId = historical;
  expect(projectRacePlanImpact(wrong)).toEqual({
    status: 'rejected',
    reason: 'current_plan_mismatch',
  });
});
it.each(['locked', 'completed'] as const)(
  'fixes %s sessions and rejects exclusion from the moved Block',
  (kind) => {
    const input = fixture(),
      plan = required(input.currentPlan),
      session = required(plan.draft.sessions[0]);
    if (kind === 'locked') session.locks.date = true;
    else
      input.completionReports = [
        {
          sessionId: 'session',
          revision: 1,
          planVersionId: id,
          schedule: {
            blockId: 'block',
            date: session.date,
            localStartTime: null,
            timezone: plan.draft.timezone,
          },
          status: 'completed',
          reportedAt: '2026-03-08T00:00:00Z',
          reason: null,
          source: 'user',
          method: 'self_report',
          definitionVersion: 'session-completion-v1',
        },
      ];
    const result = projected(input);
    expect(result.fixedSessionIds).toEqual(['session']);
    expect(result.sessionDiffs).toEqual([]);
    expect(result.plan?.sessions).toEqual(plan.draft.sessions);
    if (input.selection.kind !== 'move_period') throw Error('fixture');
    input.selection.newStartDate = '2026-03-08';
    expect(projectRacePlanImpact(input)).toEqual({
      status: 'rejected',
      reason: 'fixed_session_outside_block',
    });
  },
);
it('selected-only fixes descendant periods and sessions', () => {
  const input = fixture();
  if (input.selection.kind !== 'move_period') throw Error('fixture');
  input.selection.periodId = 'block';
  input.selection.scope = 'period_only';
  input.selection.newStartDate = '2026-03-02';
  required(input.currentPlan).draft.periods.forEach((period) => {
    if (period.level === 'block') period.endDateExclusive = '2026-03-20';
  });
  const result = projected(input);
  expect(result.periodDiffs.map((diff) => diff.id)).toEqual(['block']);
  expect(result.sessionDiffs).toEqual([]);
  expect(result.fixedSessionIds).toEqual(['session']);
});
it('rejects parent overflow and a child left outside by selected-only movement', () => {
  const input = fixture();
  if (input.selection.kind !== 'move_period') throw Error('fixture');
  input.selection.periodId = 'block';
  expect(projectRacePlanImpact(input)).toEqual({ status: 'rejected', reason: 'outside_parent' });
  input.selection.periodId = 'season';
  input.selection.scope = 'period_only';
  expect(projectRacePlanImpact(input)).toEqual({
    status: 'rejected',
    reason: 'child_outside_period',
  });
});
it('rejects sibling overlap instead of silently moving the sibling', () => {
  const input = fixture(),
    plan = required(input.currentPlan).draft,
    block = required(plan.periods.find((period) => period.level === 'block'));
  block.endDateExclusive = '2026-03-15';
  plan.periods.push({
    ...block,
    id: 'second',
    startDate: '2026-03-15',
    endDateExclusive: '2026-03-25',
  });
  if (input.selection.kind !== 'move_period') throw Error('fixture');
  input.selection.periodId = 'block';
  expect(projectRacePlanImpact(input)).toEqual({ status: 'rejected', reason: 'sibling_overlap' });
});
it('rejects unassigned sessions and cyclic/missing parent input before projection', () => {
  const input = fixture();
  required(required(input.currentPlan).draft.sessions[0]).blockId = 'unknown';
  expect(projectRacePlanImpact(input)).toEqual({ status: 'rejected', reason: 'invalid_input' });
  const cycle = fixture();
  required(required(cycle.currentPlan).draft.periods[0]).parentId = 'block';
  expect(projectRacePlanImpact(cycle)).toEqual({ status: 'rejected', reason: 'invalid_input' });
});
it('keeps absolute constraints fixed and exposes conflict/unknown availability without approval success', () => {
  const input = fixture(),
    season = required(required(input.currentPlan).draft.periods[0]);
  season.constraints = {
    unavailableDates: ['2026-03-09'],
    dailyTimeLimits: [{ date: '2026-03-10', availableSeconds: 600 }],
  };
  const result = projected(input);
  expect(result.constraintDays.find((day) => day.date === '2026-03-09')).toMatchObject({
    status: 'conflict',
    unavailableConflict: true,
  });
  const session = required(required(input.currentPlan).draft.sessions[0]);
  session.date = '2026-03-08';
  const unknown = projected(input);
  expect(unknown.constraintDays.find((day) => day.date === '2026-03-10')).toMatchObject({
    status: 'unknown',
    unknownDurationSessionIds: ['session'],
  });
  expect(unknown.approval.status).toBe('blocked');
  season.constraints.unavailableDates = ['2026-03-01'];
  expect(projectRacePlanImpact(input)).toEqual({
    status: 'rejected',
    reason: 'constraints_outside_period',
  });
});
it('preserves explicit wall time across autumn DST and crosses leap day in civil days', () => {
  const input = fixture();
  input.event.localDate = '2024-02-28';
  input.newLocalDate = '2024-03-01';
  input.selection = { kind: 'keep_plan' };
  expect(projected(input).eventDate.deltaCalendarDays).toBe(2);
  const autumn = fixture(),
    plan = required(autumn.currentPlan).draft;
  plan.periods.forEach((period) => {
    period.startDate = '2026-10-01';
    period.endDateExclusive = '2026-12-01';
  });
  const session = required(plan.sessions[0]);
  session.date = '2026-10-31';
  session.localStartTime = '01:30';
  if (autumn.selection.kind !== 'move_period') throw Error('fixture');
  autumn.selection.newStartDate = '2026-10-02';
  expect(projected(autumn).plan?.sessions[0]).toMatchObject({
    date: '2026-11-01',
    localStartTime: '01:30',
  });
});
it('bounds event delta, calendar overflow, collection size and strict input keys', () => {
  const input = fixture();
  input.newLocalDate = '9999-12-31';
  expect(projectRacePlanImpact(input)).toEqual({ status: 'rejected', reason: 'projection_bound' });
  expect(projectRacePlanImpact({ ...fixture(), bypass: true })).toEqual({
    status: 'rejected',
    reason: 'invalid_input',
  });
  const count = fixture();
  required(count.currentPlan).draft.sessions = Array.from({ length: 1001 }, (_, index) => ({
    ...required(required(count.currentPlan).draft.sessions[0]),
    id: `s${index}`,
  }));
  expect(projectRacePlanImpact(count)).toEqual({ status: 'rejected', reason: 'invalid_input' });
  const overflow = fixture(),
    plan = required(overflow.currentPlan).draft;
  plan.periods.forEach((period) => {
    period.startDate = '9999-12-01';
    period.endDateExclusive = '9999-12-31';
  });
  required(plan.sessions[0]).date = '9999-12-10';
  if (overflow.selection.kind !== 'move_period') throw Error('fixture');
  overflow.selection.newStartDate = '9999-12-02';
  expect(projectRacePlanImpact(overflow)).toEqual({
    status: 'rejected',
    reason: 'unsupported_calendar',
  });
});
