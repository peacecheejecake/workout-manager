import { z } from 'zod';
import { nutritionPlanVersionCompatibleV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { planDraftSchema } from '@workout/contracts/planning';
import { idSchema, timeZoneSchema, localDateSchema } from '@workout/contracts/primitives';
import {
  integratedNutritionItemSchema,
  unresolvedNutritionItemSchema,
  type UnresolvedNutritionItem,
} from '@workout/contracts/integrated-planner';
import { projectNutritionItem } from './nutrition-item-projection.js';
import { localInstant } from './nutrition-calendar.js';

const inputSchema = z.strictObject({
  record: nutritionPlanVersionCompatibleV3Schema,
  itemId: idSchema,
  targetTimezone: timeZoneSchema,
  linkedTraining: z.strictObject({ versionId: z.uuid(), draft: planDraftSchema }).nullable(),
  // This is a caller-owned visibility fact, not a permission or deletion policy.
  // The function has no ability to authenticate a source or establish this fact.
  raceSourceVisibility: z.enum(['available', 'unknown', 'unavailable']),
});
const projectedSchema = z.strictObject({
  date: localDateSchema,
  value: integratedNutritionItemSchema,
});
type Detail =
  | 'race_disconnected'
  | 'legacy_unpinned'
  | 'source_visibility_unknown'
  | 'source_unavailable'
  | 'race_end_unknown'
  | 'start_unknown'
  | 'ambiguous_local_time'
  | 'offset_out_of_range'
  | 'existing_projection_unresolved';
type Boundary = { storage: 'not_persisted'; approvalAllowed: false };
export type FrozenNutritionProjection = Boundary &
  (
    | { status: 'projected'; projection: z.infer<typeof projectedSchema> }
    | { status: 'unresolved'; item: UnresolvedNutritionItem; detail: Detail }
  );
export class FrozenNutritionProjectionError extends Error {
  readonly code = 'NUTRITION_FROZEN_TIMING_INVALID_INPUT';
  constructor() {
    super('NUTRITION_FROZEN_TIMING_INVALID_INPUT');
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Pure calculation only. Exact linked historical training and visibility facts
 * must be established by the caller. No mutable race input, query, storage,
 * approval or source-availability authority is exposed. Ordinary historical
 * readers/three writers are not integrated by this preparation port. */
const contextSchema = inputSchema.omit({ itemId: true, raceSourceVisibility: true });
const contextSchemaCompatibleV4 = contextSchema.extend({
  record: nutritionPlanVersionCompatibleV4Schema,
});
const selectorSchema = inputSchema.pick({ itemId: true, raceSourceVisibility: true });
function requireInputBytes(value: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new FrozenNutritionProjectionError();
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024)
    throw new FrozenNutritionProjectionError();
}
function validatedFactory(context: z.infer<typeof contextSchemaCompatibleV4>) {
  const record = freeze(context.record);
  if (
    context.linkedTraining !== null &&
    context.linkedTraining.versionId !== record.linkedTrainingPlanVersionId
  )
    throw new FrozenNutritionProjectionError();
  const items = new Map(record.items.map((item) => [item.id, item]));
  // Calculation-only typed view for the legacy pure projector. A disconnected
  // item is never passed to it; the complete captured record remains unchanged.
  const projectionPlan = {
    ...record,
    items: record.items.flatMap((item) =>
      item.anchor.kind === 'disconnected' ? [] : [{ ...item, anchor: item.anchor }],
    ),
  };
  const bindings = new Map(
    'schemaVersion' in record
      ? record.itemRaceTimingBindings.map((entry) => [entry.itemId, entry.binding])
      : [],
  );
  const pins = new Map(
    'schemaVersion' in record
      ? record.raceTimingPins.map((entry) => [
          JSON.stringify([entry.eventId, entry.eventRevision]),
          entry,
        ])
      : [],
  );
  const linked = new Map<string, z.infer<typeof planDraftSchema>>();
  if (context.linkedTraining)
    linked.set(context.linkedTraining.versionId, context.linkedTraining.draft);
  return {
    record,
    item(itemId: string) {
      return items.get(itemId);
    },
    project(unknownSelector: unknown): FrozenNutritionProjection {
      requireInputBytes(unknownSelector);
      const parsed = selectorSchema.safeParse(unknownSelector);
      if (!parsed.success) throw new FrozenNutritionProjectionError();
      const input = { ...context, ...parsed.data };
      const item = items.get(input.itemId);
      if (!item) throw new FrozenNutritionProjectionError();
      const unresolved = (
        detail: Detail,
        reason: UnresolvedNutritionItem['reason'] = 'missing_anchor',
      ): FrozenNutritionProjection =>
        freeze({
          storage: 'not_persisted',
          approvalAllowed: false,
          status: 'unresolved',
          item: unresolvedNutritionItemSchema.parse({
            id: item.id,
            planVersionId: item.planVersionId,
            title: item.title,
            category: item.category,
            source: item.source,
            reason,
          }),
          detail,
        });
      if (item.anchor.kind === 'disconnected') return unresolved('race_disconnected');
      if (item.anchor.kind !== 'relative' || item.anchor.entity === 'session') {
        const result = projectNutritionItem(
          { ...item, anchor: item.anchor },
          projectionPlan,
          linked,
          input.targetTimezone,
        );
        if ('reason' in result)
          return freeze({
            storage: 'not_persisted',
            approvalAllowed: false,
            status: 'unresolved',
            item: result,
            detail: 'existing_projection_unresolved',
          });
        return freeze({
          storage: 'not_persisted',
          approvalAllowed: false,
          status: 'projected',
          projection: projectedSchema.parse(result),
        });
      }
      if (!('schemaVersion' in record)) return unresolved('legacy_unpinned');
      const binding = bindings.get(item.id);
      if (!binding || binding.state === 'legacy_unpinned') return unresolved('legacy_unpinned');
      if (input.raceSourceVisibility === 'unknown') return unresolved('source_visibility_unknown');
      if (input.raceSourceVisibility === 'unavailable') return unresolved('source_unavailable');
      const pin = pins.get(JSON.stringify([binding.eventId, binding.eventRevision]));
      if (!pin) throw new FrozenNutritionProjectionError();
      if (item.anchor.point === 'end') return unresolved('race_end_unknown');
      if (pin.start.state === 'unknown')
        return unresolved(
          'start_unknown',
          pin.start.reason === 'ambiguous_local_time'
            ? 'ambiguous_local_time'
            : 'missing_session_time',
        );
      if (pin.localStartTime === null) return unresolved('start_unknown');
      const unique = localInstant(pin.localDate, pin.localStartTime, pin.timezone);
      const saved = Date.parse(pin.start.instant);
      if (unique === null || unique !== saved)
        return unresolved('ambiguous_local_time', 'ambiguous_local_time');
      const instant = saved + item.anchor.offsetMinutes * 60_000;
      if (!Number.isFinite(instant) || Math.abs(instant) > 8_640_000_000_000_000)
        return unresolved('offset_out_of_range', 'offset_out_of_range');
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: input.targetTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(instant);
      const part = (name: string) => parts.find((entry) => entry.type === name)?.value;
      const projection = projectedSchema.safeParse({
        date: `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`,
        value: {
          id: item.id,
          planVersionId: item.planVersionId,
          title: item.title,
          category: item.category,
          source: item.source,
          localTime: `${part('hour')}:${part('minute')}:${part('second')}`,
        },
      });
      if (!projection.success) return unresolved('offset_out_of_range', 'offset_out_of_range');
      return freeze({
        storage: 'not_persisted',
        approvalAllowed: false,
        status: 'projected',
        projection: projection.data,
      });
    },
  };
}
/** Per-record maps are scoped to this immutable read context; no health singleton.
 * Runtime validation and record byte checks run once, selectors stay bounded. */
export function createFrozenNutritionProjector(unknownContext: unknown) {
  requireInputBytes(unknownContext);
  const parsed = contextSchema.safeParse(unknownContext);
  if (!parsed.success) throw new FrozenNutritionProjectionError();
  return validatedFactory(parsed.data);
}
/** Strict public unknown boundary retains the existing single-item behavior. */
export function projectFrozenNutritionTiming(unknownInput: unknown): FrozenNutritionProjection {
  requireInputBytes(unknownInput);
  const parsed = inputSchema.safeParse(unknownInput);
  if (!parsed.success) throw new FrozenNutritionProjectionError();
  const { itemId, raceSourceVisibility, ...context } = parsed.data;
  return validatedFactory(context).project({ itemId, raceSourceVisibility });
}

/** Explicit multipin context; old unknown entries keep their original strict V3 decoder. */
export function createFrozenNutritionProjectorCompatibleV4(unknownContext: unknown) {
  requireInputBytes(unknownContext);
  const parsed = contextSchemaCompatibleV4.safeParse(unknownContext);
  if (!parsed.success) throw new FrozenNutritionProjectionError();
  return validatedFactory(parsed.data);
}
