import { z } from 'zod';
import {
  nutritionPlanVersionSchema,
  saveNutritionPlanVersionRequestSchema,
  nutritionPlanReadSchema,
} from './nutrition-core.js';
import {
  expectedRaceHeadsSchema,
  raceHeadExpectationRosterSchema,
  nutritionRaceTimingRosterSchema,
} from './nutrition-race-timing.js';

function bounded(value: unknown, context: z.RefinementCtx) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024)
    context.addIssue({
      code: 'custom',
      message: 'Complete nutrition V2 envelope exceeds 512 KiB',
    });
}
function forward(result: z.ZodSafeParseResult<unknown>, context: z.RefinementCtx) {
  if (!result.success)
    for (const issue of result.error.issues)
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
}
/** Client intent: no pins, digests, or legacy-preservation claims accepted.
 * Nested legacy command preserves its existing strict validation verbatim.
 * Confirmation is user intent; this schema is not processing/approval authority. */
export const saveNutritionPlanV2IntentSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    command: saveNutritionPlanVersionRequestSchema,
    expectedRaceHeads: expectedRaceHeadsSchema,
  })
  .superRefine((value, context) => {
    forward(
      raceHeadExpectationRosterSchema.safeParse({
        items: value.command.draft.items.map((item) => ({
          itemId: item.id,
          anchor: item.anchor,
        })),
        expectedRaceHeads: value.expectedRaceHeads,
      }),
      context,
    );
    bounded(value, context);
  });
export type SaveNutritionPlanV2Intent = z.infer<typeof saveNutritionPlanV2IntentSchema>;

/** Server-produced approved payload. Structural validation never proves source
 * ownership, freshness, legacy eligibility, deletion retention, or admission.
 * Separate V2 schema preserves top-level SQL020 identity fields and never widens legacy validation. */
export const nutritionPlanVersionV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    ...nutritionPlanVersionSchema.shape,
    raceTimingPins: nutritionRaceTimingRosterSchema.shape.raceTimingPins,
    itemRaceTimingBindings: nutritionRaceTimingRosterSchema.shape.itemRaceTimingBindings,
  })
  .superRefine((value, context) => {
    const { schemaVersion, raceTimingPins, itemRaceTimingBindings, ...legacy } = value;
    void schemaVersion;
    void raceTimingPins;
    void itemRaceTimingBindings;
    forward(nutritionPlanVersionSchema.safeParse(legacy), context);

    forward(
      nutritionRaceTimingRosterSchema.safeParse({
        items: value.items.map((item) => ({
          itemId: item.id,
          anchor: item.anchor,
        })),
        raceTimingPins: value.raceTimingPins,
        itemRaceTimingBindings: value.itemRaceTimingBindings,
      }),
      context,
    );
    bounded(value, context);
  });
export type NutritionPlanVersionV2 = z.infer<typeof nutritionPlanVersionV2Schema>;
export const nutritionPlanVersionCompatibleSchema = z.union([
  nutritionPlanVersionSchema,
  nutritionPlanVersionV2Schema,
]);
/** Read transport version is explicit; history metadata retains its old shape.
 * No live-head re-pin or end inference exists in this schema. */
export const nutritionPlanReadV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    planId: nutritionPlanReadSchema.shape.planId,
    head: nutritionPlanVersionCompatibleSchema.nullable(),
    history: nutritionPlanReadSchema.shape.history,
  })
  .superRefine((value, context) => {
    const head = value.head;
    const id = head === null ? null : head.planId;
    if (id !== null && id !== value.planId)
      context.addIssue({
        code: 'custom',
        message: 'Foreign head',
        path: ['head'],
      });
    bounded(value, context);
  });
export const nutritionPlanReadCompatibleSchema = z.union([
  nutritionPlanReadSchema,
  nutritionPlanReadV2Schema,
]);

export type NutritionPlanReadV2 = z.infer<typeof nutritionPlanReadV2Schema>;
export type NutritionPlanVersionCompatible = z.infer<typeof nutritionPlanVersionCompatibleSchema>;
export type NutritionPlanReadCompatible = z.infer<typeof nutritionPlanReadCompatibleSchema>;
