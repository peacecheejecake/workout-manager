import { z } from 'zod';

import { activityReportValuesSchema, manualActivityCreateSchema } from './activity.js';
import {
  countDefinitionSchema,
  equipmentSchema,
  executionTimerStateSchema,
  exerciseDefinitionVersionSchema,
  setLogRevisionSchema,
  setTargetSchema,
  supplementaryWorkoutSpecSchema,
} from './nutrition.js';
import {
  idSchema,
  instantSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
} from './primitives.js';

const boundedText = nonEmptyStringSchema.max(2_000);
const boundedLocalIdSchema = idSchema.max(200);
/** PostgreSQL uuid columns render canonical lowercase text in JSON identity checks. */
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const boundedCountDefinitionSchema = countDefinitionSchema.safeExtend({
  definitionId: boundedLocalIdSchema,
});
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const unique = <T>(items: readonly T[], select: (item: T) => string) =>
  new Set(items.map(select)).size === items.length;

/** Immutable catalog content. Review state is about content, not physiological efficacy. */
export const supplementaryExerciseVersionSchema = exerciseDefinitionVersionSchema
  .safeExtend({
    schemaVersion: z.literal(2),
    exerciseId: uuidSchema,
    versionId: uuidSchema,
    equipment: z.array(equipmentSchema).max(20),
    tags: z.array(nonEmptyStringSchema.max(100)).max(30),
    countDefinitions: z.array(boundedCountDefinitionSchema).max(30),
    mediaAssetIds: z.array(boundedLocalIdSchema).max(20),
    resourceVersionIds: z.array(boundedLocalIdSchema).max(20),
    description: boundedText,
    safetyNotes: z.string().max(2_000),
    supportedMetrics: z
      .array(z.enum(['count', 'duration', 'external_resistance', 'effort']))
      .min(1)
      .max(4),
    createdAt: instantSchema,
  })
  .superRefine((value, context) => {
    if (!unique(value.equipment, (item) => item))
      context.addIssue({ code: 'custom', path: ['equipment'], message: 'Duplicate equipment' });
    if (!unique(value.countDefinitions, (item) => item.definitionId))
      context.addIssue({
        code: 'custom',
        path: ['countDefinitions'],
        message: 'Duplicate count definition IDs',
      });
    if (!unique(value.supportedMetrics, (item) => item))
      context.addIssue({
        code: 'custom',
        path: ['supportedMetrics'],
        message: 'Duplicate supported metrics',
      });
    if (value.countDefinitions.length > 0 && !value.supportedMetrics.includes('count'))
      context.addIssue({
        code: 'custom',
        path: ['supportedMetrics'],
        message: 'Count definitions require count support',
      });
    if (value.supportedMetrics.includes('count') && value.countDefinitions.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['countDefinitions'],
        message: 'Count support needs a versioned definition',
      });
  });
export type SupplementaryExerciseVersion = z.infer<typeof supplementaryExerciseVersionSchema>;

/** A stable version reference is resolved by the server; no latest-version substitution. */
export const supplementaryExerciseVersionRefSchema = z.strictObject({
  exerciseId: uuidSchema,
  versionId: uuidSchema,
});
export const exerciseVersionSaveCommandSchema = z
  .strictObject({
    definition: supplementaryExerciseVersionSchema,
    expectedVersionId: uuidSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
    confirmed: z.literal(true),
  })
  .superRefine((command, context) => {
    if (command.definition.reviewState !== 'unreviewed')
      context.addIssue({
        code: 'custom',
        path: ['definition', 'reviewState'],
        message: 'User-created catalog versions cannot claim editorial review',
      });
    if (command.definition.family === 'stretching')
      context.addIssue({
        code: 'custom',
        path: ['definition', 'family'],
        message: 'Stretching definitions need an atomic StretchProfile save',
      });
    if (command.expectedVersionId === command.definition.versionId)
      context.addIssue({
        code: 'custom',
        path: ['expectedVersionId'],
        message: 'A new version cannot replace itself',
      });
  });
export const exerciseVersionReadSchema = z.strictObject({
  definition: supplementaryExerciseVersionSchema,
  version: positiveIntegerSchema,
});
export type ExerciseVersionSaveCommand = z.infer<typeof exerciseVersionSaveCommandSchema>;
export type ExerciseVersionRead = z.infer<typeof exerciseVersionReadSchema>;

