import { z } from 'zod';
import {
  evaluatePlanConstraints,
  type PlanConstraintDay,
} from '@workout/contracts/planning-constraints';
import { localDateSchema } from '@workout/contracts/primitives';
import { raceEventSchema } from '@workout/contracts/races';
import {
  planDraftSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  type PlanDraft,
} from '@workout/contracts/planning';
import {
  sessionCompletionSchema,
  preservesSessionCompletions,
  type SessionCompletion,
} from '@workout/contracts/session-completion';

// Internal pure-function input, not an HTTP command or approval contract.
const inputSchema = z.strictObject({
  event: raceEventSchema.pick({ localDate: true, planVersionId: true }),
  newLocalDate: localDateSchema,
  currentPlan: planSnapshotSchema.nullable(),
  completionReports: z.array(sessionCompletionSchema).max(1000),
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keep_plan') }),
    z.strictObject({
      kind: z.literal('move_period'),
      expectedCurrentPlanVersionId: planSnapshotSchema.shape.id,
      periodId: z.string().min(1).max(200),
      newStartDate: localDateSchema,
      scope: z.enum(['period_only', 'descendants_and_sessions']),
    }),
  ]),
});
export type RacePlanImpactInput = z.infer<typeof inputSchema>;
export type RacePlanImpactReason =
  | 'invalid_input'
  | 'unsupported_calendar'
  | 'projection_bound'
  | 'missing_current_plan'
  | 'current_plan_mismatch'
  | 'missing_period'
  | 'outside_parent'
  | 'sibling_overlap'
  | 'child_outside_period'
  | 'fixed_session_outside_block'
  | 'constraints_outside_period'
  | 'locked'
  | 'completed'
  | 'invalid_result';
export interface RacePlanCalendarDiff {
  id: string;
  before: { startDate: string; endDateExclusive: string };
  after: { startDate: string; endDateExclusive: string };
}
export type RacePlanImpactProjection =
  | { status: 'rejected'; reason: RacePlanImpactReason }
  | {
      status: 'projected';
      /** Always blocked: a calendar projection cannot establish complete approval freshness. */
      approval: {
        status: 'blocked';
        reasons: readonly [
          'affected_schedule_collection_missing',
          'complete_dependency_manifest_missing',
          'atomic_approval_missing',
        ];
      };
      eventDate: { before: string; after: string; deltaCalendarDays: number };
      linkedPlan: {
        versionId: string | null;
        relationship: 'unlinked' | 'current' | 'historical_or_other';
      };
      currentPlanVersionId: string | null;
      plan: PlanDraft | null;
      periodDiffs: RacePlanCalendarDiff[];
      sessionDiffs: { id: string; beforeDate: string; afterDate: string }[];
      fixedSessionIds: string[];
      constraintDays: PlanConstraintDay[];
    };
const reject = (reason: RacePlanImpactReason): RacePlanImpactProjection => ({
  status: 'rejected',
  reason,
});
// Proleptic Gregorian civil ordinal. No timezone offsets or elapsed 24-hour assumption.
function ordinal(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const previous = year - 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const precedingMonthDays = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][month - 1];
  if (precedingMonthDays === undefined) throw new Error('Validated month missing');
  return (
    previous * 365 +
    Math.floor(previous / 4) -
    Math.floor(previous / 100) +
    Math.floor(previous / 400) +
    precedingMonthDays +
    (leap && month > 2 ? 1 : 0) +
    day
  );
}
function shiftCivilDate(date: string, delta: number): string | null {
  // UTC Date is only a calendar carrier. setUTCDate advances date fields; no instant is projected.
  const carrier = new Date(`${date}T00:00:00.000Z`);
  carrier.setUTCDate(carrier.getUTCDate() + delta);
  if (
    !Number.isFinite(carrier.getTime()) ||
    carrier.getUTCFullYear() < 1 ||
    carrier.getUTCFullYear() > 9999
  )
    return null;
  return carrier.toISOString().slice(0, 10);
}
/** Reusable validation adapter using public contracts, with no module/persistence dependency. */
function validateCandidate(
  before: PlanDraft,
  after: PlanDraft,
  reports: SessionCompletion[],
): RacePlanImpactReason | null {
  if (!preservesSessionLocks(before, after)) return 'locked';
  if (!preservesSessionCompletions(after, reports)) return 'completed';
  return planDraftSchema.safeParse(after).success ? null : 'invalid_result';
}

