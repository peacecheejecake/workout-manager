import { z } from 'zod';
import type { Database, Transaction } from './database.js';
import { prepareRaceManualReviewCompatibleV4In } from './race-manual-review-preparation-v2.js';
import {
  enumerateRaceManualReviewFullCopiedSourcesV2,
  raceManualReviewFullCopiedInventoryV2Schema,
} from './race-manual-review-full-copied-inventory-v2.js';
import {
  captureRaceManualReviewFullOwnedSourceInventoryV2In,
  raceManualReviewFullOwnedSourceInventoryV2Schema,
} from './race-manual-review-full-owned-source-inventory-v2.js';
import { raceProjectionIntentSchema } from './race-plan-impact-projection-input.js';
import { RacePlanImpactPreviewError } from './race-plan-impact-preview.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';

const identitySchema =
  raceManualReviewFullCopiedInventoryV2Schema.out.shape.refs.element.shape.identity;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z
  .string()
  .regex(/^[0-9]+$/)
  .max(32);
const anchorSchema = z.strictObject({
  transactionId: decimal,
  callerRole: z.string().min(1).max(63),
  athleteId: z.string().min(1).max(200),
  isolation: z.enum(['repeatable read', 'serializable']),
});
const relationDefinitions = {
  'race-event': [['current_body', 'race_event']],
  'plan-snapshot': [['immutable_version', 'plan_snapshot']],
  'nutrition-plan-version': [['immutable_version', 'nutrition_plan_version']],
  'routine-schedule-version': [['immutable_version', 'routine_schedule_version']],
  'routine-blueprint-version': [['immutable_version', 'routine_blueprint_version']],
  'routine-occurrence': [['immutable_version', 'routine_occurrence']],
  'routine-run': [['immutable_version', 'routine_run_revision']],
  'session-completion': [['immutable_version', 'session_completion_revision']],
  'food-definition-version': [
    ['immutable_version', 'food_definition_version'],
    ['current_head', 'food_definition_head'],
  ],
  'recovery-method-version': [
    ['immutable_version', 'recovery_method_version'],
    ['current_head', 'recovery_method_head'],
  ],
  'recovery-strategy-version': [
    ['immutable_version', 'recovery_strategy_version'],
    ['current_head', 'recovery_strategy_head'],
  ],
  'supplementary-exercise-version': [
    ['immutable_version', 'supplementary_exercise_version'],
    ['current_head', 'supplementary_exercise_head'],
  ],
  'workout-template-version': [
    ['immutable_version', 'supplementary_routine_version'],
    ['target', 'supplementary_routine_target_ref'],
  ],
  'supplementary-session-copy': [
    ['source_fragment', 'supplementary_session_link'],
    ['target', 'supplementary_session_target_ref'],
  ],
  'activity-canonical-values': [
    ['current_body', 'activity_canonical'],
    ['source_head', 'activity_source_head'],
    ['suppression_observation', 'activity_suppression'],
  ],
  'manual-activity-source': [
    ['immutable_source', 'activity_source_revision'],
    ['source_head', 'activity_source_head'],
  ],
  'activity-overlay': [
    ['current_overlay', 'activity_overlay'],
    ['overlay_revision', 'activity_overlay_revision'],
  ],
  'intake-revision': [
    ['immutable_revision', 'intake_entry_revision'],
    ['current_head', 'intake_entry'],
  ],
  'checkin-revision': [
    ['immutable_revision', 'check_in_revision'],
    ['current_head', 'check_in'],
  ],
  'checklist-confirmation': [['immutable_report', 'routine_checklist_confirmation']],
  'routine-timer': [['current_timer', 'routine_step_timer']],
  'course-revision': [
    ['immutable_revision', 'course_revision'],
    ['lineage', 'course_revision_source'],
  ],
  'course-head-descriptor': [['current_head', 'course']],
  'activity-track-descriptor': [['immutable_descriptor', 'activity_track_revision']],
  'resource-text-version': [
    ['immutable_version', 'resource_version'],
    ['current_head', 'resource'],
  ],
  'race-timing-pin-fragment': [['pin_membership', 'nutrition_plan_version']],
  'gallery-descriptor': [
    ['current_descriptor', 'gallery_media_item'],
    ['preview_descriptor', 'gallery_media_derivative'],
    ['original_ledger', 'gallery_media_object'],
    ['preview_ledger', 'gallery_media_object'],
  ],
} as const satisfies Record<
  z.infer<typeof identitySchema>['kind'],
  readonly (readonly [string, string])[]
