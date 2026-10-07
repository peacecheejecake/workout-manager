import { z } from 'zod';
import { raceManualReviewFullCopiedInventoryV2Schema } from './race-manual-review-full-copied-inventory-v2.js';
import {
  suppressionRecordColumnNamesV6,
  validateSuppressionOccurredAt,
  validateSuppressionRecord,
  type SuppressionRecord,
} from './restore-suppression-records.js';

const byteLimit = 4 * 1024 * 1024;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const manualReviewSourceIdentityV7Schema =
  raceManualReviewFullCopiedInventoryV2Schema.out.shape.refs.element.shape.identity;
export const suppressionRecordV7Schema = z.strictObject({
  schemaVersion: z.literal(7),
  eventId: uuid,
  athleteId: z.string().refine((id) => {
    const chars = [...id];
    return (
      chars.length >= 1 &&
      chars.length <= 200 &&
      chars.every((c) => {
        const n = c.codePointAt(0);
        return n !== undefined && n >= 32 && n !== 127;
      })
    );
  }),
  kind: z.literal('manual_review_source_suppressed_v2'),
  occurredAt: z.string().refine((value) => {
    try {
      validateSuppressionOccurredAt(value);
      return true;
    } catch {
      return false;
    }
  }),
  sourceIdentity: manualReviewSourceIdentityV7Schema,
  versionScope: z.enum(['exact_identity', 'all_versions']),
});
export type SuppressionRecordV7 = z.infer<typeof suppressionRecordV7Schema>;
export type SuppressionRecordThroughV7 = SuppressionRecord | SuppressionRecordV7;

