import { z } from 'zod';

import { dayProjectionSchema } from './core.js';
import {
  idSchema,
  localDateSchema,
  instantSchema,
  timeZoneSchema,
  localTimeSchema,
  revisionSchema,
  nonNegativeNumberSchema,
  positiveIntegerSchema,
  nonEmptyStringSchema,
} from './primitives.js';

export const layoutModeSchema = z.enum(['mobile', 'tablet', 'desktop']);
export type LayoutMode = z.infer<typeof layoutModeSchema>;
export const extraModuleIdSchema = z.enum(['nutrition', 'supplementary']);
export type ExtraModuleId = z.infer<typeof extraModuleIdSchema>;
export const integratedDayProjectionSchema = dayProjectionSchema
  .safeExtend({
    schemaVersion: z.literal(2),
    nutritionPlanItemIds: z.array(idSchema),
    intakeEntryIds: z.array(idSchema),
    supplementarySessionIds: z.array(idSchema),
  })
  .refine((day) => day.supplementarySessionIds.every((id) => day.plannedSessionIds.includes(id)), {
    message: 'Supplementary sessions must be a subset of planned sessions',
    path: ['supplementarySessionIds'],
  });
export type IntegratedDayProjection = z.infer<typeof integratedDayProjectionSchema>;

/** Unknown measurements remain null; a reported zero is still a known observation. */
export function metricDatumSchema<const U extends string>(unit: U) {
  return z
    .strictObject({
      value: nonNegativeNumberSchema.nullable(),
      unit: z.literal(unit),
      status: z.enum(['reported', 'measured', 'estimated', 'unknown']),
      evidenceIds: z.array(idSchema),
    })
    .refine((datum) => (datum.status === 'unknown') === (datum.value === null), {
      message: 'Unknown measurements require null; known measurements require a value',
      path: ['value'],
    });
}
export type MetricDatum<U extends string> = z.infer<ReturnType<typeof metricDatumSchema<U>>>;
export function numericTargetSchema<const U extends string>(unit: U) {
  return z
    .strictObject({
      min: nonNegativeNumberSchema,
      max: nonNegativeNumberSchema,
      unit: z.literal(unit),
      basis: z.enum(['user_confirmed', 'reviewed_rule', 'draft_suggestion']),
      evidenceIds: z.array(idSchema),
    })
    .refine((target) => target.min <= target.max, {
      message: 'Target min must not exceed max',
      path: ['max'],
    });
}
export type NumericTarget<U extends string> = z.infer<ReturnType<typeof numericTargetSchema<U>>>;
export const nutrientSnapshotSchema = z.strictObject({
  energy: metricDatumSchema('kcal'),
  carbohydrate: metricDatumSchema('g'),
  protein: metricDatumSchema('g'),
  fat: metricDatumSchema('g'),
  fluid: metricDatumSchema('mL'),
  sodium: metricDatumSchema('mg'),
});
export type NutrientSnapshot = z.infer<typeof nutrientSnapshotSchema>;
export const nutritionAnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('absolute'),
    date: localDateSchema,
    localTime: localTimeSchema.nullable(),
    timezone: timeZoneSchema,
  }),
  z.strictObject({
    kind: z.literal('relative'),
    entity: z.enum(['session', 'race']),
    entityId: idSchema,
    point: z.enum(['start', 'end']),
    offsetMinutes: z.number().finite(),
  }),
]);
export type NutritionAnchor = z.infer<typeof nutritionAnchorSchema>;
export const foodPortionSchema = z.strictObject({
  foodVersionId: idSchema.nullable(),
  description: nonEmptyStringSchema,
  quantity: nonNegativeNumberSchema.nullable(),
  unit: z.enum(['g', 'mL', 'serving', 'piece', 'unspecified']),
  sourceBasis: z.enum(['per_100g', 'per_100mL', 'per_serving', 'manual_total', 'unknown']),
});
export type FoodPortion = z.infer<typeof foodPortionSchema>;
const nutrientTargetSchema = z.discriminatedUnion('metric', [
  z.strictObject({ metric: z.literal('energy'), amount: numericTargetSchema('kcal') }),
  z.strictObject({ metric: z.literal('carbohydrate'), amount: numericTargetSchema('g') }),
  z.strictObject({ metric: z.literal('protein'), amount: numericTargetSchema('g') }),
  z.strictObject({ metric: z.literal('fat'), amount: numericTargetSchema('g') }),
  z.strictObject({ metric: z.literal('fluid'), amount: numericTargetSchema('mL') }),
  z.strictObject({ metric: z.literal('sodium'), amount: numericTargetSchema('mg') }),
]);
export const nutritionPlanItemSchema = z.strictObject({
  id: idSchema,
  planVersionId: idSchema,
  category: z.enum(['meal', 'snack', 'before', 'during', 'after', 'hydration']),
  title: nonEmptyStringSchema,
  anchor: nutritionAnchorSchema,
  foods: z.array(foodPortionSchema),
  targets: z.array(nutrientTargetSchema),
  instructions: z.string(),
  evidenceIds: z.array(idSchema),
});
export type NutritionPlanItem = z.infer<typeof nutritionPlanItemSchema>;
export const intakeEntryRevisionSchema = z
  .strictObject({
    intakeId: idSchema,
    revisionId: idSchema,
    occurredAt: instantSchema,
    recordedAt: instantSchema,
    timezone: timeZoneSchema,
    foods: z.array(foodPortionSchema),
    nutrientTotal: nutrientSnapshotSchema,
    plannedItemId: idSchema.nullable(),
    relatedSessionIds: z.array(idSchema),
    relatedActivityIds: z.array(idSchema),
    source: z.enum(['user', 'provider', 'user_confirmed_extraction']),
    sourceRecordId: nonEmptyStringSchema.nullable(),
    notes: z.string().nullable(),
  })
  .refine((entry) => Date.parse(entry.occurredAt) <= Date.parse(entry.recordedAt), {
    message: 'Recording cannot precede occurrence',
    path: ['recordedAt'],
  });
