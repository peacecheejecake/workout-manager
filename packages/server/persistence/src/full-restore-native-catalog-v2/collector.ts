import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';

// These source-owned asset hashes are fixed implementation inputs, never archive
// metadata or caller-selected SQL. An independently supplied pin must match them.
const pins = Object.freeze({
  roster: 'e13dc970dbce462d0743acabbac273eddf0e506e3e34584b528e7c4f6c080619',
  query: 'fecf6ab1fb0935595c8ffa2b2d57e470f9c910579b1bd4ded6d58ee7d852ab05',
});
export class NativeCatalogAssetsErrorV2 extends Error {
  constructor() {
    super('CATALOG_ASSETS_INVALID');
    this.name = 'NativeCatalogAssetsErrorV2';
  }
}
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function ownData(raw: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
    throw new NativeCatalogAssetsErrorV2();
  return descriptor.value;
}
function copyAsset(raw: unknown): Uint8Array {
  if (
    !ArrayBuffer.isView(raw) ||
    !(raw instanceof Uint8Array) ||
    Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
    !bufferGetter ||
    !byteLengthGetter
  )
    throw new NativeCatalogAssetsErrorV2();
  // Intrinsic getters ignore forged own accessors; shared/resizable/detached
  // backing buffers are not accepted for a stable source asset snapshot.
  const buffer: unknown = bufferGetter.call(raw);
  const size: unknown = byteLengthGetter.call(raw);
  if (
    !(buffer instanceof ArrayBuffer) ||
    Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
    (resizableGetter && resizableGetter.call(buffer) !== false) ||
    typeof size !== 'number' ||
    size < 1 ||
    size > 8388608
  )
    throw new NativeCatalogAssetsErrorV2();
  return new Uint8Array(raw);
}
function decodeAsset(bytes: Uint8Array, expected: string): string {
  if (
    createHash('sha256').update(bytes).digest('hex') !== expected ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  )
    throw new NativeCatalogAssetsErrorV2();
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const id = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const text = z.string().max(16384);
const oid = z.number().int().min(1).max(4294967295);
const zeroOid = z.number().int().min(0).max(4294967295);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const routine = z.strictObject({
  oid,
  schema: id,
  name: id,
  identityArguments: text,
  returnType: oid,
  owner: text,
  volatility: z.enum(['i', 's', 'v']),
  parallel: z.enum(['s', 'r', 'u']),
  strict: z.boolean(),
  leakproof: z.boolean(),
  securityDefiner: z.boolean(),
  kind: z.enum(['f', 'a', 'w', 'p']),
  language: text,
  implementationLibrary: text.nullable(),
  config: z.array(text).max(64).nullable(),
  acl: text.nullable(),
  bodySha256: hash,
});
const collation = z.strictObject({
  oid,
  schema: id,
  name: text,
  provider: z.enum(['d', 'c', 'i', 'b']),
  deterministic: z.boolean(),
  encoding: z.number().int().min(-1).max(100),
  collate: text.nullable(),
  ctype: text.nullable(),
  locale: text.nullable(),
  version: text.nullable(),
  actualVersion: text.nullable(),
});
const physicalType = z.strictObject({
  oid,
  schema: id,
  name: id,
  kind: z.enum(['b', 'c', 'd', 'e', 'p', 'r', 'm']),
  category: z.string().length(1),
  elementOid: zeroOid,
  arrayOid: zeroOid,
  baseOid: zeroOid,
  typeCollationOid: zeroOid,
  sendRoutineOid: oid.nullable(),
  inputRoutineOid: oid.nullable(),
  outputRoutineOid: oid.nullable(),
  elementType: z
    .strictObject({
      oid,
      schema: id,
      name: id,
      sendOid: zeroOid,
      inputOid: zeroOid,
      outputOid: zeroOid,
      sendRoutineOid: oid.nullable(),
      inputRoutineOid: oid.nullable(),
      outputRoutineOid: oid.nullable(),
    })
    .nullable(),
  casts: z
    .array(
      z.strictObject({
        sourceOid: oid,
        targetOid: oid,
        context: z.enum(['i', 'a', 'e']),
        method: z.enum(['f', 'i', 'b']),
        functionOid: zeroOid,
        functionRoutineOid: oid.nullable(),
      }),
    )
    .max(512),
});
const component = z.strictObject({
  position: z.number().int().min(1).max(16),
  attributePosition: z.number().int().min(1).max(1600),
  column: id,
  sortOptions: z.number().int().min(0).max(3),
  collationOid: oid.nullable(),
  opclassOid: oid,
});
const opclass = z.strictObject({
  oid,
  schema: id,
  name: id,
  default: z.boolean(),
  inputTypeOid: oid,
  keyTypeOid: zeroOid,
  familyOid: oid,
  familySchema: id,
  familyName: id,
  operators: z
    .array(
      z.strictObject({
        oid,
        schema: id,
        name: text,
        strategy: z.number().int().min(1).max(5),
        leftTypeOid: oid,
        rightTypeOid: oid,
        purpose: z.enum(['s', 'o']),
        functionRoutineOid: oid,
      }),
    )
    .min(1)
    .max(256),
  supportProcedures: z
    .array(
      z.strictObject({
        number: z.number().int().min(1).max(16),
        leftTypeOid: oid,
        rightTypeOid: oid,
        functionRoutineOid: oid,
      }),
    )
    .min(1)
    .max(256),
});

const relation = z.strictObject({
  schema: id,
  relation: id,
  oid,
  kind: z.enum(['r', 'p']),
  owner: text,
  acl: text.nullable(),
  rls: z.boolean(),
  forceRls: z.boolean(),
  partition: z.boolean(),
  parents: z.array(z.strictObject({ oid, schema: id, relation: id })).max(16),
  partitionBound: text.nullable(),
  columns: z
    .array(
      z.strictObject({
        position: z.number().int().min(1).max(1600),
        name: id,
        typeName: text,
        typmod: z.number().int().min(-1),
        nullable: z.boolean(),
        identity: z.enum(['', 'a', 'd']),
        generated: z.enum(['', 's']),
        defaultExpression: text.nullable(),
        collationOid: oid.nullable(),
        physicalTypeOid: oid,
      }),
    )
    .min(1)
    .max(1600),
  primaryKey: z.strictObject({
    oid,
    name: id,
    accessMethod: z.literal('btree'),
    unique: z.literal(true),
    valid: z.literal(true),
    ready: z.literal(true),
    keyAttributes: z.number().int().min(1).max(16),
    totalAttributes: z.number().int().min(1).max(32),
    expression: z.null(),
    predicate: z.null(),
    components: z.array(component).min(1).max(16),
  }),
});
const integerText = z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/);
const poolEntry = z.strictObject({
  oid,
  pgJsonbText: z.string().min(2).max(262144),
  metadataSha256: hash,
});
const schema = z.strictObject({
  schemaVersion: z.literal(2),
  payloadEncoding: z.literal('oid-normalized-native-catalog-v2'),
  serverVersionNum: z.literal(170006),
  isolation: z.literal('repeatable read'),
  readOnly: z.literal('on'),
  exportedSnapshot: z.string().regex(/^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+$/),
  transactionSnapshot: z.string().regex(/^[0-9]+:[0-9]+:[0-9,]*$/),
  walObservation: z.string().regex(/^[A-Fa-f0-9]+\/[A-Fa-f0-9]+$/),
  database: z.strictObject({
    oid,
    encoding: z.literal('UTF8'),
    collation: text,
    ctype: text,
    provider: z.enum(['c', 'i', 'b']),
    locale: text.nullable(),
    version: text.nullable(),
    actualVersion: text.nullable(),
    owner: text,
  }),
  schemas: z.array(z.strictObject({ name: id, owner: text, acl: text.nullable() })).length(5),
  namespaceRelations: z
    .array(
      z.strictObject({
        schema: id,
        relation: id,
        kind: z.enum(['r', 'p', 'i', 'I', 'S']),
      }),
    )
    .length(704),
  relations: z.array(relation).length(239),
  pools: z.strictObject({
    physicalTypes: z.array(poolEntry).min(1).max(64),
    opclasses: z.array(poolEntry).min(1).max(64),
    routines: z.array(poolEntry).min(1).max(4096),
    collations: z.array(poolEntry).max(128),
  }),
  sequences: z
    .array(
      z.strictObject({
        schema: id,
        relation: id,
        oid,
        owner: text,
        typeOid: oid,
        start: integerText,
        increment: integerText,
        minimum: integerText,
        maximum: integerText,
        cache: integerText,
        cycle: z.boolean(),
        dependencies: z
          .array(
            z.strictObject({
              type: z.string().length(1),
              referencedOid: oid,
              attributePosition: z.number().int().min(0).max(1600),
            }),
          )
          .max(32),
      }),
    )
    .length(1),
});
const rosterSchema = z.strictObject({
  draftSha256: hash,
  tables: z
    .array(
      z.strictObject({
        schema: id,
        relation: id,
        classification: text,
        orderingKey: z.array(id).min(1).max(16),
        columns: z.array(
          z.strictObject({
            position: z.number().int(),
            name: id,
            type: text,
            typmod: z.number().int(),
            nullable: z.boolean(),
          }),
        ),
      }),
    )
    .length(239),
  indexes: z.array(z.strictObject({ schema: id, relation: id })).length(464),
  sequences: z.array(z.strictObject({ schema: id, relation: id })).length(1),
});
type SourceOwnedRosterV2 = z.infer<typeof rosterSchema>;
const names = (values: readonly { schema: string; relation: string }[]) =>
  values.map((v) => `${v.schema}.${v.relation}`).sort();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const nativeCatalogValidationStagesV2 = [
  'wire_bounds',
  'wire_schema',
  'wire_nodes',
  'pool_physical_types',
  'pool_opclasses',
  'pool_routines',
  'pool_collations',
  'roster_names',
  'schema_names',
  'namespace_kinds',
  'relation_identity',
  'column_roster',
  'primary_key_roster',
  'column_type',
  'column_routines',
  'column_collation',
  'array_shape',
  'array_element_type',
  'array_element_routines',
  'cast_duplicates',
  'cast_reference',
  'primary_key_component',
  'primary_key_opclass',
  'primary_key_strategies',
  'primary_key_support',
  'primary_key_duplicates',
  'primary_key_routines',
  'complete_closure',
] as const;
export const nativeCatalogValidationCategoriesV2 = [
  'bounds_rejected',
  'schema_rejected',
  'condition_rejected',
  'order_rejected',
  'hash_rejected',
  'json_rejected',
  'identity_rejected',
] as const;
type ValidationStage = (typeof nativeCatalogValidationStagesV2)[number];
type ValidationCategory = (typeof nativeCatalogValidationCategoriesV2)[number];
type MarkValidation = (stage: ValidationStage, category?: ValidationCategory) => void;
export class NativeCatalogValidationErrorV2 extends Error {
  constructor(
    readonly validationStage: ValidationStage,
    readonly validationCategory: ValidationCategory,
  ) {
    super('CATALOG_OBSERVATION_INVALID');
  }
}
const invalid = () => {
  throw Error('CATALOG_OBSERVATION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Exact SHA namespace is the pg_jsonb text bytes, never Node canonical JSON. */
function metadataValue(raw: string, budget: { nodes: number }): unknown {
  let position = 0;
  const white = () => {
    while (position < raw.length && /\s/.test(raw.charAt(position))) position++;
  };
  function stringToken() {
    const start = position;
    if (raw.charAt(position++) !== '"') return invalid();
    let escaped = false;
    while (position < raw.length) {
      const c = raw.charAt(position++);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        const result: unknown = JSON.parse(raw.slice(start, position));
        if (typeof result !== 'string') return invalid();
        for (let i = 0; i < result.length; i++) {
          const u = result.charCodeAt(i);
          if (u >= 0xd800 && u <= 0xdbff) {
            const v = result.charCodeAt(++i);
            if (!(v >= 0xdc00 && v <= 0xdfff)) return invalid();
          } else if (u >= 0xdc00 && u <= 0xdfff) return invalid();
        }
        return result;
      }
    }
    return invalid();
  }
  function value(depth: number): void {
    if (depth > 32 || ++budget.nodes > 250000) return invalid();
    white();
    const c = raw.charAt(position);
    if (c === '{') {
      position++;
      white();
      const keys = new Set<string>();
      if (raw.charAt(position) === '}') {
        position++;
        return;
      }
      for (;;) {
        white();
        const key = stringToken();
        if (keys.has(key)) return invalid();
        keys.add(key);
        white();
        if (raw.charAt(position++) !== ':') return invalid();
        value(depth + 1);
        white();
        const next = raw.charAt(position++);
        if (next === '}') return;
        if (next !== ',') return invalid();
      }
    }
    if (c === '[') {
      position++;
      white();
      if (raw.charAt(position) === ']') {
        position++;
        return;
      }
      for (;;) {
        value(depth + 1);
        white();
        const next = raw.charAt(position++);
        if (next === ']') return;
        if (next !== ',') return invalid();
      }
    }
    if (c === '"') {
      stringToken();
      return;
    }
    const start = position;
    while (position < raw.length && !/[\s,\]}]/.test(raw.charAt(position))) position++;
    if (position === start) return invalid();
    const parsed: unknown = JSON.parse(raw.slice(start, position));
    if (
      parsed !== null &&
      typeof parsed !== 'boolean' &&
      (typeof parsed !== 'number' || !Number.isFinite(parsed))
    )
      return invalid();
  }
  try {
    value(0);
    white();
    if (position !== raw.length) return invalid();
    const parsed: unknown = JSON.parse(raw);
    if (!createBoundedPlainJsonSchema(262144).safeParse(parsed).success) return invalid();
    return parsed;
  } catch {
    return invalid();
  }
}
function pool<T extends z.ZodType>(
  entries: readonly z.infer<typeof poolEntry>[],
  validator: T,
  budget: { nodes: number },
  stage: ValidationStage,
  mark: MarkValidation,
) {
  const values = new Map<number, z.infer<T>>();
  let previous = 0;
  for (const entry of entries) {
    mark(stage, 'order_rejected');
    if (entry.oid <= previous) return invalid();
    previous = entry.oid;
    mark(stage, 'hash_rejected');
    if (
      createHash('sha256').update(entry.pgJsonbText, 'utf8').digest('hex') !== entry.metadataSha256
    )
      return invalid();
    mark(stage, 'json_rejected');
    const metadata = metadataValue(entry.pgJsonbText, budget);
    mark(stage, 'schema_rejected');
    const parsed = validator.safeParse(metadata);
    if (!parsed.success) return invalid();
    mark(stage, 'identity_rejected');
    const identity = z.strictObject({ oid }).passthrough().safeParse(parsed.data);
    if (!identity.success || identity.data.oid !== entry.oid) return invalid();
    values.set(entry.oid, parsed.data);
  }
  return values;
}
function required<T>(map: ReadonlyMap<number, T>, id: number | null, used: Set<number>): T {
  if (id === null) return invalid();
  const value = map.get(id);
  if (value === undefined) return invalid();
  used.add(id);
  return value;
}
function chargeWireNodes(value: unknown, budget: { nodes: number }, depth = 0): void {
  if (depth > 64 || ++budget.nodes > 250000) return invalid();
  if (value !== null && typeof value === 'object')
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && name === 'length') continue;
      if (!('value' in descriptor)) return invalid();
      chargeWireNodes(descriptor.value, budget, depth + 1);
    }
}
function receiveNativeCatalogCandidateAtStageV2(
  raw: unknown,
  mark: MarkValidation,
  roster: SourceOwnedRosterV2,
) {
  if (!createBoundedPlainJsonSchema(8388608).safeParse(raw).success) return invalid();
  mark('wire_schema', 'schema_rejected');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return invalid();
  const c = parsed.data;
  const budget = { nodes: 0 };
  mark('wire_nodes', 'bounds_rejected');
  chargeWireNodes(c, budget);
  const ts = pool(c.pools.physicalTypes, physicalType, budget, 'pool_physical_types', mark),
    os = pool(c.pools.opclasses, opclass, budget, 'pool_opclasses', mark),
    rs = pool(c.pools.routines, routine, budget, 'pool_routines', mark),
    cs = pool(c.pools.collations, collation, budget, 'pool_collations', mark);
  const used = {
    ts: new Set<number>(),
    os: new Set<number>(),
    rs: new Set<number>(),
    cs: new Set<number>(),
  };
  const rr = (id: number | null) => required(rs, id, used.rs);
  const cc = (id: number | null) => (id === null ? null : required(cs, id, used.cs));
  mark('roster_names');
  if (
    !same(
      names(c.namespaceRelations),
      names([...roster.tables, ...roster.indexes, ...roster.sequences]),
    ) ||
    !same(names(c.relations), names(roster.tables)) ||
    !same(names(c.sequences), names(roster.sequences))
  )
    return invalid();
  mark('schema_names');
  if (
    !same(
      c.schemas.map((s) => s.name).sort(),
      [...new Set(roster.tables.map((t) => t.schema))].sort(),
    )
  )
    return invalid();
  const typeNames: Record<string, string> = {
    text: 'text',
    uuid: 'uuid',
    integer: 'int4',
    'timestamp with time zone': 'timestamptz',
    jsonb: 'jsonb',
    boolean: 'bool',
    bigint: 'int8',
    'double precision': 'float8',
    bytea: 'bytea',
    date: 'date',
    name: 'name',
    'uuid[]': '_uuid',
    numeric: 'numeric',
    'inet[]': '_inet',
  };
  const tableKinds = new Map(c.relations.map((v) => [`${v.schema}.${v.relation}`, v.kind]));
  const indexNames = new Set(names(roster.indexes)),
    sequenceNames = new Set(names(roster.sequences));
  mark('namespace_kinds');
  for (const v of c.namespaceRelations) {
    const name = `${v.schema}.${v.relation}`;
    const tableKind = tableKinds.get(name);
    if (
      tableKind !== undefined
        ? tableKind !== v.kind
        : indexNames.has(name)
          ? v.kind !== 'i' && v.kind !== 'I'
          : sequenceNames.has(name)
            ? v.kind !== 'S'
            : true
    )
      return invalid();
  }
  let columns = 0;
  for (const r of c.relations) {
    mark('relation_identity');
    const expected = roster.tables.find((t) => t.schema === r.schema && t.relation === r.relation);
    if (!expected) return invalid();
    mark('column_roster');
    if (
      !same(
        r.columns.map((v) => ({
          position: v.position,
          name: v.name,
          type: v.typeName,
          typmod: v.typmod,
          nullable: v.nullable,
        })),
        expected.columns,
      )
    )
      return invalid();
    columns += r.columns.length;
    mark('primary_key_roster');
    if (
      !same(
        r.primaryKey.components.map((v) => v.column),
        expected.orderingKey,
      ) ||
      r.primaryKey.keyAttributes !== expected.orderingKey.length ||
      r.primaryKey.totalAttributes < r.primaryKey.keyAttributes
    )
      return invalid();
    for (const col of r.columns) {
      mark('column_type');
      const t = required(ts, col.physicalTypeOid, used.ts);
      if (
        t.schema !== 'pg_catalog' ||
        t.name !== typeNames[col.typeName] ||
        t.kind !== 'b' ||
        t.baseOid !== 0
      )
        return invalid();
      mark('column_routines');
      rr(t.sendRoutineOid);
      rr(t.inputRoutineOid);
      rr(t.outputRoutineOid);
      mark('column_collation');
      cc(col.collationOid);
      if ((t.typeCollationOid === 0) !== (col.collationOid === null)) return invalid();
      mark('array_shape');
      if (
        t.elementOid === 0
          ? t.elementType !== null
          : !t.elementType ||
            t.elementType.oid !== t.elementOid ||
            t.elementType.schema !== 'pg_catalog'
      )
        return invalid();
      if (
        (col.typeName === 'name' || col.typeName === 'uuid[]' || col.typeName === 'inet[]') &&
        t.elementType === null
      )
        return invalid();
      if (t.elementType) {
        const e = t.elementType;
        mark('array_element_type');
        // PG17 name is a scalar identifier with raw char subscripting,
        // not a variable-length array. typelem != 0 alone is not an array test.
        const expected =
          col.typeName === 'name'
            ? { name: 'char', oid: 18, category: 'S' }
            : col.typeName === 'uuid[]'
              ? { name: 'uuid', oid: 2950, category: 'A' }
              : col.typeName === 'inet[]'
                ? { name: 'inet', oid: 869, category: 'A' }
                : null;
        if (
          expected === null ||
          e.name !== expected.name ||
          e.oid !== expected.oid ||
          t.elementOid !== expected.oid ||
          t.category !== expected.category
        )
          return invalid();
        mark('array_element_routines');
        if (
          rr(e.sendRoutineOid).oid !== e.sendOid ||
          rr(e.inputRoutineOid).oid !== e.inputOid ||
          rr(e.outputRoutineOid).oid !== e.outputOid
        )
          return invalid();
      }
      mark('cast_duplicates');
      if (new Set(t.casts.map((v) => `${v.sourceOid}:${v.targetOid}`)).size !== t.casts.length)
        return invalid();
      mark('cast_reference');
      for (const cast of t.casts) {
        if (cast.sourceOid !== t.oid && cast.targetOid !== t.oid) return invalid();
        if (cast.method === 'f') {
          if (rr(cast.functionRoutineOid).oid !== cast.functionOid) return invalid();
        } else if (cast.functionOid !== 0 || cast.functionRoutineOid !== null) return invalid();
      }
    }
    for (const [i, k] of r.primaryKey.components.entries()) {
      mark('primary_key_component');
      const col = r.columns.find((v) => v.name === k.column);
      if (
        !col ||
        k.position !== i + 1 ||
        k.attributePosition !== col.position ||
        k.collationOid !== col.collationOid
      )
        return invalid();
      cc(k.collationOid);
      const t = required(ts, col.physicalTypeOid, used.ts),
        o = required(os, k.opclassOid, used.os);
      mark('primary_key_opclass');
      const polymorphic =
        t.elementOid !== 0 &&
        o.schema === 'pg_catalog' &&
        o.name === 'array_ops' &&
        o.inputTypeOid === 2277;
      if (o.inputTypeOid !== t.oid && !polymorphic) return invalid();
      mark('primary_key_strategies');
      if (
        !same(
          o.operators
            .filter(
              (v) =>
                v.leftTypeOid === o.inputTypeOid &&
                v.rightTypeOid === o.inputTypeOid &&
                v.purpose === 's',
            )
            .map((v) => v.strategy)
            .sort(),
          [1, 2, 3, 4, 5],
        )
      )
        return invalid();
      mark('primary_key_support');
      if (
        !o.supportProcedures.some(
          (v) =>
            v.number === 1 && v.leftTypeOid === o.inputTypeOid && v.rightTypeOid === o.inputTypeOid,
        )
      )
        return invalid();
      mark('primary_key_duplicates');
      if (
        new Set(
          o.operators.map((v) => `${v.strategy}:${v.leftTypeOid}:${v.rightTypeOid}:${v.purpose}`),
        ).size !== o.operators.length ||
        new Set(o.supportProcedures.map((v) => `${v.number}:${v.leftTypeOid}:${v.rightTypeOid}`))
          .size !== o.supportProcedures.length
      )
        return invalid();
      mark('primary_key_routines');
      for (const v of o.operators) rr(v.functionRoutineOid);
      for (const v of o.supportProcedures) rr(v.functionRoutineOid);
    }
  }
  mark('complete_closure');
  if (
    columns !== 1887 ||
    used.ts.size !== ts.size ||
    used.os.size !== os.size ||
    used.rs.size !== rs.size ||
    used.cs.size !== cs.size
  )
    return invalid();
  return freeze({
    schemaVersion: 2 as const,
    authority: 'none' as const,
    registryTrusted: false as const,
    independentRegistration: 'required' as const,
    nativeCanonicalRows: 'not_checked' as const,
    nativeOrderEquality: 'not_checked' as const,
    sequenceHighWater: 'not_checked' as const,
    pgDumpCorrespondence: 'not_checked' as const,
    sourceRosterSha256: pins.roster,
    fixedQuerySha256: pins.query,
    poolCounts: {
      physicalTypes: ts.size,
      opclasses: os.size,
      routines: rs.size,
      collations: cs.size,
    },
    catalog: c,
  });
}
function receiveNativeCatalogCandidateV2(raw: unknown, roster: SourceOwnedRosterV2) {
  let stage: ValidationStage = 'wire_bounds';
  let category: ValidationCategory = 'bounds_rejected';
  const mark: MarkValidation = (nextStage, nextCategory = 'condition_rejected') => {
    stage = nextStage;
    category = nextCategory;
  };
  try {
    return receiveNativeCatalogCandidateAtStageV2(raw, mark, roster);
  } catch {
    throw new NativeCatalogValidationErrorV2(stage, category);
  }
}
export interface NativeCatalogObservationPortV2 {
  withRepeatableRead<T>(
    callback: (transaction: { queryFixed: (sql: string) => Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
}
/** Renderer/server independent metadata observation. The owning adapter must
 * establish actual PG170006 identity and keep one RR READ ONLY transaction open.
 * No credential/filesystem/SQL plug-in is consumed, and this does not admit restore. */
export function createFullRestoreNativeCatalogCollectorV2(
  assets: unknown,
  independentlyPinnedAssets: unknown,
) {
  let sql: string;
  let roster: SourceOwnedRosterV2;
  try {
    if (
      typeof assets !== 'object' ||
      assets === null ||
      Object.getPrototypeOf(assets) !== Object.prototype ||
      Reflect.ownKeys(assets).length !== 2
    )
      throw new NativeCatalogAssetsErrorV2();
    const independent = createBoundedPlainJsonSchema(1024)
      .pipe(
        z.strictObject({
          querySha256: z.literal(pins.query),
          rosterSha256: z.literal(pins.roster),
        }),
      )
      .safeParse(independentlyPinnedAssets);
    if (!independent.success) throw new NativeCatalogAssetsErrorV2();
    const queryBytes = copyAsset(ownData(assets, 'fixedQuery'));
    const rosterBytes = copyAsset(ownData(assets, 'sourceOwnedRoster'));
    sql = decodeAsset(queryBytes, independent.data.querySha256);
    const parsedRoster: unknown = JSON.parse(
      decodeAsset(rosterBytes, independent.data.rosterSha256),
    );
    const bounded = createBoundedPlainJsonSchema(8388608).safeParse(parsedRoster);
    if (!bounded.success) throw new NativeCatalogAssetsErrorV2();
    roster = freeze(rosterSchema.parse(parsedRoster));
  } catch {
    throw new NativeCatalogAssetsErrorV2();
  }
  return Object.freeze({
    receive: (raw: unknown) => receiveNativeCatalogCandidateV2(raw, roster),
    collect: async (port: NativeCatalogObservationPortV2) =>
      port.withRepeatableRead(async (tx) =>
        receiveNativeCatalogCandidateV2(await tx.queryFixed(sql), roster),
      ),
  });
}
