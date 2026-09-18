import { z } from 'zod';

import { instantSchema } from './primitives.js';
import { supplementaryExerciseVersionSchema } from './supplementary-core.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const boundedText = z.string().trim().max(2_000);
const seconds = z.number().finite().nonnegative().max(86_400);
const repetitions = z.number().int().nonnegative().max(100_000);

/** Editorial provenance is inherited from the frozen ExerciseDefinitionVersion. */
export const stretchProfileSchema = z.strictObject({
  method: z.enum(['static_hold', 'dynamic_repetitions']),
  movement: z.enum(['active', 'passive', 'unspecified']),
  assistance: z.enum(['self', 'equipment', 'partner', 'unspecified']),
  context: z.enum(['warmup', 'mobility_practice', 'cooldown', 'other']),
  bodyRegions: z.array(z.string().trim().min(1).max(100)).min(1).max(12),
  sideBasis: z.enum(['per_side', 'total', 'unspecified']),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user_authored') }),
    z.strictObject({
      kind: z.literal('resource_version'),
      resourceVersionId: z.string().min(1).max(200),
    }),
  ]),
});
export type StretchProfile = z.infer<typeof stretchProfileSchema>;
export const stretchPlannedTargetSchema = z.strictObject({
  executionId: uuid,
  targetSetId: z.string().trim().min(1).max(200),
  exerciseVersionId: uuid,
  side: z.enum(['bilateral', 'left', 'right', 'alternating', 'unspecified']),
  plannedHoldSeconds: z.strictObject({ min: seconds, max: seconds }).nullable(),
  plannedRepetitions: z.strictObject({ min: repetitions, max: repetitions }).nullable(),
  restAfterSeconds: seconds.nullable(),
});
export const stretchPlannedTargetPageSchema = z.strictObject({
  items: z.array(stretchPlannedTargetSchema).max(100),
  hasMore: z.boolean(),
});
export type StretchPlannedTarget = z.infer<typeof stretchPlannedTargetSchema>;

export const stretchingExerciseSaveSchema = z
  .strictObject({
    definition: supplementaryExerciseVersionSchema,
    profile: stretchProfileSchema,
    expectedVersionId: uuid.nullable(),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    confirmed: z.literal(true),
  })
  .superRefine((command, context) => {
    const { definition, profile } = command;
    if (definition.family !== 'stretching' || definition.reviewState !== 'unreviewed')
      context.addIssue({
        code: 'custom',
        path: ['definition'],
        message: 'New stretching content is unreviewed',
      });
    if (command.expectedVersionId === definition.versionId)
      context.addIssue({
        code: 'custom',
        path: ['expectedVersionId'],
        message: 'New version cannot replace itself',
      });
    if (
      profile.source.kind === 'resource_version' &&
      !definition.resourceVersionIds.includes(profile.source.resourceVersionId)
    )
      context.addIssue({
        code: 'custom',
        path: ['profile', 'source'],
        message: 'Source must be a frozen resource version',
      });
    if (
      profile.method === 'static_hold' &&
      (definition.supportedMetrics.length !== 1 ||
        definition.supportedMetrics[0] !== 'duration' ||
        definition.countDefinitions.length !== 0)
    )
      context.addIssue({
        code: 'custom',
        path: ['definition', 'supportedMetrics'],
        message: 'Static hold uses duration',
      });
    if (
      profile.method === 'dynamic_repetitions' &&
      (definition.supportedMetrics.length !== 1 ||
        definition.supportedMetrics[0] !== 'count' ||
        definition.countDefinitions.length !== 1 ||
        definition.countDefinitions[0]?.kind !== 'repetitions' ||
        definition.countDefinitions[0].basis !== profile.sideBasis)
    )
      context.addIssue({
        code: 'custom',
        path: ['definition', 'countDefinitions'],
        message: 'Dynamic stretching uses defined repetitions',
      });
  });
export const stretchingExerciseReadSchema = z.strictObject({
  definition: supplementaryExerciseVersionSchema,
  profile: stretchProfileSchema,
  version: z.number().int().min(1).max(2_147_483_646),
});
export type StretchingExerciseSave = z.infer<typeof stretchingExerciseSaveSchema>;
export type StretchingExerciseRead = z.infer<typeof stretchingExerciseReadSchema>;

export const stretchAllocationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('standalone') }),
  z
    .strictObject({
      kind: z.literal('activity_block'),
      startedAt: instantSchema.nullable(),
      endedAtExclusive: instantSchema.nullable(),
    })
    .superRefine((value, context) => {
      if ((value.startedAt === null) !== (value.endedAtExclusive === null))
        context.addIssue({
          code: 'custom',
          path: ['startedAt'],
          message: 'Both bounds or neither',
        });
      if (
        value.startedAt !== null &&
        value.endedAtExclusive !== null &&
        Date.parse(value.endedAtExclusive) <= Date.parse(value.startedAt)
      )
        context.addIssue({ code: 'custom', path: ['endedAtExclusive'], message: 'Empty block' });
    }),
]);

