import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';

export type FullRestoreJsonV1 =
  null | boolean | number | string | readonly FullRestoreJsonV1[] | FullRestoreRowV1;
export type FullRestoreRowV1 = { readonly [column: string]: FullRestoreJsonV1 };
export type FullRestoreRowPortsV1<T extends FullRestoreRowV1> = Readonly<{
  validateRow: (row: FullRestoreRowV1) => row is T;
  compareNativeKeys: (previous: T, current: T) => -1 | 0 | 1;
}>;
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const relationSchema = createBoundedPlainJsonSchema(4096).pipe(
  z.strictObject({
    schema: identifier,
    relation: identifier,
    physicalCodec: z.literal('postgres-row-jsonb-utc-v1'),
    columnsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    orderingKey: z
      .array(identifier)
      .min(1)
      .max(16)
      .refine((value) => new Set(value).size === value.length),
    maxRows: z.number().int().min(0).max(1000000),
    maxBytes: z.number().int().min(2).max(67108864),
    maxRowBytes: z.number().int().min(2).max(8388608),
  }),
);
const factsSchema = createBoundedPlainJsonSchema(4096).pipe(
  z.strictObject({
    schema: identifier,
    relation: identifier,
    physicalCodec: z.literal('postgres-row-jsonb-utc-v1'),
    columnsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    orderingKey: z.array(identifier).min(1).max(16),
    state: z.enum(['present', 'explicit_empty']),
    rowCount: z.number().int().min(0).max(1000000),
    byteLength: z.number().int().min(2).max(67108864),
    rowsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
export type FullRestoreRowBytesErrorCode =
  | 'ROW_BYTES_CONFIGURATION_INVALID'
  | 'ROW_BYTES_PORTS_INVALID'
  | 'ROW_BYTES_INPUT_INVALID'
  | 'ROW_BYTES_FACTS_MISMATCH'
  | 'ROW_BYTES_BOUND_EXCEEDED'
  | 'ROW_BYTES_ENCODING_INVALID'
  | 'ROW_BYTES_JSON_INVALID'
  | 'ROW_BYTES_ROW_INVALID'
  | 'ROW_BYTES_ORDER_INVALID'
  | 'ROW_BYTES_PORT_FAILED';
export class FullRestoreRowBytesError extends Error {
  constructor(readonly code: FullRestoreRowBytesErrorCode) {
    super(code);
    this.name = 'FullRestoreRowBytesError';
  }
}
function fail(code: FullRestoreRowBytesErrorCode): never {
  throw new FullRestoreRowBytesError(code);
}
function jsonbText(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0) return fail('ROW_BYTES_ROW_INVALID');
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('ROW_BYTES_ROW_INVALID');
    } else if (code >= 0xdc00 && code <= 0xdfff) return fail('ROW_BYTES_ROW_INVALID');
  }
  return value;
}
function frozenRow(value: unknown): FullRestoreJsonV1 {
  if (typeof value === 'string') return jsonbText(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozenRow));
  if (typeof value !== 'object') return fail('ROW_BYTES_ROW_INVALID');
  const row: Record<string, FullRestoreJsonV1> = Object.create(null);
  for (const key of Object.keys(value)) {
    jsonbText(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail('ROW_BYTES_ROW_INVALID');
    Object.defineProperty(row, key, { value: frozenRow(descriptor.value), enumerable: true });
  }
  return Object.freeze(row);
}
function isRow(value: FullRestoreJsonV1): value is FullRestoreRowV1 {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// Compare exact decimal spelling without coercing primary-key or timestamp values.
// Native JSON.parse must not silently round an archived numeric token before a codec sees it.
function decimalIdentity(token: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match || match[2] === undefined) return fail('ROW_BYTES_JSON_INVALID');
  const fraction = match[3] ?? '';
  let digits = (match[2] + fraction).replace(/^0+/, '');
  if (digits.length === 0) return '0';
  let exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length);
  const trimmed = digits.replace(/0+$/, '');
  exponent += BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return `${match[1]}${digits}e${exponent}`;
}
// Reject excessive nesting and top-level row count before JSON.parse allocation.
// JSON syntax itself is subsequently checked by the native parser.
function preflight(text: string, maximumRows: number, maximumRowBytes: number) {
  const frames: { object: boolean; expectingKey: boolean; keys: Set<string> }[] = [];
  let quoted = false,
    escaped = false,
    rows = 0,
    needsRow = true,
    keyStart: number | null = null,
    rowActive = false,
    rowBytes = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const depth = frames.length;
    if (
      !quoted &&
      depth === 1 &&
      needsRow &&
      character !== undefined &&
      !/\s/.test(character) &&
      character !== ']'
    ) {
      if (++rows > maximumRows) fail('ROW_BYTES_BOUND_EXCEEDED');
      needsRow = false;
      rowActive = true;
      rowBytes = 0;
    }
    if (rowActive) {
      const code = text.charCodeAt(index);
      rowBytes +=
        code < 128
          ? 1
          : code < 2048
            ? 2
            : code >= 0xd800 && code <= 0xdbff
              ? 4
              : code >= 0xdc00 && code <= 0xdfff
                ? 0
                : 3;
      if (rowBytes > maximumRowBytes) fail('ROW_BYTES_BOUND_EXCEEDED');
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        quoted = false;
        if (keyStart !== null) {
          let key: unknown;
          try {
            key = JSON.parse(text.slice(keyStart, index + 1));
          } catch {
            return fail('ROW_BYTES_JSON_INVALID');
          }
          const frame = frames.at(-1);
          if (typeof key !== 'string' || !frame || frame.keys.has(key))
            return fail('ROW_BYTES_JSON_INVALID');
          frame.keys.add(key);
          frame.expectingKey = false;
          keyStart = null;
        }
      }
      continue;
    }
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      let end = index + 1;
      while (end < text.length && !/[\s,\]}:]/.test(text[end] ?? '')) {
        if (rowActive && rowBytes + end - index > maximumRowBytes) fail('ROW_BYTES_BOUND_EXCEEDED');
        end++;
      }
      const token = text.slice(index, end);
      let number: unknown;
      try {
        number = JSON.parse(token);
      } catch {
        return fail('ROW_BYTES_JSON_INVALID');
      }
      if (typeof number !== 'number' || !Number.isFinite(number))
        return fail('ROW_BYTES_ROW_INVALID');
      if (decimalIdentity(token) !== decimalIdentity(JSON.stringify(number)))
        return fail('ROW_BYTES_ROW_INVALID');
      if (rowActive) rowBytes += token.length - 1;
      index = end - 1;
    } else if (character === '"') {
      quoted = true;
      if (frames.at(-1)?.expectingKey) keyStart = index;
    } else if (character === '[' || character === '{') {
      frames.push({ object: character === '{', expectingKey: character === '{', keys: new Set() });
      if (frames.length > 64) fail('ROW_BYTES_BOUND_EXCEEDED');
    } else if (character === ']' || character === '}') {
      frames.pop();
      if (frames.length === 1) rowActive = false;
    } else if (character === ',') {
      const frame = frames.at(-1);
      if (frame?.object) frame.expectingKey = true;
      if (depth === 1) needsRow = true;
    }
  }
}
/** Ports must come from independent trusted relation registration. Neither the
 * archive nor this result can register codecs, authenticate or admit a restore.
 * Rows passed to ports are detached, recursively frozen plain values. */
