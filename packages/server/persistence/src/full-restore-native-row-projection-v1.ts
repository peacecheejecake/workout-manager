import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import { createFullRestoreNativeCatalogCollectorV2 } from './full-restore-native-catalog-v2/collector.js';
import {
  createFullRestorePhysicalCodecV2,
  fullRestorePhysicalCodecV2,
  type FullRestorePhysicalDescriptorV2,
} from './full-restore-physical-codec-v2.js';
import {
  createFullRestorePhysicalRowPacketParserV2,
  fullRestorePhysicalRowPacketCodecV2,
  fullRestorePhysicalRowPacketLimitsV2,
} from './full-restore-physical-row-packet-v2.js';

const MAX_ASSET = 8388608;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
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
const columnSchema = z.strictObject({
  column: id,
  pgType: types,
  maxBytes: integer(1, fullRestorePhysicalRowPacketLimitsV2.rowBytes),
  maxElements: integer(0, 1000000),
});
const relationSchema = z.strictObject({
  schema: id,
  relation: id,
  // SHA namespace: JSON.stringify of the collector's validated column/PK values,
  // in their original array order. These are binding checks, not native SQL hashes.
  columnBindingSha256: digest,
  primaryKeyBindingSha256: digest,
  columns: z.array(columnSchema).min(1).max(1600),
  maxRows: integer(0, 5000),
  maxBytes: integer(2, 16777216),
  maxRowBytes: integer(2, 4194304),
});
const registrationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('native-row-projection-registration-v1'),
  profileVersion: z.literal(9),
  runtimeStep: z.literal(25),
  sourceDdlTip: z.literal(142),
  catalogSha256: digest,
  tables: z.array(relationSchema).length(239),
});
const pinSchema = z.strictObject({
  registrationSha256: digest,
  catalogSha256: digest,
  querySha256: digest,
  rosterSha256: digest,
});
export class FullRestoreNativeRowProjectionErrorV1 extends Error {
  constructor(
    readonly code:
      | 'PROJECTION_ASSETS_INVALID'
      | 'PROJECTION_REGISTRATION_INVALID'
      | 'PROJECTION_RELATION_UNKNOWN'
      | 'PROJECTION_CARRIER_INVALID',
  ) {
    super(code);
    this.name = 'FullRestoreNativeRowProjectionErrorV1';
  }
}
const fail = (code: FullRestoreNativeRowProjectionErrorV1['code']): never => {
  throw new FullRestoreNativeRowProjectionErrorV1(code);
};
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function own(raw: unknown, keys: readonly string[]) {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Reflect.ownKeys(raw).length !== keys.length
  )
    throw Error('invalid');
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) throw Error('invalid');
    values[key] = d.value;
  }
  return values;
}
function copy(raw: unknown) {
  const proto = Object.getPrototypeOf(Uint8Array.prototype);
  if (!(raw instanceof Uint8Array) || Object.getPrototypeOf(raw) !== Uint8Array.prototype)
    throw Error('invalid');
  const buffer: unknown = Object.getOwnPropertyDescriptor(proto, 'buffer')?.get?.call(raw);
  const size: unknown = Object.getOwnPropertyDescriptor(proto, 'byteLength')?.get?.call(raw);
  const offset: unknown = Object.getOwnPropertyDescriptor(proto, 'byteOffset')?.get?.call(raw);
  if (
    !(buffer instanceof ArrayBuffer) ||
    Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get?.call(buffer) !==
      false ||
    offset !== 0 ||
    typeof size !== 'number' ||
    size < 1 ||
    size > MAX_ASSET ||
    size !== Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get?.call(buffer)
  )
    throw Error('invalid');
  return new Uint8Array(raw);
}
// Bound JSON containers/tokens before JSON.parse allocates a recursive object tree.
// JSON.parse checks grammar; the subsequent exact spelling check rejects duplicate keys.
function preflightAsset(text: string) {
  let depth = 0,
    nodes = 0,
    at = 0;
  while (at < text.length) {
    const c = text[at++];
    if (c === '"') {
      if (++nodes > 250000) throw Error('invalid');
      let closed = false;
      while (at < text.length) {
        const next = text[at++];
        if (next === '\\') at++;
        else if (next === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw Error('invalid');
    } else if (c === '{' || c === '[') {
      if (++depth > 64 || ++nodes > 250000) throw Error('invalid');
    } else if (c === '}' || c === ']') {
      if (--depth < 0) throw Error('invalid');
    } else if (c !== undefined && /[0-9tfn-]/.test(c)) {
      if (++nodes > 250000) throw Error('invalid');
      while (at < text.length && !/[\x20\t\r\n,\]}]/.test(text[at] ?? '')) at++;
    }
  }
  if (depth !== 0) throw Error('invalid');
}
function json(bytes: Uint8Array, expected: string) {
  if (sha(bytes) !== expected || (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191))
    throw Error('invalid');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  preflightAsset(text);
  const value: unknown = JSON.parse(text);
  if (!createBoundedPlainJsonSchema(MAX_ASSET).safeParse(value).success) throw Error('invalid');
  // Source assets are independently fixed bytes; JSON key ambiguity is still rejected
  // by exact canonical spelling, unlike physical row bytes which must never reserialize.
  if (JSON.stringify(value) !== text) throw Error('invalid');
  return value;
}
const q = (name: string) => `"${name}"`;
const scalarTypes: Readonly<Record<FullRestorePhysicalDescriptorV2['pgType'], string>> =
  Object.freeze({
    text: 'text',
    uuid: 'uuid',
    int32: 'integer',
    int64: 'bigint',
    numericdecimal: 'numeric',
    boolean: 'boolean',
    date: 'date',
    timestamptzUTC6: 'timestamp with time zone',
    bytea: 'bytea',
    name: 'name',
    float8sendbits: 'double precision',
    'uuid[]': 'uuid[]',
    'inet[]': 'inet[]',
    jsonb: 'jsonb',
  });
