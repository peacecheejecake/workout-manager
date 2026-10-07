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
/** Internal preview adapter: saved timing and hypothetical event timing remain separate; no capture or write. */
export interface RaceRelativeScheduleCalculationPortsCompatibleV3 extends RaceScheduleCalculationPortsCompatibleV3 {
  resolveNutrition(raw: unknown): z.infer<typeof timingCompatibleV3>;
}
export interface RaceRelativeScheduleCalculationPortsCompatibleV4 extends RaceScheduleCalculationPortsCompatibleV4 {
  resolveNutrition(raw: unknown): z.infer<typeof timingCompatibleV3>;
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
  return {
    expandRoutine: (context) => legacy.expandRoutine(context),
    resolveNutrition(raw) {
      bounded(raw);
      const { item, record, sourcePlan, event, proposedFromEvent } =
        nutritionInputCompatibleV4.parse(raw);
      if (
        item.planVersionId !== record.versionId ||
        !record.items.some((saved) => saved.id === item.id)
      )
        throw new Error('INVALID_CALCULATION_INPUT');
      if (!('schemaVersion' in record))
        return legacy.resolveNutrition({
          sourcePlan,
          event,
          item: nutritionPlanItemCoreSchema.parse(item),
          record,
        });
      if (item.anchor.kind === 'disconnected')
        return { state: 'unresolved', reason: 'missing_anchor' };
      if (item.anchor.kind === 'relative' && item.anchor.entity === 'race') {
        const saved = record.items.find((saved) => saved.id === item.id);
        if (!saved || JSON.stringify(saved) !== JSON.stringify(item))
          return { state: 'unresolved', reason: 'unsupported_anchor_mapping' };
        if (proposedFromEvent) {
          const binding = record.itemRaceTimingBindings.find(
            (entry) => entry.itemId === item.id,
          )?.binding;
          if (!binding || binding.state !== 'captured')
            return { state: 'unresolved', reason: 'unsupported_anchor_mapping' };
          const pin = record.raceTimingPins.find(
            (entry) =>
              entry.eventId === binding.eventId && entry.eventRevision === binding.eventRevision,
          );
          // Current facts can be newer than the immutable pin; an older or foreign
          // event cannot stand in for its source. Only the proposed date changes.
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
          const calculationPlan = {
            ...record,
            items: record.items.flatMap((saved) =>
              saved.anchor.kind === 'disconnected' ? [] : [{ ...saved, anchor: saved.anchor }],
            ),
          };
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
        const projector = createFrozenNutritionProjectorCompatibleV4({
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
      // Calculation-only typed view for the old non-race projector. The full
      // V3 record remains in collector/digest/projection inputs; this is not a stored record.
      const calculationPlan = {
        ...record,
        items: record.items.flatMap((saved) =>
          saved.anchor.kind === 'disconnected' ? [] : [{ ...saved, anchor: saved.anchor }],
        ),
      };
      const linked = new Map<string, z.infer<typeof planDraftSchema>>();
      if (sourcePlan && record.linkedTrainingPlanVersionId)
        linked.set(record.linkedTrainingPlanVersionId, sourcePlan);
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
