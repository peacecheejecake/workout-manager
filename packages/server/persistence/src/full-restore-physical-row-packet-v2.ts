import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  createFullRestorePhysicalCodecV2,
  fullRestorePhysicalCodecV2,
  type FullRestorePhysicalValueV2,
} from './full-restore-physical-codec-v2.js';

export const fullRestorePhysicalRowPacketCodecV2 = 'postgres-tagged-row-packet-v2' as const;
export const fullRestorePhysicalRowPacketLimitsV2 = Object.freeze({
  rows: 5000,
  bytes: 16777216,
  rowBytes: 4194304,
  columns: 1600,
  depth: 64,
});
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = (min: number, max: number) =>
  z.number().int().min(min).max(max).refine(Number.isSafeInteger);
const descriptor = z.strictObject({
  schemaVersion: z.literal(2),
  physicalCodec: z.literal(fullRestorePhysicalCodecV2),
  schema: identifier,
  relation: identifier,
  column: identifier,
  // Actual supported types and scalar descriptor semantics remain codec-owned.
  pgType: z.string().max(100),
  nullable: z.boolean(),
  maxBytes: integer(1, 8388608),
  maxElements: integer(0, 1000000),
});
const registrationSchema = createBoundedPlainJsonSchema(1048576).pipe(
  z.strictObject({
    schemaVersion: z.literal(2),
    physicalCodec: z.literal(fullRestorePhysicalRowPacketCodecV2),
    schema: identifier,
    relation: identifier,
    columnsSha256: digest,
    orderingKey: z.array(identifier).min(1).max(16),
    columns: z.array(descriptor).min(1).max(fullRestorePhysicalRowPacketLimitsV2.columns),
    maxRows: integer(0, fullRestorePhysicalRowPacketLimitsV2.rows),
    maxBytes: integer(2, fullRestorePhysicalRowPacketLimitsV2.bytes),
    maxRowBytes: integer(2, fullRestorePhysicalRowPacketLimitsV2.rowBytes),
  }),
);
const factsSchema = createBoundedPlainJsonSchema(4096).pipe(
  z.strictObject({
    schemaVersion: z.literal(2),
    physicalCodec: z.literal(fullRestorePhysicalRowPacketCodecV2),
    schema: identifier,
    relation: identifier,
    columnsSha256: digest,
    orderingKey: z.array(identifier).min(1).max(16),
    state: z.enum(['present', 'explicit_empty']),
    rowCount: integer(0, fullRestorePhysicalRowPacketLimitsV2.rows),
    byteLength: integer(2, fullRestorePhysicalRowPacketLimitsV2.bytes),
    rowsSha256: digest,
  }),
);
export type FullRestorePhysicalRowPacketErrorCodeV2 =
  | 'PACKET_REGISTRATION_INVALID'
  | 'PACKET_FACTS_INVALID'
  | 'PACKET_INPUT_INVALID'
  | 'PACKET_BOUND_EXCEEDED'
  | 'PACKET_ENCODING_INVALID'
  | 'PACKET_JSON_INVALID'
  | 'PACKET_COLUMNS_INVALID'
  | 'PACKET_VALUE_INVALID'
  | 'PACKET_DUPLICATE_KEY';
