import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  routineBlueprintReadSchema,
  routineBlueprintSaveCommandSchema,
  routineLibraryCommandSchema,
  routineRunChoiceCommandSchema,
  routineRunLifecycleCommandSchema,
  routineRunReadSchema,
  routineRunStartCommandSchema,
  routineRunStepCommandSchema,
  routineScheduleApproveCommandSchema,
  routineSchedulePreviewCommandSchema,
  routineSchedulePreviewSchema,
  routineScheduleReadSchema,
  routineScheduleStateCommandSchema,
  routineTimerCommandSchema,
  routineTimerSchema,
  type RoutineBlueprintSaveCommand,
  type RoutineLibraryCommand,
  type RoutineRunChoiceCommand,
  type RoutineRunLifecycleCommand,
  type RoutineRunStartCommand,
  type RoutineRunStepCommand,
  type RoutineScheduleApproveCommand,
  type RoutineSchedulePreviewCommand,
  type RoutineScheduleStateCommand,
  type RoutineTimerCommand,
} from '@workout/contracts/routine-commands';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';

const collection = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(100),
    hasMore: z.boolean(),
  });
const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const base = '/bff/v1';
const pathId = (id: string) => encodeURIComponent(id);

export class RoutineRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function createRoutineApi(transport: AuthenticatedTransport) {
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
      throw new RoutineRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  const command = <T>(
    path: string,
    schema: z.ZodType<T>,
    raw: { idempotencyKey: string },
    body: unknown,
  ) => request(path, 'POST', schema, z.json().parse(body), raw.idempotencyKey);
  return {
    listBlueprints(search = '', signal?: AbortSignal) {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      return request(
        `${base}/routines${params.size ? `?${params}` : ''}`,
        'GET',
        collection(routineBlueprintReadSchema),
        null,
        null,
        signal,
      );
    },
    readBlueprint(id: string, signal?: AbortSignal) {
      return request(
        `${base}/routines/${pathId(id)}`,
        'GET',
        routineBlueprintReadSchema,
        null,
        null,
        signal,
      );
    },
    readBlueprintVersion(id: string, signal?: AbortSignal) {
      return request(
        `${base}/routine-versions/${pathId(id)}`,
        'GET',
        routineBlueprintVersionSchema,
        null,
        null,
        signal,
      );
    },
    saveBlueprint(raw: RoutineBlueprintSaveCommand) {
      const { idempotencyKey, ...body } = routineBlueprintSaveCommandSchema.parse(raw);
      return command(`${base}/routines`, routineBlueprintReadSchema, { idempotencyKey }, body);
    },
    changeLibrary(raw: RoutineLibraryCommand) {
      const { routineId, idempotencyKey, ...body } = routineLibraryCommandSchema.parse(raw);
      return command(
        `${base}/routines/${pathId(routineId)}/library`,
        routineBlueprintReadSchema,
        { idempotencyKey },
        body,
      );
    },
    previewSchedule(raw: RoutineSchedulePreviewCommand) {
      const body = routineSchedulePreviewCommandSchema.parse(raw);
      return request(
        `${base}/routine-schedule-previews`,
        'POST',
        routineSchedulePreviewSchema,
        body,
      );
    },
    approveSchedule(raw: RoutineScheduleApproveCommand) {
      const { idempotencyKey, ...body } = routineScheduleApproveCommandSchema.parse(raw);
      return command(
        `${base}/routine-schedules`,
        routineScheduleReadSchema,
        { idempotencyKey },
        body,
      );
    },
    listSchedules(signal?: AbortSignal) {
      return request(
        `${base}/routine-schedules`,
        'GET',
        collection(routineScheduleReadSchema),
        null,
        null,
        signal,
      );
    },
    readSchedule(id: string, signal?: AbortSignal) {
      return request(
        `${base}/routine-schedules/${pathId(id)}`,
        'GET',
        routineScheduleReadSchema,
        null,
        null,
        signal,
      );
    },
    changeSchedule(raw: RoutineScheduleStateCommand) {
      const { scheduleId, idempotencyKey, ...body } = routineScheduleStateCommandSchema.parse(raw);
      return command(
        `${base}/routine-schedules/${pathId(scheduleId)}/state`,
        routineScheduleReadSchema,
        { idempotencyKey },
        body,
      );
    },
    startRun(raw: RoutineRunStartCommand) {
      const { idempotencyKey, ...body } = routineRunStartCommandSchema.parse(raw);
      return command(`${base}/routine-runs`, routineRunReadSchema, { idempotencyKey }, body);
    },
    readRun(id: string, signal?: AbortSignal) {
      return request(
        `${base}/routine-runs/${pathId(id)}`,
        'GET',
        routineRunReadSchema,
        null,
        null,
        signal,
      );
    },
    listRuns(signal?: AbortSignal) {
      return request(
        `${base}/routine-runs`,
        'GET',
        collection(routineRunReadSchema),
        null,
        null,
        signal,
      );
    },
    chooseStep(raw: RoutineRunChoiceCommand) {
      const { runId, idempotencyKey, ...body } = routineRunChoiceCommandSchema.parse(raw);
      return command(
        `${base}/routine-runs/${pathId(runId)}/choice`,
        routineRunReadSchema,
        { idempotencyKey },
        body,
      );
    },
    recordStep(raw: RoutineRunStepCommand) {
      const { runId, idempotencyKey, ...body } = routineRunStepCommandSchema.parse(raw);
      return command(
        `${base}/routine-runs/${pathId(runId)}/steps`,
        routineRunReadSchema,
        { idempotencyKey },
        body,
      );
    },
    changeRun(raw: RoutineRunLifecycleCommand) {
      const { runId, idempotencyKey, ...body } = routineRunLifecycleCommandSchema.parse(raw);
      return command(
        `${base}/routine-runs/${pathId(runId)}/state`,
        routineRunReadSchema,
        { idempotencyKey },
        body,
      );
    },
    commandTimer(raw: RoutineTimerCommand) {
      const { runId, idempotencyKey, ...body } = routineTimerCommandSchema.parse(raw);
      return command(
        `${base}/routine-runs/${pathId(runId)}/timers`,
        routineTimerSchema,
        { idempotencyKey },
        body,
      );
    },
  };
}
export type RoutineApi = ReturnType<typeof createRoutineApi>;