>;
const sqlRelationSchema = z.strictObject({
  role: z.string().min(1).max(64),
  relation: z.string().min(1).max(64),
  key: z
    .array(z.union([z.string().min(1), z.number().int().min(0).max(2147483647)]))
    .min(1)
    .max(5),
  hashMethod: z.literal('postgres-owned-relation-row-jsonb-utc-v2'),
  sourceRowDigest: hash,
});
const sqlFactSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(5000),
  identity: identitySchema,
  state: z.enum(['observed', 'unavailable']),
  reason: z
    .enum([
      'source_unavailable',
      'historical_observation_unavailable',
      'cleanup_observation_unavailable',
    ])
    .nullable(),
  relations: z.array(sqlRelationSchema).max(5000),
  relationGroupHashMethod: z.literal('postgres-owned-relation-group-jsonb-v2'),
  relationGroupDigest: hash.nullable(),
  cleanupHashMethod: z.literal('postgres-narrow-cleanup-observation-jsonb-v1'),
  cleanupObservationDigest: hash.nullable(),
});
const observerSchema = z.strictObject({
  bindingVersion: z.literal(2),
  scope: z.literal('prepared_full_context_relation_groups_only'),
  hashMethod: z.literal('postgres-owned-relation-row-jsonb-utc-v2'),
  sqlRefsDigest: hash,
  transactionId: decimal,
  callerRole: anchorSchema.shape.callerRole,
  athleteId: anchorSchema.shape.athleteId,
  rows: z.array(sqlFactSchema).min(1).max(5000),
  storage: z.literal('not_persisted'),
  admissionAllowed: z.literal(false),
  sourceCompleteness: z.literal('unverified'),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
type Identity = z.infer<typeof identitySchema>;
function principalKey(i: Identity): readonly (string | number)[] | null {
  switch (i.kind) {
    case 'race-event':
    case 'activity-canonical-values':
    case 'course-head-descriptor':
      return [i.sourceId, i.revision];
    case 'plan-snapshot':
      return [i.sourceId, i.version];
    case 'nutrition-plan-version':
    case 'routine-schedule-version':
    case 'routine-blueprint-version':
    case 'food-definition-version':
    case 'recovery-method-version':
    case 'recovery-strategy-version':
    case 'supplementary-exercise-version':
    case 'workout-template-version':
    case 'resource-text-version':
      return [i.sourceId, i.versionId];
    case 'routine-occurrence':
    case 'activity-overlay':
      return [i.sourceId];
    case 'routine-run':
    case 'session-completion':
    case 'checkin-revision':
      return [i.sourceId, i.revision];
    case 'supplementary-session-copy':
      return [i.sourceId, i.sessionId];
    case 'manual-activity-source':
      return ['manual', i.sourceRecordId, i.sourceRevision];
    case 'intake-revision':
      return [i.sourceId, i.revisionId];
    case 'checklist-confirmation':
      return [i.sourceId, i.revisionId, i.runId, i.stepId];
    case 'routine-timer':
      return [i.sourceId, i.stepId, i.revision];
    case 'course-revision':
      return [i.sourceId, i.revisionId, i.revision];
    case 'activity-track-descriptor':
      return [i.sourceId, i.trackId, i.revision];
    case 'gallery-descriptor':
      return [i.sourceId, i.accessRevision];
    case 'race-timing-pin-fragment':
      return null;
  }
}
function validateRelations(row: z.infer<typeof sqlFactSchema>, refs: readonly Identity[]) {
  const allowed = relationDefinitions[row.identity.kind],
    seen = new Set<string>();
  for (const r of row.relations) {
    if (!allowed.some(([role, relation]) => r.role === role && r.relation === relation)) invalid();
    const key = JSON.stringify([r.role, r.relation, r.key]);
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  const [principalRole, principalRelation] = allowed[0];
  const principals = row.relations.filter(
    (r) => r.role === principalRole && r.relation === principalRelation,
  );
  if (row.relations.length === 0) {
    if (
      row.state !== 'unavailable' ||
      row.relationGroupDigest !== null ||
      row.reason === null ||
      row.cleanupObservationDigest !== null
    )
      invalid();
    return;
  }
  if (row.relationGroupDigest === null) invalid();
  if (
    row.state === 'unavailable' &&
    (row.identity.kind !== 'gallery-descriptor' || row.reason !== 'cleanup_observation_unavailable')
  )
    invalid();
  if (
    row.state === 'observed' &&
    row.identity.kind === 'gallery-descriptor' &&
    row.cleanupObservationDigest === null
  )
    invalid();
  if (row.identity.kind === 'race-timing-pin-fragment') {
    if (
      principals.length === 0 ||
      principals.some(
        (r) =>
          !refs.some(
            (i) => i.kind === 'nutrition-plan-version' && equal(r.key, [i.sourceId, i.versionId]),
          ),
      )
    )
      invalid();
  } else if (principals.length !== 1 || !equal(principals[0]?.key, principalKey(row.identity)))
    invalid();
  if ((row.state === 'observed') !== (row.reason === null)) invalid();
  if (row.identity.kind !== 'gallery-descriptor' && row.cleanupObservationDigest !== null)
    invalid();
  for (const r of row.relations) {
    if (r.role === principalRole) continue;
    switch (r.role) {
      case 'current_head':
        if (!equal(r.key, [row.identity.sourceId])) invalid();
        break;
      case 'target':
        if (row.identity.kind === 'workout-template-version') {
          if (r.key.length !== 2 || r.key[0] !== row.identity.versionId) invalid();
        } else if (row.identity.kind === 'supplementary-session-copy') {
          if (
            r.key.length !== 3 ||
            r.key[0] !== row.identity.sourceId ||
            r.key[1] !== row.identity.sessionId
          )
            invalid();
        } else invalid();
        break;
      case 'overlay_revision':
        if (
          row.identity.kind !== 'activity-overlay' ||
          !equal(r.key, [row.identity.sourceId, row.identity.revision])
        )
          invalid();
        break;
      case 'source_head':
      case 'suppression_observation':
        if (r.key.length !== 2 || typeof r.key[0] !== 'string' || typeof r.key[1] !== 'string')
          invalid();
        if (
          row.identity.kind === 'manual-activity-source' &&
          !equal(r.key, ['manual', row.identity.sourceRecordId])
        )
          invalid();
        break;
      case 'lineage':
        if (
          row.identity.kind !== 'course-revision' ||
          r.key.length !== 5 ||
          r.key[0] !== row.identity.sourceId ||
          r.key[1] !== row.identity.revision
        )
          invalid();
        break;
      case 'preview_descriptor':
        if (
          row.identity.kind !== 'gallery-descriptor' ||
          r.key.length !== 2 ||
          r.key[0] !== row.identity.sourceId
        )
          invalid();
        break;
      case 'original_ledger':
      case 'preview_ledger':
        if (r.key.length !== 1 || !hash.safeParse(r.key[0]).success) invalid();
        break;
      default:
        invalid();
    }
  }
}
function invalid(): never {
  throw new RaceImpactDependencyError('INVALID_CONTEXT');
}
/** Guard before schema access; no accessors, sparse arrays, cycles or oversized JSON. */
function boundedPlain(value: unknown): number {
  const active = new WeakSet<object>();
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > 4194305 || depth > 64) invalid();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || active.has(v)) invalid();
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      invalid();
    if (Object.getOwnPropertySymbols(v).length) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      invalid();
    active.add(v);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) invalid();
      visit(descriptor.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > 4194304) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return size;
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  boundedPlain(raw);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) invalid();
  return parsed.data;
}
function equal(a: unknown, b: unknown): boolean {
  return impactDependencyDigest(a) === impactDependencyDigest(b);
}
const limitations = {
  budgetCoverage: 'request_source_response_reservations' as const,
  aggregatePhysicalTransfer: 'not_verified' as const,
  sourceCompleteness: 'unverified' as const,
  storage: 'not_persisted' as const,
  authority: 'none' as const,
  freshness: 'not_checked' as const,
  admissionAllowed: false as const,
  approvalAllowed: false as const,
};
const anchorSql = `SELECT txid_current()::text AS "transactionId",current_user::text AS "callerRole",current_setting('app.athlete_id',true) AS "athleteId",current_setting('transaction_isolation') AS isolation`;