export class FullRestorePhysicalRowPacketErrorV2 extends Error {
  constructor(readonly code: FullRestorePhysicalRowPacketErrorCodeV2) {
    super(code);
    this.name = 'FullRestorePhysicalRowPacketErrorV2';
  }
}
function fail(code: FullRestorePhysicalRowPacketErrorCodeV2): never {
  throw new FullRestorePhysicalRowPacketErrorV2(code);
}
export type FullRestorePhysicalRowV2 = Readonly<{
  rowVersion: 2;
  columns: readonly Readonly<{ column: string; value: FullRestorePhysicalValueV2 }>[];
}>;
function ownedBytes(input: unknown, max: number) {
  try {
    if (!(input instanceof Uint8Array) || Object.getPrototypeOf(input) !== Uint8Array.prototype)
      return fail('PACKET_INPUT_INVALID');
    const proto = Object.getPrototypeOf(Uint8Array.prototype);
    const length: unknown = Object.getOwnPropertyDescriptor(proto, 'byteLength')?.get?.call(input);
    const offset: unknown = Object.getOwnPropertyDescriptor(proto, 'byteOffset')?.get?.call(input);
    const buffer: unknown = Object.getOwnPropertyDescriptor(proto, 'buffer')?.get?.call(input);
    if (typeof length !== 'number' || length > max) return fail('PACKET_BOUND_EXCEEDED');
    if (
      !(buffer instanceof ArrayBuffer) ||
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get?.call(buffer) !==
        false ||
      offset !== 0 ||
      length !==
        Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get?.call(buffer) ||
      Reflect.ownKeys(input).length !== length
    )
      return fail('PACKET_INPUT_INVALID');
    const copy = new Uint8Array(length);
    copy.set(input);
    return copy;
  } catch (error) {
    if (error instanceof FullRestorePhysicalRowPacketErrorV2) throw error;
    return fail('PACKET_INPUT_INVALID');
  }
}
function decimalIdentity(token: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match || match[2] === undefined) return fail('PACKET_JSON_INVALID');
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
      if (++rows > maximumRows) fail('PACKET_BOUND_EXCEEDED');
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
      if (rowBytes > maximumRowBytes) fail('PACKET_BOUND_EXCEEDED');
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
            return fail('PACKET_JSON_INVALID');
          }
          const frame = frames.at(-1);
          if (typeof key !== 'string' || !frame || frame.keys.has(key))
            return fail('PACKET_JSON_INVALID');
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
        if (rowActive && rowBytes + end - index > maximumRowBytes) fail('PACKET_BOUND_EXCEEDED');
        end++;
      }
      const token = text.slice(index, end);
      let number: unknown;
      try {
        number = JSON.parse(token);
      } catch {
        return fail('PACKET_JSON_INVALID');
      }
      if (typeof number !== 'number' || !Number.isFinite(number))
        return fail('PACKET_VALUE_INVALID');
      if (decimalIdentity(token) !== decimalIdentity(JSON.stringify(number)))
        return fail('PACKET_VALUE_INVALID');
      if (rowActive) rowBytes += token.length - 1;
      index = end - 1;
    } else if (character === '"') {
      quoted = true;
      if (frames.at(-1)?.expectingKey) keyStart = index;
    } else if (character === '[' || character === '{') {
      frames.push({ object: character === '{', expectingKey: character === '{', keys: new Set() });
      if (frames.length > 64) fail('PACKET_BOUND_EXCEEDED');
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

/** Independent registration is supplied by the configured caller, never an archive
 * descriptor. This validates tagged physical structure, not native order, source
 * authentication, complete inventory, domain correctness or restore admission. */
export function createFullRestorePhysicalRowPacketParserV2(rawTrustedRegistration: unknown) {
  let registration: z.infer<typeof registrationSchema>;
  let codecs: ReturnType<typeof createFullRestorePhysicalCodecV2>[];
  try {
    registration = registrationSchema.parse(rawTrustedRegistration);
    const names = registration.columns.map((column) => column.column);
    if (
      new Set(names).size !== names.length ||
      new Set(registration.orderingKey).size !== registration.orderingKey.length ||
      registration.orderingKey.some(
        (key) => !registration.columns.some((column) => column.column === key && !column.nullable),
      ) ||
      registration.columns.some(
        (column) =>
          column.schema !== registration.schema || column.relation !== registration.relation,
      ) ||
      registration.maxRowBytes > registration.maxBytes
    )
      return fail('PACKET_REGISTRATION_INVALID');
    codecs = registration.columns.map(createFullRestorePhysicalCodecV2);
  } catch {
    return fail('PACKET_REGISTRATION_INVALID');
  }
  // Schemas detach plain config fields; capture immutable column identities before
  // any archive is consumed. Source caller's subsequent mutation has no effect.
  const names = Object.freeze(registration.columns.map((column) => column.column));
  const keys = Object.freeze([...registration.orderingKey]);
  const rowSchema = createBoundedPlainJsonSchema(registration.maxRowBytes).pipe(
    z.strictObject({
      rowVersion: z.literal(2),
      columns: z
        .array(z.strictObject({ column: identifier, value: z.unknown() }))
        .length(names.length),
    }),
  );
  return Object.freeze({
    validate(rawBytes: unknown, rawFacts: unknown) {
      let facts: z.infer<typeof factsSchema>;
      try {
        facts = factsSchema.parse(rawFacts);
      } catch {
        return fail('PACKET_FACTS_INVALID');
      }
      if (
        facts.schema !== registration.schema ||
        facts.relation !== registration.relation ||
        facts.columnsSha256 !== registration.columnsSha256 ||
        facts.orderingKey.length !== keys.length ||
        facts.orderingKey.some((key, i) => key !== keys[i])
      )
        return fail('PACKET_FACTS_INVALID');
      if (facts.rowCount > registration.maxRows || facts.byteLength > registration.maxBytes)
        return fail('PACKET_BOUND_EXCEEDED');
      const bytes = ownedBytes(rawBytes, registration.maxBytes);
      const rowsSha256 = createHash('sha256').update(bytes).digest('hex');
      if (bytes.byteLength !== facts.byteLength || rowsSha256 !== facts.rowsSha256)
        return fail('PACKET_FACTS_INVALID');
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return fail('PACKET_ENCODING_INVALID');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return fail('PACKET_ENCODING_INVALID');
      }
      if (facts.state === 'explicit_empty' && (text !== '[]' || facts.rowCount !== 0))
        return fail('PACKET_FACTS_INVALID');
      preflight(text, registration.maxRows, registration.maxRowBytes);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return fail('PACKET_JSON_INVALID');
      }
      if (
        !Array.isArray(raw) ||
        raw.length !== facts.rowCount ||
        (facts.state === 'present' && raw.length === 0)
      )
        return fail('PACKET_FACTS_INVALID');
      const physicalKeys = new Set<string>();
      const rows: FullRestorePhysicalRowV2[] = raw.map((entry: unknown) => {
        let row: z.infer<typeof rowSchema>;
        try {
          row = rowSchema.parse(entry);
        } catch {
          return fail('PACKET_COLUMNS_INVALID');
        }
        const columns = row.columns.map((column, index) => {
          if (column.column !== names[index]) return fail('PACKET_COLUMNS_INVALID');
          const codec = codecs[index];
          if (!codec) return fail('PACKET_REGISTRATION_INVALID');
          try {
            return Object.freeze({
              column: column.column,
              value: codec.validate(column.value).value,
            });
          } catch {
            return fail('PACKET_VALUE_INVALID');
          }
        });
        // Exact physical-wrapper duplicates only. Native equality/collation remains
        // unchecked: differing decimal spelling or locale equivalence is not certified.
        const key = JSON.stringify(
          keys.map((name) => columns.find((column) => column.column === name)?.value),
        );
        if (physicalKeys.has(key)) return fail('PACKET_DUPLICATE_KEY');
        physicalKeys.add(key);
        return Object.freeze({ rowVersion: 2 as const, columns: Object.freeze(columns) });
      });
      return Object.freeze({
        kind: 'validated_full_restore_physical_row_packet_v2' as const,
        physicalCodec: fullRestorePhysicalRowPacketCodecV2,
        scalarCodec: fullRestorePhysicalCodecV2,
        schema: registration.schema,
        relation: registration.relation,
        columnsSha256: registration.columnsSha256,
        orderingKey: keys,
        columnNames: names,
        rowCount: rows.length,
        byteLength: bytes.byteLength,
        rowsSha256,
        rows: Object.freeze(rows),
        authority: 'none' as const,
        admissionAllowed: false as const,
        nativeOrderVerification: 'not_checked' as const,
        nativeUniquenessVerification: 'not_checked' as const,
        nativeCanonicalVerification: 'not_checked' as const,
        domainValidation: 'not_checked' as const,
        copyOriginalUtf8: () => new Uint8Array(bytes),
      });
    },
  });
}
