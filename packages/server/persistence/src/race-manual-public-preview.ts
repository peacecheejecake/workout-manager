import { z } from 'zod';
import { raceManualApprovalCandidateSchema } from '@workout/contracts/race-manual-approval';
import {
  raceManualPublicPreviewSchema,
  raceManualPublicPreviewReferenceSchema,
  type RaceManualPublicPreview,
} from '@workout/contracts/race-manual-public-preview';
import {
  raceManualReviewCandidateV2InputSchema,
  raceManualReviewCandidateV2ResultSchema,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';
import { expandRoutineSchedule, RoutineExpansionError } from './routine-expansion.js';
import { raceRoutineExpansionSchema } from '@workout/server-coaching/race-relative-schedule-impact';

/** Internal selected read, not a browser command. SQL118 supplies candidate_json;
 * SQL116's exact linked evidence supplies payload.payload.preparation's three
 * fields. Neither a live head nor a caller projection can replace frozen before. */
export const raceManualPublicPreviewSourceSchema = z.discriminatedUnion('bodyState', [
  z.strictObject({
    reference: raceManualPublicPreviewReferenceSchema,
    bodyState: z.literal('present'),
    candidate: raceManualApprovalCandidateSchema,
    preparation: z.strictObject({
      context: raceImpactConsumedCaptureSchema,
      sourceInput: raceManualReviewCandidateV2InputSchema,
      candidate: raceManualReviewCandidateV2ResultSchema,
    }),
  }),
  z.strictObject({
    reference: raceManualPublicPreviewReferenceSchema,
    bodyState: z.literal('purged'),
    candidate: z.null(),
    preparation: z.null(),
  }),
]);
export class RaceManualPublicPreviewError extends Error {
  constructor(readonly code: 'PUBLIC_PREVIEW_INVALID_CONTEXT' | 'PUBLIC_PREVIEW_LIMIT') {
    super(code);
  }
}
function invalid(): never {
  throw new RaceManualPublicPreviewError('PUBLIC_PREVIEW_INVALID_CONTEXT');
}
function same(a: unknown, b: unknown) {
  if (a === undefined || b === undefined) return a === b;
  return impactDependencyDigest(a) === impactDependencyDigest(b);
}
// Only assembler-declared set rosters are normalized. Ordered stored foods,
// items, steps and progress are never sorted or changed.
function normalizedSource(input: z.infer<typeof raceManualReviewCandidateV2InputSchema>) {
  const sort = <T>(rows: readonly T[], key: (row: T) => string) =>
    [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const p = input.projectionInput;
  return {
    projectionInput: {
      ...p,
      ...(p.retainedUnplannedRuns === undefined
        ? {}
        : { retainedUnplannedRuns: sort(p.retainedUnplannedRuns, (r) => r.run.id) }),
      sourcePlans: sort(p.sourcePlans, (r) => r.id),
      completionReports: sort(p.completionReports, (r) => r.sessionId),
      nutrition: sort(p.nutrition, (r) => r.record.versionId).map((r) => ({
        ...r,
        timings: sort(r.timings, (t) => t.itemId),
      })),
      routines: sort(p.routines, (r) => r.record.versionId).map((r) => ({
        ...r,
        occurrences: sort(r.occurrences, (o) => o.id),
        runs: sort(r.runs, (o) => o.id),
      })),
      resolutions: {
        nutrition: sort(p.resolutions.nutrition, (r) =>
          JSON.stringify([r.planVersionId, r.itemId]),
        ),
        routines: sort(p.resolutions.routines, (r) => r.scheduleVersionId),
      },
    },
    sourceFacts: {
      ...input.sourceFacts,
      nutritionRacePins: sort(input.sourceFacts.nutritionRacePins, (r) =>
        JSON.stringify([r.nutritionVersionId, r.itemId]),
      ),
    },
  };
}
function section<T>(members: T[]) {
  return members.length ? { state: 'present' as const, members } : { state: 'absent' as const };
}
function raceSide(event: z.infer<typeof raceImpactConsumedCaptureSchema>['event']) {
  const {
    title,
    localDate,
    localStartTime,
    timezone,
    distance,
    priority,
    participation,
    targetSeconds,
  } = event;
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
function nutritionItem(
  item: z.infer<
    typeof raceImpactConsumedCaptureSchema
  >['nutrition'][number]['record']['items'][number],
) {
  const { id, category, title, anchor, foods, targets, instructions } = item;
  return { id, category, title, anchor, foods, targets, instructions };
}
function nutritionPlan(
  record: z.infer<typeof raceImpactConsumedCaptureSchema>['nutrition'][number]['record'],
) {
  return {
    period: record.period,
    purpose: record.purpose,
    timezone: record.timezone,
    items: record.items.map(({ id, category, title, anchor, foods, targets, instructions }) => ({
      id,
      category,
      title,
      anchor,
      foods,
      targets,
      instructions,
    })),
  };
}
function recoveryPlan(
  draft: z.infer<typeof raceImpactConsumedCaptureSchema>['recovery'][number]['record']['draft'],
) {
  const { title, goal, startDate, endDateExclusive, timezone, priority, options, reassessment } =
    draft;
  return { title, goal, startDate, endDateExclusive, timezone, priority, options, reassessment };
}
/** Pure wire projection only. Structural correspondence is not source
 * authentication, current permission, fresh approval or storage admission. */
export function projectRaceManualPublicPreview(raw: unknown): RaceManualPublicPreview {
  try {
    assertRaceManualPlainV2(raw);
  } catch {
    invalid();
  }
  const decoded = raceManualPublicPreviewSourceSchema.safeParse(raw);
  if (!decoded.success) invalid();
  const read = decoded.data;
  if (read.bodyState === 'purged')
    return raceManualPublicPreviewSchema.parse({
      schemaVersion: 1,
      status: 'unavailable',
      reference: read.reference,
      reason: 'review_body_purged',
      preview: null,
    });
  const { context: c, sourceInput: input, candidate: readonly } = read.preparation;
  const app = read.candidate;
  const normalized = normalizedSource(input);
  if (
    app.applicationState !== 'ready_for_explicit_approval' ||
    readonly.status !== 'assembled_readonly'
  )
    invalid();
  if (
    app.candidateId !== read.reference.candidateId ||
    app.applicationDigest !== read.reference.applicationDigest ||
    app.createdAt !== read.reference.createdAt ||
    !same(app.chain, read.reference.chain) ||
    app.chain.readonlyCandidateDigest !== readonly.digest ||
    !same(readonly.body.projectionInput, normalized.projectionInput) ||
    !same(readonly.body.binding, input.binding) ||
    !same(readonly.body.sourceFacts, normalized.sourceFacts) ||
    readonly.body.athleteId !== c.athleteId ||
    input.athleteId !== c.athleteId ||
    input.binding.readSetDigest !== c.readSetDigest ||
    input.binding.restoreGeneration !== c.restoreGeneration ||
    app.expectation.restoreGeneration !== c.restoreGeneration ||
    !same(input.projectionInput.event, c.event) ||
    app.raceChange.eventId !== c.event.id ||
    app.raceChange.expectedRevision !== c.event.revision ||
    app.raceChange.newLocalDate !== input.projectionInput.newLocalDate ||
    !c.calendarIntent ||
    !same(c.calendarIntent.expectedEvent, input.binding.event) ||
    c.calendarIntent.newLocalDate !== app.raceChange.newLocalDate ||
    !same(c.calendarIntent.selection, input.projectionInput.selection) ||
    c.manualBasis.app.state !== 'present' ||
    input.binding.appRevision !== c.manualBasis.app.revision ||
    app.expectation.appRevision !== input.binding.appRevision ||
    !same(app.expectation.manualPolicy, input.binding.policy) ||
    !same(c.manualBasis.policy, input.binding.policy)
  )
    invalid();
  const p = readonly.body.projection;
  // Require all frozen current-domain rows, never substitute historical extras.
  const exact = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && new Set(a).size === a.length && same([...a].sort(), [...b].sort());
  if (
    !exact(
      c.nutrition.map((r) => r.versionId),
      p.nutrition.map((r) => r.planVersionId),
    ) ||
    !exact(
      c.routines.map((r) => r.versionId),
      p.routines.map((r) => r.scheduleVersionId),
    )
  )
    invalid();
  for (const n of p.nutrition)
    if (!same(n.record, c.nutrition.find((r) => r.versionId === n.planVersionId)?.record))
      invalid();
  for (const r of p.routines)
    if (!same(r.record, c.routines.find((row) => row.versionId === r.scheduleVersionId)?.record))
      invalid();
  const { status, coverage, readSetDigest, affected, ...readSet } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  if (
    impactDependencyDigest({
      ...readSet,
      coreDependencies: { ...c.coreDependencies, capturedAt: null },
    }) !== c.readSetDigest ||
    !same(input.projectionInput.currentPlan, c.currentTraining?.snapshot ?? null)
  )
    invalid();
  for (const domain of ['nutrition', 'recovery', 'routine'] as const) {
    const rows = domain === 'routine' ? c.routines : c[domain];
    if (
      !exact(
        c.rosters[domain].map((r) => JSON.stringify([r.aggregateId, r.versionId])),
        rows.map((r) => JSON.stringify([r.aggregateId, r.versionId])),
      )
    )
      invalid();
  }
  for (const row of input.projectionInput.sourcePlans) {
    const actual =
      c.currentTraining?.snapshot.id === row.id
        ? c.currentTraining.snapshot
        : c.consumedSources.plans.find((p) => p.id === row.id);
    if (!actual || !same(actual, row)) invalid();
  }
  for (const row of p.routines) {
    const actual = c.routineActualManifest.blueprints.find(
      (b) =>
        b.record.routineId === row.blueprint.routineId &&
        b.record.versionId === row.blueprint.versionId,
    );
    if (!actual || !same(actual.record, row.blueprint)) invalid();
  }
  const unplannedActual = c.routineActualManifest.runs.filter(
    (row) => row.record.origin.kind === 'unplanned',
  );
  if (
    !exact(
      unplannedActual.map((row) => row.record.id),
      (p.retainedUnplannedRuns ?? []).map((row) => row.run.id),
    )
  )
    invalid();
  for (const row of p.retainedUnplannedRuns ?? []) {
    if (
      !same(row.run, unplannedActual.find((r) => r.record.id === row.run.id)?.record) ||
      !same(
        row.blueprint,
        c.routineActualManifest.blueprints.find(
          (b) =>
            b.record.versionId === row.blueprint.versionId &&
            b.record.routineId === row.blueprint.routineId,
        )?.record,
      )
    )
      invalid();
  }
  const writes = app.writes;
  const findWrite = (
    domain: 'training' | 'nutrition' | 'recovery' | 'routine_schedule',
    id: string,
  ) => writes.find((w) => w.domain === domain && w.aggregateId === id);
  const actualHeads = {
    training: section(
      c.currentTraining
        ? [
            {
              aggregateId: c.currentTraining.aggregateId,
              head: {
                kind: 'exists',
                versionId: c.currentTraining.snapshot.id,
                version: c.currentTraining.snapshot.version,
              },
            },
          ]
        : [],
    ),
    nutrition: section(
      c.nutrition.map((r) => ({
        aggregateId: r.aggregateId,
        head: { kind: 'exists', versionId: r.versionId, version: r.record.version },
      })),
    ),
    recovery: section(
      c.recovery.map((r) => ({
        aggregateId: r.aggregateId,
        head: { kind: 'exists', versionId: r.versionId, version: r.record.version },
      })),
    ),
    routine_schedule: section(
      c.routines.map((r) => ({
        aggregateId: r.aggregateId,
        head: { kind: 'exists', versionId: r.versionId },
      })),
    ),
  };
  for (const domain of ['training', 'nutrition', 'recovery', 'routine_schedule'] as const) {
    const a = actualHeads[domain],
      b = app.expectation.heads[domain];
    if (a.state !== b.state) invalid();
    if (a.state === 'present' && b.state === 'present') {
      if (
        !exact(
          a.members.map((r) => r.aggregateId),
          b.members.map((r) => r.aggregateId),
        )
      )
        invalid();
      for (const row of a.members)
        if (!same(row.head, b.members.find((r) => r.aggregateId === row.aggregateId)?.head))
          invalid();
    }
  }
  const training = c.currentTraining
    ? (() => {
        const row = c.currentTraining;
        if (!row) invalid();
        const w = findWrite('training', row.aggregateId);
        if (w && w.domain !== 'training') invalid();
        const after = w ? w.proposed : row.snapshot.draft;
        if (!same(after, p.calendar.plan)) invalid();
        return [
          {
            aggregateId: row.aggregateId,
            before: {
              ref: { versionId: row.snapshot.id, version: row.snapshot.version },
              plan: row.snapshot.draft,
            },
            after: {
              kind: w ? ('new_version_on_approval' as const) : ('retained' as const),
              plan: after,
            },
          },
        ];
      })()
    : [];
  const nutrition = p.nutrition.map((n) => {
    const w = findWrite('nutrition', n.record.planId);
    if (w && w.domain !== 'nutrition') invalid();
    if (
      w &&
      !same(
        w.intent.intent.command.draft.items,
        n.items.map(({ item }) => {
          const { planVersionId, ...draft } = item;
          void planVersionId;
          return draft;
        }),
      )
    )
      invalid();
    if (w) {
      const draft = w.intent.intent.command.draft;
      if (
        !same(
          {
            period: draft.period,
            purpose: draft.purpose,
            timezone: draft.timezone,
            linkedTrainingPlanVersionId: draft.linkedTrainingPlanVersionId,
          },
          {
            period: n.record.period,
            purpose: n.record.purpose,
            timezone: n.record.timezone,
            linkedTrainingPlanVersionId: n.record.linkedTrainingPlanVersionId,
          },
        )
      )
        invalid();
    }
    const before = nutritionPlan(n.record);
    const itemMap = new Map(n.items.map((row) => [row.itemId, row.item]));
    const after = {
      ...before,
      items: w
        ? n.items.map(({ item }) => nutritionItem(item))
        : n.record.items.map((item) => {
            const projected = itemMap.get(item.id);
            if (!projected) invalid();
            return nutritionItem(projected);
          }),
    };
    const oldLink = n.record.linkedTrainingPlanVersionId;
    const linked =
      oldLink === null
        ? { kind: 'absent' as const }
        : { kind: 'retained' as const, versionId: oldLink };
    const trainingWrite = c.currentTraining
      ? findWrite('training', c.currentTraining.aggregateId)
      : undefined;
    const afterLink =
      trainingWrite && oldLink === c.currentTraining?.snapshot.id
        ? { kind: 'follows_training_approval' as const, aggregateId: trainingWrite.aggregateId }
        : linked;
    return {
      aggregateId: n.record.planId,
      before: {
        ref: { versionId: n.record.versionId, version: n.record.version },
        plan: before,
        linkedTraining: linked,
      },
      after: {
        kind: w ? ('new_version_on_approval' as const) : ('retained' as const),
        plan: after,
        linkedTraining: afterLink,
      },
      timings: n.items.map((i) => ({
        itemId: i.itemId,
        state: i.state,
        before:
          i.item.anchor.kind === 'disconnected'
            ? {
                state: 'suspended' as const,
                reason: 'race_disconnected' as const,
                resume: 'explicit_reconnect_and_reapproval_required' as const,
              }
            : i.before.state === 'resolved'
              ? { ...i.before, timezone: n.record.timezone }
              : i.before,
        after:
          i.item.anchor.kind === 'disconnected'
            ? {
                state: 'suspended' as const,
                reason: 'race_disconnected' as const,
                resume: 'explicit_reconnect_and_reapproval_required' as const,
              }
            : i.after.state === 'resolved'
              ? { ...i.after, timezone: n.record.timezone }
              : i.after,
      })),
    };
  });
  const recovery = c.recovery.map((r) => {
    const w = findWrite('recovery', r.aggregateId);
    if (w && w.domain !== 'recovery') invalid();
    if (
      w &&
      (!same(w.proposed, r.record.draft) || w.selectedOptionId !== r.record.selectedOptionId)
    )
      invalid();
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
      before: { ref: { versionId: r.record.versionId, version: r.record.version }, ...side },
      after: {
        ...side,
        kind: w ? ('new_version_on_approval' as const) : ('retained' as const),
        planLinks: links.map((ref) => ({
          ...ref,
          version:
            w && findWrite(ref.domain, ref.aggregateId)
              ? { kind: 'follows_approval' as const }
              : ref.version,
        })),
      },
    };
  });
  const routines = p.routines.map((r) => {
    const w = findWrite('routine_schedule', r.record.id);
    if (w && w.domain !== 'routine_schedule') invalid();
    const source = input.projectionInput.routines.find(
      (row) => row.record.versionId === r.scheduleVersionId,
    );
    if (!source) invalid();
    const plan =
      source.sourcePlanVersionId === c.currentTraining?.snapshot.id
        ? c.currentTraining.snapshot
        : c.consumedSources.plans.find((row) => row.id === source.sourcePlanVersionId);
    let beforeExpansion;
    try {
      beforeExpansion = raceRoutineExpansionSchema.parse({
        state: 'expanded',
        occurrences: expandRoutineSchedule(r.record, plan?.draft ?? null),
      });
    } catch (error) {
      if (!(error instanceof RoutineExpansionError)) invalid();
      const checked = raceRoutineExpansionSchema.safeParse({
        state: 'unresolved',
        reason: error.code,
      });
      if (!checked.success) invalid();
      beforeExpansion = checked.data;
    }
    const started = c.routineActualManifest.runs.flatMap((row) => {
      const run = row.record;
      if (run.origin.kind !== 'planned') return [];
      const occurrenceId = run.origin.occurrenceId;
      const occurrence = c.routineActualManifest.occurrences.find(
        (o) => o.record.id === occurrenceId,
      )?.record;
      if (!occurrence) invalid();
      if (occurrence.schedule.id !== r.record.id) return [];
      return [
        {
          runId: run.id,
          occurrenceId: occurrence.id,
          scheduleVersionId: occurrence.schedule.versionId,
          blueprintVersionId: run.blueprint.versionId,
          anchorKey: occurrence.anchorKey,
          preservation: 'started_run_frozen' as const,
        },
      ];
    });
    if (
      w &&
      (r.state !== 'affected' ||
        !same({ ...w.proposed, versionId: r.projection.proposed.versionId }, r.projection.proposed))
    )
      invalid();
    if (w) {
      const afterPlan =
        w.sourcePlanVersionId === c.currentTraining?.snapshot.id
          ? p.calendar.plan
          : (c.consumedSources.plans.find((row) => row.id === w.sourcePlanVersionId)?.draft ??
            null);
      if (w.sourcePlanVersionId !== null && afterPlan === null) invalid();
      const expected = expandRoutineSchedule(w.proposed, afterPlan).filter(
        (o) => !started.some((run) => run.anchorKey === o.anchorKey),
      );
      if (!same(expected, w.occurrences)) invalid();
    }
    return {
      aggregateId: r.record.id,
      blueprint: r.blueprint,
      before: { schedule: r.record, expansion: beforeExpansion },
      after: {
        kind: w ? ('new_version_on_approval' as const) : ('retained' as const),
        schedule: w ? w.proposed : r.record,
        expansion: w ? { state: 'expanded' as const, occurrences: w.occurrences } : beforeExpansion,
      },
      retainedStarted: started,
    };
  });
  const retainedUnplanned = (p.retainedUnplannedRuns ?? []).map((row) => ({
    runId: row.run.id,
    blueprintVersionId: row.run.blueprint.versionId,
    preservation: 'unplanned_run_unchanged' as const,
  }));
  const notices: {
    domain: 'nutrition' | 'routine_schedule';
    aggregateId: string;
    itemId: string | null;
    code:
      | 'DISCONNECTED_RETAINED'
      | 'UNCHANGED_UNRESOLVED'
      | 'ENDED_SCHEDULE_RETAINED'
      | 'STARTED_RUN_PRESERVED';
  }[] = [];
  for (const n of nutrition)
    for (const t of n.timings)
      if (t.state === 'unchanged' && t.before.state !== 'resolved')
        notices.push({
          domain: 'nutrition',
          aggregateId: n.aggregateId,
          itemId: t.itemId,
          code: t.before.state === 'suspended' ? 'DISCONNECTED_RETAINED' : 'UNCHANGED_UNRESOLVED',
        });
  for (const r of routines) {
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
  const out = {
    schemaVersion: 1,
    status: 'present',
    reference: read.reference,
    storedCandidateState: app.applicationState,
    beforeBasis: 'frozen_review',
    afterBasis: 'hypothetical_on_approval',
    freshness: 'not_checked_on_read',
    scope: 'whole_affected',
    race: {
      eventId: c.event.id,
      expectedRevision: c.event.revision,
      before: raceSide(c.event),
      after: { ...raceSide(c.event), localDate: app.raceChange.newLocalDate },
    },
    training: section(training),
    nutrition: section(nutrition),
    recovery: section(recovery),
    routines: section(routines),
    retainedUnplanned,
    affected: app.affected,
    notices,
  };
  const result = raceManualPublicPreviewSchema.safeParse(out);
  if (!result.success) {
    if (result.error.issues.some((issue) => issue.message === 'Bounded plain preview required'))
      throw new RaceManualPublicPreviewError('PUBLIC_PREVIEW_LIMIT');
    invalid();
  }
  return result.data;
}
