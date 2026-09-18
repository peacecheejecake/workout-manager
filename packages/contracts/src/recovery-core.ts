import { z } from 'zod';
import { instantSchema, localDateSchema, timeZoneSchema } from './primitives.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const shortText = z.string().trim().min(1).max(160);
const note = z.string().max(2_000);
const commandKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const recoveryObservationRefSchema = z.strictObject({
  kind: z.enum(['check_in', 'activity', 'intake']),
  id: z.string().min(1).max(128),
  revision: z.number().int().positive(),
});
export type RecoveryObservationRef = z.infer<typeof recoveryObservationRefSchema>;
export const recoveryPlanRefSchema = z
  .strictObject({
    kind: z.enum(['training', 'nutrition']),
    aggregateId: uuid,
    headVersionId: uuid,
  })
  .superRefine((reference, context) => {
    if (reference.kind === 'training' && reference.aggregateId !== reference.headVersionId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'Training uses the frozen head as its reference',
      });
    }
  });
export type RecoveryPlanRef = z.infer<typeof recoveryPlanRefSchema>;

export const recoveryMethodCategorySchema = z.enum([
  'rest',
  'sleep_preparation',
  'relaxation',
  'manual_method',
  'compression',
  'thermal_method',
  'electrical_stimulation',
  'other',
]);
export const recoveryMethodVersionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  methodId: uuid,
  versionId: uuid,
  version: z.number().int().positive(),
  title: shortText,
  category: recoveryMethodCategorySchema,
  intendedUse: note,
  applicability: z.array(shortText).max(20),
  cautions: z.array(shortText).max(20),
  sourceDescription: note,
  evidenceLimitations: note,
  reviewState: z.literal('unreviewed'),
  reviewedAt: z.null(),
  source: z.literal('user_recorded'),
  createdAt: instantSchema,
});
export type RecoveryMethodVersion = z.infer<typeof recoveryMethodVersionSchema>;
export const createRecoveryMethodRequestSchema = z.strictObject({
  title: shortText,
  category: recoveryMethodCategorySchema,
  intendedUse: note,
  applicability: z.array(shortText).max(20),
  cautions: z.array(shortText).max(20),
  sourceDescription: note,
  evidenceLimitations: note,
  idempotencyKey: commandKey,
});
export type CreateRecoveryMethodRequest = z.infer<typeof createRecoveryMethodRequestSchema>;

export const recoveryOptionSchema = z
  .strictObject({
    id: uuid,
    title: shortText,
    kind: z.enum(['full_rest', 'maintain_existing_plan', 'nonexercise_action']),
    methodVersionId: uuid.nullable(),
    explanation: note,
  })
  .superRefine((option, context) => {
    if ((option.kind === 'nonexercise_action') !== (option.methodVersionId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['methodVersionId'],
        message: 'Only non-exercise actions have a method',
      });
    }
  });
export const recoveryReassessmentSchema = z
  .strictObject({
    id: uuid,
    trigger: z.enum([
      'scheduled_checkin',
      'user_report_changed',
      'plan_changed',
      'source_withdrawn',
    ]),
    plannedAt: instantSchema.nullable(),
    description: shortText,
    policyVersion: z.string().min(1).max(80).nullable(),
  })
  .superRefine((condition, context) => {
    if (condition.trigger === 'scheduled_checkin' && condition.plannedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['plannedAt'],
        message: 'A scheduled check-in needs a time',
      });
    }
  });
export const recoveryStrategyDraftSchema = z
  .strictObject({
    title: shortText,
    goal: note,
    startDate: localDateSchema,
    endDateExclusive: localDateSchema,
    timezone: timeZoneSchema,
    knownFacts: z.array(note).max(30),
    missingInformation: z.array(shortText).max(30),
    priority: z.enum(['low', 'normal', 'high']),
    observations: z.array(recoveryObservationRefSchema).max(40),
    planRefs: z.array(recoveryPlanRefSchema).max(20),
    options: z.array(recoveryOptionSchema).min(1).max(20),
    reassessment: z.array(recoveryReassessmentSchema).min(1).max(20),
  })
  .superRefine((draft, context) => {
    if (draft.startDate >= draft.endDateExclusive) {
      context.addIssue({
        code: 'custom',
        path: ['endDateExclusive'],
        message: 'Period must be ordered',
      });
    }
    if (new Set(draft.options.map((option) => option.id)).size !== draft.options.length) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'Duplicate option' });
    }
    if (new Set(draft.reassessment.map((item) => item.id)).size !== draft.reassessment.length) {
      context.addIssue({ code: 'custom', path: ['reassessment'], message: 'Duplicate condition' });
    }
    if (
      new Set(draft.observations.map((ref) => ref.kind + ':' + ref.id)).size !==
      draft.observations.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message: 'Duplicate observation',
      });
    }
    if (
      new Set(draft.planRefs.map((ref) => ref.kind + ':' + ref.aggregateId)).size !==
      draft.planRefs.length
    ) {
      context.addIssue({ code: 'custom', path: ['planRefs'], message: 'Duplicate plan reference' });
    }
  });
export type RecoveryStrategyDraft = z.infer<typeof recoveryStrategyDraftSchema>;
export const recoveryStrategyVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    strategyId: uuid,
    versionId: uuid,
    version: z.number().int().positive(),
    previousVersionId: uuid.nullable(),
    status: z.enum(['draft', 'user_confirmed']),
    selectedOptionId: uuid.nullable(),
    createdAt: instantSchema,
    draft: recoveryStrategyDraftSchema,
  })
  .superRefine((strategy, context) => {
    if (strategy.status === 'user_confirmed' && strategy.selectedOptionId === null) {
      context.addIssue({
        code: 'custom',
        path: ['selectedOptionId'],
        message: 'Confirmation requires an option',
      });
    }
    if (
      strategy.selectedOptionId !== null &&
      !strategy.draft.options.some((option) => option.id === strategy.selectedOptionId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['selectedOptionId'],
        message: 'Selected option is missing',
      });
    }
  });
