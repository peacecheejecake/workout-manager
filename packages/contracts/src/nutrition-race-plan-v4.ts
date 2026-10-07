import { z } from 'zod';
import {
  nutritionPlanReadSchema,
  nutritionPlansResponseSchema,
  validateApprovedNutritionPlan,
} from './nutrition-core.js';
import { raceTimingPinV1Schema, itemRaceTimingBindingSchema } from './nutrition-race-timing.js';
import {
  nutritionPlanVersionV3Schema,
  nutritionPlanVersionCompatibleV3Schema,
  nutritionPlanReadCompatibleV3Schema,
  saveNutritionPlanV3IntentSchema,
} from './nutrition-race-plan-v3.js';

/** Explicit multipin representation only. Captured immutable source facts remain
 * distinct by [eventId,eventRevision]; no live repinning or approval authority.
 * Historical V1/V2/V3 schemas and their single-pin roster stay unchanged. */
const sourceUuid = z.uuid().refine((id) => id === id.toLowerCase());
const tupleKey = (eventId: string, revision: number) => JSON.stringify([eventId, revision]);
export const nutritionPlanVersionV4Schema = z
  .strictObject({
    ...nutritionPlanVersionV3Schema.shape,
    schemaVersion: z.literal(4),
    raceTimingPins: z.array(raceTimingPinV1Schema).max(5000),
    itemRaceTimingBindings: z.array(itemRaceTimingBindingSchema).max(5000),
  })
  .superRefine((record, context) => {
    validateApprovedNutritionPlan(record, context);
    const pins = new Map<string, z.infer<typeof raceTimingPinV1Schema>>();
    for (const [index, pin] of record.raceTimingPins.entries()) {
      const previous = record.raceTimingPins[index - 1];
      if (
        previous &&
        (previous.eventId > pin.eventId ||
          (previous.eventId === pin.eventId && previous.eventRevision >= pin.eventRevision))
      )
        context.addIssue({
          code: 'custom',
          path: ['raceTimingPins', index],
          message: 'Pins must strictly ascend by event UUID and numeric revision',
        });
      const key = tupleKey(pin.eventId, pin.eventRevision);
      if (pins.has(key))
        context.addIssue({
          code: 'custom',
          path: ['raceTimingPins', index],
          message: 'Duplicate or conflicting exact pin tuple',
        });
      pins.set(key, pin);
    }
    const items = new Map(record.items.map((item) => [item.id, item]));
    const boundItems = new Set<string>(),
      usedPins = new Set<string>();
    for (const [index, entry] of record.itemRaceTimingBindings.entries()) {
      const previous = record.itemRaceTimingBindings[index - 1];
      if (previous && previous.itemId >= entry.itemId)
        context.addIssue({
          code: 'custom',
          path: ['itemRaceTimingBindings', index],
          message: 'Bindings must strictly ascend by item ID',
        });
      const item = items.get(entry.itemId);
      if (boundItems.has(entry.itemId))
        context.addIssue({
          code: 'custom',
          path: ['itemRaceTimingBindings', index],
          message: 'Duplicate item binding',
        });
      boundItems.add(entry.itemId);
      if (!item || item.anchor.kind !== 'relative' || item.anchor.entity !== 'race') {
        context.addIssue({
          code: 'custom',
          path: ['itemRaceTimingBindings', index],
          message: 'Binding must belong to an active race anchor',
        });
        continue;
      }
      if (entry.binding.state === 'legacy_unpinned') {
        if (entry.binding.priorItemId !== item.id)
          context.addIssue({
            code: 'custom',
            path: ['itemRaceTimingBindings', index],
            message: 'Legacy binding must retain its exact item identity',
          });
        continue;
      }
      const key = tupleKey(entry.binding.eventId, entry.binding.eventRevision);
      if (item.anchor.entityId !== entry.binding.eventId || !pins.has(key))
        context.addIssue({
          code: 'custom',
          path: ['itemRaceTimingBindings', index],
          message: 'Captured binding must match the exact owned-source pin tuple',
        });
      else usedPins.add(key);
    }
    for (const [index, item] of record.items.entries())
      if (item.anchor.kind === 'relative' && item.anchor.entity === 'race') {
        if (!sourceUuid.safeParse(item.anchor.entityId).success)
          context.addIssue({
            code: 'custom',
            path: ['items', index, 'anchor', 'entityId'],
            message: 'Race identity must be a canonical lowercase UUID',
          });
        if (!boundItems.has(item.id))
          context.addIssue({
            code: 'custom',
            path: ['items', index],
            message: 'Active race item requires an explicit binding',
          });
      }
    for (const [index, pin] of record.raceTimingPins.entries())
      if (!usedPins.has(tupleKey(pin.eventId, pin.eventRevision)))
        context.addIssue({
          code: 'custom',
          path: ['raceTimingPins', index],
          message: 'Unused source pin',
        });
  });
