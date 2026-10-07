import { z } from 'zod';
import { validateLegacySuppressionReplayRecord } from './restore-suppression-segment.js';
import { validateSuppressionOccurredAt } from './restore-suppression-records.js';
import {
  decodeSuppressionRecordColumnsV7,
  manualReviewSourceIdentityV7Schema,
  suppressionRecordColumnNamesV7,
  validateSuppressionRecordV7,
  type SuppressionRecordThroughV7,
} from './restore-suppression-records-v7.js';

const bytesLimit = 4 * 1024 * 1024;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
// Exact installed116 columns. Structural encoding never authenticates an event.
const restoreSuppressionPhysicalRowV7Schema = z.strictObject({
  event_id: uuid,
  record_version: z.number().int().min(-2147483648).max(2147483647),
  athlete_id: z.string(),
  kind: z.string(),
  occurred_at: utc,
  target_id: uuid.nullable(),
  activity_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  source_kind: z.string().nullable(),
  source_id: z.string().nullable(),
  source_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  source_content_hash: z.string().nullable(),
  resource_access_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  gallery_access_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  consent_previous_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  consent_previous_granted: z.boolean().nullable(),
  consent_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  consent_granted: z.boolean().nullable(),
  check_in_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  share_id: uuid.nullable(),
  share_granted_access_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  share_revoked_access_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  course_share_id: uuid.nullable(),
  course_share_epoch: z.number().int().min(-2147483648).max(2147483647).nullable(),
  course_share_course_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  actual_deletion_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  share_cause_kind: z.string().nullable(),
  share_cause_event_id: uuid.nullable(),
  course_share_revoke_reason: z.string().nullable(),
  course_share_audit_id: uuid.nullable(),
  course_share_audit_occurred_at: utc.nullable(),
  actual_previous_revision_id: uuid.nullable(),
  actual_deleted_revision_id: uuid.nullable(),
  healthkit_claim_epoch: uuid.nullable(),
  healthkit_operation_id: uuid.nullable(),
  healthkit_consent_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  healthkit_registry_previous_revision: z
    .number()
    .int()
    .min(-2147483648)
    .max(2147483647)
    .nullable(),
  healthkit_registry_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  healthkit_object_scopes: z.json().nullable(),
  race_previous_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  race_deleted_revision: z.number().int().min(-2147483648).max(2147483647).nullable(),
  manual_review_source_kind: z.string().nullable(),
  manual_review_source_id: z.string().nullable(),
  manual_review_version_scope: z.string().nullable(),
  manual_review_version_key: z.string().nullable(),
  manual_review_v2_source_identity: manualReviewSourceIdentityV7Schema.nullable(),
  manual_review_v2_version_scope: z.string().nullable(),
});
export type RestoreSuppressionPhysicalRowV7 = z.infer<typeof restoreSuppressionPhysicalRowV7Schema>;

function boundedPlain(value: unknown): void {
  let bytes = 0;
  let visits = 0;
  const active = new WeakSet<object>();
  function visit(v: unknown, depth: number): void {
    if (++visits > bytesLimit || depth > 64) throw Error('SUPPRESSION_PHYSICAL_INVALID');
    bytes += typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 1;
    if (bytes > bytesLimit) throw Error('SUPPRESSION_PHYSICAL_LIMIT');
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return;
    if (
      typeof v !== 'object' ||
      active.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
    )
      throw Error('SUPPRESSION_PHYSICAL_INVALID');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      throw Error('SUPPRESSION_PHYSICAL_INVALID');
    active.add(v);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor))
        throw Error('SUPPRESSION_PHYSICAL_INVALID');
      bytes += Buffer.byteLength(key, 'utf8');
      visit(descriptor.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytesLimit)
    throw Error('SUPPRESSION_PHYSICAL_LIMIT');
}