export type RecoveryStrategyVersion = z.infer<typeof recoveryStrategyVersionSchema>;
export const createRecoveryStrategyRequestSchema = z.strictObject({
  draft: recoveryStrategyDraftSchema,
  idempotencyKey: commandKey,
});
export type CreateRecoveryStrategyRequest = z.infer<typeof createRecoveryStrategyRequestSchema>;
export const confirmRecoveryStrategyRequestSchema = z.strictObject({
  strategyId: uuid,
  expectedHeadVersionId: uuid,
  selectedOptionId: uuid,
  idempotencyKey: commandKey,
});
export type ConfirmRecoveryStrategyRequest = z.infer<typeof confirmRecoveryStrategyRequestSchema>;

export const recoveryActionStateSchema = z.enum([
  'performed',
  'partial',
  'confirmed_skipped',
  'stopped',
  'unconfirmed',
]);
const actionFields = {
  methodVersionId: uuid,
  strategyVersionId: uuid.nullable(),
  plannedOptionId: uuid.nullable(),
  occurredAt: instantSchema,
  timezone: timeZoneSchema,
  state: recoveryActionStateSchema,
  durationSeconds: z.number().int().min(0).max(86_400).nullable(),
  actualConditions: note,
  beforeCheckIn: recoveryObservationRefSchema.nullable(),
  afterCheckIn: recoveryObservationRefSchema.nullable(),
  discomfort: note,
  userNotes: note,
  source: z.literal('user_confirmed'),
};
export const createRecoveryActionRequestSchema = z
  .strictObject({
    ...actionFields,
    idempotencyKey: commandKey,
  })
  .superRefine((action, context) => {
    if (action.beforeCheckIn !== null && action.beforeCheckIn.kind !== 'check_in')
      context.addIssue({ code: 'custom', path: ['beforeCheckIn'], message: 'Expected check-in' });
    if (action.afterCheckIn !== null && action.afterCheckIn.kind !== 'check_in')
      context.addIssue({ code: 'custom', path: ['afterCheckIn'], message: 'Expected check-in' });
    if (action.plannedOptionId !== null && action.strategyVersionId === null)
      context.addIssue({
        code: 'custom',
        path: ['plannedOptionId'],
        message: 'A plan option needs a strategy version',
      });
  });
export type CreateRecoveryActionRequest = z.infer<typeof createRecoveryActionRequestSchema>;
export const recoveryActionLogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  actionId: uuid,
  revisionId: uuid,
  revision: z.number().int().positive(),
  status: z.literal('active'),
  recordedAt: instantSchema,
  ...actionFields,
});
export type RecoveryActionLog = z.infer<typeof recoveryActionLogSchema>;
export const correctRecoveryActionRequestSchema = z
  .strictObject({
    ...createRecoveryActionRequestSchema.shape,
    actionId: uuid,
    expectedRevision: z.number().int().positive(),
  })
  .superRefine((action, context) => {
    if (action.beforeCheckIn !== null && action.beforeCheckIn.kind !== 'check_in')
      context.addIssue({ code: 'custom', path: ['beforeCheckIn'], message: 'Expected check-in' });
    if (action.afterCheckIn !== null && action.afterCheckIn.kind !== 'check_in')
      context.addIssue({ code: 'custom', path: ['afterCheckIn'], message: 'Expected check-in' });
    if (action.plannedOptionId !== null && action.strategyVersionId === null)
      context.addIssue({
        code: 'custom',
        path: ['plannedOptionId'],
        message: 'A plan option needs a strategy version',
      });
  });
export type CorrectRecoveryActionRequest = z.infer<typeof correctRecoveryActionRequestSchema>;
export const deleteRecoveryActionRequestSchema = z.strictObject({
  actionId: uuid,
  expectedRevision: z.number().int().positive(),
  idempotencyKey: commandKey,
});
export type DeleteRecoveryActionRequest = z.infer<typeof deleteRecoveryActionRequestSchema>;
export const deletedRecoveryActionSchema = z.strictObject({
  actionId: uuid,
  revisionId: uuid,
  revision: z.number().int().positive(),
  status: z.literal('deleted'),
  deletedAt: instantSchema,
});
export type DeletedRecoveryAction = z.infer<typeof deletedRecoveryActionSchema>;
export const recoveryActionRecordSchema = z.discriminatedUnion('status', [
  recoveryActionLogSchema,
  deletedRecoveryActionSchema,
]);
export type RecoveryActionRecord = z.infer<typeof recoveryActionRecordSchema>;

export const recoveryWorkspaceReadSchema = z.strictObject({
  methods: z.array(recoveryMethodVersionSchema).max(100),
  strategies: z.array(recoveryStrategyVersionSchema).max(100),
  actions: z.array(recoveryActionRecordSchema).max(100),
  observations: z
    .array(
      z.strictObject({
        reference: recoveryObservationRefSchema,
        state: z.enum(['current', 'revised', 'deleted']),
      }),
    )
    .max(5000),
  planRefs: z
    .array(
      z.strictObject({
        reference: recoveryPlanRefSchema,
        state: z.enum(['current', 'changed', 'deleted']),
      }),
    )
    .max(2000),
  reassessment: z
    .array(
      z.strictObject({
        strategyId: uuid,
        conditionId: uuid,
        reason: z.enum(['scheduled', 'observation_changed', 'plan_changed']),
      }),
    )
    .max(2000),
});
export type RecoveryWorkspaceRead = z.infer<typeof recoveryWorkspaceReadSchema>;
