import { createHash } from 'node:crypto';

/**
 * Closed PostgreSQL 17 `pg_node_tree` decoder and catalog binder (EXT-RESTOREa C4).
 *
 * Successor of the TMP CONST/VAR-only candidate. It decodes the node tags that
 * actually occur in the integrated schema's DEFAULT/CHECK/trigger WHEN/index
 * expressions plus RELABELTYPE, with the exact PG17 outfuncs field order. Any
 * other tag, field, enum value or nesting is rejected, never skipped.
 *
 * Binding replaces every OID by catalog identity supplied from the SAME
 * snapshot and checks operator->function, result type, constant length/byval
 * and column type/typmod/collation consistency. The normalized OID-free tree
 * is equality data for comparing two clusters; it does not interpret datum
 * bytes (ABI/endianness) and carries no restore authority.
 */
export type Pg17NodeDecodeErrorCode =
  | 'NODE_INPUT_INVALID'
  | 'NODE_BOUND_EXCEEDED'
  | 'NODE_SYNTAX_UNSUPPORTED'
  | 'NODE_TAG_UNSUPPORTED'
  | 'NODE_FIELD_UNSUPPORTED'
  | 'NODE_VALUE_UNSUPPORTED'
  | 'NODE_REFERENCE_UNBOUND'
  | 'NODE_REFERENCE_INCONSISTENT';
export class Pg17NodeDecodeError extends Error {
  constructor(readonly code: Pg17NodeDecodeErrorCode) {
    super(code);
    this.name = 'Pg17NodeDecodeError';
  }
}
function fail(code: Pg17NodeDecodeErrorCode): never {
  throw new Pg17NodeDecodeError(code);
}

export const PG17_NODE_TREE_MAX_BYTES = 262144;
const MAX_TOKENS = 131072;
const MAX_DEPTH = 64;
const MAX_NODES = 16384;
const MAX_DATUM = 65536;

type Kind =
  | 'type'
  | 'collation'
  | 'operator'
  | 'procedure'
  | 'procedureOrZero'
  | 'int32'
  | 'typmod'
  | 'location'
  | 'bool'
  | 'falseOnly'
  | 'node'
  | 'nodeList'
  | 'emptyBitmap'
  | 'datum'
  | 'attno'
  | 'rangeIndex'
  | 'levelsUp'
  | 'coercionForm'
  | 'boolop'
  | 'nullTest'
  | 'boolTest'
  | 'minMaxOp';
