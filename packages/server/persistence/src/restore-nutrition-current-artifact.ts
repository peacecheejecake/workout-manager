import { createHash } from 'node:crypto';
import { z } from 'zod';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { integratedApprovalResultV4Schema } from '@workout/contracts/integrated-coaching';

// Private SQL108 preparation only. No signature, owner SQL authority, import,
// complete catalog/tail proof, admission or processing opening is provided here.
export const NUTRITION_CURRENT_MAX_BYTES = 16 * 1024 * 1024;
export const NUTRITION_CURRENT_MAX_ROWS = 5000;
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().min(1).max(2147483647);
const stamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00(?::00)?)$/)
  .refine((s) => Number.isFinite(Date.parse(s)));
const tenant = { athlete_id: uuid };
const versionRow = z.strictObject({
  ...tenant,
  plan_id: uuid,
  version_id: uuid,
  version: positive,
  previous_version_id: uuid.nullable(),
  previous_version: positive.nullable(),
  period_from: z.string(),
  period_to: z.string(),
  linked_training_plan_version_id: uuid.nullable(),
  approval_id: uuid,
  approved_at: stamp,
  record_json: nutritionPlanVersionCompatibleV4Schema,
});
const schemas = {
  nutrition_plan_version: versionRow,
  nutrition_plan_head: z.strictObject({
    ...tenant,
    plan_id: uuid,
    version_id: uuid,
    version: positive,
  }),
  nutrition_plan_history: z.strictObject({
    ...tenant,
    plan_id: uuid,
    version_id: uuid,
    approval_id: uuid,
    action: z.enum(['user_approved', 'candidate_approved']),
    created_at: stamp,
  }),
  nutrition_race_item_disconnection: z.strictObject({
    ...tenant,
    version_id: uuid,
    item_key: z.string().regex(/^\\x[a-f0-9]{64}$/),
    item_id: z
      .string()
      .min(1)
      .refine((v) => v.trim() === v),
    event_id: uuid,
  }),
  // Normalized exact projection, not a claimed full suppression SQL row/catalog.
  original_race_deletion_v4: z.strictObject({
    ...tenant,
    event_id: uuid,
    record_version: z.literal(4),
    kind: z.literal('race_event_deleted'),
    target_id: uuid,
    occurred_at: stamp,
    race_previous_revision: positive,
    race_deleted_revision: positive,
  }),
  integrated_candidate_v4: z.strictObject({
    ...tenant,
    id: uuid,
    proposal_id: uuid,
    digest: hash,
    body: z.null(),
    purged_reason: z.literal('source_deleted'),
    created_at: stamp,
  }),
  nutrition_integrated_candidate_disconnection: z.strictObject({
    ...tenant,
    candidate_id: uuid,
    event_id: uuid,
    row_digest_version: z.literal('postgres-row-jsonb-utc-v1'),
    row_digest: hash,
    payload_digest_version: z.literal('integrated-candidate-v4-canonical-v1'),
    payload_digest: hash,
  }),
  integrated_candidate_app_admission_binding: z.strictObject({
    ...tenant,
    candidate_id: uuid,
    evidence_snapshot_id: uuid,
    binding_version: z.literal(1),
  }),
  integrated_approval_v4: z.strictObject({
    ...tenant,
    approval_id: uuid,
    candidate_id: uuid,
    proposal_id: uuid,
    proposal_digest: hash,
    write_domains: z
      .array(z.enum(['training', 'nutrition', 'recovery', 'routine_schedule']))
      .min(1)
      .max(4),
    result_json: integratedApprovalResultV4Schema,
    approved_at: stamp,
  }),
  approval_app_admission_binding: z.strictObject({
    ...tenant,
    receipt_key: z.string().min(1).max(200),
    candidate_id: z.null(),
    integrated_candidate_id: uuid,
    integrated_approval_id: uuid,
    binding_version: z.literal(1),
    created_at: stamp,
  }),
  command_receipt: z.strictObject({
    ...tenant,
    idempotency_key: z.string().min(1).max(200),
    request: z.strictObject({
      receiptVersion: z.literal(2),
      digestVersion: z.literal('postgres-jsonb-sha256-v1'),
      requestDigest: hash,
    }),
    result: z.strictObject({
      receiptVersion: z.literal(2),
      outcome: z.literal('committed'),
      kind: z.literal('nutrition_plan'),
      planId: uuid,
      versionId: uuid,
      version: positive,
      approvalId: uuid,
    }),
  }),
};
const rowSchema = z.discriminatedUnion('relation', [
  z.strictObject({
    relation: z.literal('nutrition_plan_version'),
    row: schemas.nutrition_plan_version,
  }),
  z.strictObject({ relation: z.literal('nutrition_plan_head'), row: schemas.nutrition_plan_head }),
  z.strictObject({
    relation: z.literal('nutrition_plan_history'),
    row: schemas.nutrition_plan_history,
  }),
  z.strictObject({
    relation: z.literal('nutrition_race_item_disconnection'),
    row: schemas.nutrition_race_item_disconnection,
  }),
  z.strictObject({
    relation: z.literal('original_race_deletion_v4'),
    row: schemas.original_race_deletion_v4,
  }),
  z.strictObject({
    relation: z.literal('integrated_candidate_v4'),
    row: schemas.integrated_candidate_v4,
  }),
  z.strictObject({
    relation: z.literal('nutrition_integrated_candidate_disconnection'),
    row: schemas.nutrition_integrated_candidate_disconnection,
  }),
  z.strictObject({
    relation: z.literal('integrated_candidate_app_admission_binding'),
    row: schemas.integrated_candidate_app_admission_binding,
  }),
  z.strictObject({
    relation: z.literal('integrated_approval_v4'),
    row: schemas.integrated_approval_v4,
  }),
  z.strictObject({
    relation: z.literal('approval_app_admission_binding'),
    row: schemas.approval_app_admission_binding,
  }),
  z.strictObject({ relation: z.literal('command_receipt'), row: schemas.command_receipt }),
]);
const artifactSchema = z.strictObject({
  artifactVersion: z.literal(1),
  purpose: z.literal('owner_restore_nutrition_current_preparation'),
  sourceSchemaVersion: z.literal(108),
  ownerId: uuid,
  sourceRegistrySha256: hash,
  archiveSha256: hash,
  tailSha256: hash,
  rowsSha256: hash,
  count: z.number().int().min(1).max(NUTRITION_CURRENT_MAX_ROWS),
  rows: z.array(rowSchema).min(1).max(NUTRITION_CURRENT_MAX_ROWS),
});
export type NutritionCurrentPreparationBody = z.infer<typeof artifactSchema>;
export type NutritionCurrentPreparationRow = z.infer<typeof rowSchema>;

