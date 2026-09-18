import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import { activityListSchema } from '@workout/contracts/activity';
import { planReadSchema, planSnapshotSchema } from '@workout/contracts/planning';
import {
  activeIntakeEntrySchema,
  createIntakeEntryRequestSchema,
  correctIntakeEntryRequestSchema,
  deleteIntakeEntryRequestSchema,
  deletedIntakeEntrySchema,
  foodDefinitionVersionSchema,
  intakeEntriesResponseSchema,
  intakeEntryRecordSchema,
  nutritionPlanReadSchema,
  nutritionPlansResponseSchema,
  nutritionPlanVersionSchema,
  saveFoodDefinitionVersionRequestSchema,
  saveNutritionPlanVersionRequestSchema,
  type CreateIntakeEntryRequest,
  type CorrectIntakeEntryRequest,
  type DeleteIntakeEntryRequest,
  type SaveFoodDefinitionVersionRequest,
  type SaveNutritionPlanVersionRequest,
} from '@workout/contracts/nutrition-core';

const foodsResponseSchema = z.strictObject({
  foods: z.array(foodDefinitionVersionSchema).max(100),
  nextCursor: z.string().max(512).nullable(),
});
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export class NutritionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function createNutritionApi(transport: AuthenticatedTransport) {
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
      throw new NutritionRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  const planPath = (id: string) => `/bff/v1/nutrition/plans/${encodeURIComponent(id)}`;
  const intakePath = (id: string) => `/bff/v1/nutrition/intakes/${encodeURIComponent(id)}`;
  return {
    listPlans(from: string, toInclusive: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/nutrition/plans?${new URLSearchParams({ from, toInclusive, limit: '100' })}`,
        'GET',
        nutritionPlansResponseSchema,
        null,
        null,
        signal,
      );
    },
    readPlan(planId: string, signal?: AbortSignal) {
      return request(planPath(planId), 'GET', nutritionPlanReadSchema, null, null, signal);
    },
    currentTrainingPlan(signal?: AbortSignal) {
      return request('/bff/v1/plans/current', 'GET', planReadSchema, null, null, signal);
    },
    trainingPlan(versionId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/plans/versions/${encodeURIComponent(versionId)}`,
        'GET',
        planSnapshotSchema,
        null,
        null,
        signal,
      );
    },
    savePlan(input: SaveNutritionPlanVersionRequest, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = saveNutritionPlanVersionRequestSchema.parse(input);
      return request(
        '/bff/v1/nutrition/plans',
        'POST',
        nutritionPlanVersionSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    listFoods(signal?: AbortSignal) {
      return request(
        '/bff/v1/nutrition/foods?limit=100',
        'GET',
        foodsResponseSchema,
        null,
        null,
        signal,
      );
    },
    listActivities(day: string, toExclusive: string, timezone: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/activities?${new URLSearchParams({ from: day, toExclusive, timezone, limit: '100', offset: '0', sort: 'started_desc' })}`,
        'GET',
        activityListSchema,
        null,
        null,
        signal,
      );
    },
    saveFood(input: SaveFoodDefinitionVersionRequest, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = saveFoodDefinitionVersionRequestSchema.parse(input);
      return request(
        '/bff/v1/nutrition/foods',
        'POST',
        foodDefinitionVersionSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    listIntakes(from: string, toExclusive: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/nutrition/intakes?${new URLSearchParams({ from, toExclusive, limit: '100' })}`,
        'GET',
        intakeEntriesResponseSchema,
        null,
        null,
        signal,
      );
    },
    readIntake(intakeId: string, signal?: AbortSignal) {
      return request(intakePath(intakeId), 'GET', intakeEntryRecordSchema, null, null, signal);
    },
    createIntake(input: CreateIntakeEntryRequest, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = createIntakeEntryRequestSchema.parse(input);
      return request(
        '/bff/v1/nutrition/intakes',
        'POST',
        activeIntakeEntrySchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    correctIntake(input: CorrectIntakeEntryRequest, signal?: AbortSignal) {
      const { idempotencyKey, intakeId, ...body } = correctIntakeEntryRequestSchema.parse(input);
      return request(
        intakePath(intakeId),
        'PATCH',
        activeIntakeEntrySchema,
        body,
        idempotencyKey,
        signal,
      );
    },
    deleteIntake(input: DeleteIntakeEntryRequest, signal?: AbortSignal) {
      const { idempotencyKey, intakeId, ...body } = deleteIntakeEntryRequestSchema.parse(input);
      return request(
        intakePath(intakeId),
        'DELETE',
        deletedIntakeEntrySchema,
        body,
        idempotencyKey,
        signal,
      );
    },
  };
}
