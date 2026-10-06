import { z } from 'zod';
import type { RaceScheduleCalculationPorts } from '@workout/server-coaching/race-relative-schedule-impact';
import {
  nutritionPlanItemCoreSchema,
  nutritionPlanVersionSchema,
} from '@workout/contracts/nutrition-core';
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
export function createRaceRelativeScheduleCalculationPorts(): RaceRelativeScheduleCalculationPorts {
  return {
    resolveNutrition(raw: unknown) {
      bounded(raw);
      const { item, record, sourcePlan } = nutritionInput.parse(raw);
      if (item.planVersionId !== record.versionId) throw new Error('INVALID_CALCULATION_INPUT');
      const linked = new Map<string, z.infer<typeof planDraftSchema>>();
      if (sourcePlan && record.linkedTrainingPlanVersionId !== null)
        linked.set(record.linkedTrainingPlanVersionId, sourcePlan);
      // Existing resolver deliberately leaves race anchors unresolved. The
      // event is validated, but never translated into a synthetic Plan session.
      const result = projectNutritionItem(item, record, linked, record.timezone);
      return timing.parse(
        'value' in result
          ? { state: 'resolved', date: result.date, localTime: result.value.localTime }
          : { state: 'unresolved', reason: result.reason },
      );
    },
    expandRoutine(raw: unknown) {
      bounded(raw);
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
