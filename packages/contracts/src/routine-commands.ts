import { z } from 'zod';
import { idSchema, instantSchema, nonEmptyStringSchema, revisionSchema } from './primitives.js';
import {
  actualRefSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  routineScheduleVersionSchema,
  stepOutcomeSchema,
} from './routines.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const key = z.string().min(8).max(128);

export const routineBlueprintSaveCommandSchema = z.strictObject({
  blueprint: routineBlueprintVersionSchema,
  expectedVersionId: uuid.nullable(),
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineBlueprintReadSchema = z.strictObject({
  blueprint: routineBlueprintVersionSchema,
  version: z.number().int().positive(),
  favorite: z.boolean(),
  visibility: z.enum(['active', 'archived', 'deleted']),
});
export const routineLibraryCommandSchema = z.strictObject({
  routineId: uuid,
  action: z.enum(['favorite', 'unfavorite', 'archive', 'restore', 'delete']),
  expectedVersionId: uuid,
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineSchedulePreviewCommandSchema = z.strictObject({
  schedule: routineScheduleVersionSchema,
  sourcePlanVersionId: uuid.nullable(),
});
export const routineSchedulePreviewSchema = z.strictObject({
  schedule: routineScheduleVersionSchema,
  sourcePlanVersionId: uuid.nullable(),
  occurrences: z.array(routineOccurrenceSchema).max(100),
  conflicts: z.array(
    z.strictObject({
      anchorKey: nonEmptyStringSchema,
      kind: z.enum(['session_overlap', 'routine_overlap', 'unresolved_anchor', 'locked_session']),
      description: z.string(),
    }),
  ),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const routineScheduleApproveCommandSchema = routineSchedulePreviewCommandSchema.extend({
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineScheduleReadSchema = z.strictObject({
  schedule: routineScheduleVersionSchema,
  sourcePlanVersionId: uuid.nullable(),
  occurrences: z.array(routineOccurrenceSchema).max(100),
  notificationMuted: z.boolean(),
  impactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const routineScheduleStateCommandSchema = z.strictObject({
  scheduleId: uuid,
  action: z.enum(['pause', 'resume', 'end', 'mute', 'unmute']),
  expectedVersionId: uuid,
  previewDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineRunStartCommandSchema = z.strictObject({
  runId: uuid,
  blueprintVersionId: uuid,
  occurrenceId: uuid.nullable(),
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineRunChoiceCommandSchema = z.strictObject({
  runId: uuid,
  groupId: idSchema,
  stepId: idSchema,
  expectedRevision: revisionSchema,
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineRunStepCommandSchema = z.strictObject({
  runId: uuid,
  stepId: idSchema,
  state: stepOutcomeSchema,
  actualRefs: z.array(actualRefSchema).max(20),
  occurredAt: instantSchema.nullable(),
  reason: z.string().max(500).nullable(),
  expectedRevision: revisionSchema,
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineRunLifecycleCommandSchema = z.strictObject({
  runId: uuid,
  action: z.enum(['pause', 'resume', 'end', 'stop']),
  expectedRevision: revisionSchema,
  idempotencyKey: key,
  confirmed: z.literal(true),
});
export const routineTimerCommandSchema = z.strictObject({
  runId: uuid,
  stepId: idSchema,
  action: z.enum(['start', 'pause', 'resume', 'clear']),
  durationSeconds: z.number().int().positive().max(86400).nullable(),
  expectedRevision: revisionSchema.nullable(),
  idempotencyKey: key,
});
export const routineTimerSchema = z.strictObject({
  runId: uuid,
  stepId: idSchema,
  revision: revisionSchema,
  state: z.enum(['running', 'paused', 'cleared']),
  durationSeconds: z.number().int().positive().max(86400),
  startedAt: instantSchema,
  pausedAt: instantSchema.nullable(),
  pausedMilliseconds: z.number().int().nonnegative(),
});
export const routineRunReadSchema = z.strictObject({
  run: routineRunSchema,
  timers: z.array(routineTimerSchema),
});

export type RoutineBlueprintSaveCommand = z.infer<typeof routineBlueprintSaveCommandSchema>;
export type RoutineBlueprintRead = z.infer<typeof routineBlueprintReadSchema>;
export type RoutineLibraryCommand = z.infer<typeof routineLibraryCommandSchema>;
export type RoutineSchedulePreviewCommand = z.infer<typeof routineSchedulePreviewCommandSchema>;
export type RoutineSchedulePreview = z.infer<typeof routineSchedulePreviewSchema>;
export type RoutineScheduleApproveCommand = z.infer<typeof routineScheduleApproveCommandSchema>;
export type RoutineScheduleRead = z.infer<typeof routineScheduleReadSchema>;
export type RoutineScheduleStateCommand = z.infer<typeof routineScheduleStateCommandSchema>;
export type RoutineRunStartCommand = z.infer<typeof routineRunStartCommandSchema>;
export type RoutineRunChoiceCommand = z.infer<typeof routineRunChoiceCommandSchema>;
export type RoutineRunStepCommand = z.infer<typeof routineRunStepCommandSchema>;
export type RoutineRunLifecycleCommand = z.infer<typeof routineRunLifecycleCommandSchema>;
export type RoutineTimerCommand = z.infer<typeof routineTimerCommandSchema>;
export type RoutineTimer = z.infer<typeof routineTimerSchema>;
export type RoutineRunRead = z.infer<typeof routineRunReadSchema>;
