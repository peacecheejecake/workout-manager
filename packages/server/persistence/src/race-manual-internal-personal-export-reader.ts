import { z } from 'zod';
import type { Transaction } from './database.js';
import { RetainedPersonalExportError } from './retained-personal-export.js';
import {
  renderRaceManualInternalPersonalExport,
  RaceManualInternalPersonalExportError,
} from './race-manual-internal-personal-export-renderer.js';

const maximum = 8 * 1024 * 1024;
const signature = 'public.read_manual_race_internal_personal_export_v1(integer)';
function fail(code: RetainedPersonalExportError['code']): never {
  throw new RetainedPersonalExportError(code);
}
// Small driver envelopes are strict plain records; accessors are never invoked.
function row(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('CORRUPT');
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) fail('CORRUPT');
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(String(key))))
    fail('CORRUPT');
  return Object.fromEntries(
    fields.map((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('CORRUPT');
      const value: unknown = descriptor.value;
      return [field, value];
    }),
  );
}
function bounded(raw: unknown, limit: number): void {
  let bytes = 0,
    visits = 0;
  const ancestors = new Set<object>();
  function charge(text: string) {
    if (text.length > limit - bytes) fail('TOO_LARGE');
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > limit) fail('TOO_LARGE');
  }
  function visit(value: unknown, depth: number): void {
    // Every JSON value occupies at least one UTF8 byte, including containers.
    // This is a lower bound, not a substitute for exact escaped bytes below.
    if (++visits > limit) fail('TOO_LARGE');
    if (depth > 64) fail('CORRUPT');
    if (typeof value === 'string') return charge(value);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || ancestors.has(value)) fail('CORRUPT');
    const array = Array.isArray(value),
      prototype: unknown = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      fail('CORRUPT');
    const keys = Reflect.ownKeys(value);
    if (keys.length > limit) fail('TOO_LARGE');
    if (array && keys.length !== value.length + 1) fail('CORRUPT');
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
      )
        fail('CORRUPT');
      // Array index keys are not serialized JSON field names.
      if (!array) charge(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('CORRUPT');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(raw, 0);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > limit) fail('TOO_LARGE');
}
const capabilitySchema = z.strictObject({ installed: z.boolean(), executable: z.boolean() });
const responseSchema = z.strictObject({
  bytes: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(16),
  source: z.unknown(),
});
const sqlFailureSchema = z.object({ code: z.string().optional(), message: z.string().optional() });

/** Same owned snapshot transaction only: SQL129 enforces tenant and reader
 * fences. The capability probe is availability, never processing permission.
 * Debit measured raw JSONB UTF8 once before historical safe projection; no
 * current source recapture, raw body return or accounting of renderer copies.
 * The whole-account caller must still enforce its combined output byte bound. */
export async function readRaceManualInternalPersonalExportV1In(
  tx: Transaction,
  byteLimit = maximum,
  onMeasured?: (bytes: number) => void,
) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > maximum) fail('CORRUPT');
  try {
    const probe = await tx.query(
      `SELECT to_regprocedure($1::text) IS NOT NULL AS installed,
      CASE WHEN to_regprocedure($1::text) IS NULL THEN false
       ELSE has_function_privilege(current_user,to_regprocedure($1::text),'EXECUTE') END AS executable`,
      [signature],
    );
    if (probe.rows.length !== 1) fail('CORRUPT');
    const capability = capabilitySchema.safeParse(row(probe.rows[0], ['installed', 'executable']));
    if (!capability.success) fail('CORRUPT');
    if (!capability.data.installed || !capability.data.executable) fail('UNSUPPORTED');
    const observed = await tx.query(
      `WITH observed AS MATERIALIZED (SELECT public.read_manual_race_internal_personal_export_v1($1::integer) AS source),
      measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed)
      SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`,
      [byteLimit],
    );
    if (observed.rows.length !== 1) fail('CORRUPT');
    const response = responseSchema.safeParse(row(observed.rows[0], ['bytes', 'source']));
    if (!response.success) fail('CORRUPT');
    if (BigInt(response.data.bytes) > BigInt(byteLimit)) fail('TOO_LARGE');
    if (response.data.source === null) fail('CORRUPT');
    onMeasured?.(Number(response.data.bytes));
    bounded(response.data.source, Math.min(byteLimit, Number(response.data.bytes)));
    return renderRaceManualInternalPersonalExport(response.data.source);
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    if (
      error instanceof RaceManualInternalPersonalExportError &&
      error.code === 'INTERNAL_MANUAL_EXPORT_LIMIT'
    )
      fail('TOO_LARGE');
    // No raw SQL, private payload or driver detail escapes the read boundary.
    try {
      const failure = sqlFailureSchema.safeParse(error);
      if (failure.success) {
        if (failure.data.message === 'MANUAL_INTERNAL_EXPORT_TOO_LARGE') fail('TOO_LARGE');
        if (failure.data.code === '42883' || failure.data.code === '42501') fail('UNSUPPORTED');
      }
    } catch (failure) {
      if (failure instanceof RetainedPersonalExportError) throw failure;
    }
    fail('CORRUPT');
  }
}
