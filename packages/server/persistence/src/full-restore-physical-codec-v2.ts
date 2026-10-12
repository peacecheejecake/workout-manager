import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';

export const fullRestorePhysicalCodecV2 = 'postgres-lossless-physical-value-v2' as const;
const MAX_BYTES = 8388608;
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const types = z.enum([
  'text',
  'uuid',
  'int32',
  'int64',
  'numericdecimal',
  'boolean',
  'date',
  'timestamptzUTC6',
  'bytea',
  'name',
  'float8sendbits',
  'uuid[]',
  'inet[]',
  'jsonb',
]);
const descriptorSchema = createBoundedPlainJsonSchema(4096).pipe(
  z.strictObject({
    schemaVersion: z.literal(2),
    physicalCodec: z.literal(fullRestorePhysicalCodecV2),
    schema: identifier,
    relation: identifier,
    column: identifier,
    pgType: types,
    nullable: z.boolean(),
    // UTF8 scalar/element content bytes, decoded bytea bytes or eight float8 bytes.
    // Independent whole-wire/depth limits additionally apply before parsing.
    maxBytes: z.number().int().min(1).max(MAX_BYTES),
    maxElements: z.number().int().min(0).max(1000000),
  }),
);
export type FullRestorePhysicalDescriptorV2 = z.infer<typeof descriptorSchema>;
const dimension = z.strictObject({
  lowerBound: z.number().int().min(-2147483648).max(2147483647),
  length: z.number().int().min(1).max(1000000),
});
const valueSchema = createBoundedPlainJsonSchema(MAX_BYTES).pipe(
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('sql_null') }),
    z.strictObject({ kind: z.literal('text'), value: z.string() }),
    z.strictObject({ kind: z.literal('name'), value: z.string() }),
    z.strictObject({ kind: z.literal('uuid'), value: z.string() }),
    z.strictObject({ kind: z.literal('int32'), value: z.string() }),
    z.strictObject({ kind: z.literal('int64'), value: z.string() }),
    z.strictObject({ kind: z.literal('numericdecimal'), value: z.string() }),
    z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
    z.strictObject({ kind: z.literal('date'), value: z.string() }),
    z.strictObject({ kind: z.literal('timestamptzUTC6'), value: z.string() }),
    z.strictObject({ kind: z.literal('bytea'), hex: z.string() }),
    z.strictObject({ kind: z.literal('float8sendbits'), sendBits: z.string() }),
    z.strictObject({
      kind: z.literal('uuid[]'),
      dimensions: z.array(dimension).max(6),
      elements: z.array(z.string().nullable()).max(1000000),
    }),
    z.strictObject({
      kind: z.literal('inet[]'),
      dimensions: z.array(dimension).max(6),
      elements: z.array(z.string().nullable()).max(1000000),
    }),
    z.strictObject({
      kind: z.literal('jsonb'),
      text: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ]),
);
type WireValue = z.infer<typeof valueSchema>;
export type FullRestorePhysicalValueV2 =
  | Exclude<WireValue, { kind: 'uuid[]' | 'inet[]' }>
  | Readonly<{
      kind: 'uuid[]' | 'inet[]';
      dimensions: readonly Readonly<z.infer<typeof dimension>>[];
      elements: readonly (string | null)[];
    }>;
export type FullRestorePhysicalCodecErrorCodeV2 =
  | 'PHYSICAL_DESCRIPTOR_INVALID'
  | 'PHYSICAL_VALUE_INVALID'
  | 'PHYSICAL_BOUND_EXCEEDED'
  | 'PHYSICAL_TYPE_MISMATCH'
  | 'PHYSICAL_JSONB_INVALID'
  | 'PHYSICAL_DIGEST_MISMATCH';
