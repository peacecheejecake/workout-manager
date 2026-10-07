import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  activeIntakeEntrySchema,
  correctIntakeEntryRequestSchema,
  createIntakeEntryRequestSchema,
  deleteIntakeEntryRequestSchema,
  deletedIntakeEntrySchema,
  foodDefinitionVersionSchema,
  intakeEntriesQuerySchema,
  intakeEntriesResponseSchema,
  intakeEntryRecordSchema,
  nutritionPlanReadSchema,
  nutritionPlansQuerySchema,
  nutritionPlansResponseSchema,
  nutritionPlanVersionSchema,
  saveFoodDefinitionVersionRequestSchema,
  saveNutritionPlanVersionRequestSchema,
} from '@workout/contracts/nutrition-core';
import {
  NutritionReferenceError,
  NutritionReadVersionError,
  NutritionReadLimitError,
  NutritionValidationError,
  type NutritionRepository,
} from '@workout/server-persistence/nutrition-core';
import { nutritionPlanReadV2Schema } from '@workout/contracts/nutrition-race-plan-v2';
import {
  nutritionPlanReadV3Schema,
  nutritionPlansResponseV3Schema,
  nutritionPlanVersionCompatibleV3Schema,
} from '@workout/contracts/nutrition-race-plan-v3';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const planPathSchema = z.strictObject({ planId: z.uuid().transform((id) => id.toLowerCase()) });
const boundedIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((id) => id.trim() === id);
const foodPathSchema = z.strictObject({ foodId: boundedIdSchema });
const intakePathSchema = z.strictObject({ intakeId: boundedIdSchema });
const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
const version = z.coerce.number().int().min(1).max(3).optional();
const nutritionPlanReadQuerySchema = z.strictObject({ maxSchemaVersion: version });
const nutritionPlanListQuerySchema = listQuerySchema.extend({
  maxSchemaVersion: version,
  from: z.iso.date(),
  toInclusive: z.iso.date(),
});
const intakeListQuerySchema = listQuerySchema.extend({
  from: z.iso.datetime({ offset: true }),
  toExclusive: z.iso.datetime({ offset: true }),
});
const foodsResponseSchema = z.strictObject({
  foods: z.array(foodDefinitionVersionSchema).max(100),
  nextCursor: z.string().max(512).nullable(),
});
const recordSchema = z.record(z.string(), z.unknown());

function requestPayload<T>(
  schema: z.ZodType<T>,
  body: unknown,
  additions: Record<string, unknown>,
) {
  const record = input(recordSchema, body);
  if (Object.keys(additions).some((key) => key in record)) {
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  }
  return input(schema, { ...record, ...additions });
}

function nutritionRequestError(error: unknown): ProductRequestError | undefined {
  if (error instanceof NutritionReadVersionError) return new ProductRequestError(409, error.code);
  if (error instanceof NutritionReadLimitError) return new ProductRequestError(422, error.code);
  if (error instanceof NutritionReferenceError) {
    const statusCode = ['PLAN_NOT_FOUND', 'FOOD_NOT_FOUND', 'INTAKE_NOT_FOUND'].includes(error.code)
      ? 404
      : 422;
    return new ProductRequestError(statusCode, error.code);
  }
  if (error instanceof NutritionValidationError) {
    return new ProductRequestError(422, error.code);
  }
  if (error instanceof Error && error.message === 'INVALID_CURSOR') {
    return new ProductRequestError(400, 'INVALID_CURSOR');
  }
  return undefined;
}

function nutritionCommand<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, nutritionRequestError);
}