const op = [
  ['opno', 'operator'],
  ['opfuncid', 'procedure'],
  ['opresulttype', 'type'],
  ['opretset', 'falseOnly'],
  ['opcollid', 'collation'],
  ['inputcollid', 'collation'],
  ['args', 'nodeList'],
  ['location', 'location'],
] as const;
/** PG17 outfuncs field order (gen_node_support emits struct order). */
const SPECS: Readonly<Record<string, readonly (readonly [string, Kind])[]>> = Object.freeze({
  CONST: [
    ['consttype', 'type'],
    ['consttypmod', 'typmod'],
    ['constcollid', 'collation'],
    ['constlen', 'int32'],
    ['constbyval', 'bool'],
    ['constisnull', 'bool'],
    ['location', 'location'],
    ['constvalue', 'datum'],
  ],
  VAR: [
    ['varno', 'rangeIndex'],
    ['varattno', 'attno'],
    ['vartype', 'type'],
    ['vartypmod', 'typmod'],
    ['varcollid', 'collation'],
    ['varnullingrels', 'emptyBitmap'],
    ['varlevelsup', 'levelsUp'],
    ['varnosyn', 'rangeIndex'],
    ['varattnosyn', 'attno'],
    ['location', 'location'],
  ],
  OPEXPR: op,
  DISTINCTEXPR: op,
  SCALARARRAYOPEXPR: [
    ['opno', 'operator'],
    ['opfuncid', 'procedure'],
    ['hashfuncid', 'procedureOrZero'],
    ['negfuncid', 'procedureOrZero'],
    ['useOr', 'bool'],
    ['inputcollid', 'collation'],
    ['args', 'nodeList'],
    ['location', 'location'],
  ],
  FUNCEXPR: [
    ['funcid', 'procedure'],
    ['funcresulttype', 'type'],
    ['funcretset', 'falseOnly'],
    ['funcvariadic', 'falseOnly'],
    ['funcformat', 'coercionForm'],
    ['funccollid', 'collation'],
    ['inputcollid', 'collation'],
    ['args', 'nodeList'],
    ['location', 'location'],
  ],
  BOOLEXPR: [
    ['boolop', 'boolop'],
    ['args', 'nodeList'],
    ['location', 'location'],
  ],
  NULLTEST: [
    ['arg', 'node'],
    ['nulltesttype', 'nullTest'],
    ['argisrow', 'falseOnly'],
    ['location', 'location'],
  ],
  BOOLEANTEST: [
    ['arg', 'node'],
    ['booltesttype', 'boolTest'],
    ['location', 'location'],
  ],
  RELABELTYPE: [
    ['arg', 'node'],
    ['resulttype', 'type'],
    ['resulttypmod', 'typmod'],
    ['resultcollid', 'collation'],
    ['relabelformat', 'coercionForm'],
    ['location', 'location'],
  ],
  COERCEVIAIO: [
    ['arg', 'node'],
    ['resulttype', 'type'],
    ['resultcollid', 'collation'],
    ['coerceformat', 'coercionForm'],
    ['location', 'location'],
  ],
  ARRAYEXPR: [
    ['array_typeid', 'type'],
    ['array_collid', 'collation'],
    ['element_typeid', 'type'],
    ['elements', 'nodeList'],
    ['multidims', 'falseOnly'],
    ['location', 'location'],
  ],
  COALESCEEXPR: [
    ['coalescetype', 'type'],
    ['coalescecollid', 'collation'],
    ['args', 'nodeList'],
    ['location', 'location'],
  ],
  MINMAXEXPR: [
    ['minmaxtype', 'type'],
    ['minmaxcollid', 'collation'],
    ['inputcollid', 'collation'],
    ['op', 'minMaxOp'],
    ['args', 'nodeList'],
    ['location', 'location'],
  ],
});
export const PG17_SUPPORTED_NODE_TAGS: readonly string[] = Object.freeze(Object.keys(SPECS));

export type Pg17DatumV1 =
  | Readonly<{ isNull: true }>
  | Readonly<{ isNull: false; length: number; octets: readonly number[] }>;
export type Pg17FieldValueV1 =
  number | boolean | string | Pg17DatumV1 | Pg17NodeV1 | readonly Pg17NodeV1[] | null;
export type Pg17NodeV1 = Readonly<{
  tag: string;
  fields: Readonly<Record<string, Pg17FieldValueV1>>;
}>;
export type Pg17NodeReferenceV1 = Readonly<{
  catalog: 'pg_type' | 'pg_collation' | 'pg_operator' | 'pg_proc';
  oid: number;
}>;
export type DecodedPg17NodeTreeV1 = Readonly<{
  kind: 'decoded_pg17_node_tree_v1';
  rawSha256: string;
  rawByteLength: number;
  /** A top-level List occurs for index expressions; otherwise a single node. */
  root: Pg17NodeV1 | readonly Pg17NodeV1[];
  references: readonly Pg17NodeReferenceV1[];
  nodeCount: number;
  authority: 'none';
}>;

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s*(<>|[{}()[\]]|:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|-?[0-9]+)/y;
  let offset = 0;
  for (;;) {
    pattern.lastIndex = offset;
    const match = pattern.exec(raw);
    if (!match?.[1]) {
      if (raw.slice(offset).trim() !== '') fail('NODE_SYNTAX_UNSUPPORTED');
      return tokens;
    }
    tokens.push(match[1]);
    if (tokens.length > MAX_TOKENS) fail('NODE_BOUND_EXCEEDED');
    offset = pattern.lastIndex;
  }
}

const ENUMS: Partial<Record<Kind, readonly string[]>> = {
  boolop: ['and', 'or', 'not'],
};
const INT_ENUMS: Partial<Record<Kind, readonly [number, number]>> = {
  coercionForm: [0, 3],
  nullTest: [0, 1],
  boolTest: [0, 5],
  minMaxOp: [0, 1],
};
const REFERENCE: Partial<Record<Kind, Pg17NodeReferenceV1['catalog']>> = {
  type: 'pg_type',
  collation: 'pg_collation',
  operator: 'pg_operator',
  procedure: 'pg_proc',
  procedureOrZero: 'pg_proc',
};