function scalar(column: FullRestorePhysicalDescriptorV2) {
  const v = `t.${q(column.column)}`,
    kind = column.pgType;
  const utf8 = (s: string) => `pg_catalog.octet_length(pg_catalog.convert_to(${s},'UTF8'))`;
  let value: string,
    size: string,
    extra = 'true';
  switch (kind) {
    case 'text':
    case 'name':
    case 'uuid':
    case 'int32':
    case 'int64':
    case 'numericdecimal':
    case 'date':
      value = `pg_catalog.jsonb_build_object('kind','${kind}','value',${v}::text)`;
      size = utf8(`${v}::text`);
      break;
    case 'boolean':
      value = `pg_catalog.jsonb_build_object('kind','boolean','value',${v})`;
      size = '1';
      break;
    case 'timestamptzUTC6': {
      const s = `CASE WHEN NOT pg_catalog.isfinite(${v}) THEN ${v}::text ELSE pg_catalog.to_char(${v} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||CASE WHEN pg_catalog.date_part('year',${v} AT TIME ZONE 'UTC')<0 THEN ' BC' ELSE '' END END`;
      value = `pg_catalog.jsonb_build_object('kind','${kind}','value',${s})`;
      size = utf8(s);
      break;
    }
    case 'bytea':
      value = `pg_catalog.jsonb_build_object('kind','bytea','hex',pg_catalog.encode(${v},'hex'))`;
      size = `pg_catalog.octet_length(${v})`;
      break;
    case 'float8sendbits':
      value = `pg_catalog.jsonb_build_object('kind','float8sendbits','sendBits',pg_catalog.encode(pg_catalog.float8send(${v}),'hex'))`;
      size = '8';
      break;
    case 'jsonb':
      value = `pg_catalog.jsonb_build_object('kind','jsonb','text',${v}::text,'sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${v}::text,'UTF8')),'hex'))`;
      size = utf8(`${v}::text`);
      break;
    case 'uuid[]':
    case 'inet[]':
      size = `(SELECT COALESCE(pg_catalog.sum(${utf8('e::text')}),0) FROM pg_catalog.unnest(${v}) e)`;
      extra = `pg_catalog.cardinality(${v})<=${column.maxElements} AND COALESCE(pg_catalog.array_ndims(${v}),0)<=6`;
      value = `pg_catalog.jsonb_build_object('kind','${kind}','dimensions',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('lowerBound',pg_catalog.array_lower(${v},d),'length',pg_catalog.array_length(${v},d)) ORDER BY d) FROM pg_catalog.generate_series(1,COALESCE(pg_catalog.array_ndims(${v}),0)) d),'[]'::jsonb),'elements',COALESCE((SELECT pg_catalog.jsonb_agg(e::text ORDER BY ordinal) FROM pg_catalog.unnest(${v}) WITH ORDINALITY AS a(e,ordinal)),'[]'::jsonb))`;
      break;
  }
  return {
    value: `CASE WHEN ${v} IS NULL THEN pg_catalog.jsonb_build_object('kind','sql_null') ELSE ${value} END`,
    size: `CASE WHEN ${v} IS NULL THEN 0 ELSE ${size} END`,
    valid: `(${v} IS NULL ${column.nullable ? '' : 'AND false'} OR (${v} IS NOT NULL AND ${size}<=${column.maxBytes} AND ${extra}))`,
  };
}
function nativeSql(
  columns: readonly FullRestorePhysicalDescriptorV2[],
  order: string,
  table: string,
  bounds: z.infer<typeof relationSchema>,
) {
  const values = columns.map(scalar);
  const checks = values.map((v) => v.valid).join(' AND ');
  const size = values.map((v) => `(${v.size})::numeric`).join('+');
  const row = `pg_catalog.jsonb_build_object('rowVersion',2,'columns',pg_catalog.jsonb_build_array(VARIADIC ARRAY[${columns.map((c, i) => `pg_catalog.jsonb_build_object('column','${c.column}','value',${values[i]?.value})`).join(',')}]))::text`;
  const keys = order.split(',');
  // Full census: no LIMIT, no sampled relations, no ORDER BY serialized wrappers.
  return `WITH context AS MATERIALIZED (SELECT pg_catalog.current_setting('transaction_isolation')='repeatable read' AND pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006' AND pg_catalog.current_setting('DateStyle')='ISO, YMD' AND pg_catalog.current_setting('client_encoding')='UTF8' AS session_ok), projected AS MATERIALIZED (SELECT ${keys.map((key, i) => `${key} AS k${i}`).join(',')}, CASE WHEN ${checks} AND (${size})<=${bounds.maxRowBytes} THEN ${row} ELSE NULL END AS row_text FROM ${table} t), stats AS MATERIALIZED (SELECT pg_catalog.count(*)::bigint AS row_count, pg_catalog.count(*) FILTER(WHERE row_text IS NULL)::bigint AS invalid_rows, COALESCE(pg_catalog.max(pg_catalog.octet_length(row_text)),0)::bigint AS max_row_bytes, (2+COALESCE(pg_catalog.sum(pg_catalog.octet_length(row_text)::numeric),0)+GREATEST(pg_catalog.count(*)-1,0))::numeric AS byte_length FROM projected) SELECT context.session_ok, stats.row_count::text, stats.invalid_rows::text, stats.max_row_bytes::text, stats.byte_length::text, CASE WHEN context.session_ok AND stats.invalid_rows=0 AND stats.row_count<=${bounds.maxRows} AND stats.max_row_bytes<=${bounds.maxRowBytes} AND stats.byte_length<=${bounds.maxBytes} THEN '['||COALESCE((SELECT pg_catalog.string_agg(row_text,',' ORDER BY ${keys.map((_, i) => `k${i} ASC NULLS LAST`).join(',')}) FROM projected),'')||']' ELSE NULL END AS body FROM context CROSS JOIN stats`;
}
/** Build-only boundary. Independently pinned source assets are not archive metadata,
 * approval capabilities or a trusted registration issuer. No database I/O is owned here. */
