import { raceRelativeScheduleImpactResultCompatibleV4BodySchema } from '@workout/server-coaching/race-relative-schedule-impact-codecs';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import { localDateSchema } from '@workout/contracts/primitives';
import { nutritionPlanItemCoreSchema } from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import {
  projectRacePlanImpact,
  type RacePlanImpactReason,
} from '@workout/server-coaching/race-plan-impact';
import {
  projectRaceRelativeScheduleImpactCompatibleV4,
  type RaceRelativeScheduleImpactInputCompatibleV4,
} from '@workout/server-coaching/race-relative-schedule-impact';
import type { RacePlanImpactContext } from './race-plan-impact-context.js';
import { createRaceRelativeScheduleCalculationPortsCompatibleV4 } from './race-relative-schedule-calculation.js';

/** Internal collector DTO only. This projection seam authenticates no browser capture. */
export type RaceProjectionCapture = Pick<
  RacePlanImpactContext,
  | 'athleteId'
  | 'event'
  | 'currentTraining'
  | 'linkedPlan'
  | 'completions'
  | 'nutrition'
  | 'coverage'
  | 'readSetDigest'
> & {
  // Older internal unit captures may omit these; omission never grants readiness.
  consumedSources?: RacePlanImpactContext['consumedSources'];
  routineActualManifest: Pick<
    RacePlanImpactContext['routineActualManifest'],
    'schedules' | 'blueprints' | 'occurrences' | 'runs'
  >;
};
const id = z.string().min(1).max(200);
export const raceProjectionIntentSchema = z.strictObject({
  expectedEvent: z.strictObject({
    id: z.uuid(),
    revision: z.number().int().min(1).max(2147483647),
  }),
  newLocalDate: localDateSchema,
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
  resolutions: z
    .strictObject({
      nutrition: z
        .array(
          z.strictObject({
            planVersionId: z.uuid(),
            itemId: id,
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
    })
    .default({ nutrition: [], routines: [] }),
});
const collectorIds = z
  .array(id)
  .max(1000)
  .refine((values) => new Set(values).size === values.length);
export const racePlanImpactCollectorSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keep_plan') }),
  z.strictObject({
    kind: z.literal('move_period'),
    expectedCurrentPlanVersionId: z.uuid().transform((value) => value.toLowerCase()),
    changedSessionIds: collectorIds,
    movedPeriodIds: collectorIds.max(100),
  }),
]);
export type RaceProjectionIntent = z.infer<typeof raceProjectionIntentSchema>;
export type RaceProjectionMissingFact = {
  kind:
    | 'source_plan_body'
    | 'race_anchor_body'
    | 'frozen_blueprint'
    | 'routine_run_schedule'
    | 'immutable_race_pin'
    | 'actual_reference_unavailable';
  id: string;
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const approval = { approvalAllowed: false as const, coverageComplete: false as const };
export type RaceProjectionBlockReason =
  | RacePlanImpactReason
  | Extract<
      ReturnType<typeof projectRaceRelativeScheduleImpactCompatibleV4>,
      { status: 'rejected' }
    >['reason']
  | 'event_revision_conflict'
  | 'unsupported_coverage'
  | 'linked_plan_identity_mismatch'
  | 'source_identity_mismatch'
  | 'missing_facts'
  | 'invalid_input_or_capture';
function blocked(
  reason: RaceProjectionBlockReason,
  missingFacts: RaceProjectionMissingFact[] = [],
) {
  return { status: 'blocked' as const, reason, missingFacts, ...approval };
}
function unique<T>(values: T[], key: (value: T) => string) {
  if (new Set(values.map(key)).size !== values.length) throw new Error('duplicate_capture');
}

/** Finite collector membership derived from the actual calendar projector. */
export function deriveRacePlanImpactCollectorSelection(
  calendar: Extract<ReturnType<typeof projectRacePlanImpact>, { status: 'projected' }>,
  selection: RaceProjectionIntent['selection'],
) {
  return selection.kind === 'keep_plan'
    ? { kind: 'keep_plan' as const }
    : {
        kind: 'move_period' as const,
        expectedCurrentPlanVersionId: selection.expectedCurrentPlanVersionId,
        changedSessionIds: calendar.sessionDiffs
          .filter((diff) => diff.beforeDate !== diff.afterDate)
          .map((diff) => diff.id)
          .sort(compare),
        movedPeriodIds: calendar.periodDiffs
          .filter(
            (diff) =>
              diff.before.startDate !== diff.after.startDate ||
              diff.before.endDateExclusive !== diff.after.endDateExclusive,
          )
          .map((diff) => diff.id)
          .sort(compare),
      };
}

/** Builds only from server-captured facts. No reads, receipts, writes, fresh permission
 * checks or approval occur here. Missing historical bodies are never replaced by heads. */
export function buildRacePlanImpactProjectionInput(
  capture: RaceProjectionCapture,
  rawIntent: unknown,
) {
  try {
    const encoded = JSON.stringify({ capture, intent: rawIntent });
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 4194304)
      return blocked('projection_bound');
    const intent = raceProjectionIntentSchema.parse(rawIntent);
    const references =
      capture.nutrition.reduce((count, row) => count + row.record.items.length, 0) +
      capture.completions.length +
      capture.routineActualManifest.occurrences.length +
      capture.routineActualManifest.schedules.length +
      capture.routineActualManifest.blueprints.reduce(
        (count, row) => count + row.record.steps.length,
        0,
      ) +
      capture.routineActualManifest.runs.reduce(
        (count, row) =>
          count + row.record.progress.reduce((total, step) => total + step.actualRefs.length, 1),
        0,
      ) +
      intent.resolutions.nutrition.length +
      intent.resolutions.routines.length +
      (capture.consumedSources?.plans.length ?? 0) +
      (capture.consumedSources?.races.length ?? 0);
    if (references > 5000) return blocked('projection_bound');
    const event = raceEventSchema.parse(capture.event);
    if (event.id !== intent.expectedEvent.id || event.revision !== intent.expectedEvent.revision)
      return blocked('event_revision_conflict');
    const athleteId = id.parse(capture.athleteId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(capture.readSetDigest);
    if (capture.coverage.complete !== false) return blocked('unsupported_coverage');
    const currentPlan =
      capture.currentTraining === null
        ? null
        : planSnapshotSchema.parse(capture.currentTraining.snapshot);
    const linked =
      capture.linkedPlan === null ? null : planSnapshotSchema.parse(capture.linkedPlan);
    if (event.planVersionId !== (linked?.id ?? null))
      return blocked('linked_plan_identity_mismatch');
    const consumed = z
      .strictObject({
        plans: z.array(planSnapshotSchema).max(5000),
        races: z.array(raceEventSchema).max(5000),
      })
      .parse(capture.consumedSources ?? { plans: [], races: [] });
    const races = new Map<string, z.infer<typeof raceEventSchema>>();
    for (const race of [event, ...consumed.races]) {
      const previous = races.get(race.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(race))
        return blocked('source_identity_mismatch');
      races.set(race.id, race);
    }
    const plans = new Map<string, z.infer<typeof planSnapshotSchema>>();
    for (const plan of [currentPlan, linked, ...consumed.plans]) {
      if (!plan) continue;
      const previous = plans.get(plan.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(plan))
        return blocked('source_identity_mismatch');
      plans.set(plan.id, plan);
    }
    const completions = z.array(sessionCompletionSchema).max(1000).parse(capture.completions);
    const calendar = projectRacePlanImpact({
      event: { localDate: event.localDate, planVersionId: event.planVersionId },
      newLocalDate: intent.newLocalDate,
      currentPlan,
      completionReports: completions,
      selection: intent.selection,
    });
    if (calendar.status === 'rejected') return blocked(calendar.reason);
    const collectorSelection = deriveRacePlanImpactCollectorSelection(calendar, intent.selection);
    const missingFacts: RaceProjectionMissingFact[] = [];
    const fatal: RaceProjectionMissingFact[] = [];
    function sourcePlan(versionId: string | null) {
      if (versionId === null) return null;
      const found = plans.get(versionId);
      if (!found) fatal.push({ kind: 'source_plan_body', id: versionId });
      return found?.draft ?? null;
    }
    const records = capture.nutrition.map((row) => {
      const record = nutritionPlanVersionCompatibleV4Schema.parse(row.record);
      if (record.planId !== row.aggregateId || record.versionId !== row.versionId)
        throw new Error('source_identity_mismatch');
      for (const item of record.items)
        if (item.anchor.kind === 'relative' && item.anchor.entity === 'race') {
          const binding =
            'schemaVersion' in record
              ? record.itemRaceTimingBindings.find((entry) => entry.itemId === item.id)?.binding
              : undefined;
          if (!binding || binding.state === 'legacy_unpinned')
            missingFacts.push({
              kind: 'immutable_race_pin',
              id: JSON.stringify([record.versionId, item.id]),
            });
          if (!races.has(item.anchor.entityId))
            fatal.push({ kind: 'race_anchor_body', id: item.anchor.entityId });
        }
      return { record, sourcePlan: sourcePlan(record.linkedTrainingPlanVersionId) };
    });
    unique(records, (row) => row.record.versionId);
    records.sort((a, b) => compare(a.record.versionId, b.record.versionId));
    const manifest = capture.routineActualManifest;
    for (const run of manifest.runs)
      for (const actual of run.actuals)
        if (actual.fact.state === 'unavailable')
          missingFacts.push({
            kind: 'actual_reference_unavailable',
            id: JSON.stringify(actual.fact.requested),
          });
    const schedules = manifest.schedules.map((row) => {
      const record = routineScheduleVersionSchema.parse(row.record);
      if (record.id !== row.scheduleId || record.versionId !== row.versionId)
        throw new Error('source_identity_mismatch');
      return { record, sourcePlanVersionId: row.sourcePlanVersionId };
    });
    unique(schedules, (row) => row.record.versionId);
    const blueprints = manifest.blueprints.map((row) =>
      routineBlueprintVersionSchema.parse(row.record),
    );
    unique(blueprints, (row) => row.versionId);
    const occurrences = manifest.occurrences.map((row) =>
      routineOccurrenceSchema.parse(row.record),
    );
    const runs = manifest.runs.map((row) => routineRunSchema.parse(row.record));
    unique(occurrences, (row) => row.id);
    unique(runs, (row) => row.id);
    const routines: RaceRelativeScheduleImpactInputCompatibleV4['routines'] = [];
    for (const row of schedules) {
      sourcePlan(row.sourcePlanVersionId);
      const blueprint = blueprints.find(
        (candidate) =>
          candidate.versionId === row.record.blueprint.versionId &&
          candidate.routineId === row.record.blueprint.id,
      );
      if (!blueprint) {
        fatal.push({ kind: 'frozen_blueprint', id: row.record.blueprint.versionId });
        continue;
      }
      const ownedOccurrences = occurrences.filter(
        (value) => value.schedule.versionId === row.record.versionId,
      );
      const ownedRuns = runs.filter((run) =>
        run.origin.kind === 'planned'
          ? ownedOccurrences.some(
              (value) => run.origin.kind === 'planned' && value.id === run.origin.occurrenceId,
            )
          : run.blueprint.versionId === blueprint.versionId,
      );
      if (
        ownedRuns.some((run) => run.origin.kind !== 'planned') &&
        schedules.filter((value) => value.record.blueprint.versionId === blueprint.versionId)
          .length > 1
      )
        fatal.push({ kind: 'routine_run_schedule', id: blueprint.versionId });
      routines.push({ ...row, blueprint, occurrences: ownedOccurrences, runs: ownedRuns });
    }
    for (const occurrence of occurrences)
      if (!schedules.some((row) => row.record.versionId === occurrence.schedule.versionId))
        fatal.push({ kind: 'routine_run_schedule', id: occurrence.schedule.versionId });
    for (const run of runs)
      if (!routines.some((row) => row.runs.some((value) => value.id === run.id)))
        fatal.push({ kind: 'routine_run_schedule', id: run.id });
    const ordered = (facts: RaceProjectionMissingFact[]) =>
      [...new Map(facts.map((fact) => [JSON.stringify(fact), fact])).values()].sort((a, b) =>
        compare(JSON.stringify(a), JSON.stringify(b)),
      );
    if (fatal.length)
      return {
        ...blocked('missing_facts', ordered([...fatal, ...missingFacts])),
        calendar,
        collectorSelection,
      };
    const ports = createRaceRelativeScheduleCalculationPortsCompatibleV4(
      [...races.values()].sort((a, b) => compare(a.id, b.id)),
    );
    const input: RaceRelativeScheduleImpactInputCompatibleV4 = {
      event,
      newLocalDate: intent.newLocalDate,
      currentPlan,
      sourcePlans: [...plans.values()].sort((a, b) => compare(a.id, b.id)),
      completionReports: completions,
      selection: intent.selection,
      nutrition: records.map((row) => ({
        record: row.record,
        timings: row.record.items.map((item) => ({
          itemId: item.id,
          timing: ports.resolveNutrition({
            item,
            record: row.record,
            sourcePlan: row.sourcePlan,
            event,
          }),
        })),
      })),
      routines,
      resolutions: intent.resolutions,
    };
    const projection = projectRaceRelativeScheduleImpactCompatibleV4(input, ports);
    if (projection.status === 'rejected') return blocked(projection.reason, ordered(missingFacts));
    if (!raceRelativeScheduleImpactResultCompatibleV4BodySchema.safeParse(projection).success)
      return blocked('invalid_result', ordered(missingFacts));
    return {
      status: 'projected' as const,
      input,
      projection,
      collectorSelection,
      missingFacts: ordered(missingFacts),
      sourceFacts: {
        ownerAthleteId: athleteId,
        nutritionRacePins: records.flatMap((row) =>
          row.record.items
            .filter((item) => item.anchor.kind === 'relative' && item.anchor.entity === 'race')
            .map((item) => ({
              nutritionVersionId: row.record.versionId,
              itemId: item.id,
              binding:
                'schemaVersion' in row.record
                  ? (row.record.itemRaceTimingBindings.find((entry) => entry.itemId === item.id)
                      ?.binding ?? { state: 'legacy_unpinned' as const })
                  : { state: 'legacy_unpinned' as const },
            })),
        ),
      },
      readSetDigest: capture.readSetDigest,
      coverage: capture.coverage,
      ...approval,
    };
  } catch {
    return blocked('invalid_input_or_capture');
  }
}
