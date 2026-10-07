import { z } from 'zod';
import {
  nutritionPlanVersionCompatibleV4Schema,
  nutritionPlanVersionV4Schema,
} from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineScheduleVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import {
  raceRetainedUnplannedRunSchema,
  raceScheduleTimingSchema,
  raceRoutineExpansionSchema,
} from './race-relative-schedule-impact.js';
import {
  racePlanImpactProjectedSchema,
  racePlanImpactReasonSchema,
} from './race-plan-impact-codecs.js';

const approval = z.strictObject({
  status: z.literal('blocked'),
  reasons: z.tuple([
    z.literal('full_owned_review_missing'),
    z.literal('complete_dependency_freshness_missing'),
    z.literal('atomic_multi_domain_approval_missing'),
  ]),
});
const item = nutritionPlanVersionV4Schema.shape.items.element;
const absentResolution = z.strictObject({ state: z.literal('absent') });
const nutritionItem = z.discriminatedUnion('state', [
  z.strictObject({
    itemId: item.shape.id,
    state: z.literal('unchanged'),
    item,
    before: raceScheduleTimingSchema,
    after: raceScheduleTimingSchema,
    notice: z.literal('existing_unresolved_preserved').nullable(),
    resolution: absentResolution,
  }),
  z.strictObject({
    itemId: item.shape.id,
    state: z.literal('affected'),
    item,
    before: raceScheduleTimingSchema,
    after: raceScheduleTimingSchema,
    notice: z.literal('affected_unresolved_requires_resolution').nullable(),
    resolution: z.discriminatedUnion('state', [
      absentResolution,
      z.strictObject({
        state: z.literal('explicit'),
        action: z.literal('replace_anchor'),
        outcome: z.enum(['resolved', 'unresolved']),
      }),
    ]),
  }),
]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nutrition = z
  .strictObject({
    planVersionId: nutritionPlanVersionV4Schema.shape.versionId,
    record: nutritionPlanVersionCompatibleV4Schema,
    items: z.array(nutritionItem).max(5000),
  })
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (value.planVersionId !== value.record.versionId) fail('Nutrition version identity mismatch');
    const original = new Map(value.record.items.map((row) => [row.id, row]));
    if (
      new Set(value.items.map((row) => row.itemId)).size !== value.items.length ||
      value.items.length !== original.size
    )
      fail('Nutrition item roster mismatch');
    for (const entry of value.items) {
      const saved = original.get(entry.itemId);
      if (
        !saved ||
        entry.item.id !== entry.itemId ||
        entry.item.planVersionId !== value.record.versionId
      ) {
        fail('Nutrition item identity mismatch');
        continue;
      }
      if (entry.state === 'unchanged') {
        if (!same(entry.item, saved) || !same(entry.before, entry.after))
          fail('Unchanged nutrition must preserve body and timing');
        if (
          entry.notice !==
          (entry.before.state === 'unresolved' ? 'existing_unresolved_preserved' : null)
        )
          fail('Unchanged nutrition notice mismatch');
      } else {
        const explicit = entry.resolution.state === 'explicit';
        if (
          !same({ ...entry.item, anchor: saved.anchor }, saved) ||
          (!explicit && !same(entry.item, saved))
        )
          fail('Proposed nutrition changes more than declared anchor');
        if (entry.resolution.state === 'explicit' && entry.resolution.outcome !== entry.after.state)
          fail('Resolution timing outcome mismatch');
        if (
          entry.notice !==
          (entry.after.state === 'unresolved' || (entry.before.state === 'unresolved' && !explicit)
            ? 'affected_unresolved_requires_resolution'
            : null)
        )
          fail('Affected nutrition notice mismatch');
        if (saved.anchor.kind === 'disconnected')
          fail('Disconnected source cannot become affected timing');
      }
    }
  });
