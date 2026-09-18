import { z } from 'zod';
import {
  trainingCandidateDraftV1Schema,
  trainingCandidateStrategyV1Schema,
  type TrainingCandidateDiffV1,
  type TrainingCandidateDraftV1,
  type TrainingCandidateIssueV1,
} from '@workout/contracts/coaching-candidates';
import { trainingCoachingBasisV1Schema } from '@workout/contracts/coaching-basis';
import {
  planDraftSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  sessionDistanceBounds,
  sessionDurationBounds,
  sumTargetQuantities,
  type PlanDraft,
  type PlannedSession,
} from '@workout/contracts/planning';
import { evaluatePlanConstraints } from '@workout/contracts/planning-constraints';
import {
  preservesSessionCompletions,
  sessionCompletionSchema,
} from '@workout/contracts/session-completion';
import { localDateSchema } from '@workout/contracts/primitives';

const inputSchema = z.strictObject({
  basis: trainingCoachingBasisV1Schema,
  before: planSnapshotSchema,
  proposed: planDraftSchema,
  strategy: trainingCandidateStrategyV1Schema,
  asOfLocalDate: localDateSchema,
  completions: z.array(sessionCompletionSchema).max(1000),
});

type Input = z.infer<typeof inputSchema>;
type Issue = TrainingCandidateIssueV1;
type Subject = Issue['subject'];

