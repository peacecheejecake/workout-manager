import { expect, it } from 'vitest';
import {
  encodeRestoreSuppressionPhysicalRowV7,
  decodeRestoreSuppressionPhysicalRowV7,
} from '../src/restore-suppression-physical-row-v7.js';
import {
  decodeSuppressionRecordColumnsV7,
  suppressionRecordColumnNamesV7,
} from '../src/restore-suppression-records-v7.js';

const id = '12345678-abcd-4123-8123-123456789abc';
const target = '22345678-abcd-4123-8123-123456789abc';
const other = '32345678-abcd-4123-8123-123456789abc';
const base = {
  schemaVersion: 1,
  eventId: id,
  athleteId: 'synthetic-tenant',
  occurredAt: '2026-10-01 12:34:56.123456+00',
};
const cases = [
  { kind: 'tenant_erased' },
  { kind: 'course_deleted', targetId: target },
  {
    kind: 'activity_deleted',
    targetId: target,
    activityRevision: 2,
    sourceKind: 'manual',
    sourceId: 'opaque:수동',
    sourceRevision: 1,
    sourceContentHash: 'a'.repeat(64),
  },
  { kind: 'resource_deleted', targetId: target, resourceAccessRevision: 2 },
  { kind: 'gallery_media_deleted', targetId: target, galleryAccessRevision: 2 },
  {
    kind: 'healthkit_consent_transition',
    consentPreviousRevision: null,
    consentPreviousGranted: null,
    consentRevision: 1,
    consentGranted: false,
  },
  {
    kind: 'ai_consent_transition',
    consentPreviousRevision: 1,
    consentPreviousGranted: true,
    consentRevision: 2,
    consentGranted: false,
  },
  {
    schemaVersion: 5,
    kind: 'app_consent_transition',
    consentPreviousRevision: 1,
    consentPreviousGranted: true,
    consentRevision: 2,
    consentGranted: false,
  },
  { kind: 'check_in_deleted', targetId: target, checkInRevision: 2 },
  {
    kind: 'resource_share_revoked',
    targetId: target,
    shareId: other,
    shareGrantedAccessRevision: 1,
    shareRevokedAccessRevision: 2,
  },
  {
    schemaVersion: 2,
    kind: 'resource_share_revoked',
    targetId: target,
    shareId: other,
    shareGrantedAccessRevision: 1,
    shareRevokedAccessRevision: 2,
    shareCauseKind: 'resource_deleted',
    shareCauseEventId: id,
  },
  {
    kind: 'course_share_revoked',
    targetId: target,
    courseShareId: other,
    courseShareEpoch: 1,
    courseShareCourseRevision: 1,
  },
  {
    schemaVersion: 2,
    kind: 'course_share_revoked',
    targetId: target,
    courseShareId: other,
    courseShareEpoch: 1,
    courseShareCourseRevision: 1,
    courseShareRevokeReason: 'owner',
    courseShareAuditId: id,
    courseShareAuditOccurredAt: '2026-10-01 12:34:56.654321+00',
  },
  ...['intake_entry_deleted', 'recovery_action_deleted'].flatMap((kind) => [
    { kind, targetId: target, actualDeletionRevision: 2 },
    {
      schemaVersion: 2,
      kind,
      targetId: target,
      actualDeletionRevision: 2,
      actualPreviousRevisionId: id,
      actualDeletedRevisionId: other,
    },
  ]),
  ...['healthkit_workout_deregistration_pending', 'healthkit_workout_deregistration_released'].map(
    (kind) => ({
      schemaVersion: 3,
      kind,
      targetId: target,
      healthKitClaimEpoch: id,
      healthKitOperationId: other,
      healthKitConsentRevision: 1,
      healthKitRegistryPreviousRevision: 0,
      healthKitRegistryRevision: 1,
      healthKitObjectScopes: [{ kind: 'activity', id: target }],
    }),
  ),
  ...['race_event_deleted', 'race_result_deleted', 'training_best_deleted'].map((kind) => ({
    schemaVersion: 4,
    kind,
    targetId: target,
    racePreviousRevision: 1,
    raceDeletedRevision: 2,
  })),
  {
    schemaVersion: 6,
    kind: 'manual_review_source_suppressed',
    manualReviewSourceKind: 'race-event',
    manualReviewSourceId: target,
    manualReviewVersionScope: 'exact_version',
    manualReviewVersionKey: '2',
  },
  {
    schemaVersion: 6,
    kind: 'manual_review_source_suppressed',
    manualReviewSourceKind: 'plan-snapshot',
    manualReviewSourceId: target,
    manualReviewVersionScope: 'all_versions',
    manualReviewVersionKey: null,
  },
  {
    schemaVersion: 7,
    kind: 'manual_review_source_suppressed_v2',
    sourceIdentity: { kind: 'race-event', sourceId: target, revision: 2 },
    versionScope: 'exact_identity',
  },
];

it.each(cases)(
  'roundtrips valid synthetic protocol $kind/$schemaVersion with exact 46 columns and microseconds',
  (fields) => {
    const original = { ...base, ...fields };
    const physical = encodeRestoreSuppressionPhysicalRowV7(original);
    expect(Object.keys(physical)).toEqual(suppressionRecordColumnNamesV7());
    expect(physical.occurred_at).toBe('2026-10-01T12:34:56.123456Z');
    expect(physical.event_id).toBe(id);
    expect(decodeRestoreSuppressionPhysicalRowV7(physical)).toEqual(original);
    const text = new Map<string, string | null>(
      Object.entries(physical).map(([key, value]) => [
        key,
        value === null
          ? null
          : typeof value === 'boolean'
            ? value
              ? 't'
              : 'f'
            : key === 'occurred_at' || key === 'course_share_audit_occurred_at'
              ? String(value).replace('T', ' ').replace('Z', '+00')
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value),
      ]),
    );
    expect(decodeSuppressionRecordColumnsV7(text)).toEqual(original);
  },
);