/** Preserve the fractional digits independently: Date only handles integral seconds and offsets. */
function physicalInstant(raw: string): string {
  validateSuppressionOccurredAt(raw);
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-]\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) throw Error('SUPPRESSION_PHYSICAL_INVALID');
  const [, date, time, fraction, offset, minutes] = match;
  const seconds = Date.parse(`${date}T${time}${offset}:${minutes ?? '00'}`);
  const whole = new Date(seconds).toISOString();
  if (!/^\d{4}-/.test(whole) || whole.startsWith('0000-'))
    throw Error('SUPPRESSION_PHYSICAL_INVALID');
  return `${whole.slice(0, 19)}.${(fraction ?? '').padEnd(6, '0')}Z`;
}
function sqlInstant(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, -1)}+00`;
}

/** Convert an already observed original DTO; no IDs, timestamps, or authority are minted. */
export function encodeRestoreSuppressionPhysicalRowV7(
  raw: unknown,
): RestoreSuppressionPhysicalRowV7 {
  boundedPlain(raw);
  const record: SuppressionRecordThroughV7 =
    typeof raw === 'object' && raw !== null && 'schemaVersion' in raw && raw.schemaVersion === 7
      ? validateSuppressionRecordV7(raw)
      : validateLegacySuppressionReplayRecord(raw);
  const row = restoreSuppressionPhysicalRowV7Schema.parse({
    event_id: record.eventId,
    record_version: record.schemaVersion,
    athlete_id: record.athleteId,
    kind: record.kind,
    occurred_at: physicalInstant(record.occurredAt),
    target_id: null,
    activity_revision: null,
    source_kind: null,
    source_id: null,
    source_revision: null,
    source_content_hash: null,
    resource_access_revision: null,
    gallery_access_revision: null,
    consent_previous_revision: null,
    consent_previous_granted: null,
    consent_revision: null,
    consent_granted: null,
    check_in_revision: null,
    share_id: null,
    share_granted_access_revision: null,
    share_revoked_access_revision: null,
    course_share_id: null,
    course_share_epoch: null,
    course_share_course_revision: null,
    actual_deletion_revision: null,
    share_cause_kind: null,
    share_cause_event_id: null,
    course_share_revoke_reason: null,
    course_share_audit_id: null,
    course_share_audit_occurred_at: null,
    actual_previous_revision_id: null,
    actual_deleted_revision_id: null,
    healthkit_claim_epoch: null,
    healthkit_operation_id: null,
    healthkit_consent_revision: null,
    healthkit_registry_previous_revision: null,
    healthkit_registry_revision: null,
    healthkit_object_scopes: null,
    race_previous_revision: null,
    race_deleted_revision: null,
    manual_review_source_kind: null,
    manual_review_source_id: null,
    manual_review_version_scope: null,
    manual_review_version_key: null,
    manual_review_v2_source_identity: null,
    manual_review_v2_version_scope: null,
  });
  switch (record.kind) {
    case 'tenant_erased':
      break;
    case 'course_deleted':
      Object.assign(row, { target_id: record.targetId });
      break;
    case 'activity_deleted':
      Object.assign(row, {
        target_id: record.targetId,
        activity_revision: record.activityRevision,
        source_kind: record.sourceKind,
        source_id: record.sourceId,
        source_revision: record.sourceRevision,
        source_content_hash: record.sourceContentHash,
      });
      break;
    case 'resource_deleted':
      Object.assign(row, {
        target_id: record.targetId,
        resource_access_revision: record.resourceAccessRevision,
      });
      break;
    case 'gallery_media_deleted':
      Object.assign(row, {
        target_id: record.targetId,
        gallery_access_revision: record.galleryAccessRevision,
      });
      break;
    case 'healthkit_consent_transition':
    case 'ai_consent_transition':
    case 'app_consent_transition':
      Object.assign(row, {
        consent_previous_revision: record.consentPreviousRevision,
        consent_previous_granted: record.consentPreviousGranted,
        consent_revision: record.consentRevision,
        consent_granted: record.consentGranted,
      });
      break;
    case 'check_in_deleted':
      Object.assign(row, { target_id: record.targetId, check_in_revision: record.checkInRevision });
      break;
    case 'resource_share_revoked':
      Object.assign(row, {
        target_id: record.targetId,
        share_id: record.shareId,
        share_granted_access_revision: record.shareGrantedAccessRevision,
        share_revoked_access_revision: record.shareRevokedAccessRevision,
        share_cause_kind: record.shareCauseKind ?? null,
        share_cause_event_id: record.shareCauseEventId ?? null,
      });
      break;
    case 'course_share_revoked':
      Object.assign(row, {
        target_id: record.targetId,
        course_share_id: record.courseShareId,
        course_share_epoch: record.courseShareEpoch,
        course_share_course_revision: record.courseShareCourseRevision,
        course_share_revoke_reason: record.courseShareRevokeReason ?? null,
        course_share_audit_id: record.courseShareAuditId ?? null,
        course_share_audit_occurred_at:
          record.courseShareAuditOccurredAt === undefined
            ? null
            : physicalInstant(record.courseShareAuditOccurredAt),
      });
      break;
    case 'intake_entry_deleted':
    case 'recovery_action_deleted':
      Object.assign(row, {
        target_id: record.targetId,
        actual_deletion_revision: record.actualDeletionRevision,
        actual_previous_revision_id: record.actualPreviousRevisionId ?? null,
        actual_deleted_revision_id: record.actualDeletedRevisionId ?? null,
      });
      break;
    case 'healthkit_workout_deregistration_pending':
    case 'healthkit_workout_deregistration_released':
      Object.assign(row, {
        target_id: record.targetId,
        healthkit_claim_epoch: record.healthKitClaimEpoch,
        healthkit_operation_id: record.healthKitOperationId,
        healthkit_consent_revision: record.healthKitConsentRevision,
        healthkit_registry_previous_revision: record.healthKitRegistryPreviousRevision,
        healthkit_registry_revision: record.healthKitRegistryRevision,
        healthkit_object_scopes: record.healthKitObjectScopes,
      });
      break;
    case 'race_event_deleted':
    case 'race_result_deleted':
    case 'training_best_deleted':
      Object.assign(row, {
        target_id: record.targetId,
        race_previous_revision: record.racePreviousRevision,
        race_deleted_revision: record.raceDeletedRevision,
      });
      break;
    case 'manual_review_source_suppressed':
      Object.assign(row, {
        manual_review_source_kind: record.manualReviewSourceKind,
        manual_review_source_id: record.manualReviewSourceId,
        manual_review_version_scope: record.manualReviewVersionScope,
        manual_review_version_key: record.manualReviewVersionKey,
      });
      break;
    case 'manual_review_source_suppressed_v2':
      Object.assign(row, {
        manual_review_v2_source_identity: record.sourceIdentity,
        manual_review_v2_version_scope: record.versionScope,
      });
      break;
    default: {
      const unreachable: never = record;
      throw Error(`SUPPRESSION_PHYSICAL_UNSUPPORTED:${typeof unreachable}`);
    }
  }
  const output = restoreSuppressionPhysicalRowV7Schema.parse(row);
  boundedPlain(output);
  // The independent physical decoder enforces all version-specific inactive NULLs and relational bounds.
  decodeRestoreSuppressionPhysicalRowV7(output);
  return output;
}

/** Explicit reverse read boundary for this 46-column physical format, not an event installer. */
export function decodeRestoreSuppressionPhysicalRowV7(raw: unknown): SuppressionRecordThroughV7 {
  boundedPlain(raw);
  const row = restoreSuppressionPhysicalRowV7Schema.parse(raw);
  const columns = new Map<string, string | null>();
  for (const name of suppressionRecordColumnNamesV7()) {
    const value: unknown = Reflect.get(row, name);
    if (value === null) columns.set(name, null);
    else if (name === 'occurred_at' || name === 'course_share_audit_occurred_at') {
      if (typeof value !== 'string') throw Error('SUPPRESSION_PHYSICAL_INVALID');
      columns.set(name, sqlInstant(value));
    } else if (typeof value === 'boolean') columns.set(name, value ? 't' : 'f');
    else if (typeof value === 'number' || typeof value === 'string')
      columns.set(name, String(value));
    else columns.set(name, JSON.stringify(value));
  }
  return decodeSuppressionRecordColumnsV7(columns);
}
