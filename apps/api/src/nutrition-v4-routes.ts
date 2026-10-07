import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  nutritionPlanPublicApproveV4RequestSchema,
  nutritionPlanPublicPreviewV4RequestSchema,
  nutritionPlanPublicPreviewV4Schema,
  nutritionPlanPublicApprovalV4ResultSchema,
  nutritionPlanPublicCapabilitiesV4Schema,
} from '@workout/contracts/nutrition-race-plan-public-v4';
import {
  NutritionRacePlanV4WriterError,
  type NutritionRacePlanV4Writer,
} from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import {
  NutritionReferenceError,
  type NutritionPlanV4Reader,
} from '@workout/server-persistence/nutrition-core';
import { NutritionRacePlanV4PreviewError } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { RaceTimingBindingError } from '@workout/server-persistence/race-timing-bindings';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

/** Actual configured protocol ports only. Presence never proves installation,
 * consent, current source availability or permission to approve a plan. */
export interface NutritionV4RoutesPorts {
  writer?: NutritionRacePlanV4Writer;
  preview?: { previewPlanV4(athleteId: string, input: unknown): Promise<unknown> };
  reader?: NutritionPlanV4Reader;
}
const params = z.strictObject({ planId: z.uuid().transform((id) => id.toLowerCase()) });
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
function response<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProductRequestError(500, 'INTERNAL_ERROR');
  return parsed.data;
}
function approvalResponse(raw: unknown) {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw new ProductRequestError(500, 'INTERNAL_ERROR');
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || !keys.includes('plan') || !keys.includes('notices'))
    throw new ProductRequestError(500, 'INTERNAL_ERROR');
  const plan = Object.getOwnPropertyDescriptor(raw, 'plan');
  const notices = Object.getOwnPropertyDescriptor(raw, 'notices');
  if (!plan?.enumerable || !notices?.enumerable || !('value' in plan) || !('value' in notices))
    throw new ProductRequestError(500, 'INTERNAL_ERROR');
  return response(nutritionPlanPublicApprovalV4ResultSchema, {
    schemaVersion: 4,
    plan: plan.value,
    notices: notices.value,
  });
}
function translate(error: unknown): ProductRequestError | undefined {
  if (error instanceof NutritionRacePlanV4PreviewError)
    return new ProductRequestError(
      error.code === 'NUTRITION_V4_PREVIEW_INVALID_INPUT' ? 400 : 503,
      error.code,
    );
  if (error instanceof NutritionRacePlanV4WriterError) {
    switch (error.code) {
      case 'NUTRITION_V4_LIMIT':
        return new ProductRequestError(422, error.code);
      case 'NUTRITION_V4_ORIGIN_REQUIRED':
      case 'NUTRITION_V4_RECONNECT_REQUIRED':
      case 'NUTRITION_V4_RECONNECT_INVALID':
      case 'NUTRITION_V4_TIMING_UNRESOLVED':
        return new ProductRequestError(422, error.code);
      case 'NUTRITION_V4_SOURCE_INVALID':
        return new ProductRequestError(500, 'INTERNAL_ERROR');
    }
  }
  if (error instanceof NutritionReferenceError)
    return new ProductRequestError(error.code === 'PLAN_NOT_FOUND' ? 404 : 422, error.code);
  if (error instanceof RaceTimingBindingError) {
    switch (error.code) {
      case 'RACE_TIMING_STALE':
        return new ProductRequestError(409, error.code);
      case 'RACE_TIMING_UNAVAILABLE':
        return new ProductRequestError(404, error.code);
      case 'RACE_TIMING_LIMIT':
        return new ProductRequestError(422, error.code);
      case 'RACE_TIMING_INVALID_INPUT':
      case 'RACE_TIMING_TENANT_MISMATCH':
      case 'RACE_TIMING_INVALID_SOURCE':
        return new ProductRequestError(500, 'INTERNAL_ERROR');
    }
  }
  return undefined;
}
/** Encapsulated under the existing authenticated product/CSRF plugin. Existing
 * V1 reads/saves and V4 read negotiation remain unchanged. No configured
 * activation, private marker grant or migration admission is provided here. */
export function registerNutritionV4Routes(
  routes: FastifyInstance,
  ports: NutritionV4RoutesPorts,
  principal: (request: FastifyRequest) => Principal,
): void {
  routes.register(async (api) => {
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store');
    });
    api.get('/nutrition/plans/capabilities', async (request) => {
      principal(request);
      input(emptyQuery, request.query);
      return nutritionPlanPublicCapabilitiesV4Schema.parse({
        schemaVersion: 1,
        readV4: ports.reader !== undefined,
        previewV4: ports.preview !== undefined,
        standaloneApprovalV4: ports.writer !== undefined,
      });
    });
    api.post('/nutrition/plans/:planId/preview-v4', { bodyLimit: 524288 }, async (request) => {
      const athleteId = principal(request).athleteId;
      input(emptyQuery, request.query);
      const { planId } = input(params, request.params);
      if (request.headers['idempotency-key'] !== undefined)
        throw new ProductRequestError(400, 'INVALID_REQUEST');
      const body = input(nutritionPlanPublicPreviewV4RequestSchema, request.body);
      const preview = ports.preview;
      if (!preview) throw new ProductRequestError(503, 'NUTRITION_V4_PORT_UNAVAILABLE');
      const result = response(
        nutritionPlanPublicPreviewV4Schema,
        await command(() => preview.previewPlanV4(athleteId, { ...body, planId }), translate),
      );
      if (
        result.status !== 'unavailable' &&
        (result.expectedPlan.planId !== planId ||
          result.expectedPlan.versionId !== body.expectedHeadVersionId ||
          JSON.stringify(result.expectedRaceHeads) !== JSON.stringify(body.expectedRaceHeads))
      )
        throw new ProductRequestError(500, 'INTERNAL_ERROR');
      return result;
    });
    api.post('/nutrition/plans/:planId/approve-v4', { bodyLimit: 524288 }, async (request) => {
      const athleteId = principal(request).athleteId;
      input(emptyQuery, request.query);
      const { planId } = input(params, request.params);
      const idempotencyKey = input(key, request.headers['idempotency-key']);
      const body = input(nutritionPlanPublicApproveV4RequestSchema, request.body);
      const writer = ports.writer;
      if (!writer) throw new ProductRequestError(503, 'NUTRITION_V4_PORT_UNAVAILABLE');
      const result = approvalResponse(
        await command(
          () =>
            writer.savePlanV4(athleteId, {
              ...body,
              intent: {
                ...body.intent,
                command: { ...body.intent.command, planId, idempotencyKey },
              },
            }),
          translate,
        ),
      );
      if (
        result.plan.planId !== planId ||
        result.plan.previousVersionId !== body.intent.command.expectedHeadVersionId
      )
        throw new ProductRequestError(500, 'INTERNAL_ERROR');
      return result;
    });
  });
}
