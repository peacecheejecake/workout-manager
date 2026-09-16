import { z } from 'zod';
import { dayProjectionSchema } from './core.js';
import {
  exerciseDefinitionVersionSchema,
  metricDatumSchema,
  numericTargetSchema,
  sideSchema,
} from './nutrition.js';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  nonEmptyStringSchema,
  nonNegativeNumberSchema,
  positiveIntegerSchema,
  revisionSchema,
  timeZoneSchema,
} from './primitives.js';

const uniqueIds = z
  .array(idSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate IDs');
function unique<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}
export const versionRefSchema = z.strictObject({ id: idSchema, versionId: idSchema });
export const planDomainSchema = z.enum(['training', 'nutrition', 'recovery', 'routine_schedule']);
export const domainPlanRefSchema = z.strictObject({
  domain: planDomainSchema,
  planId: idSchema,
  versionId: idSchema,
  itemId: idSchema,
});
export const dependencyRefSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  id: idSchema,
  revision: nonEmptyStringSchema,
});
export const integratedDayV023Schema = dayProjectionSchema.extend({
  schemaVersion: z.literal(4),
  nutritionPlanItemIds: uniqueIds,
  intakeEntryIds: uniqueIds,
  recoveryPlanItemIds: uniqueIds,
  recoveryActionLogIds: uniqueIds,
  routineOccurrenceIds: uniqueIds,
  routineRunIds: uniqueIds,
  stretchingSessionIds: uniqueIds,
});
export const routineStepContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workout_template'), ref: versionRefSchema }),
  z.strictObject({ kind: z.literal('nutrition_template'), ref: versionRefSchema }),
  z.strictObject({ kind: z.literal('recovery_method'), ref: versionRefSchema }),
  z.strictObject({ kind: z.literal('checkin_template'), ref: versionRefSchema }),
  z.strictObject({ kind: z.literal('checklist'), prompt: nonEmptyStringSchema }),
]);
export const stepTimingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ordered'), afterStepId: idSchema.nullable() }),
  z.strictObject({
    kind: z.literal('anchor_relative'),
    point: z.enum(['start', 'end']),
    offsetMinutes: z.number(),
  }),
  z.strictObject({ kind: z.literal('user_scheduled') }),
]);
export const routineBlueprintStepSchema = z.strictObject({
  id: idSchema,
  title: nonEmptyStringSchema,
  content: routineStepContentSchema,
  timing: stepTimingSchema,
  required: z.boolean(),
  choiceGroupId: idSchema.nullable(),
});
export const routineBlueprintVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(4),
    routineId: idSchema,
    versionId: idSchema,
    title: nonEmptyStringSchema,
    intent: z.string(),
    status: z.enum(['draft', 'published', 'archived']),
    tags: z.array(nonEmptyStringSchema),
    steps: z.array(routineBlueprintStepSchema),
    choiceGroups: z.array(
      z.strictObject({ id: idSchema, mode: z.literal('one_of'), stepIds: uniqueIds.min(2) }),
    ),
    estimatedDurationSeconds: nonNegativeNumberSchema.nullable(),
    createdAt: instantSchema,
  })
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (!unique(value.steps, (step) => step.id)) fail('Duplicate step IDs');
    if (!unique(value.choiceGroups, (group) => group.id)) fail('Duplicate choice group IDs');
    const steps = new Map(value.steps.map((step) => [step.id, step]));
    const groups = new Map(value.choiceGroups.map((group) => [group.id, group]));
    for (const group of value.choiceGroups) {
      if (group.stepIds.some((id) => steps.get(id)?.choiceGroupId !== group.id))
        fail('Choice group membership mismatch');
    }
    for (const step of value.steps) {
      if (step.choiceGroupId !== null && !groups.get(step.choiceGroupId)?.stepIds.includes(step.id))
        fail('Missing choice group membership');
      const visited = new Set<string>([step.id]);
      let timing = step.timing;
      while (timing.kind === 'ordered' && timing.afterStepId !== null) {
        const parent = steps.get(timing.afterStepId);
        if (!parent) {
          fail('Unknown predecessor step');
          break;
        }
        if (visited.has(parent.id)) {
          fail('Cyclic step ordering');
          break;
        }
        visited.add(parent.id);
        timing = parent.timing;
      }
    }
  });
export const finiteExpansionWindowSchema = z
  .strictObject({
    startDate: localDateSchema,
    endDateExclusive: localDateSchema,
    timezone: timeZoneSchema,
    maxOccurrences: positiveIntegerSchema,
  })
  .refine((value) => value.startDate < value.endDateExclusive, 'Expansion window must be nonempty');
