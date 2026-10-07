import { z } from 'zod';
import { idSchema, timeZoneSchema } from '@workout/contracts/primitives';
import {
  nutritionOperationalStateSchema,
  type NutritionOperationalState,
  type IntegratedNutritionItem,
  type UnresolvedNutritionItem,
} from '@workout/contracts/integrated-planner';
import { createFrozenNutritionProjectorCompatibleV4 } from './nutrition-frozen-timing-projection.js';

/** Metadata captured under the authenticated tenant's RLS in the reader snapshot.
 * No source body, replacement event or permission claim enters the calculation. */
export const nutritionRaceSourceHeadSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().min(1).max(2147483647),
  deleted: z.boolean(),
  body_present: z.boolean(),
});
const inputSchema = z.strictObject({
  record: z.unknown(),
  itemId: idSchema,
  targetTimezone: timeZoneSchema,
  linkedTraining: z.unknown(),
  sourceHead: nutritionRaceSourceHeadSchema.nullable(),
});
export class NutritionOperationalTimingError extends Error {
  readonly code = 'INVALID_NUTRITION_OPERATIONAL_TIMING';
  constructor() {
    super('INVALID_NUTRITION_OPERATIONAL_TIMING');
  }
}
export interface OperationalNutritionProjection {
  projection: { date: string; value: IntegratedNutritionItem } | UnresolvedNutritionItem;
  operationalState: NutritionOperationalState | null;
}
/** Read calculation, not stored disconnection, source authority or reapproval.
 * The caller must capture the own record, exact linked Plan and source metadata. */
function requireInputBytes(value: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new NutritionOperationalTimingError();
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024)
    throw new NutritionOperationalTimingError();
}
const selectorSchema = inputSchema.pick({ itemId: true, sourceHead: true });
/** This factory validates one read context and shares its frozen item/pin maps.
 * Metadata remains a caller-owned read fact, not proof of source authority. */
export function createOperationalNutritionProjector(unknownContext: unknown) {
  const frozen = createFrozenNutritionProjectorCompatibleV4(unknownContext);
  return (unknownSelector: unknown): OperationalNutritionProjection => {
    requireInputBytes(unknownSelector);
    const result = selectorSchema.safeParse(unknownSelector);
    if (!result.success) throw new NutritionOperationalTimingError();
    const input = result.data;
    const item = frozen.item(input.itemId);
    if (!item) throw new NutritionOperationalTimingError();
    const race = item.anchor.kind === 'relative' && item.anchor.entity === 'race';
    if (
      input.sourceHead !== null &&
      (item.anchor.kind !== 'relative' ||
        item.anchor.entity !== 'race' ||
        input.sourceHead.id.toLowerCase() !== item.anchor.entityId.toLowerCase())
    )
      throw new NutritionOperationalTimingError();
    const unavailable =
      race &&
      (input.sourceHead === null || input.sourceHead.deleted || !input.sourceHead.body_present);
    const projection = frozen.project({
      itemId: input.itemId,
      raceSourceVisibility: unavailable ? 'unavailable' : 'available',
    });
    if (projection.status === 'projected')
      return { projection: projection.projection, operationalState: null };
    const identity = { planVersionId: item.planVersionId, itemId: item.id };
    const state =
      item.anchor.kind === 'disconnected'
        ? { ...identity, state: 'suspended', reason: 'race_disconnected' }
        : unavailable
          ? {
              ...identity,
              state: 'suspended',
              reason: input.sourceHead?.deleted ? 'race_disconnected' : 'source_unavailable',
            }
          : {
              ...identity,
              state: 'unresolved',
              reason:
                projection.detail === 'legacy_unpinned' ? 'legacy_unpinned' : 'timing_unresolved',
            };
    return {
      projection: projection.item,
      operationalState: nutritionOperationalStateSchema.parse(state),
    };
  };
}
export function projectOperationalNutritionTiming(
  unknownInput: unknown,
): OperationalNutritionProjection {
  requireInputBytes(unknownInput);
  const result = inputSchema.safeParse(unknownInput);
  if (!result.success) throw new NutritionOperationalTimingError();
  const { itemId, sourceHead, ...context } = result.data;
  return createOperationalNutritionProjector(context)({ itemId, sourceHead });
}
