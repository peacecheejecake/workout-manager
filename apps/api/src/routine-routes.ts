import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
} from '@workout/contracts/routine-commands';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import {
  RoutineConflict,
  RoutineExpansionError,
  RoutineReferenceError,
  type RoutineRepository,
} from '@workout/server-persistence/routine-core';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const routinePath = z.strictObject({ routineId: uuid });
const versionPath = z.strictObject({ versionId: uuid });
const schedulePath = z.strictObject({ scheduleId: uuid });
const runPath = z.strictObject({ runId: uuid });
const libraryQuery = z.strictObject({
  search: z.string().max(100).optional(),
  favorite: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  archived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(100),
    hasMore: z.boolean(),
  });
const record = z.record(z.string(), z.unknown());
function payload<T>(schema: z.ZodType<T>, body: unknown, additions: Record<string, unknown>): T {
  const value = input(record, body);
  if (Object.keys(additions).some((key) => key in value))
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  return input(schema, { ...value, ...additions });
}
function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (error instanceof RoutineConflict) return new ProductRequestError(409, error.code);
    if (error instanceof RoutineExpansionError) return new ProductRequestError(422, error.code);
    if (error instanceof RoutineReferenceError) {
      return new ProductRequestError(error.code.endsWith('_NOT_FOUND') ? 404 : 422, error.code);
    }
    return undefined;
  });
}

export function registerRoutineRoutes(
  routes: FastifyInstance,
  repository: RoutineRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/routines', async (request) => {
    const query = input(libraryQuery, request.query);
    return page(routineBlueprintReadSchema).parse(
      await repository.listBlueprints(principal(request).athleteId, query),
    );
  });
  routes.get('/routines/:routineId', async (request) => {
    input(emptyQuery, request.query);
    const { routineId } = input(routinePath, request.params);
    const result = await repository.readBlueprint(principal(request).athleteId, routineId);
    if (!result) throw new ProductRequestError(404, 'BLUEPRINT_NOT_FOUND');
    return routineBlueprintReadSchema.parse(result);
  });
  routes.get('/routine-versions/:versionId', async (request) => {
    input(emptyQuery, request.query);
    const { versionId } = input(versionPath, request.params);
    const result = await repository.readBlueprintVersion(principal(request).athleteId, versionId);
    if (!result) throw new ProductRequestError(404, 'BLUEPRINT_NOT_FOUND');
    return routineBlueprintVersionSchema.parse(result);
  });
  routes.post('/routines', { bodyLimit: 1024 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = payload(routineBlueprintSaveCommandSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineBlueprintReadSchema.parse(
      await execute(() => repository.saveBlueprint(principal(request).athleteId, body)),
    );
  });
  routes.post('/routines/:routineId/library', async (request) => {
    input(emptyQuery, request.query);
    const { routineId } = input(routinePath, request.params);
    const body = payload(routineLibraryCommandSchema, request.body, {
      routineId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineBlueprintReadSchema.parse(
      await execute(() => repository.changeLibrary(principal(request).athleteId, body)),
    );
  });

  routes.post('/routine-schedule-previews', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(routineSchedulePreviewCommandSchema, request.body);
    return routineSchedulePreviewSchema.parse(
      await execute(() => repository.previewSchedule(principal(request).athleteId, body)),
    );
  });
  routes.post('/routine-schedules', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = payload(routineScheduleApproveCommandSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineScheduleReadSchema.parse(
      await execute(() => repository.approveSchedule(principal(request).athleteId, body)),
    );
  });
  routes.get('/routine-schedules', async (request) => {
    input(emptyQuery, request.query);
    return page(routineScheduleReadSchema).parse(
      await repository.listSchedules(principal(request).athleteId),
    );
  });
  routes.get('/routine-schedules/:scheduleId', async (request) => {
    input(emptyQuery, request.query);
    const { scheduleId } = input(schedulePath, request.params);
    const result = await repository.readSchedule(principal(request).athleteId, scheduleId);
    if (!result) throw new ProductRequestError(404, 'SCHEDULE_NOT_FOUND');
    return routineScheduleReadSchema.parse(result);
  });
  routes.post('/routine-schedules/:scheduleId/state', async (request) => {
    input(emptyQuery, request.query);
    const { scheduleId } = input(schedulePath, request.params);
    const body = payload(routineScheduleStateCommandSchema, request.body, {
      scheduleId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineScheduleReadSchema.parse(
      await execute(() => repository.changeSchedule(principal(request).athleteId, body)),
    );
  });

  routes.get('/routine-runs', async (request) => {
    input(emptyQuery, request.query);
    return page(routineRunReadSchema).parse(
      await repository.listRuns(principal(request).athleteId),
    );
  });
  routes.post('/routine-runs', async (request) => {
    input(emptyQuery, request.query);
    const body = payload(routineRunStartCommandSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineRunReadSchema.parse(
      await execute(() => repository.startRun(principal(request).athleteId, body)),
    );
  });
  routes.get('/routine-runs/:runId', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runPath, request.params);
    const result = await repository.readRun(principal(request).athleteId, runId);
    if (!result) throw new ProductRequestError(404, 'RUN_NOT_FOUND');
    return routineRunReadSchema.parse(result);
  });
  routes.post('/routine-runs/:runId/choice', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runPath, request.params);
    const body = payload(routineRunChoiceCommandSchema, request.body, {
      runId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineRunReadSchema.parse(
      await execute(() => repository.chooseStep(principal(request).athleteId, body)),
    );
  });
  routes.post('/routine-runs/:runId/steps', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runPath, request.params);
    const body = payload(routineRunStepCommandSchema, request.body, {
      runId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineRunReadSchema.parse(
      await execute(() => repository.recordStep(principal(request).athleteId, body)),
    );
  });
  routes.post('/routine-runs/:runId/state', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runPath, request.params);
    const body = payload(routineRunLifecycleCommandSchema, request.body, {
      runId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineRunReadSchema.parse(
      await execute(() => repository.changeRun(principal(request).athleteId, body)),
    );
  });
  routes.post('/routine-runs/:runId/timers', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runPath, request.params);
    const body = payload(routineTimerCommandSchema, request.body, {
      runId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return routineTimerSchema.parse(
      await execute(() => repository.commandTimer(principal(request).athleteId, body)),
    );
  });
}
