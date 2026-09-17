import {
  planDraftSchema,
  sessionDurationBounds,
  sumTargetQuantities,
  type PlanDraft,
} from './planning.js';

export interface PlanConstraintDay {
  date: string;
  unavailablePeriodIds: string[];
  timeLimitSources: { periodId: string; availableSeconds: number }[];
  availableSeconds: number | null;
  sessionIds: string[];
  knownDurationSeconds: number;
  durationRangeSeconds: { min: number; max: number } | null;
  rangeDurationSessionIds: string[];
  unknownDurationSessionIds: string[];
  unavailableConflict: boolean;
  exceedsAvailableTime: boolean;
  possibleTimeExcess: boolean;
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
  const quantities = new Map<string, { min: number[]; max: number[]; exact: number[] }>();
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
        durationRangeSeconds: null,
        rangeDurationSessionIds: [],
        unknownDurationSessionIds: [],
        unavailableConflict: false,
        exceedsAvailableTime: false,
        possibleTimeExcess: false,
        status: 'no_conflict',
      };
      days.set(date, day);
      quantities.set(date, { min: [], max: [], exact: [] });
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
    const bounds = sessionDurationBounds(session);
    if (bounds === null) day.unknownDurationSessionIds.push(session.id);
    else {
      const values = quantities.get(session.date);
      if (!values) throw new Error('Missing constrained date quantities');
      values.min.push(bounds.min);
      values.max.push(bounds.max);
      if (session.durationRange) day.rangeDurationSessionIds.push(session.id);
      else if (session.durationSeconds !== null) values.exact.push(session.durationSeconds);
    }
  }
  for (const day of days.values()) {
    const values = quantities.get(day.date);
    if (!values) throw new Error('Missing constrained date quantities');
    day.knownDurationSeconds = sumTargetQuantities(values.exact);
    day.durationRangeSeconds = values.min.length
      ? { min: sumTargetQuantities(values.min), max: sumTargetQuantities(values.max) }
      : null;
    day.unavailablePeriodIds.sort();
    day.timeLimitSources.sort((a, b) => a.periodId.localeCompare(b.periodId));
    day.sessionIds.sort();
    day.unknownDurationSessionIds.sort();
    day.rangeDurationSessionIds.sort();
    day.unavailableConflict = day.unavailablePeriodIds.length > 0 && day.sessionIds.length > 0;
    day.exceedsAvailableTime =
      day.availableSeconds !== null && (day.durationRangeSeconds?.min ?? 0) > day.availableSeconds;
    day.possibleTimeExcess =
      day.availableSeconds !== null &&
      !day.exceedsAvailableTime &&
      (day.durationRangeSeconds?.max ?? 0) > day.availableSeconds;
    day.status =
      day.unavailableConflict || day.exceedsAvailableTime
        ? 'conflict'
        : day.availableSeconds !== null &&
            (day.unknownDurationSessionIds.length > 0 || day.possibleTimeExcess)
          ? 'unknown'
          : 'no_conflict';
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
