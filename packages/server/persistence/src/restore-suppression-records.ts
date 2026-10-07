// This allowlist is for transient local replay preparation. It is not a remote
// ledger or a claim that the slot covers a particular backup or current tail.
const columnNames = [
  'event_id',
  'record_version',
  'athlete_id',
  'kind',
  'occurred_at',
  'target_id',
  'activity_revision',
  'source_kind',
  'source_id',
  'source_revision',
  'source_content_hash',
  'resource_access_revision',
  'gallery_access_revision',
  'consent_previous_revision',
  'consent_previous_granted',
  'consent_revision',
  'consent_granted',
  'check_in_revision',
  'share_id',
  'share_granted_access_revision',
  'share_revoked_access_revision',
  'course_share_id',
  'course_share_epoch',
  'course_share_course_revision',
  'actual_deletion_revision',
  'share_cause_kind',
  'share_cause_event_id',
  'course_share_revoke_reason',
  'course_share_audit_id',
  'course_share_audit_occurred_at',
  'actual_previous_revision_id',
  'actual_deleted_revision_id',
  'healthkit_claim_epoch',
  'healthkit_operation_id',
  'healthkit_consent_revision',
  'healthkit_registry_previous_revision',
  'healthkit_registry_revision',
  'healthkit_object_scopes',
  'race_previous_revision',
  'race_deleted_revision',
] as const;

const manualReviewColumns = [
  'manual_review_source_kind',
  'manual_review_source_id',
  'manual_review_version_scope',
  'manual_review_version_key',
] as const;
const currentColumnNames = [...columnNames, ...manualReviewColumns];
/** Physical V1–V6 columns, for an explicit successor decoder. */
export function suppressionRecordColumnNamesV6(): readonly string[] {
  return [...currentColumnNames];
}
const manualReviewKinds = [
  'race-event',
  'plan-snapshot',
  'nutrition-plan-version',
  'recovery-strategy-version',
  'routine-schedule-version',
  'routine-blueprint-version',
  'routine-occurrence',
  'routine-run',
  'session-completion',
] as const;
// SQL106 source identities require canonical lower hex UUIDs, without RFC version restrictions.
// This separate namespace does not alter historical event/target validation.
const canonicalSourceUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type ManualReviewSourceKind = (typeof manualReviewKinds)[number];
type ManualReviewIdentity = {
  manualReviewSourceKind: ManualReviewSourceKind;
  manualReviewSourceId: string;
} & (
  | { manualReviewVersionScope: 'all_versions'; manualReviewVersionKey: null }
  | { manualReviewVersionScope: 'exact_version'; manualReviewVersionKey: string }
);

