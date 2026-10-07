import { expect, it } from 'vitest';
import {
  suppressionRecordColumnNamesV6,
  validateSuppressionRecord,
} from '../src/restore-suppression-records.js';
import {
  decodeSuppressionRecordColumnsV7,
  suppressionIdentityMatchesV7,
  suppressionRecordColumnNamesV7,
  validateSuppressionRecordV7,
} from '../src/restore-suppression-records-v7.js';

const id = 'abcdefab-1234-4123-8123-abcdefabcdef';
const version = 'bbbbbbbb-1234-4123-8123-abcdefabcdef';
const event = {
  schemaVersion: 7,
  eventId: id,
  athleteId: '합성-tenant',
  kind: 'manual_review_source_suppressed_v2',
  occurredAt: '2026-10-07 12:34:56.123456+00',
  versionScope: 'exact_identity',
};
const identities = [
  { kind: 'race-event', sourceId: id, revision: 1 },
  { kind: 'plan-snapshot', sourceId: id, version: 2 },
  ...[
    'nutrition-plan-version',
    'routine-schedule-version',
    'routine-blueprint-version',
    'food-definition-version',
    'recovery-strategy-version',
    'recovery-method-version',
    'workout-template-version',
    'supplementary-exercise-version',
    'resource-text-version',
  ].map((kind) => ({ kind, sourceId: id, versionId: version })),
  { kind: 'routine-occurrence', sourceId: id },
  { kind: 'routine-run', sourceId: id, revision: 0 },
  { kind: 'session-completion', sourceId: 'opaque session', planVersionId: version, revision: 2 },
  { kind: 'supplementary-session-copy', sourceId: id, sessionId: 'session' },
  { kind: 'manual-activity-source', sourceId: id, sourceRecordId: 'record', sourceRevision: 0 },
  { kind: 'activity-overlay', sourceId: id, revision: 0 },
  { kind: 'activity-canonical-values', sourceId: id, revision: 1 },
  { kind: 'intake-revision', sourceId: '섭취 "\\ opaque', revisionId: version },
  { kind: 'checkin-revision', sourceId: id, revision: 1 },
  {
    kind: 'checklist-confirmation',
    sourceId: 'confirmation',
    revisionId: version,
    runId: 'run',
    stepId: 'step',
  },
  { kind: 'course-revision', sourceId: id, revisionId: version, revision: 0 },
  { kind: 'activity-track-descriptor', sourceId: id, trackId: version, revision: 0 },
  { kind: 'race-timing-pin-fragment', sourceId: id, revision: 1 },
  { kind: 'course-head-descriptor', sourceId: id, revision: 1 },
  { kind: 'gallery-descriptor', sourceId: id, accessRevision: 0 },
  { kind: 'routine-timer', sourceId: 'run', stepId: 'step', revision: 0 },
];
it.each(identities)('retains full typed identity: $kind', (sourceIdentity) => {
  const input = { ...event, sourceIdentity };
  expect(validateSuppressionRecordV7(input)).toEqual(input);
  expect(suppressionIdentityMatchesV7(input, sourceIdentity)).toBe(true);
  expect(validateSuppressionRecordV7(input)).not.toHaveProperty('authenticated');
});
it('uses exact identity or explicit all-version source namespace', () => {
  const sourceIdentity = { kind: 'intake-revision', sourceId: '섭취', revisionId: id };
  const later = { ...sourceIdentity, revisionId: version };
  expect(suppressionIdentityMatchesV7({ ...event, sourceIdentity }, later)).toBe(false);
  expect(
    suppressionIdentityMatchesV7({ ...event, sourceIdentity, versionScope: 'all_versions' }, later),
  ).toBe(true);
  expect(
    suppressionIdentityMatchesV7(
      { ...event, sourceIdentity, versionScope: 'all_versions' },
      { ...later, sourceId: '다른 섭취' },
    ),
  ).toBe(false);
});
it.each([
  [
    { kind: 'supplementary-session-copy', sourceId: id, sessionId: 'a' },
    { kind: 'supplementary-session-copy', sourceId: id, sessionId: 'b' },
  ],
  [
    { kind: 'manual-activity-source', sourceId: id, sourceRecordId: 'a', sourceRevision: 1 },
    { kind: 'manual-activity-source', sourceId: id, sourceRecordId: 'b', sourceRevision: 2 },
  ],
  [
    { kind: 'routine-timer', sourceId: 'run', stepId: 'a', revision: 1 },
    { kind: 'routine-timer', sourceId: 'run', stepId: 'b', revision: 2 },
  ],
  [
    { kind: 'activity-track-descriptor', sourceId: id, trackId: id, revision: 1 },
    { kind: 'activity-track-descriptor', sourceId: id, trackId: version, revision: 2 },
  ],
  [
    { kind: 'checklist-confirmation', sourceId: 'c', revisionId: id, runId: 'a', stepId: 's' },
    { kind: 'checklist-confirmation', sourceId: 'c', revisionId: version, runId: 'b', stepId: 's' },
  ],
])('does not widen an all-version namespace', (sourceIdentity, other) => {
  expect(
    suppressionIdentityMatchesV7({ ...event, sourceIdentity, versionScope: 'all_versions' }, other),
  ).toBe(false);
});
function physical(extra: Record<string, string | null>) {
  const values = new Map<string, string | null>(
    suppressionRecordColumnNamesV7().map((name) => [name, null]),
  );
  for (const [key, value] of Object.entries({
    event_id: id,
    athlete_id: event.athleteId,
    occurred_at: event.occurredAt,
    ...extra,
  }))
    values.set(key, value);
  return values;
}
it('decodes the explicit physical V7 profile and rejects field mixing/schema drift', () => {
  const sourceIdentity = { kind: 'routine-timer', sourceId: 'run', stepId: 'step', revision: 0 };
  const values = physical({
    record_version: '7',
    kind: event.kind,
    manual_review_v2_source_identity: JSON.stringify(sourceIdentity),
    manual_review_v2_version_scope: 'exact_identity',
  });
  expect(decodeSuppressionRecordColumnsV7(values)).toEqual({ ...event, sourceIdentity });
  values.set('source_id', 'legacy-nonnull');
  expect(() => decodeSuppressionRecordColumnsV7(values)).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
  values.set('source_id', null);
  values.set('unrecognized', null);
  expect(() => decodeSuppressionRecordColumnsV7(values)).toThrow('PGOUTPUT_SCHEMA_CHANGED');
});
it.each([
  { record_version: '1', kind: 'tenant_erased' },
  {
    record_version: '2',
    kind: 'intake_entry_deleted',
    target_id: id,
    actual_deletion_revision: '2',
    actual_previous_revision_id: id,
    actual_deleted_revision_id: version,
  },
  {
    record_version: '3',
    kind: 'healthkit_workout_deregistration_pending',
    target_id: id,
    healthkit_claim_epoch: id,
    healthkit_operation_id: version,
    healthkit_consent_revision: '1',
    healthkit_registry_previous_revision: '0',
    healthkit_registry_revision: '1',
    healthkit_object_scopes: '[]',
  },
  {
    record_version: '4',
    kind: 'race_event_deleted',
    target_id: id,
    race_previous_revision: '1',
    race_deleted_revision: '2',
  },
  {
    record_version: '5',
    kind: 'app_consent_transition',
    consent_revision: '1',
    consent_granted: 't',
  },
  {
    record_version: '6',
    kind: 'manual_review_source_suppressed',
    manual_review_source_kind: 'race-event',
    manual_review_source_id: id,
    manual_review_version_scope: 'exact_version',
    manual_review_version_key: '1',
  },
])('preserves legacy validation in a successor physical row: $record_version', (extra) => {
  const values = physical(extra);
  const old = new Map(
    suppressionRecordColumnNamesV6().map((name) => [name, values.get(name) ?? null]),
  );
  expect(decodeSuppressionRecordColumnsV7(values)).toEqual(validateSuppressionRecord(old));
  values.set('manual_review_v2_version_scope', 'all_versions');
  expect(() => decodeSuppressionRecordColumnsV7(values)).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
});
it.each([
  { schemaVersion: 6 },
  { versionScope: 'exact_version' },
  { kind: 'manual_review_source_suppressed' },
  { occurredAt: '2026-02-30 12:00:00+00' },
  { occurredAt: 'infinity' },
  { authenticated: true },
  { sourceIdentity: { kind: 'unknown', sourceId: id } },
  { sourceIdentity: { kind: 'routine-run', sourceId: 'run', revision: -1 } },
])('rejects malformed or purported-authority fields', (extra) => {
  expect(() =>
    validateSuppressionRecordV7({ ...event, sourceIdentity: identities[0], ...extra }),
  ).toThrow('PGOUTPUT_INVALID_RECORD');
});
it('rejects getters without running them, cycles, oversized multibyte IDs, and extra identity fields', () => {
  let calls = 0;
  const input = { ...event, sourceIdentity: identities[0] };
  Object.defineProperty(input, 'athleteId', {
    enumerable: true,
    get: () => {
      calls++;
      return 'tenant';
    },
  });
  expect(() => validateSuppressionRecordV7(input)).toThrow();
  expect(calls).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => validateSuppressionRecordV7(cycle)).toThrow();
  expect(() =>
    validateSuppressionRecordV7({
      ...event,
      sourceIdentity: { kind: 'intake-revision', sourceId: '가'.repeat(1400000), revisionId: id },
    }),
  ).toThrow();
  expect(() =>
    validateSuppressionRecordV7({
      ...event,
      sourceIdentity: { ...identities[0], versionId: version },
    }),
  ).toThrow();
});