export type IntakeEntryRevision = z.infer<typeof intakeEntryRevisionSchema>;
export const intakeCoverageSchema = z
  .strictObject({
    from: instantSchema,
    toExclusive: instantSchema,
    status: z.enum(['unknown', 'partial', 'user_marked_complete']),
    knownEntries: revisionSchema,
    entriesWithUnknownNutrients: revisionSchema,
  })
  .refine((coverage) => Date.parse(coverage.from) < Date.parse(coverage.toExclusive), {
    message: 'Coverage range must be ordered',
    path: ['toExclusive'],
  })
  .refine((coverage) => coverage.entriesWithUnknownNutrients <= coverage.knownEntries, {
    message: 'Unknown nutrient entries cannot exceed known entries',
    path: ['entriesWithUnknownNutrients'],
  });
export type IntakeCoverage = z.infer<typeof intakeCoverageSchema>;
export const exerciseFamilySchema = z.enum([
  'resistance',
  'plyometric',
  'mobility',
  'balance_stability',
  'activation',
  'other',
]);
export type ExerciseFamily = z.infer<typeof exerciseFamilySchema>;
export const equipmentSchema = z.enum([
  'bodyweight',
  'dumbbell',
  'barbell',
  'machine',
  'band',
  'other',
]);
export type Equipment = z.infer<typeof equipmentSchema>;
export const sideSchema = z.enum(['bilateral', 'left', 'right', 'alternating', 'unspecified']);
export type Side = z.infer<typeof sideSchema>;
export const countDefinitionSchema = z.strictObject({
  kind: z.enum(['repetitions', 'jumps', 'landing_events', 'foot_contacts']),
  basis: z.enum(['total', 'per_side', 'unspecified']),
  definitionId: idSchema,
});
export type CountDefinition = z.infer<typeof countDefinitionSchema>;
export const externalResistanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no_added_load') }),
  z.strictObject({
    kind: z.enum(['external', 'weighted_bodyweight']),
    totalKg: metricDatumSchema('kg'),
  }),
  z.strictObject({ kind: z.literal('assisted'), assistanceKg: metricDatumSchema('kg') }),
  z.strictObject({
    kind: z.literal('band_or_machine_level'),
    setting: nonEmptyStringSchema,
    equipmentVersionId: idSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type ExternalResistance = z.infer<typeof externalResistanceSchema>;
export const exerciseDefinitionVersionSchema = z.strictObject({
  exerciseId: idSchema,
  versionId: idSchema,
  name: nonEmptyStringSchema,
  family: exerciseFamilySchema,
  equipment: z.array(equipmentSchema),
  tags: z.array(nonEmptyStringSchema),
  countDefinitions: z.array(countDefinitionSchema),
  mediaAssetIds: z.array(idSchema),
  resourceVersionIds: z.array(idSchema),
  reviewState: z.enum(['unreviewed', 'reviewed', 'withdrawn']),
});
export type ExerciseDefinitionVersion = z.infer<typeof exerciseDefinitionVersionSchema>;
const effortSchema = z.strictObject({
  rir: nonNegativeNumberSchema.nullable(),
  rpe: nonNegativeNumberSchema.max(10).nullable(),
  scaleVersion: nonEmptyStringSchema,
});
export const setTargetSchema = z.strictObject({
  id: idSchema,
  exerciseVersionId: idSchema,
  side: sideSchema,
  count: z
    .strictObject({ target: numericTargetSchema('count'), definition: countDefinitionSchema })
    .nullable(),
  durationSeconds: numericTargetSchema('s').nullable(),
  externalResistance: externalResistanceSchema,
  restAfterSeconds: nonNegativeNumberSchema.nullable(),
  tempo: z
    .strictObject({
      eccentricSeconds: nonNegativeNumberSchema.nullable(),
      bottomSeconds: nonNegativeNumberSchema.nullable(),
      concentricSeconds: nonNegativeNumberSchema.nullable(),
      topSeconds: nonNegativeNumberSchema.nullable(),
      intent: z.string().nullable(),
    })
    .nullable(),
  effort: effortSchema.nullable(),
});
export type SetTarget = z.infer<typeof setTargetSchema>;
export const supplementaryWorkoutSpecSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('supplementary'),
  routineVersionId: idSchema.nullable(),
  blocks: z.array(
    z.strictObject({
      id: idSchema,
      mode: z.enum(['single', 'superset', 'circuit']),
      rounds: positiveIntegerSchema,
      sets: z.array(setTargetSchema),
      restBetweenRoundsSeconds: nonNegativeNumberSchema.nullable(),
    }),
  ),
});
export type SupplementaryWorkoutSpec = z.infer<typeof supplementaryWorkoutSpecSchema>;
export const setLogRevisionSchema = z
  .strictObject({
    logId: idSchema,
    revisionId: idSchema,
    activityId: idSchema,
    executionId: idSchema,
    targetSetId: idSchema.nullable(),
    blockId: idSchema.nullable(),
    roundIndex: revisionSchema.nullable(),
    exerciseVersionId: idSchema,
    side: sideSchema,
    state: z.enum(['performed', 'partial', 'confirmed_skipped', 'stopped', 'unconfirmed']),
    count: z
      .strictObject({ actual: metricDatumSchema('count'), definition: countDefinitionSchema })
      .nullable(),
    durationSeconds: metricDatumSchema('s'),
    externalResistance: externalResistanceSchema,
    effort: effortSchema,
    occurredAt: instantSchema,
    recordedAt: instantSchema,
    reason: z.string().nullable(),
  })
  .refine((log) => Date.parse(log.occurredAt) <= Date.parse(log.recordedAt), {
    message: 'Recording cannot precede occurrence',
    path: ['recordedAt'],
  });