it('separates active fields and leaves every inactive original field SQL NULL', () => {
  const row = encodeRestoreSuppressionPhysicalRowV7({
    ...base,
    schemaVersion: 7,
    kind: 'manual_review_source_suppressed_v2',
    sourceIdentity: { kind: 'race-event', sourceId: target, revision: 2 },
    versionScope: 'all_versions',
  });
  expect(
    Object.entries(row)
      .filter(([, value]) => value !== null)
      .map(([key]) => key),
  ).toEqual([
    'event_id',
    'record_version',
    'athlete_id',
    'kind',
    'occurred_at',
    'manual_review_v2_source_identity',
    'manual_review_v2_version_scope',
  ]);
  expect(() => decodeRestoreSuppressionPhysicalRowV7({ ...row, target_id: target })).toThrow();
});
it.each([
  ['2026-01-01 00:00:00.000001+09', '2025-12-31T15:00:00.000001Z'],
  ['2026-01-01 00:00:00.999999-05:30', '2026-01-01T05:30:00.999999Z'],
  ['2026-01-01 00:00:00+00', '2026-01-01T00:00:00.000000Z'],
  ['2026-01-01 00:00:00.1+00', '2026-01-01T00:00:00.100000Z'],
])(
  'normalizes integral timezone offset without discarding fractional digits %s',
  (occurredAt, expected) => {
    const row = encodeRestoreSuppressionPhysicalRowV7({
      ...base,
      kind: 'tenant_erased',
      occurredAt,
    });
    expect(row.occurred_at).toBe(expected);
    expect(
      encodeRestoreSuppressionPhysicalRowV7(decodeRestoreSuppressionPhysicalRowV7(row)),
    ).toEqual(row);
  },
);
it('preserves all source tuple fields and false/null independently', () => {
  const activity = encodeRestoreSuppressionPhysicalRowV7({ ...base, ...cases[2] });
  expect(activity).toMatchObject({
    activity_revision: 2,
    source_kind: 'manual',
    source_id: 'opaque:수동',
    source_revision: 1,
    source_content_hash: 'a'.repeat(64),
  });
  const initial = encodeRestoreSuppressionPhysicalRowV7({ ...base, ...cases[5] });
  expect(initial).toMatchObject({
    consent_previous_revision: null,
    consent_previous_granted: null,
    consent_granted: false,
  });
});
it('validates a fresh clone and does not mutate the observed source identity', () => {
  const sourceIdentity = { kind: 'race-event', sourceId: target, revision: 2 };
  const raw = {
    ...base,
    schemaVersion: 7,
    kind: 'manual_review_source_suppressed_v2',
    sourceIdentity,
    versionScope: 'exact_identity',
  };
  const row = encodeRestoreSuppressionPhysicalRowV7(raw);
  sourceIdentity.revision = 3;
  expect(row.manual_review_v2_source_identity).toMatchObject({ revision: 2 });
});
it.each([
  { ...base, kind: 'tenant_erased', extra: true },
  { ...base, kind: 'tenant_erased', schemaVersion: 7 },
  { ...base, kind: 'unknown' },
  { ...base, kind: 'activity_deleted', targetId: target },
  { ...base, kind: 'tenant_erased', occurredAt: '2026-02-30 12:00:00+00' },
  { ...base, kind: 'tenant_erased', occurredAt: '2026-01-01 00:00:00.1234567+00' },
  { ...base, kind: 'tenant_erased', eventId: id.toUpperCase() },
  { ...base, kind: 'check_in_deleted', targetId: target, checkInRevision: 2n },
  { ...base, kind: 'check_in_deleted', targetId: target, checkInRevision: '2' },
  { ...base, kind: 'tenant_erased', athleteId: 'x'.repeat(4 * 1024 * 1024) },
])('rejects malformed or unsupported unknown input without coercion', (raw) => {
  expect(() => encodeRestoreSuppressionPhysicalRowV7(raw)).toThrow();
});
it('rejects missing/extra physical columns and non-null payload from a different version', () => {
  const row = encodeRestoreSuppressionPhysicalRowV7({ ...base, kind: 'tenant_erased' });
  const { target_id: _target, ...missing } = row;
  expect(() => decodeRestoreSuppressionPhysicalRowV7(missing)).toThrow();
  expect(() => decodeRestoreSuppressionPhysicalRowV7({ ...row, extra: null })).toThrow();
  expect(() =>
    decodeRestoreSuppressionPhysicalRowV7({ ...row, race_previous_revision: 1 }),
  ).toThrow();
});
it('rejects accessor, sparse, cyclic, symbol and nonplain ingress before execution', () => {
  let calls = 0;
  const getter = {
    ...base,
    kind: 'tenant_erased',
    get extra() {
      calls++;
      return true;
    },
  };
  expect(() => encodeRestoreSuppressionPhysicalRowV7(getter)).toThrow();
  expect(calls).toBe(0);
  const cycle: Record<string, unknown> = { ...base, kind: 'tenant_erased' };
  cycle['extra'] = cycle;
  for (const raw of [
    cycle,
    new Date(),
    { ...base, kind: 'tenant_erased', [Symbol('extra')]: true },
    { ...base, kind: 'tenant_erased', extra: new Array(1) },
  ])
    expect(() => encodeRestoreSuppressionPhysicalRowV7(raw)).toThrow();
});
