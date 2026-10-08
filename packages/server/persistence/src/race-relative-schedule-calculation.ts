import { z } from 'zod';
import type {
  RaceScheduleCalculationPorts,
  RaceScheduleCalculationPortsCompatibleV3,
  RaceScheduleCalculationPortsCompatibleV4,
} from '@workout/server-coaching/race-relative-schedule-impact';
import {
  nutritionPlanItemCoreSchema,
  nutritionPlanVersionSchema,
} from '@workout/contracts/nutrition-core';
import {
  nutritionPlanVersionCompatibleV3Schema,
  nutritionPlanVersionV3Schema,
} from '@workout/contracts/nutrition-race-plan-v3';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { createFrozenNutritionProjectorCompatibleV4 } from './nutrition-frozen-timing-projection.js';
import { planDraftSchema } from '@workout/contracts/planning';
import { raceEventSchema } from '@workout/contracts/races';
import { routineScheduleVersionSchema, routineOccurrenceSchema } from '@workout/contracts/routines';
import { localDateSchema, localTimeSchema } from '@workout/contracts/primitives';
import { projectNutritionItem } from './integrated-planner.js';
import { expandRoutineSchedule, RoutineExpansionError } from './routine-expansion.js';

const nutritionInput = z.strictObject({
  item: nutritionPlanItemCoreSchema,
  record: nutritionPlanVersionSchema,
  sourcePlan: planDraftSchema.nullable(),
  event: raceEventSchema,
});
const routineInput = z.strictObject({
  schedule: routineScheduleVersionSchema,
  sourcePlan: planDraftSchema.nullable(),
});
const timing = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('resolved'),
    date: localDateSchema,
    localTime: localTimeSchema.nullable(),
  }),
  z.strictObject({
    state: z.literal('unresolved'),
    reason: z.enum([
      'missing_anchor',
      'missing_session_time',
      'missing_session_duration',
      'ambiguous_local_time',
      'timezone_mismatch',
      'offset_out_of_range',
    ]),
  }),
]);
const expansionReason = z.enum([
  'SOURCE_PLAN_REQUIRED',
  'SOURCE_PLAN_TIMEZONE_MISMATCH',
  'PERIOD_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'ANCHOR_OUTSIDE_WINDOW',
  'ANCHOR_OUTSIDE_PERIOD',
  'EXPANSION_LIMIT_EXCEEDED',
  'DUPLICATE_ANCHOR',
]);
const expansion = z.strictObject({
  state: z.literal('expanded'),
  occurrences: z.array(routineOccurrenceSchema).max(100),
});
export interface RaceRelativeScheduleCalculationPorts extends RaceScheduleCalculationPorts {
  resolveNutrition(raw: unknown): z.infer<typeof timing>;
  expandRoutine(
    raw: unknown,
  ): z.infer<typeof expansion> | { state: 'unresolved'; reason: z.infer<typeof expansionReason> };
}
function bounded(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 4194304)
    throw new Error('INVALID_CALCULATION_INPUT');
}

/** Pure adapter only. Source ownership/freshness is the collector's responsibility;
 * no reads, approval, consent grant or lifecycle mutation occurs here. */
