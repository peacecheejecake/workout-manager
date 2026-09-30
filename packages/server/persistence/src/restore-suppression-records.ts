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
] as const;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const timestamp =
  /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?([+-])(\d\d)(?::(\d\d))?$/;

type Base = {
  schemaVersion: 1 | 2;
  eventId: string;
  athleteId: string;
  occurredAt: string;
};

export type SuppressionRecord = Base &
  (
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
        kind: 'healthkit_consent_transition' | 'ai_consent_transition';
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
  if (values.size !== columnNames.length || columnNames.some((name) => !values.has(name)))
    throw new Error('PGOUTPUT_SCHEMA_CHANGED');
  for (const [name, value] of values) {
    if (!included.has(name) && value !== null) throw new Error('PGOUTPUT_UNEXPECTED_FIELD');
  }
}

/** Converts exactly one known DB event shape; rejects extra non-null fields. */
export function validateSuppressionRecord(values: Values): SuppressionRecord {
  const eventId = match(required(values, 'event_id'), uuid);
  const version = required(values, 'record_version');
  if (version !== '1' && version !== '2') throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  const athleteId = required(values, 'athlete_id');
  if ([...athleteId].length < 1 || [...athleteId].length > 200 || hasControl(athleteId))
    throw new Error('PGOUTPUT_INVALID_RECORD');
  const occurredAt = validTimestamp(required(values, 'occurred_at'));
  const base: Base = { schemaVersion: version === '1' ? 1 : 2, eventId, athleteId, occurredAt };
  const kind = required(values, 'kind');
  if (
    version === '2' &&
    kind !== 'resource_share_revoked' &&
    kind !== 'course_share_revoked' &&
    kind !== 'intake_entry_deleted' &&
    kind !== 'recovery_action_deleted'
  )
    throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  switch (kind) {
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
    case 'ai_consent_transition': {
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