export const routineScheduleRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('dates'),
    dates: z
      .array(localDateSchema)
      .min(1)
      .refine((dates) => unique(dates, (date) => date), 'Duplicate dates'),
    localTime: localTimeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('weekdays'),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .refine((days) => new Set(days).size === days.length, 'Duplicate weekdays'),
    localTime: localTimeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('every_n_days'),
    anchorDate: localDateSchema,
    intervalDays: positiveIntegerSchema,
    localTime: localTimeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('period_days'),
    periodId: idSchema,
    offsetsDays: z
      .array(z.number().int().nonnegative())
      .min(1)
      .refine((days) => new Set(days).size === days.length, 'Duplicate offsets'),
    localTime: localTimeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('session_links'),
    sessionIds: uniqueIds.min(1),
    point: z.enum(['start', 'end']),
    offsetMinutes: z.number(),
  }),
]);
export const routineScheduleVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(4),
    id: idSchema,
    versionId: idSchema,
    blueprint: versionRefSchema,
    window: finiteExpansionWindowSchema,
    rule: routineScheduleRuleSchema,
    state: z.enum(['draft', 'active', 'paused', 'ended']),
  })
  .superRefine((value, ctx) => {
    if (value.rule.kind === 'dates') {
      if (
        value.rule.dates.some(
          (date) => date < value.window.startDate || date >= value.window.endDateExclusive,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['rule', 'dates'],
          message: 'Dates must be inside expansion window',
        });
      }
      if (value.rule.dates.length > value.window.maxOccurrences)
        ctx.addIssue({ code: 'custom', message: 'Occurrence limit exceeded' });
    }
  });
const selectedChoicesSchema = z.record(idSchema, idSchema);
export const routineOccurrenceSchema = z
  .strictObject({
    id: idSchema,
    schedule: versionRefSchema,
    blueprint: versionRefSchema,
    anchorKey: nonEmptyStringSchema,
    scheduledAt: instantSchema.nullable(),
    timingStatus: z.enum(['resolved', 'unresolved']),
    stepBindings: z
      .array(z.strictObject({ stepId: idSchema, plannedRef: domainPlanRefSchema }))
      .refine((items) => unique(items, (item) => item.stepId), 'Duplicate step binding'),
    selectedChoices: selectedChoicesSchema,
  })
  .refine(
    (value) => (value.timingStatus === 'resolved') === (value.scheduledAt !== null),
    'Anchor resolution must agree with scheduled time',
  );
export const actualRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('activity'),
    id: idSchema,
    revisionId: idSchema,
    detailId: idSchema.nullable(),
    allocationId: idSchema.nullable(),
  }),
  ...(['intake', 'recovery_log', 'checkin', 'checklist_confirmation'] as const).map((kind) =>
    z.strictObject({ kind: z.literal(kind), id: idSchema, revisionId: idSchema }),
  ),
]);
export const stepOutcomeSchema = z.enum([
  'pending',
  'in_progress',
  'partial',
  'performed',
  'confirmed_skipped',
  'stopped',
  'not_applicable',
]);
export const routineStepProgressSchema = z
  .strictObject({
    stepId: idSchema,
    revision: revisionSchema,
    state: stepOutcomeSchema,
    actualRefs: z
      .array(actualRefSchema)
      .refine(
        (items) =>
          unique(items, (item) =>
            JSON.stringify(
              item.kind === 'activity'
                ? [item.kind, item.id, item.detailId, item.allocationId]
                : [item.kind, item.id],
            ),
          ),
        'Duplicate actual references',
      ),
    occurredAt: instantSchema.nullable(),
    recordedAt: instantSchema,
    reason: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      ['performed', 'partial'].includes(value.state) &&
      (value.actualRefs.length === 0 || value.occurredAt === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Performed/partial progress needs actual references and occurrence time',
      });
    }
    if (['pending', 'not_applicable'].includes(value.state) && value.actualRefs.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Nonperformed progress cannot link performed actuals',
      });
    }
  });
export const routineRunSchema = z
  .strictObject({
    id: idSchema,
    revision: revisionSchema,
    blueprint: versionRefSchema,
    origin: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('planned'), occurrenceId: idSchema }),
      z.strictObject({ kind: z.literal('unplanned') }),
    ]),
    state: z.enum(['in_progress', 'paused', 'ended', 'stopped']),
    progress: z
      .array(routineStepProgressSchema)
      .refine((items) => unique(items, (item) => item.stepId), 'Duplicate step progress'),
    selectedChoices: selectedChoicesSchema,
    startedAt: instantSchema,
    endedAt: instantSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (['ended', 'stopped'].includes(value.state) !== (value.endedAt !== null))
      ctx.addIssue({ code: 'custom', message: 'Run end time must match lifecycle state' });
    if (value.endedAt !== null && Date.parse(value.endedAt) < Date.parse(value.startedAt))
      ctx.addIssue({ code: 'custom', message: 'Run ends before it starts' });
  });