const routineFields = {
  scheduleVersionId: routineScheduleVersionSchema.shape.versionId,
  record: routineScheduleVersionSchema,
  blueprint: routineBlueprintVersionSchema,
  occurrences: z.array(routineOccurrenceSchema).max(1000),
  runs: z.array(routineRunSchema).max(1000),
};
const routine = z
  .discriminatedUnion('state', [
    z.strictObject({
      ...routineFields,
      state: z.literal('unchanged'),
      notice: z.literal('existing_unresolved_preserved').nullable(),
      projection: z.null(),
    }),
    z.strictObject({
      ...routineFields,
      state: z.literal('retained_ended'),
      notice: z.enum(['affected_unresolved_requires_resolution', 'ended_schedule_preserved']),
      projection: z.null(),
    }),
    z.strictObject({
      ...routineFields,
      state: z.literal('affected'),
      notice: z.literal('affected_unresolved_requires_resolution').nullable(),
      projection: z.strictObject({
        proposed: routineScheduleVersionSchema,
        expansion: raceRoutineExpansionSchema,
        plannedOccurrences: z.array(routineOccurrenceSchema).max(100),
        retainedOccurrences: z.array(routineOccurrenceSchema).max(1000),
        resolution: z.discriminatedUnion('state', [
          absentResolution,
          z.strictObject({ state: z.literal('explicit'), action: z.literal('replace_rule') }),
        ]),
      }),
    }),
  ])
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const record = value.record,
      blueprint = value.blueprint;
    if (
      value.scheduleVersionId !== record.versionId ||
      record.blueprint.id !== blueprint.routineId ||
      record.blueprint.versionId !== blueprint.versionId
    )
      fail('Routine identity mismatch');
    const occurrences = new Map(value.occurrences.map((row) => [row.id, row]));
    if (
      occurrences.size !== value.occurrences.length ||
      new Set(value.runs.map((row) => row.id)).size !== value.runs.length
    )
      fail('Routine roster duplicates');
    for (const occurrence of value.occurrences)
      if (
        occurrence.schedule.id !== record.id ||
        occurrence.schedule.versionId !== record.versionId ||
        occurrence.blueprint.id !== blueprint.routineId ||
        occurrence.blueprint.versionId !== blueprint.versionId
      )
        fail('Saved occurrence identity mismatch');
    const retainedIds = new Set<string>();
    for (const run of value.runs) {
      if (
        run.blueprint.id !== blueprint.routineId ||
        run.blueprint.versionId !== blueprint.versionId
      )
        fail('Run frozen blueprint mismatch');
      if (run.origin.kind === 'planned') {
        if (!occurrences.has(run.origin.occurrenceId)) fail('Run occurrence missing');
        retainedIds.add(run.origin.occurrenceId);
      }
    }
    if (value.state === 'unchanged') {
      if (
        value.notice !==
        (value.occurrences.some((row) => row.timingStatus === 'unresolved')
          ? 'existing_unresolved_preserved'
          : null)
      )
        fail('Unchanged routine notice mismatch');
      return;
    }
    if (value.state === 'retained_ended') {
      if (
        record.state !== 'ended' ||
        value.notice !==
          (value.occurrences.some((row) => row.timingStatus === 'unresolved')
            ? 'affected_unresolved_requires_resolution'
            : 'ended_schedule_preserved')
      )
        fail('Ended routine mismatch');
      return;
    }
    const p = value.projection;
    if (
      record.state === 'ended' ||
      !same({ ...p.proposed, rule: record.rule, window: record.window }, record) ||
      (p.resolution.state === 'absent' && !same(p.proposed, record))
    )
      fail('Proposed routine changes undeclared fields');
    const expectedRetained = value.occurrences.filter((row) => retainedIds.has(row.id));
    if (!same(p.retainedOccurrences, expectedRetained)) fail('Retained occurrence body mismatch');
    const keys = new Set(expectedRetained.map((row) => row.anchorKey));
    const expanded = p.expansion.state === 'expanded' ? p.expansion.occurrences : [];
    if (
      new Set(expanded.map((row) => row.id)).size !== expanded.length ||
      new Set(expanded.map((row) => row.anchorKey)).size !== expanded.length ||
      expanded.length > p.proposed.window.maxOccurrences
    )
      fail('Expansion roster invalid');
    for (const row of expanded)
      if (
        row.schedule.id !== record.id ||
        row.schedule.versionId !== record.versionId ||
        row.blueprint.id !== blueprint.routineId ||
        row.blueprint.versionId !== blueprint.versionId
      )
        fail('Expansion identity mismatch');
    const planned = expanded.filter((row) => !retainedIds.has(row.id) && !keys.has(row.anchorKey));
    if (!same(p.plannedOccurrences, planned)) fail('Planned expansion membership mismatch');
    const unresolved =
      p.expansion.state === 'unresolved' ||
      planned.some((row) => row.timingStatus === 'unresolved') ||
      expectedRetained.some((row) => row.timingStatus === 'unresolved') ||
      (p.resolution.state === 'absent' &&
        value.occurrences.some((row) => row.timingStatus === 'unresolved'));
    if (value.notice !== (unresolved ? 'affected_unresolved_requires_resolution' : null))
      fail('Affected routine notice mismatch');
  });
