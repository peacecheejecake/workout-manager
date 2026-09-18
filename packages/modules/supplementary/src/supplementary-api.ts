import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  executionCreateCommandSchema,
  executionStatusCommandSchema,
  exerciseVersionReadSchema,
  exerciseVersionSaveCommandSchema,
  restTimerCommandSchema,
  restTimerStateSchema,
  routineTemplateReadSchema,
  routineTemplateSaveCommandSchema,
  setLogCorrectCommandSchema,
  setLogCreateCommandSchema,
  setLogDeleteCommandSchema,
  setLogReadSchema,
  supplementaryExecutionSchema,
  type ExecutionCreateCommand,
  type ExecutionStatusCommand,
  type ExerciseVersionSaveCommand,
  type RestTimerCommand,
  type RoutineTemplateSaveCommand,
  type SetLogCorrectCommand,
  type SetLogCreateCommand,
  type SetLogDeleteCommand,
} from '@workout/contracts/supplementary-core';

const collection = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item).max(100), hasMore: z.boolean() });
const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const base = '/bff/v1/supplementary';
const pathId = (id: string) => encodeURIComponent(id);

export class SupplementaryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function createSupplementaryApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: TransportRequest['method'],
    schema: z.ZodType<T>,
    body: TransportRequest['body'] = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
  ): Promise<T> {
    const reply = transportReplySchema.parse(
      await transport.request({
        path,
        method,
        body,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      }),
    );
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = errorSchema.safeParse(reply.body);
      throw new SupplementaryRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  return {
    listExercises(signal?: AbortSignal) {
      return request(
        `${base}/exercises`,
        'GET',
        collection(exerciseVersionReadSchema),
        null,
        null,
        signal,
      );
    },
    readExercise(exerciseId: string, signal?: AbortSignal) {
      return request(
        `${base}/exercises/${pathId(exerciseId)}`,
        'GET',
        exerciseVersionReadSchema,
        null,
        null,
        signal,
      );
    },
    saveExercise(input: ExerciseVersionSaveCommand, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = exerciseVersionSaveCommandSchema.parse(input);
      return request(
        `${base}/exercises`,
        'POST',
        exerciseVersionReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    listRoutines(signal?: AbortSignal) {
      return request(
        `${base}/routines`,
        'GET',
        collection(routineTemplateReadSchema),
        null,
        null,
        signal,
      );
    },
    readRoutine(routineId: string, signal?: AbortSignal) {
      return request(
        `${base}/routines/${pathId(routineId)}`,
        'GET',
        routineTemplateReadSchema,
        null,
        null,
        signal,
      );
    },
    readRoutineVersion(versionId: string, signal?: AbortSignal) {
      return request(
        `${base}/routine-versions/${pathId(versionId)}`,
        'GET',
        routineTemplateReadSchema,
        null,
        null,
        signal,
      );
    },
    saveRoutine(input: RoutineTemplateSaveCommand, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = routineTemplateSaveCommandSchema.parse(input);
      return request(
        `${base}/routines`,
        'POST',
        routineTemplateReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    listExecutions(signal?: AbortSignal) {
      return request(
        `${base}/executions`,
        'GET',
        collection(supplementaryExecutionSchema),
        null,
        null,
        signal,
      );
    },
    readExecution(executionId: string, signal?: AbortSignal) {
      return request(
        `${base}/executions/${pathId(executionId)}`,
        'GET',
        supplementaryExecutionSchema,
        null,
        null,
        signal,
      );
    },
    createExecution(input: ExecutionCreateCommand, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = executionCreateCommandSchema.parse(input);
      return request(
        `${base}/executions`,
        'POST',
        supplementaryExecutionSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    completeExecution(input: ExecutionStatusCommand, signal?: AbortSignal) {
      const { idempotencyKey, executionId, ...body } = executionStatusCommandSchema.parse(input);
      return request(
        `${base}/executions/${pathId(executionId)}/completion`,
        'POST',
        supplementaryExecutionSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    listSets(executionId: string, signal?: AbortSignal) {
      return request(
        `${base}/executions/${pathId(executionId)}/sets`,
        'GET',
        collection(setLogReadSchema),
        null,
        null,
        signal,
      );
    },
    createSet(input: SetLogCreateCommand, signal?: AbortSignal) {
      const { idempotencyKey, executionId, ...body } = setLogCreateCommandSchema.parse(input);
      return request(
        `${base}/executions/${pathId(executionId)}/sets`,
        'POST',
        setLogReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    correctSet(input: SetLogCorrectCommand, signal?: AbortSignal) {
      const { idempotencyKey, executionId, logId, ...body } =
        setLogCorrectCommandSchema.parse(input);
      return request(
        `${base}/executions/${pathId(executionId)}/sets/${pathId(logId)}`,
        'PATCH',
        setLogReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    deleteSet(input: SetLogDeleteCommand, signal?: AbortSignal) {
      const { idempotencyKey, executionId, logId, ...body } =
        setLogDeleteCommandSchema.parse(input);
      return request(
        `${base}/executions/${pathId(executionId)}/sets/${pathId(logId)}`,
        'DELETE',
        setLogReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    readTimer(timerId: string, signal?: AbortSignal) {
      return request(
        `${base}/rest-timers/${pathId(timerId)}`,
        'GET',
        restTimerStateSchema,
        null,
        null,
        signal,
      );
    },
    listTimers(executionId: string, signal?: AbortSignal) {
      return request(
        `${base}/executions/${pathId(executionId)}/rest-timers`,
        'GET',
        collection(restTimerStateSchema),
        null,
        null,
        signal,
      );
    },
    commandTimer(input: RestTimerCommand, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = restTimerCommandSchema.parse(input);
      return request(
        `${base}/rest-timers`,
        'POST',
        restTimerStateSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
  };
}

export type SupplementaryApi = ReturnType<typeof createSupplementaryApi>;