/** This is supplementary content, not a replacement for the endurance planning schema. */
const supplementarySetTargetSchema = setTargetSchema.safeExtend({
  id: boundedLocalIdSchema,
  exerciseVersionId: uuidSchema,
  count: setTargetSchema.shape.count
    .unwrap()
    .safeExtend({
      definition: boundedCountDefinitionSchema,
    })
    .nullable(),
});
const supplementaryBlockSchema = supplementaryWorkoutSpecSchema.shape.blocks.element.safeExtend({
  id: boundedLocalIdSchema,
  sets: z.array(supplementarySetTargetSchema).min(1).max(30),
});
export const supplementarySpecSchema = supplementaryWorkoutSpecSchema
  .safeExtend({
    routineVersionId: uuidSchema.nullable(),
    blocks: z.array(supplementaryBlockSchema).min(1).max(30),
  })
  .superRefine((spec, context) => {
    if (spec.blocks.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['blocks'],
        message: 'At least one block is required',
      });
    if (!unique(spec.blocks, (block) => block.id))
      context.addIssue({ code: 'custom', path: ['blocks'], message: 'Duplicate block IDs' });
    const allSets = spec.blocks.flatMap((block) => block.sets);
    if (!unique(allSets, (set) => set.id))
      context.addIssue({ code: 'custom', path: ['blocks'], message: 'Duplicate set IDs' });
    if (allSets.length > 300)
      context.addIssue({ code: 'custom', path: ['blocks'], message: 'Too many target sets' });
    for (const [index, block] of spec.blocks.entries()) {
      if (block.sets.length === 0)
        context.addIssue({
          code: 'custom',
          path: ['blocks', index, 'sets'],
          message: 'A block needs a target set',
        });
      for (const [setIndex, set] of block.sets.entries()) {
        if (set.count === null && set.durationSeconds === null)
          context.addIssue({
            code: 'custom',
            path: ['blocks', index, 'sets', setIndex],
            message: 'A target needs count or duration',
          });
      }
    }
  });
export type SupplementarySpec = z.infer<typeof supplementarySpecSchema>;
export const routineTemplateVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    routineId: uuidSchema,
    versionId: uuidSchema,
    title: nonEmptyStringSchema.max(200),
    purpose: z.string().max(2_000),
    requiredEquipment: z.array(equipmentSchema).max(20),
    spec: supplementarySpecSchema,
    createdAt: instantSchema,
  })
  .superRefine((value, context) => {
    if (value.spec.routineVersionId !== value.versionId)
      context.addIssue({
        code: 'custom',
        path: ['spec', 'routineVersionId'],
        message: 'Template spec must reference its frozen version',
      });
    if (!unique(value.requiredEquipment, (item) => item))
      context.addIssue({
        code: 'custom',
        path: ['requiredEquipment'],
        message: 'Duplicate required equipment',
      });
  });
export const routineTemplateSaveCommandSchema = z
  .strictObject({
    template: routineTemplateVersionSchema,
    expectedVersionId: uuidSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
    confirmed: z.literal(true),
  })
  .refine((command) => command.expectedVersionId !== command.template.versionId, {
    path: ['expectedVersionId'],
    message: 'A new version cannot replace itself',
  });
export const routineTemplateReadSchema = z.strictObject({
  template: routineTemplateVersionSchema,
  version: positiveIntegerSchema,
});
export type RoutineTemplateVersion = z.infer<typeof routineTemplateVersionSchema>;
export type RoutineTemplateSaveCommand = z.infer<typeof routineTemplateSaveCommandSchema>;
export type RoutineTemplateRead = z.infer<typeof routineTemplateReadSchema>;

/** Stored separately until the training PlannedSession contract gains a versioned supplement. */
export const supplementarySessionLinkSchema = z.strictObject({
  schemaVersion: z.literal(2),
  plannedSessionId: boundedLocalIdSchema,
  planVersionId: uuidSchema,
  content: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('routine_version'), routineVersionId: uuidSchema }),
    z.strictObject({
      kind: z.literal('embedded'),
      spec: supplementarySpecSchema.refine((spec) => spec.routineVersionId === null, {
        message: 'Embedded spec cannot float to a routine version',
      }),
    }),
  ]),
});
export type SupplementarySessionLink = z.infer<typeof supplementarySessionLinkSchema>;