export function createRaceRelativeScheduleCalculationPorts(
  knownRaceEvents: unknown = [],
): RaceRelativeScheduleCalculationPorts {
  bounded(knownRaceEvents);
  const decoded = z.array(raceEventSchema).max(5000).parse(knownRaceEvents);
  const captured = new Map<string, z.infer<typeof raceEventSchema>>();
  for (const event of decoded) {
    const existing = captured.get(event.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event))
      throw new Error('INVALID_CALCULATION_INPUT');
    captured.set(event.id, event);
  }
  // Decode produces a private snapshot; later caller mutations cannot alter it.
  const capturedBodies = [...captured.values()];
  return {
    resolveNutrition(raw: unknown) {
      bounded({ capturedRaceEvents: capturedBodies, calculation: raw });
      const { item, record, sourcePlan, event } = nutritionInput.parse(raw);
      if (item.planVersionId !== record.versionId) throw new Error('INVALID_CALCULATION_INPUT');
      const linked = new Map<string, z.infer<typeof planDraftSchema>>();
      if (sourcePlan && record.linkedTrainingPlanVersionId !== null)
        linked.set(record.linkedTrainingPlanVersionId, sourcePlan);
      // Captured other-race anchors keep their own exact bodies. Only the
      // explicit preview event overrides its ID for before/after calculation.
      // No normal reader is wired to mutable races or synthetic Plan sessions.
      const races = new Map(captured);
      races.set(event.id, event);
      const result = projectNutritionItem(item, record, linked, record.timezone, races);
      return timing.parse(
        'value' in result
          ? { state: 'resolved', date: result.date, localTime: result.value.localTime }
          : { state: 'unresolved', reason: result.reason },
      );
    },
    expandRoutine(raw: unknown) {
      bounded({ capturedRaceEvents: capturedBodies, calculation: raw });
      const { schedule, sourcePlan } = routineInput.parse(raw);
      try {
        return expansion.parse({
          state: 'expanded',
          occurrences: expandRoutineSchedule(schedule, sourcePlan),
        });
      } catch (error) {
        if (!(error instanceof RoutineExpansionError)) throw error;
        // Unknown failures are not silently converted to a supported mapping.
        return { state: 'unresolved' as const, reason: expansionReason.parse(error.code) };
      }
    },
  };
}

const nutritionInputCompatibleV3 = nutritionInput.extend({
  item: nutritionPlanVersionV3Schema.shape.items.element,
  record: nutritionPlanVersionCompatibleV3Schema,
  proposedFromEvent: raceEventSchema.optional(),
});
const nutritionInputCompatibleV4 = nutritionInputCompatibleV3.extend({
  record: nutritionPlanVersionCompatibleV4Schema,
});
const timingCompatibleV3 = z.union([
  timing,
  z.strictObject({
    state: z.literal('unresolved'),
    reason: z.literal('unsupported_anchor_mapping'),
  }),
]);
const nutritionContextCompatibleV4 = nutritionInputCompatibleV4.omit({ item: true });
/** Bound before parsing or cloning; no accessors or mutable identity cache. */
function boundedNutrition(raw: unknown): void {
  const active = new Set<object>();
  let bytes = 0,
    nodes = 0;
  function charge(value: string) {
    if (value.length > 4194304) throw new Error('INVALID_CALCULATION_INPUT');
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > 4194304) throw new Error('INVALID_CALCULATION_INPUT');
  }
  function visit(value: unknown, depth: number): void {
    if (++nodes > 4194304 || depth > 64) throw new Error('INVALID_CALCULATION_INPUT');
    if (typeof value === 'string') return charge(value);
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return;
    if (typeof value !== 'object' || active.has(value))
      throw new Error('INVALID_CALCULATION_INPUT');
    const array = Array.isArray(value),
      proto: unknown = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      throw new Error('INVALID_CALCULATION_INPUT');
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 4194304) throw new Error('INVALID_CALCULATION_INPUT');
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new Error('INVALID_CALCULATION_INPUT');
      charge(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor) || (array && key !== String(count++)))
        throw new Error('INVALID_CALCULATION_INPUT');
      visit(descriptor.value, depth + 1);
    }
    if (array && count !== value.length) throw new Error('INVALID_CALCULATION_INPUT');
    active.delete(value);
  }
  try {
    visit(raw, 0);
    bounded(raw);
  } catch {
    throw new Error('INVALID_CALCULATION_INPUT');
  }
}