const stretchValuesFields = {
  activityId: uuid,
  exerciseVersionId: uuid,
  plannedTarget: z
    .strictObject({
      executionId: uuid,
      targetSetId: z.string().trim().min(1).max(200),
    })
    .nullable(),
  allocation: stretchAllocationSchema,
  side: z.enum(['left', 'right', 'both', 'total', 'unknown']),
  state: z.enum(['unconfirmed', 'performed', 'partial', 'stopped', 'confirmed_skipped']),
  holdSeconds: seconds.nullable(),
  repetitions: repetitions.nullable(),
  restSeconds: seconds.nullable(),
  comfort: z.enum(['unknown', 'comfortable', 'discomfort']),
  discomfortNote: boundedText.nullable(),
  reason: boundedText.nullable(),
  occurredAt: instantSchema,
};
export const stretchLogValuesSchema = z
  .strictObject(stretchValuesFields)
  .superRefine((value, context) => {
    const positive =
      (value.holdSeconds !== null && value.holdSeconds > 0) ||
      (value.repetitions !== null && value.repetitions > 0);
    if (value.holdSeconds !== null && value.repetitions !== null)
      context.addIssue({
        code: 'custom',
        path: ['repetitions'],
        message: 'One method metric per log',
      });
    if ((value.state === 'performed' || value.state === 'partial') && !positive)
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Confirmed performance needs a positive actual',
      });
    if (
      (value.state === 'unconfirmed' || value.state === 'confirmed_skipped') &&
      (value.holdSeconds !== null || value.repetitions !== null || value.restSeconds !== null)
    )
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'No actual for unconfirmed or skipped',
      });
    if (value.state === 'stopped' && !value.reason)
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Stopping needs a reason' });
    if (value.comfort === 'discomfort' && !value.discomfortNote)
      context.addIssue({
        code: 'custom',
        path: ['discomfortNote'],
        message: 'Describe discomfort without diagnosing it',
      });
    if (value.comfort !== 'discomfort' && value.discomfortNote !== null)
      context.addIssue({
        code: 'custom',
        path: ['discomfortNote'],
        message: 'Note needs discomfort state',
      });
  });
export type StretchLogValues = z.infer<typeof stretchLogValuesSchema>;

const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const commandBase = {
  schemaVersion: z.literal(1),
  logId: uuid,
  idempotencyKey,
  confirmation: z.enum(['draft', 'user_confirmed']),
  values: stretchLogValuesSchema,
};
const checkConfirmation = (value: {
  confirmation: 'draft' | 'user_confirmed';
  values: StretchLogValues;
}) => (value.values.state === 'unconfirmed') === (value.confirmation === 'draft');
export const stretchLogCreateSchema = z.strictObject(commandBase).refine(checkConfirmation, {
  path: ['confirmation'],
  message: 'Timer and draft cannot confirm an actual',
});
export const stretchLogCorrectSchema = z
  .strictObject({
    ...commandBase,
    expectedRevision: z.number().int().min(1).max(2_147_483_646),
  })
  .refine(checkConfirmation, {
    path: ['confirmation'],
    message: 'Timer and draft cannot confirm an actual',
  });
export const stretchLogDeleteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  logId: uuid,
  expectedRevision: z.number().int().min(1).max(2_147_483_646),
  idempotencyKey,
  confirmed: z.literal(true),
  reason: z.string().trim().min(1).max(500),
});
export const stretchLogRevisionSchema = stretchLogValuesSchema.safeExtend({
  schemaVersion: z.literal(1),
  logId: uuid,
  revisionId: uuid,
  revision: z.number().int().min(1).max(2_147_483_646),
  source: z.literal('user'),
  confirmation: z.enum(['draft', 'user_confirmed']),
  recordedAt: instantSchema,
});
export const stretchLogReadSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('active'), current: stretchLogRevisionSchema }),
  z.strictObject({
    status: z.literal('deleted'),
    logId: uuid,
    activityId: uuid,
    revision: z.number().int().min(1),
    deletedAt: instantSchema,
  }),
]);
export const stretchLogPageSchema = z.strictObject({
  items: z.array(stretchLogReadSchema).max(100),
  hasMore: z.boolean(),
});
export type StretchLogCreate = z.infer<typeof stretchLogCreateSchema>;
export type StretchLogCorrect = z.infer<typeof stretchLogCorrectSchema>;
export type StretchLogDelete = z.infer<typeof stretchLogDeleteSchema>;
export type StretchLogRead = z.infer<typeof stretchLogReadSchema>;
export type StretchLogRevision = z.infer<typeof stretchLogRevisionSchema>;
