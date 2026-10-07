import { z } from 'zod';
import {
  nutritionPlanItemCoreSchema,
  nutritionPlanItemDraftSchema,
  nutritionPlanDraftSchema,
  saveNutritionPlanVersionRequestSchema,
  validateNutritionPlanItemDraft,
  validateNutritionPlanDraft,
  nutritionPlanReadSchema,
  nutritionPlansResponseSchema,
  nutritionPlanVersionSchema,
  validateNutritionPlanItem,
  validateApprovedNutritionPlan,
} from './nutrition-core.js';
import { nutritionAnchorSchema } from './nutrition.js';
import {
  nutritionPlanVersionCompatibleSchema,
  nutritionPlanReadCompatibleSchema,
} from './nutrition-race-plan-v2.js';
import {
  nutritionRaceTimingRosterSchema,
  expectedRaceHeadsSchema,
  raceHeadExpectationRosterSchema,
} from './nutrition-race-timing.js';

/** Privacy representation only. Structural validation cannot authorize deletion,
 * reconnection, approval, or processing and contains no deleted source facts. */
export const disconnectedNutritionRaceAnchorSchema = z.strictObject({
  kind: z.literal('disconnected'),
  entity: z.literal('race'),
});
const itemSchema = z
  .strictObject({
    ...nutritionPlanItemCoreSchema.shape,
    anchor: z.union([nutritionAnchorSchema, disconnectedNutritionRaceAnchorSchema]),
  })
  .superRefine(validateNutritionPlanItem);
function bounded(value: unknown, context: z.RefinementCtx) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024)
    context.addIssue({ code: 'custom', message: 'Complete nutrition V3 envelope exceeds 512 KiB' });
}
export const nutritionPlanVersionV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    ...nutritionPlanVersionSchema.shape,
    items: z.array(itemSchema).max(5_000),
    raceTimingPins: nutritionRaceTimingRosterSchema.shape.raceTimingPins,
    itemRaceTimingBindings: nutritionRaceTimingRosterSchema.shape.itemRaceTimingBindings,
  })
  .superRefine((record, context) => {
    validateApprovedNutritionPlan(record, context);
    const roster = nutritionRaceTimingRosterSchema.safeParse({
      items: record.items.flatMap((item) =>
        item.anchor.kind === 'relative' && item.anchor.entity === 'race'
          ? [{ itemId: item.id, anchor: item.anchor }]
          : [],
      ),
      raceTimingPins: record.raceTimingPins,
      itemRaceTimingBindings: record.itemRaceTimingBindings,
    });
    if (!roster.success)
      for (const issue of roster.error.issues)
        context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    bounded(record, context);
  });
export type NutritionPlanVersionV3 = z.infer<typeof nutritionPlanVersionV3Schema>;
/** Existing V1/V2 decoders remain strict and unchanged. No implicit redaction. */
export const nutritionPlanVersionCompatibleV3Schema = z.union([
  nutritionPlanVersionCompatibleSchema,
  nutritionPlanVersionV3Schema,
]);
export type NutritionPlanVersionCompatibleV3 = z.infer<
  typeof nutritionPlanVersionCompatibleV3Schema
>;
/** Explicit current head with retained history metadata. No past payload is
 * fabricated from this metadata, and no live source is substituted for a pin. */
export const nutritionPlanReadV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    planId: nutritionPlanReadSchema.shape.planId,
    head: nutritionPlanVersionCompatibleV3Schema.nullable(),
    history: nutritionPlanReadSchema.shape.history,
  })
  .superRefine((read, context) => {
    if (read.head !== null && read.head.planId !== read.planId)
      context.addIssue({ code: 'custom', message: 'Foreign head', path: ['head'] });
    bounded(read, context);
  });
export type NutritionPlanReadV3 = z.infer<typeof nutritionPlanReadV3Schema>;
export const nutritionPlanReadCompatibleV3Schema = z.union([
  nutritionPlanReadCompatibleSchema,
  nutritionPlanReadV3Schema,
]);
export type NutritionPlanReadCompatibleV3 = z.infer<typeof nutritionPlanReadCompatibleV3Schema>;

/** Explicit bounded current-head list. Retained data is not source or approval authority. */
export const nutritionPlansResponseV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    plans: z.array(nutritionPlanVersionCompatibleV3Schema).max(100),
    nextCursor: nutritionPlansResponseSchema.shape.nextCursor,
  })
  .superRefine((response, context) => {
    const ids = new Set<string>();
    for (const [index, plan] of response.plans.entries()) {
      if (ids.has(plan.planId))
        context.addIssue({
          code: 'custom',
          message: 'Duplicate current plan head',
          path: ['plans', index, 'planId'],
        });
      ids.add(plan.planId);
    }
    if (new TextEncoder().encode(JSON.stringify(response)).length > 4 * 1024 * 1024)
      context.addIssue({ code: 'custom', message: 'Nutrition V3 list exceeds 4 MiB' });
  });
export type NutritionPlansResponseV3 = z.infer<typeof nutritionPlansResponseV3Schema>;

/** Update intent only: the server must match each retained disconnected item to
 * the exact owned prior head and authenticated disconnection marker. Neither a
 * submitted state nor confirmed=true proves source permission or approval.
 */
export const nutritionPlanItemDraftV3Schema = z
  .strictObject({
    ...nutritionPlanItemDraftSchema.shape,
    anchor: z.union([nutritionAnchorSchema, disconnectedNutritionRaceAnchorSchema]),
  })
  .superRefine(validateNutritionPlanItemDraft);
export const nutritionPlanDraftV3Schema = z
  .strictObject({
    ...nutritionPlanDraftSchema.shape,
    items: z.array(nutritionPlanItemDraftV3Schema).max(5000),
  })
  .superRefine(validateNutritionPlanDraft);
export const saveNutritionPlanV3IntentSchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    command: z.strictObject({
      ...saveNutritionPlanVersionRequestSchema.options[1].shape,
      draft: nutritionPlanDraftV3Schema,
    }),
    expectedRaceHeads: expectedRaceHeadsSchema,
    reconnectItemIds: z.array(nutritionPlanItemDraftSchema.shape.id).max(5000),
  })
  .superRefine((intent, context) => {
    const items = new Map(intent.command.draft.items.map((item) => [item.id, item]));
    for (let index = 0; index < intent.reconnectItemIds.length; index++) {
      const id = intent.reconnectItemIds[index];
      const previous = intent.reconnectItemIds[index - 1];
      const item = id === undefined ? undefined : items.get(id);
      if (
        (previous !== undefined && id !== undefined && previous >= id) ||
        !item ||
        item.anchor.kind !== 'relative' ||
        item.anchor.entity !== 'race'
      )
        context.addIssue({
          code: 'custom',
          path: ['reconnectItemIds', index],
          message: 'Reconnect IDs must strictly ascend and refer to explicit race anchors',
        });
    }
    const roster = raceHeadExpectationRosterSchema.safeParse({
      items: intent.command.draft.items.flatMap((item) =>
        item.anchor.kind === 'disconnected' ? [] : [{ itemId: item.id, anchor: item.anchor }],
      ),
      expectedRaceHeads: intent.expectedRaceHeads,
    });
    if (!roster.success)
      for (const issue of roster.error.issues)
        context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    bounded(intent, context);
  });
export type NutritionPlanDraftV3 = z.infer<typeof nutritionPlanDraftV3Schema>;
export type SaveNutritionPlanV3Intent = z.infer<typeof saveNutritionPlanV3IntentSchema>;