export type SetLogRevision = z.infer<typeof setLogRevisionSchema>;
export const executionTimerStateSchema = z
  .strictObject({
    startedAt: instantSchema,
    deadlineAt: instantSchema.nullable(),
    pausedAt: instantSchema.nullable(),
    remainingWhenPausedSeconds: nonNegativeNumberSchema.nullable(),
    status: z.enum(['running', 'paused', 'finished']),
  })
  .superRefine((timer, ctx) => {
    if (
      (timer.status === 'paused') !==
        (timer.pausedAt !== null && timer.remainingWhenPausedSeconds !== null) ||
      (timer.status !== 'paused' &&
        (timer.pausedAt !== null || timer.remainingWhenPausedSeconds !== null))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only paused timers require pause time and remaining duration',
        path: ['pausedAt'],
      });
    }
    for (const key of ['deadlineAt', 'pausedAt'] as const) {
      const instant = timer[key];
      if (instant !== null && Date.parse(instant) < Date.parse(timer.startedAt)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Timer timestamps cannot precede start',
          path: [key],
        });
      }
    }
  });
export type ExecutionTimerState = z.infer<typeof executionTimerStateSchema>;
export const trainingDomainBasisSchema = z.strictObject({
  planVersionId: idSchema,
  activityDataRevision: revisionSchema,
  exerciseCatalogRevision: revisionSchema,
});
export type TrainingDomainBasis = z.infer<typeof trainingDomainBasisSchema>;
export const nutritionDomainBasisSchema = z.strictObject({
  planVersionId: idSchema.nullable(),
  intakeDataRevision: revisionSchema,
  foodCatalogRevision: revisionSchema,
});
export type NutritionDomainBasis = z.infer<typeof nutritionDomainBasisSchema>;
export const jointDomainsSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('training'),
    training: trainingDomainBasisSchema,
    nutrition: z.null(),
  }),
  z.strictObject({
    scope: z.literal('nutrition'),
    training: z.null(),
    nutrition: nutritionDomainBasisSchema,
  }),
  z.strictObject({
    scope: z.literal('combined'),
    training: trainingDomainBasisSchema,
    nutrition: nutritionDomainBasisSchema,
  }),
]);
export type JointDomains = z.infer<typeof jointDomainsSchema>;
export const jointCoachingBasisSchema = z.strictObject({
  schemaVersion: z.literal(3),
  domains: jointDomainsSchema,
  contextDependencies: z.array(
    z.strictObject({ kind: nonEmptyStringSchema, id: idSchema, revision: nonEmptyStringSchema }),
  ),
  preferenceRevision: revisionSchema,
  constraintRevision: revisionSchema,
  conversationRevision: revisionSchema,
  policyVersion: nonEmptyStringSchema,
  evidenceSnapshotId: idSchema,
});
export type JointCoachingBasis = z.infer<typeof jointCoachingBasisSchema>;
export const jointApprovalRequestSchema = z.strictObject({
  schemaVersion: z.literal(3),
  proposalId: idSchema,
  candidateId: idSchema,
  proposalDigest: nonEmptyStringSchema,
  expectedBasis: jointCoachingBasisSchema,
  idempotencyKey: nonEmptyStringSchema,
});
export type JointApprovalRequest = z.infer<typeof jointApprovalRequestSchema>;