export function decodePg17NodeTreeV1(input: unknown): DecodedPg17NodeTreeV1 {
  if (typeof input !== 'string') fail('NODE_INPUT_INVALID');
  const rawByteLength = Buffer.byteLength(input, 'utf8');
  if (rawByteLength < 1 || rawByteLength > PG17_NODE_TREE_MAX_BYTES) fail('NODE_BOUND_EXCEEDED');
  if (input.includes('\0') || /[\uD800-\uDFFF]/u.test(input)) fail('NODE_INPUT_INVALID');
  const tokens = tokenize(input);
  let cursor = 0,
    nodeCount = 0;
  const references = new Map<string, Pg17NodeReferenceV1>();
  const peek = () => tokens[cursor];
  const take = (): string => {
    const token = tokens[cursor++];
    if (token === undefined) fail('NODE_SYNTAX_UNSUPPORTED');
    return token;
  };
  const need = (token: string) => {
    if (take() !== token) fail('NODE_SYNTAX_UNSUPPORTED');
  };
  const integer = (minimum: number, maximum: number): number => {
    const token = take();
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(token) || token === '-0') fail('NODE_VALUE_UNSUPPORTED');
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      fail('NODE_VALUE_UNSUPPORTED');
    return value;
  };
  const bool = (): boolean => {
    const token = take();
    if (token === 'true') return true;
    if (token === 'false') return false;
    return fail('NODE_VALUE_UNSUPPORTED');
  };
  function list(depth: number): readonly Pg17NodeV1[] {
    if (peek() === '<>') {
      cursor++;
      return Object.freeze([]);
    }
    need('(');
    const items: Pg17NodeV1[] = [];
    while (peek() !== ')') items.push(node(depth + 1));
    need(')');
    if (items.length === 0) fail('NODE_SYNTAX_UNSUPPORTED');
    return Object.freeze(items);
  }
  function value(kind: Kind, depth: number): Pg17FieldValueV1 {
    const catalog = REFERENCE[kind];
    if (catalog) {
      const oid = integer(
        kind === 'type' || kind === 'operator' || kind === 'procedure' ? 1 : 0,
        4294967295,
      );
      if (oid !== 0) references.set(`${catalog}:${oid}`, Object.freeze({ catalog, oid }));
      return oid;
    }
    const enumValues = ENUMS[kind];
    if (enumValues) {
      const token = take();
      if (!enumValues.includes(token)) fail('NODE_VALUE_UNSUPPORTED');
      return token;
    }
    const range = INT_ENUMS[kind];
    if (range) return integer(range[0], range[1]);
    switch (kind) {
      case 'int32':
        return integer(-2147483648, 2147483647);
      case 'typmod':
        return integer(-1, 2147483647);
      case 'location':
        return integer(-1, 2147483647);
      case 'attno':
        return integer(1, 1600);
      case 'rangeIndex':
        return integer(1, 2);
      case 'levelsUp':
        return integer(0, 0);
      case 'bool':
        return bool();
      case 'falseOnly':
        if (bool()) fail('NODE_VALUE_UNSUPPORTED');
        return false;
      case 'node':
        return node(depth + 1);
      case 'nodeList':
        return list(depth);
      case 'emptyBitmap':
        need('(');
        need('b');
        need(')');
        return null;
      case 'datum': {
        if (peek() === '<>') {
          cursor++;
          return Object.freeze({ isNull: true });
        }
        const length = integer(0, MAX_DATUM);
        need('[');
        const octets: number[] = [];
        while (peek() !== ']') {
          if (octets.length >= MAX_DATUM) fail('NODE_BOUND_EXCEEDED');
          octets.push(integer(-128, 255));
        }
        need(']');
        return Object.freeze({ isNull: false, length, octets: Object.freeze(octets) });
      }
      default:
        return fail('NODE_FIELD_UNSUPPORTED');
    }
  }
  function node(depth: number): Pg17NodeV1 {
    if (depth > MAX_DEPTH) fail('NODE_BOUND_EXCEEDED');
    if (++nodeCount > MAX_NODES) fail('NODE_BOUND_EXCEEDED');
    need('{');
    const tag = take();
    const spec = SPECS[tag];
    if (!spec || !Object.hasOwn(SPECS, tag)) fail('NODE_TAG_UNSUPPORTED');
    const fields: Record<string, Pg17FieldValueV1> = {};
    for (const [name, kind] of spec) {
      if (take() !== `:${name}`) fail('NODE_FIELD_UNSUPPORTED');
      fields[name] = value(kind, depth);
    }
    need('}');
    const result = Object.freeze({ tag, fields: Object.freeze(fields) });
    checkShape(result);
    return result;
  }
  let root: Pg17NodeV1 | readonly Pg17NodeV1[];
  if (peek() === '(') {
    root = list(0);
  } else root = node(0);
  if (cursor !== tokens.length) fail('NODE_SYNTAX_UNSUPPORTED');
  return Object.freeze({
    kind: 'decoded_pg17_node_tree_v1',
    rawSha256: createHash('sha256').update(input, 'utf8').digest('hex'),
    rawByteLength,
    root,
    references: Object.freeze(
      [...references.values()].sort((a, b) =>
        a.catalog === b.catalog ? a.oid - b.oid : a.catalog < b.catalog ? -1 : 1,
      ),
    ),
    nodeCount,
    authority: 'none',
  });
}

