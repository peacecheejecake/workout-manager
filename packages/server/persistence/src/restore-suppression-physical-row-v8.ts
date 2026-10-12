import { validateSuppressionOccurredAt } from './restore-suppression-records.js';
import {
  decodeRestoreSuppressionPhysicalRowV7,
  encodeRestoreSuppressionPhysicalRowV7,
  type RestoreSuppressionPhysicalRowV7,
} from './restore-suppression-physical-row-v7.js';
import {
  decodeSuppressionRecordColumnsV8,
  suppressionRecordColumnNamesV8,
  validateSuppressionRecordV8,
  type SuppressionRecordThroughV8,
} from './restore-suppression-records-v8.js';

// The same 46-column installed116 physical row (SQL145 adds no column). Rows of record
// versions 1-7 go through the unchanged V7 physical codec; record_version 8 rows are
// accepted only as the exact SQL145 album-deletion branch. Structural only: no event
// authority, id or timestamp is minted.
export type RestoreSuppressionPhysicalRowV8 = RestoreSuppressionPhysicalRowV7;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const v8Present = new Set([
  'event_id',
  'record_version',
  'athlete_id',
  'kind',
  'occurred_at',
  'target_id',
  'gallery_access_revision',
]);

function invalid(): never {
  throw Error('SUPPRESSION_PHYSICAL_INVALID');
}
function isRecordVersion8(raw: unknown, field: string): boolean {
  // Data descriptors only: an accessor is never invoked and falls through to V7 rejection.
  if (typeof raw !== 'object' || raw === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(raw, field);
  return descriptor !== undefined && 'value' in descriptor && descriptor.value === 8;
}
/** Same instant normalization as the V7 codec (fraction preserved independently of Date). */
function physicalInstant(raw: string): string {
  validateSuppressionOccurredAt(raw);
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-]\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return invalid();
  const [, date, time, fraction, offset, minutes] = match;
  const whole = new Date(Date.parse(`${date}T${time}${offset}:${minutes ?? '00'}`)).toISOString();
  if (!/^\d{4}-/.test(whole) || whole.startsWith('0000-')) return invalid();
  return `${whole.slice(0, 19)}.${(fraction ?? '').padEnd(6, '0')}Z`;
}
function sqlInstant(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, -1)}+00`;
}

/** Exact V8 row: plain object, exactly the 46 roster keys, only the album branch non-NULL. */
function checkedV8Row(raw: unknown): Map<string, string | null> {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Object.getOwnPropertySymbols(raw).length
  )
    return invalid();
  const names = suppressionRecordColumnNamesV8();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Object.keys(descriptors);
  if (keys.length !== names.length || names.some((name) => !(name in descriptors)))
    return invalid();
  const columns = new Map<string, string | null>();
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
    const value: unknown = descriptor.value;
    if (!v8Present.has(name)) {
      if (value !== null) throw Error('SUPPRESSION_PHYSICAL_INVALID');
      columns.set(name, null);
      continue;
    }
    switch (name) {
      case 'event_id':
      case 'target_id':
        if (typeof value !== 'string' || !uuid.test(value)) return invalid();
        columns.set(name, value);
        break;
      case 'record_version':
        if (value !== 8) return invalid();
        columns.set(name, '8');
        break;
      case 'athlete_id':
      case 'kind':
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) return invalid();
        columns.set(name, value);
        break;
      case 'occurred_at':
        if (typeof value !== 'string' || !utc.test(value)) return invalid();
        columns.set(name, sqlInstant(value));
        break;
      case 'gallery_access_revision':
        if (typeof value !== 'number' || !Number.isInteger(value)) return invalid();
        columns.set(name, String(value));
        break;
      default:
        return invalid();
    }
  }
  return columns;
}

/** Convert an already observed original DTO. Versions 1-7 delegate to the V7 codec. */
export function encodeRestoreSuppressionPhysicalRowV8(
  raw: unknown,
): RestoreSuppressionPhysicalRowV8 {
  if (!isRecordVersion8(raw, 'schemaVersion')) return encodeRestoreSuppressionPhysicalRowV7(raw);
  const record = validateSuppressionRecordV8(raw);
  const row: Record<string, unknown> = Object.fromEntries(
    suppressionRecordColumnNamesV8().map((name) => [name, null]),
  );
  Object.assign(row, {
    event_id: record.eventId,
    record_version: 8,
    athlete_id: record.athleteId,
    kind: record.kind,
    occurred_at: physicalInstant(record.occurredAt),
    target_id: record.targetId,
    gallery_access_revision: record.galleryAccessRevision,
  });
  // The independent reverse decoder enforces the exact branch before the row is returned.
  decodeRestoreSuppressionPhysicalRowV8(row);
  // Shape is the V7 46-column row; record_version 8 is admitted only by this V8 boundary.
  return row as RestoreSuppressionPhysicalRowV8;
}

/** Reverse read boundary for the unchanged 46-column physical format through record 8. */
export function decodeRestoreSuppressionPhysicalRowV8(raw: unknown): SuppressionRecordThroughV8 {
  if (!isRecordVersion8(raw, 'record_version')) return decodeRestoreSuppressionPhysicalRowV7(raw);
  try {
    return decodeSuppressionRecordColumnsV8(checkedV8Row(raw));
  } catch (error) {
    if (error instanceof Error && error.message === 'SUPPRESSION_PHYSICAL_INVALID') throw error;
    throw Error('SUPPRESSION_PHYSICAL_INVALID');
  }
}
