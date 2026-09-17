import {
  planDraftSchema,
  periodDraftSchema,
  preservesSessionLocks,
  type PlanDraft,
} from '@workout/contracts/planning';
import {
  preservesSessionCompletions,
  type SessionCompletion,
} from '@workout/contracts/session-completion';

export type PeriodMoveReason =
  | 'invalid_draft'
  | 'invalid_baseline'
  | 'invalid_date'
  | 'invalid_scope'
  | 'missing_period'
  | 'unsupported_calendar'
  | 'outside_parent'
  | 'sibling_overlap'
  | 'child_outside_period'
  | 'fixed_session_outside_block'
  | 'constraints_outside_period'
  | 'locked'
  | 'completed'
  | 'invalid_result';
export type PeriodMoveResult =
  | { status: 'unchanged' }
  | { status: 'rejected'; reason: PeriodMoveReason }
  | {
      status: 'changed';
      draft: PlanDraft;
      summary: {
        deltaDays: number;
        movedPeriodIds: string[];
        movedSessionIds: string[];
        fixedSessionIds: string[];
      };
    };
const day = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / 86_400_000;
function shifted(date: string, delta: number): string | null {
  if (date < '0001-01-01') return null;
  const value = new Date((day(date) + delta) * 86_400_000);
  if (
    !Number.isFinite(value.getTime()) ||
    value.getUTCFullYear() < 1 ||
    value.getUTCFullYear() > 9999
  )
    return null;
  return value.toISOString().slice(0, 10);
}

/** One atomic draft-only calendar move. Absolute-date constraints and protected sessions stay fixed. */
export function applyPeriodMove({
  draft,
  baseline,
  completionReports,
  periodId,
  newStartDate,
  scope,
}: {
  draft: PlanDraft;
  baseline: PlanDraft | null;
  completionReports: readonly SessionCompletion[];
  periodId: string;
  newStartDate: string;
  scope: 'period_only' | 'descendants_and_sessions';
}): PeriodMoveResult {
  const reject = (reason: PeriodMoveReason): PeriodMoveResult => ({ status: 'rejected', reason });
  if (!planDraftSchema.safeParse(draft).success) return reject('invalid_draft');
  if (baseline !== null && !planDraftSchema.safeParse(baseline).success)
    return reject('invalid_baseline');
  if (!periodDraftSchema.shape.startDate.safeParse(newStartDate).success)
    return reject('invalid_date');
  if (scope !== 'period_only' && scope !== 'descendants_and_sessions')
    return reject('invalid_scope');
  const source = draft.periods.find((period) => period.id === periodId);
  if (!source) return reject('missing_period');
  if (newStartDate < '0001-01-01' || source.startDate < '0001-01-01')
    return reject('unsupported_calendar');
  const deltaDays = day(newStartDate) - day(source.startDate);
  const moving = new Set([periodId]);
  if (scope === 'descendants_and_sessions') {
    // At most 100 nodes, including arbitrarily ordered validated trees.
    for (let size = 0; size !== moving.size;) {
      size = moving.size;
      for (const period of draft.periods)
        if (period.parentId !== null && moving.has(period.parentId)) moving.add(period.id);
    }
  }
  const candidate = structuredClone(draft);
  const movedSessionIds: string[] = [];
  const fixedSessionIds: string[] = [];
  const completed = new Set(
    completionReports
      .filter((report) => report.status === 'completed')
      .map((report) => report.sessionId),
  );
  const prior = new Map(baseline?.sessions.map((session) => [session.id, session]) ?? []);
  for (const period of candidate.periods) {
    if (!moving.has(period.id)) continue;
    const start = shifted(period.startDate, deltaDays);
    const end = shifted(period.endDateExclusive, deltaDays);
    if (start === null || end === null) return reject('unsupported_calendar');
    period.startDate = start;
    period.endDateExclusive = end;
    if (
      period.constraints?.unavailableDates.some((date) => date < start || date >= end) ||
      period.constraints?.dailyTimeLimits.some(({ date }) => date < start || date >= end)
    )
      return reject('constraints_outside_period');
  }
  // Selected-only leaves the entire descendant subtree and all sessions unchanged.
  const subtree = new Set([periodId]);
  for (let size = 0; size !== subtree.size;) {
    size = subtree.size;
    for (const period of draft.periods)
      if (period.parentId !== null && subtree.has(period.parentId)) subtree.add(period.id);
  }
  for (const session of candidate.sessions) {
    if (!subtree.has(session.blockId)) continue;
    if (
      scope === 'period_only' ||
      completed.has(session.id) ||
      session.locks.date ||
      prior.get(session.id)?.locks.date
    ) {
      fixedSessionIds.push(session.id);
      continue;
    }
    const date = shifted(session.date, deltaDays);
    if (date === null) return reject('unsupported_calendar');
    session.date = date;
    movedSessionIds.push(session.id);
  }
  const periods = new Map(candidate.periods.map((period) => [period.id, period]));
  for (const period of candidate.periods) {
    const parent = period.parentId === null ? undefined : periods.get(period.parentId);
    if (
      parent &&
      (period.startDate < parent.startDate || period.endDateExclusive > parent.endDateExclusive)
    )
      return reject(moving.has(period.id) ? 'outside_parent' : 'child_outside_period');
    if (
      candidate.periods.some(
        (other) =>
          other.id !== period.id &&
          other.parentId === period.parentId &&
          other.startDate < period.endDateExclusive &&
          period.startDate < other.endDateExclusive,
      )
    )
      return reject('sibling_overlap');
  }
  for (const session of candidate.sessions) {
    const block = periods.get(session.blockId);
    if (!block || session.date < block.startDate || session.date >= block.endDateExclusive)
      return reject('fixed_session_outside_block');
  }
  if (baseline !== null && !preservesSessionLocks(baseline, candidate)) return reject('locked');
  if (!preservesSessionCompletions(candidate, [...completionReports])) return reject('completed');
  if (!planDraftSchema.safeParse(candidate).success) return reject('invalid_result');
  if (deltaDays === 0) return { status: 'unchanged' };
  return {
    status: 'changed',
    draft: candidate,
    summary: {
      deltaDays,
      movedPeriodIds: draft.periods
        .filter((period) => moving.has(period.id))
        .map((period) => period.id),
      movedSessionIds,
      fixedSessionIds,
    },
  };
}