/** Shared finite identity validation for physical records and encrypted DTOs. */
export function validateManualReviewSourceIdentity(
  kind: string,
  id: string,
  scope: string,
  key: string | null,
): ManualReviewIdentity {
  const sourceKind = manualReviewKinds.find((value) => value === kind);
  if (
    !sourceKind ||
    [...id].length < 1 ||
    [...id].length > 200 ||
    hasControl(id) ||
    (sourceKind !== 'session-completion' && !canonicalSourceUuid.test(id))
  )
    throw new Error('PGOUTPUT_INVALID_RECORD');
  if (scope === 'all_versions' && key === null)
    return {
      manualReviewSourceKind: sourceKind,
      manualReviewSourceId: id,
      manualReviewVersionScope: scope,
      manualReviewVersionKey: null,
    };
  if (scope !== 'exact_version' || key === null || key.length < 1 || key.length > 128)
    throw new Error('PGOUTPUT_INVALID_RECORD');
  let valid = false;
  if (sourceKind === 'session-completion') {
    try {
      const tuple: unknown = JSON.parse(key);
      valid =
        Array.isArray(tuple) &&
        tuple.length === 2 &&
        typeof tuple[0] === 'string' &&
        canonicalSourceUuid.test(tuple[0]) &&
        typeof tuple[1] === 'number' &&
        Number.isInteger(tuple[1]) &&
        tuple[1] >= 1 &&
        tuple[1] <= 2147483647 &&
        JSON.stringify(tuple) === key;
    } catch {
      valid = false;
    }
  } else if (sourceKind === 'routine-occurrence') valid = key === 'immutable';
  else if (
    sourceKind === 'routine-run' ||
    sourceKind === 'race-event' ||
    sourceKind === 'plan-snapshot'
  ) {
    valid =
      (sourceKind === 'routine-run' ? /^(0|[1-9][0-9]{0,9})$/ : /^[1-9][0-9]{0,9}$/).test(key) &&
      Number(key) <= 2147483647;
  } else valid = canonicalSourceUuid.test(key);
  if (!valid) throw new Error('PGOUTPUT_INVALID_RECORD');
  return {
    manualReviewSourceKind: sourceKind,
    manualReviewSourceId: id,
    manualReviewVersionScope: scope,
    manualReviewVersionKey: key,
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const timestamp =
  /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?([+-])(\d\d)(?::(\d\d))?$/;

type Base = {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  eventId: string;
  athleteId: string;
  occurredAt: string;
};

export type SuppressionRecord = Base &
  (
    | ({ schemaVersion: 6; kind: 'manual_review_source_suppressed' } & ManualReviewIdentity)
    | {
        kind:
          'healthkit_workout_deregistration_pending' | 'healthkit_workout_deregistration_released';
        targetId: string;
        healthKitClaimEpoch: string;
        healthKitOperationId: string;
        healthKitConsentRevision: number;
        healthKitRegistryPreviousRevision: number;
        healthKitRegistryRevision: number;
        healthKitObjectScopes: { kind: 'activity' | 'course'; id: string }[];
      }
    | {
        kind: 'race_event_deleted' | 'race_result_deleted' | 'training_best_deleted';
        targetId: string;
        racePreviousRevision: number;
        raceDeletedRevision: number;
      }
    | { kind: 'tenant_erased' }
    | { kind: 'course_deleted'; targetId: string }
    | {
        kind: 'activity_deleted';
        targetId: string;
        activityRevision: number;
        sourceKind: 'fit' | 'fixture' | 'manual' | 'healthkit';
        sourceId: string;
        sourceRevision: number;
        sourceContentHash: string;
      }
    | { kind: 'resource_deleted'; targetId: string; resourceAccessRevision: number }
    | { kind: 'gallery_media_deleted'; targetId: string; galleryAccessRevision: number }
    | {
        kind: 'healthkit_consent_transition' | 'ai_consent_transition' | 'app_consent_transition';
        consentPreviousRevision: number | null;
        consentPreviousGranted: boolean | null;
        consentRevision: number;
        consentGranted: boolean;
      }
    | { kind: 'check_in_deleted'; targetId: string; checkInRevision: number }
    | {
        kind: 'resource_share_revoked';
        targetId: string;
        shareId: string;
        shareGrantedAccessRevision: number;
        shareRevokedAccessRevision: number;
        shareCauseKind?: 'resource_deleted' | 'tenant_erased' | undefined;
        shareCauseEventId?: string | undefined;
      }
    | {
        kind: 'course_share_revoked';
        targetId: string;
        courseShareId: string;
        courseShareEpoch: number;
        courseShareCourseRevision: number;
        courseShareRevokeReason?: 'owner' | 'owner_all' | 'zone_added' | 'zone_removed' | undefined;
        courseShareAuditId?: string | undefined;
        courseShareAuditOccurredAt?: string | undefined;
      }
    | {
        kind: 'intake_entry_deleted' | 'recovery_action_deleted';
        targetId: string;
        actualDeletionRevision: number;
        actualPreviousRevisionId?: string | undefined;
        actualDeletedRevisionId?: string | undefined;
      }
  );

type Values = ReadonlyMap<string, string | null>;

function required(values: Values, name: string): string {
  const value = values.get(name);
  if (value === null || value === undefined) throw new Error('PGOUTPUT_INVALID_RECORD');
  return value;
}

function optional(values: Values, name: string): string | null {
  const value = values.get(name);
  if (value === undefined) throw new Error('PGOUTPUT_SCHEMA_CHANGED');
  return value;
}

function match(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error('PGOUTPUT_INVALID_RECORD');
  return value;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127);
  });
}

function validTimestamp(value: string): string {
  const parts = timestamp.exec(value);
  if (!parts) throw new Error('PGOUTPUT_INVALID_RECORD');
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    parts[1],
    parts[2],
    parts[3],
    parts[4],
    parts[5],
    parts[6],
    parts[8],
    parts[9] ?? '0',
  ].map(Number);
  const leap = year !== undefined && (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0));
  const daysByMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offsetHour === undefined ||
    offsetMinute === undefined ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysByMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('PGOUTPUT_INVALID_RECORD');
  return value;
}

export { validTimestamp as validateSuppressionOccurredAt };

function revision(values: Values, name: string, min = 1, max = 2147483647): number {
  const raw = required(values, name);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('PGOUTPUT_INVALID_RECORD');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('PGOUTPUT_INVALID_RECORD');
  return value;
}

function boolean(values: Values, name: string): boolean {
  const raw = required(values, name);
  if (raw !== 't' && raw !== 'f') throw new Error('PGOUTPUT_INVALID_RECORD');
  return raw === 't';
}

