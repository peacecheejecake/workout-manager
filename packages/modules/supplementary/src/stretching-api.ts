import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  activityListSchema,
  manualActivityCreateSchema,
  manualActivityResultSchema,
  type ManualActivityCreate,
} from '@workout/contracts/activity';
import {
  stretchingExerciseReadSchema,
  stretchingExerciseSaveSchema,
  stretchLogCreateSchema,
  stretchPlannedTargetPageSchema,
  stretchLogCorrectSchema,
  stretchLogDeleteSchema,
  stretchLogPageSchema,
  stretchLogReadSchema,
  type StretchLogCreate,
  type StretchLogCorrect,
  type StretchLogDelete,
  type StretchingExerciseSave,
} from '@workout/contracts/stretching';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const exercisePage = z.strictObject({
  items: z.array(stretchingExerciseReadSchema).max(100),
  hasMore: z.boolean(),
});
const pathId = (id: string) => encodeURIComponent(id);
export class StretchingRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function createStretchingApi(transport: AuthenticatedTransport) {
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
      const error = errorSchema.safeParse(reply.body);
      throw new StretchingRequestError(
        reply.status,
        error.success ? error.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  return {
    listExercises(signal?: AbortSignal) {
      return request('/bff/v1/stretching/exercises', 'GET', exercisePage, null, null, signal);
    },
    readExercise(exerciseId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/stretching/exercises/${pathId(exerciseId)}`,
        'GET',
        stretchingExerciseReadSchema,
        null,
        null,
        signal,
      );
    },
    saveExercise(input: StretchingExerciseSave, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = stretchingExerciseSaveSchema.parse(input);
      return request(
        '/bff/v1/stretching/exercises',
        'POST',
        stretchingExerciseReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    listActivities(signal?: AbortSignal) {
      return request(
        '/bff/v1/activities?limit=20&offset=0',
        'GET',
        activityListSchema,
        null,
        null,
        signal,
      );
    },
    listTargets(activityId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/stretching/targets?activityId=${pathId(activityId)}`,
        'GET',
        stretchPlannedTargetPageSchema,
        null,
        null,
        signal,
      );
    },
    createActivity(input: ManualActivityCreate, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = manualActivityCreateSchema.parse(input);
      return request(
        '/bff/v1/activities',
        'POST',
        manualActivityResultSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    listLogs(activityId: string | null, signal?: AbortSignal) {
      const query = activityId === null ? '' : `?activityId=${pathId(activityId)}`;
      return request(
        `/bff/v1/stretching/logs${query}`,
        'GET',
        stretchLogPageSchema,
        null,
        null,
        signal,
      );
    },
    readLog(logId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/stretching/logs/${pathId(logId)}`,
        'GET',
        stretchLogReadSchema,
        null,
        null,
        signal,
      );
    },
    createLog(input: StretchLogCreate, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = stretchLogCreateSchema.parse(input);
      return request(
        '/bff/v1/stretching/logs',
        'POST',
        stretchLogReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    correctLog(input: StretchLogCorrect, signal?: AbortSignal) {
      const { idempotencyKey, logId, ...body } = stretchLogCorrectSchema.parse(input);
      return request(
        `/bff/v1/stretching/logs/${pathId(logId)}`,
        'PATCH',
        stretchLogReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    deleteLog(input: StretchLogDelete, signal?: AbortSignal) {
      const { idempotencyKey, logId, ...body } = stretchLogDeleteSchema.parse(input);
      return request(
        `/bff/v1/stretching/logs/${pathId(logId)}`,
        'DELETE',
        stretchLogReadSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
  };
}
export type StretchingApi = ReturnType<typeof createStretchingApi>;