/** One execution points to exactly one canonical Activity, including provider matches. */
export const supplementaryExecutionSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    executionId: uuidSchema,
    activityId: uuidSchema,
    plannedSession: supplementarySessionLinkSchema.nullable(),
    revision: positiveIntegerSchema,
    status: z.enum(['active', 'finished', 'stopped']),
    startedAt: instantSchema,
    endedAt: instantSchema.nullable(),
  })
  .superRefine((execution, context) => {
    if ((execution.status === 'active') !== (execution.endedAt === null))
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'Only active executions lack an end time',
      });
    if (
      execution.endedAt !== null &&
      Date.parse(execution.endedAt) < Date.parse(execution.startedAt)
    )
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'Execution cannot end before start',
      });
  });
export const executionCreateCommandSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    executionId: uuidSchema,
    plannedSession: supplementarySessionLinkSchema.nullable(),
    activity: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('create_manual'),
        values: manualActivityCreateSchema.shape.activity.refine(
          (values) => values.kind === 'strength',
          'Supplementary execution creates a strength activity',
        ),
        report: activityReportValuesSchema,
      }),
      z.strictObject({ kind: z.literal('match_existing'), activityId: uuidSchema }),
    ]),
    idempotencyKey: idempotencyKeySchema,
    confirmed: z.literal(true),
  })
  .refine(
    (command) => {
      if (command.activity.kind !== 'create_manual') return true;
      const link = command.activity.report.planLink;
      const session = command.plannedSession;
      if (session === null) return link === null;
      return (
        link?.planVersionId === session.planVersionId && link.sessionId === session.plannedSessionId
      );
    },
    {
      path: ['activity', 'report', 'planLink'],
      message: 'Activity plan link must match execution session',
    },
  );
/** Explicit user confirmation, independent of the presentation-only rest timer. */
export const executionStatusCommandSchema = z.strictObject({
  schemaVersion: z.literal(2),
  executionId: uuidSchema,
  expectedRevision: positiveIntegerSchema,
  status: z.enum(['finished', 'stopped']),
  endedAt: instantSchema,
  idempotencyKey: idempotencyKeySchema,
  confirmed: z.literal(true),
});
export type SupplementaryExecution = z.infer<typeof supplementaryExecutionSchema>;
export type ExecutionCreateCommand = z.infer<typeof executionCreateCommandSchema>;
export type ExecutionStatusCommand = z.infer<typeof executionStatusCommandSchema>;

const setLogValuesBaseSchema = z.strictObject({
  targetSetId: boundedLocalIdSchema.nullable(),
  blockId: boundedLocalIdSchema.nullable(),
  roundIndex: setLogRevisionSchema.shape.roundIndex,
  exerciseVersionId: uuidSchema,
  side: setLogRevisionSchema.shape.side,
  state: setLogRevisionSchema.shape.state,
  count: setLogRevisionSchema.shape.count
    .unwrap()
    .safeExtend({
      definition: boundedCountDefinitionSchema,
    })
    .nullable(),
  durationSeconds: setLogRevisionSchema.shape.durationSeconds,
  externalResistance: setLogRevisionSchema.shape.externalResistance,
  effort: setLogRevisionSchema.shape.effort,
  occurredAt: setLogRevisionSchema.shape.occurredAt,
  reason: z.string().max(2_000).nullable(),
});
function validateSetLogValues(
  entry: z.infer<typeof setLogValuesBaseSchema>,
  context: z.RefinementCtx,
) {
  if (entry.roundIndex !== null && (entry.blockId === null || entry.targetSetId === null))
    context.addIssue({
      code: 'custom',
      path: ['roundIndex'],
      message: 'Round needs a block and target set',
    });
  const actualCount = entry.count?.actual.value ?? null;
  const actualDuration = entry.durationSeconds.value;
  const hasPerformance =
    (actualCount !== null && actualCount > 0) || (actualDuration !== null && actualDuration > 0);
  if ((entry.state === 'performed' || entry.state === 'partial') && !hasPerformance)
    context.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'Performed or partial needs confirmed positive actual',
    });
  if (entry.state === 'confirmed_skipped' && hasPerformance)
    context.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'Skipped cannot include performed count or duration',
    });
  if (entry.state === 'stopped' && !entry.reason?.trim())
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Stopped needs a reason' });
}
const setLogValuesSchema = setLogValuesBaseSchema.superRefine(validateSetLogValues);
export type SetLogValues = z.infer<typeof setLogValuesSchema>;