// Parsing is structural. It never authenticates an original event, archive, or tail.
function assertBoundedPlain(value: unknown): void {
  let visits = 0;
  let rawBytes = 0;
  const active = new WeakSet<object>();
  function visit(v: unknown, depth: number): void {
    if (++visits > byteLimit + 1 || depth > 64) throw new Error('PGOUTPUT_INVALID_RECORD');
    rawBytes += typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 1;
    if (rawBytes > byteLimit) throw new Error('PGOUTPUT_INVALID_RECORD');
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return;
    if (typeof v !== 'object' || active.has(v) || Object.getOwnPropertySymbols(v).length)
      throw new Error('PGOUTPUT_INVALID_RECORD');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
      throw new Error('PGOUTPUT_INVALID_RECORD');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      throw new Error('PGOUTPUT_INVALID_RECORD');
    active.add(v);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      rawBytes += Buffer.byteLength(key, 'utf8');
      if (rawBytes > byteLimit) throw new Error('PGOUTPUT_INVALID_RECORD');
      if (!d.enumerable || !('value' in d)) throw new Error('PGOUTPUT_INVALID_RECORD');
      visit(d.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > byteLimit)
    throw new Error('PGOUTPUT_INVALID_RECORD');
}
export function validateSuppressionRecordV7(input: unknown): SuppressionRecordV7 {
  assertBoundedPlain(input);
  const result = suppressionRecordV7Schema.safeParse(input);
  if (!result.success) throw new Error('PGOUTPUT_INVALID_RECORD');
  return result.data;
}

export function suppressionRecordColumnNamesV7(): readonly string[] {
  return [
    ...suppressionRecordColumnNamesV6(),
    'manual_review_v2_source_identity',
    'manual_review_v2_version_scope',
  ];
}
/** Explicit physical successor decoder. Legacy callers/column profiles stay unchanged. */
export function decodeSuppressionRecordColumnsV7(
  values: ReadonlyMap<string, string | null>,
): SuppressionRecordThroughV7 {
  const names = suppressionRecordColumnNamesV7();
  if (values.size !== names.length || names.some((name) => !values.has(name)))
    throw new Error('PGOUTPUT_SCHEMA_CHANGED');
  let bytes = 0;
  for (const [key, value] of values) {
    if (typeof key !== 'string' || (value !== null && typeof value !== 'string'))
      throw new Error('PGOUTPUT_INVALID_RECORD');
    bytes +=
      Buffer.byteLength(key, 'utf8') + (value === null ? 4 : Buffer.byteLength(value, 'utf8'));
    if (bytes > byteLimit) throw new Error('PGOUTPUT_INVALID_RECORD');
  }
  if (values.get('record_version') !== '7') {
    if (
      values.get('manual_review_v2_source_identity') !== null ||
      values.get('manual_review_v2_version_scope') !== null
    )
      throw new Error('PGOUTPUT_UNEXPECTED_FIELD');
    return validateSuppressionRecord(
      new Map(
        suppressionRecordColumnNamesV6().map((name) => {
          const value = values.get(name);
          if (value === undefined) throw new Error('PGOUTPUT_SCHEMA_CHANGED');
          return [name, value];
        }),
      ),
    );
  }
  const present = new Set([
    'event_id',
    'record_version',
    'athlete_id',
    'kind',
    'occurred_at',
    'manual_review_v2_source_identity',
    'manual_review_v2_version_scope',
  ]);
  for (const [name, value] of values)
    if (!present.has(name) && value !== null) throw new Error('PGOUTPUT_UNEXPECTED_FIELD');
  const rawIdentity = values.get('manual_review_v2_source_identity');
  if (rawIdentity === null || rawIdentity === undefined) throw new Error('PGOUTPUT_INVALID_RECORD');
  let sourceIdentity: unknown;
  try {
    sourceIdentity = JSON.parse(rawIdentity);
  } catch {
    throw new Error('PGOUTPUT_INVALID_RECORD');
  }
  return validateSuppressionRecordV7({
    schemaVersion: 7,
    eventId: values.get('event_id'),
    athleteId: values.get('athlete_id'),
    kind: values.get('kind'),
    occurredAt: values.get('occurred_at'),
    sourceIdentity,
    versionScope: values.get('manual_review_v2_version_scope'),
  });
}

type Identity = z.infer<typeof manualReviewSourceIdentityV7Schema>;
/** Stable identity namespace, not proof that an event was emitted or is authorized. */
function namespace(identity: Identity): readonly string[] {
  const base = [identity.kind, identity.sourceId];
  switch (identity.kind) {
    case 'supplementary-session-copy':
      return [...base, identity.sessionId];
    case 'manual-activity-source':
      return [...base, identity.sourceRecordId];
    case 'checklist-confirmation':
      return [...base, identity.runId, identity.stepId];
    case 'activity-track-descriptor':
      return [...base, identity.trackId];
    case 'routine-timer':
      return [...base, identity.stepId];
    case 'race-event':
    case 'plan-snapshot':
    case 'nutrition-plan-version':
    case 'routine-schedule-version':
    case 'routine-blueprint-version':
    case 'routine-occurrence':
    case 'routine-run':
    case 'session-completion':
    case 'food-definition-version':
    case 'recovery-strategy-version':
    case 'recovery-method-version':
    case 'workout-template-version':
    case 'supplementary-exercise-version':
    case 'resource-text-version':
    case 'activity-overlay':
    case 'activity-canonical-values':
    case 'intake-revision':
    case 'checkin-revision':
    case 'course-revision':
    case 'race-timing-pin-fragment':
    case 'course-head-descriptor':
    case 'gallery-descriptor':
      return base;
    default: {
      const unreachable: never = identity;
      void unreachable;
      throw new Error('PGOUTPUT_UNKNOWN_EVENT');
    }
  }
}
export function suppressionIdentityMatchesV7(record: unknown, copiedIdentity: unknown): boolean {
  const event = validateSuppressionRecordV7(record);
  assertBoundedPlain(copiedIdentity);
  const identity = manualReviewSourceIdentityV7Schema.safeParse(copiedIdentity);
  if (!identity.success) throw new Error('PGOUTPUT_INVALID_RECORD');
  return event.versionScope === 'exact_identity'
    ? JSON.stringify(event.sourceIdentity) === JSON.stringify(identity.data)
    : JSON.stringify(namespace(event.sourceIdentity)) === JSON.stringify(namespace(identity.data));
}
