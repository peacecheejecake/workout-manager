import { z } from 'zod';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { routineRunSchema } from '@workout/contracts/routines';
import { raceManualReviewSourceInventoryV2Schema } from './race-manual-review-source-inventory-v2.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
import type { Transaction } from './database.js';
import { captureRaceManualReviewOwnedSourceRefV2In } from './race-manual-review-owned-source-inventory-v2.js';
const coreIdentitySchema =
  raceManualReviewSourceInventoryV2Schema.out.shape.refs.element.shape.identity;
const uuid = z.uuid().transform((v) => v.toLowerCase()),
  opaque = z.string().min(1),
  rev = z.number().int().min(0).max(2147483647),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const plainGuard = z.unknown().superRefine((value, ctx) => {
  try {
    const visiting = new WeakSet<object>();
    let nodes = 0;
    function visit(v: unknown, depth: number): void {
      // A serialized JSON node needs at least one byte; the root is included.
      if (++nodes > 4194305 || depth > 64) throw Error('bound');
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw Error('number');
        return;
      }
      if (typeof v !== 'object' || visiting.has(v)) throw Error('plain');
      if (
        !Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        throw Error('plain');
      visiting.add(v);
      const properties = Object.getOwnPropertyDescriptors(v);
      if (Reflect.ownKeys(v).some((key) => typeof key !== 'string')) throw Error('symbol');
      for (const [key, descriptor] of Object.entries(properties)) {
        if (Array.isArray(v) && key === 'length') continue;
        if (descriptor.get || descriptor.set || !descriptor.enumerable) throw Error('accessor');
        visit(descriptor.value, depth + 1);
      }
      if (Array.isArray(v) && Object.keys(v).length !== v.length) throw Error('sparse');
      visiting.delete(v);
    }
    visit(value, 0);
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > 4194304) throw Error('bytes');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid or oversized plain JSON review boundary' });
  }
});
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return r.data;
}
function bytes(raw: unknown): number {
  const json = JSON.stringify(raw);
  if (json === undefined) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return Buffer.byteLength(json, 'utf8');
}
import {
  recoveryStrategyVersionSchema,
  recoveryMethodVersionSchema,
} from '@workout/contracts/recovery-core';
import {
  supplementaryExerciseVersionSchema,
  supplementarySpecSchema,
} from '@workout/contracts/supplementary-core';
import { activityValuesSchema, activityOverlaySchema } from '@workout/contracts/activity';
import { checkInValuesSchema } from '@workout/contracts/check-ins';
import {
  raceManualReviewCandidateV2BodySchema,
  raceManualReviewCandidateV2InputSchema,
  raceManualReviewCandidateV2ResultSchema,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
import {
  enumerateRaceManualReviewFullCopiedSourcesV2,
  raceManualReviewFullCopiedInventoryV2Schema,
} from './race-manual-review-full-copied-inventory-v2.js';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import { captureRaceFoodVersionSourceIn } from './race-plan-impact-nested-sources.js';
import { captureWorkoutTemplateSources } from './race-plan-impact-workout-template-sources.js';
import { captureResourceRetainedReadFacts } from './race-plan-impact-resource-read-facts.js';
import { captureMediaRetainedReadFacts } from './race-plan-impact-media-read-facts.js';
import { captureManualIntakeReadFacts } from './race-plan-impact-intake-read-facts.js';
import { captureCourseReadSources } from './race-plan-impact-course-sources.js';
import { captureRoutineTimerReads } from './race-plan-impact-routine-timers.js';

const fullRefSchema = raceManualReviewFullCopiedInventoryV2Schema.out.shape.refs.element;
type FullRef = z.infer<typeof fullRefSchema>;
type FullIdentity = FullRef['identity'];
const unavailableReasonSchema = z.enum([
  'owned_source_unavailable',
  'source_deleted',
  'source_tuple_mismatch',
  'copied_body_mismatch',
  'history_missing',
  'historical_snapshot_unavailable',
  'read_capability_unavailable',
  'relation_membership_unavailable',
  'source_fragment_not_stored',
  'inventory_incomplete',
]);
type UnavailableReason = z.infer<typeof unavailableReasonSchema>;
const fullFactSchema = z
  .strictObject({
    identity: fullRefSchema.shape.identity,
    representation: fullRefSchema.shape.representation,
    state: z.enum(['matched', 'unavailable']),
    dtoDigest: hash.nullable(),
    reason: unavailableReasonSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.state === 'matched') !== (value.dtoDigest !== null && value.reason === null) ||
      (value.state === 'unavailable' && (value.dtoDigest !== null || value.reason === null))
    )
      ctx.addIssue({ code: 'custom', message: 'Observed correspondence state mismatch' });
  });