/** Internal preview adapter: saved timing and hypothetical event timing remain separate; no capture or write. */
export interface RaceRelativeScheduleCalculationPortsCompatibleV3 extends RaceScheduleCalculationPortsCompatibleV3 {
  resolveNutrition(raw: unknown): z.infer<typeof timingCompatibleV3>;
}
export interface RaceRelativeScheduleCalculationPortsCompatibleV4 extends RaceScheduleCalculationPortsCompatibleV4 {
  resolveNutrition(raw: unknown): z.infer<typeof timingCompatibleV3>;
  /** Private immutable calculation snapshot only; never source authority. */
  prepareNutritionContext(raw: unknown): {
    resolveNutrition(unknownItem: unknown): z.infer<typeof timingCompatibleV3>;
  };
}
export function createRaceRelativeScheduleCalculationPortsCompatibleV3(
  knownRaceEvents: unknown = [],
): RaceRelativeScheduleCalculationPortsCompatibleV3 {
  const ports = createRaceRelativeScheduleCalculationPortsCompatibleV4(knownRaceEvents);
  return {
    expandRoutine: (context) => ports.expandRoutine(context),
    resolveNutrition(raw) {
      bounded(raw);
      return ports.resolveNutrition(nutritionInputCompatibleV3.parse(raw));
    },
  };
}
export function createRaceRelativeScheduleCalculationPortsCompatibleV4(
  knownRaceEvents: unknown = [],
): RaceRelativeScheduleCalculationPortsCompatibleV4 {
  const legacy = createRaceRelativeScheduleCalculationPorts(knownRaceEvents);
  const currentEvents = new Map(
    z
      .array(raceEventSchema)
      .max(5000)
      .parse(knownRaceEvents)
      .map((event) => [event.id, event]),
  );
  const visible = new Set(currentEvents.keys());
  function preparedContext(context: z.infer<typeof nutritionContextCompatibleV4>) {
    const { record, sourcePlan, event, proposedFromEvent } = context;
    const legacyContextBytes = !('schemaVersion' in record)
      ? Buffer.byteLength(
          JSON.stringify({ capturedRaceEvents: [...currentEvents.values()], calculation: context }),
          'utf8',
        )
      : null;
    // These maps and views belong to this parsed snapshot. Never cache a caller's
    // mutable record identity or select a body by version ID alone.
    const items = new Map(record.items.map((item) => [item.id, item]));
    const bindings = new Map(
      'schemaVersion' in record
        ? record.itemRaceTimingBindings.map((row) => [row.itemId, row.binding])
        : [],
    );
    const pins = new Map(
      'schemaVersion' in record
        ? record.raceTimingPins.map((pin) => [
            JSON.stringify([pin.eventId, pin.eventRevision]),
            pin,
          ])
        : [],
    );
    const calculationPlan = {
      ...record,
      items: record.items.flatMap((saved) =>
        saved.anchor.kind === 'disconnected' ? [] : [{ ...saved, anchor: saved.anchor }],
      ),
    };
    const linked = new Map<string, z.infer<typeof planDraftSchema>>();
    if (sourcePlan && record.linkedTrainingPlanVersionId)
      linked.set(record.linkedTrainingPlanVersionId, sourcePlan);
    const races = new Map(currentEvents);
    races.set(event.id, event);
    let projector: ReturnType<typeof createFrozenNutritionProjectorCompatibleV4> | undefined;
    return {
      resolveNutrition(unknownItem: unknown) {
        boundedNutrition(unknownItem);
        const item = nutritionInputCompatibleV4.shape.item.parse(unknownItem);
        if (
          legacyContextBytes !== null &&
          legacyContextBytes + Buffer.byteLength(JSON.stringify(item), 'utf8') + 8 > 4194304
        )
          throw new Error('INVALID_CALCULATION_INPUT');
        const saved = items.get(item.id);
        if (item.planVersionId !== record.versionId || !saved)
          throw new Error('INVALID_CALCULATION_INPUT');
        if (!('schemaVersion' in record)) {
          const result = projectNutritionItem(
            nutritionPlanItemCoreSchema.parse(item),
            record,
            linked,
            record.timezone,
            races,
          );
          return timingCompatibleV3.parse(
            'value' in result
              ? { state: 'resolved', date: result.date, localTime: result.value.localTime }
              : { state: 'unresolved', reason: result.reason },
          );
        }
        if (item.anchor.kind === 'disconnected')
          return { state: 'unresolved' as const, reason: 'missing_anchor' as const };
        if (item.anchor.kind === 'relative' && item.anchor.entity === 'race') {
          if (JSON.stringify(saved) !== JSON.stringify(item))
            return { state: 'unresolved' as const, reason: 'unsupported_anchor_mapping' as const };
          if (proposedFromEvent) {
            const binding = bindings.get(item.id);
            if (!binding || binding.state !== 'captured')
              return {
                state: 'unresolved' as const,
                reason: 'unsupported_anchor_mapping' as const,
              };
            const pin = pins.get(JSON.stringify([binding.eventId, binding.eventRevision]));
            if (
              !pin ||
              JSON.stringify(currentEvents.get(proposedFromEvent.id)) !==
                JSON.stringify(proposedFromEvent) ||
              binding.eventId !== item.anchor.entityId ||
              event.id !== binding.eventId ||
              proposedFromEvent.id !== event.id ||
              proposedFromEvent.revision < binding.eventRevision ||
              JSON.stringify({ ...event, localDate: proposedFromEvent.localDate }) !==
                JSON.stringify(proposedFromEvent)
            )
              throw new Error('INVALID_CALCULATION_INPUT');
            const result = projectNutritionItem(
              nutritionPlanItemCoreSchema.parse(item),
              calculationPlan,
              new Map(),
              record.timezone,
              new Map([[event.id, event]]),
            );
            return timingCompatibleV3.parse(
              'value' in result
                ? { state: 'resolved', date: result.date, localTime: result.value.localTime }
                : { state: 'unresolved', reason: result.reason },
            );
          }
          projector ??= createFrozenNutritionProjectorCompatibleV4({
            record,
            targetTimezone: record.timezone,
            linkedTraining:
              sourcePlan && record.linkedTrainingPlanVersionId
                ? { versionId: record.linkedTrainingPlanVersionId, draft: sourcePlan }
                : null,
          });
          const result = projector.project({
            itemId: item.id,
            raceSourceVisibility:
              visible.has(item.anchor.entityId) || item.anchor.entityId === event.id
                ? 'available'
                : 'unavailable',
          });
          return timingCompatibleV3.parse(
            result.status === 'projected'
              ? {
                  state: 'resolved',
                  date: result.projection.date,
                  localTime: result.projection.value.localTime,
                }
              : { state: 'unresolved', reason: result.item.reason },
          );
        }
        const result = projectNutritionItem(
          nutritionPlanItemCoreSchema.parse(item),
          calculationPlan,
          linked,
          record.timezone,
        );
        return timingCompatibleV3.parse(
          'value' in result
            ? { state: 'resolved', date: result.date, localTime: result.value.localTime }
            : { state: 'unresolved', reason: result.reason },
        );
      },
    };
  }
  return {
    expandRoutine: (context) => legacy.expandRoutine(context),
    prepareNutritionContext(raw) {
      boundedNutrition(raw);
      return preparedContext(nutritionContextCompatibleV4.parse(raw));
    },
    resolveNutrition(raw) {
      // The public unknown boundary still validates the entire tuple each call.
      bounded(raw);
      const { item, ...context } = nutritionInputCompatibleV4.parse(raw);
      if (!('schemaVersion' in context.record)) {
        if (
          item.planVersionId !== context.record.versionId ||
          !context.record.items.some((row) => row.id === item.id)
        )
          throw new Error('INVALID_CALCULATION_INPUT');
        return legacy.resolveNutrition({
          ...context,
          item: nutritionPlanItemCoreSchema.parse(item),
        });
      }
      return preparedContext(context).resolveNutrition(item);
    },
  };
}