export const stretchMethodSchema = z.enum(['static_hold', 'dynamic_repetition', 'other_reviewed']);
export const stretchExerciseVersionSchema = exerciseDefinitionVersionSchema.extend({
  family: z.literal('stretching'),
  method: stretchMethodSchema,
  movementMode: z.enum(['active', 'passive', 'unspecified']),
  assistance: z.enum(['self', 'equipment', 'partner', 'unspecified']),
  bodyRegionTags: z.array(nonEmptyStringSchema),
  contextTags: z.array(nonEmptyStringSchema),
  instructionText: z.string(),
  cautionText: z.string(),
});
const countBasisSchema = z.enum(['total', 'per_side', 'unspecified']);
export const stretchTargetSchema = z
  .strictObject({
    id: idSchema,
    exerciseVersionId: idSchema,
    side: sideSchema,
    method: stretchMethodSchema,
    holdSeconds: numericTargetSchema('s').nullable(),
    repetitions: numericTargetSchema('count').nullable(),
    countBasis: countBasisSchema,
    restAfterSeconds: nonNegativeNumberSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.method === 'static_hold' &&
      (value.holdSeconds === null || value.repetitions !== null)
    )
      ctx.addIssue({ code: 'custom', message: 'Static hold requires hold duration only' });
    if (
      value.method === 'dynamic_repetition' &&
      (value.repetitions === null || value.holdSeconds !== null)
    )
      ctx.addIssue({ code: 'custom', message: 'Dynamic repetition requires repetitions only' });
  });
export const stretchLogRevisionSchema = z.strictObject({
  id: idSchema,
  revisionId: idSchema,
  activityId: idSchema,
  executionId: idSchema,
  plannedTargetId: idSchema.nullable(),
  exerciseVersionId: idSchema,
  side: sideSchema,
  state: z.enum(['partial', 'performed', 'confirmed_skipped', 'stopped']),
  holdSeconds: metricDatumSchema('s'),
  repetitions: metricDatumSchema('count'),
  countBasis: countBasisSchema,
  occurredAt: instantSchema,
  recordedAt: instantSchema,
  checkInIds: uniqueIds,
  reason: z.string().nullable(),
});
export const recoveryMethodVersionSchema = z
  .strictObject({
    id: idSchema,
    versionId: idSchema,
    title: nonEmptyStringSchema,
    category: z.enum([
      'rest',
      'sleep_preparation',
      'relaxation',
      'manual_method',
      'compression',
      'thermal_method',
      'electrical_stimulation',
      'other',
    ]),
    reviewState: z.enum(['unreviewed', 'reviewed_for_stated_use', 'withdrawn']),
    intendedUse: z.string(),
    applicability: z.array(z.string()),
    cautions: z.array(z.string()),
    resourceVersionIds: uniqueIds,
    reviewedAt: instantSchema.nullable(),
  })
  .refine(
    (value) => value.reviewState !== 'reviewed_for_stated_use' || value.reviewedAt !== null,
    'Reviewed method requires review timestamp',
  );
export const recoveryPlanItemSchema = z.strictObject({
  id: idSchema,
  planVersionId: idSchema,
  strategy: versionRefSchema.nullable(),
  method: versionRefSchema,
  scheduledAt: instantSchema.nullable(),
  userInstructions: z.string(),
  reviewAt: instantSchema.nullable(),
});
export const recoveryStrategyVersionSchema = z
  .strictObject({
    id: idSchema,
    versionId: idSchema,
    title: nonEmptyStringSchema,
    goal: z.string(),
    startDate: localDateSchema,
    endDateExclusive: localDateSchema,
    timezone: timeZoneSchema,
    selectedOptionId: idSchema.nullable(),
    options: z.array(
      z.strictObject({
        id: idSchema,
        title: nonEmptyStringSchema,
        actionRefs: z.array(domainPlanRefSchema),
        rationaleEvidenceIds: uniqueIds,
      }),
    ),
    missingInformation: z.array(z.string()),
    reassessment: z.array(
      z.strictObject({
        id: idSchema,
        trigger: z.enum([
          'scheduled_checkin',
          'user_report_changed',
          'plan_changed',
          'source_withdrawn',
        ]),
        plannedAt: instantSchema.nullable(),
        description: z.string(),
        policyVersion: nonEmptyStringSchema.nullable(),
      }),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.startDate >= value.endDateExclusive)
      ctx.addIssue({ code: 'custom', message: 'Strategy period must be nonempty' });
    if (!unique(value.options, (item) => item.id) || !unique(value.reassessment, (item) => item.id))
      ctx.addIssue({ code: 'custom', message: 'Duplicate strategy option/reassessment IDs' });
    if (
      value.selectedOptionId !== null &&
      !value.options.some((item) => item.id === value.selectedOptionId)
    )
      ctx.addIssue({ code: 'custom', message: 'Unknown selected option' });
  });