function target(values: Values): string {
  return match(required(values, 'target_id'), uuid);
}

function only(values: Values, allowed: readonly string[]): void {
  const included = new Set<string>([
    'event_id',
    'record_version',
    'athlete_id',
    'kind',
    'occurred_at',
    ...allowed,
  ]);
  const names = values.size === columnNames.length ? columnNames : currentColumnNames;
  if (values.size !== names.length || names.some((name) => !values.has(name)))
    throw new Error('PGOUTPUT_SCHEMA_CHANGED');
  for (const [name, value] of values) {
    if (!included.has(name) && value !== null) throw new Error('PGOUTPUT_UNEXPECTED_FIELD');
  }
}

/** Converts exactly one known DB event shape; rejects extra non-null fields. */
export function validateSuppressionRecord(values: Values): SuppressionRecord {
  const eventId = match(required(values, 'event_id'), uuid);
  const version = required(values, 'record_version');
  if (
    version !== '1' &&
    version !== '2' &&
    version !== '3' &&
    version !== '4' &&
    version !== '5' &&
    version !== '6'
  )
    throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  const athleteId = required(values, 'athlete_id');
  if ([...athleteId].length < 1 || [...athleteId].length > 200 || hasControl(athleteId))
    throw new Error('PGOUTPUT_INVALID_RECORD');
  const occurredAt = validTimestamp(required(values, 'occurred_at'));
  const base: Base = {
    schemaVersion:
      version === '1'
        ? 1
        : version === '2'
          ? 2
          : version === '3'
            ? 3
            : version === '4'
              ? 4
              : version === '5'
                ? 5
                : 6,
    eventId,
    athleteId,
    occurredAt,
  };
  const kind = required(values, 'kind');
  if (
    version === '2' &&
    kind !== 'resource_share_revoked' &&
    kind !== 'course_share_revoked' &&
    kind !== 'intake_entry_deleted' &&
    kind !== 'recovery_action_deleted'
  )
    throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  if (
    version === '3' &&
    kind !== 'healthkit_workout_deregistration_pending' &&
    kind !== 'healthkit_workout_deregistration_released'
  )
    throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  if (
    version === '4' &&
    kind !== 'race_event_deleted' &&
    kind !== 'race_result_deleted' &&
    kind !== 'training_best_deleted'
  )
    throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  if (version === '5' && kind !== 'app_consent_transition')
    throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  if (version === '6' && kind !== 'manual_review_source_suppressed')
    throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  switch (kind) {
    case 'manual_review_source_suppressed': {
      if (version !== '6' || values.size !== currentColumnNames.length)
        throw new Error('PGOUTPUT_SCHEMA_CHANGED');
      only(values, manualReviewColumns);
      return {
        ...base,
        schemaVersion: 6,
        kind,
        ...validateManualReviewSourceIdentity(
          required(values, 'manual_review_source_kind'),
          required(values, 'manual_review_source_id'),
          required(values, 'manual_review_version_scope'),
          optional(values, 'manual_review_version_key'),
        ),
      };
    }
    case 'race_event_deleted':
    case 'race_result_deleted':
    case 'training_best_deleted': {
      if (version !== '4') throw new Error('PGOUTPUT_UNKNOWN_EVENT');
      only(values, ['target_id', 'race_previous_revision', 'race_deleted_revision']);
      const previous = revision(values, 'race_previous_revision');
      const deleted = revision(values, 'race_deleted_revision');
      if (deleted !== Math.min(previous + 1, 2147483647))
        throw new Error('PGOUTPUT_INVALID_RECORD');
      return {
        ...base,
        kind,
        targetId: target(values),
        racePreviousRevision: previous,
        raceDeletedRevision: deleted,
      };
    }
    case 'healthkit_workout_deregistration_pending':
    case 'healthkit_workout_deregistration_released': {
      if (version !== '3') throw new Error('PGOUTPUT_UNKNOWN_EVENT');
      only(values, [
        'target_id',
        'healthkit_claim_epoch',
        'healthkit_operation_id',
        'healthkit_consent_revision',
        'healthkit_registry_previous_revision',
        'healthkit_registry_revision',
        'healthkit_object_scopes',
      ]);
      const previousRaw = required(values, 'healthkit_registry_previous_revision');
      if (!/^(0|[1-9]\d*)$/.test(previousRaw)) throw new Error('PGOUTPUT_INVALID_RECORD');
      const previous = Number(previousRaw);
      if (!Number.isSafeInteger(previous) || previous > 2147483646)
        throw new Error('PGOUTPUT_INVALID_RECORD');
      const current = revision(values, 'healthkit_registry_revision');
      if (current !== previous + 1) throw new Error('PGOUTPUT_INVALID_RECORD');
      let parsed: unknown;
      try {
        parsed = JSON.parse(required(values, 'healthkit_object_scopes'));
      } catch {
        throw new Error('PGOUTPUT_INVALID_RECORD');
      }
      if (!Array.isArray(parsed) || parsed.length > 1000)
        throw new Error('PGOUTPUT_INVALID_RECORD');
      const scopes: { kind: 'activity' | 'course'; id: string }[] = parsed.map((item: unknown) => {
        if (
          typeof item !== 'object' ||
          item === null ||
          !('kind' in item) ||
          !('id' in item) ||
          Object.keys(item).length !== 2 ||
          (item.kind !== 'activity' && item.kind !== 'course') ||
          typeof item.id !== 'string'
        )
          throw new Error('PGOUTPUT_INVALID_RECORD');
        return { kind: item.kind, id: match(item.id, uuid) };
      });
      if (new Set(scopes.map((scope) => scope.kind + ':' + scope.id)).size !== scopes.length)
        throw new Error('PGOUTPUT_INVALID_RECORD');
      return {
        ...base,
        kind,
        targetId: target(values),
        healthKitClaimEpoch: match(required(values, 'healthkit_claim_epoch'), uuid),
        healthKitOperationId: match(required(values, 'healthkit_operation_id'), uuid),
        healthKitConsentRevision: revision(values, 'healthkit_consent_revision'),
        healthKitRegistryPreviousRevision: previous,
        healthKitRegistryRevision: current,
        healthKitObjectScopes: scopes,
      };
    }
    case 'tenant_erased':
      only(values, []);
      return { ...base, kind };
    case 'course_deleted':
      only(values, ['target_id']);
      return { ...base, kind, targetId: target(values) };
    case 'activity_deleted': {
      only(values, [
        'target_id',
        'activity_revision',
        'source_kind',
        'source_id',
        'source_revision',
        'source_content_hash',
      ]);
      const sourceKind = required(values, 'source_kind');
      if (
        sourceKind !== 'fit' &&
        sourceKind !== 'fixture' &&
        sourceKind !== 'manual' &&
        sourceKind !== 'healthkit'
      )
        throw new Error('PGOUTPUT_INVALID_RECORD');
      const sourceId = required(values, 'source_id');
      if ([...sourceId].length < 1 || [...sourceId].length > 200 || hasControl(sourceId))
        throw new Error('PGOUTPUT_INVALID_RECORD');
      return {
        ...base,
        kind,
        targetId: target(values),
        activityRevision: revision(values, 'activity_revision'),
        sourceKind,
        sourceId,
        sourceRevision: revision(values, 'source_revision'),
        sourceContentHash: match(required(values, 'source_content_hash'), hash),
      };
    }
    case 'resource_deleted':
      only(values, ['target_id', 'resource_access_revision']);
      return {
        ...base,
        kind,
        targetId: target(values),
        resourceAccessRevision: revision(values, 'resource_access_revision', 1, 2147483646),
      };
    case 'gallery_media_deleted':
      only(values, ['target_id', 'gallery_access_revision']);
      return {
        ...base,
        kind,
        targetId: target(values),
        galleryAccessRevision: revision(values, 'gallery_access_revision', 1, 2147483646),
      };
    case 'healthkit_consent_transition':
    case 'ai_consent_transition':
    case 'app_consent_transition': {
      if (kind === 'app_consent_transition' && version !== '5')
        throw new Error('PGOUTPUT_UNKNOWN_EVENT');
      only(values, [
        'consent_previous_revision',
        'consent_previous_granted',
        'consent_revision',
        'consent_granted',
      ]);
      const consentRevision = revision(values, 'consent_revision');
      const previous = optional(values, 'consent_previous_revision');
      const previousGranted = optional(values, 'consent_previous_granted');
      if ((previous === null) !== (previousGranted === null))
        throw new Error('PGOUTPUT_INVALID_RECORD');
      if (previous === null && consentRevision !== 1) throw new Error('PGOUTPUT_INVALID_RECORD');
      const consentPreviousRevision =
        previous === null ? null : revision(values, 'consent_previous_revision', 1, 2147483646);
      if (consentPreviousRevision !== null && consentRevision !== consentPreviousRevision + 1)
        throw new Error('PGOUTPUT_INVALID_RECORD');
      return {
        ...base,
        kind,
        consentPreviousRevision,
        consentPreviousGranted:
          previousGranted === null ? null : boolean(values, 'consent_previous_granted'),
        consentRevision,
        consentGranted: boolean(values, 'consent_granted'),
      };
    }
    case 'check_in_deleted':
      only(values, ['target_id', 'check_in_revision']);
      return {
        ...base,
        kind,
        targetId: target(values),
        checkInRevision: revision(values, 'check_in_revision', 2, 2147483646),
      };
    case 'resource_share_revoked': {
      only(values, [
        'target_id',
        'share_id',
        'share_granted_access_revision',
        'share_revoked_access_revision',
        'share_cause_kind',
        'share_cause_event_id',
      ]);
      const causeKind = optional(values, 'share_cause_kind');
      const causeEventId = optional(values, 'share_cause_event_id');
      if (
        (causeKind === null) !== (causeEventId === null) ||
        (version === '2') !== (causeKind !== null) ||
        (causeKind !== null && causeKind !== 'resource_deleted' && causeKind !== 'tenant_erased')
      )
        throw new Error('PGOUTPUT_INVALID_RECORD');
      const shareGrantedAccessRevision = revision(
        values,
        'share_granted_access_revision',
        1,
        2147483645,
      );
      const shareRevokedAccessRevision = revision(
        values,
        'share_revoked_access_revision',
        2,
        2147483646,
      );
      if (shareRevokedAccessRevision <= shareGrantedAccessRevision)
        throw new Error('PGOUTPUT_INVALID_RECORD');
      return {
        ...base,
        kind,
        targetId: target(values),
        shareId: match(required(values, 'share_id'), uuid),
        shareGrantedAccessRevision,
        shareRevokedAccessRevision,
        ...(causeKind === null || causeEventId === null
          ? {}
          : {
              shareCauseKind: causeKind,
              shareCauseEventId: match(causeEventId, uuid),
            }),
      };
    }
    case 'course_share_revoked': {
      only(values, [
        'target_id',
        'course_share_id',
        'course_share_epoch',
        'course_share_course_revision',
        'course_share_revoke_reason',
        'course_share_audit_id',
        'course_share_audit_occurred_at',
      ]);
      const reason = optional(values, 'course_share_revoke_reason');
      const auditId = optional(values, 'course_share_audit_id');
      const auditAt = optional(values, 'course_share_audit_occurred_at');
      if (
        (version === '2') !== (reason !== null && auditId !== null && auditAt !== null) ||
        (reason === null) !== (auditId === null) ||
        (reason === null) !== (auditAt === null) ||
        (reason !== null &&
          reason !== 'owner' &&
          reason !== 'owner_all' &&
          reason !== 'zone_added' &&
          reason !== 'zone_removed')
      )
        throw new Error('PGOUTPUT_INVALID_RECORD');
      const validatedAuditAt = auditAt === null ? null : validTimestamp(auditAt);
      if (validatedAuditAt !== null && Date.parse(validatedAuditAt) < Date.parse(occurredAt))
        throw new Error('PGOUTPUT_INVALID_RECORD');
      return {
        ...base,
        kind,
        targetId: target(values),
        courseShareId: match(required(values, 'course_share_id'), uuid),
        courseShareEpoch: revision(values, 'course_share_epoch', 1, 2147483646),
        courseShareCourseRevision: revision(values, 'course_share_course_revision', 1, 2147483646),
        ...(reason === null || auditId === null || validatedAuditAt === null
          ? {}
          : {
              courseShareRevokeReason: reason,
              courseShareAuditId: match(auditId, uuid),
              courseShareAuditOccurredAt: validatedAuditAt,
            }),
      };
    }
    case 'intake_entry_deleted':
    case 'recovery_action_deleted': {
      only(values, [
        'target_id',
        'actual_deletion_revision',
        'actual_previous_revision_id',
        'actual_deleted_revision_id',
      ]);
      const previousId = optional(values, 'actual_previous_revision_id');
      const deletedId = optional(values, 'actual_deleted_revision_id');
      if (
        (previousId === null) !== (deletedId === null) ||
        (version === '2') !== (previousId !== null) ||
        (previousId !== null && previousId === deletedId)
      )
        throw new Error('PGOUTPUT_INVALID_RECORD');
      return {
        ...base,
        kind,
        targetId: target(values),
        actualDeletionRevision: revision(values, 'actual_deletion_revision', 2, 2147483646),
        ...(previousId === null || deletedId === null
          ? {}
          : {
              actualPreviousRevisionId: match(previousId, uuid),
              actualDeletedRevisionId: match(deletedId, uuid),
            }),
      };
    }
    default:
      throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  }
}
