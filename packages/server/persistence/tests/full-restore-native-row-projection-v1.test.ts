import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createFullRestoreNativeCatalogCollectorV2 } from '../src/full-restore-native-catalog-v2/collector.js';
import { createFullRestoreNativeRowProjectionV1 } from '../src/full-restore-native-row-projection-v1.js';

// Existing catalog fixture construction only: synthetic metadata, not source rows
// or independently trusted registry evidence. Production engine is not duplicated.
function must<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
const roster: {
  tables: {
    schema: string;
    relation: string;
    orderingKey: string[];
    columns: {
      position: number;
      name: string;
      type: string;
      typmod: number;
      nullable: boolean;
    }[];
  }[];
  indexes: { schema: string; relation: string }[];
  sequences: { schema: string; relation: string }[];
} = JSON.parse(
  readFileSync(
    new URL('../src/full-restore-native-catalog-v2/source-owned-roster.json', import.meta.url),
    'utf8',
  ),
);
const names: Record<string, string> = {
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
function fixture(routinePadding = 0) {
  const routine = {
    oid: 101,
    schema: 'pg_catalog',
    name: 'synthetic_send',
    identityArguments: 'x'.repeat(routinePadding),
    returnType: 17,
    owner: 'postgres',
    volatility: 'i',
    parallel: 's',
    strict: true,
    leakproof: false,
    securityDefiner: false,
    kind: 'f',
    language: 'internal',
    implementationLibrary: null,
    config: null,
    acl: null,
    bodySha256: 'a'.repeat(64),
  };
  const casts: {
    sourceOid: number;
    targetOid: number;
    context: string;
    method: string;
    functionOid: number;
    function: typeof routine | null;
  }[] = [];
  const relations = roster.tables.map((t, index) => ({
    schema: t.schema,
    relation: t.relation,
    oid: index + 1000,
    kind: 'r',
    owner: 'synthetic_owner',
    acl: null,
    rls: true,
    forceRls: true,
    partition: false,
    parents: [],
    partitionBound: null,
    columns: t.columns.map((c) => ({
      position: c.position,
      name: c.name,
      typmod: c.typmod,
      nullable: c.nullable,
      typeName: c.type,
      identity: '',
      generated: '',
      defaultExpression: null,
      collation: null,
      physicalType: {
        oid: 100,
        schema: 'pg_catalog',
        name: names[c.type],
        kind: 'b',
        category: c.type === 'name' ? 'S' : c.type.endsWith('[]') ? 'A' : 'U',
        elementOid: c.type === 'name' ? 18 : c.type.endsWith('[]') ? 200 : 0,
        arrayOid: 0,
        baseOid: 0,
        typeCollationOid: 0,
        send: routine as typeof routine | null,
        input: routine,
        output: routine,
        elementType:
          c.type === 'name' || c.type.endsWith('[]')
            ? {
                oid: 200,
                schema: 'pg_catalog',
                name: c.type === 'name' ? 'char' : c.type === 'uuid[]' ? 'uuid' : 'inet',
                sendOid: 101,
                inputOid: 101,
                outputOid: 101,
                send: routine,
                input: routine,
                output: routine,
              }
            : null,
        casts,
      },
    })),
    primaryKey: {
      oid: index + 3000,
      name: 'synthetic_pkey',
      accessMethod: 'btree',
      unique: true,
      valid: true,
      ready: true,
      keyAttributes: t.orderingKey.length,
      totalAttributes: t.orderingKey.length,
      expression: null,
      predicate: null,
      components: t.orderingKey.map((column, i) => ({
        position: i + 1,
        attributePosition: t.columns.find((c) => c.name === column)?.position,
        column,
        sortOptions: 0,
        collation: null,
        opclass: {
          oid: 100,
          schema: 'pg_catalog',
          name: 'synthetic_ops',
          default: true,
          inputTypeOid: 100,
          keyTypeOid: 0,
          familyOid: 100,
          familySchema: 'pg_catalog',
          familyName: 'synthetic_ops',
          operators: [1, 2, 3, 4, 5].map((strategy) => ({
            oid: 100 + strategy,
            schema: 'pg_catalog',
            name: '=',
            strategy,
            leftTypeOid: 100,
            rightTypeOid: 100,
            purpose: 's',
            function: routine,
          })),
          supportProcedures: [
            {
              number: 1,
              leftTypeOid: 100,
              rightTypeOid: 100,
              function: routine,
            },
          ],
        },
      })),
    },
  }));
  return {
    schemaVersion: 1,
    serverVersionNum: 170006,
    isolation: 'repeatable read',
    readOnly: 'on',
    exportedSnapshot: '00000001-00000002-1',
    transactionSnapshot: '10:11:',
    walObservation: '0/100',
    database: {
      oid: 1,
      encoding: 'UTF8',
      collation: 'C',
      ctype: 'C',
      provider: 'c',
      locale: null,
      version: null,
      actualVersion: null,
      owner: 'postgres',
    },
    schemas: [...new Set(roster.tables.map((t) => t.schema))]
      .sort()
      .map((name) => ({ name, owner: 'synthetic_owner', acl: null })),
    namespaceRelations: [
      ...roster.tables.map((t) => ({
        schema: t.schema,
        relation: t.relation,
        kind: 'r',
      })),
      ...roster.indexes.map((t) => ({ ...t, kind: 'i' })),
      ...roster.sequences.map((t) => ({ ...t, kind: 'S' })),
    ],
    relations,
    sequences: roster.sequences.map((s) => ({
      ...s,
      oid: 99,
      owner: 'synthetic_owner',
      typeOid: 20,
      start: '1',
      increment: '1',
      minimum: '1',
      maximum: '9223372036854775807',
      cache: '1',
      cycle: false,
      dependencies: [],
    })),
  };
}

function normalizedFixture(routinePadding = 0) {
  const c = fixture(routinePadding);
  const map = new Map<string, number>();
  let next = 300;
  for (const r of c.relations) {
    for (const col of r.columns) {
      if (!map.has(col.typeName)) map.set(col.typeName, next++);
      const t = col.physicalType;
      t.oid = must(map.get(col.typeName));
      if (t.elementType) {
        t.elementOid = col.typeName === 'name' ? 18 : col.typeName === 'uuid[]' ? 2950 : 869;
        t.elementType.oid = t.elementOid;
      }
    }
    for (const k of r.primaryKey.components) {
      const col = must(r.columns.find((c) => c.name === k.column));
      const o = k.opclass;
      o.oid = col.physicalType.oid + 1000;
      o.inputTypeOid = col.physicalType.oid;
      for (const v of o.operators) {
        v.leftTypeOid = o.inputTypeOid;
        v.rightTypeOid = o.inputTypeOid;
      }
      for (const v of o.supportProcedures) {
        v.leftTypeOid = o.inputTypeOid;
        v.rightTypeOid = o.inputTypeOid;
      }
    }
  }
  const entries = {
    physicalTypes: new Map<number, unknown>(),
    opclasses: new Map<number, unknown>(),
    routines: new Map<number, unknown>(),
    collations: new Map<number, unknown>(),
  };
  function intern(which: keyof typeof entries, raw: unknown): number | null {
    if (raw === null) return null;
    if (typeof raw !== 'object' || raw === null || !('oid' in raw) || typeof raw.oid !== 'number')
      throw Error('fixture');
    const prior = entries[which].get(raw.oid);
    if (prior !== undefined) assert.deepEqual(prior, raw);
    entries[which].set(raw.oid, raw);
    return raw.oid;
  }
  const relations = c.relations.map((r) => ({
    ...r,
    columns: r.columns.map((col) => {
      const { physicalType: t, collation, ...rest } = col;
      const { send, input, output, elementType, casts, ...type } = t;
      const nt = {
        ...type,
        sendRoutineOid: intern('routines', send),
        inputRoutineOid: intern('routines', input),
        outputRoutineOid: intern('routines', output),
        elementType: elementType
          ? (() => {
              const { send, input, output, ...e } = elementType;
              return {
                ...e,
                sendRoutineOid: intern('routines', send),
                inputRoutineOid: intern('routines', input),
                outputRoutineOid: intern('routines', output),
              };
            })()
          : null,
        casts: casts.map((v) => {
          const { function: fn, ...rest } = v;
          return { ...rest, functionRoutineOid: intern('routines', fn) };
        }),
      };
      return {
        ...rest,
        physicalTypeOid: intern('physicalTypes', nt),
        collationOid: intern('collations', collation),
      };
    }),
    primaryKey: {
      ...r.primaryKey,
      components: r.primaryKey.components.map((k) => {
        const { opclass: o, collation, ...rest } = k;
        const no = {
          ...o,
          operators: o.operators.map((v) => {
            const { function: fn, ...rest } = v;
            return { ...rest, functionRoutineOid: intern('routines', fn) };
          }),
          supportProcedures: o.supportProcedures.map((v) => {
            const { function: fn, ...rest } = v;
            return { ...rest, functionRoutineOid: intern('routines', fn) };
          }),
        };
        return {
          ...rest,
          opclassOid: intern('opclasses', no),
          collationOid: intern('collations', collation),
        };
      }),
    },
  }));
  const pools = Object.fromEntries(
    Object.entries(entries).map(([name, map]) => [
      name,
      [...map.entries()]
        .sort(([a], [b]) => a - b)
        .map(([oid, metadata]) => {
          const pgJsonbText = JSON.stringify(metadata);
          return {
            oid,
            pgJsonbText,
            metadataSha256: createHash('sha256').update(pgJsonbText).digest('hex'),
          };
        }),
    ]),
  );
  return {
    wire: {
      ...c,
      schemaVersion: 2,
      payloadEncoding: 'oid-normalized-native-catalog-v2',
      relations,
      pools,
    },
    expanded: c,
    expandedBytes: Buffer.byteLength(JSON.stringify(c)),
  };
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));
const physicalNames = {
  text: 'text',
  uuid: 'uuid',
  integer: 'int32',
  bigint: 'int64',
  numeric: 'numericdecimal',
  boolean: 'boolean',
  date: 'date',
  'timestamp with time zone': 'timestamptzUTC6',
  bytea: 'bytea',
  name: 'name',
  'double precision': 'float8sendbits',
  'uuid[]': 'uuid[]',
  'inet[]': 'inet[]',
  jsonb: 'jsonb',
} as const;
function setup() {
  const wire = normalizedFixture().wire;
  const catalog = bytes(wire);
  const fixedQuery = new Uint8Array(
    readFileSync(new URL('../src/full-restore-native-catalog-v2/fixed-query.sql', import.meta.url)),
  );
  const sourceOwnedRoster = new Uint8Array(
    readFileSync(
      new URL('../src/full-restore-native-catalog-v2/source-owned-roster.json', import.meta.url),
    ),
  );
  const observed = createFullRestoreNativeCatalogCollectorV2(
    { fixedQuery, sourceOwnedRoster },
    { querySha256: hash(fixedQuery), rosterSha256: hash(sourceOwnedRoster) },
  ).receive(wire).catalog;
  const registration = {
    schemaVersion: 1,
    kind: 'native-row-projection-registration-v1',
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
    catalogSha256: hash(catalog),
    tables: observed.relations.map((r) => ({
      schema: r.schema,
      relation: r.relation,
      columnBindingSha256: hash(JSON.stringify(r.columns)),
      primaryKeyBindingSha256: hash(JSON.stringify(r.primaryKey)),
      columns: r.columns.map((c) => {
        const pgType = physicalNames[c.typeName as keyof typeof physicalNames];
        if (!pgType) throw Error('synthetic_type_required');
        return {
          column: c.name,
          pgType,
          maxBytes: 4096,
          maxElements: c.typeName.endsWith('[]') ? 100 : 0,
        };
      }),
      maxRows: 5000,
      maxBytes: 16777216,
      maxRowBytes: 4194304,
    })),
  };
  const build = () => {
    const raw = bytes(registration);
    return createFullRestoreNativeRowProjectionV1(
      { registration: raw, catalog, fixedQuery, sourceOwnedRoster },
      {
        registrationSha256: hash(raw),
        catalogSha256: hash(catalog),
        querySha256: hash(fixedQuery),
        rosterSha256: hash(sourceOwnedRoster),
      },
    );
  };
  return { registration, wire, catalog, fixedQuery, sourceOwnedRoster, build };
}
const f = setup();
const factory = f.build();
function carrier(body: string | null, count = '0', max = '0', length = '2') {
  return {
    session_ok: true,
    row_count: count,
    invalid_rows: '0',
    max_row_bytes: max,
    byte_length: length,
    body,
  };
}
function firstPlan() {
  return must(factory.allPlans[0]);
}
function exampleRow() {
  const plan = firstPlan();
  const row = {
    rowVersion: 2,
    columns: plan.columns.map((c) => ({
      column: c.column,
      value:
        c.pgType === 'boolean'
          ? { kind: 'boolean', value: false }
          : c.pgType === 'text'
            ? { kind: 'text', value: 'synthetic' }
            : c.pgType === 'uuid'
              ? { kind: 'uuid', value: '00000000-0000-0000-0000-000000000001' }
              : { kind: 'sql_null' },
    })),
  };
  return { plan, text: JSON.stringify([row]), row };
}
describe('source-owned native row projection C1', () => {
  it('covers the complete fixed census without admitting a restore or executing I/O', () => {
    expect(factory.allPlans).toHaveLength(239);
    expect(factory.allPlans.reduce((n, p) => n + p.columns.length, 0)).toBe(1887);
    expect(factory.namespaceRelationCount).toBe(704);
    expect(factory).toMatchObject({
      authority: 'none',
      registryTrusted: false,
      admissionAllowed: false,
    });
    expect(factory.allPlans.every((p) => Object.isFrozen(p) && Object.isFrozen(p.columns))).toBe(
      true,
    );
    expect(firstPlan()).toMatchObject({
      nativeCanonicalVerification: 'not_checked',
      nativeOrderEquality: 'not_checked',
      sequenceHighWater: 'not_checked',
      pgDumpCorrespondence: 'not_checked',
    });
    expect(() => factory.getPlan('public', 'unregistered')).toThrow('PROJECTION_RELATION_UNKNOWN');
    expect(() => factory.getPlan('public;DROP TABLE x', 'synthetic')).toThrow(
      'PROJECTION_RELATION_UNKNOWN',
    );
  });
  it('keeps native typed composite order and full census rather than ordering encoded text or sampling', () => {
    const plan = must(factory.allPlans.find((p) => p.orderingKey.length > 1));
    for (const key of plan.orderingKey) expect(plan.sql).toContain(`t."${key}" AS k`);
    expect(plan.sql).toContain('string_agg(row_text');
    expect(plan.sql).not.toMatch(/\bLIMIT\b|ORDER BY row_text/);
    expect(plan.sql).toContain('stats.row_count<=5000');
    expect(plan.sql).toContain('stats.max_row_bytes<=4194304');
    expect(plan.sql).toContain('stats.byte_length<=16777216');
  });
  it('provides all14 scalar forms, preserves JSONB opaque numeric text and SQL NULL distinction', () => {
    const seen = new Set(factory.allPlans.flatMap((p) => p.columns.map((c) => c.pgType)));
    expect([...seen].sort()).toEqual(Object.values(physicalNames).sort());
    const json = must(factory.allPlans.find((p) => p.columns.some((c) => c.pgType === 'jsonb')));
    expect(json.sql).toContain("'kind','sql_null'");
    expect(json.sql).toContain("'kind','jsonb','text'");
    expect(json.sql).toContain('pg_catalog.sha256(pg_catalog.convert_to(');
    const float = must(
      factory.allPlans.find((p) => p.columns.some((c) => c.pgType === 'float8sendbits')),
    );
    expect(float.sql).toContain('pg_catalog.float8send(');
    const arr = must(factory.allPlans.find((p) => p.columns.some((c) => c.pgType === 'inet[]')));
    expect(arr.sql).toContain('WITH ORDINALITY');
    expect(arr.sql).toContain('array_lower');
    expect(arr.sql).toContain('array_length');
    expect(arr.sql).toContain('cardinality');
  });
  it('rejects missing/duplicate tables, reordered columns, invalid types and widened bounds', () => {
    const variants = [
      (r: ReturnType<typeof setup>['registration']) => r.tables.pop(),
      (r: ReturnType<typeof setup>['registration']) => {
        r.tables[1] = must(r.tables[0]);
      },
      (r: ReturnType<typeof setup>['registration']) => must(r.tables[0]).columns.reverse(),
      (r: ReturnType<typeof setup>['registration']) => {
        must(must(r.tables[0]).columns[0]).pgType = 'uuid';
      },
      (r: ReturnType<typeof setup>['registration']) => {
        must(r.tables[0]).maxRows = 5001;
      },
      (r: ReturnType<typeof setup>['registration']) => {
        must(r.tables[0]).maxRowBytes = 4194305;
      },
      (r: ReturnType<typeof setup>['registration']) => {
        must(r.tables[0]).maxBytes = 16777217;
      },
      (r: ReturnType<typeof setup>['registration']) => {
        must(r.tables[0]).primaryKeyBindingSha256 = 'f'.repeat(64);
      },
      (r: ReturnType<typeof setup>['registration']) => {
        must(r.tables[0]).columnBindingSha256 = 'f'.repeat(64);
      },
    ];
    for (const change of variants) {
      const next = setup();
      change(next.registration);
      expect(next.build).toThrow(/PROJECTION_/);
    }
  });
  it('does not use caller-supplied SQL, unsafe accessors, shared buffers or wrong independent hashes', () => {
    const getter = vi.fn();
    const raw = bytes(f.registration);
    const assets = {
      registration: raw,
      catalog: f.catalog,
      fixedQuery: f.fixedQuery,
      sourceOwnedRoster: f.sourceOwnedRoster,
    };
    const pins = {
      registrationSha256: hash(raw),
      catalogSha256: hash(f.catalog),
      querySha256: hash(f.fixedQuery),
      rosterSha256: hash(f.sourceOwnedRoster),
    };
    expect(() =>
      createFullRestoreNativeRowProjectionV1({ ...assets, sql: 'SELECT true' }, pins),
    ).toThrow('PROJECTION_ASSETS_INVALID');
    expect(() =>
      createFullRestoreNativeRowProjectionV1(
        Object.defineProperty({ ...assets }, 'catalog', { get: getter }),
        pins,
      ),
    ).toThrow('PROJECTION_ASSETS_INVALID');
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      createFullRestoreNativeRowProjectionV1(
        { ...assets, registration: new Uint8Array(new SharedArrayBuffer(8)) },
        pins,
      ),
    ).toThrow('PROJECTION_ASSETS_INVALID');
    expect(() =>
      createFullRestoreNativeRowProjectionV1(assets, {
        ...pins,
        registrationSha256: '0'.repeat(64),
      }),
    ).toThrow('PROJECTION_ASSETS_INVALID');
    const different = bytes({ ...f.registration, catalogSha256: 'f'.repeat(64) });
    expect(() =>
      createFullRestoreNativeRowProjectionV1(
        { ...assets, registration: different },
        { ...pins, registrationSha256: hash(different) },
      ),
    ).toThrow('PROJECTION_ASSETS_INVALID');
  });
  it('captures assets immutably; mutation cannot replace identities, SQL or bounds after construction', () => {
    const local = setup(),
      built = local.build();
    local.catalog.fill(0);
    local.fixedQuery.fill(0);
    local.sourceOwnedRoster.fill(0);
    must(local.registration.tables[0]).maxRows = 0;
    expect(must(built.allPlans[0]).maxRows).toBe(5000);
    expect(must(built.allPlans[0]).receiveCarrier(carrier('[]'))).toMatchObject({
      rowCount: 0,
      byteLength: 2,
      authority: 'none',
      registryTrusted: false,
    });
  });
  it('keeps original packet bytes/SHA and frozen typed rows; empty is exact[]', () => {
    const { plan, text, row } = exampleRow();
    const result = plan.receiveCarrier(
      carrier(
        text,
        '1',
        String(Buffer.byteLength(JSON.stringify(row))),
        String(Buffer.byteLength(text)),
      ),
    );
    expect(result.kind).toBe('validated_full_restore_physical_row_packet_v2');
    if (result.kind !== 'validated_full_restore_physical_row_packet_v2')
      throw Error('validated_required');
    expect(result.rowsSha256).toBe(hash(text));
    expect(new TextDecoder().decode(result.copyOriginalUtf8())).toBe(text);
    result.copyOriginalUtf8().fill(0);
    expect(result.rowsSha256).toBe(hash(text));
    expect(Object.isFrozen(result.rows[0]?.columns)).toBe(true);
    expect(plan.receiveCarrier(carrier('[]'))).toMatchObject({ rowCount: 0 });
    expect(() => plan.receiveCarrier(carrier('[ ]'))).toThrow('PROJECTION_CARRIER_INVALID');
  });
  it('returns finite body-null rejection for5001/oversize/scalar/session cases without fallback', () => {
    for (const raw of [
      carrier(null, '5001'),
      carrier(null, '1', '4194305'),
      carrier(null, '1', '1', '16777217'),
      { ...carrier(null, '1'), invalid_rows: '1' },
      { ...carrier(null), session_ok: false },
    ]) {
      expect(firstPlan().receiveCarrier(raw).kind).toBe('rejected_native_row_carrier_v1');
      expect(() => firstPlan().receiveCarrier({ ...raw, body: '[]' })).toThrow(
        'PROJECTION_CARRIER_INVALID',
      );
    }
    expect(() => firstPlan().receiveCarrier(carrier(null))).toThrow('PROJECTION_CARRIER_INVALID');
  });
  it('rejects malformed/count/hash-correspondence carrier facts without reading arbitrary driver fields', () => {
    const { plan, text, row } = exampleRow();
    const valid = carrier(
      text,
      '1',
      String(Buffer.byteLength(JSON.stringify(row))),
      String(Buffer.byteLength(text)),
    );
    expect(plan.receiveCarrier(valid).kind).toBe('validated_full_restore_physical_row_packet_v2');
    for (const raw of [
      { ...valid, row_count: '2' },
      { ...valid, byte_length: '2' },
      { ...valid, query: 'private' },
      { ...valid, row_count: '1e3' },
      { ...valid, invalid_rows: '2' },
      { ...valid, byte_length: '9'.repeat(20) },
    ])
      expect(() => plan.receiveCarrier(raw)).toThrow('PROJECTION_CARRIER_INVALID');
    const getter = vi.fn();
    expect(() =>
      plan.receiveCarrier(Object.defineProperty({ ...valid }, 'body', { get: getter })),
    ).toThrow('PROJECTION_CARRIER_INVALID');
    expect(getter).not.toHaveBeenCalled();
  });
  it('refuses nondefault native operator classes and reverse PK order instead of guessing an equivalent order', () => {
    for (const mode of ['reverse', 'nondefault']) {
      const local = setup();
      if (mode === 'reverse') {
        must(must(local.wire.relations[0]).primaryKey.components[0]).sortOptions = 1;
      } else {
        const entry = must(local.wire.pools.opclasses?.[0]);
        const value: Record<string, unknown> = JSON.parse(entry.pgJsonbText);
        value.default = false;
        entry.pgJsonbText = JSON.stringify(value);
        entry.metadataSha256 = hash(entry.pgJsonbText);
      }
      const native = createFullRestoreNativeCatalogCollectorV2(
        { fixedQuery: local.fixedQuery, sourceOwnedRoster: local.sourceOwnedRoster },
        { querySha256: hash(local.fixedQuery), rosterSha256: hash(local.sourceOwnedRoster) },
      ).receive(local.wire).catalog;
      const catalog = bytes(local.wire);
      local.registration.catalogSha256 = hash(catalog);
      for (const r of local.registration.tables) {
        const source = must(
          native.relations.find((n) => n.schema === r.schema && n.relation === r.relation),
        );
        r.primaryKeyBindingSha256 = hash(JSON.stringify(source.primaryKey));
      }
      const registration = bytes(local.registration);
      expect(() =>
        createFullRestoreNativeRowProjectionV1(
          {
            registration,
            catalog,
            fixedQuery: local.fixedQuery,
            sourceOwnedRoster: local.sourceOwnedRoster,
          },
          {
            registrationSha256: hash(registration),
            catalogSha256: hash(catalog),
            querySha256: hash(local.fixedQuery),
            rosterSha256: hash(local.sourceOwnedRoster),
          },
        ),
      ).toThrow('PROJECTION_REGISTRATION_INVALID');
    }
  });
  it('rejects ambiguous source JSON and damaged UTF8 even when supplied byte digests match', () => {
    const original = JSON.stringify(f.registration);
    const invalid = [
      new Uint8Array(
        Buffer.from(original.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
      ),
      new Uint8Array([0xff]),
      new Uint8Array(Buffer.from('['.repeat(65) + '0' + ']'.repeat(65))),
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(original)]),
    ];
    for (const registration of invalid)
      expect(() =>
        createFullRestoreNativeRowProjectionV1(
          {
            registration,
            catalog: f.catalog,
            fixedQuery: f.fixedQuery,
            sourceOwnedRoster: f.sourceOwnedRoster,
          },
          {
            registrationSha256: hash(registration),
            catalogSha256: hash(f.catalog),
            querySha256: hash(f.fixedQuery),
            rosterSha256: hash(f.sourceOwnedRoster),
          },
        ),
      ).toThrow('PROJECTION_ASSETS_INVALID');
  });
  it('delegates actual carrier rows to strict physical validators, including extra keys and SQL NULL on nonnullable columns', () => {
    const { plan, row } = exampleRow();
    const bodies = [
      JSON.stringify([{ ...row, extra: 'not_allowed' }]),
      JSON.stringify([{ ...row, columns: [...row.columns].reverse() }]),
      JSON.stringify([
        { ...row, columns: row.columns.map((c) => ({ ...c, value: { kind: 'sql_null' } })) },
      ]),
    ];
    for (const text of bodies)
      expect(() =>
        plan.receiveCarrier(
          carrier(text, '1', String(Buffer.byteLength(text) - 2), String(Buffer.byteLength(text))),
        ),
      ).toThrow('PROJECTION_CARRIER_INVALID');
  });
  it('preserves precise JSONB/int64/numeric text in carrier reconstruction without granting domain validity', () => {
    const payload = '{"large":9007199254740993,"decimal":1.23000,"exponent":1e400,"null":null}';
    const samples = {
      text: { kind: 'text', value: 'synthetic' },
      uuid: { kind: 'uuid', value: '00000000-0000-0000-0000-000000000001' },
      int32: { kind: 'int32', value: '1' },
      int64: { kind: 'int64', value: '9223372036854775807' },
      numericdecimal: { kind: 'numericdecimal', value: '12345678901234567890.000001' },
      boolean: { kind: 'boolean', value: false },
      date: { kind: 'date', value: '2000-01-01' },
      timestamptzUTC6: { kind: 'timestamptzUTC6', value: '2000-01-01T00:00:00.000001Z' },
      bytea: { kind: 'bytea', hex: '00ff' },
      name: { kind: 'name', value: 'synthetic' },
      float8sendbits: { kind: 'float8sendbits', sendBits: '8000000000000000' },
      'uuid[]': { kind: 'uuid[]', dimensions: [], elements: [] },
      'inet[]': { kind: 'inet[]', dimensions: [], elements: [] },
      jsonb: { kind: 'jsonb', text: payload, sha256: hash(payload) },
    };
    for (const type of ['jsonb', 'int64', 'numericdecimal'] as const) {
      const plan = must(factory.allPlans.find((p) => p.columns.some((c) => c.pgType === type)));
      const row = {
        rowVersion: 2,
        columns: plan.columns.map((c) => ({ column: c.column, value: samples[c.pgType] })),
      };
      const body = JSON.stringify([row]);
      const result = plan.receiveCarrier(
        carrier(
          body,
          '1',
          String(Buffer.byteLength(JSON.stringify(row))),
          String(Buffer.byteLength(body)),
        ),
      );
      if (result.kind !== 'validated_full_restore_physical_row_packet_v2')
        throw Error('validated_required');
      expect(result.rows[0]?.columns.find((c) => c.value.kind === type)?.value).toEqual(
        samples[type],
      );
      expect(result.domainValidation).toBe('not_checked');
      expect(result.nativeOrderVerification).toBe('not_checked');
      expect(result.admissionAllowed).toBe(false);
    }
  });
  it('rejects max0/max1 and lower-than-original escaped UTF8 row span without increasing the4MiB cap', () => {
    const { plan, row } = exampleRow();
    const textColumn = must(row.columns.find((c) => c.value.kind === 'text'));
    textColumn.value = { kind: 'text', value: '한글🗺\n"quoted"\\' };
    // Indented wire preserves spaces and escaped contributions; neither the JS
    // string length nor a compact reserialization is the original row span.
    const rawRow = JSON.stringify(row, null, 2);
    const body = '[' + rawRow + ']';
    const actualMax = Buffer.byteLength(rawRow);
    expect(actualMax).toBeGreaterThan(Buffer.byteLength(JSON.stringify(row)));
    expect(actualMax).toBeGreaterThan(rawRow.length);
    for (const reported of [
      '0',
      '1',
      String(actualMax - 1),
      String(Buffer.byteLength(JSON.stringify(row))),
      String(rawRow.length),
    ])
      expect(() =>
        plan.receiveCarrier(carrier(body, '1', reported, String(Buffer.byteLength(body)))),
      ).toThrow('PROJECTION_CARRIER_INVALID');
    expect(
      plan.receiveCarrier(carrier(body, '1', String(actualMax), String(Buffer.byteLength(body))))
        .kind,
    ).toBe('validated_full_restore_physical_row_packet_v2');
    expect(plan.maxRowBytes).toBe(4194304);
    expect(plan.receiveCarrier(carrier('[]'))).toMatchObject({
      rowCount: 0,
      byteLength: 2,
      admissionAllowed: false,
    });
    expect(() => plan.receiveCarrier(carrier('[]', '0', '1'))).toThrow(
      'PROJECTION_CARRIER_INVALID',
    );
  });
  it('captures facts without getter invocation and cannot repair an underreport by mutating a later descriptor read', () => {
    const { plan, text, row } = exampleRow();
    const actualMax = String(Buffer.byteLength(JSON.stringify(row)));
    const valid = carrier(text, '1', actualMax, String(Buffer.byteLength(text)));
    const getter = vi.fn(() => actualMax);
    expect(() =>
      plan.receiveCarrier(Object.defineProperty({ ...valid }, 'max_row_bytes', { get: getter })),
    ).toThrow('PROJECTION_CARRIER_INVALID');
    expect(getter).not.toHaveBeenCalled();
    const mutable = carrier(text, '1', '1', String(Buffer.byteLength(text)));
    let mutationObserved = false;
    const raced = new Proxy(mutable, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'body') {
          target.max_row_bytes = actualMax;
          mutationObserved = true;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(() => plan.receiveCarrier(raced)).toThrow('PROJECTION_CARRIER_INVALID');
    expect(mutationObserved).toBe(true);
    expect(mutable.max_row_bytes).toBe(actualMax);
    expect(plan.receiveCarrier(valid).kind).toBe('validated_full_restore_physical_row_packet_v2');
  });
});
