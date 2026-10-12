import { z } from 'zod';
import { validateSuppressionOccurredAt } from './restore-suppression-records.js';
import {
  decodeSuppressionRecordColumnsV7,
  suppressionRecordColumnNamesV7,
  type SuppressionRecordThroughV7,
} from './restore-suppression-records-v7.js';

// SQL145 successor record: restore_suppression_event record_version 8, kind
// 'gallery_album_deleted'. target_id is the album id and gallery_access_revision is the
// album's deleted revision; every other event column is NULL. The physical column roster
// is the unchanged installed116 V7 roster (SQL145 adds no column). Parsing is structural
// only: it never authenticates an original event, archive, slot or tail.
const byteLimit = 4 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(uuidPattern);
export const suppressionRecordV8Schema = z.strictObject({
  schemaVersion: z.literal(8),
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
  kind: z.literal('gallery_album_deleted'),
  occurredAt: z.string().refine((value) => {
    try {
      validateSuppressionOccurredAt(value);
      return true;
    } catch {
      return false;
    }
  }),
  targetId: uuid,
  // SQL145 branch: gallery_access_revision BETWEEN 2 AND 2147483646.
  galleryAccessRevision: z.number().int().min(2).max(2147483646),
});
export type SuppressionRecordV8 = z.infer<typeof suppressionRecordV8Schema>;
export type SuppressionRecordThroughV8 = SuppressionRecordThroughV7 | SuppressionRecordV8;

/** A V8 DTO is flat: one plain object of bounded primitive own data properties. */
function assertFlatPlain(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    throw new Error('PGOUTPUT_INVALID_RECORD');
  let bytes = 0;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor))
      throw new Error('PGOUTPUT_INVALID_RECORD');
    const v: unknown = descriptor.value;
    if (
      v !== null &&
      typeof v !== 'string' &&
      typeof v !== 'boolean' &&
      !(typeof v === 'number' && Number.isFinite(v))
    )
      throw new Error('PGOUTPUT_INVALID_RECORD');
    bytes += Buffer.byteLength(key, 'utf8') + (typeof v === 'string' ? Buffer.byteLength(v) : 8);
    if (bytes > byteLimit) throw new Error('PGOUTPUT_INVALID_RECORD');
  }
}

export function validateSuppressionRecordV8(input: unknown): SuppressionRecordV8 {
  assertFlatPlain(input);
  const result = suppressionRecordV8Schema.safeParse(input);
  if (!result.success) throw new Error('PGOUTPUT_INVALID_RECORD');
  return result.data;
}

/** Unchanged installed116 physical roster: SQL145 adds no event column. */
export function suppressionRecordColumnNamesV8(): readonly string[] {
  return [...suppressionRecordColumnNamesV7()];
}

const v8Columns = new Set([
  'event_id',
  'record_version',
  'athlete_id',
  'kind',
  'occurred_at',
  'target_id',
  'gallery_access_revision',
]);

/** Explicit successor decoder. Record versions 1-7 are decoded by the unchanged V7
 * decoder; version 8 only as the exact SQL145 branch; any other version fails closed. */
export function decodeSuppressionRecordColumnsV8(
  values: ReadonlyMap<string, string | null>,
): SuppressionRecordThroughV8 {
  const names = suppressionRecordColumnNamesV8();
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
  if (values.get('record_version') !== '8') {
    if (values.get('kind') === 'gallery_album_deleted') throw new Error('PGOUTPUT_UNKNOWN_EVENT');
    return decodeSuppressionRecordColumnsV7(values);
  }
  if (values.get('kind') !== 'gallery_album_deleted') throw new Error('PGOUTPUT_UNKNOWN_EVENT');
  for (const [name, value] of values)
    if (!v8Columns.has(name) && value !== null) throw new Error('PGOUTPUT_UNEXPECTED_FIELD');
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === null || value === undefined) throw new Error('PGOUTPUT_INVALID_RECORD');
    return value;
  };
  const rawRevision = required('gallery_access_revision');
  if (!/^[1-9]\d{0,9}$/.test(rawRevision)) throw new Error('PGOUTPUT_INVALID_RECORD');
  const eventId = required('event_id');
  const targetId = required('target_id');
  if (!uuidPattern.test(eventId) || !uuidPattern.test(targetId))
    throw new Error('PGOUTPUT_INVALID_RECORD');
  return validateSuppressionRecordV8({
    schemaVersion: 8,
    eventId,
    athleteId: required('athlete_id'),
    kind: 'gallery_album_deleted',
    occurredAt: validateSuppressionOccurredAt(required('occurred_at')),
    targetId,
    galleryAccessRevision: Number(rawRevision),
  });
}
