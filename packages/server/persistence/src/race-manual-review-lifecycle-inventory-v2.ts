import { supplementarySpecSchema } from '@workout/contracts/supplementary-core';
import {
  selectRaceManualOwnedProtocolIn,
  parseRaceManualReviewFullSqlObservationV2,
  parseRaceManualReviewMultiOwnedSqlObservationV3,
} from './race-manual-review-full-owned-binding-consumer-v2.js';
import { z } from 'zod';
import type { Transaction } from './database.js';
import { raceManualReviewFullCopiedInventoryV2Schema } from './race-manual-review-full-copied-inventory-v2.js';
import {
  raceManualReviewRetainedPayloadV2Schema,
  raceManualReviewMultiOwnedRetainedPayloadV3Schema,
} from './race-manual-review-retained-payload-v2.js';
import {
  impactDependencyDigest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';

const identity = raceManualReviewFullCopiedInventoryV2Schema.out.shape.refs.element.shape.identity;
type Identity = z.infer<typeof identity>;
const family = z.enum([
  'race-event',
  'plan-snapshot',
  'nutrition-plan',
  'routine-schedule',
  'routine-blueprint',
  'routine-occurrence',
  'routine-run',
  'session-completion',
  'food-definition',
  'recovery-strategy',
  'recovery-method',
  'workout-template',
  'supplementary-exercise',
  'resource',
  'activity',
  'intake',
  'intake-origin',
  'checkin',
  'checklist-confirmation',
  'course',
  'activity-track',
  'gallery-media',
]);
const key = z.string().min(1);
const uuidFamilies = new Set<z.infer<typeof family>>([
  'race-event',
  'plan-snapshot',
  'nutrition-plan',
  'routine-schedule',
  'routine-blueprint',
  'routine-occurrence',
  'recovery-strategy',
  'recovery-method',
  'workout-template',
  'supplementary-exercise',
  'resource',
  'activity',
  'intake-origin',
  'checkin',
  'course',
  'activity-track',
  'gallery-media',
]);
export const raceManualReviewLifecycleEdgeV2Schema = z
  .strictObject({
    family,
    sourceId: key,
    versionKey: key.nullable(),
    membershipKey: z.array(z.string().min(1)).min(2).max(3).nullable(),
    role: z.enum(['source', 'parent', 'lineage', 'target', 'pin_parent', 'origin']),
  })
  .superRefine((v, ctx) => {
    if (
      uuidFamilies.has(v.family) &&
      (!z.uuid().safeParse(v.sourceId).success || v.sourceId !== v.sourceId.toLowerCase())
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid lifecycle UUID parent' });
  });
type Edge = z.infer<typeof raceManualReviewLifecycleEdgeV2Schema>;
const limits = {
  originalEventAuthentication: 'unverified_original_event',
  sourceAuthentication: 'unverified',
  authority: 'none',
  freshness: 'not_checked',
  storage: 'not_persisted',
  admissionAllowed: false,
  approvalAllowed: false,
  appWithdrawal: 'retained_read_allowed',
  catalogWithdrawal: 'not_source_deletion',
  correction: 'not_source_deletion',
} as const;
const blocker = z.enum([
  'retained_payload_blocked',
  'purged_payload',
  'owned_parent_unavailable',
  'historical_parent_association_unavailable',
  'parent_membership_mismatch',
  'lifecycle_family_unavailable',
]);
export const raceManualReviewLifecycleInventoryV2Schema = z.strictObject({
  retainedState: z.enum(['present', 'purged']),
  retainedReason: z
    .enum([
      'inventory_incomplete',
      'inventory_mismatch',
      'copied_body_mismatch',
      'dto_observation_mismatch',
      'source_unavailable',
      'sql_observation_mismatch',
      'external_source_witness_required',
    ])
    .nullable(),
  coverage: raceManualReviewFullCopiedInventoryV2Schema.out.shape.candidateCoverage.nullable(),
  inventoryVersion: z.literal(2),
  status: z.enum(['dependency_correspondence', 'blocked']),
  athleteId: key,
  facts: z
    .array(
      z.strictObject({
        identity,
        edges: z.array(raceManualReviewLifecycleEdgeV2Schema).max(5000),
        state: z.enum(['bound', 'unavailable']),
        reason: blocker.nullable(),
      }),
    )
    .max(5000),
  originalEventAuthentication: z.literal(limits.originalEventAuthentication),
  sourceAuthentication: z.literal(limits.sourceAuthentication),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
  storage: z.literal('not_persisted'),
  admissionAllowed: z.literal(false),
  approvalAllowed: z.literal(false),
  appWithdrawal: z.literal(limits.appWithdrawal),
  catalogWithdrawal: z.literal(limits.catalogWithdrawal),
  correction: z.literal(limits.correction),
});
/** Static source parents only. This is not a deletion-event authorization interface. */
function edge(
  f: Edge['family'],
  sourceId: string,
  versionKey: string | null = null,
  role: Edge['role'] = 'source',
): Edge {
  return { family: f, sourceId, versionKey, role, membershipKey: null };
}
function primary(i: Identity): Edge {
  switch (i.kind) {
    case 'race-event':
      return edge('race-event', i.sourceId, String(i.revision));
    case 'plan-snapshot':
      return edge('plan-snapshot', i.sourceId, String(i.version));
    case 'nutrition-plan-version':
      return edge('nutrition-plan', i.sourceId, i.versionId);
    case 'routine-schedule-version':
      return edge('routine-schedule', i.sourceId, i.versionId);
    case 'routine-blueprint-version':
      return edge('routine-blueprint', i.sourceId, i.versionId);
    case 'routine-occurrence':
      return edge('routine-occurrence', i.sourceId);
    case 'routine-run':
      return edge('routine-run', i.sourceId, String(i.revision));
    case 'session-completion':
      return edge('session-completion', i.sourceId, JSON.stringify([i.planVersionId, i.revision]));
    case 'food-definition-version':
      return edge('food-definition', i.sourceId, i.versionId);
    case 'recovery-strategy-version':
      return edge('recovery-strategy', i.sourceId, i.versionId);
    case 'recovery-method-version':
      return edge('recovery-method', i.sourceId, i.versionId);
    case 'workout-template-version':
      return edge('workout-template', i.sourceId, i.versionId);
    case 'supplementary-exercise-version':
      return edge('supplementary-exercise', i.sourceId, i.versionId);
    case 'resource-text-version':
      return edge('resource', i.sourceId, i.versionId);
    case 'supplementary-session-copy':
      return edge('plan-snapshot', i.sourceId, null, 'parent');
    case 'manual-activity-source':
      return edge(
        'activity',
        i.sourceId,
        JSON.stringify(['manual', i.sourceRecordId, i.sourceRevision]),
      );
    case 'activity-overlay':
    case 'activity-canonical-values':
      return edge('activity', i.sourceId, String(i.revision));
    case 'intake-revision':
      return edge('intake', i.sourceId, i.revisionId);
    case 'checkin-revision':
      return edge('checkin', i.sourceId, String(i.revision));
    case 'checklist-confirmation':
      return edge('checklist-confirmation', i.sourceId, i.revisionId);
    case 'course-revision':
      return edge('course', i.sourceId, JSON.stringify([i.revisionId, i.revision]));
    case 'activity-track-descriptor':
      return edge('activity-track', i.sourceId, JSON.stringify([i.trackId, i.revision]));
    case 'race-timing-pin-fragment':
      return edge('race-event', i.sourceId, String(i.revision));
    case 'course-head-descriptor':
      return edge('course', i.sourceId, String(i.revision));
    case 'gallery-descriptor':
      return edge('gallery-media', i.sourceId, String(i.accessRevision));
    case 'routine-timer':
      return edge('routine-run', i.sourceId, JSON.stringify([i.stepId, i.revision]), 'parent');
  }
}
function assertPlain(raw: unknown): void {
  const active = new WeakSet<object>();
  let visits = 0;
  function walk(v: unknown, depth: number): void {
    if (++visits > 4194305 || depth > 64) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return;
    if (typeof v !== 'object' || active.has(v) || Object.getOwnPropertySymbols(v).length)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    active.add(v);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && k === 'length') continue;
      if (!d.enumerable || !('value' in d)) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      walk(d.value, depth + 1);
    }
    active.delete(v);
  }
  walk(raw, 0);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
}
/** Finite typed planning, not evidence that any parent exists or was deleted. */
export function planRaceManualReviewLifecycleParentsV2(unknownRefs: unknown) {
  assertPlain(unknownRefs);
  const refs = z.array(identity).max(5000).parse(unknownRefs);
  const bytes = Buffer.byteLength(JSON.stringify(refs), 'utf8');
  if (bytes > 4194304) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  if (new Set(refs.map(impactDependencyDigest)).size !== refs.length)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return refs.map((i) => ({ identity: i, edge: primary(i), ...limits }));
}
// Identifiers below are source-controlled literals, never selected from a caller string.
const sourceDefinitions = {
  'race-event': [
    'race_event',
    "id::text=$2->>'sourceId' AND revision=($2->>'revision')::int AND NOT deleted",
  ],
  'plan-snapshot': ['plan_snapshot', "id::text=$2->>'sourceId' AND version=($2->>'version')::int"],
  'nutrition-plan-version': [
    'nutrition_plan_version',
    "plan_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'routine-schedule-version': [
    'routine_schedule_version',
    "schedule_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'routine-blueprint-version': [
    'routine_blueprint_version',
    "routine_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'routine-occurrence': ['routine_occurrence', "id::text=$2->>'sourceId'"],
  'routine-run': [
    'routine_run_revision',
    "run_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int",
  ],
  'session-completion': [
    'session_completion_revision',
    "session_id=$2->>'sourceId' AND revision=($2->>'revision')::int AND record_json->>'planVersionId'=$2->>'planVersionId'",
  ],
  'food-definition-version': [
    'food_definition_version',
    "food_id=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'recovery-strategy-version': [
    'recovery_strategy_version',
    "strategy_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'recovery-method-version': [
    'recovery_method_version',
    "method_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'workout-template-version': [
    'supplementary_routine_version',
    "routine_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'supplementary-exercise-version': [
    'supplementary_exercise_version',
    "exercise_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'",
  ],
  'resource-text-version': [
    'resource_version',
    "resource_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId' AND EXISTS(SELECT 1 FROM public.resource p WHERE p.athlete_id=resource_version.athlete_id AND p.id=resource_version.resource_id AND p.deleted_at IS NULL)",
  ],
  'supplementary-session-copy': [
    'supplementary_session_link',
    "plan_version_id::text=$2->>'sourceId' AND planned_session_id=$2->>'sessionId'",
  ],
  'manual-activity-source': [
    'activity_source_revision',
    "kind='manual' AND source_id=$2->>'sourceRecordId' AND source_revision=($2->>'sourceRevision')::int AND EXISTS(SELECT 1 FROM public.activity_source_head h WHERE h.athlete_id=activity_source_revision.athlete_id AND h.kind='manual' AND h.source_id=activity_source_revision.source_id AND h.source_revision=activity_source_revision.source_revision AND h.activity_id::text=$2->>'sourceId' AND EXISTS(SELECT 1 FROM public.activity_canonical a WHERE a.athlete_id=h.athlete_id AND a.id=h.activity_id AND NOT a.deleted) AND NOT EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=h.athlete_id AND z.kind=h.kind AND z.source_id=h.source_id))",
  ],
  'activity-overlay': [
    'activity_overlay_revision',
    "activity_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int",
  ],
  'activity-canonical-values': [
    'activity_canonical',
    "id::text=$2->>'sourceId' AND revision=($2->>'revision')::int AND NOT deleted",
  ],
  'intake-revision': [
    'intake_entry_revision',
    "intake_id=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND EXISTS(SELECT 1 FROM public.intake_entry h WHERE h.athlete_id=intake_entry_revision.athlete_id AND h.id=intake_entry_revision.intake_id AND h.status='active')",
  ],
  'checkin-revision': [
    'check_in_revision',
    "check_in_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int",
  ],
  'checklist-confirmation': [
    'routine_checklist_confirmation',
    "id::text=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND run_id::text=$2->>'runId' AND step_id=$2->>'stepId'",
  ],
  'course-revision': [
    'course_revision',
    "course_id::text=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND course_revision=($2->>'revision')::int",
  ],
  'activity-track-descriptor': [
    'activity_track_revision',
    "activity_id::text=$2->>'sourceId' AND track_id::text=$2->>'trackId' AND track_revision=($2->>'revision')::int",
  ],
  'course-head-descriptor': [
    'course',
    "course_id::text=$2->>'sourceId' AND head_revision=($2->>'revision')::int",
  ],
  'gallery-descriptor': [
    'gallery_media_item',
    "id::text=$2->>'sourceId' AND access_revision=($2->>'accessRevision')::int AND deleted_at IS NULL",
  ],
  'routine-timer': [
    'routine_step_timer',
    "run_id::text=$2->>'sourceId' AND step_id=$2->>'stepId' AND revision=($2->>'revision')::int",
  ],
} as const;
function parentsSql(i: Identity): string {
  if (i.kind === 'race-timing-pin-fragment')
    return `SELECT 'nutrition-plan'::text AS family, n.plan_id::text AS "sourceId", n.version_id::text AS "versionKey", 'pin_parent'::text AS role,NULL::jsonb AS "membershipKey" FROM public.nutrition_plan_version n WHERE n.athlete_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb) ref WHERE ref->>'kind'='nutrition-plan-version' AND ref->>'sourceId'=n.plan_id::text AND ref->>'versionId'=n.version_id::text) AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(n.record_json->'raceTimingPins','[]'::jsonb)) pin WHERE pin->>'eventId'=$2->>'sourceId' AND pin->>'eventRevision'=$2->>'revision' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(n.record_json->'itemRaceTimingBindings','[]'::jsonb)) b WHERE b->'binding'->>'state'='captured' AND b->'binding'->>'eventId'=pin->>'eventId' AND b->'binding'->>'eventRevision'=pin->>'eventRevision'))`;
  const [table, where] = sourceDefinitions[i.kind];
  let sql = `SELECT $4::jsonb->>'family' AS family,$4::jsonb->>'sourceId' AS "sourceId",$4::jsonb->>'versionKey' AS "versionKey",$4::jsonb->>'role' AS role,NULL::jsonb AS "membershipKey" FROM public.${table} WHERE athlete_id=$1 AND ${where}`;
  if (i.kind === 'intake-revision')
    sql += ` UNION ALL SELECT 'intake-origin',r.revision_id::text,NULL,'origin',NULL::jsonb FROM public.intake_entry_revision r JOIN public.intake_entry h ON h.athlete_id=r.athlete_id AND h.id=r.intake_id WHERE r.athlete_id=$1 AND r.intake_id=$2->>'sourceId' AND r.revision=1 AND r.status='active' AND h.status='active' AND EXISTS(SELECT 1 FROM public.intake_entry_revision requested WHERE requested.athlete_id=r.athlete_id AND requested.intake_id=r.intake_id AND requested.revision_id::text=$2->>'revisionId')`;
  if (i.kind === 'course-revision' || i.kind === 'course-head-descriptor')
    sql += ` UNION ALL SELECT 'activity',s.activity_id::text,NULL,'lineage',NULL::jsonb FROM public.course_revision_source s WHERE s.athlete_id=$1 AND s.course_id::text=$2->>'sourceId' AND s.course_revision=($2->>'revision')::int UNION ALL SELECT 'activity-track',s.activity_id::text,('[' || to_jsonb(s.track_id)::text || ',' || s.track_revision::text || ']'),'lineage',NULL::jsonb FROM public.course_revision_source s WHERE s.athlete_id=$1 AND s.course_id::text=$2->>'sourceId' AND s.course_revision=($2->>'revision')::int`;
  if (i.kind === 'workout-template-version')
    sql += ` UNION ALL SELECT 'supplementary-exercise',e.exercise_id::text,e.version_id::text,'target',jsonb_build_array(t.routine_version_id,t.target_set_id) FROM public.supplementary_routine_target_ref t JOIN public.supplementary_exercise_version e ON e.athlete_id=t.athlete_id AND e.version_id=t.exercise_version_id WHERE t.athlete_id=$1 AND t.routine_version_id::text=$2->>'versionId'`;
  if (i.kind === 'supplementary-session-copy')
    sql += ` UNION ALL SELECT 'supplementary-exercise',e.exercise_id::text,e.version_id::text,'target',jsonb_build_array(t.plan_version_id,t.planned_session_id,t.target_set_id) FROM public.supplementary_session_target_ref t JOIN public.supplementary_exercise_version e ON e.athlete_id=t.athlete_id AND e.version_id=t.exercise_version_id WHERE t.athlete_id=$1 AND t.plan_version_id::text=$2->>'sourceId' AND t.planned_session_id=$2->>'sessionId'`;
  if (i.kind === 'session-completion')
    sql += ` UNION ALL SELECT 'plan-snapshot',p.id::text,p.version::text,'parent',NULL::jsonb FROM public.plan_snapshot p WHERE p.athlete_id=$1 AND p.id::text=$2->>'planVersionId' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.draft->'sessions') s WHERE s->>'id'=$2->>'sourceId')`;
  if (i.kind === 'checklist-confirmation')
    sql += ` UNION ALL SELECT 'routine-run',r.id::text,NULL,'parent',NULL::jsonb FROM public.routine_run r WHERE r.athlete_id=$1 AND r.id::text=$2->>'runId'`;
  if (i.kind === 'activity-track-descriptor')
    sql += ` UNION ALL SELECT 'activity',a.id::text,NULL,'parent',NULL::jsonb FROM public.activity_canonical a WHERE a.athlete_id=$1 AND a.id::text=$2->>'sourceId'`;
  return sql;
}
function stableEdges(edges: Edge[]): Edge[] {
  return [...new Map(edges.map((e) => [impactDependencyDigest(e), e])).values()].sort((a, b) => {
    const x = JSON.stringify(a),
      y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
/** Exact target membership only; does not authenticate source rows/events. */
export function validateRaceManualReviewLifecycleTargetMembershipV2(
  unknownIdentity: unknown,
  unknownSpec: unknown,
  unknownEdges: unknown,
  unknownSourceRefs: unknown,
): boolean {
  try {
    assertPlain({ unknownIdentity, unknownSpec, unknownEdges, unknownSourceRefs });
    const i = identity.parse(unknownIdentity);
    if (i.kind !== 'workout-template-version' && i.kind !== 'supplementary-session-copy')
      return false;
    const spec = supplementarySpecSchema.parse(unknownSpec),
      refs = z.array(identity).max(5000).parse(unknownSourceRefs),
      actual = z.array(raceManualReviewLifecycleEdgeV2Schema).max(5000).parse(unknownEdges);
    const expected: Edge[] = [];
    for (const block of spec.blocks)
      for (const target of block.sets) {
        const exercise = refs.find(
          (r) =>
            r.kind === 'supplementary-exercise-version' &&
            r.versionId === target.exerciseVersionId.toLowerCase(),
        );
        if (!exercise || exercise.kind !== 'supplementary-exercise-version') return false;
        expected.push({
          ...edge('supplementary-exercise', exercise.sourceId, exercise.versionId, 'target'),
          membershipKey:
            i.kind === 'workout-template-version'
              ? [i.versionId, target.id]
              : [i.sourceId, i.sessionId, target.id],
        });
      }
    if (actual.length !== expected.length) return false;
    return (
      impactDependencyDigest(stableEdges(actual)) === impactDependencyDigest(stableEdges(expected))
    );
  } catch {
    return false;
  }
}
/** Caller-owned fenced snapshot transaction; only minimal parent metadata is transferred.
 * Current rows/JSON/digests cannot authenticate deletion events or grant storage. */
export async function captureRaceManualReviewLifecycleInventoryV2In(
  tx: Transaction,
  unknownRetainedPayload: unknown,
  budget: SourceBudget,
) {
  return captureLifecycleInventory(tx, unknownRetainedPayload, budget, 'single_race_v2');
}
export async function captureRaceManualReviewMultiOwnedLifecycleInventoryV3In(
  tx: Transaction,
  unknownRetainedPayload: unknown,
  budget: SourceBudget,
) {
  return captureLifecycleInventory(tx, unknownRetainedPayload, budget, 'multi_owned_races_v3');
}
/** Actual finite SQL capability chooses the profile, never caller payload/GUC. */
export async function captureRaceManualReviewCompatibleLifecycleInventoryIn(
  tx: Transaction,
  unknownRetainedPayload: unknown,
  budget: SourceBudget,
) {
  const observer = await selectRaceManualOwnedProtocolIn(tx, budget, 'observer');
  return observer === 'public.observe_manual_review_multi_owned_source_bindings_v3'
    ? captureRaceManualReviewMultiOwnedLifecycleInventoryV3In(tx, unknownRetainedPayload, budget)
    : captureRaceManualReviewLifecycleInventoryV2In(tx, unknownRetainedPayload, budget);
}
async function captureLifecycleInventory(
  tx: Transaction,
  unknownRetainedPayload: unknown,
  budget: SourceBudget,
  profile: 'single_race_v2' | 'multi_owned_races_v3',
) {
  const retainedSchema =
    profile === 'single_race_v2'
      ? raceManualReviewRetainedPayloadV2Schema
      : raceManualReviewMultiOwnedRetainedPayloadV3Schema;
  const parseObservation =
    profile === 'single_race_v2'
      ? parseRaceManualReviewFullSqlObservationV2
      : parseRaceManualReviewMultiOwnedSqlObservationV3;
  const retained = retainedSchema.parse(unknownRetainedPayload);
  if (retained.minimalAudit.athleteId !== tx.athleteId)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const anchor = z
    .strictObject({ athleteId: z.string(), isolation: z.enum(['repeatable read', 'serializable']) })
    .parse(
      (
        await tx.query(
          "SELECT current_setting('app.athlete_id') AS \"athleteId\", current_setting('transaction_isolation') AS isolation",
        )
      ).rows[0],
    );
  if (anchor.athleteId !== tx.athleteId) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (retained.state === 'purged')
    return raceManualReviewLifecycleInventoryV2Schema.parse({
      retainedState: retained.state,
      retainedReason: retained.reason,
      coverage: null,
      inventoryVersion: 2,
      status: 'blocked',
      athleteId: tx.athleteId,
      facts: [],
      ...limits,
    });
  const refs = retained.payload.inventory.refs;
  const refsJson = JSON.stringify(refs.map((r) => r.identity));
  reserveSourceBudget(
    budget,
    BigInt(Buffer.byteLength(refsJson, 'utf8')),
    refs.reduce((n, r) => n + r.copiedLocations.length, 0),
  );
  const observed = retained.payload.sqlObservations;
  // Structural observation is expected correspondence, never source authentication.
  const parsedObservation = parseObservation(
    observed,
    refs.map((r) => r.identity),
  );
  if (parsedObservation.status !== 'validated_structure')
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const facts: z.infer<typeof raceManualReviewLifecycleInventoryV2Schema>['facts'] = [];
  const observations = new Map(
    parsedObservation.observation.rows.map((r) => [impactDependencyDigest(r.identity), r]),
  );
  for (const ref of refs) {
    const i = ref.identity,
      expected = primary(i),
      q = parentsSql(i),
      values = [tx.athleteId, JSON.stringify(i), refsJson, JSON.stringify(expected)];
    const scalar = z
      .strictObject({ count: z.string().regex(/^\d+$/), bytes: z.string().regex(/^\d+$/) })
      .parse(
        (
          await tx.query(
            `WITH input AS (SELECT $2::jsonb,$3::jsonb,$4::jsonb), parents AS (${q}) SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(parents)::text)),0)::text AS bytes FROM parents`,
            values,
          )
        ).rows[0],
      );
    if (BigInt(scalar.count) > 5000n)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
    reserveSourceBudget(budget, BigInt(scalar.bytes) + 256n, Number(scalar.count));
    const rows = z
      .array(raceManualReviewLifecycleEdgeV2Schema)
      .max(5000)
      .parse(
        (
          await tx.query(
            `WITH input AS (SELECT $2::jsonb,$3::jsonb,$4::jsonb), parents AS (${q}) SELECT * FROM parents ORDER BY family COLLATE "C","sourceId" COLLATE "C","versionKey" COLLATE "C" NULLS FIRST,role COLLATE "C" LIMIT 5001`,
            values,
          )
        ).rows,
      );
    if (rows.length !== Number(scalar.count))
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    let reason: z.infer<typeof blocker> | null =
      retained.status === 'blocked' ? 'retained_payload_blocked' : null;
    if (
      rows.length === 0 ||
      (i.kind !== 'race-timing-pin-fragment' &&
        !rows.some((e) => impactDependencyDigest(e) === impactDependencyDigest(expected)))
    )
      reason = 'owned_parent_unavailable';
    const prior = observations.get(impactDependencyDigest(i));
    if (!prior) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (i.kind === 'race-timing-pin-fragment') {
      const expectedParents = prior.relations
        .filter((r) => r.role === 'pin_membership')
        .map((r) => JSON.stringify(r.key))
        .sort();
      const actualParents = rows.map((r) => JSON.stringify([r.sourceId, r.versionKey])).sort();
      if (impactDependencyDigest(expectedParents) !== impactDependencyDigest(actualParents))
        reason = 'parent_membership_mismatch';
    }
    if (i.kind === 'course-revision') {
      const expectedLineage = prior.relations
        .filter((r) => r.role === 'lineage')
        .flatMap((r) => {
          const activity = r.key[2],
            track = r.key[3],
            revision = r.key[4];
          if (
            typeof activity !== 'string' ||
            typeof track !== 'string' ||
            typeof revision !== 'number'
          )
            throw new RaceImpactDependencyError('INVALID_CONTEXT');
          return [
            edge('activity', activity, null, 'lineage'),
            edge('activity-track', activity, JSON.stringify([track, revision]), 'lineage'),
          ];
        });
      if (
        impactDependencyDigest(stableEdges(expectedLineage)) !==
        impactDependencyDigest(stableEdges(rows.filter((e) => e.role === 'lineage')))
      )
        reason = 'parent_membership_mismatch';
    }
    if (i.kind === 'workout-template-version' || i.kind === 'supplementary-session-copy') {
      const c = retained.payload.preparation.context;
      let spec: unknown;
      if (i.kind === 'workout-template-version')
        spec = c.workoutTemplateSources?.templates.find(
          (t) => t.routineId === i.sourceId && t.versionId === i.versionId,
        )?.spec;
      else {
        const copy = c.supplementaryManifest.copies.find(
          (t) => t.link.planVersionId === i.sourceId && t.link.plannedSessionId === i.sessionId,
        );
        if (copy?.link.content.kind === 'embedded') spec = copy.link.content.spec;
      }
      if (
        !spec ||
        !validateRaceManualReviewLifecycleTargetMembershipV2(
          i,
          spec,
          rows.filter((e) => e.role === 'target'),
          refs.map((r) => r.identity),
        )
      )
        reason = 'parent_membership_mismatch';
      const targetKeys = prior.relations.filter((r) => r.role === 'target').map((r) => r.key);
      if (
        impactDependencyDigest(targetKeys.map(impactDependencyDigest).sort()) !==
        impactDependencyDigest(
          rows
            .filter((e) => e.role === 'target')
            .map((e) => impactDependencyDigest(e.membershipKey))
            .sort(),
        )
      )
        reason = 'parent_membership_mismatch';
    }
    if (i.kind === 'intake-revision' && !rows.some((e) => e.role === 'origin'))
      reason = 'historical_parent_association_unavailable';
    if (i.kind === 'session-completion' && !rows.some((e) => e.role === 'parent'))
      reason = 'historical_parent_association_unavailable';
    if (i.kind === 'checklist-confirmation' && !rows.some((e) => e.role === 'parent'))
      reason = 'owned_parent_unavailable';
    const edges =
      i.kind === 'race-timing-pin-fragment' ? stableEdges([expected, ...rows]) : stableEdges(rows);
    facts.push({ identity: i, edges, state: reason === null ? 'bound' : 'unavailable', reason });
  }
  const result = {
    retainedState: retained.state,
    retainedReason: retained.reason,
    coverage: retained.payload.inventory.candidateCoverage,
    inventoryVersion: 2,
    status: facts.some((f) => f.reason !== null) ? 'blocked' : 'dependency_correspondence',
    athleteId: tx.athleteId,
    facts,
    ...limits,
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return raceManualReviewLifecycleInventoryV2Schema.parse(result);
}
