import { z } from 'zod';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { raceEventSchema } from '@workout/contracts/races';
import { localDateSchema } from '@workout/contracts/primitives';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  type RoutineOccurrence,
} from '@workout/contracts/routines';
import { projectRacePlanImpact } from '@workout/server-coaching/race-plan-impact';
import { expandRoutineSchedule, RoutineExpansionError } from './routine-expansion.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

const id = z.string().min(1).max(200);
const tenant = z.string().min(1).max(200);
const selection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keep_plan') }),
  z.strictObject({
    kind: z.literal('move_period'),
    expectedCurrentPlanVersionId: z.uuid(),
    periodId: id,
    newStartDate: localDateSchema,
    scope: z.enum(['period_only', 'descendants_and_sessions']),
  }),
]);
/** Internal owned capture correspondence. This schema grants no source or write permission. */
export const routineScheduleReadManifestProjectionSchema = z.strictObject({
  athleteId: tenant,
  currentTraining: z
    .strictObject({ aggregateId: z.uuid(), snapshot: planSnapshotSchema })
    .nullable(),
  sourcePlans: z.array(planSnapshotSchema).max(1000),
  blueprints: z.array(routineBlueprintVersionSchema).max(1000),
  schedules: z
    .array(
      z.strictObject({
        scheduleId: id,
        versionId: id,
        sourcePlanVersionId: z.uuid().nullable(),
        record: routineScheduleVersionSchema,
        currentHead: z.discriminatedUnion('state', [
          z.strictObject({ state: z.literal('absent') }),
          z.strictObject({
            state: z.literal('present'),
            versionId: id,
            notificationMuted: z.boolean().nullable(),
          }),
        ]),
      }),
    )
    .max(1000),
  routines: z
    .array(
      z.strictObject({
        aggregateId: id,
        versionId: id,
        record: routineScheduleVersionSchema,
        sourceVersionId: z.uuid().nullable(),
        sourceRelation: z.enum(['absent', 'current', 'historical']),
        affected: z.boolean(),
      }),
    )
    .max(1000),
  affectedRoutineIds: z.array(id).max(1000),
  calendarIntent: z
    .strictObject({
      athleteId: tenant,
      event: raceEventSchema,
      newLocalDate: localDateSchema,
      selection,
      completionReports: z.array(sessionCompletionSchema).max(1000),
    })
    .optional(),
});
export type RoutineScheduleReadManifestProjection = z.infer<
  typeof routineScheduleReadManifestProjectionSchema
>;
export type RoutineScheduleReadBlocker =
  | 'invalid_projection'
  | 'projection_limit'
  | 'source_identity_mismatch'
  | 'source_plan_missing'
  | 'source_membership_mismatch'
  | 'source_relation_mismatch'
  | 'blueprint_missing'
  | 'source_timezone_mismatch'
  | 'affected_selection_port_missing'
  | 'foreign_source'
  | 'calendar_projection_rejected'
  | 'affected_roster_mismatch';
const remaining = [
  'complete_catalog_and_actual_manifest',
  'supplementary_reference_manifest',
  'routine_occurrences_and_started_runs',
  'complete_source_permission_manifest',
  'manual_purpose_app_and_policy_binding',
] as const;
type Expansion =
  { state: 'expanded'; occurrences: RoutineOccurrence[] } | { state: 'unresolved'; reason: string };
export type RoutineScheduleReadManifestResult = {
  status: 'validated_read_scope' | 'blocked';
  authority: 'none';
  freshness: 'not_checked';
  complete: false;
  remaining: typeof remaining;
  blockers: { path: string; reason: RoutineScheduleReadBlocker }[];
  digest: string | null;
  affectedRoutineIds: string[];
  timings: {
    scheduleVersionId: string;
    before: Expansion;
    after: Expansion | null;
    notice:
      | 'existing_unresolved_preserved'
      | 'affected_unresolved_requires_resolution'
      | 'ended_schedule_preserved'
      | null;
  }[];
};
// UUID identity is case independent; opaque public IDs retain case.
const key = (value: string) => (z.uuid().safeParse(value).success ? value.toLowerCase() : value);
const same = (a: string, b: string) => key(a) === key(b);
const tuple = (a: string, b: string) => JSON.stringify([key(a), key(b)]);
const digest = impactDependencyDigest;
function byteSize(input: unknown) {
  try {
    const text = JSON.stringify(input);
    return text === undefined ? Infinity : Buffer.byteLength(text, 'utf8');
  } catch {
    return Infinity;
  }
}
function expand(
  record: z.infer<typeof routineScheduleVersionSchema>,
  plan: z.infer<typeof planSnapshotSchema>['draft'] | null,
): Expansion {
  try {
    return { state: 'expanded', occurrences: expandRoutineSchedule(record, plan) };
  } catch (error) {
    if (error instanceof RoutineExpansionError) return { state: 'unresolved', reason: error.code };
    throw error;
  }
}
/** Frozen before and hypothetical after only. Existing occurrence/run/actual/history
 * validation remains required; expansion never replaces their saved records. */