export function createFullRestoreNativeRowProjectionV1(assets: unknown, independentPins: unknown) {
  try {
    const raw = own(assets, ['registration', 'catalog', 'fixedQuery', 'sourceOwnedRoster']);
    const pins = createBoundedPlainJsonSchema(1024).pipe(pinSchema).parse(independentPins);
    const registrationBytes = copy(raw.registration),
      catalogBytes = copy(raw.catalog);
    const registration = registrationSchema.parse(json(registrationBytes, pins.registrationSha256));
    if (registration.catalogSha256 !== pins.catalogSha256) throw Error('invalid');
    const observed = createFullRestoreNativeCatalogCollectorV2(
      {
        fixedQuery: copy(raw.fixedQuery),
        sourceOwnedRoster: copy(raw.sourceOwnedRoster),
      },
      { querySha256: pins.querySha256, rosterSha256: pins.rosterSha256 },
    ).receive(json(catalogBytes, pins.catalogSha256));
    const catalog = observed.catalog;
    const opclasses = new Map(
      catalog.pools.opclasses.map((entry) => {
        const value: unknown = JSON.parse(entry.pgJsonbText);
        const parsed = z.object({ default: z.boolean() }).parse(value);
        return [entry.oid, parsed.default] as const;
      }),
    );
    const plans = new Map<string, ReturnType<typeof buildPlan>>();
    for (const r of registration.tables) {
      const native = catalog.relations.find(
        (c) => c.schema === r.schema && c.relation === r.relation,
      );
      const key = `${r.schema}.${r.relation}`;
      if (
        !native ||
        plans.has(key) ||
        r.columns.length !== native.columns.length ||
        r.columnBindingSha256 !== sha(JSON.stringify(native.columns)) ||
        r.primaryKeyBindingSha256 !== sha(JSON.stringify(native.primaryKey)) ||
        r.maxRowBytes > r.maxBytes ||
        native.partition ||
        native.parents.length !== 0 ||
        native.primaryKey.components.some(
          (c) => c.sortOptions !== 0 || opclasses.get(c.opclassOid) !== true,
        )
      )
        return fail('PROJECTION_REGISTRATION_INVALID');
      const columns = r.columns.map((c, i): FullRestorePhysicalDescriptorV2 => {
        const n = native.columns[i];
        if (
          !n ||
          c.column !== n.name ||
          scalarTypes[c.pgType] !== n.typeName ||
          (c.pgType !== 'uuid[]' && c.pgType !== 'inet[]' && c.maxElements !== 0)
        )
          return fail('PROJECTION_REGISTRATION_INVALID');
        const descriptor = {
          schemaVersion: 2 as const,
          physicalCodec: fullRestorePhysicalCodecV2,
          schema: r.schema,
          relation: r.relation,
          column: c.column,
          pgType: c.pgType,
          nullable: n.nullable,
          maxBytes: c.maxBytes,
          maxElements: c.maxElements,
        };
        createFullRestorePhysicalCodecV2(descriptor);
        return Object.freeze(descriptor);
      });
      const orderingKey = native.primaryKey.components.map((c) => c.column);
      if (orderingKey.some((key) => columns.find((c) => c.column === key)?.nullable !== false))
        return fail('PROJECTION_REGISTRATION_INVALID');
      plans.set(key, buildPlan(r, columns, orderingKey));
    }
    if (
      plans.size !== 239 ||
      catalog.relations.some((r) => !plans.has(`${r.schema}.${r.relation}`))
    )
      return fail('PROJECTION_REGISTRATION_INVALID');
    const allPlans = Object.freeze([...plans.values()]);
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: 'native-row-projection-plans-v1' as const,
      profileVersion: 9 as const,
      runtimeStep: 25 as const,
      sourceDdlTip: 142 as const,
      authority: 'none' as const,
      registryTrusted: false as const,
      admissionAllowed: false as const,
      catalogSha256: pins.catalogSha256,
      registrationSha256: pins.registrationSha256,
      tableCount: 239 as const,
      columnCount: 1887 as const,
      namespaceRelationCount: 704 as const,
      allPlans,
      getPlan(schema: string, relation: string) {
        if (typeof schema !== 'string' || typeof relation !== 'string')
          return fail('PROJECTION_RELATION_UNKNOWN');
        const plan = plans.get(`${schema}.${relation}`);
        if (!plan) return fail('PROJECTION_RELATION_UNKNOWN');
        return plan;
      },
    });
  } catch (error) {
    if (error instanceof FullRestoreNativeRowProjectionErrorV1) throw error;
    return fail('PROJECTION_ASSETS_INVALID');
  }
}
function buildPlan(
  r: z.infer<typeof relationSchema>,
  columns: readonly FullRestorePhysicalDescriptorV2[],
  orderingKey: readonly string[],
) {
  const packetRegistration = {
    schemaVersion: 2,
    physicalCodec: fullRestorePhysicalRowPacketCodecV2,
    schema: r.schema,
    relation: r.relation,
    columnsSha256: r.columnBindingSha256,
    orderingKey,
    columns,
    maxRows: r.maxRows,
    maxBytes: r.maxBytes,
    maxRowBytes: r.maxRowBytes,
  };
  const parser = createFullRestorePhysicalRowPacketParserV2(packetRegistration);
  return Object.freeze({
    schema: r.schema,
    relation: r.relation,
    sql: nativeSql(
      columns,
      orderingKey.map((k) => `t.${q(k)}`).join(','),
      `${q(r.schema)}.${q(r.relation)}`,
      r,
    ),
    physicalCodec: fullRestorePhysicalRowPacketCodecV2,
    columnsSha256: r.columnBindingSha256,
    columnBindingNamespace: 'validated-native-catalog-columns-json-v1' as const,
    primaryKeyBindingSha256: r.primaryKeyBindingSha256,
    primaryKeyBindingNamespace: 'validated-native-catalog-pk-json-v1' as const,
    columns: Object.freeze([...columns]),
    orderingKey: Object.freeze([...orderingKey]),
    maxRows: r.maxRows,
    maxBytes: r.maxBytes,
    maxRowBytes: r.maxRowBytes,
    authority: 'none' as const,
    registryTrusted: false as const,
    admissionAllowed: false as const,
    nativeCanonicalVerification: 'not_checked' as const,
    nativeOrderEquality: 'not_checked' as const,
    sequenceHighWater: 'not_checked' as const,
    pgDumpCorrespondence: 'not_checked' as const,
    receiveCarrier(input: unknown) {
      try {
        const raw = own(input, [
          'session_ok',
          'row_count',
          'invalid_rows',
          'max_row_bytes',
          'byte_length',
          'body',
        ]);
        const number = (value: unknown) => {
          if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value))
            throw Error('invalid');
          return BigInt(value);
        };
        const count = number(raw.row_count),
          invalid = number(raw.invalid_rows),
          max = number(raw.max_row_bytes),
          length = number(raw.byte_length);
        if (
          typeof raw.session_ok !== 'boolean' ||
          invalid > count ||
          length < 2n ||
          (count === 0n && (max !== 0n || length !== 2n || invalid !== 0n))
        )
          throw Error('invalid');
        const rejected =
          !raw.session_ok ||
          invalid > 0n ||
          count > BigInt(r.maxRows) ||
          max > BigInt(r.maxRowBytes) ||
          length > BigInt(r.maxBytes);
        if (rejected) {
          if (raw.body !== null) throw Error('invalid');
          return Object.freeze({
            kind: 'rejected_native_row_carrier_v1' as const,
            reason: !raw.session_ok
              ? ('session_mismatch' as const)
              : invalid > 0n
                ? ('scalar_bound' as const)
                : ('packet_bound' as const),
            rowCount: count.toString(),
            invalidRows: invalid.toString(),
            maxRowBytes: max.toString(),
            byteLength: length.toString(),
            authority: 'none' as const,
            admissionAllowed: false as const,
          });
        }
        if (count > 0n && max < 2n) throw Error('invalid');
        if (typeof raw.body !== 'string' || raw.body.length > r.maxBytes) throw Error('invalid');
        const bytes = new Uint8Array(Buffer.from(raw.body, 'utf8'));
        if (bytes.byteLength !== Number(length) || bytes.byteLength > r.maxBytes)
          throw Error('invalid');
        // A reported maximum is an additional upper bound on each ORIGINAL UTF8
        // row span, not merely a finite diagnostic. Empty packets retain max0;
        // nonempty packets narrow the existing independent 4MiB registration.
        const measuredParser =
          count === 0n
            ? parser
            : createFullRestorePhysicalRowPacketParserV2({
                ...packetRegistration,
                maxRowBytes: Number(max),
              });
        const result = measuredParser.validate(bytes, {
          schemaVersion: 2,
          physicalCodec: fullRestorePhysicalRowPacketCodecV2,
          schema: r.schema,
          relation: r.relation,
          columnsSha256: r.columnBindingSha256,
          orderingKey,
          state: count === 0n ? 'explicit_empty' : 'present',
          rowCount: Number(count),
          byteLength: Number(length),
          rowsSha256: sha(bytes),
        });
        return Object.freeze({ ...result, registryTrusted: false as const });
      } catch {
        return fail('PROJECTION_CARRIER_INVALID');
      }
    },
  });
}
