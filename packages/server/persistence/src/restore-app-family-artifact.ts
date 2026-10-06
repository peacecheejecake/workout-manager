import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { planDraftSchema } from '@workout/contracts/planning';
import { coreEvidenceBodySchema } from '@workout/contracts/evidence-snapshots';
import {
  trainingCandidateV1Schema,
  trainingCandidateBundleV1Schema,
  trainingDecisionV1Schema,
  trainingProposalV1Schema,
} from '@workout/contracts/coaching-candidates';
import {
  coachingRunModelSourceSchema,
  coachingRunStatusSchema,
} from '@workout/contracts/coaching-runs';
import {
  trainingCoachingBasisV1Schema,
  trainingCoachingPolicySchema,
} from '@workout/contracts/coaching-basis';
import {
  integratedApprovalResultV4Schema,
  integratedCandidateV4Schema,
} from '@workout/contracts/integrated-coaching';

// Private owner restore boundary. Authenticating this family never proves full
// baseline/tail coverage, grants SQL authority, or opens generation processing.
export const APP_FAMILY_MAX_ROWS = 32;
export const APP_FAMILY_MAX_ROW_BYTES = 4 * 1024 * 1024;
export const APP_FAMILY_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DOMAIN = 'wm-owner-restore-app-family-v1\0';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const text = z.string().max(APP_FAMILY_MAX_ROW_BYTES);
const integer = z.number().int().min(-2147483648).max(2147483647);
const timestamp = z
  .string()
  .max(40)
  .refine(
    (v) =>
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+]00(?::00)?)$/.test(v) &&
      Number.isFinite(Date.parse(v)),
  );
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._:-]+$/);
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    text,
    z.array(json),
    z.record(z.string(), json),
  ]),
);
// Historical source SQL100 column roster; target SQL102 is independently pinned.
// No row schema or table name is accepted from archive-provided metadata.
const rowSchemas = {
  plan_snapshot: z.strictObject({
    athlete_id: text,
    id: uuid,
    version: integer,
    created_at: timestamp,
    draft: json,
  }),
  nutrition_plan_version: z.strictObject({
    athlete_id: text,
    plan_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    previous_version: integer.nullable(),
    period_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    linked_training_plan_version_id: uuid.nullable(),
    approval_id: uuid,
    approved_at: timestamp,
    record_json: json,
  }),
  routine_blueprint_version: z.strictObject({
    athlete_id: text,
    routine_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    record_json: json,
    created_at: timestamp,
  }),
  recovery_strategy_version: z.strictObject({
    athlete_id: text,
    strategy_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    previous_version: integer.nullable(),
    record_json: json,
  }),
  routine_schedule_version: z.strictObject({
    athlete_id: text,
    schedule_id: uuid,
    version_id: uuid,
    prior_version_id: uuid.nullable(),
    blueprint_routine_id: uuid,
    blueprint_version_id: uuid,
    source_plan_version_id: uuid.nullable(),
    record_json: json,
    created_at: timestamp,
  }),
  plan_head: z.strictObject({ athlete_id: text, version_id: uuid, aggregate_id: uuid }),
  nutrition_plan_head: z.strictObject({
    athlete_id: text,
    plan_id: uuid,
    version: integer,
    version_id: uuid,
  }),
  routine_blueprint_head: z.strictObject({
    athlete_id: text,
    routine_id: uuid,
    version_id: uuid,
    version: integer,
    favorite: z.boolean(),
    visibility: text,
  }),
  recovery_strategy_head: z.strictObject({
    athlete_id: text,
    strategy_id: uuid,
    version: integer,
    version_id: uuid,
  }),
  routine_schedule_head: z.strictObject({
    athlete_id: text,
    schedule_id: uuid,
    version_id: uuid,
    notification_muted: z.boolean(),
  }),
  routine_occurrence: z.strictObject({
    athlete_id: text,
    id: uuid,
    schedule_id: uuid,
    schedule_version_id: uuid,
    blueprint_routine_id: uuid,
    blueprint_version_id: uuid,
    anchor_key: text,
    scheduled_at: timestamp.nullable(),
    record_json: json,
  }),
  coaching_thread: z.strictObject({
    athlete_id: text,
    id: uuid,
    plan_version_id: uuid,
    title: text,
    scope: json,
    revision: integer,
    created_at: timestamp,
    updated_at: timestamp,
  }),
  coaching_message: z.strictObject({
    athlete_id: text,
    id: uuid,
    thread_id: uuid,
    revision: integer,
    content: text,
    created_at: timestamp,
  }),
  core_evidence_snapshot: z.strictObject({
    athlete_id: text,
    id: uuid,
    thread_id: uuid,
    created_at: timestamp,
    body: json.nullable(),
    purged_reason: text.nullable(),
  }),
  coaching_run: z.strictObject({
    athlete_id: text,
    id: uuid,
    thread_id: uuid,
    evidence_snapshot_id: uuid,
    conversation_revision: integer,
    policy: json,
    source: json,
    basis: json,
    status: json,
    created_at: timestamp,
    updated_at: timestamp,
  }),
  coaching_analysis_output: z.strictObject({
    athlete_id: text,
    id: uuid,
    run_id: uuid,
    body: json.nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  coaching_decision: z.strictObject({
    athlete_id: text,
    id: uuid,
    run_id: uuid,
    body: json.nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  coaching_proposal: z.strictObject({
    athlete_id: text,
    id: uuid,
    decision_id: uuid,
    body: json.nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  coaching_candidate: z.strictObject({
    athlete_id: text,
    id: uuid,
    decision_id: uuid,
    proposal_id: uuid,
    parent_candidate_id: uuid.nullable(),
    digest: text.nullable(),
    body: json.nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  integrated_candidate_v4: z.strictObject({
    athlete_id: text,
    id: uuid,
    proposal_id: uuid,
    digest: text,
    body: json,
    created_at: timestamp,
  }),
  integrated_approval_v4: z.strictObject({
    athlete_id: text,
    approval_id: uuid,
    candidate_id: uuid,
    proposal_id: uuid,
    proposal_digest: text,
    write_domains: json,
    result_json: json,
    approved_at: timestamp,
  }),
  command_receipt: z.strictObject({
    athlete_id: text,
    idempotency_key: text,
    request: json,
    result: json,
  }),
  plan_history: z.strictObject({ athlete_id: text, version_id: uuid, action: text }),
  nutrition_plan_history: z.strictObject({
    athlete_id: text,
    plan_id: uuid,
    version_id: uuid,
    approval_id: uuid,
    action: text,
    created_at: timestamp,
  }),
  recovery_strategy_history: z.strictObject({
    athlete_id: text,
    version_id: uuid,
    approval_id: uuid,
    action: text,
  }),
  routine_schedule_history: z.strictObject({
    athlete_id: text,
    version_id: uuid,
    approval_id: uuid,
    action: text,
  }),
  approval_app_admission_binding: z.strictObject({
    athlete_id: text,
    receipt_key: text,
    candidate_id: uuid.nullable(),
    integrated_candidate_id: uuid.nullable(),
    integrated_approval_id: uuid.nullable(),
    binding_version: integer,
    created_at: timestamp,
  }),
} as const;
export type AppFamilyRelation = keyof typeof rowSchemas;
const relation = z.enum(Object.keys(rowSchemas) as [AppFamilyRelation, ...AppFamilyRelation[]]);
const entrySchema = z.strictObject({
  ordinal: z.number().int().min(1).max(APP_FAMILY_MAX_ROWS),
  relation,
  row: z.record(z.string(), json),
  binding: z.record(z.string(), json).nullable(),
  absence: z.boolean(),
  witness: z.strictObject({ canonicalRequest: z.string().max(131072) }).nullable(),
});
const identitySchema = z.strictObject({
  sourceKeyId: identifier,
  sourceKeyVersion: z.number().int().positive().max(2147483647),
  purpose: z.literal('owner_restore_app_family'),
  schemaVersion: z.literal(100),
  targetSchemaVersion: z.literal(102),
  controlRevision: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
  targetIncarnation: uuid,
  schemaHash: hash,
  targetNonce: uuid,
  ownerId: uuid,
  proofHash: hash,
  expectedStateVersion: z.number().int().positive().max(2147483647),
  count: z.number().int().min(1).max(APP_FAMILY_MAX_ROWS),
  rowsSha256: hash,
});
const bodySchema = identitySchema
  .extend({
    artifactVersion: z.literal(1),
    rows: z.array(entrySchema).min(1).max(APP_FAMILY_MAX_ROWS),
  })
  .strict();
const signedSchema = z.strictObject({ body: bodySchema, hmacSha256: hash });
export type AppFamilyIdentity = z.infer<typeof identitySchema>;
export type AppFamilyRow = z.infer<typeof entrySchema>;
export type AppFamilyArtifactBodyV1 = z.infer<typeof bodySchema>;
export interface AppFamilyVerificationAuthority {
  // Expected identity comes from an independently authenticated coordinator,
  // never from the artifact's claimed owner/schema/target fields.
  readonly expected: AppFamilyIdentity;
  readonly resolveSourceKey: (id: string, version: number) => Uint8Array;
}
export interface VerifiedAppFamilyArtifact {
  readonly kind: 'verified_app_family_v1';
  readonly admissionAllowed: false;
}
export interface AppFamilyStagePort {
  // This internal port must use the owner's existing transaction and independent
  // SQL CLOSED/nonce/xid checks. It has no admit/open operation.
  computeSqlInventory(
    input: Readonly<{ identity: AppFamilyIdentity; rows: readonly AppFamilyRow[] }>,
  ): Promise<unknown>;
  stageVerifiedFamily(
    input: Readonly<{
      identity: AppFamilyIdentity;
      rows: readonly AppFamilyRow[];
      sqlInventory: SqlFamilyInventory;
      admissionAllowed: false;
    }>,
  ): Promise<void>;
}
const sqlInventorySchema = z.strictObject({
  canonicalRowsSha256: hash,
  count: z.number().int().min(1).max(APP_FAMILY_MAX_ROWS),
  sqlInventorySha256: hash,
  rows: z
    .array(
      z.strictObject({
        ordinal: z.number().int().positive().max(APP_FAMILY_MAX_ROWS),
        rowSha256: hash,
        tupleSha256: hash,
      }),
    )
    .min(1)
    .max(APP_FAMILY_MAX_ROWS),
});
export type SqlFamilyInventory = z.infer<typeof sqlInventorySchema>;
const verified = new WeakMap<VerifiedAppFamilyArtifact, AppFamilyArtifactBodyV1>();
function invalid(): never {
  throw new Error('INVALID_APP_FAMILY_ARTIFACT');
}
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: Json): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function boundedDepth(bytes: Uint8Array) {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const b of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (b === 92) escaped = true;
      else if (b === 34) quoted = false;
    } else if (b === 34) quoted = true;
    else if (b === 91 || b === 123) {
      if (++depth > 64) invalid();
    } else if (b === 93 || b === 125) {
      if (--depth < 0) invalid();
    }
  }
  if (depth !== 0 || quoted) invalid();
}
function same(a: Json, b: Json) {
  return canonical(a) === canonical(b);
}
function object(value: Json | undefined): { [key: string]: Json } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
const bindingBase = { athlete_id: uuid, binding_version: z.literal(1) };
const bindingSchemas = {
  core_evidence_snapshot: z.strictObject({
    ...bindingBase,
    evidence_snapshot_id: uuid,
    app_revision: z.number().int().positive().max(2147483647),
    captured_at: timestamp,
  }),
  coaching_run: z.strictObject({
    ...bindingBase,
    run_id: uuid,
    evidence_snapshot_id: uuid,
  }),
  coaching_candidate: z.strictObject({
    ...bindingBase,
    candidate_id: uuid,
    run_id: uuid,
  }),
  integrated_candidate_v4: z.strictObject({
    ...bindingBase,
    candidate_id: uuid,
    evidence_snapshot_id: uuid,
  }),
};
function validateRows(body: AppFamilyArtifactBodyV1) {
  if (body.count !== body.rows.length || digest(body.rows) !== body.rowsSha256) invalid();
  let total = 0;
  const seen = new Set<string>();
  for (const [index, entry] of body.rows.entries()) {
    if (entry.ordinal !== index + 1 || entry.row.athlete_id !== body.ownerId) invalid();
    rowSchemas[entry.relation].parse(entry.row);
    const rowBytes = Buffer.byteLength(canonical(entry.row));
    const tupleBytes = Buffer.byteLength(canonical(entry));
    total += tupleBytes;
    if (
      rowBytes > APP_FAMILY_MAX_ROW_BYTES ||
      tupleBytes > APP_FAMILY_MAX_ROW_BYTES + 4096 ||
      total > APP_FAMILY_MAX_TOTAL_BYTES
    )
      invalid();
    const key =
      entry.relation +
      ':' +
      String(
        entry.row.id ??
          entry.row.approval_id ??
          entry.row.idempotency_key ??
          entry.row.receipt_key ??
          entry.row.version_id ??
          entry.row.athlete_id,
      );
    if (seen.has(key)) invalid();
    seen.add(key);
    if ('version' in entry.row && (typeof entry.row.version !== 'number' || entry.row.version < 1))
      invalid();
    if (entry.relation === 'plan_snapshot') {
      const versionKey = 'plan_version:' + String(entry.row.version);
      if (seen.has(versionKey)) invalid();
      seen.add(versionKey);
    }
    if (entry.absence !== (entry.binding === null)) invalid();
    if (entry.relation in bindingSchemas) {
      if (entry.binding) {
        const name = entry.relation as keyof typeof bindingSchemas;
        bindingSchemas[name].parse(entry.binding);
        if (
          entry.binding.athlete_id !== body.ownerId ||
          (entry.binding.evidence_snapshot_id !== entry.row.id &&
            name === 'core_evidence_snapshot') ||
          (entry.binding.run_id !== entry.row.id && name === 'coaching_run') ||
          (entry.binding.candidate_id !== entry.row.id &&
            (name === 'coaching_candidate' || name === 'integrated_candidate_v4'))
        )
          invalid();
      }
    } else if (entry.binding !== null) invalid();
    if (
      entry.witness &&
      !(entry.relation === 'approval_app_admission_binding' && entry.row.candidate_id)
    )
      invalid();
    if (
      'body' in entry.row &&
      'purged_reason' in entry.row &&
      (entry.row.body === null) !== (entry.row.purged_reason !== null)
    )
      invalid();
    const r = entry.row;
    switch (entry.relation) {
      case 'plan_snapshot':
        planDraftSchema.parse(r.draft);
        break;
      case 'core_evidence_snapshot':
        if (r.body !== null) coreEvidenceBodySchema.parse(r.body);
        break;
      case 'coaching_run':
        trainingCoachingPolicySchema.parse(r.policy);
        coachingRunModelSourceSchema.parse(r.source);
        trainingCoachingBasisV1Schema.parse(r.basis);
        coachingRunStatusSchema.parse(r.status);
        break;
      case 'coaching_analysis_output':
        if (r.body !== null)
          z.strictObject({ schemaVersion: z.literal(1), content: json }).parse(r.body);
        break;
      case 'coaching_decision':
        if (r.body !== null) trainingDecisionV1Schema.parse(r.body);
        break;
      case 'coaching_proposal':
        if (r.body !== null) trainingProposalV1Schema.parse(r.body);
        break;
      case 'coaching_candidate':
        if (r.body !== null) trainingCandidateV1Schema.parse(r.body);
        break;
      case 'integrated_candidate_v4':
        integratedCandidateV4Schema.parse(r.body);
        break;
      case 'integrated_approval_v4':
        integratedApprovalResultV4Schema.parse(r.result_json);
        break;
    }
  }
  const find = (name: AppFamilyRelation, key: string, value: Json | undefined) => {
    const e = body.rows.find((e) => e.relation === name && e.row[key] === value);
    if (!e) invalid();
    return e;
  };
  const reference = (
    _entry: AppFamilyRow,
    name: AppFamilyRelation,
    key: string,
    value: Json | undefined,
  ) => find(name, key, value);
  for (const entry of body.rows) {
    const r = entry.row,
      b = entry.binding;
    switch (entry.relation) {
      case 'coaching_thread':
        reference(entry, 'plan_snapshot', 'id', r.plan_version_id);
        break;
      case 'coaching_message':
      case 'core_evidence_snapshot':
        reference(entry, 'coaching_thread', 'id', r.thread_id);
        break;
      case 'coaching_run': {
        reference(entry, 'coaching_thread', 'id', r.thread_id);
        const parent = find('core_evidence_snapshot', 'id', r.evidence_snapshot_id);
        if (b && (b.evidence_snapshot_id !== parent.row.id || !parent.binding)) invalid();
        break;
      }
      case 'coaching_analysis_output':
      case 'coaching_decision':
        reference(entry, 'coaching_run', 'id', r.run_id);
        break;
      case 'coaching_proposal':
        reference(entry, 'coaching_decision', 'id', r.decision_id);
        break;
      case 'coaching_candidate': {
        const decision = find('coaching_decision', 'id', r.decision_id);
        const run = find('coaching_run', 'id', decision.row.run_id);
        const proposal = find('coaching_proposal', 'id', r.proposal_id);
        if (
          proposal.row.decision_id !== decision.row.id ||
          (b && (b.run_id !== run.row.id || !run.binding))
        )
          invalid();
        if (r.body !== null) {
          const bundle = trainingCandidateBundleV1Schema.parse({
            decision: decision.row.body,
            proposal: proposal.row.body,
            candidate: r.body,
          });
          if (
            bundle.candidate.id !== r.id ||
            bundle.candidate.proposalId !== r.proposal_id ||
            bundle.candidate.decisionId !== r.decision_id ||
            bundle.candidate.runId !== run.row.id ||
            bundle.candidate.digest !== r.digest ||
            (bundle.candidate.parentCandidateId ?? null) !== r.parent_candidate_id ||
            bundle.decision.id !== decision.row.id ||
            bundle.decision.runId !== decision.row.run_id ||
            bundle.proposal.id !== proposal.row.id
          )
            invalid();
        }
        if (r.parent_candidate_id !== null) find('coaching_candidate', 'id', r.parent_candidate_id);
        break;
      }
      case 'integrated_candidate_v4': {
        const candidateBody = integratedCandidateV4Schema.parse(r.body);
        if (
          candidateBody.id !== r.id ||
          candidateBody.proposalId !== r.proposal_id ||
          candidateBody.digest !== r.digest
        )
          invalid();
        const parent = find(
          'core_evidence_snapshot',
          'id',
          object(object(r.body).basis).evidenceSnapshotId,
        );
        if (b && (b.evidence_snapshot_id !== parent.row.id || !parent.binding)) invalid();
        break;
      }
      case 'integrated_approval_v4': {
        const candidate = find('integrated_candidate_v4', 'id', r.candidate_id);
        if (
          r.proposal_id !== candidate.row.proposal_id ||
          r.proposal_digest !== candidate.row.digest
        )
          invalid();
        break;
      }
      case 'routine_schedule_version':
        find('routine_blueprint_version', 'version_id', r.blueprint_version_id);
        if (r.source_plan_version_id !== null)
          find('plan_snapshot', 'id', r.source_plan_version_id);
        break;
      case 'plan_head':
      case 'plan_history':
        find('plan_snapshot', 'id', r.version_id);
        break;
      case 'nutrition_plan_head':
      case 'nutrition_plan_history': {
        const parent = find('nutrition_plan_version', 'version_id', r.version_id);
        if (
          parent.row.plan_id !== r.plan_id ||
          ('approval_id' in r && parent.row.approval_id !== r.approval_id)
        )
          invalid();
        break;
      }
      case 'routine_blueprint_head': {
        const parent = find('routine_blueprint_version', 'version_id', r.version_id);
        if (parent.row.routine_id !== r.routine_id) invalid();
        break;
      }
      case 'recovery_strategy_head':
      case 'recovery_strategy_history': {
        const parent = find('recovery_strategy_version', 'version_id', r.version_id);
        if ('strategy_id' in r && parent.row.strategy_id !== r.strategy_id) invalid();
        if ('approval_id' in r) find('integrated_approval_v4', 'approval_id', r.approval_id);
        break;
      }
      case 'routine_schedule_head':
      case 'routine_schedule_history':
      case 'routine_occurrence': {
        const parent = find(
          'routine_schedule_version',
          'version_id',
          r.version_id ?? r.schedule_version_id,
        );
        if ('schedule_id' in r && parent.row.schedule_id !== r.schedule_id) invalid();
        if ('approval_id' in r) find('integrated_approval_v4', 'approval_id', r.approval_id);
        break;
      }
      case 'approval_app_admission_binding': {
        if (r.binding_version !== 1) invalid();
        const receipt = find('command_receipt', 'idempotency_key', r.receipt_key);
        if (r.candidate_id !== null) {
          if (
            r.integrated_candidate_id !== null ||
            r.integrated_approval_id !== null ||
            !entry.witness
          )
            invalid();
          const candidate = find('coaching_candidate', 'id', r.candidate_id);
          if (!candidate.binding) invalid();
          const witness = entry.witness.canonicalRequest;
          const parsed = z
            .strictObject({
              schemaVersion: z.literal(1),
              operation: z.literal('training_candidate_approve'),
              candidateId: uuid,
              expectedDigest: hash,
              confirmed: z.literal(true),
            })
            .parse(JSON.parse(witness));
          if (
            parsed.candidateId !== r.candidate_id ||
            parsed.expectedDigest !== candidate.row.digest ||
            !same(receipt.row.request ?? null, {
              requestHash: createHash('sha256').update(witness).digest('hex'),
            })
          )
            invalid();
          const versionId = object(receipt.row.result).versionId;
          find('plan_snapshot', 'id', versionId);
          const history = find('plan_history', 'version_id', versionId);
          if (history.row.action !== 'candidate_approved') invalid();
        } else {
          if (
            r.integrated_candidate_id === null ||
            r.integrated_approval_id === null ||
            entry.witness
          )
            invalid();
          const approval = find('integrated_approval_v4', 'approval_id', r.integrated_approval_id);
          const candidate = find('integrated_candidate_v4', 'id', r.integrated_candidate_id);
          if (
            !candidate.binding ||
            approval.row.candidate_id !== candidate.row.id ||
            !same(receipt.row.result ?? null, approval.row.result_json ?? null)
          )
            invalid();
          const request = object(receipt.row.request);
          if (request.kind !== 'integrated_approve_v4' || request.candidateId !== candidate.row.id)
            invalid();
          const result = integratedApprovalResultV4Schema.parse(approval.row.result_json);
          for (const version of result.versions) {
            const histories = {
              training: 'plan_history',
              nutrition: 'nutrition_plan_history',
              recovery: 'recovery_strategy_history',
              routine_schedule: 'routine_schedule_history',
            } as const;
            const history = find(histories[version.domain], 'version_id', version.versionId);
            if (version.domain === 'training' || version.domain === 'nutrition') {
              if (history.row.action !== 'candidate_approved') invalid();
            } else if (history.row.approval_id !== approval.row.approval_id) invalid();
            if (version.domain === 'nutrition') {
              const original = find('nutrition_plan_version', 'version_id', version.versionId);
              if (
                original.row.approval_id !== history.row.approval_id ||
                original.row.plan_id !== version.aggregateId
              )
                invalid();
            }
          }
          for (const occurrenceId of result.occurrenceIds)
            find('routine_occurrence', 'id', occurrenceId);
        }
        break;
      }
    }
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Exported signing is a source-owner boundary only. No source key provisioning.
export function signAppFamilyArtifact(body: unknown, key: Uint8Array): Uint8Array {
  boundedDepth(Buffer.from(JSON.stringify(body)));
  const parsed = bodySchema.parse(body);
  validateRows(parsed);
  if (key.byteLength !== 32) invalid();
  const mac = createHmac('sha256', key).update(DOMAIN).update(canonical(parsed)).digest('hex');
  return Buffer.from(canonical({ body: parsed, hmacSha256: mac }));
}
export function appFamilyRowsSha256(rows: readonly AppFamilyRow[]): string {
  const parsed = z.array(entrySchema).min(1).max(APP_FAMILY_MAX_ROWS).parse(rows);
  boundedDepth(Buffer.from(JSON.stringify(parsed)));
  return digest(parsed);
}
export function prepareVerifiedAppFamilyArtifact(
  bytes: Uint8Array,
  authority: AppFamilyVerificationAuthority,
): VerifiedAppFamilyArtifact {
  try {
    if (bytes.byteLength > APP_FAMILY_MAX_TOTAL_BYTES + 65536) invalid();
    boundedDepth(bytes);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const envelope = signedSchema.parse(JSON.parse(decoded));
    if (decoded !== canonical(envelope)) invalid(); // rejects duplicate keys and ambiguous byte forms
    const expected = identitySchema.parse(authority.expected);
    const { artifactVersion: _, rows: __, ...actual } = envelope.body;
    if (!same(actual, expected)) invalid();
    const key = authority.resolveSourceKey(expected.sourceKeyId, expected.sourceKeyVersion);
    if (key.byteLength !== 32) invalid();
    const wanted = createHmac('sha256', key)
      .update(DOMAIN)
      .update(canonical(envelope.body))
      .digest();
    if (!timingSafeEqual(wanted, Buffer.from(envelope.hmacSha256, 'hex'))) invalid();
    validateRows(envelope.body);
    const handle: VerifiedAppFamilyArtifact = Object.freeze({
      kind: 'verified_app_family_v1',
      admissionAllowed: false,
    });
    verified.set(handle, freeze(envelope.body));
    return handle;
  } catch {
    invalid();
  }
}
export async function stageVerifiedAppFamilyArtifact(
  port: AppFamilyStagePort,
  handle: VerifiedAppFamilyArtifact,
): Promise<void> {
  const body = verified.get(handle);
  if (!body) invalid();
  const { artifactVersion: _, rows, ...identity } = body;
  const sqlInventory = sqlInventorySchema.parse(
    await port.computeSqlInventory(Object.freeze({ identity: freeze(identity), rows })),
  );
  if (
    sqlInventory.canonicalRowsSha256 !== identity.rowsSha256 ||
    sqlInventory.count !== identity.count ||
    sqlInventory.rows.length !== rows.length ||
    sqlInventory.rows.some((r, i) => r.ordinal !== i + 1)
  )
    invalid();
  await port.stageVerifiedFamily(
    Object.freeze({
      identity: freeze(identity),
      rows,
      sqlInventory: freeze(sqlInventory),
      admissionAllowed: false,
    }),
  );
}