const planSubject: Subject = { kind: 'plan' };
const issue = (code: Issue['code'], subject: Subject): Issue => ({ code, subject });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function changes<T extends { id: string }>(before: readonly T[], after: readonly T[]) {
  const old = new Map(before.map((item) => [item.id, item]));
  const next = new Map(after.map((item) => [item.id, item]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((id) => {
    const previous = old.get(id) ?? null;
    const proposed = next.get(id) ?? null;
    if (same(previous, proposed)) return [];
    return [
      {
        id,
        kind: previous === null ? 'added' : proposed === null ? 'removed' : 'modified',
        before: previous,
        after: proposed,
      } as const,
    ];
  });
}

function quantitySummary<const U extends 's' | 'm'>(
  sessions: readonly PlannedSession[],
  unit: U,
): { unit: U; knownMin: number; knownMax: number; unknownSessionIds: string[] } {
  const minimums: number[] = [];
  const maximums: number[] = [];
  const unknownSessionIds: string[] = [];
  for (const session of sessions) {
    const bounds = unit === 's' ? sessionDurationBounds(session) : sessionDistanceBounds(session);
    if (bounds === null) unknownSessionIds.push(session.id);
    else {
      minimums.push(bounds.min);
      maximums.push(bounds.max);
    }
  }
  return {
    unit,
    knownMin: sumTargetQuantities(minimums),
    knownMax: sumTargetQuantities(maximums),
    unknownSessionIds: unknownSessionIds.sort(),
  };
}

function quantityImpact<const U extends 's' | 'm'>(
  before: readonly PlannedSession[],
  after: readonly PlannedSession[],
  unit: U,
) {
  const previous = quantitySummary(before, unit);
  const proposed = quantitySummary(after, unit);
  const complete =
    previous.unknownSessionIds.length === 0 && proposed.unknownSessionIds.length === 0;
  return {
    before: previous,
    after: proposed,
    delta: complete
      ? {
          unit,
          min: proposed.knownMin - previous.knownMax,
          max: proposed.knownMax - previous.knownMin,
        }
      : null,
  };
}

function diff(before: PlanDraft, proposed: PlanDraft): TrainingCandidateDiffV1 {
  return {
    definitionVersion: 'training-candidate-diff-v1',
    title: before.title === proposed.title ? null : { before: before.title, after: proposed.title },
    periodChanges: changes(before.periods, proposed.periods),
    sessionChanges: changes(before.sessions, proposed.sessions),
    duration: quantityImpact(before.sessions, proposed.sessions, 's'),
    distance: quantityImpact(before.sessions, proposed.sessions, 'm'),
  };
}

function changedConstraintDates(
  periodChanges: TrainingCandidateDiffV1['periodChanges'],
): Set<string> {
  const dates = new Set<string>();
  for (const change of periodChanges) {
    for (const period of [change.before, change.after]) {
      if (!period) continue;
      for (const date of period.constraints?.unavailableDates ?? []) dates.add(date);
      for (const limit of period.constraints?.dailyTimeLimits ?? []) dates.add(limit.date);
    }
  }
  return dates;
}

function validate(input: Input, projected: TrainingCandidateDiffV1) {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const unknowns: Issue[] = [];
  const { before, proposed, asOfLocalDate, completions } = input;
  if (
    projected.title === null &&
    projected.periodChanges.length === 0 &&
    projected.sessionChanges.length === 0 &&
    before.draft.timezone === proposed.timezone
  )
    errors.push(issue('NO_CHANGE', planSubject));
  if (before.draft.timezone !== proposed.timezone)
    errors.push(issue('PLAN_TIMEZONE_CHANGED', planSubject));

  for (const change of projected.sessionChanges) {
    const subject: Subject = { kind: 'session', id: change.id };
    if (
      (change.before !== null && change.before.date < asOfLocalDate) ||
      (change.after !== null && change.after.date < asOfLocalDate)
    )
      errors.push(issue('PAST_SESSION_CHANGED', subject));
    if (
      change.before !== null &&
      !preservesSessionLocks(
        { ...before.draft, sessions: [change.before] },
        { ...proposed, sessions: change.after === null ? [] : [change.after] },
      )
    )
      errors.push(issue('SESSION_LOCKED', subject));
    if (
      completions.some(
        (completion) =>
          completion.sessionId === change.id &&
          completion.status === 'completed' &&
          !preservesSessionCompletions(proposed, [completion]),
      )
    )
      errors.push(issue('COMPLETED_SESSION_CHANGED', subject));
  }
  for (const change of projected.periodChanges) {
    const old = change.before;
    const next = change.after;
    // A past period's original purpose and constraint history are also frozen.
    if (
      (old !== null && old.startDate < asOfLocalDate) ||
      (next !== null && next.startDate < asOfLocalDate)
    )
      errors.push(issue('PAST_PERIOD_CHANGED', planSubject));
  }
  if (before.draft.timezone !== proposed.timezone) {
    for (const completion of completions) {
      if (completion.status === 'completed' && !preservesSessionCompletions(proposed, [completion]))
        errors.push(
          issue('COMPLETED_SESSION_CHANGED', { kind: 'session', id: completion.sessionId }),
        );
    }
  }

  const previousConstraints = new Map(
    evaluatePlanConstraints(before.draft).map((day) => [day.date, day]),
  );
  const affectedDates = changedConstraintDates(projected.periodChanges);
  for (const change of projected.sessionChanges) {
    if (change.before) affectedDates.add(change.before.date);
    if (change.after) affectedDates.add(change.after.date);
  }
  for (const day of evaluatePlanConstraints(proposed)) {
    const subject: Subject = { kind: 'date', date: day.date };
    if (day.unavailableConflict || day.exceedsAvailableTime) {
      if (affectedDates.has(day.date) || previousConstraints.get(day.date)?.status !== 'conflict') {
        if (day.unavailableConflict) errors.push(issue('CONSTRAINT_UNAVAILABLE', subject));
        if (day.exceedsAvailableTime) errors.push(issue('CONSTRAINT_TIME_EXCEEDED', subject));
      } else warnings.push(issue('PREEXISTING_CONSTRAINT_CONFLICT', subject));
    } else if (day.status === 'unknown') unknowns.push(issue('CONSTRAINT_TIME_UNCERTAIN', subject));
  }
  for (const session of proposed.sessions) {
    if (sessionDurationBounds(session) === null || sessionDistanceBounds(session) === null)
      unknowns.push(issue('TARGET_UNKNOWN', { kind: 'session', id: session.id }));
  }
  return {
    definitionVersion: 'training-candidate-validation-v1' as const,
    status:
      errors.length > 0
        ? ('invalid' as const)
        : unknowns.length > 0
          ? ('uncertain' as const)
          : ('checked' as const),
    errors,
    warnings,
    unknowns,
  };
}

export type TrainingCandidateProjectionResult =
  | { ok: true; draft: TrainingCandidateDraftV1 }
  | {
      ok: false;
      reason:
        | 'INVALID_INPUT'
        | 'PLAN_VERSION_MISMATCH'
        | 'INVALID_COMPLETION_BASIS'
        | 'PROJECTION_FAILED';
    };

/** Structural projection only. Run output and client-supplied drafts cannot confer decision authority. */
export function projectTrainingCandidateV1(input: unknown): TrainingCandidateProjectionResult {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'INVALID_INPUT' };
  const value = parsed.data;
  if (value.before.id !== value.basis.planVersionId)
    return { ok: false, reason: 'PLAN_VERSION_MISMATCH' };
  if (
    new Set(value.completions.map((completion) => completion.sessionId)).size !==
      value.completions.length ||
    value.completions.some(
      (completion) =>
        completion.status === 'completed' &&
        !value.before.draft.sessions.some((session) => session.id === completion.sessionId),
    ) ||
    (value.completions.length > 0 && value.basis.dependencies.sessionCompletions.kind === 'absent')
  )
    return { ok: false, reason: 'INVALID_COMPLETION_BASIS' };
  try {
    const projected = diff(value.before.draft, value.proposed);
    const draft = trainingCandidateDraftV1Schema.parse({
      schemaVersion: 1,
      scope: 'running-core-v2-training',
      basis: value.basis,
      before: value.before,
      proposed: value.proposed,
      asOfLocalDate: value.asOfLocalDate,
      strategy: value.strategy,
      diff: projected,
      validation: validate(value, projected),
    });
    return { ok: true, draft };
  } catch {
    return { ok: false, reason: 'PROJECTION_FAILED' };
  }
}
