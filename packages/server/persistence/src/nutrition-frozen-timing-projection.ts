import { nutritionPlanDraftV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { z } from 'zod';
import { nutritionPlanVersionCompatibleV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import {
  nutritionPlanVersionCompatibleV4Schema,
  nutritionPlanVersionV4Schema,
} from '@workout/contracts/nutrition-race-plan-v4';
import { planDraftSchema } from '@workout/contracts/planning';
import { idSchema, timeZoneSchema, localDateSchema } from '@workout/contracts/primitives';
import {
  integratedNutritionItemSchema,
  unresolvedNutritionItemSchema,
  type UnresolvedNutritionItem,
} from '@workout/contracts/integrated-planner';
import { projectNutritionItem, projectNutritionTimingCore } from './nutrition-item-projection.js';
import { localInstant, localParts } from './nutrition-calendar.js';

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
  const ancestors = new Set<object>();
  let visits = 0,
    bytes = 0;
  function charge(s: string) {
    bytes += Buffer.byteLength(s, 'utf8');
    if (bytes > 4194304) throw new FrozenNutritionProjectionError();
  }
  function visit(v: unknown, depth: number): void {
    if (++visits > 500000 || depth > 64) throw new FrozenNutritionProjectionError();
    if (typeof v === 'string') {
      charge(v);
      return;
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return;
    if (typeof v !== 'object' || ancestors.has(v)) throw new FrozenNutritionProjectionError();
    const array = Array.isArray(v);
    if (
      array
        ? Object.getPrototypeOf(v) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    )
      throw new FrozenNutritionProjectionError();
    ancestors.add(v);
    let count = 0;
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string') throw new FrozenNutritionProjectionError();
      if (array && key === 'length') continue;
      charge(key);
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !('value' in d)) throw new FrozenNutritionProjectionError();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length))
        throw new FrozenNutritionProjectionError();
      count++;
      visit(d.value, depth + 1);
    }
    if (array && count !== v.length) throw new FrozenNutritionProjectionError();
    ancestors.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4194304)
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
    timing(unknownSelector: unknown): NutritionTransientTimingV4 {
      requireInputBytes(unknownSelector);
      const selector = selectorSchema.safeParse(unknownSelector);
      if (!selector.success) throw new FrozenNutritionProjectionError();
      const item = items.get(selector.data.itemId);
      if (!item) throw new FrozenNutritionProjectionError();
      if (item.anchor.kind === 'disconnected')
        return { state: 'suspended', reason: 'race_disconnected' };
      if (item.anchor.kind === 'relative' && item.anchor.entity === 'race') {
        const binding = bindings.get(item.id);
        if (!binding || binding.state === 'legacy_unpinned')
          return { state: 'unresolved', reason: 'missing_anchor', detail: 'legacy_unpinned' };
        if (selector.data.raceSourceVisibility !== 'available')
          return {
            state: 'unresolved',
            reason: 'missing_anchor',
            detail:
              selector.data.raceSourceVisibility === 'unknown'
                ? 'source_visibility_unknown'
                : 'source_unavailable',
          };
        const pin = pins.get(JSON.stringify([binding.eventId, binding.eventRevision]));
        if (!pin) throw new FrozenNutritionProjectionError();
        return capturedRaceTiming(item.anchor, pin, context.targetTimezone);
      }
      return coreTiming(
        item.anchor,
        record.linkedTrainingPlanVersionId,
        linked,
        context.targetTimezone,
      );
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
      const timing = capturedRaceTiming(item.anchor, pin, input.targetTimezone);
      if (timing.state !== 'resolved')
        return unresolved(
          timing.state === 'unresolved'
            ? timing.detail === 'start_unknown'
              ? 'start_unknown'
              : timing.reason === 'ambiguous_local_time'
                ? 'ambiguous_local_time'
                : timing.reason === 'offset_out_of_range'
                  ? 'offset_out_of_range'
                  : (timing.detail ?? 'existing_projection_unresolved')
            : 'race_disconnected',
          timing.state === 'unresolved' ? timing.reason : 'missing_anchor',
        );
      const projection = projectedSchema.safeParse({
        date: timing.date,
        value: {
          id: item.id,
          planVersionId: item.planVersionId,
          title: item.title,
          category: item.category,
          source: item.source,
          localTime: timing.localTime,
        },
      });
      if (!projection.success)
        return unresolved('existing_projection_unresolved', 'offset_out_of_range');
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

/** A transient calculation view, never an approved version or source credential. */
const transientContextSchema = z
  .strictObject({
    draft: nutritionPlanDraftV3Schema,
    raceTimingPins: nutritionPlanVersionV4Schema.shape.raceTimingPins,
    itemRaceTimingBindings: nutritionPlanVersionV4Schema.shape.itemRaceTimingBindings,
    targetTimezone: timeZoneSchema,
    linkedTraining: contextSchema.shape.linkedTraining,
  })
  .superRefine((c, ctx) => {
    const pins = new Map<string, unknown>(),
      used = new Set<string>(),
      items = new Map(c.draft.items.map((i) => [i.id, i])),
      bound = new Set<string>();
    for (const pin of c.raceTimingPins) {
      const key = JSON.stringify([pin.eventId, pin.eventRevision]);
      if (pins.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate source tuple' });
      pins.set(key, pin);
    }
    for (const b of c.itemRaceTimingBindings) {
      const item = items.get(b.itemId);
      if (
        bound.has(b.itemId) ||
        !item ||
        item.anchor.kind !== 'relative' ||
        item.anchor.entity !== 'race'
      ) {
        ctx.addIssue({ code: 'custom', message: 'Binding item mismatch' });
        continue;
      }
      bound.add(b.itemId);
      if (b.binding.state === 'captured') {
        const key = JSON.stringify([b.binding.eventId, b.binding.eventRevision]);
        if (item.anchor.entityId !== b.binding.eventId || !pins.has(key))
          ctx.addIssue({ code: 'custom', message: 'Missing captured tuple' });
        used.add(key);
      }
    }
    if (
      c.draft.items.some(
        (i) => i.anchor.kind === 'relative' && i.anchor.entity === 'race' && !bound.has(i.id),
      ) ||
      [...pins.keys()].some((k) => !used.has(k))
    )
      ctx.addIssue({ code: 'custom', message: 'Source roster mismatch' });
    if (
      c.linkedTraining !== null &&
      c.linkedTraining.versionId !== c.draft.linkedTrainingPlanVersionId
    )
      ctx.addIssue({ code: 'custom', message: 'Training tuple mismatch' });
  });
export type NutritionTransientTimingV4 =
  | {
      state: 'resolved';
      date: string;
      localTime: string | null;
      timezone: string;
      instant: string | null;
    }
  | { state: 'suspended'; reason: 'race_disconnected' }
  | { state: 'unresolved'; reason: UnresolvedNutritionItem['reason']; detail: Detail | null };
function capturedRaceTiming(
  anchor: { point: 'start' | 'end'; offsetMinutes: number },
  pin: z.infer<typeof nutritionPlanVersionV4Schema>['raceTimingPins'][number],
  timezone: string,
): NutritionTransientTimingV4 {
  const unresolved = (
    detail: Detail,
    reason: UnresolvedNutritionItem['reason'] = 'missing_anchor',
  ): NutritionTransientTimingV4 => ({ state: 'unresolved', reason, detail });
  if (anchor.point === 'end') return unresolved('race_end_unknown');
  if (pin.start.state === 'unknown' || pin.localStartTime === null)
    return unresolved(
      'start_unknown',
      pin.start.state === 'unknown' && pin.start.reason === 'ambiguous_local_time'
        ? 'ambiguous_local_time'
        : 'missing_session_time',
    );
  const saved = Date.parse(pin.start.instant),
    unique = localInstant(pin.localDate, pin.localStartTime, pin.timezone);
  if (unique === null || unique !== saved)
    return unresolved('existing_projection_unresolved', 'ambiguous_local_time');
  const instant = saved + anchor.offsetMinutes * 60000;
  if (!Number.isFinite(instant) || Math.abs(instant) > 8640000000000000)
    return unresolved('existing_projection_unresolved', 'offset_out_of_range');
  const parts = localParts(instant, timezone);
  if (!localDateSchema.safeParse(parts.date).success)
    return unresolved('existing_projection_unresolved', 'offset_out_of_range');
  return {
    state: 'resolved',
    date: parts.date,
    localTime: parts.time,
    timezone,
    instant: new Date(instant).toISOString(),
  };
}
/** No version/approval IDs, clock or storage adapter is accepted or generated. */
export function createTransientNutritionTimingProjectorV4(unknownContext: unknown) {
  requireInputBytes(unknownContext);
  const parsed = transientContextSchema.safeParse(unknownContext);
  if (!parsed.success) throw new FrozenNutritionProjectionError();
  const c = freeze(parsed.data),
    items = new Map(c.draft.items.map((i) => [i.id, i])),
    bindings = new Map(c.itemRaceTimingBindings.map((b) => [b.itemId, b.binding])),
    pins = new Map(c.raceTimingPins.map((p) => [JSON.stringify([p.eventId, p.eventRevision]), p]));
  const linked = new Map<string, z.infer<typeof planDraftSchema>>();
  if (c.linkedTraining) linked.set(c.linkedTraining.versionId, c.linkedTraining.draft);
  return {
    project(unknownSelector: unknown): NutritionTransientTimingV4 {
      requireInputBytes(unknownSelector);
      const selector = selectorSchema.safeParse(unknownSelector);
      if (!selector.success) throw new FrozenNutritionProjectionError();
      const item = items.get(selector.data.itemId);
      if (!item) throw new FrozenNutritionProjectionError();
      if (item.anchor.kind === 'disconnected')
        return { state: 'suspended', reason: 'race_disconnected' };
      if (item.anchor.kind === 'relative' && item.anchor.entity === 'race') {
        const binding = bindings.get(item.id);
        if (!binding || binding.state === 'legacy_unpinned')
          return { state: 'unresolved', reason: 'missing_anchor', detail: 'legacy_unpinned' };
        if (selector.data.raceSourceVisibility !== 'available')
          return {
            state: 'unresolved',
            reason: 'missing_anchor',
            detail:
              selector.data.raceSourceVisibility === 'unknown'
                ? 'source_visibility_unknown'
                : 'source_unavailable',
          };
        const pin = pins.get(JSON.stringify([binding.eventId, binding.eventRevision]));
        if (!pin) throw new FrozenNutritionProjectionError();
        return capturedRaceTiming(item.anchor, pin, c.targetTimezone);
      }
      return coreTiming(item.anchor, c.draft.linkedTrainingPlanVersionId, linked, c.targetTimezone);
    },
  };
}

function coreTiming(
  anchor: Parameters<typeof projectNutritionTimingCore>[0],
  linkedId: string | null,
  linked: Parameters<typeof projectNutritionTimingCore>[2],
  timezone: string,
): NutritionTransientTimingV4 {
  const timing = projectNutritionTimingCore(anchor, linkedId, linked, timezone);
  if ('reason' in timing)
    return { state: 'unresolved', reason: timing.reason, detail: 'existing_projection_unresolved' };
  if (timing.localTime !== null && timing.instant === null)
    return {
      state: 'unresolved',
      reason: 'ambiguous_local_time',
      detail: 'existing_projection_unresolved',
    };
  return {
    state: 'resolved',
    date: timing.date,
    localTime: timing.localTime,
    timezone,
    instant: timing.instant === null ? null : new Date(timing.instant).toISOString(),
  };
}
/** The genuine strict approved record is decoded here. No manual draft, approval
 * metadata or version identity is synthesized to evaluate historical before. */
export function createApprovedNutritionTimingProjectorV4(unknownContext: unknown) {
  requireInputBytes(unknownContext);
  const parsed = contextSchemaCompatibleV4.safeParse(unknownContext);
  if (!parsed.success) throw new FrozenNutritionProjectionError();
  const factory = validatedFactory(parsed.data);
  return { project: factory.timing };
}