/** Finite producer-built internal output validation primitive. Callers must
 * supply an outer aggregate byte bound; this is not an unbounded external decoder. */
export const raceRelativeScheduleImpactResultCompatibleV4BodySchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('rejected'),
      reason: z.union([
        racePlanImpactReasonSchema,
        z.enum(['invalid_port_result', 'unsupported_resolution', 'source_identity_mismatch']),
      ]),
      approval,
    }),
    z
      .strictObject({
        status: z.literal('projected'),
        approval,
        calendar: racePlanImpactProjectedSchema,
        nutrition: z.array(nutrition).max(1000),
        routines: z.array(routine).max(1000),
        retainedUnplannedRuns: z
          .array(
            z
              .strictObject({
                state: z.literal('retained_unplanned'),
                blueprint: routineBlueprintVersionSchema,
                run: routineRunSchema,
              })
              .superRefine((row, ctx) => {
                if (
                  !raceRetainedUnplannedRunSchema.safeParse({
                    blueprint: row.blueprint,
                    run: row.run,
                  }).success
                )
                  ctx.addIssue({ code: 'custom', message: 'Invalid retained unplanned tuple' });
              }),
          )
          .max(1000)
          .optional(),
        requiresResolution: z.boolean(),
        completionReports: z.array(sessionCompletionSchema).max(1000),
      })
      .superRefine((value, ctx) => {
        const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
        if (
          new Set(value.nutrition.map((row) => row.planVersionId)).size !==
            value.nutrition.length ||
          new Set(value.routines.map((row) => row.scheduleVersionId)).size !==
            value.routines.length ||
          new Set(value.completionReports.map((row) => row.sessionId)).size !==
            value.completionReports.length
        )
          fail('Duplicate output rosters');
        if (value.retainedUnplannedRuns !== undefined) {
          const ids = new Set<string>();
          const blueprints = new Map<string, unknown>();
          for (const row of [...value.routines, ...value.retainedUnplannedRuns]) {
            const identity = JSON.stringify([row.blueprint.routineId, row.blueprint.versionId]);
            const previous = blueprints.get(identity);
            if (previous !== undefined && !same(previous, row.blueprint))
              fail('Divergent frozen blueprint body');
            blueprints.set(identity, row.blueprint);
          }
          let visits = 0;
          for (const row of value.routines)
            for (const run of row.runs) {
              if (run.origin.kind !== 'planned' || ids.has(run.id))
                fail('Scheduled run roster mismatch');
              ids.add(run.id);
            }
          for (const row of value.retainedUnplannedRuns) {
            if (ids.has(row.run.id)) fail('Duplicate retained run');
            ids.add(row.run.id);
            visits += 1 + row.blueprint.steps.length + row.run.progress.length;
            for (const progress of row.run.progress) visits += progress.actualRefs.length;
          }
          if (visits > 5000) fail('Retained run visit bound');
        }
        const unresolved =
          value.nutrition.some((row) =>
            row.items.some((entry) => entry.notice === 'affected_unresolved_requires_resolution'),
          ) ||
          value.routines.some((row) => row.notice === 'affected_unresolved_requires_resolution');
        if (value.requiresResolution !== unresolved) fail('Resolution summary mismatch');
      }),
  ],
);
/** Explicit successor boundary only. It authenticates no source and grants no
 * storage or approval. Legacy projector outputs retain their original limits. */
export const raceRelativeScheduleImpactResultCompatibleV4Schema = z
  .unknown()
  .superRefine((value, ctx) => {
    try {
      const json = JSON.stringify(value);
      if (json === undefined || Buffer.byteLength(json, 'utf8') > 4194304) throw Error('bound');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Relative result exceeds JSON boundary' });
    }
  })
  .pipe(raceRelativeScheduleImpactResultCompatibleV4BodySchema);
export type RaceRelativeScheduleImpactResultCompatibleV4 = z.infer<
  typeof raceRelativeScheduleImpactResultCompatibleV4Schema
>;