export class FullRestorePhysicalCodecErrorV2 extends Error {
  constructor(readonly code: FullRestorePhysicalCodecErrorCodeV2) {
    super(code);
    this.name = 'FullRestorePhysicalCodecErrorV2';
  }
}
function fail(code: FullRestorePhysicalCodecErrorCodeV2): never {
  throw new FullRestorePhysicalCodecErrorV2(code);
}
function safeText(text: string) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function bytes(text: string) {
  return Buffer.byteLength(text, 'utf8');
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function inet(text: string) {
  const parts = text.split('/'),
    address = parts[0];
  if (!address || parts.length > 2) return false;
  const family = isIP(address);
  return (
    family !== 0 &&
    (parts.length === 1 ||
      (/^(?:0|[1-9][0-9]*)$/.test(parts[1] ?? '') && Number(parts[1]) <= (family === 4 ? 32 : 128)))
  );
}
function integer(text: string, minimum: bigint, maximum: bigint) {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(text) || text.length > 20) return false;
  const value = BigInt(text);
  return value >= minimum && value <= maximum;
}
// The wire keeps explicit UTC microseconds, BC and infinity; no Date/Number epoch coercion.
function calendar(text: string, instant: boolean) {
  if (text === 'infinity' || text === '-infinity') return true;
  const match = (
    instant
      ? /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z( BC)?$/
      : /^(\d{4,7})-(\d{2})-(\d{2})( BC)?$/
  ).exec(text);
  if (!match || !match[1]) return false;
  const year = BigInt(match[1]);
  const bc = Boolean(match[instant ? 8 : 4]);
  if (year === 0n || (bc && year > 4714n)) return false;
  const astronomicalYear = bc ? 1n - year : year;
  const month = Number(match[2]),
    day = Number(match[3]);
  const leap =
    astronomicalYear % 4n === 0n &&
    (astronomicalYear % 100n !== 0n || astronomicalYear % 400n === 0n);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined || day < 1 || day > days) return false;
  // PostgreSQL REL_17_6 datetime.c date2j and datatype/timestamp.h exact limits.
  // BC 4714-11-24 is Julian day zero; checking only the printed year is wrong.
  const adjustedYear = astronomicalYear + (month > 2 ? 4800n : 4799n);
  const adjustedMonth = BigInt(month + (month > 2 ? 1 : 13));
  const century = adjustedYear / 100n;
  const julian =
    adjustedYear * 365n -
    32167n +
    adjustedYear / 4n -
    century +
    century / 4n +
    (7834n * adjustedMonth) / 256n +
    BigInt(day);
  if (!instant) return julian >= 0n && julian < 2147483494n;
  const hour = Number(match[4]),
    minute = Number(match[5]),
    second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const micros =
    (julian - 2451545n) * 86400000000n +
    BigInt(hour) * 3600000000n +
    BigInt(minute) * 60000000n +
    BigInt(second) * 1000000n +
    BigInt(match[7] ?? '0');
  return micros >= -211813488000000000n && micros < 9223371331200000000n;
}
// Validate opaque JSON grammar and decoded keys without parsing numeric values.
// Large decimals stay in the original text; duplicate/escaped-equivalent keys are ambiguous.
function jsonbSyntax(text: string) {
  let at = 0,
    nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? '\0')) at++;
  };
  const invalid = () => fail('PHYSICAL_JSONB_INVALID');
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') {
        let decoded: unknown;
        try {
          decoded = JSON.parse(text.slice(start, at));
        } catch {
          return invalid();
        }
        return typeof decoded === 'string' && safeText(decoded) ? decoded : invalid();
      }
      if (c === '\\') at++;
      else if (c !== undefined && c.charCodeAt(0) < 32) return invalid();
    }
    return invalid();
  };
  const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (depth: number): void => {
    if (++nodes > 250000 || depth > 64) return invalid();
    whitespace();
    const c = text[at];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{' || c === '[') {
      const object = c === '{',
        closing = object ? '}' : ']';
      at++;
      whitespace();
      const keys = new Set<string>();
      if (text[at] === closing) {
        at++;
        return;
      }
      while (at < text.length) {
        if (object) {
          if (text[at] !== '"') return invalid();
          const key = string();
          if (keys.has(key)) return invalid();
          keys.add(key);
          whitespace();
          if (text[at++] !== ':') return invalid();
        }
        value(depth + 1);
        whitespace();
        const separator = text[at++];
        if (separator === closing) return;
        if (separator !== ',') return invalid();
        whitespace();
      }
      return invalid();
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return;
      }
    }
    numberToken.lastIndex = at;
    const token = numberToken.exec(text);
    if (!token) return invalid();
    at = numberToken.lastIndex;
  };
  if (!safeText(text) || text.charCodeAt(0) === 0xfeff) invalid();
  value(0);
  whitespace();
  if (at !== text.length) invalid();
}
function immutableValue(value: FullRestorePhysicalValueV2): FullRestorePhysicalValueV2 {
  if (value.kind === 'uuid[]' || value.kind === 'inet[]') {
    return Object.freeze({
      ...value,
      dimensions: Object.freeze(value.dimensions.map((d) => Object.freeze({ ...d }))),
      elements: Object.freeze([...value.elements]),
    });
  }
  return Object.freeze(value);
}
export type FullRestoreValidatedPhysicalValueV2 = Readonly<{
  descriptor: Readonly<FullRestorePhysicalDescriptorV2>;
  value: FullRestorePhysicalValueV2;
  processingAuthority: 'none';
  admission: false;
  nativeCanonicalVerification: 'not_checked';
  domainValidation: 'not_checked';
  copyOpaqueJsonbUtf8: () => Uint8Array | null;
}>;
/** Descriptors must originate from an independent closed registration, never archive metadata.
 * This pure component checks physical representation, not PostgreSQL canonical correspondence,
 * domain validity, registry coverage, archive authenticity or restore admission.
 */