export function validateRoutineScheduleReadManifest(
  input: unknown,
): RoutineScheduleReadManifestResult {
  const blockers: RoutineScheduleReadManifestResult['blockers'] = [];
  const timings: RoutineScheduleReadManifestResult['timings'] = [];
  const affectedRoutineIds: string[] = [];
  const fail = (path: string, reason: RoutineScheduleReadBlocker) =>
    blockers.push({ path, reason });
  const result = (): RoutineScheduleReadManifestResult => ({
    status: blockers.length ? 'blocked' : 'validated_read_scope',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    remaining,
    blockers,
    timings,
    affectedRoutineIds,
    digest: blockers.length ? null : digest(input),
  });
  if (byteSize(input) > 4 * 1024 * 1024) {
    fail('', 'projection_limit');
    return result();
  }
  const parsed = routineScheduleReadManifestProjectionSchema.safeParse(input);
  if (!parsed.success) {
    fail('', 'invalid_projection');
    return result();
  }
  const c = parsed.data;
  if (
    c.sourcePlans.length +
      c.blueprints.length +
      c.schedules.length +
      c.routines.length +
      c.affectedRoutineIds.length +
      (c.calendarIntent?.completionReports.length ?? 0) >
    5000
  ) {
    fail('', 'projection_limit');
    return result();
  }
  const plans = new Map(c.sourcePlans.map((p) => [key(p.id), p]));
  const blueprints = new Map(c.blueprints.map((b) => [tuple(b.routineId, b.versionId), b]));
  const schedules = new Map(c.schedules.map((s) => [key(s.versionId), s]));
  if (
    plans.size !== c.sourcePlans.length ||
    blueprints.size !== c.blueprints.length ||
    schedules.size !== c.schedules.length ||
    new Set(c.routines.map((r) => key(r.aggregateId))).size !== c.routines.length ||
    new Set(c.affectedRoutineIds.map(key)).size !== c.affectedRoutineIds.length
  )
    fail('', 'source_identity_mismatch');
  const routinesById = new Map(c.routines.map((r) => [key(r.aggregateId), r]));
  const usedPlans = new Set<string>(),
    usedBlueprints = new Set<string>();
  const current = c.currentTraining?.snapshot ?? null;
  if (current) {
    const stored = plans.get(key(current.id));
    if (!stored || digest(stored) !== digest(current))
      fail('currentTraining', 'source_identity_mismatch');
    usedPlans.add(key(current.id));
  }
  let calendar: ReturnType<typeof projectRacePlanImpact> | null = null;
  const intent = c.calendarIntent;
  if (intent) {
    if (intent.athleteId !== c.athleteId) fail('calendarIntent', 'foreign_source');
    calendar = projectRacePlanImpact({
      event: { localDate: intent.event.localDate, planVersionId: intent.event.planVersionId },
      newLocalDate: intent.newLocalDate,
      currentPlan: current,
      completionReports: intent.completionReports,
      selection: intent.selection,
    });
    if (calendar.status === 'rejected') fail('calendarIntent', 'calendar_projection_rejected');
  } else if (c.affectedRoutineIds.length || c.routines.some((r) => r.affected))
    fail('calendarIntent', 'affected_selection_port_missing');
  const periods = new Set(
    calendar?.status === 'projected'
      ? calendar.periodDiffs
          .filter(
            (p) =>
              p.before.startDate !== p.after.startDate ||
              p.before.endDateExclusive !== p.after.endDateExclusive,
          )
          .map((p) => p.id)
      : [],
  );
  const sessions = new Set(
    calendar?.status === 'projected'
      ? calendar.sessionDiffs.filter((s) => s.beforeDate !== s.afterDate).map((s) => s.id)
      : [],
  );
  let generatedOccurrences = 0;
  for (const s of c.schedules) {
    const path = `schedules.${s.versionId}`;
    if (!same(s.scheduleId, s.record.id) || !same(s.versionId, s.record.versionId))
      fail(path, 'source_identity_mismatch');
    const blueprintKey = tuple(s.record.blueprint.id, s.record.blueprint.versionId);
    if (!blueprints.has(blueprintKey)) fail(path, 'blueprint_missing');
    usedBlueprints.add(blueprintKey);
    const plan =
      s.sourcePlanVersionId === null ? null : (plans.get(key(s.sourcePlanVersionId)) ?? null);
    if (s.sourcePlanVersionId !== null) usedPlans.add(key(s.sourcePlanVersionId));
    if (
      (s.sourcePlanVersionId !== null ||
        s.record.rule.kind === 'period_days' ||
        s.record.rule.kind === 'session_links') &&
      !plan
    )
      fail(path, 'source_plan_missing');
    if (plan && plan.draft.timezone !== s.record.window.timezone)
      fail(path, 'source_timezone_mismatch');
    const rule = s.record.rule;
    if (
      plan &&
      ((rule.kind === 'period_days' && !plan.draft.periods.some((p) => p.id === rule.periodId)) ||
        (rule.kind === 'session_links' &&
          rule.sessionIds.some((id) => !plan.draft.sessions.some((p) => p.id === id))))
    )
      fail(path, 'source_membership_mismatch');
    const routine = routinesById.get(key(s.scheduleId));
    const isCurrent =
      s.currentHead.state === 'present' && same(s.currentHead.versionId, s.versionId);
    if (
      s.currentHead.state === 'present' &&
      (!routine || !same(routine.versionId, s.currentHead.versionId))
    )
      fail(path, 'source_identity_mismatch');
    if (isCurrent && (!routine || !same(routine.versionId, s.versionId)))
      fail(path, 'source_identity_mismatch');
    if (!isCurrent && routine && same(routine.versionId, s.versionId))
      fail(path, 'source_identity_mismatch');
    const affected =
      isCurrent &&
      plan !== null &&
      current !== null &&
      same(plan.id, current.id) &&
      ((rule.kind === 'period_days' && periods.has(rule.periodId)) ||
        (rule.kind === 'session_links' && rule.sessionIds.some((id) => sessions.has(id))));
    if (affected) affectedRoutineIds.push(s.scheduleId);
    const before = expand(s.record, plan?.draft ?? null);
    const after =
      affected && s.record.state !== 'ended' && calendar?.status === 'projected'
        ? expand(s.record, calendar.plan)
        : null;
    const unresolved = (e: Expansion) =>
      e.state === 'unresolved' || e.occurrences.some((o) => o.timingStatus === 'unresolved');
    const generated =
      (before.state === 'expanded' ? before.occurrences.length : 0) +
      (after?.state === 'expanded' ? after.occurrences.length : 0);
    generatedOccurrences += generated;
    if (generatedOccurrences > 5000) {
      fail('timings', 'projection_limit');
      timings.length = 0;
      return result();
    }
    timings.push({
      scheduleVersionId: s.versionId,
      before,
      after,
      notice: affected
        ? unresolved(before) || (after !== null && unresolved(after))
          ? 'affected_unresolved_requires_resolution'
          : s.record.state === 'ended'
            ? 'ended_schedule_preserved'
            : null
        : unresolved(before)
          ? 'existing_unresolved_preserved'
          : null,
    });
  }
  for (const r of c.routines) {
    const s = schedules.get(key(r.versionId));
    const relation =
      r.sourceVersionId === null
        ? 'absent'
        : current && same(r.sourceVersionId, current.id)
          ? 'current'
          : 'historical';
    if (
      !s ||
      !same(s.scheduleId, r.aggregateId) ||
      digest(s.record) !== digest(r.record) ||
      (s.sourcePlanVersionId === null
        ? r.sourceVersionId !== null
        : r.sourceVersionId === null || !same(s.sourcePlanVersionId, r.sourceVersionId))
    )
      fail(`routines.${r.aggregateId}`, 'source_identity_mismatch');
    if (r.sourceRelation !== relation)
      fail(`routines.${r.aggregateId}`, 'source_relation_mismatch');
    if (intent && r.affected !== affectedRoutineIds.some((id) => same(id, r.aggregateId)))
      fail(`routines.${r.aggregateId}`, 'affected_roster_mismatch');
  }
  if (
    intent &&
    (affectedRoutineIds.length !== c.affectedRoutineIds.length ||
      c.affectedRoutineIds.some((id) => !affectedRoutineIds.some((expected) => same(id, expected))))
  )
    fail('affectedRoutineIds', 'affected_roster_mismatch');
  if (
    [...plans.keys()].some((id) => !usedPlans.has(id)) ||
    [...blueprints.keys()].some((id) => !usedBlueprints.has(id))
  )
    fail('sources', 'source_membership_mismatch');
  if (byteSize(timings) > 4 * 1024 * 1024) {
    fail('timings', 'projection_limit');
    timings.length = 0;
  }
  return result();
}