/** Caller owns one fenced snapshot throughout. This reconciles transient copied
 * DTOs with independently observed SQL rows; it never seals, stores or approves. */
export async function prepareRaceManualReviewFullOwnedBindingV2In(
  tx: Transaction,
  unknownIntent: unknown,
  requestSourceBudget: SourceBudget,
) {
  if (
    requestSourceBudget.bytes < 0n ||
    !Number.isSafeInteger(requestSourceBudget.sources) ||
    requestSourceBudget.sources < 0
  )
    invalid();
  const intent = raceProjectionIntentSchema.safeParse(unknownIntent);
  if (!intent.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
  boundedPlain(intent.data);
  // Bounded diagnostic row reservation before its query; not wire/heap telemetry.
  reserveSourceBudget(requestSourceBudget, 2048n);
  const anchorRows = await tx.query(anchorSql);
  if (anchorRows.rows.length !== 1) invalid();
  const anchor = parse(anchorSchema, anchorRows.rows[0]);
  if (anchor.athleteId !== tx.athleteId) invalid();
  if (boundedPlain(anchor) > 2048) invalid();
  const preparation = await prepareRaceManualReviewCompatibleV4In(
    tx,
    intent.data,
    requestSourceBudget,
  );
  if (preparation.status === 'blocked') {
    const result = { status: 'blocked' as const, preparation, ...limitations };
    boundedPlain(result);
    return result;
  }
  // The source adapters accept exactly the captured C/S/B projection, not
  // the preparation envelope's status, consumedScope or authority metadata.
  const sourcePreparation = {
    context: preparation.context,
    sourceInput: preparation.sourceInput,
    candidate: preparation.candidate,
  };
  const inventory = raceManualReviewFullCopiedInventoryV2Schema.parse(
    enumerateRaceManualReviewFullCopiedSourcesV2(sourcePreparation),
  );
  const refs = inventory.refs.map((ref) => ref.identity);
  const owned = parse(
    raceManualReviewFullOwnedSourceInventoryV2Schema,
    await captureRaceManualReviewFullOwnedSourceInventoryV2In(
      tx,
      inventory,
      sourcePreparation,
      requestSourceBudget,
    ),
  );
  if (owned.facts.length !== refs.length) invalid();
  for (const [index, fact] of owned.facts.entries()) {
    const ref = inventory.refs[index];
    if (
      !ref ||
      !equal(fact.identity, ref.identity) ||
      fact.representation !== ref.representation ||
      (fact.state === 'matched' && fact.dtoDigest !== ref.dtoDigest)
    )
      invalid();
  }
  // SQL115 has its own 4MiB internal row preflight. This shared reservation gates
  // request/source responses, not all physical transfer or SQL internal row bytes.
  // refs are a bounded Node→DB input, not a source response. Preserve visits.
  boundedPlain(refs);
  reserveSourceBudget(requestSourceBudget, 2048n, refs.length);
  const remaining = 4194304n - requestSourceBudget.bytes;
  const observedRows = await tx.query(
    `/* manual_review_full_owned_binding_consumer_v2 */ WITH observed AS MATERIALIZED (
      SELECT public.observe_manual_review_full_owned_source_bindings_v2($1::jsonb) AS observation,
       encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex') AS "expectedRefsDigest",
       txid_current()::text AS "transactionId",current_user::text AS "callerRole",
       current_setting('app.athlete_id',true) AS "athleteId",current_setting('transaction_isolation') AS isolation
    ) , grouped AS MATERIALIZED (SELECT o.*,
       (SELECT jsonb_agg(CASE WHEN jsonb_array_length(r->'relations')=0 THEN NULL ELSE encode(sha256(convert_to((r->'relations')::text,'UTF8')),'hex') END ORDER BY ord) FROM jsonb_array_elements(observation->'rows') WITH ORDINALITY t(r,ord)) AS "groupDigests"
       ,(SELECT coalesce(bool_and((r->'relations')=(SELECT coalesce(jsonb_agg(v ORDER BY v->>'role' COLLATE "C",v->>'relation' COLLATE "C",(v->'key')::text COLLATE "C"),'[]'::jsonb) FROM jsonb_array_elements(r->'relations') v)),false) FROM jsonb_array_elements(observation->'rows') r) AS "groupsOrdered"
       FROM observed o), sized AS MATERIALIZED (SELECT o.*,octet_length(to_jsonb(o)::text)::bigint AS n FROM grouped o)
    SELECT CASE WHEN n <= $2::bigint THEN observation ELSE NULL END AS observation,
      CASE WHEN n <= $2::bigint THEN "groupDigests" ELSE NULL END AS "groupDigests",
      "expectedRefsDigest","transactionId","callerRole","athleteId",isolation,"groupsOrdered",
      n::text AS "responseBytes",(n <= $2::bigint) AS "withinBudget" FROM sized`,
    [JSON.stringify(refs), remaining.toString()],
  );
  if (observedRows.rows.length !== 1) invalid();
  const gatedSchema = anchorSchema
    .extend({
      observation: observerSchema.nullable(),
      groupDigests: z.array(hash.nullable()).max(5000).nullable(),
      groupsOrdered: z.boolean(),
      expectedRefsDigest: hash,
      responseBytes: decimal,
      withinBudget: z.boolean(),
    })
    .strict();
  const gated = parse(gatedSchema, observedRows.rows[0]);
  const responseBytes = BigInt(gated.responseBytes);
  if (!gated.withinBudget) {
    if (gated.observation !== null || gated.groupDigests !== null || responseBytes <= remaining)
      invalid();
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  }
  if (gated.observation === null || gated.groupDigests === null || responseBytes > remaining)
    invalid();
  // One reservation for the already SQL-gated encoded response; never charge
  // this payload again after decode. 2048 covers the bounded gate scalar fields.
  reserveSourceBudget(requestSourceBudget, responseBytes);
  const wire = {
    observation: gated.observation,
    expectedRefsDigest: gated.expectedRefsDigest,
    transactionId: gated.transactionId,
    callerRole: gated.callerRole,
    athleteId: gated.athleteId,
    isolation: gated.isolation,
  };
  if (BigInt(boundedPlain(wire)) > responseBytes) invalid();
  const observation = wire.observation;
  if (!gated.groupsOrdered) invalid();
  if (
    !equal(anchor, {
      transactionId: wire.transactionId,
      callerRole: wire.callerRole,
      athleteId: wire.athleteId,
      isolation: wire.isolation,
    }) ||
    observation.transactionId !== anchor.transactionId ||
    observation.callerRole !== anchor.callerRole ||
    observation.athleteId !== anchor.athleteId ||
    observation.sqlRefsDigest !== wire.expectedRefsDigest ||
    observation.rows.length !== refs.length
  )
    invalid();
  if (
    gated.groupDigests.length !== refs.length ||
    observation.rows.reduce((n, r) => n + r.relations.length, 0) > 5000
  )
    invalid();
  for (const [index, row] of observation.rows.entries()) {
    const identity = refs[index];
    if (
      !identity ||
      row.ordinal !== index + 1 ||
      !equal(row.identity, identity) ||
      row.relationGroupDigest !== gated.groupDigests[index]
    )
      invalid();
    validateRelations(row, refs);
  }

  const result = {
    status:
      preparation.status === 'prepared_readonly' &&
      inventory.inventoryState === 'mapped' &&
      inventory.allCopiedBodiesIndexed &&
      owned.status === 'observed_correspondence' &&
      observation.rows.every((row) => row.state === 'observed')
        ? ('observed_readonly' as const)
        : ('observed_blocked' as const),
    preparation,
    inventory,
    owned,
    sqlObservation: observation,
    ...limitations,
  };
  boundedPlain(result);
  return result;
}
export type RaceManualReviewFullOwnedBindingV2 = Awaited<
  ReturnType<typeof prepareRaceManualReviewFullOwnedBindingV2In>
>;

/** Snapshot capability is mandatory; a committed preview or RC fallback is invalid. */
export function createRaceManualReviewFullOwnedBindingV2Service(database: Database) {
  return {
    async prepare(
      athleteId: string,
      unknownIntent: unknown,
    ): Promise<RaceManualReviewFullOwnedBindingV2> {
      const intent = raceProjectionIntentSchema.safeParse(unknownIntent);
      if (!intent.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
      boundedPlain(intent.data);
      const snapshot = database.snapshotTenant;
      if (!snapshot) throw new RacePlanImpactPreviewError('CONTEXT_UNAVAILABLE');
      return snapshot(athleteId, (tx) =>
        prepareRaceManualReviewFullOwnedBindingV2In(tx, intent.data, { bytes: 0n, sources: 0 }),
      );
    },
  };
}
