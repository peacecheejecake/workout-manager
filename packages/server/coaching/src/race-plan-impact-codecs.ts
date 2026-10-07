import { z } from 'zod';
import {
  planDraftSchema,
  planSnapshotSchema,
  periodDraftSchema,
  plannedSessionSchema,
} from '@workout/contracts/planning';
import { localDateSchema } from '@workout/contracts/primitives';
import { raceEventSchema } from '@workout/contracts/races';

export const racePlanImpactReasonSchema = z.enum([
  'invalid_input',
  'unsupported_calendar',
  'projection_bound',
  'missing_current_plan',
  'current_plan_mismatch',
  'missing_period',
  'outside_parent',
  'sibling_overlap',
  'child_outside_period',
  'fixed_session_outside_block',
  'constraints_outside_period',
  'locked',
  'completed',
  'invalid_result',
]);
const date = localDateSchema.refine((value) => value >= '0001-01-01', 'Unsupported calendar year');
const periodId = periodDraftSchema.shape.id;
const sessionId = plannedSessionSchema.shape.id;
const periodIds = z
  .array(periodId)
  .max(100)
  .refine((values) => new Set(values).size === values.length, 'Duplicate period IDs');
const sessionIds = z
  .array(sessionId)
  .max(1000)
  .refine((values) => new Set(values).size === values.length, 'Duplicate session IDs');
const quantity = z.number().finite().nonnegative();
const availableSeconds =
  periodDraftSchema.shape.constraints.unwrap().shape.dailyTimeLimits.element.shape.availableSeconds;
export const racePlanConstraintDaySchema = z
  .strictObject({
    date,
    unavailablePeriodIds: periodIds,
    timeLimitSources: z.array(z.strictObject({ periodId, availableSeconds })).max(100),
    availableSeconds: availableSeconds.nullable(),
    sessionIds,
    knownDurationSeconds: quantity,
    durationRangeSeconds: z
      .strictObject({ min: quantity, max: quantity })
      .refine((value) => value.min <= value.max, 'Reversed duration bounds')
      .nullable(),
    rangeDurationSessionIds: sessionIds,
    unknownDurationSessionIds: sessionIds,
    unavailableConflict: z.boolean(),
    exceedsAvailableTime: z.boolean(),
    possibleTimeExcess: z.boolean(),
    status: z.enum(['conflict', 'unknown', 'no_conflict']),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.timeLimitSources.map((row) => row.periodId)).size !==
      value.timeLimitSources.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate time-limit source' });
    if (
      [...value.rangeDurationSessionIds, ...value.unknownDurationSessionIds].some(
        (id) => !value.sessionIds.includes(id),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duration classification requires day session membership',
      });
    if (value.rangeDurationSessionIds.some((id) => value.unknownDurationSessionIds.includes(id)))
      ctx.addIssue({ code: 'custom', message: 'Range and unknown are distinct duration states' });
  });
const interval = z
  .strictObject({ startDate: date, endDateExclusive: date })
  .refine((value) => value.startDate < value.endDateExclusive, 'Empty period interval');
export const racePlanImpactProjectedSchema = z
  .strictObject({
    status: z.literal('projected'),
    approval: z.strictObject({
      status: z.literal('blocked'),
      reasons: z.tuple([
        z.literal('affected_schedule_collection_missing'),
        z.literal('complete_dependency_manifest_missing'),
        z.literal('atomic_approval_missing'),
      ]),
    }),
    eventDate: z.strictObject({
      before: date,
      after: date,
      deltaCalendarDays: z.number().int().min(-3660).max(3660),
    }),
    linkedPlan: z.strictObject({
      versionId: raceEventSchema.shape.planVersionId,
      relationship: z.enum(['unlinked', 'current', 'historical_or_other']),
    }),
    currentPlanVersionId: planSnapshotSchema.shape.id.nullable(),
    plan: planDraftSchema.nullable(),
    periodDiffs: z
      .array(z.strictObject({ id: periodId, before: interval, after: interval }))
      .max(100),
    sessionDiffs: z
      .array(z.strictObject({ id: sessionId, beforeDate: date, afterDate: date }))
      .max(1000),
    fixedSessionIds: sessionIds,
    // Each of 100 source periods has up to 3660 unavailable dates and 3660 time limits.
    constraintDays: z.array(racePlanConstraintDaySchema).max(732000),
  })
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      (Date.parse(`${value.eventDate.after}T00:00:00.000Z`) -
        Date.parse(`${value.eventDate.before}T00:00:00.000Z`)) /
        86400000 !==
      value.eventDate.deltaCalendarDays
    )
      fail('Calendar delta does not match dates');
    if ((value.plan === null) !== (value.currentPlanVersionId === null))
      fail('Current plan presence mismatch');
    if (
      value.linkedPlan.relationship !==
      (value.linkedPlan.versionId === null
        ? 'unlinked'
        : value.linkedPlan.versionId === value.currentPlanVersionId
          ? 'current'
          : 'historical_or_other')
    )
      fail('Linked-plan relationship mismatch');
    if (
      new Set(value.periodDiffs.map((row) => row.id)).size !== value.periodDiffs.length ||
      new Set(value.sessionDiffs.map((row) => row.id)).size !== value.sessionDiffs.length ||
      new Set(value.constraintDays.map((row) => row.date)).size !== value.constraintDays.length
    )
      fail('Duplicate projection rows');
    if (!value.plan) {
      if (
        value.periodDiffs.length ||
        value.sessionDiffs.length ||
        value.fixedSessionIds.length ||
        value.constraintDays.length
      )
        fail('Absent plan has projection rows');
      return;
    }
    const periods = new Map(value.plan.periods.map((row) => [row.id, row])),
      sessions = new Map(value.plan.sessions.map((row) => [row.id, row]));
    for (const row of value.periodDiffs) {
      const period = periods.get(row.id);
      if (
        !period ||
        period.startDate !== row.after.startDate ||
        period.endDateExclusive !== row.after.endDateExclusive
      )
        fail('Period diff does not match projected plan');
    }
    for (const row of value.sessionDiffs) {
      if (sessions.get(row.id)?.date !== row.afterDate)
        fail('Session diff does not match projected plan');
    }
    if (value.fixedSessionIds.some((id) => !sessions.has(id)))
      fail('Fixed session is not in projected plan');
    for (const day of value.constraintDays) {
      if (
        day.unavailablePeriodIds.some((id) => !periods.has(id)) ||
        day.timeLimitSources.some((row) => !periods.has(row.periodId)) ||
        day.sessionIds.some((id) => sessions.get(id)?.date !== day.date)
      )
        fail('Constraint-day source is not in projected plan');
    }
  });
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('rejected'), reason: racePlanImpactReasonSchema }),
  racePlanImpactProjectedSchema,
]);

/** Bounded successor JSON boundary, not a claim that every theoretically large legacy
 * projector output fits this envelope. A decoded calendar result authenticates no source,
 * checks no later freshness and never grants approval or actual-performance authority. */
export const racePlanImpactResultSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 4194304)
        throw Error('bound');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Calendar result exceeds JSON boundary' });
    }
  })
  .pipe(resultSchema);
export type RacePlanImpactResult = z.infer<typeof racePlanImpactResultSchema>;
