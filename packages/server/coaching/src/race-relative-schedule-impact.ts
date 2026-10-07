import { z } from 'zod';
import {
  nutritionPlanVersionCompatibleV3Schema,
  type NutritionPlanVersionCompatibleV3,
} from '@workout/contracts/nutrition-race-plan-v3';
import {
  nutritionPlanVersionCompatibleV4Schema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema, type PlanDraft, type PlanSnapshot } from '@workout/contracts/planning';
import {
  nutritionPlanVersionSchema,
  nutritionPlanItemCoreSchema,
  type NutritionPlanVersion,
} from '@workout/contracts/nutrition-core';
import {
  routineScheduleVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  type RoutineScheduleVersion,
} from '@workout/contracts/routines';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import { localDateSchema, localTimeSchema } from '@workout/contracts/primitives';
import { projectRacePlanImpact } from './race-plan-impact.js';

const id = z.string().min(1).max(200);
export const raceScheduleTimingSchema = z.discriminatedUnion('state', [
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
      'missing_race_time',
      'missing_race_end',
      'unsupported_anchor_mapping',
    ]),
  }),
]);
export type RaceScheduleTiming = z.infer<typeof raceScheduleTimingSchema>;
type Timing = RaceScheduleTiming;
export const raceRoutineExpansionSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('expanded'),
    occurrences: z.array(routineOccurrenceSchema).max(100),
  }),
  z.strictObject({
    state: z.literal('unresolved'),
    reason: z.enum([
      'SOURCE_PLAN_REQUIRED',
      'SOURCE_PLAN_TIMEZONE_MISMATCH',
      'PERIOD_NOT_FOUND',
      'SESSION_NOT_FOUND',
      'ANCHOR_OUTSIDE_WINDOW',
      'ANCHOR_OUTSIDE_PERIOD',
      'EXPANSION_LIMIT_EXCEEDED',
      'DUPLICATE_ANCHOR',
      'UNSUPPORTED_MAPPING',
    ]),
  }),
]);
export type RaceRoutineExpansion = z.infer<typeof raceRoutineExpansionSchema>;
const nutritionContext = z.strictObject({
  record: nutritionPlanVersionSchema,
  timings: z
    .array(
      z.strictObject({
        itemId: nutritionPlanItemCoreSchema.shape.id,
        timing: raceScheduleTimingSchema,
      }),
    )
    .max(5000),
});
const nutritionContextCompatibleV3 = nutritionContext.extend({
  record: nutritionPlanVersionCompatibleV3Schema,
  timings: z
    .array(z.strictObject({ itemId: z.string().min(1), timing: raceScheduleTimingSchema }))
    .max(5000),
});
const routineContext = z.strictObject({
  record: routineScheduleVersionSchema,
  sourcePlanVersionId: z.uuid().nullable(),
  blueprint: routineBlueprintVersionSchema,
  occurrences: z.array(routineOccurrenceSchema).max(1000),
  runs: z.array(routineRunSchema).max(1000),
});
// This is an internal projection input, never an HTTP command, signed review or approval DTO.
const inputSchema = z.strictObject({
  event: raceEventSchema,
  newLocalDate: localDateSchema,
  currentPlan: planSnapshotSchema.nullable(),
  sourcePlans: z.array(planSnapshotSchema).max(1000),
  completionReports: z.array(sessionCompletionSchema).max(1000),
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keep_plan') }),
    z.strictObject({
      kind: z.literal('move_period'),
      expectedCurrentPlanVersionId: z.uuid(),
      periodId: id,
      newStartDate: localDateSchema,
      scope: z.enum(['period_only', 'descendants_and_sessions']),
    }),
  ]),
  nutrition: z.array(nutritionContext).max(1000),
  routines: z.array(routineContext).max(1000),
  resolutions: z.strictObject({
    nutrition: z
      .array(
        z.strictObject({
          planVersionId: z.uuid(),
          itemId: nutritionPlanItemCoreSchema.shape.id,
          action: z.literal('replace_anchor'),
          anchor: nutritionPlanItemCoreSchema.shape.anchor,
        }),
      )
      .max(5000),
    routines: z
      .array(
        z.strictObject({
          scheduleVersionId: id,
          action: z.literal('replace_rule'),
          rule: routineScheduleVersionSchema.shape.rule,
          window: routineScheduleVersionSchema.shape.window,
          sourcePlanVersionId: z.uuid().nullable(),
        }),
      )
      .max(1000),
  }),
});
const inputSchemaCompatibleV3 = inputSchema.extend({
  nutrition: z.array(nutritionContextCompatibleV3).max(1000),
});
/** Frozen unplanned origin: it has no schedule/occurrence to project or approve. */
export const raceRetainedUnplannedRunSchema = z
  .strictObject({ blueprint: routineBlueprintVersionSchema, run: routineRunSchema })
  .superRefine((row, ctx) => {
    const steps = new Set(row.blueprint.steps.map((step) => step.id));
    if (
      row.run.origin.kind !== 'unplanned' ||
      row.run.blueprint.id !== row.blueprint.routineId ||
      row.run.blueprint.versionId !== row.blueprint.versionId ||
      row.run.progress.some((progress) => !steps.has(progress.stepId)) ||
      Object.entries(row.run.selectedChoices).some(
        ([groupId, stepId]) =>
          !row.blueprint.choiceGroups.some(
            (group) => group.id === groupId && group.stepIds.includes(stepId),
          ),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Unplanned frozen source mismatch' });
  });
export const raceRelativeScheduleImpactInputCompatibleV4Schema = inputSchema
  .extend({
    nutrition: z
      .array(
        nutritionContextCompatibleV3.extend({ record: nutritionPlanVersionCompatibleV4Schema }),
      )
      .max(1000),
    retainedUnplannedRuns: z.array(raceRetainedUnplannedRunSchema).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.retainedUnplannedRuns === undefined) return;
    const ids = new Set<string>();
    const blueprints = new Map<string, unknown>();
    for (const row of [...value.routines, ...value.retainedUnplannedRuns]) {
      const identity = JSON.stringify([row.blueprint.routineId, row.blueprint.versionId]);
      const previous = blueprints.get(identity);
      if (previous !== undefined && !same(previous, row.blueprint))
        ctx.addIssue({ code: 'custom', message: 'Divergent frozen blueprint body' });
      blueprints.set(identity, row.blueprint);
    }
    let visits = 0;
    for (const row of value.routines)
      for (const run of row.runs) {
        if (run.origin.kind !== 'planned' || ids.has(run.id))
          ctx.addIssue({ code: 'custom', message: 'Scheduled run origin/roster mismatch' });
        ids.add(run.id);
      }
    for (const row of value.retainedUnplannedRuns) {
      if (ids.has(row.run.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate retained run' });
      ids.add(row.run.id);
      visits += 1 + row.blueprint.steps.length + row.run.progress.length;
      for (const progress of row.run.progress) visits += progress.actualRefs.length;
    }
    if (visits > 5000) ctx.addIssue({ code: 'custom', message: 'Retained run visit bound' });
  });
export type RaceRelativeScheduleImpactInputCompatibleV4 = z.infer<
  typeof raceRelativeScheduleImpactInputCompatibleV4Schema
>;
export interface RaceScheduleCalculationPortsCompatibleV4 {
  resolveNutrition(context: {
    item: NutritionPlanVersionCompatibleV4['items'][number];
    record: NutritionPlanVersionCompatibleV4;
    sourcePlan: PlanDraft | null;
    event: z.infer<typeof raceEventSchema>;
    proposedFromEvent?: z.infer<typeof raceEventSchema>;
  }): unknown;
  expandRoutine: RaceScheduleCalculationPorts['expandRoutine'];
}
export type RaceRelativeScheduleImpactInputCompatibleV3 = z.infer<typeof inputSchemaCompatibleV3>;
export interface RaceScheduleCalculationPortsCompatibleV3 {
  resolveNutrition(context: {
    item: NutritionPlanVersionCompatibleV3['items'][number];
    record: NutritionPlanVersionCompatibleV3;
    sourcePlan: PlanDraft | null;
    event: z.infer<typeof raceEventSchema>;
    /** Explicit hypothetical facts; never a replacement saved pin. */
    proposedFromEvent?: z.infer<typeof raceEventSchema>;
  }): unknown;
  expandRoutine: RaceScheduleCalculationPorts['expandRoutine'];
}
export type RaceRelativeScheduleImpactInput = z.infer<typeof inputSchema>;
export interface RaceScheduleCalculationPorts {
  /** Runtime adapter uses the existing resolver. Unknown race end stays null; this function never infers duration. */
  resolveNutrition(context: {
    item: z.infer<typeof nutritionPlanItemCoreSchema>;
    record: NutritionPlanVersion;
    sourcePlan: PlanDraft | null;
    event: z.infer<typeof raceEventSchema>;
  }): unknown;
  /** Runtime adapter uses existing bounded expansion, including civil dates and DST ambiguity handling. */
  expandRoutine(context: {
    schedule: RoutineScheduleVersion;
    sourcePlan: PlanDraft | null;
  }): unknown;
}
const approval = {
  status: 'blocked' as const,
  reasons: [
    'full_owned_review_missing',
    'complete_dependency_freshness_missing',
    'atomic_multi_domain_approval_missing',
  ] as const,
};
const key = (a: string, b: string) => JSON.stringify([a, b]);
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
// Decoded snapshots are immutable at the calculation port boundary. A faulty
// adapter cannot rewrite retained facts while calculating another schedule.
function freezeSnapshot(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeSnapshot(child);
  Object.freeze(value);
}
class ProjectionFailure extends Error {
  constructor(
    readonly reason:
      | 'invalid_input'
      | 'invalid_port_result'
      | 'projection_bound'
      | 'unsupported_resolution'
      | 'source_identity_mismatch',
  ) {
    super(reason);
  }
}
function reject(reason: ProjectionFailure['reason']) {
  return { status: 'rejected' as const, reason, approval };
}
function bytes(value: unknown) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return Buffer.byteLength(encoded, 'utf8');
  } catch {
    throw new ProjectionFailure('invalid_input');
  }
}
function unique<T>(values: readonly T[], identity: (value: T) => string) {
  if (new Set(values.map(identity)).size !== values.length)
    throw new ProjectionFailure('source_identity_mismatch');
}
function decoded<T>(schema: z.ZodType<T>, value: unknown, budget: { bytes: number }) {
  budget.bytes += bytes(value);
  if (budget.bytes > 4194304) throw new ProjectionFailure('projection_bound');
  const result = schema.safeParse(value);
  if (!result.success) throw new ProjectionFailure('invalid_port_result');
  return result.data;
}
/** Pure candidate preparation only. Neither resolver success nor explicit resolution
 * writes schedules, runs, actuals, versions, receipts, outbox or approval history. */
function projectRaceRelativeScheduleImpactInternal(
  raw: unknown,
  ports: RaceScheduleCalculationPortsCompatibleV4,
) {
  try {
    const budget = { bytes: bytes(raw) };
    if (budget.bytes > 4194304) return reject('projection_bound');
    const parsed = raceRelativeScheduleImpactInputCompatibleV4Schema.safeParse(raw);
    if (!parsed.success) return reject('invalid_input');
    const input = parsed.data;
    freezeSnapshot(input);
    const calendar = projectRacePlanImpact({
      event: { localDate: input.event.localDate, planVersionId: input.event.planVersionId },
      newLocalDate: input.newLocalDate,
      currentPlan: input.currentPlan,
      completionReports: input.completionReports,
      selection: input.selection,
    });
    if (calendar.status === 'rejected')
      return { status: 'rejected' as const, reason: calendar.reason, approval };
    freezeSnapshot(calendar);
    unique(input.sourcePlans, (plan) => plan.id);
    unique(input.nutrition, (context) => context.record.versionId);
    unique(input.routines, (context) => context.record.versionId);
    unique(input.resolutions.nutrition, (resolution) =>
      key(resolution.planVersionId, resolution.itemId),
    );
    unique(input.resolutions.routines, (resolution) => resolution.scheduleVersionId);
    const plans = new Map<string, PlanSnapshot>(input.sourcePlans.map((plan) => [plan.id, plan]));
    if (input.currentPlan) {
      const duplicate = plans.get(input.currentPlan.id);
      if (duplicate && !same(duplicate, input.currentPlan))
        return reject('source_identity_mismatch');
      plans.set(input.currentPlan.id, input.currentPlan);
    }
    const changedSessions = new Set(calendar.sessionDiffs.map((diff) => diff.id)),
      changedPeriods = new Set(calendar.periodDiffs.map((diff) => diff.id));
    const nutritionResolutions = new Map(
      input.resolutions.nutrition.map((resolution) => [
        key(resolution.planVersionId, resolution.itemId),
        resolution,
      ]),
    );
    const routineResolutions = new Map(
      input.resolutions.routines.map((resolution) => [resolution.scheduleVersionId, resolution]),
    );
    const consumedNutrition = new Set<string>(),
      consumedRoutine = new Set<string>();
    let refs =
      input.sourcePlans.length +
      input.completionReports.length +
      input.resolutions.nutrition.length +
      input.resolutions.routines.length;
    const bound = (count: number) => {
      refs += count;
      if (refs > 5000) throw new ProjectionFailure('projection_bound');
    };
    // Include nested identities, not just top-level schedule rows. This finite
    // envelope is independent of the calculation adapter's recurrence policy.
    bound(
      [...plans.values()].reduce(
        (count, plan) => count + plan.draft.periods.length + plan.draft.sessions.length,
        0,
      ),
    );
    bound(
      input.nutrition.reduce(
        (count, context) =>
          count +
          context.record.items.reduce(
            (total, item) =>
              total + item.foods.length + item.targets.length + item.evidenceIds.length,
            0,
          ),
        0,
      ),
    );
    bound(
      input.routines.reduce(
        (count, context) =>
          count +
          context.runs.reduce(
            (total, run) =>
              total +
              run.progress.reduce((size, progress) => size + 1 + progress.actualRefs.length, 0),
            0,
          ) +
          context.occurrences.reduce(
            (total, occurrence) => total + occurrence.stepBindings.length,
            0,
          ),
        0,
      ),
    );
    const sourcePlan = (versionId: string | null, after: boolean): PlanDraft | null =>
      versionId === null
        ? null
        : after && versionId === input.currentPlan?.id
          ? calendar.plan
          : (plans.get(versionId)?.draft ?? null);
    const nutrition = [];
    for (const context of [...input.nutrition].sort((a, b) =>
      a.record.versionId.localeCompare(b.record.versionId),
    )) {
      const { record } = context;
      bound(record.items.length);
      unique(context.timings, (entry) => entry.itemId);
      if (
        context.timings.length !== record.items.length ||
        context.timings.some((entry) => !record.items.some((item) => item.id === entry.itemId))
      )
        return reject('source_identity_mismatch');
      const timings = new Map(context.timings.map((entry) => [entry.itemId, entry.timing]));
      const items = [];
      for (const item of [...record.items].sort((a, b) => a.id.localeCompare(b.id))) {
        const before = timings.get(item.id);
        if (!before) return reject('source_identity_mismatch');
        const affected =
          item.anchor.kind === 'relative' &&
          (item.anchor.entity === 'race'
            ? item.anchor.entityId === input.event.id &&
              input.event.localDate !== input.newLocalDate
            : record.linkedTrainingPlanVersionId === input.currentPlan?.id &&
              changedSessions.has(item.anchor.entityId));
        const resolutionKey = key(record.versionId, item.id),
          resolution = nutritionResolutions.get(resolutionKey);
        if (!affected) {
          if (resolution) return reject('unsupported_resolution');
          items.push({
            itemId: item.id,
            state: 'unchanged' as const,
            item,
            before,
            after: before,
            notice:
              before.state === 'unresolved' ? ('existing_unresolved_preserved' as const) : null,
            resolution: { state: 'absent' as const },
          });
          continue;
        }
        const proposed = resolution
          ? nutritionPlanItemCoreSchema.parse({ ...item, anchor: resolution.anchor })
          : item;
        if (resolution) consumedNutrition.add(resolutionKey);
        if (resolution && proposed.anchor.kind === 'relative') {
          const anchor = proposed.anchor;
          if (
            anchor.entity === 'race'
              ? anchor.entityId !== input.event.id
              : !sourcePlan(record.linkedTrainingPlanVersionId, true)?.sessions.some(
                  (session) => session.id === anchor.entityId,
                )
          )
            return reject('unsupported_resolution');
        }
        const after: Timing =
          proposed.anchor.kind === 'relative' &&
          proposed.anchor.entity === 'race' &&
          proposed.anchor.entityId === input.event.id &&
          proposed.anchor.point === 'end'
            ? { state: 'unresolved', reason: 'missing_race_end' }
            : proposed.anchor.kind === 'relative' &&
                proposed.anchor.entity === 'race' &&
                proposed.anchor.entityId === input.event.id &&
                input.event.localStartTime === null
              ? { state: 'unresolved', reason: 'missing_race_time' }
              : decoded(
                  raceScheduleTimingSchema,
                  ports.resolveNutrition({
                    item: proposed,
                    record,
                    sourcePlan: sourcePlan(record.linkedTrainingPlanVersionId, true),
                    event: { ...input.event, localDate: input.newLocalDate },
                    ...('schemaVersion' in record &&
                    proposed.anchor.kind === 'relative' &&
                    proposed.anchor.entity === 'race'
                      ? { proposedFromEvent: input.event }
                      : {}),
                  }),
                  budget,
                );
        items.push({
          itemId: item.id,
          state: 'affected' as const,
          item: proposed,
          before,
          after,
          notice:
            after.state === 'unresolved' || (before.state === 'unresolved' && !resolution)
              ? ('affected_unresolved_requires_resolution' as const)
              : null,
          resolution: resolution
            ? { state: 'explicit' as const, action: resolution.action, outcome: after.state }
            : { state: 'absent' as const },
        });
      }
      nutrition.push({ planVersionId: record.versionId, record, items });
    }
    const routines = [];
    for (const context of [...input.routines].sort((a, b) =>
      a.record.versionId.localeCompare(b.record.versionId),
    )) {
      const { record, blueprint } = context;
      bound(context.occurrences.length + context.runs.length + context.blueprint.steps.length);
      unique(context.occurrences, (item) => item.id);
      unique(context.occurrences, (item) => item.anchorKey);
      unique(context.runs, (run) => run.id);
      if (
        record.blueprint.id !== blueprint.routineId ||
        record.blueprint.versionId !== blueprint.versionId ||
        context.occurrences.some(
          (occurrence) =>
            occurrence.schedule.id !== record.id ||
            occurrence.schedule.versionId !== record.versionId ||
            occurrence.blueprint.id !== blueprint.routineId ||
            occurrence.blueprint.versionId !== blueprint.versionId,
        ) ||
        context.runs.some(
          (run) =>
            run.blueprint.id !== blueprint.routineId ||
            run.blueprint.versionId !== blueprint.versionId ||
            (run.origin.kind === 'planned' &&
              !context.occurrences.some((occurrence) => {
                const origin = run.origin;
                return origin.kind === 'planned' && occurrence.id === origin.occurrenceId;
              })),
        )
      )
        return reject('source_identity_mismatch');
      const affected =
        context.sourcePlanVersionId === input.currentPlan?.id &&
        (record.rule.kind === 'period_days'
          ? changedPeriods.has(record.rule.periodId)
          : record.rule.kind === 'session_links' &&
            record.rule.sessionIds.some((id) => changedSessions.has(id)));
      const resolution = routineResolutions.get(record.versionId);
      if (!affected) {
        if (resolution) return reject('unsupported_resolution');
        routines.push({
          scheduleVersionId: record.versionId,
          state: 'unchanged' as const,
          record,
          blueprint,
          occurrences: context.occurrences,
          runs: context.runs,
          notice: context.occurrences.some((occurrence) => occurrence.timingStatus === 'unresolved')
            ? ('existing_unresolved_preserved' as const)
            : null,
          projection: null,
        });
        continue;
      }
      if (record.state === 'ended') {
        if (resolution) return reject('unsupported_resolution');
        routines.push({
          scheduleVersionId: record.versionId,
          state: 'retained_ended' as const,
          record,
          blueprint,
          occurrences: context.occurrences,
          runs: context.runs,
          notice: context.occurrences.some((occurrence) => occurrence.timingStatus === 'unresolved')
            ? ('affected_unresolved_requires_resolution' as const)
            : ('ended_schedule_preserved' as const),
          projection: null,
        });
        continue;
      }
      const proposed = resolution
        ? routineScheduleVersionSchema.parse({
            ...record,
            rule: resolution.rule,
            window: resolution.window,
          })
        : record;
      if (resolution) consumedRoutine.add(record.versionId);
      if (resolution?.sourcePlanVersionId && !plans.has(resolution.sourcePlanVersionId))
        return reject('unsupported_resolution');
      const windowDays =
        (Date.parse(`${proposed.window.endDateExclusive}T00:00:00Z`) -
          Date.parse(`${proposed.window.startDate}T00:00:00Z`)) /
        86400000;
      const expansion =
        proposed.window.maxOccurrences > 100 || windowDays > 366
          ? { state: 'unresolved' as const, reason: 'EXPANSION_LIMIT_EXCEEDED' as const }
          : decoded(
              raceRoutineExpansionSchema,
              ports.expandRoutine({
                schedule: proposed,
                sourcePlan: sourcePlan(
                  resolution ? resolution.sourcePlanVersionId : context.sourcePlanVersionId,
                  true,
                ),
              }),
              budget,
            );
      if (expansion.state === 'expanded') {
        if (expansion.occurrences.length > proposed.window.maxOccurrences)
          return reject('invalid_port_result');
        bound(expansion.occurrences.length);
        unique(expansion.occurrences, (occurrence) => occurrence.id);
        unique(expansion.occurrences, (occurrence) => occurrence.anchorKey);
        if (
          expansion.occurrences.some(
            (occurrence) =>
              occurrence.schedule.id !== record.id ||
              occurrence.schedule.versionId !== record.versionId ||
              occurrence.blueprint.id !== blueprint.routineId ||
              occurrence.blueprint.versionId !== blueprint.versionId,
          )
        )
          return reject('invalid_port_result');
      }
      const retainedIds = new Set(
        context.runs.flatMap((run) =>
          run.origin.kind === 'planned' ? [run.origin.occurrenceId] : [],
        ),
      );
      const retained = context.occurrences.filter((occurrence) => retainedIds.has(occurrence.id));
      const retainedKeys = new Set(retained.map((occurrence) => occurrence.anchorKey));
      const planned =
        expansion.state === 'expanded'
          ? expansion.occurrences.filter(
              (occurrence) =>
                !retainedIds.has(occurrence.id) && !retainedKeys.has(occurrence.anchorKey),
            )
          : [];
      const unresolved =
        expansion.state === 'unresolved' ||
        planned.some((occurrence) => occurrence.timingStatus === 'unresolved') ||
        retained.some((occurrence) => occurrence.timingStatus === 'unresolved') ||
        (!resolution &&
          context.occurrences.some((occurrence) => occurrence.timingStatus === 'unresolved'));
      routines.push({
        scheduleVersionId: record.versionId,
        state: 'affected' as const,
        record,
        blueprint,
        occurrences: context.occurrences,
        runs: context.runs,
        notice: unresolved ? ('affected_unresolved_requires_resolution' as const) : null,
        projection: {
          proposed,
          expansion,
          plannedOccurrences: planned,
          retainedOccurrences: retained,
          resolution: resolution
            ? { state: 'explicit' as const, action: resolution.action }
            : { state: 'absent' as const },
        },
      });
    }
    if (
      consumedNutrition.size !== nutritionResolutions.size ||
      consumedRoutine.size !== routineResolutions.size
    )
      return reject('unsupported_resolution');
    return {
      status: 'projected' as const,
      approval,
      calendar,
      nutrition,
      routines,
      requiresResolution:
        nutrition.some((context) =>
          context.items.some((item) => item.notice === 'affected_unresolved_requires_resolution'),
        ) ||
        routines.some((context) => context.notice === 'affected_unresolved_requires_resolution'),
      completionReports: input.completionReports,
      ...(input.retainedUnplannedRuns === undefined
        ? {}
        : {
            retainedUnplannedRuns: [...input.retainedUnplannedRuns]
              .sort((a, b) => (a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0))
              .map((row) => ({ state: 'retained_unplanned' as const, ...row })),
          }),
    };
  } catch (error) {
    if (error instanceof ProjectionFailure) return reject(error.reason);
    return reject('invalid_port_result');
  }
}

/** Explicit internal compatible read only; this is not a stored approval or HTTP DTO. */
export function projectRaceRelativeScheduleImpactCompatibleV3(
  raw: unknown,
  ports: RaceScheduleCalculationPortsCompatibleV3,
) {
  try {
    if (bytes(raw) > 4194304) return reject('projection_bound');
    const parsed = inputSchemaCompatibleV3.safeParse(raw);
    if (!parsed.success) return reject('invalid_input');
    return projectRaceRelativeScheduleImpactInternal(parsed.data, {
      expandRoutine: (context) => ports.expandRoutine(context),
      resolveNutrition: (context) =>
        ports.resolveNutrition({
          ...context,
          record: nutritionPlanVersionCompatibleV3Schema.parse(context.record),
        }),
    });
  } catch {
    return reject('invalid_port_result');
  }
}
/** Explicit multipin-compatible internal projection; never approval authority. */
export function projectRaceRelativeScheduleImpactCompatibleV4(
  raw: unknown,
  ports: RaceScheduleCalculationPortsCompatibleV4,
) {
  return projectRaceRelativeScheduleImpactInternal(raw, ports);
}
/** Existing V1 seam keeps its strict decoder and legacy calculation semantics. */
export function projectRaceRelativeScheduleImpact(
  raw: unknown,
  ports: RaceScheduleCalculationPorts,
) {
  try {
    if (bytes(raw) > 4194304) return reject('projection_bound');
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return reject('invalid_input');
    return projectRaceRelativeScheduleImpactInternal(parsed.data, {
      expandRoutine: (context) => ports.expandRoutine(context),
      resolveNutrition: (context) => {
        const legacy = {
          ...context,
          item: nutritionPlanItemCoreSchema.parse(context.item),
          record: nutritionPlanVersionSchema.parse(context.record),
        };
        freezeSnapshot(legacy);
        return ports.resolveNutrition(legacy);
      },
    });
  } catch (error) {
    if (error instanceof ProjectionFailure) return reject(error.reason);
    return reject('invalid_port_result');
  }
}