export function createFullRestoreRowBytesValidatorV1<T extends FullRestoreRowV1>(
  rawTrustedRelation: unknown,
  ports: FullRestoreRowPortsV1<T>,
) {
  const parsed = relationSchema.safeParse(rawTrustedRelation);
  if (!parsed.success) return fail('ROW_BYTES_CONFIGURATION_INVALID');
  const relation = parsed.data;
  let validateRow: FullRestoreRowPortsV1<T>['validateRow'];
  let compareNativeKeys: FullRestoreRowPortsV1<T>['compareNativeKeys'];
  try {
    if (
      !Object.isFrozen(ports) ||
      Object.getPrototypeOf(ports) !== Object.prototype ||
      Reflect.ownKeys(ports).length !== 2
    )
      return fail('ROW_BYTES_PORTS_INVALID');
    const validator = Object.getOwnPropertyDescriptor(ports, 'validateRow');
    const comparator = Object.getOwnPropertyDescriptor(ports, 'compareNativeKeys');
    if (
      !validator ||
      !comparator ||
      !Object.hasOwn(validator, 'value') ||
      !Object.hasOwn(comparator, 'value') ||
      typeof validator.value !== 'function' ||
      typeof comparator.value !== 'function'
    )
      return fail('ROW_BYTES_PORTS_INVALID');
    validateRow = validator.value;
    compareNativeKeys = comparator.value;
  } catch {
    return fail('ROW_BYTES_PORTS_INVALID');
  }
  const plainRow = createBoundedPlainJsonSchema(relation.maxRowBytes);
  return Object.freeze({
    validate(rawBytes: unknown, rawFacts: unknown) {
      const facts = factsSchema.safeParse(rawFacts);
      if (!facts.success) return fail('ROW_BYTES_FACTS_MISMATCH');
      const expected = facts.data;
      if (
        expected.schema !== relation.schema ||
        expected.relation !== relation.relation ||
        expected.physicalCodec !== relation.physicalCodec ||
        expected.columnsSha256 !== relation.columnsSha256 ||
        expected.orderingKey.length !== relation.orderingKey.length ||
        expected.orderingKey.some((column, ordinal) => column !== relation.orderingKey[ordinal])
      )
        return fail('ROW_BYTES_FACTS_MISMATCH');
      if (expected.rowCount > relation.maxRows || expected.byteLength > relation.maxBytes)
        return fail('ROW_BYTES_BOUND_EXCEEDED');
      let bytes: Uint8Array;
      try {
        if (
          !(rawBytes instanceof Uint8Array) ||
          Object.getPrototypeOf(rawBytes) !== Uint8Array.prototype ||
          !ArrayBuffer.isView(rawBytes)
        )
          return fail('ROW_BYTES_INPUT_INVALID');
        const prototype = Object.getPrototypeOf(Uint8Array.prototype);
        const length = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get?.call(
          rawBytes,
        );
        const offset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')?.get?.call(
          rawBytes,
        );
        const buffer: unknown = Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get?.call(
          rawBytes,
        );
        if (typeof length !== 'number' || length > relation.maxBytes)
          return fail('ROW_BYTES_BOUND_EXCEEDED');
        if (
          !(buffer instanceof ArrayBuffer) ||
          Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
          Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get?.call(buffer) !==
            false ||
          offset !== 0 ||
          length !==
            Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get?.call(
              buffer,
            ) ||
          Reflect.ownKeys(rawBytes).length !== length
        )
          return fail('ROW_BYTES_INPUT_INVALID');
        bytes = new Uint8Array(length);
        bytes.set(rawBytes); // Own exact immutable-in-closure canonical bytes; no caller iterator.
      } catch (error) {
        if (error instanceof FullRestoreRowBytesError) throw error;
        return fail('ROW_BYTES_INPUT_INVALID');
      }
      if (
        bytes.byteLength !== expected.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== expected.rowsSha256
      )
        return fail('ROW_BYTES_FACTS_MISMATCH');
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return fail('ROW_BYTES_ENCODING_INVALID');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return fail('ROW_BYTES_ENCODING_INVALID');
      }
      if (expected.state === 'explicit_empty' && (text !== '[]' || expected.rowCount !== 0))
        return fail('ROW_BYTES_FACTS_MISMATCH');
      preflight(text, relation.maxRows, relation.maxRowBytes);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return fail('ROW_BYTES_JSON_INVALID');
      }
      if (
        !Array.isArray(raw) ||
        raw.length !== expected.rowCount ||
        (expected.state === 'present' && raw.length === 0)
      )
        return fail('ROW_BYTES_FACTS_MISMATCH');
      const rows: T[] = [];
      for (const entry of raw) {
        if (!plainRow.safeParse(entry).success) return fail('ROW_BYTES_ROW_INVALID');
        const row = frozenRow(entry);
        if (!isRow(row)) return fail('ROW_BYTES_ROW_INVALID');
        try {
          if (validateRow(row) !== true) return fail('ROW_BYTES_ROW_INVALID');
          const previous = rows.at(-1);
          if (previous && compareNativeKeys(previous, row) !== -1)
            return fail('ROW_BYTES_ORDER_INVALID');
          rows.push(row);
        } catch (error) {
          if (error instanceof FullRestoreRowBytesError) throw error;
          return fail('ROW_BYTES_PORT_FAILED');
        }
      }
      return Object.freeze({
        kind: 'validated_full_restore_row_bytes_v1' as const,
        authority: 'none' as const,
        admissionAllowed: false as const,
        schema: relation.schema,
        relation: relation.relation,
        rowCount: rows.length,
        byteLength: bytes.byteLength,
        rowsSha256: expected.rowsSha256,
        rows: Object.freeze(rows),
        // Never expose mutable internal bytes, nor reserialize the source for hash.
        copyCanonicalBytes: () => new Uint8Array(bytes),
      });
    },
  });
}