/** Local arity and datum shape rules that need no catalog. */
function checkShape(node: Pg17NodeV1) {
  const f = node.fields;
  const args = (name: string) => f[name] as readonly Pg17NodeV1[];
  switch (node.tag) {
    case 'CONST': {
      const datum = f['constvalue'] as Pg17DatumV1;
      const length = f['constlen'] as number;
      if (length === 0 || length < -2) fail('NODE_VALUE_UNSUPPORTED');
      if ((f['constisnull'] as boolean) !== datum.isNull) fail('NODE_VALUE_UNSUPPORTED');
      if (!datum.isNull) {
        if (f['constbyval']) {
          // byval Datum is written as the full machine word; only 64-bit hosts are accepted.
          if (
            ![1, 2, 4, 8].includes(length) ||
            datum.length !== length ||
            datum.octets.length !== 8
          )
            fail('NODE_VALUE_UNSUPPORTED');
        } else if (datum.length !== datum.octets.length || (length > 0 && datum.length !== length))
          fail('NODE_VALUE_UNSUPPORTED');
      }
      return;
    }
    case 'VAR':
      if (f['varno'] !== f['varnosyn'] || f['varattno'] !== f['varattnosyn'])
        fail('NODE_VALUE_UNSUPPORTED');
      return;
    case 'OPEXPR':
      if (args('args').length < 1 || args('args').length > 2) fail('NODE_VALUE_UNSUPPORTED');
      return;
    case 'DISTINCTEXPR':
    case 'SCALARARRAYOPEXPR':
      if (args('args').length !== 2) fail('NODE_VALUE_UNSUPPORTED');
      return;
    case 'BOOLEXPR': {
      const count = args('args').length;
      if (f['boolop'] === 'not' ? count !== 1 : count < 2) fail('NODE_VALUE_UNSUPPORTED');
      return;
    }
    case 'COALESCEEXPR':
    case 'MINMAXEXPR':
      if (args('args').length < 1) fail('NODE_VALUE_UNSUPPORTED');
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- binding

export type Pg17CatalogSnapshotV1 = Readonly<{
  types: readonly Readonly<{
    oid: number;
    schema: string;
    name: string;
    typlen: number;
    typbyval: boolean;
    typtype: string;
  }>[];
  collations: readonly Readonly<{ oid: number; schema: string; name: string }>[];
  operators: readonly Readonly<{
    oid: number;
    schema: string;
    name: string;
    left: number;
    right: number;
    result: number;
    code: number;
  }>[];
  procedures: readonly Readonly<{
    oid: number;
    schema: string;
    name: string;
    args: readonly number[];
    result: number;
    retset: boolean;
    /** provariadic; 0 when the function is not variadic. */
    variadic: number;
  }>[];
}>;
export type Pg17BindingColumnV1 = Readonly<{
  attnum: number;
  name: string;
  typeOid: number;
  typmod: number;
  collationOid: number;
}>;
/** `relation`: varno 1 only. `trigger`: varno 1 = OLD, 2 = NEW of the same relation. */
export type Pg17BindingContextV1 = Readonly<{
  scope: 'relation' | 'trigger';
  columns: readonly Pg17BindingColumnV1[];
}>;
export type BoundPg17NodeTreeV1 = Readonly<{
  kind: 'bound_pg17_node_tree_v1';
  normalized: unknown;
  normalizedSha256: string;
  polymorphicResults: number;
  authority: 'none';
  semanticEquivalence: 'normalized_tree_equality_only';
}>;

function index<T extends { oid: number }>(rows: readonly T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.oid) || row.oid <= 0 || map.has(row.oid))
      fail('NODE_REFERENCE_INCONSISTENT');
    map.set(row.oid, row);
  }
  return map;
}
export function canonicalPg17Json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPg17Json).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) => `${JSON.stringify(k)}:${canonicalPg17Json((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) fail('NODE_VALUE_UNSUPPORTED');
  return text;
}

export function bindPg17NodeTreeV1(
  decoded: DecodedPg17NodeTreeV1,
  catalog: Pg17CatalogSnapshotV1,
  context: Pg17BindingContextV1,
): BoundPg17NodeTreeV1 {
  if (decoded?.kind !== 'decoded_pg17_node_tree_v1') fail('NODE_INPUT_INVALID');
  const types = index(catalog.types),
    collations = index(catalog.collations),
    operators = index(catalog.operators),
    procedures = index(catalog.procedures);
  const columns = new Map<number, Pg17BindingColumnV1>();
  for (const column of context.columns) {
    if (columns.has(column.attnum)) fail('NODE_REFERENCE_INCONSISTENT');
    columns.set(column.attnum, column);
  }
  let polymorphicResults = 0;
  const type = (oid: number) => {
    const row = types.get(oid);
    if (!row) return fail('NODE_REFERENCE_UNBOUND');
    return `${row.schema}.${row.name}`;
  };
  const collation = (oid: number) => {
    if (oid === 0) return null;
    const row = collations.get(oid);
    if (!row) return fail('NODE_REFERENCE_UNBOUND');
    return `${row.schema}.${row.name}`;
  };
  const procedure = (oid: number) => {
    if (oid === 0) return null;
    const row = procedures.get(oid);
    if (!row) return fail('NODE_REFERENCE_UNBOUND');
    return `${row.schema}.${row.name}(${row.args.map(type).join(',')})`;
  };
  const resultMatches = (declared: number, actual: number) => {
    if (declared === actual) return;
    const declaredType = types.get(declared);
    if (!declaredType) fail('NODE_REFERENCE_UNBOUND');
    // Polymorphic/pseudo result (anyelement etc.) is resolved per call site.
    if (declaredType.typtype !== 'p') fail('NODE_REFERENCE_INCONSISTENT');
    polymorphicResults++;
  };
  const operator = (oid: number, functionOid: number, resultOid: number | null) => {
    const row = operators.get(oid);
    if (!row) return fail('NODE_REFERENCE_UNBOUND');
    if (row.code !== functionOid) fail('NODE_REFERENCE_INCONSISTENT');
    if (resultOid !== null) resultMatches(row.result, resultOid);
    procedure(functionOid);
    const side = (o: number) => (o === 0 ? '' : type(o));
    return `${row.schema}.${row.name}(${side(row.left)},${side(row.right)})`;
  };
  function bind(node: Pg17NodeV1): unknown {
    const f = node.fields;
    const n = (name: string) => f[name] as number;
    const many = (name: string) => (f[name] as readonly Pg17NodeV1[]).map(bind);
    switch (node.tag) {
      case 'CONST': {
        const row = types.get(n('consttype'));
        if (!row) return fail('NODE_REFERENCE_UNBOUND');
        if (row.typlen !== n('constlen') || row.typbyval !== f['constbyval'])
          fail('NODE_REFERENCE_INCONSISTENT');
        return {
          const: type(n('consttype')),
          typmod: n('consttypmod'),
          collation: collation(n('constcollid')),
          value: f['constvalue'],
        };
      }
      case 'VAR': {
        if (context.scope === 'relation' && n('varno') !== 1) fail('NODE_REFERENCE_INCONSISTENT');
        const column = columns.get(n('varattno'));
        if (
          !column ||
          column.typeOid !== n('vartype') ||
          column.typmod !== n('vartypmod') ||
          column.collationOid !== n('varcollid')
        )
          fail('NODE_REFERENCE_INCONSISTENT');
        type(n('vartype'));
        collation(n('varcollid'));
        return context.scope === 'trigger'
          ? { var: column.name, row: n('varno') === 1 ? 'OLD' : 'NEW' }
          : { var: column.name };
      }
      case 'OPEXPR':
      case 'DISTINCTEXPR': {
        const row = operators.get(n('opno'));
        if (row && (row.left === 0) !== ((f['args'] as readonly unknown[]).length === 1))
          fail('NODE_REFERENCE_INCONSISTENT');
        return {
          [node.tag === 'OPEXPR' ? 'op' : 'distinct']: operator(
            n('opno'),
            n('opfuncid'),
            node.tag === 'OPEXPR' ? n('opresulttype') : null,
          ),
          result: type(n('opresulttype')),
          collation: collation(n('opcollid')),
          inputCollation: collation(n('inputcollid')),
          args: many('args'),
        };
      }
      case 'SCALARARRAYOPEXPR':
        return {
          arrayOp: operator(n('opno'), n('opfuncid'), null),
          hash: procedure(n('hashfuncid')),
          negate: procedure(n('negfuncid')),
          useOr: f['useOr'],
          inputCollation: collation(n('inputcollid')),
          args: many('args'),
        };
      case 'FUNCEXPR': {
        const row = procedures.get(n('funcid'));
        if (!row) return fail('NODE_REFERENCE_UNBOUND');
        const supplied = (f['args'] as readonly unknown[]).length;
        // funcvariadic is always false here; a variadic function then receives its
        // variadic arguments spread (VARIADIC "any") or zero-or-more extra items.
        if (
          row.retset ||
          (row.variadic === 0 ? row.args.length !== supplied : supplied < row.args.length - 1)
        )
          fail('NODE_REFERENCE_INCONSISTENT');
        resultMatches(row.result, n('funcresulttype'));
        return {
          func: procedure(n('funcid')),
          result: type(n('funcresulttype')),
          format: n('funcformat'),
          collation: collation(n('funccollid')),
          inputCollation: collation(n('inputcollid')),
          args: many('args'),
        };
      }
      case 'BOOLEXPR':
        return { bool: f['boolop'], args: many('args') };
      case 'NULLTEST':
        return { nullTest: n('nulltesttype'), arg: bind(f['arg'] as Pg17NodeV1) };
      case 'BOOLEANTEST':
        return { booleanTest: n('booltesttype'), arg: bind(f['arg'] as Pg17NodeV1) };
      case 'RELABELTYPE':
        return {
          relabel: type(n('resulttype')),
          typmod: n('resulttypmod'),
          collation: collation(n('resultcollid')),
          format: n('relabelformat'),
          arg: bind(f['arg'] as Pg17NodeV1),
        };
      case 'COERCEVIAIO':
        return {
          coerceViaIo: type(n('resulttype')),
          collation: collation(n('resultcollid')),
          format: n('coerceformat'),
          arg: bind(f['arg'] as Pg17NodeV1),
        };
      case 'ARRAYEXPR':
        return {
          array: type(n('array_typeid')),
          element: type(n('element_typeid')),
          collation: collation(n('array_collid')),
          elements: many('elements'),
        };
      case 'COALESCEEXPR':
        return {
          coalesce: type(n('coalescetype')),
          collation: collation(n('coalescecollid')),
          args: many('args'),
        };
      case 'MINMAXEXPR':
        return {
          minmax: n('op') === 0 ? 'greatest' : 'least',
          type: type(n('minmaxtype')),
          collation: collation(n('minmaxcollid')),
          inputCollation: collation(n('inputcollid')),
          args: many('args'),
        };
      default:
        return fail('NODE_TAG_UNSUPPORTED');
    }
  }
  const normalized = Array.isArray(decoded.root)
    ? (decoded.root as readonly Pg17NodeV1[]).map(bind)
    : bind(decoded.root as Pg17NodeV1);
  const text = canonicalPg17Json(normalized);
  return Object.freeze({
    kind: 'bound_pg17_node_tree_v1',
    normalized: JSON.parse(text) as unknown,
    normalizedSha256: createHash('sha256')
      .update('wm-pg17-normalized-node-tree-v1\0')
      .update(text)
      .digest('hex'),
    polymorphicResults,
    authority: 'none',
    semanticEquivalence: 'normalized_tree_equality_only',
  });
}