export function registerNutritionRoutes(
  routes: FastifyInstance,
  nutrition: NutritionRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/nutrition/plans', async (request) => {
    const { maxSchemaVersion = 1, ...query } = input(nutritionPlanListQuerySchema, request.query);
    const inputQuery = input(nutritionPlansQuerySchema, { ...query, cursor: query.cursor ?? null });
    if (maxSchemaVersion === 2)
      throw new ProductRequestError(409, 'NUTRITION_READ_VERSION_UNSUPPORTED');
    if (maxSchemaVersion === 3)
      return nutritionPlansResponseV3Schema.parse(
        await nutritionCommand(() =>
          nutrition.listPlansV3(principal(request).athleteId, inputQuery),
        ),
      );
    return nutritionPlansResponseSchema.parse(
      await nutritionCommand(() => nutrition.listPlans(principal(request).athleteId, inputQuery)),
    );
  });
  routes.get('/nutrition/plans/:planId', async (request) => {
    const { maxSchemaVersion = 1 } = input(nutritionPlanReadQuerySchema, request.query);
    const { planId } = input(planPathSchema, request.params);
    if (maxSchemaVersion === 3) {
      const result = await nutritionCommand(() =>
        nutrition.readPlanV3(principal(request).athleteId, planId),
      );
      if (result === null) throw new ProductRequestError(404, 'NUTRITION_PLAN_NOT_FOUND');
      return nutritionPlanReadV3Schema.parse(result);
    }
    if (maxSchemaVersion === 2) {
      const result = await nutritionCommand(() =>
        nutrition.readPlanV2(principal(request).athleteId, planId),
      );
      if (result === null) throw new ProductRequestError(404, 'NUTRITION_PLAN_NOT_FOUND');
      return nutritionPlanReadV2Schema.parse(result);
    }
    const result = await nutritionCommand(() =>
      nutrition.readPlan(principal(request).athleteId, planId),
    );
    if (result === null) throw new ProductRequestError(404, 'NUTRITION_PLAN_NOT_FOUND');
    return nutritionPlanReadSchema.parse(result);
  });
  // Replay only: a missing receipt never becomes a new approval or save.
  routes.post('/nutrition/plans/replay-v3', { bodyLimit: 1024 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const payload = requestPayload(saveNutritionPlanVersionRequestSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    const result = await nutritionCommand(() =>
      nutrition.replayPlanV3(principal(request).athleteId, payload),
    );
    if (result === null) throw new ProductRequestError(404, 'NUTRITION_SAVE_RECEIPT_NOT_FOUND');
    return nutritionPlanVersionCompatibleV3Schema.parse(result);
  });
  routes.post('/nutrition/plans', { bodyLimit: 1024 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const payload = requestPayload(saveNutritionPlanVersionRequestSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return nutritionPlanVersionSchema.parse(
      await nutritionCommand(() => nutrition.savePlan(principal(request).athleteId, payload)),
    );
  });

  routes.get('/nutrition/foods', async (request) => {
    const query = input(listQuerySchema, request.query);
    return foodsResponseSchema.parse(
      await nutritionCommand(() =>
        nutrition.listFoods(principal(request).athleteId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        }),
      ),
    );
  });
  routes.get('/nutrition/foods/:foodId', async (request) => {
    input(emptyQuery, request.query);
    const { foodId } = input(foodPathSchema, request.params);
    const result = await nutrition.readFood(principal(request).athleteId, foodId);
    if (result === null) throw new ProductRequestError(404, 'FOOD_NOT_FOUND');
    return foodDefinitionVersionSchema.parse(result);
  });
  routes.post('/nutrition/foods', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const payload = requestPayload(saveFoodDefinitionVersionRequestSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return foodDefinitionVersionSchema.parse(
      await nutritionCommand(() => nutrition.saveFood(principal(request).athleteId, payload)),
    );
  });

  routes.get('/nutrition/intakes', async (request) => {
    const query = input(intakeListQuerySchema, request.query);
    return intakeEntriesResponseSchema.parse(
      await nutritionCommand(() =>
        nutrition.listIntakes(
          principal(request).athleteId,
          input(intakeEntriesQuerySchema, { ...query, cursor: query.cursor ?? null }),
        ),
      ),
    );
  });
  routes.get('/nutrition/intakes/:intakeId', async (request) => {
    input(emptyQuery, request.query);
    const { intakeId } = input(intakePathSchema, request.params);
    const result = await nutrition.readIntake(principal(request).athleteId, intakeId);
    if (result === null) throw new ProductRequestError(404, 'INTAKE_NOT_FOUND');
    return intakeEntryRecordSchema.parse(result);
  });
  routes.post('/nutrition/intakes', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const payload = requestPayload(createIntakeEntryRequestSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return activeIntakeEntrySchema.parse(
      await nutritionCommand(() => nutrition.createIntake(principal(request).athleteId, payload)),
    );
  });
  routes.patch('/nutrition/intakes/:intakeId', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { intakeId } = input(intakePathSchema, request.params);
    const payload = requestPayload(correctIntakeEntryRequestSchema, request.body, {
      intakeId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return activeIntakeEntrySchema.parse(
      await nutritionCommand(() => nutrition.correctIntake(principal(request).athleteId, payload)),
    );
  });
  routes.delete('/nutrition/intakes/:intakeId', async (request) => {
    input(emptyQuery, request.query);
    const { intakeId } = input(intakePathSchema, request.params);
    const payload = requestPayload(deleteIntakeEntryRequestSchema, request.body, {
      intakeId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return deletedIntakeEntrySchema.parse(
      await nutritionCommand(() => nutrition.deleteIntake(principal(request).athleteId, payload)),
    );
  });
}