export const setLogCreateCommandSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    executionId: uuidSchema,
    logId: uuidSchema,
    expectedExecutionRevision: positiveIntegerSchema,
    idempotencyKey: idempotencyKeySchema,
    confirmation: z.enum(['draft', 'user_confirmed']),
    values: setLogValuesSchema,
  })
  .refine(
    (command) => (command.values.state === 'unconfirmed') === (command.confirmation === 'draft'),
    { path: ['confirmation'], message: 'Only user confirmation creates an actual set' },
  );
export const setLogCorrectCommandSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    executionId: uuidSchema,
    logId: uuidSchema,
    expectedRevision: positiveIntegerSchema,
    idempotencyKey: idempotencyKeySchema,
    confirmation: z.enum(['draft', 'user_confirmed']),
    values: setLogValuesSchema,
  })
  .refine(
    (command) => (command.values.state === 'unconfirmed') === (command.confirmation === 'draft'),
    { path: ['confirmation'], message: 'Only user confirmation creates an actual set' },
  );
export const setLogDeleteCommandSchema = z.strictObject({
  schemaVersion: z.literal(2),
  executionId: uuidSchema,
  logId: uuidSchema,
  expectedRevision: positiveIntegerSchema,
  idempotencyKey: idempotencyKeySchema,
  confirmed: z.literal(true),
  reason: nonEmptyStringSchema.max(500),
});
export const supplementarySetLogRevisionSchema = setLogRevisionSchema
  .safeExtend({
    logId: uuidSchema,
    revisionId: uuidSchema,
    activityId: uuidSchema,
    executionId: uuidSchema,
    targetSetId: boundedLocalIdSchema.nullable(),
    blockId: boundedLocalIdSchema.nullable(),
    exerciseVersionId: uuidSchema,
    count: setLogValuesBaseSchema.shape.count,
    reason: setLogValuesBaseSchema.shape.reason,
    revision: positiveIntegerSchema,
    source: z.enum(['user', 'provider', 'user_confirmed_extraction']),
  })
  .superRefine(validateSetLogValues);
export const setLogReadSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('active'),
    current: supplementarySetLogRevisionSchema,
  }),
  z.strictObject({
    status: z.literal('deleted'),
    executionId: uuidSchema,
    logId: uuidSchema,
    revision: positiveIntegerSchema,
    deletedAt: instantSchema,
  }),
]);
export type SetLogCreateCommand = z.infer<typeof setLogCreateCommandSchema>;
export type SetLogCorrectCommand = z.infer<typeof setLogCorrectCommandSchema>;
export type SetLogDeleteCommand = z.infer<typeof setLogDeleteCommandSchema>;
export type SetLogRead = z.infer<typeof setLogReadSchema>;

/** A timer has no Activity or SetLog field and cannot confirm performance. */
export const restTimerStateSchema = executionTimerStateSchema
  .safeExtend({
    timerId: uuidSchema,
    executionId: uuidSchema,
    revision: positiveIntegerSchema,
    durationSeconds: positiveIntegerSchema.max(86_400),
  })
  .superRefine((timer, context) => {
    if (timer.status === 'running' && timer.deadlineAt === null)
      context.addIssue({ code: 'custom', path: ['deadlineAt'], message: 'Running needs deadline' });
    if (
      timer.status === 'running' &&
      timer.deadlineAt !== null &&
      Date.parse(timer.deadlineAt) <= Date.parse(timer.startedAt)
    )
      context.addIssue({
        code: 'custom',
        path: ['deadlineAt'],
        message: 'Deadline must follow start',
      });
    if (timer.status === 'paused' && timer.deadlineAt !== null)
      context.addIssue({ code: 'custom', path: ['deadlineAt'], message: 'Paused has no deadline' });
    if (
      timer.status === 'paused' &&
      timer.remainingWhenPausedSeconds !== null &&
      timer.remainingWhenPausedSeconds > timer.durationSeconds
    )
      context.addIssue({
        code: 'custom',
        path: ['remainingWhenPausedSeconds'],
        message: 'Paused remainder cannot exceed timer duration',
      });
  });
export const restTimerCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('start'),
    executionId: uuidSchema,
    timerId: uuidSchema,
    durationSeconds: positiveIntegerSchema.max(86_400),
    at: instantSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    action: z.enum(['pause', 'resume', 'finish']),
    executionId: uuidSchema,
    timerId: uuidSchema,
    expectedRevision: positiveIntegerSchema,
    at: instantSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
]);
export type RestTimerState = z.infer<typeof restTimerStateSchema>;
export type RestTimerCommand = z.infer<typeof restTimerCommandSchema>;