export type NutritionPlanVersionV4 = z.infer<typeof nutritionPlanVersionV4Schema>;
export const nutritionPlanVersionCompatibleV4Schema = z.union([
  nutritionPlanVersionCompatibleV3Schema,
  nutritionPlanVersionV4Schema,
]);
export type NutritionPlanVersionCompatibleV4 = z.infer<
  typeof nutritionPlanVersionCompatibleV4Schema
>;
export const nutritionPlanReadV4Schema = z
  .strictObject({
    schemaVersion: z.literal(4),
    planId: nutritionPlanReadSchema.shape.planId,
    head: nutritionPlanVersionCompatibleV4Schema.nullable(),
    history: nutritionPlanReadSchema.shape.history,
  })
  .superRefine((read, context) => {
    if (read.head !== null && read.head.planId !== read.planId)
      context.addIssue({ code: 'custom', path: ['head'], message: 'Foreign head' });
    if (new TextEncoder().encode(JSON.stringify(read)).byteLength > 512 * 1024)
      context.addIssue({ code: 'custom', message: 'Nutrition V4 read exceeds 512 KiB' });
  });
export type NutritionPlanReadV4 = z.infer<typeof nutritionPlanReadV4Schema>;
export const nutritionPlanReadCompatibleV4Schema = z.union([
  nutritionPlanReadCompatibleV3Schema,
  nutritionPlanReadV4Schema,
]);
export type NutritionPlanReadCompatibleV4 = z.infer<typeof nutritionPlanReadCompatibleV4Schema>;
export const nutritionPlansResponseV4Schema = z
  .strictObject({
    schemaVersion: z.literal(4),
    plans: z.array(nutritionPlanVersionCompatibleV4Schema).max(100),
    nextCursor: nutritionPlansResponseSchema.shape.nextCursor,
  })
  .superRefine((response, context) => {
    const seen = new Set<string>();
    for (const [index, plan] of response.plans.entries()) {
      if (seen.has(plan.planId))
        context.addIssue({
          code: 'custom',
          path: ['plans', index, 'planId'],
          message: 'Duplicate current head',
        });
      seen.add(plan.planId);
    }
    if (new TextEncoder().encode(JSON.stringify(response)).byteLength > 4 * 1024 * 1024)
      context.addIssue({ code: 'custom', message: 'Nutrition V4 list exceeds 4 MiB' });
  });
export type NutritionPlansResponseV4 = z.infer<typeof nutritionPlansResponseV4Schema>;
/** Explicit update intent wrapper. The nested V3 command reuses all exact
 * expected-head/reconnect validation. Neither wrapper nor confirmation authorizes
 * lineage/storage; no client pins, changed IDs or approval proof accepted. */
export const saveNutritionPlanV4IntentSchema = z
  .strictObject({ schemaVersion: z.literal(4), intent: saveNutritionPlanV3IntentSchema })
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024)
      context.addIssue({ code: 'custom', message: 'Nutrition V4 intent exceeds 512 KiB' });
  });
export type SaveNutritionPlanV4Intent = z.infer<typeof saveNutritionPlanV4IntentSchema>;