/** Requirements for an independently implemented coordinator. This module does
 * not implement/call it, or turn its JSON metadata into a verified handle. */
export interface NutritionCurrentIndependentAuthority {
  verifyArchiveSourceAndTail(
    input: Readonly<{
      artifactBytes: Uint8Array;
      expectedOwnerId: string;
      expectedSourceRegistrySha256: string;
      immutableArchiveBytes: Uint8Array;
      independentlyRetainedSourceWitnessBytes: Uint8Array;
      independentlyRetainedContiguousTailBytes: Uint8Array;
    }>,
  ): Promise<void>;
}
function rejected(): never {
  throw new Error('INVALID_NUTRITION_CURRENT_PREPARATION');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  const s = JSON.stringify(value);
  if (s === undefined) rejected();
  return s;
}
export function nutritionCurrentRowsSha256(
  rows: readonly NutritionCurrentPreparationRow[],
): string {
  return createHash('sha256').update(canonical(rows), 'utf8').digest('hex');
}
function instant(s: string): bigint {
  const fraction = /\.(\d{1,6})/.exec(s)?.[1] ?? '';
  const seconds = s.replace(/\.\d{1,6}/, '');
  return BigInt(Date.parse(seconds)) * 1000n + BigInt(fraction.padEnd(6, '0'));
}
function tuple(...s: string[]): string {
  return JSON.stringify(s);
}
function boundedJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > NUTRITION_CURRENT_MAX_BYTES) rejected();
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
      if (++depth > 64) rejected();
    } else if (b === 93 || b === 125) {
      if (--depth < 0) rejected();
    }
  }
  if (depth !== 0 || quoted) rejected();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function validate(body: NutritionCurrentPreparationBody) {
  if (body.count !== body.rows.length || body.rowsSha256 !== nutritionCurrentRowsSha256(body.rows))
    rejected();
  const versions = new Map<string, z.infer<typeof versionRow>>();
  const events = new Map<string, z.infer<typeof schemas.original_race_deletion_v4>>();
  const candidates = new Map<string, z.infer<typeof schemas.integrated_candidate_v4>>();
  const approvals = new Map<string, z.infer<typeof schemas.integrated_approval_v4>>();
  const itemMarkers = new Map<string, z.infer<typeof schemas.nutrition_race_item_disconnection>>();
  const candidateMarkers = new Map<
    string,
    z.infer<typeof schemas.nutrition_integrated_candidate_disconnection>
  >();
  const candidateBindings = new Map<
    string,
    z.infer<typeof schemas.integrated_candidate_app_admission_binding>
  >();
  const seen = new Set<string>(),
    uniqueVersions = new Set<string>();
  for (const entry of body.rows) {
    if (
      entry.row.athlete_id !== body.ownerId ||
      Buffer.byteLength(canonical(entry.row)) >
        (entry.relation === 'nutrition_plan_version' ? 524288 : 4194304)
    )
      rejected();
    const r = entry.row;
    const identity =
      'item_key' in r
        ? tuple(r.version_id, r.item_key)
        : 'idempotency_key' in r
          ? r.idempotency_key
          : 'receipt_key' in r
            ? r.receipt_key
            : 'id' in r
              ? r.id
              : 'event_id' in r && !('candidate_id' in r)
                ? r.event_id
                : 'candidate_id' in r && !('approval_id' in r)
                  ? r.candidate_id
                  : 'approval_id' in r && !('version_id' in r)
                    ? r.approval_id
                    : 'version_id' in r
                      ? r.version_id
                      : '';
    // Heads are keyed by plan, histories by full version; no alternate case UUID identity accepted.
    const key = tuple(
      entry.relation,
      entry.relation === 'nutrition_plan_head' ? ('plan_id' in r ? r.plan_id : '') : identity,
    );
    if (seen.has(key)) rejected();
    seen.add(key);
    switch (entry.relation) {
      case 'nutrition_plan_version': {
        const row = entry.row,
          b = row.record_json;
        if (
          row.plan_id !== b.planId ||
          row.version_id !== b.versionId ||
          row.version !== b.version ||
          row.previous_version_id !== b.previousVersionId ||
          row.previous_version !== (b.version === 1 ? null : b.version - 1) ||
          row.approval_id !== b.approvalId ||
          instant(row.approved_at) !== instant(b.approvedAt) ||
          row.period_from !== b.period.from ||
          row.period_to !== b.period.toInclusive ||
          row.linked_training_plan_version_id !== b.linkedTrainingPlanVersionId
        )
          rejected();
        const sqlUnique = tuple(row.plan_id, String(row.version));
        if (uniqueVersions.has(sqlUnique)) rejected();
        uniqueVersions.add(sqlUnique);
        versions.set(row.version_id, row);
        break;
      }
      case 'original_race_deletion_v4':
        if (entry.row.race_deleted_revision !== entry.row.race_previous_revision + 1) rejected();
        events.set(entry.row.event_id, entry.row);
        break;
      case 'integrated_candidate_v4':
        candidates.set(entry.row.id, entry.row);
        break;
      case 'integrated_approval_v4':
        approvals.set(entry.row.approval_id, entry.row);
        break;
      case 'nutrition_race_item_disconnection':
        if (
          entry.row.item_key !==
            `\\x${createHash('sha256').update(entry.row.item_id, 'utf8').digest('hex')}` ||
          itemMarkers.has(tuple(entry.row.version_id, entry.row.item_id))
        )
          rejected();
        itemMarkers.set(tuple(entry.row.version_id, entry.row.item_id), entry.row);
        break;
      case 'nutrition_integrated_candidate_disconnection':
        candidateMarkers.set(entry.row.candidate_id, entry.row);
        break;
      case 'integrated_candidate_app_admission_binding':
        candidateBindings.set(entry.row.candidate_id, entry.row);
        break;
    }
  }
  const external = new Set<string>();
  const deletedTargets = new Set([...events.values()].map((e) => e.target_id));
  for (const row of versions.values()) {
    if (row.previous_version_id !== null) {
      const prior = versions.get(row.previous_version_id);
      if (!prior || prior.plan_id !== row.plan_id || prior.version !== row.previous_version)
        rejected();
    }
    if (row.linked_training_plan_version_id)
      external.add(`plan_snapshot:${row.linked_training_plan_version_id}`);
    for (const item of row.record_json.items) {
      const marker = itemMarkers.get(tuple(row.version_id, item.id));
      if ((item.anchor.kind === 'disconnected') !== (marker !== undefined)) rejected();
      for (const food of item.foods)
        if (food.foodVersionId) external.add(`food_definition_version:${food.foodVersionId}`);
      const anchor = item.anchor;
      if (
        anchor.kind === 'relative' &&
        anchor.entity === 'race' &&
        deletedTargets.has(anchor.entityId.toLowerCase())
      )
        rejected();
    }
    if (
      'raceTimingPins' in row.record_json &&
      row.record_json.raceTimingPins.some((pin) => deletedTargets.has(pin.eventId))
    )
      rejected();
  }
  for (const m of itemMarkers.values()) {
    const item = versions.get(m.version_id)?.record_json.items.find((i) => i.id === m.item_id);
    if (
      !item ||
      item.anchor.kind !== 'disconnected' ||
      !events.has(m.event_id) ||
      m.item_key !== `\\x${createHash('sha256').update(m.item_id, 'utf8').digest('hex')}`
    )
      rejected();
  }
  for (const c of candidates.values()) {
    const m = candidateMarkers.get(c.id),
      b = candidateBindings.get(c.id);
    if (!m || !b || m.payload_digest !== c.digest || !events.has(m.event_id)) rejected();
    external.add(`core_evidence_snapshot:${b.evidence_snapshot_id}`);
  }
  for (const m of candidateMarkers.values()) if (!candidates.has(m.candidate_id)) rejected();
  for (const b of candidateBindings.values()) if (!candidates.has(b.candidate_id)) rejected();
  for (const entry of body.rows) {
    switch (entry.relation) {
      case 'nutrition_plan_head':
      case 'nutrition_plan_history': {
        const r = entry.row,
          v = versions.get(r.version_id);
        if (
          !v ||
          v.plan_id !== r.plan_id ||
          ('version' in r && v.version !== r.version) ||
          ('approval_id' in r && v.approval_id !== r.approval_id)
        )
          rejected();
        break;
      }
      case 'command_receipt': {
        const r = entry.row.result,
          v = versions.get(r.versionId);
        if (
          !v ||
          v.plan_id !== r.planId ||
          v.version !== r.version ||
          v.approval_id !== r.approvalId ||
          ![...itemMarkers.values()].some((m) => m.version_id === r.versionId)
        )
          rejected();
        break;
      }
      case 'integrated_approval_v4': {
        const r = entry.row,
          c = candidates.get(r.candidate_id),
          b = r.result_json;
        if (
          !c ||
          c.proposal_id !== r.proposal_id ||
          c.digest !== r.proposal_digest ||
          b.candidateId !== c.id ||
          b.approvalId !== r.approval_id ||
          instant(b.approvedAt) !== instant(r.approved_at) ||
          new Set(r.write_domains).size !== r.write_domains.length ||
          canonical([...new Set(b.versions.map((v) => v.domain))].sort()) !==
            canonical([...r.write_domains].sort())
        )
          rejected();
        const found = new Set<string>();
        for (const v of b.versions) {
          const key = tuple(v.domain, v.aggregateId);
          if (found.has(key)) rejected();
          found.add(key);
          if (v.domain === 'nutrition') {
            const owned = versions.get(v.versionId);
            if (!owned || owned.plan_id !== v.aggregateId || owned.approval_id !== r.approval_id)
              rejected();
          } else external.add(`${v.domain}:${v.aggregateId}:${v.versionId}`);
        }
        for (const id of b.occurrenceIds) external.add(`routine_occurrence:${id}`);
        break;
      }
      case 'approval_app_admission_binding': {
        const r = entry.row,
          a = approvals.get(r.integrated_approval_id);
        if (
          !a ||
          a.candidate_id !== r.integrated_candidate_id ||
          instant(a.approved_at) !== instant(r.created_at)
        )
          rejected();
        external.add(`command_receipt:${r.receipt_key}`);
        break;
      }
    }
  }
  return [...external].sort();
}
export function parseNutritionCurrentArtifact(bytes: Uint8Array): Readonly<{
  status: 'not_authenticated';
  admissionAllowed: false;
  body: NutritionCurrentPreparationBody;
  requiredExternalSources: readonly string[];
}> {
  const body = artifactSchema.parse(boundedJson(bytes));
  const requiredExternalSources = validate(body);
  return { status: 'not_authenticated', admissionAllowed: false, body, requiredExternalSources };
}
