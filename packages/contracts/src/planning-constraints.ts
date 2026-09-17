import { planDraftSchema, type PlanDraft } from './planning.js';

export interface PlanConstraintDay {
  date: string;
  unavailablePeriodIds: string[];
  timeLimitSources: { periodId: string; availableSeconds: number }[];
  availableSeconds: number | null;
  sessionIds: string[];
  knownDurationSeconds: number;
  unknownDurationSessionIds: string[];
  unavailableConflict: boolean;
  exceedsAvailableTime: boolean;
  status: 'conflict' | 'unknown' | 'no_conflict';
}

/**
 * Evaluate only explicitly constrained dates. Valid sibling periods cannot overlap,
 * so all periods applicable on one date form a single ancestor path. Sessions are
 * counted once by their plan-local date; steps and actuals never enter this sum.
 * Warnings do not authorize schedule changes or prevent explicit manual storage.
 */
export function evaluatePlanConstraints(input: PlanDraft): PlanConstraintDay[] {
  const draft = planDraftSchema.parse(input);
  const days = new Map<string, PlanConstraintDay>();
  const getDay = (date: string) => {
    let day = days.get(date);
    if (!day) {
      day = {
        date,
        unavailablePeriodIds: [],
        timeLimitSources: [],
        availableSeconds: null,
        sessionIds: [],
        knownDurationSeconds: 0,
        unknownDurationSessionIds: [],
        unavailableConflict: false,
        exceedsAvailableTime: false,
        status: 'no_conflict',
      };
      days.set(date, day);
    }
    return day;
  };
  for (const period of draft.periods) {
    for (const date of period.constraints?.unavailableDates ?? [])
      getDay(date).unavailablePeriodIds.push(period.id);
    for (const limit of period.constraints?.dailyTimeLimits ?? []) {
      const day = getDay(limit.date);
      day.timeLimitSources.push({ periodId: period.id, availableSeconds: limit.availableSeconds });
      day.availableSeconds = Math.min(
        day.availableSeconds ?? limit.availableSeconds,
        limit.availableSeconds,
      );
    }
  }
  for (const session of draft.sessions) {
    const day = days.get(session.date);
    if (!day) continue;
    day.sessionIds.push(session.id);
    if (session.durationSeconds === null) day.unknownDurationSessionIds.push(session.id);
    else day.knownDurationSeconds += session.durationSeconds;
  }
  for (const day of days.values()) {
    day.unavailablePeriodIds.sort();
    day.timeLimitSources.sort((a, b) => a.periodId.localeCompare(b.periodId));
    day.sessionIds.sort();
    day.unknownDurationSessionIds.sort();
    day.unavailableConflict = day.unavailablePeriodIds.length > 0 && day.sessionIds.length > 0;
    day.exceedsAvailableTime =
      day.availableSeconds !== null && day.knownDurationSeconds > day.availableSeconds;
    day.status =
      day.unavailableConflict || day.exceedsAvailableTime
        ? 'conflict'
        : day.availableSeconds !== null && day.unknownDurationSessionIds.length > 0
          ? 'unknown'
          : 'no_conflict';
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
