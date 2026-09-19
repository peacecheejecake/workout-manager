import { z } from 'zod';

import { nutrientSnapshotSchema } from './nutrition.js';
import { plannedSessionSchema } from './planning.js';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  timeZoneSchema,
} from './primitives.js';

const count = z.number().int().nonnegative();
const metric = z
  .strictObject({
    value: z.number().finite().nonnegative().nullable(),
    knownCount: count,
    missingCount: count,
  })
  .refine((item) => (item.knownCount === 0) === (item.value === null));

/** One bounded local-calendar window. The timezone is explicit even without a training plan. */
export const integratedPlannerQuerySchema = z
  .strictObject({ from: localDateSchema, toExclusive: localDateSchema, timezone: timeZoneSchema })
  .refine((query) => {
    const days =
      (Date.parse(`${query.toExclusive}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) /
      86_400_000;
    return days >= 1 && days <= 93 && query.from >= '0001-01-01';
  }, 'Expected 1–93 local calendar days');
export type IntegratedPlannerQuery = z.infer<typeof integratedPlannerQuerySchema>;

export const integratedNutritionItemSchema = z.strictObject({
  id: idSchema,
  planVersionId: z.uuid(),
  title: z.string().min(1),
  category: z.enum(['meal', 'snack', 'before', 'during', 'after', 'hydration']),
  source: z.enum(['user_confirmed', 'reviewed_rule', 'draft_suggestion']),
  localTime: localTimeSchema.nullable(),
});
export type IntegratedNutritionItem = z.infer<typeof integratedNutritionItemSchema>;

export const unresolvedNutritionItemSchema = integratedNutritionItemSchema
  .omit({ localTime: true })
  .extend({
    reason: z.enum([
      'missing_anchor',
      'missing_session_time',
      'missing_session_duration',
      'ambiguous_local_time',
      'timezone_mismatch',
      'offset_out_of_range',
    ]),
  });
export type UnresolvedNutritionItem = z.infer<typeof unresolvedNutritionItemSchema>;

export const integratedActivitySchema = z.strictObject({
  activityId: z.uuid(),
  kind: z.enum(['running', 'cycling', 'walking', 'strength', 'other', 'unknown']),
  title: z.string().nullable(),
  startedAt: instantSchema,
  distanceMeters: z.number().finite().nonnegative().nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
  durationKind: z.enum(['timer', 'elapsed', 'moving', 'unknown']),
  hasSupplementaryDetail: z.boolean(),
});
export type IntegratedActivity = z.infer<typeof integratedActivitySchema>;

export const integratedIntakeSchema = z.strictObject({
  intakeId: idSchema,
  revision: z.number().int().positive(),
  occurredAt: instantSchema,
  nutrientTotal: nutrientSnapshotSchema,
});
export type IntegratedIntake = z.infer<typeof integratedIntakeSchema>;

const nutrients = z.strictObject({
  energyKcal: metric,
  carbohydrateGrams: metric,
  proteinGrams: metric,
  fatGrams: metric,
  fluidMl: metric,
  sodiumMg: metric,
});
export const integratedPlannerSummarySchema = z.strictObject({
  training: z.strictObject({
    plannedSessionCount: count,
    actualActivityCount: count,
    supplementaryActivityCount: count,
    distanceMeters: metric,
    durationSeconds: z.strictObject({
      timer: metric,
      elapsed: metric,
      moving: metric,
      unknown: metric,
    }),
  }),
  nutrition: z.strictObject({
    plannedItemCount: count,
    intakeCount: count,
    nutrients,
    intakeCoverage: z.literal('unknown'),
  }),
});
export type IntegratedPlannerSummary = z.infer<typeof integratedPlannerSummarySchema>;

export const integratedPlannerDaySchema = z.strictObject({
  date: localDateSchema,
  plannedSessions: z.array(plannedSessionSchema),
  nutritionItems: z.array(integratedNutritionItemSchema),
  activities: z.array(integratedActivitySchema),
  intakes: z.array(integratedIntakeSchema),
  summary: integratedPlannerSummarySchema,
});
export type IntegratedPlannerDay = z.infer<typeof integratedPlannerDaySchema>;

/** Planned rows never become actual rows by projection. An Activity is counted once even with set detail. */
export const integratedPlannerReadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  from: localDateSchema,
  toExclusive: localDateSchema,
  timezone: timeZoneSchema,
  trainingPlanVersionId: z.uuid().nullable(),
  nutritionPlanVersionIds: z.array(z.uuid()),
  days: z.array(integratedPlannerDaySchema).min(1).max(93),
  unresolvedNutritionItems: z.array(unresolvedNutritionItemSchema),
  unplacedActivityCount: count,
  summary: integratedPlannerSummarySchema,
});
export type IntegratedPlannerRead = z.infer<typeof integratedPlannerReadSchema>;

export const integratedRecoveryPlanSchema = z.strictObject({
  strategyId: z.uuid(),
  versionId: z.uuid(),
  title: z.string().min(1),
  selectedOptionId: z.uuid(),
});
export const integratedRecoveryActionSchema = z.strictObject({
  actionId: z.uuid(),
  revision: z.number().int().positive(),
  occurredAt: instantSchema,
  state: z.enum(['performed', 'partial', 'confirmed_skipped', 'stopped', 'unconfirmed']),
  methodVersionId: z.uuid(),
});
export const integratedRoutineOccurrenceSchema = z.strictObject({
  occurrenceId: z.uuid(),
  scheduleId: z.uuid(),
  scheduleVersionId: z.uuid(),
  blueprintVersionId: z.uuid(),
  scheduledAt: instantSchema,
});
export const integratedRoutineRunSchema = z.strictObject({
  runId: z.uuid(),
  revision: z.number().int().nonnegative(),
  state: z.enum(['in_progress', 'paused', 'ended', 'stopped']),
  occurrenceId: z.uuid().nullable(),
});
export const integratedPlannerDayV4Schema = integratedPlannerDaySchema.extend({
  recoveryPlans: z.array(integratedRecoveryPlanSchema),
  recoveryActions: z.array(integratedRecoveryActionSchema),
  routineOccurrences: z.array(integratedRoutineOccurrenceSchema),
  routineRuns: z.array(integratedRoutineRunSchema),
  stretchingActivityIds: z.array(z.uuid()),
});
export const integratedPlannerSummaryV4Schema = integratedPlannerSummarySchema.extend({
  recovery: z.strictObject({ plannedStrategyCount: count, actualActionCount: count }),
  routines: z.strictObject({ occurrenceCount: count, runCount: count }),
  stretchingActivityCount: count,
});
export const integratedPlannerReadV4Schema = integratedPlannerReadSchema
  .omit({ schemaVersion: true, days: true, summary: true })
  .extend({
    schemaVersion: z.literal(4),
    recoveryStrategyVersionIds: z.array(z.uuid()),
    routineScheduleVersionIds: z.array(z.uuid()),
    days: z.array(integratedPlannerDayV4Schema).min(1).max(93),
    summary: integratedPlannerSummaryV4Schema,
  });
export type IntegratedPlannerReadV4 = z.infer<typeof integratedPlannerReadV4Schema>;