export function createFullRestorePhysicalCodecV2(trustedDescriptor: unknown) {
  let descriptor: FullRestorePhysicalDescriptorV2;
  try {
    descriptor = descriptorSchema.parse(trustedDescriptor);
  } catch {
    return fail('PHYSICAL_DESCRIPTOR_INVALID');
  }
  const capturedDescriptor = Object.freeze(descriptor);
  return Object.freeze({
    validate(input: unknown): FullRestoreValidatedPhysicalValueV2 {
      let value: FullRestorePhysicalValueV2;
      try {
        value = valueSchema.parse(input);
      } catch {
        return fail('PHYSICAL_VALUE_INVALID');
      }
      if (value.kind === 'sql_null') {
        if (!descriptor.nullable) fail('PHYSICAL_TYPE_MISMATCH');
      } else if (value.kind !== descriptor.pgType) fail('PHYSICAL_TYPE_MISMATCH');
      const maximum = descriptor.maxBytes;
      if (value.kind === 'uuid[]' || value.kind === 'inet[]') {
        let count = value.dimensions.length === 0 ? 0 : 1;
        for (const d of value.dimensions) {
          if (d.lowerBound + d.length - 1 > 2147483647) fail('PHYSICAL_VALUE_INVALID');
          count *= d.length;
          if (count > descriptor.maxElements) fail('PHYSICAL_BOUND_EXCEEDED');
        }
        if (count !== value.elements.length || count > descriptor.maxElements)
          fail('PHYSICAL_VALUE_INVALID');
        let total = 0;
        for (const element of value.elements) {
          if (element === null) continue;
          total += bytes(element);
          if (total > maximum) fail('PHYSICAL_BOUND_EXCEEDED');
          if (!(value.kind === 'uuid[]' ? uuid.test(element) : inet(element)))
            fail('PHYSICAL_VALUE_INVALID');
        }
      } else if (value.kind === 'jsonb') {
        if (value.text.length > maximum || bytes(value.text) > maximum)
          fail('PHYSICAL_BOUND_EXCEEDED');
        jsonbSyntax(value.text);
        if (createHash('sha256').update(value.text, 'utf8').digest('hex') !== value.sha256)
          fail('PHYSICAL_DIGEST_MISMATCH');
      } else if ('value' in value && typeof value.value === 'string') {
        const text = value.value;
        if (text.length > maximum || bytes(text) > maximum) fail('PHYSICAL_BOUND_EXCEEDED');
        if (!safeText(text)) fail('PHYSICAL_VALUE_INVALID');
        const valid =
          value.kind === 'uuid'
            ? uuid.test(text)
            : value.kind === 'int32'
              ? integer(text, -2147483648n, 2147483647n)
              : value.kind === 'int64'
                ? integer(text, -9223372036854775808n, 9223372036854775807n)
                : value.kind === 'numericdecimal'
                  ? /^(?:NaN|Infinity|-Infinity|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?)$/.test(text)
                  : value.kind === 'date'
                    ? calendar(text, false)
                    : value.kind === 'timestamptzUTC6'
                      ? calendar(text, true)
                      : value.kind === 'name'
                        ? bytes(text) <= 63
                        : true;
        if (!valid) fail('PHYSICAL_VALUE_INVALID');
      } else if (value.kind === 'bytea') {
        if (!/^(?:[a-f0-9]{2})*$/.test(value.hex)) fail('PHYSICAL_VALUE_INVALID');
        if (value.hex.length / 2 > maximum) fail('PHYSICAL_BOUND_EXCEEDED');
      } else if (value.kind === 'float8sendbits' && !/^[a-f0-9]{16}$/.test(value.sendBits))
        fail('PHYSICAL_VALUE_INVALID');
      if (value.kind === 'float8sendbits' && maximum < 8) fail('PHYSICAL_BOUND_EXCEEDED');
      const captured = immutableValue(value);
      const opaque = value.kind === 'jsonb' ? new TextEncoder().encode(value.text) : null;
      return Object.freeze({
        descriptor: capturedDescriptor,
        value: captured,
        processingAuthority: 'none',
        admission: false,
        nativeCanonicalVerification: 'not_checked',
        domainValidation: 'not_checked',
        copyOpaqueJsonbUtf8: () => (opaque === null ? null : new Uint8Array(opaque)),
      });
    },
  });
}
