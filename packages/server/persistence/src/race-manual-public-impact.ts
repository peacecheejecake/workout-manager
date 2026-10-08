import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { z } from 'zod';
import {
  raceManualPublicImpactSchema,
  type RaceManualPublicImpact,
} from '@workout/contracts/race-manual-public-impact';
import { raceManualProjectionIntentSchema } from '@workout/contracts/race-manual-public';
import { raceManualPublicRoutineExpansionSchema } from '@workout/contracts/race-manual-public-preview';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import { buildRacePlanImpactProjectionInput } from './race-plan-impact-projection-input.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';
import { expandRoutineSchedule, RoutineExpansionError } from './routine-expansion.js';

const input = z.strictObject({
  context: raceImpactConsumedCaptureSchema,
  intent: raceManualProjectionIntentSchema,
});
export class RaceManualPublicImpactError extends Error {
  constructor(readonly code: 'PUBLIC_IMPACT_INVALID_CONTEXT' | 'PUBLIC_IMPACT_LIMIT') {
    super(code);
  }
}
function invalid(): never {
  throw new RaceManualPublicImpactError('PUBLIC_IMPACT_INVALID_CONTEXT');
}
function same(a: unknown, b: unknown) {
  return impactDependencyDigest(a) === impactDependencyDigest(b);
}
function section<T>(members: T[]) {
  return members.length ? { state: 'present' as const, members } : { state: 'absent' as const };
}
function raceSide(e: z.infer<typeof raceImpactConsumedCaptureSchema>['event']) {
  const {
    title,
    localDate,
    localStartTime,
    timezone,
    distance,
    priority,
    participation,
    targetSeconds,
  } = e;
  return {
    title,
    localDate,
    localStartTime,
    timezone,
    distance,
    priority,
    participation,
    targetSeconds,
  };
}
type Context = z.infer<typeof raceImpactConsumedCaptureSchema>;
function item(i: Context['nutrition'][number]['record']['items'][number]) {
  const { id, category, title, anchor, foods, targets, instructions } = i;
  return {
    id,
    category,
    title,
    anchor,
    foods,
    targets: targets.map((target) => {
      const { min, max, unit, basis } = target.amount;
      return { metric: target.metric, amount: { min, max, unit, basis } };
    }),
    instructions,
  };
}
function plan(r: Context['nutrition'][number]['record']) {
  return { period: r.period, purpose: r.purpose, timezone: r.timezone, items: r.items.map(item) };
}
function recoveryPlan(r: Context['recovery'][number]['record']['draft']) {
  const { title, goal, startDate, endDateExclusive, timezone, priority, options, reassessment } = r;
  return { title, goal, startDate, endDateExclusive, timezone, priority, options, reassessment };
}
function output(raw: unknown): RaceManualPublicImpact {
  const p = raceManualPublicImpactSchema.safeParse(raw);
  if (!p.success) {
    if (
      p.error.issues.some(
        (issue) => issue.code === 'custom' && issue.message === 'Bounded plain impact required',
      )
    )
      throw new RaceManualPublicImpactError('PUBLIC_IMPACT_LIMIT');
    invalid();
  }
  return p.data;
}
/** Strict structural normalization only; this neither captures nor authenticates source rows. */
export function normalizeRaceManualImpactProjectionCapture(raw: unknown) {
  try {
    assertRaceManualPlainV2(raw);
  } catch {
    throw new RaceManualPublicImpactError('PUBLIC_IMPACT_LIMIT');
  }
  const parsed = raceImpactConsumedCaptureSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const c = parsed.data;
  const checkedCoverage = z
    .strictObject({
      complete: z.literal(false),
      missing: z.tuple([
        z.literal('complete_catalog_and_actual_manifest'),
        z.literal('supplementary_reference_manifest'),
        z.literal('routine_occurrences_and_started_runs'),
        z.literal('complete_source_permission_manifest'),
        z.literal('manual_purpose_app_and_policy_binding'),
      ]),
      captured: z.tuple([
        z.literal('integrated_dependency_inventory'),
        z.literal('immutable_supplementary_copy_references'),
        z.literal('routine_occurrence_run_and_actual_reference_facts'),
        z.literal('partial_owned_planned_reference_and_resource_permission_facts'),
        z.literal('nested_nutrition_plan_food_anchor_and_activity_media_provider_facts'),
        z.literal('manual_purpose_app_and_policy_facts'),
      ]),
    })
    .safeParse(c.coverage);
  if (!checkedCoverage.success) invalid();
  return {
    ...c,
    coverage: checkedCoverage.data,
    routineActualManifest: {
      ...c.routineActualManifest,
      blueprints: c.routineActualManifest.blueprints.map((row) => {
        const unsupported = z
          .array(
            z.strictObject({
              stepId: z.string(),
              content: routineBlueprintVersionSchema.shape.steps.element.shape.content,
              state: z.literal('unavailable'),
              reason: z.literal('producer_content_unsupported'),
            }),
          )
          .safeParse(row.unsupportedContent);
        if (!unsupported.success) invalid();
        return { ...row, unsupportedContent: unsupported.data };
      }),
    },
    nutrition: c.nutrition.map((row) => ({
      ...row,
      relativeItems: row.relativeItems.map((ref) => {
        if (ref.entity === 'race') {
          if (
            ref.sourceVersionId !== null ||
            ref.sourceRaceRevision === undefined ||
            ref.sourceRaceDigest === undefined
          )
            invalid();
          return {
            itemId: ref.itemId,
            entity: 'race' as const,
            entityId: ref.entityId,
            sourceVersionId: null,
            affected: ref.affected,
            point: ref.point,
            sourceRaceRevision: ref.sourceRaceRevision,
            sourceRaceDigest: ref.sourceRaceDigest,
            timing: ref.timing,
          };
        }
        if (
          ref.sourceVersionId === null ||
          ref.sourceRaceRevision !== undefined ||
          ref.sourceRaceDigest !== undefined
        )
          invalid();
        return {
          itemId: ref.itemId,
          entity: 'session' as const,
          entityId: ref.entityId,
          sourceVersionId: ref.sourceVersionId,
          affected: ref.affected,
          point: ref.point,
          timing: ref.timing,
        };
      }),
    })),
  };
}