const fullOutput = z
  .strictObject({
    scope: z.literal('prepared_full_context_copied_bodies_only'),
    status: z.enum(['observed_correspondence', 'blocked']),
    copiedInventoryComplete: z.boolean(),
    coverage: raceManualReviewCandidateV2BodySchema.out.shape.coverage,
    facts: z.array(fullFactSchema).min(1).max(5000),
    observation: z.literal('same_transaction_owned_rows'),
    sqlRowDigest: z.literal('not_captured'),
    sourceAuthentication: z.literal('unverified'),
    sourceCompleteness: z.literal('unverified'),
    lifecycleAuthority: z.literal('none'),
    permissionAuthority: z.literal('none'),
    authority: z.literal('none'),
    freshness: z.literal('not_checked'),
    storage: z.literal('not_persisted'),
    admissionAllowed: z.literal(false),
    approvalAllowed: z.literal(false),
  })
  .superRefine((v, ctx) => {
    if (
      v.status !==
      (v.copiedInventoryComplete && v.facts.every((f) => f.state === 'matched')
        ? 'observed_correspondence'
        : 'blocked')
    )
      ctx.addIssue({ code: 'custom', message: 'Observation state mismatch' });
    if (new Set(v.facts.map((f) => impactDependencyDigest(f.identity))).size !== v.facts.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate observed source' });
  });
/** Parsing this envelope does not authenticate a transaction or confer authority. */
export const raceManualReviewFullOwnedSourceInventoryV2Schema = plainGuard.pipe(fullOutput);
export type RaceManualReviewFullOwnedSourceInventoryV2 = z.infer<
  typeof raceManualReviewFullOwnedSourceInventoryV2Schema
>;
export function validateRaceManualReviewFullOwnedSourceInventoryV2(raw: unknown) {
  return raceManualReviewFullOwnedSourceInventoryV2Schema.safeParse(raw);
}
const preparationSchema = plainGuard.pipe(
  z.strictObject({
    context: raceImpactConsumedCaptureSchema,
    sourceInput: raceManualReviewCandidateV2InputSchema,
    candidate: raceManualReviewCandidateV2ResultSchema,
  }),
);
type Preparation = z.infer<typeof preparationSchema>;
type Read = { body: unknown; reason: UnavailableReason | null };
const missing = (reason: UnavailableReason = 'owned_source_unavailable'): Read => ({
  body: null,
  reason,
});
const observed = (body: unknown): Read => ({ body, reason: null });
const metadataRecord = z.strictObject({
  athlete_id: z.string(),
  metadata: z.unknown(),
  record_json: z.unknown(),
});
/** Finite static SELECTs only. No input-derived SQL identifiers, no new grants. */
async function readBounded(
  tx: Transaction,
  budget: SourceBudget,
  id: FullIdentity,
  sql: string,
  values: unknown[],
  maximum = 1048576,
) {
  const scalar = parse(
    z.strictObject({ count: decimal, bytes: decimal, maximum: decimal }),
    (
      await tx.query(
        `/* full_owned_v2 scalar ${id.kind} */ SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(q)::text)),0)::text AS bytes,coalesce(max(octet_length(to_jsonb(q)::text)),0)::text AS maximum FROM (${sql} LIMIT 2) q`,
        values,
      )
    ).rows[0],
  );
  if (BigInt(scalar.count) > 1n) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  reserveSourceBudget(budget, BigInt(scalar.bytes) + 512n);
  if (BigInt(scalar.maximum) > BigInt(maximum))
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  if (scalar.count === '0') return null;
  const rows = (await tx.query(`/* full_owned_v2 body ${id.kind} */ ${sql} LIMIT 2`, values)).rows;
  if (rows.length !== 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const row = parse(metadataRecord, rows[0]);
  if (row.athlete_id !== tx.athleteId || bytes(row) > Number(scalar.bytes) + 512)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return row;
}
async function versionRecord(
  tx: Transaction,
  budget: SourceBudget,
  id: Extract<FullIdentity, { versionId: string }>,
  table: string,
  column: string,
  schema: z.ZodType,
  bodyKey: string,
): Promise<Read> {
  // table/column are private constants selected by exhaustive caller branches.
  const row = await readBounded(
    tx,
    budget,
    id,
    `SELECT r.athlete_id,jsonb_build_object('id',r.${column},'versionId',r.version_id) AS metadata,r.record_json FROM ${table} r WHERE r.athlete_id=$1 AND r.${column}::text=$2 AND r.version_id::text=$3`,
    [tx.athleteId, id.sourceId, id.versionId],
    524800,
  );
  if (!row) return missing();
  const meta = parse(z.strictObject({ id: uuid, versionId: uuid }), row.metadata);
  const body = parse(schema, row.record_json);
  const tuple = parse(z.object({ [bodyKey]: uuid, versionId: uuid }).passthrough(), body);
  return meta.id === id.sourceId &&
    meta.versionId === id.versionId &&
    tuple[bodyKey] === id.sourceId &&
    tuple['versionId'] === id.versionId
    ? observed(body)
    : missing('source_tuple_mismatch');
}
async function readAdditional(
  tx: Transaction,
  ref: FullRef,
  p: Preparation,
  budget: SourceBudget,
): Promise<Read> {
  const id = ref.identity;
  switch (id.kind) {
    case 'food-definition-version': {
      const f = await captureRaceFoodVersionSourceIn(tx, id.versionId, budget);
      return f.content === null
        ? missing()
        : f.content.foodId === id.sourceId
          ? observed(f.content.record)
          : missing('source_tuple_mismatch');
    }
    case 'recovery-strategy-version':
      return versionRecord(
        tx,
        budget,
        id,
        'recovery_strategy_version',
        'strategy_id',
        recoveryStrategyVersionSchema,
        'strategyId',
      );
    case 'recovery-method-version':
      return versionRecord(
        tx,
        budget,
        id,
        'recovery_method_version',
        'method_id',
        recoveryMethodVersionSchema,
        'methodId',
      );
    case 'supplementary-exercise-version':
      return versionRecord(
        tx,
        budget,
        id,
        'supplementary_exercise_version',
        'exercise_id',
        supplementaryExerciseVersionSchema,
        'exerciseId',
      );
    case 'workout-template-version': {
      const f = await captureWorkoutTemplateSources(
        tx,
        [{ kind: 'workout_template', ref: { id: id.sourceId, versionId: id.versionId } }],
        budget,
      );
      const body = f.templates.find(
        (v) => v.routineId === id.sourceId && v.versionId === id.versionId,
      );
      return body ? observed(body) : missing();
    }
    case 'resource-text-version': {
      const f = (await captureResourceRetainedReadFacts(tx, [id.versionId], budget)).facts[0];
      if (!f || !f.record)
        return missing(f?.state === 'deleted' ? 'source_deleted' : 'owned_source_unavailable');
      return f.record.resourceId === id.sourceId
        ? observed(f.record)
        : missing('source_tuple_mismatch');
    }
    case 'gallery-descriptor': {
      // A false capability is detected before SQL, never catch an aborted 42501.
      reserveSourceBudget(budget, 512n);
      const capability = parse(
        z.strictObject({ available: z.boolean() }),
        (
          await tx.query(
            "SELECT has_table_privilege(current_user,'public.gallery_media_object','SELECT') AS available",
          )
        ).rows[0],
      );
      if (!capability.available) return missing('read_capability_unavailable');
      const f = (await captureMediaRetainedReadFacts(tx, [id.sourceId], budget)).facts[0];
      if (!f?.current) return missing();
      if (f.current.accessRevision !== id.accessRevision)
        return missing('historical_snapshot_unavailable');
      if (f.current.deleted) return missing('source_deleted');
      if (
        f.state !== 'owned' ||
        !f.record ||
        !f.originalLedger ||
        f.cleanup?.status !== 'available'
      )
        return missing('relation_membership_unavailable');
      return observed(f);
    }
    case 'intake-revision': {
      const f = (
        await captureManualIntakeReadFacts(
          tx,
          [{ kind: 'intake', id: id.sourceId, revisionId: id.revisionId }],
          budget,
        )
      ).facts[0];
      return f?.content
        ? observed(f.content)
        : missing(f?.state === 'deleted' ? 'source_deleted' : 'owned_source_unavailable');
    }
    case 'course-revision':
    case 'course-head-descriptor':
    case 'activity-track-descriptor': {
      const original = p.context.course;
      if (!original) return missing('relation_membership_unavailable');
      // Existing narrow deletion capability checked without failing SQL.
      reserveSourceBudget(budget, 512n);
      const capability = parse(
        z.strictObject({ available: z.boolean() }),
        (
          await tx.query(
            "SELECT coalesce(has_function_privilege(current_user,to_regprocedure('public.export_course_deletions()'),'EXECUTE'),false) AS available",
          )
        ).rows[0],
      );
      if (!capability.available) return missing('read_capability_unavailable');
      const f = await captureCourseReadSources(tx, original.ref, budget);
      if (!f) return missing();
      if (id.kind === 'course-revision')
        return f.owned?.revision?.courseId === id.sourceId &&
          f.owned.revision.revisionId === id.revisionId &&
          f.owned.revision.courseRevision === id.revision
          ? observed(f.owned.revision)
          : missing('source_tuple_mismatch');
      if (id.kind === 'course-head-descriptor')
        return f.owned?.head.status === 'available' &&
          f.owned.head.headRevision === id.revision &&
          f.owned.head.courseId === id.sourceId
          ? observed(f.owned.head)
          : missing('historical_snapshot_unavailable');
      const source = f.lineageSources?.find(
        (s) =>
          s.activity.id === id.sourceId &&
          s.track.trackId === id.trackId &&
          s.track.trackRevision === id.revision,
      );
      return source && !source.activity.deleted && source.suppression.state === 'absent'
        ? observed(source.track)
        : missing('relation_membership_unavailable');
    }
    case 'routine-timer': {
      const run = p.context.routineActualManifest.runs.find(
        (r) => r.record.id === id.sourceId,
      )?.record;
      if (!run) return missing('relation_membership_unavailable');
      const current = await captureRaceManualReviewOwnedSourceRefV2In(
        tx,
        {
          identity: { kind: 'routine-run', sourceId: run.id, revision: run.revision },
          dtoDigest: impactDependencyDigest(run),
        },
        budget,
      );
      if (current.state !== 'matched') return missing('relation_membership_unavailable');
      const reads = await captureRoutineTimerReads(tx, [run], budget);
      const timer = reads[0]?.timers.find((t) => t.runId === id.sourceId && t.stepId === id.stepId);
      return timer?.revision === id.revision
        ? observed(timer)
        : missing('historical_snapshot_unavailable');
    }
    case 'checkin-revision': {
      const row = await readBounded(
        tx,
        budget,
        id,
        `SELECT r.athlete_id,jsonb_build_object('id',r.check_in_id,'revision',r.revision,'deleted',h.deleted,'currentRevision',h.revision) AS metadata,CASE WHEN h.deleted THEN NULL ELSE r.values_json END AS record_json FROM check_in_revision r JOIN check_in h ON h.athlete_id=r.athlete_id AND h.id=r.check_in_id WHERE r.athlete_id=$1 AND r.check_in_id::text=$2 AND r.revision=$3`,
        [tx.athleteId, id.sourceId, id.revision],
        65536,
      );
      if (!row) return missing('history_missing');
      const m = parse(
        z.strictObject({ id: uuid, revision: rev, currentRevision: rev, deleted: z.boolean() }),
        row.metadata,
      );
      if (m.deleted) return missing('source_deleted');
      if (m.id !== id.sourceId || m.revision !== id.revision || m.currentRevision < id.revision)
        return missing('source_tuple_mismatch');
      return observed(parse(checkInValuesSchema, row.record_json));
    }
    case 'checklist-confirmation': {
      const row = await readBounded(
        tx,
        budget,
        id,
        `SELECT c.athlete_id,jsonb_build_object('runId',h.id,'revision',h.revision,'record',h.record_json) AS metadata,jsonb_build_object('id',c.id,'run_id',c.run_id,'step_id',c.step_id,'revision_id',c.revision_id,'occurred_at',to_char(c.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state',c.state) AS record_json FROM routine_checklist_confirmation c JOIN routine_run h ON h.athlete_id=c.athlete_id AND h.id=c.run_id WHERE c.athlete_id=$1 AND c.id::text=$2 AND c.revision_id::text=$3 AND c.run_id::text=$4 AND c.step_id=$5`,
        [tx.athleteId, id.sourceId, id.revisionId, id.runId, id.stepId],
      );
      if (!row) return missing();
      const m = parse(
        z.strictObject({ runId: uuid, revision: rev, record: routineRunSchema }),
        row.metadata,
      );
      const body = parse(
        z.strictObject({
          id: uuid,
          run_id: uuid,
          step_id: opaque,
          revision_id: uuid,
          occurred_at: z.iso.datetime(),
          state: z.enum(['performed', 'partial']),
        }),
        row.record_json,
      );
      const progress = m.record.progress.find((s) => s.stepId === id.stepId);
      return m.runId === id.runId &&
        m.record.id === id.runId &&
        m.record.revision === m.revision &&
        body.id === id.sourceId &&
        body.revision_id === id.revisionId &&
        body.run_id === id.runId &&
        body.step_id === id.stepId &&
        progress?.actualRefs.some(
          (r) =>
            r.kind === 'checklist_confirmation' &&
            r.id === id.sourceId &&
            r.revisionId === id.revisionId,
        )
        ? observed(body)
        : missing('relation_membership_unavailable');
    }
    case 'manual-activity-source':
    case 'activity-canonical-values':
    case 'activity-overlay': {
      const row = await readBounded(
        tx,
        budget,
        id,
        `SELECT c.athlete_id,jsonb_build_object('id',c.id,'revision',c.revision,'deleted',c.deleted,'kind',s.kind,'sourceId',s.source_id,'sourceRevision',s.source_revision,'sourceHash',s.content_hash,'suppressed',EXISTS(SELECT 1 FROM activity_suppression x WHERE x.athlete_id=s.athlete_id AND x.kind=s.kind AND x.source_id=s.source_id),'sourceRecord',CASE WHEN s.kind='manual' THEN v.normalized_raw ELSE NULL END,'sourceRevisionPresent',v.source_id IS NOT NULL,'overlayRevision',(SELECT max(revision) FROM activity_overlay_revision h WHERE h.athlete_id=c.athlete_id AND h.activity_id=c.id)) AS metadata,jsonb_build_object('original',c.original,'overlay',o.values_json) AS record_json FROM activity_canonical c LEFT JOIN activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id LEFT JOIN activity_source_revision v ON v.athlete_id=s.athlete_id AND v.kind=s.kind AND v.source_id=s.source_id AND v.source_revision=s.source_revision AND v.content_hash=s.content_hash LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id::text=$2`,
        [tx.athleteId, id.sourceId],
      );
      if (!row) return missing();
      const m = parse(
        z.strictObject({
          id: uuid,
          revision: rev,
          deleted: z.boolean(),
          kind: z.string().nullable(),
          sourceId: opaque.nullable(),
          sourceRevision: rev.nullable(),
          sourceHash: hash.nullable(),
          suppressed: z.boolean(),
          sourceRecord: z.unknown(),
          sourceRevisionPresent: z.boolean(),
          overlayRevision: rev.nullable(),
        }),
        row.metadata,
      );
      if (m.deleted || m.suppressed) return missing('source_deleted');
      if (m.id !== id.sourceId) return missing('source_tuple_mismatch');
      if (
        !m.sourceRevisionPresent ||
        m.kind === null ||
        m.sourceId === null ||
        m.sourceRevision === null ||
        m.sourceHash === null
      )
        return missing('relation_membership_unavailable');
      const b = parse(
        z.strictObject({
          original: activityValuesSchema,
          overlay: activityOverlaySchema.nullable(),
        }),
        row.record_json,
      );
      if (id.kind === 'activity-overlay')
        return m.revision === id.revision && m.overlayRevision === id.revision && b.overlay !== null
          ? observed(b.overlay)
          : missing('historical_snapshot_unavailable');
      if (id.kind === 'activity-canonical-values')
        return m.revision === id.revision
          ? observed(b.original)
          : missing('historical_snapshot_unavailable');
      if (
        m.kind !== 'manual' ||
        m.sourceId !== id.sourceRecordId ||
        m.sourceRevision !== id.sourceRevision ||
        m.sourceRecord === null
      )
        return missing('source_tuple_mismatch');
      const raw = parse(activityValuesSchema, m.sourceRecord);
      // Producer sourceHash uses original JSON order; do not equate it to DTO canonical hash.
      if (impactDependencyDigest(raw) !== impactDependencyDigest(b.original))
        return missing('source_tuple_mismatch');
      return observed(b.original);
    }
    case 'supplementary-session-copy': {
      const row = await readBounded(
        tx,
        budget,
        id,
        `SELECT l.athlete_id,jsonb_build_object('planId',p.id,'sessionExists',EXISTS(SELECT 1 FROM jsonb_array_elements(p.draft->'sessions') s WHERE s->>'id'=l.planned_session_id),'kind',l.content_kind) AS metadata,l.embedded_spec_json AS record_json FROM supplementary_session_link l JOIN plan_snapshot p ON p.athlete_id=l.athlete_id AND p.id=l.plan_version_id WHERE l.athlete_id=$1 AND l.plan_version_id::text=$2 AND l.planned_session_id=$3`,
        [tx.athleteId, id.sourceId, id.sessionId],
        524800,
      );
      if (!row) return missing();
      const meta = parse(
        z.strictObject({
          planId: uuid,
          sessionExists: z.boolean(),
          kind: z.enum(['embedded', 'routine_version']),
        }),
        row.metadata,
      );
      if (meta.planId !== id.sourceId || !meta.sessionExists || meta.kind !== 'embedded')
        return missing('relation_membership_unavailable');
      const body = parse(supplementarySpecSchema, row.record_json);
      const targetSql = `SELECT block_id,target_set_id,exercise_version_id FROM supplementary_session_target_ref WHERE athlete_id=$1 AND plan_version_id::text=$2 AND planned_session_id=$3`;
      const measured = parse(
        z.strictObject({ count: decimal, bytes: decimal }),
        (
          await tx.query(
            `SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(t)::text)+256),0)::text AS bytes FROM (${targetSql} LIMIT 901) t`,
            [tx.athleteId, id.sourceId, id.sessionId],
          )
        ).rows[0],
      );
      if (BigInt(measured.count) > 900n)
        throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
      reserveSourceBudget(budget, BigInt(measured.bytes) + 512n, Number(measured.count));
      const target = z.strictObject({
        block_id: opaque,
        target_set_id: opaque,
        exercise_version_id: uuid,
      });
      const targets = parse(
        z.array(target).max(900),
        (
          await tx.query(`${targetSql} ORDER BY block_id,target_set_id LIMIT 901`, [
            tx.athleteId,
            id.sourceId,
            id.sessionId,
          ])
        ).rows,
      );
      if (targets.length !== Number(measured.count))
        throw new RaceImpactDependencyError('INVALID_CONTEXT');
      const expected = body.blocks.flatMap((b) =>
        b.sets.map((t) => ({
          block_id: b.id,
          target_set_id: t.id,
          exercise_version_id: t.exerciseVersionId,
        })),
      );
      const key = (v: z.infer<typeof target>) =>
        JSON.stringify([v.block_id, v.target_set_id, v.exercise_version_id]);
      const normalize = (vs: z.infer<typeof target>[]) => vs.map(key).sort();
      return impactDependencyDigest(normalize(expected)) ===
        impactDependencyDigest(normalize(targets))
        ? observed(body)
        : missing('relation_membership_unavailable');
    }
    case 'race-timing-pin-fragment': {
      // Pin identity lacks its nutrition parent. Use the complete enumerated parent roster,
      // not current race dates, to prove an actual retained original binding.
      for (const n of [
        ...p.context.nutrition,
        ...p.sourceInput.projectionInput.nutrition,
        ...(p.context.recoveryNutritionSources?.records.map((record) => ({ record })) ?? []),
      ]) {
        const row = await readBounded(
          tx,
          budget,
          id,
          `SELECT v.athlete_id,jsonb_build_object('id',v.plan_id,'versionId',v.version_id) AS metadata,v.record_json FROM nutrition_plan_version v WHERE v.athlete_id=$1 AND v.plan_id::text=$2 AND v.version_id::text=$3`,
          [tx.athleteId, n.record.planId, n.record.versionId],
          524800,
        );
        if (!row) continue;
        const meta = parse(z.strictObject({ id: uuid, versionId: uuid }), row.metadata);
        const record = parse(nutritionPlanVersionCompatibleV4Schema, row.record_json);
        if (record.planId !== meta.id || record.versionId !== meta.versionId)
          throw new RaceImpactDependencyError('INVALID_CONTEXT');
        if ('raceTimingPins' in record) {
          const pin = record.raceTimingPins.find(
            (pin) =>
              pin.eventId === id.sourceId &&
              pin.eventRevision === id.revision &&
              impactDependencyDigest(pin) === ref.dtoDigest,
          );
          if (pin) return observed(pin);
        }
      }
      return missing('source_fragment_not_stored');
    }
    case 'race-event':
    case 'plan-snapshot':
    case 'nutrition-plan-version':
    case 'routine-schedule-version':
    case 'routine-blueprint-version':
    case 'routine-occurrence':
    case 'routine-run':
    case 'session-completion':
      return missing('owned_source_unavailable'); // Routed to private core adapter by the caller.
  }
}
/** Caller supplies an authenticated fenced snapshot. Supplied preparation JSON is
 * checked for correspondence, never accepted as ownership/permission authority. */
export async function captureRaceManualReviewFullOwnedSourceInventoryV2In(
  tx: Transaction,
  unknownInventory: unknown,
  unknownPreparation: unknown,
  budget: SourceBudget,
): Promise<RaceManualReviewFullOwnedSourceInventoryV2> {
  parse(
    z.strictObject({
      bytes: z.bigint().min(0n).max(4194304n),
      sources: z.number().int().min(0).max(5000),
    }),
    budget,
  );
  const p = parse(preparationSchema, unknownPreparation);
  if (
    p.context.athleteId !== tx.athleteId ||
    p.sourceInput.athleteId !== tx.athleteId ||
    p.candidate.status !== 'assembled_readonly'
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const inventory = parse(raceManualReviewFullCopiedInventoryV2Schema, unknownInventory);
  const recomputed = enumerateRaceManualReviewFullCopiedSourcesV2(p);
  if (impactDependencyDigest(inventory) !== impactDependencyDigest(recomputed))
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  reserveSourceBudget(
    budget,
    0n,
    inventory.refs.reduce((n, r) => n + r.copiedLocations.length, 0),
  );
  const facts: z.infer<typeof fullFactSchema>[] = [];
  for (const ref of inventory.refs) {
    const core = coreIdentitySchema.safeParse(ref.identity);
    if (core.success) {
      const result = await captureRaceManualReviewOwnedSourceRefV2In(
        tx,
        { identity: core.data, dtoDigest: ref.dtoDigest },
        budget,
      );
      if (!result) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      facts.push({
        identity: ref.identity,
        representation: ref.representation,
        state: result.state,
        dtoDigest: result.dtoDigest,
        reason: result.reason,
      });
      continue;
    }
    const read = await readAdditional(tx, ref, p, budget);
    const digest = read.reason === null ? impactDependencyDigest(read.body) : null;
    const reason = read.reason ?? (digest === ref.dtoDigest ? null : 'copied_body_mismatch');
    facts.push({
      identity: ref.identity,
      representation: ref.representation,
      state: reason === null ? 'matched' : 'unavailable',
      dtoDigest: reason === null ? digest : null,
      reason,
    });
  }
  return parse(raceManualReviewFullOwnedSourceInventoryV2Schema, {
    scope: 'prepared_full_context_copied_bodies_only',
    status:
      inventory.allCopiedBodiesIndexed && facts.every((f) => f.state === 'matched')
        ? 'observed_correspondence'
        : 'blocked',
    copiedInventoryComplete: inventory.allCopiedBodiesIndexed,
    coverage: p.candidate.body.coverage,
    facts,
    observation: 'same_transaction_owned_rows',
    sqlRowDigest: 'not_captured',
    sourceAuthentication: 'unverified',
    sourceCompleteness: 'unverified',
    lifecycleAuthority: 'none',
    permissionAuthority: 'none',
    authority: 'none',
    freshness: 'not_checked',
    storage: 'not_persisted',
    admissionAllowed: false,
    approvalAllowed: false,
  });
}