export const recoveryActionLogRevisionSchema = z.strictObject({
  id: idSchema,
  revisionId: idSchema,
  method: versionRefSchema,
  plannedItemId: idSchema.nullable(),
  occurredAt: instantSchema,
  recordedAt: instantSchema,
  state: z.enum(['performed', 'partial', 'confirmed_skipped', 'stopped', 'unconfirmed']),
  duration: metricDatumSchema('s'),
  beforeCheckInId: idSchema.nullable(),
  afterCheckInId: idSchema.nullable(),
  userNotes: z.string().nullable(),
});
export const planHeadExpectationSchema = z.strictObject({
  domain: planDomainSchema,
  aggregateId: idSchema,
  head: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('exists'), versionId: idSchema }),
    z.strictObject({ kind: z.literal('absent') }),
  ]),
});
export const integratedCoachingBasisV023Schema = z.strictObject({
  schemaVersion: z.literal(4),
  planHeads: z
    .array(planHeadExpectationSchema)
    .refine(
      (items) => unique(items, (item) => JSON.stringify([item.domain, item.aggregateId])),
      'Duplicate domain/aggregate expectation',
    ),
  contextDependencies: z
    .array(dependencyRefSchema)
    .refine(
      (items) => unique(items, (item) => JSON.stringify([item.kind, item.id])),
      'Duplicate dependency',
    ),
  preferenceRevision: revisionSchema,
  constraintRevision: revisionSchema,
  conversationRevision: revisionSchema,
  policyVersion: nonEmptyStringSchema,
  evidenceSnapshotId: idSchema,
});
export const integratedApprovalV023Schema = z
  .strictObject({
    schemaVersion: z.literal(4),
    proposalId: idSchema,
    candidateId: idSchema,
    proposalDigest: nonEmptyStringSchema,
    writeDomains: z
      .tuple([planDomainSchema], planDomainSchema)
      .refine((domains) => new Set(domains).size === domains.length, 'Duplicate write domain'),
    expectedBasis: integratedCoachingBasisV023Schema,
    idempotencyKey: nonEmptyStringSchema,
  })
  .refine(
    (value) =>
      value.writeDomains.every((domain) =>
        value.expectedBasis.planHeads.some((head) => head.domain === domain),
      ),
    'Every write domain requires a head expectation',
  );
// These DTO checks do not establish ownership, freshness, candidate write sets or atomic persistence.

export type VersionRef = z.infer<typeof versionRefSchema>;
export type PlanDomain = z.infer<typeof planDomainSchema>;
export type DomainPlanRef = z.infer<typeof domainPlanRefSchema>;
export type DependencyRef = z.infer<typeof dependencyRefSchema>;
export type IntegratedDayV023 = z.infer<typeof integratedDayV023Schema>;
export type RoutineStepContent = z.infer<typeof routineStepContentSchema>;
export type StepTiming = z.infer<typeof stepTimingSchema>;
export type RoutineBlueprintStep = z.infer<typeof routineBlueprintStepSchema>;
export type RoutineBlueprintVersion = z.infer<typeof routineBlueprintVersionSchema>;
export type FiniteExpansionWindow = z.infer<typeof finiteExpansionWindowSchema>;
export type RoutineScheduleRule = z.infer<typeof routineScheduleRuleSchema>;
export type RoutineScheduleVersion = z.infer<typeof routineScheduleVersionSchema>;
export type RoutineOccurrence = z.infer<typeof routineOccurrenceSchema>;
export type ActualRef = z.infer<typeof actualRefSchema>;
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;
export type RoutineStepProgress = z.infer<typeof routineStepProgressSchema>;
export type RoutineRun = z.infer<typeof routineRunSchema>;
export type StretchMethod = z.infer<typeof stretchMethodSchema>;
export type StretchExerciseVersion = z.infer<typeof stretchExerciseVersionSchema>;
export type StretchTarget = z.infer<typeof stretchTargetSchema>;
export type StretchLogRevision = z.infer<typeof stretchLogRevisionSchema>;
export type RecoveryMethodVersion = z.infer<typeof recoveryMethodVersionSchema>;
export type RecoveryPlanItem = z.infer<typeof recoveryPlanItemSchema>;
export type RecoveryStrategyVersion = z.infer<typeof recoveryStrategyVersionSchema>;
export type RecoveryActionLogRevision = z.infer<typeof recoveryActionLogRevisionSchema>;
export type PlanHeadExpectation = z.infer<typeof planHeadExpectationSchema>;
export type IntegratedCoachingBasisV023 = z.infer<typeof integratedCoachingBasisV023Schema>;
export type IntegratedApprovalV023 = z.infer<typeof integratedApprovalV023Schema>;