/** Internal pure projection from an owned snapshot capture. The JSON boundary
 * checks correspondence only; the calling service must obtain the capture in
 * its fenced transaction. No supplied projection, candidate or boolean is used. */
export function projectRaceManualPublicImpact(raw: unknown): RaceManualPublicImpact {
  try {
    assertRaceManualPlainV2(raw);
  } catch {
    throw new RaceManualPublicImpactError('PUBLIC_IMPACT_LIMIT');
  }
  const parsed = input.safeParse(raw);
  if (!parsed.success) invalid();
  const { context: c, intent } = parsed.data;
  if (
    !c.calendarIntent ||
    !same(c.calendarIntent, intent) ||
    c.event.id.toLowerCase() !== intent.expectedEvent.id.toLowerCase() ||
    c.event.revision !== intent.expectedEvent.revision ||
    c.manualBasis.app.state !== 'present' ||
    !c.manualBasis.app.granted
  )
    invalid();
  const { status, coverage, readSetDigest, affected, ...readSet } = c;
  void status;
  void coverage;
  void affected;
  if (
    impactDependencyDigest({
      ...readSet,
      coreDependencies: { ...c.coreDependencies, capturedAt: null },
    }) !== readSetDigest
  )
    invalid();
  const observedEvent = c.consumedSources.races.find((r) => r.id === c.event.id);
  if (!observedEvent || !same(observedEvent, c.event)) invalid();
  for (const domain of ['nutrition', 'recovery', 'routine'] as const) {
    const rows = domain === 'routine' ? c.routines : c[domain];
    const expected = c.rosters[domain]
      .map((r) => JSON.stringify([r.aggregateId, r.versionId]))
      .sort();
    const actual = rows.map((r) => JSON.stringify([r.aggregateId, r.versionId])).sort();
    if (new Set(actual).size !== actual.length || !same(expected, actual)) invalid();
  }
  const capture = normalizeRaceManualImpactProjectionCapture(c);
  const built = buildRacePlanImpactProjectionInput(capture, intent);
  const fixed = {
    schemaVersion: 1,
    approvalAllowed: false,
    persistence: 'not_stored',
    freshness: 'not_checked',
  };
  if (built.status !== 'projected')
    return output({
      ...fixed,
      status: 'blocked',
      reason:
        built.reason === 'projection_bound'
          ? 'limit_exceeded'
          : built.reason === 'event_revision_conflict'
            ? 'stale_basis'
            : 'source_unavailable',
      domains: [],
    });
  const p = built.projection;
  const trainingChanged =
    c.currentTraining !== null &&
    p.calendar.plan !== null &&
    !same(c.currentTraining.snapshot.draft, p.calendar.plan);
  const training = c.currentTraining
    ? [
        {
          aggregateId: c.currentTraining.aggregateId,
          before: {
            ref: {
              versionId: c.currentTraining.snapshot.id,
              version: c.currentTraining.snapshot.version,
            },
            plan: c.currentTraining.snapshot.draft,
          },
          after: {
            kind: trainingChanged ? 'new_version_on_approval' : 'retained',
            plan: p.calendar.plan,
          },
        },
      ]
    : [];
  const nutrition = p.nutrition.map((n) => {
    const oldLink = n.record.linkedTrainingPlanVersionId;
    const link =
      oldLink === null
        ? { kind: 'absent' as const }
        : { kind: 'retained' as const, versionId: oldLink };
    const source = c.nutrition.find((r) => r.versionId === n.planVersionId);
    if (!source || source.aggregateId !== n.record.planId || !same(source.record, n.record))
      invalid();
    return {
      aggregateId: n.record.planId,
      before: {
        ref: { versionId: n.record.versionId, version: n.record.version },
        plan: plan(n.record),
        linkedTraining: link,
      },
      after: {
        plan: { ...plan(n.record), items: n.items.map((i) => item(i.item)) },
        linkedTraining:
          trainingChanged && oldLink === c.currentTraining?.snapshot.id
            ? { kind: 'follows_training_approval', aggregateId: c.currentTraining.aggregateId }
            : link,
      },
      timings: n.items.map((i) => {
        const timing = (t: typeof i.before) =>
          i.item.anchor.kind === 'disconnected'
            ? {
                state: 'suspended',
                reason: 'race_disconnected',
                resume: 'explicit_reconnect_and_reapproval_required',
              }
            : t.state === 'resolved'
              ? { ...t, timezone: n.record.timezone }
              : t;
        return {
          itemId: i.itemId,
          state: i.state,
          before: timing(i.before),
          after: timing(i.after),
          resolution: i.resolution.state === 'explicit' ? 'explicit_replacement' : 'absent',
          requirement:
            i.notice === 'affected_unresolved_requires_resolution'
              ? 'resolve_before_review'
              : 'none',
        };
      }),
    };
  });
  const changedNutrition = new Set(
    nutrition
      .filter((n) => n.timings.some((t) => t.state === 'affected'))
      .map((n) => n.aggregateId),
  );
  // Matches approval recipes: only dependency relinking changes recovery; its
  // reported status/selection/food or actual logs are never manufactured.
  const recovery = c.recovery.map((r) => {
    const changed = r.record.draft.planRefs.some((ref) =>
      ref.kind === 'training'
        ? trainingChanged && ref.headVersionId === c.currentTraining?.snapshot.id
        : changedNutrition.has(ref.aggregateId),
    );
    const links = r.record.draft.planRefs.map((ref) => ({
      domain: ref.kind,
      aggregateId: ref.aggregateId,
      version: { kind: 'retained' as const, versionId: ref.headVersionId },
    }));
    const side = {
      plan: recoveryPlan(r.record.draft),
      status: r.record.status,
      selectedOptionId: r.record.selectedOptionId,
      planLinks: links,
    };
    return {
      aggregateId: r.aggregateId,
      state: changed ? 'affected' : 'unchanged',
      before: { ref: { versionId: r.record.versionId, version: r.record.version }, ...side },
      after: {
        ...side,
        planLinks: links.map((ref) => ({
          ...ref,
          version:
            changed &&
            (ref.domain === 'training'
              ? trainingChanged && ref.version.versionId === c.currentTraining?.snapshot.id
              : changedNutrition.has(ref.aggregateId))
              ? { kind: 'follows_approval' as const }
              : ref.version,
        })),
      },
      requirement:
        changed && (r.record.status !== 'user_confirmed' || r.record.selectedOptionId === null)
          ? 'resolve_before_review'
          : 'none',
    };
  });
  const routines = p.routines.map((r) => {
    const actual = c.routines.find((row) => row.versionId === r.scheduleVersionId);
    const source = built.input.routines.find((row) => row.record.versionId === r.scheduleVersionId);
    if (!actual || !source || actual.aggregateId !== r.record.id || !same(actual.record, r.record))
      invalid();
    let before;
    try {
      before = raceManualPublicRoutineExpansionSchema.parse({
        state: 'expanded',
        occurrences: expandRoutineSchedule(
          r.record,
          source.sourcePlanVersionId === c.currentTraining?.snapshot.id
            ? c.currentTraining.snapshot.draft
            : (built.input.sourcePlans.find((p) => p.id === source.sourcePlanVersionId)?.draft ??
                null),
        ),
      });
    } catch (e) {
      if (!(e instanceof RoutineExpansionError)) invalid();
      const result = raceManualPublicRoutineExpansionSchema.safeParse({
        state: 'unresolved',
        reason: e.code,
      });
      if (!result.success) invalid();
      before = result.data;
    }
    const started = c.routineActualManifest.runs.flatMap((row) => {
      const run = row.record;
      if (run.origin.kind !== 'planned') return [];
      const oid = run.origin.occurrenceId;
      const occurrence = c.routineActualManifest.occurrences.find(
        (o) => o.record.id === oid,
      )?.record;
      if (!occurrence) invalid();
      if (occurrence.schedule.id !== r.record.id) return [];
      if (
        run.blueprint.id !== occurrence.blueprint.id ||
        run.blueprint.versionId !== occurrence.blueprint.versionId
      )
        invalid();
      return [
        {
          runId: run.id,
          occurrenceId: oid,
          scheduleVersionId: occurrence.schedule.versionId,
          blueprintVersionId: run.blueprint.versionId,
          anchorKey: occurrence.anchorKey,
          preservation: 'started_run_frozen',
        },
      ];
    });
    const resolution = intent.resolutions.routines.find(
      (v) => v.scheduleVersionId === r.scheduleVersionId,
    );
    const expansion =
      r.state === 'affected'
        ? r.projection.expansion.state === 'expanded'
          ? { state: 'expanded', occurrences: r.projection.plannedOccurrences }
          : r.projection.expansion
        : before;
    return {
      aggregateId: r.record.id,
      state: r.state,
      blueprint: r.blueprint,
      before: {
        schedule: r.record,
        sourcePlanVersionId: source.sourcePlanVersionId,
        expansion: before,
      },
      after: {
        schedule: r.state === 'affected' ? r.projection.proposed : r.record,
        sourcePlanVersionId: resolution
          ? resolution.sourcePlanVersionId
          : source.sourcePlanVersionId,
        expansion,
      },
      retainedStarted: started,
      storedOccurrences: c.routineActualManifest.occurrences.flatMap((row) => {
        const o = row.record;
        // The public wire lists current occurrences and frozen started history;
        // unstarted historical rows remain in the private retained source roster.
        if (
          o.schedule.versionId !== r.record.versionId &&
          !started.some((run) => run.occurrenceId === o.id)
        )
          return [];
        const storedSource = c.routineActualManifest.schedules.find(
          (s) => s.versionId === o.schedule.versionId,
        );
        if (
          !storedSource ||
          storedSource.scheduleId !== o.schedule.id ||
          storedSource.record.blueprint.id !== o.blueprint.id ||
          storedSource.record.blueprint.versionId !== o.blueprint.versionId
        )
          invalid();
        return [
          {
            occurrenceId: o.id,
            schedule: o.schedule,
            blueprint: o.blueprint,
            sourcePlanVersionId: storedSource.sourcePlanVersionId,
            anchorKey: o.anchorKey,
            scheduledAt: o.scheduledAt,
            timingStatus: o.timingStatus,
            unresolvedReason: null,
          },
        ];
      }),
      resolution: resolution ? 'explicit_replacement' : 'absent',
      requirement:
        r.state === 'affected' && r.notice === 'affected_unresolved_requires_resolution'
          ? 'resolve_before_review'
          : 'none',
    };
  });
  const targets: Extract<RaceManualPublicImpact, { status: 'projected' }>['affected'] = [];
  if (trainingChanged && c.currentTraining)
    targets.push({ domain: 'training', aggregateId: c.currentTraining.aggregateId });
  nutrition
    .filter((n) => changedNutrition.has(n.aggregateId))
    .forEach((n) => targets.push({ domain: 'nutrition', aggregateId: n.aggregateId }));
  recovery
    .filter((r) => r.state === 'affected')
    .forEach((r) => targets.push({ domain: 'recovery', aggregateId: r.aggregateId }));
  routines
    .filter((r) => r.state === 'affected')
    .forEach((r) => targets.push({ domain: 'routine_schedule', aggregateId: r.aggregateId }));
  const requirements: Extract<
    RaceManualPublicImpact,
    { status: 'projected' }
  >['resolutionRequirements'] = [];
  const notices: Extract<RaceManualPublicImpact, { status: 'projected' }>['notices'] = [];
  for (const n of nutrition)
    for (const t of n.timings) {
      if (t.requirement === 'resolve_before_review')
        requirements.push({
          domain: 'nutrition',
          aggregateId: n.aggregateId,
          planVersionId: n.before.ref.versionId,
          itemId: t.itemId,
          reason: 'affected_timing_unresolved',
          editor: 'replace_anchor',
        });
      if (t.state === 'unchanged' && t.before.state !== 'resolved')
        notices.push({
          domain: 'nutrition',
          aggregateId: n.aggregateId,
          itemId: t.itemId,
          code: t.before.state === 'suspended' ? 'DISCONNECTED_RETAINED' : 'UNCHANGED_UNRESOLVED',
        });
    }
  for (const r of recovery)
    if (r.requirement === 'resolve_before_review')
      requirements.push({
        domain: 'recovery',
        aggregateId: r.aggregateId,
        strategyVersionId: r.before.ref.versionId,
        reason: 'recovery_confirmation_required',
        editor: 'confirm_recovery_and_review',
      });
  for (const r of routines) {
    if (r.requirement !== 'none')
      requirements.push({
        domain: 'routine_schedule',
        aggregateId: r.aggregateId,
        scheduleVersionId: r.before.schedule.versionId,
        reason:
          r.requirement === 'retained_ended_unresolved'
            ? 'retained_ended_unresolved'
            : 'affected_timing_unresolved',
        editor:
          r.requirement === 'retained_ended_unresolved'
            ? 'unavailable_frozen_ended'
            : 'replace_rule',
      });
    if (
      r.state !== 'affected' &&
      r.storedOccurrences.some(
        (o) =>
          o.schedule.versionId === r.before.schedule.versionId && o.timingStatus === 'unresolved',
      )
    )
      notices.push({
        domain: 'routine_schedule',
        aggregateId: r.aggregateId,
        itemId: null,
        code: 'UNCHANGED_UNRESOLVED',
      });
    if (r.before.schedule.state === 'ended')
      notices.push({
        domain: 'routine_schedule',
        aggregateId: r.aggregateId,
        itemId: null,
        code: 'ENDED_SCHEDULE_RETAINED',
      });
    if (r.retainedStarted.length)
      notices.push({
        domain: 'routine_schedule',
        aggregateId: r.aggregateId,
        itemId: null,
        code: 'STARTED_RUN_PRESERVED',
      });
  }
  return output({
    ...fixed,
    status: 'projected',
    expectedEvent: intent.expectedEvent,
    intent,
    beforeBasis: 'captured_snapshot',
    afterBasis: 'hypothetical',
    race: {
      eventId: c.event.id,
      expectedRevision: c.event.revision,
      before: raceSide(c.event),
      after: { ...raceSide(c.event), localDate: intent.newLocalDate },
    },
    training: section(training),
    nutrition: section(nutrition),
    recovery: section(recovery),
    routines: section(routines),
    retainedUnplanned: (p.retainedUnplannedRuns ?? []).map((r) => ({
      runId: r.run.id,
      blueprintVersionId: r.run.blueprint.versionId,
      preservation: 'unplanned_run_unchanged',
    })),
    affected: targets,
    resolutionRequirements: requirements,
    notices,
  });
}