/** Produces review data only. Never writes events, plans, actuals, receipts or an outbox. */
export function projectRacePlanImpact(input: unknown): RacePlanImpactProjection {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return reject('invalid_input');
  const { event, newLocalDate, currentPlan, completionReports, selection } = parsed.data;
  if (
    new Set(completionReports.map((report) => report.sessionId)).size !== completionReports.length
  )
    return reject('invalid_input');
  const dates = [
    event.localDate,
    newLocalDate,
    ...(currentPlan?.draft.periods.flatMap((period) => [
      period.startDate,
      period.endDateExclusive,
    ]) ?? []),
    ...(currentPlan?.draft.sessions.map((session) => session.date) ?? []),
  ];
  if (dates.some((date) => date < '0001-01-01')) return reject('unsupported_calendar');
  const eventDelta = ordinal(newLocalDate) - ordinal(event.localDate);
  if (Math.abs(eventDelta) > 3660) return reject('projection_bound');
  if (currentPlan === null && completionReports.length > 0) return reject('invalid_input');
  const plan = currentPlan ? structuredClone(currentPlan.draft) : null;
  const periodDiffs: RacePlanCalendarDiff[] = [];
  const sessionDiffs: { id: string; beforeDate: string; afterDate: string }[] = [];
  const fixedSessionIds: string[] = [];
  if (selection.kind === 'move_period') {
    if (currentPlan === null || plan === null) return reject('missing_current_plan');
    if (selection.expectedCurrentPlanVersionId !== currentPlan.id)
      return reject('current_plan_mismatch');
    const source = plan.periods.find((period) => period.id === selection.periodId);
    if (!source) return reject('missing_period');
    if (selection.newStartDate < '0001-01-01') return reject('unsupported_calendar');
    const delta = ordinal(selection.newStartDate) - ordinal(source.startDate);
    if (Math.abs(delta) > 3660) return reject('projection_bound');
    const moving = new Set([source.id]);
    const subtree = new Set([source.id]);
    for (let size = 0; size !== subtree.size;) {
      size = subtree.size;
      for (const period of plan.periods)
        if (period.parentId !== null && subtree.has(period.parentId)) subtree.add(period.id);
    }
    if (selection.scope === 'descendants_and_sessions') for (const id of subtree) moving.add(id);
    for (const period of plan.periods) {
      if (!moving.has(period.id)) continue;
      const before = { startDate: period.startDate, endDateExclusive: period.endDateExclusive };
      const start = shiftCivilDate(period.startDate, delta),
        end = shiftCivilDate(period.endDateExclusive, delta);
      if (start === null || end === null) return reject('unsupported_calendar');
      period.startDate = start;
      period.endDateExclusive = end;
      if (
        period.constraints?.unavailableDates.some((date) => date < start || date >= end) ||
        period.constraints?.dailyTimeLimits.some(({ date }) => date < start || date >= end)
      )
        return reject('constraints_outside_period');
      if (delta !== 0)
        periodDiffs.push({
          id: period.id,
          before,
          after: { startDate: start, endDateExclusive: end },
        });
    }
    const completed = new Set(
      completionReports
        .filter((report) => report.status === 'completed')
        .map((report) => report.sessionId),
    );
    for (const session of plan.sessions) {
      if (!subtree.has(session.blockId)) continue;
      if (selection.scope === 'period_only' || completed.has(session.id) || session.locks.date) {
        fixedSessionIds.push(session.id);
        continue;
      }
      const date = shiftCivilDate(session.date, delta);
      if (date === null) return reject('unsupported_calendar');
      if (delta !== 0)
        sessionDiffs.push({ id: session.id, beforeDate: session.date, afterDate: date });
      session.date = date;
    }
    const periods = new Map(plan.periods.map((period) => [period.id, period]));
    for (const period of plan.periods) {
      const parent = period.parentId === null ? undefined : periods.get(period.parentId);
      if (
        parent &&
        (period.startDate < parent.startDate || period.endDateExclusive > parent.endDateExclusive)
      )
        return reject(moving.has(period.id) ? 'outside_parent' : 'child_outside_period');
      if (
        plan.periods.some(
          (other) =>
            other.id !== period.id &&
            other.parentId === period.parentId &&
            other.startDate < period.endDateExclusive &&
            period.startDate < other.endDateExclusive,
        )
      )
        return reject('sibling_overlap');
    }
    for (const session of plan.sessions) {
      const block = periods.get(session.blockId);
      if (!block || session.date < block.startDate || session.date >= block.endDateExclusive)
        return reject('fixed_session_outside_block');
    }
    const invalid = validateCandidate(currentPlan.draft, plan, completionReports);
    if (invalid) return reject(invalid);
  } else if (currentPlan !== null && plan !== null) {
    const invalid = validateCandidate(currentPlan.draft, plan, completionReports);
    if (invalid) return reject(invalid);
  }
  periodDiffs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  sessionDiffs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fixedSessionIds.sort();
  return {
    status: 'projected',
    approval: {
      status: 'blocked',
      reasons: [
        'affected_schedule_collection_missing',
        'complete_dependency_manifest_missing',
        'atomic_approval_missing',
      ],
    },
    eventDate: { before: event.localDate, after: newLocalDate, deltaCalendarDays: eventDelta },
    linkedPlan: {
      versionId: event.planVersionId,
      relationship:
        event.planVersionId === null
          ? 'unlinked'
          : event.planVersionId === currentPlan?.id
            ? 'current'
            : 'historical_or_other',
    },
    currentPlanVersionId: currentPlan?.id ?? null,
    plan,
    periodDiffs,
    sessionDiffs,
    fixedSessionIds,
    constraintDays: plan === null ? [] : evaluatePlanConstraints(plan),
  };
}
