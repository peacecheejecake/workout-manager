import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createFullRestoreNativeCatalogCollectorV2,
  NativeCatalogAssetsErrorV2,
  NativeCatalogValidationErrorV2,
} from '../src/full-restore-native-catalog-v2/collector.js';
import { test } from 'vitest';

const independentPins = Object.freeze({
  querySha256: 'fecf6ab1fb0935595c8ffa2b2d57e470f9c910579b1bd4ded6d58ee7d852ab05',
  rosterSha256: 'e13dc970dbce462d0743acabbac273eddf0e506e3e34584b528e7c4f6c080619',
});
function packageAssets() {
  return {
    fixedQuery: new Uint8Array(
      readFileSync(
        new URL('../src/full-restore-native-catalog-v2/fixed-query.sql', import.meta.url),
      ),
    ),
    sourceOwnedRoster: new Uint8Array(
      readFileSync(
        new URL('../src/full-restore-native-catalog-v2/source-owned-roster.json', import.meta.url),
      ),
    ),
  };
}
const collector = createFullRestoreNativeCatalogCollectorV2(packageAssets(), independentPins);
const receiveNativeCatalogCandidateV2 = collector.receive;
const collectNativeCatalogCandidateV2 = collector.collect;

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
export const completeSyntheticFixture = normalizedFixture;
function alteredEntry(
  wire: ReturnType<typeof normalizedFixture>['wire'],
  family: string,
  change: (metadata: Record<string, unknown>) => void,
) {
  const entry = must(wire.pools[family]?.[0]);
  const value: Record<string, unknown> = JSON.parse(entry.pgJsonbText);
  change(value);
  entry.pgJsonbText = JSON.stringify(value);
  entry.metadataSha256 = createHash('sha256').update(entry.pgJsonbText).digest('hex');
}
test('whole239 normalized census validates directly with bounded pools and immutable output', () => {
  const f = normalizedFixture();
  const c = receiveNativeCatalogCandidateV2(f.wire);
  assert.equal(c.catalog.relations.length, 239);
  assert.equal(
    c.catalog.relations.reduce((n, r) => n + r.columns.length, 0),
    1887,
  );
  assert.equal(c.catalog.namespaceRelations.length, 704);
  assert.equal(c.registryTrusted, false);
  assert.ok(Object.isFrozen(c.catalog));
  assert.ok(Buffer.byteLength(JSON.stringify(f.wire)) < f.expandedBytes);
});
test('missing/ref-to-foreign/orphan routine rejected', () => {
  for (const change of [
    (w: ReturnType<typeof normalizedFixture>['wire']) => {
      must(w.pools.routines).pop();
    },
    (w: ReturnType<typeof normalizedFixture>['wire']) => {
      must(must(w.relations[0]).columns[0]).physicalTypeOid = 999999;
    },
    (w: ReturnType<typeof normalizedFixture>['wire']) => {
      const entry = must(must(w.pools.routines)[0]);
      const v = JSON.parse(entry.pgJsonbText);
      v.oid = 999999;
      const pgJsonbText = JSON.stringify(v);
      must(w.pools.routines).push({
        oid: v.oid,
        pgJsonbText,
        metadataSha256: createHash('sha256').update(pgJsonbText).digest('hex'),
      });
    },
  ]) {
    const f = normalizedFixture();
    change(f.wire);
    assert.throws(() => receiveNativeCatalogCandidateV2(f.wire));
  }
});
test('duplicate conflicting OID and wrong digest reject', () => {
  const a = normalizedFixture().wire;
  must(a.pools.routines).push(must(must(a.pools.routines)[0]));
  assert.throws(() => receiveNativeCatalogCandidateV2(a));
  const b = normalizedFixture().wire;
  must(must(b.pools.physicalTypes)[0]).metadataSha256 = '0'.repeat(64);
  assert.throws(() => receiveNativeCatalogCandidateV2(b));
});
test('missing source relation, column and duplicate PK ordinal reject', () => {
  const a = normalizedFixture().wire;
  a.relations.pop();
  assert.throws(() => receiveNativeCatalogCandidateV2(a));
  const b = normalizedFixture().wire;
  must(b.relations[0]).columns.pop();
  assert.throws(() => receiveNativeCatalogCandidateV2(b));
  const c = normalizedFixture().wire;
  must(must(c.relations[0]).primaryKey.components[0]).position = 2;
  assert.throws(() => receiveNativeCatalogCandidateV2(c));
});
test('hash-valid duplicate escaped metadata keys and nested duplicate reject', () => {
  for (const text of ['{"oid":101,"\\u006fid":101}', '{"oid":101,"nested":{"x":1,"x":2}}']) {
    const f = normalizedFixture().wire;
    const entry = must(must(f.pools.routines)[0]);
    entry.pgJsonbText = text;
    entry.metadataSha256 = createHash('sha256').update(text).digest('hex');
    assert.throws(() => receiveNativeCatalogCandidateV2(f));
  }
});
test('array element/send disagreement and missing comparison strategy reject', () => {
  const a = normalizedFixture().wire;
  alteredEntry(a, 'physicalTypes', (m) => {
    m.sendRoutineOid = 999999;
  });
  assert.throws(() => receiveNativeCatalogCandidateV2(a));
  const b = normalizedFixture().wire;
  alteredEntry(b, 'opclasses', (m) => {
    const ops = m.operators;
    if (!Array.isArray(ops)) throw Error('fixture');
    ops.pop();
  });
  assert.throws(() => receiveNativeCatalogCandidateV2(b));
});
test('getters are never invoked and foreign keys/byte excess rejected', () => {
  let reads = 0;
  const a = normalizedFixture().wire;
  Object.defineProperty(a, 'pools', {
    get() {
      reads++;
      throw Error('forbidden');
    },
  });
  assert.throws(() => receiveNativeCatalogCandidateV2(a));
  assert.equal(reads, 0);
  assert.throws(() =>
    receiveNativeCatalogCandidateV2({
      ...normalizedFixture().wire,
      extra: true,
    }),
  );
  assert.throws(() =>
    receiveNativeCatalogCandidateV2({
      ...normalizedFixture().wire,
      walObservation: 'a'.repeat(8388609),
    }),
  );
});
test('collector has single pinned SQL path and does not consume expanded wire', async () => {
  let queries = 0;
  const c = await collectNativeCatalogCandidateV2({
    async withRepeatableRead(callback) {
      return callback({
        async queryFixed(sql) {
          queries++;
          assert.ok(sql.includes('normalized AS MATERIALIZED'));
          return normalizedFixture().wire;
        },
      });
    },
  });
  assert.equal(queries, 1);
  assert.equal(c.authority, 'none');
  assert.equal(c.nativeOrderEquality, 'not_checked');
});

test('expanded synthetic metadata over8MiB still accepts bounded normalized closure without expansion', () => {
  const f = normalizedFixture(2048);
  const size = Buffer.byteLength(JSON.stringify(f.wire));
  assert.ok(f.expandedBytes > 8388608);
  assert.ok(size < 8388608);
  assert.equal(receiveNativeCatalogCandidateV2(f.wire).catalog.relations.length, 239);
  console.log(
    JSON.stringify({
      kind: 'synthetic_normalized_size',
      expandedBytes: f.expandedBytes,
      normalizedBytes: size,
    }),
  );
});

test('all pool families reject unused metadata and conflicting duplicate OID', () => {
  for (const family of ['physicalTypes', 'opclasses', 'routines', 'collations']) {
    const f = normalizedFixture().wire;
    const entries = must(f.pools[family]);
    const base = entries[0];
    const metadata = base
      ? JSON.parse(base.pgJsonbText)
      : {
          oid: 999999,
          schema: 'pg_catalog',
          name: 'C',
          provider: 'c',
          deterministic: true,
          encoding: -1,
          collate: 'C',
          ctype: 'C',
          locale: null,
          version: null,
          actualVersion: null,
        };
    metadata.oid = 999999;
    const pgJsonbText = JSON.stringify(metadata);
    entries.push({
      oid: 999999,
      pgJsonbText,
      metadataSha256: createHash('sha256').update(pgJsonbText).digest('hex'),
    });
    assert.throws(() => receiveNativeCatalogCandidateV2(f));
  }
  const f = normalizedFixture().wire;
  const entries = must(f.pools.routines);
  const first = must(entries[0]);
  const metadata = JSON.parse(first.pgJsonbText);
  metadata.owner = 'conflicting_owner';
  const pgJsonbText = JSON.stringify(metadata);
  entries.splice(1, 0, {
    oid: first.oid,
    pgJsonbText,
    metadataSha256: createHash('sha256').update(pgJsonbText).digest('hex'),
  });
  assert.throws(() => receiveNativeCatalogCandidateV2(f));
});
test('outer invalid version and child native identity do not become trust', () => {
  assert.throws(() =>
    receiveNativeCatalogCandidateV2({
      ...normalizedFixture().wire,
      schemaVersion: 1,
    }),
  );
  const f = normalizedFixture().wire;
  alteredEntry(f, 'physicalTypes', (m) => {
    m.oid = 999999;
  });
  assert.throws(() => receiveNativeCatalogCandidateV2(f));
});

test('small synthetic lossless normalization preserves every original key and semantic order', () => {
  const f = normalizedFixture();
  const c = receiveNativeCatalogCandidateV2(f.wire).catalog;
  const object = z.record(z.string(), z.unknown());
  const objects = z.array(object);
  const drop = (v: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(Object.entries(v).filter(([key]) => !keys.includes(key)));
  function lookup(family: keyof typeof c.pools, id: unknown): Record<string, unknown> | null {
    if (id === null) return null;
    assert.equal(typeof id, 'number');
    const entry = must(c.pools[family].find((v) => v.oid === id));
    return object.parse(JSON.parse(entry.pgJsonbText));
  }
  function type(id: unknown) {
    const t = must(lookup('physicalTypes', id));
    const element = t.elementType === null ? null : object.parse(t.elementType);
    return {
      ...drop(t, ['sendRoutineOid', 'inputRoutineOid', 'outputRoutineOid', 'elementType', 'casts']),
      send: lookup('routines', t.sendRoutineOid),
      input: lookup('routines', t.inputRoutineOid),
      output: lookup('routines', t.outputRoutineOid),
      elementType: element
        ? {
            ...drop(element, ['sendRoutineOid', 'inputRoutineOid', 'outputRoutineOid']),
            send: lookup('routines', element.sendRoutineOid),
            input: lookup('routines', element.inputRoutineOid),
            output: lookup('routines', element.outputRoutineOid),
          }
        : null,
      casts: objects.parse(t.casts).map((v) => ({
        ...drop(v, ['functionRoutineOid']),
        function: lookup('routines', v.functionRoutineOid),
      })),
    };
  }
  function opclass(id: unknown) {
    const o = must(lookup('opclasses', id));
    return {
      ...drop(o, ['operators', 'supportProcedures']),
      operators: objects.parse(o.operators).map((v) => ({
        ...drop(v, ['functionRoutineOid']),
        function: lookup('routines', v.functionRoutineOid),
      })),
      supportProcedures: objects.parse(o.supportProcedures).map((v) => ({
        ...drop(v, ['functionRoutineOid']),
        function: lookup('routines', v.functionRoutineOid),
      })),
    };
  }
  const restored = {
    ...drop(object.parse(c), ['schemaVersion', 'payloadEncoding', 'relations', 'pools']),
    schemaVersion: 1,
    relations: c.relations.map((r) => ({
      ...r,
      columns: r.columns.map((col) => ({
        ...drop(object.parse(col), ['physicalTypeOid', 'collationOid']),
        physicalType: type(col.physicalTypeOid),
        collation: lookup('collations', col.collationOid),
      })),
      primaryKey: {
        ...r.primaryKey,
        components: r.primaryKey.components.map((k) => ({
          ...drop(object.parse(k), ['opclassOid', 'collationOid']),
          opclass: opclass(k.opclassOid),
          collation: lookup('collations', k.collationOid),
        })),
      },
    })),
  };
  assert.deepEqual(restored, f.expanded);
});

function diagnostic(raw: unknown) {
  try {
    receiveNativeCatalogCandidateV2(raw);
  } catch (error) {
    assert.ok(error instanceof NativeCatalogValidationErrorV2);
    assert.equal(error.message, 'CATALOG_OBSERVATION_INVALID');
    assert.equal('cause' in error, false);
    return { stage: error.validationStage, category: error.validationCategory };
  }
  throw Error('EXPECTED_REJECTION');
}
test('diagnostic wire shape rejection carries only closed enums', () => {
  assert.deepEqual(diagnostic({ ...normalizedFixture().wire, schemaVersion: 3 }), {
    stage: 'wire_schema',
    category: 'schema_rejected',
  });
});
test('diagnostic pool hash failure retains strict hash rejection', () => {
  const f = normalizedFixture().wire;
  const first = must(must(f.pools.physicalTypes)[0]);
  first.metadataSha256 = '0'.repeat(64);
  assert.deepEqual(diagnostic(f), {
    stage: 'pool_physical_types',
    category: 'hash_rejected',
  });
});
test('diagnostic accessor rejection never evaluates supplied getter', () => {
  let calls = 0;
  const f = {};
  Object.defineProperty(f, 'catalog', {
    enumerable: true,
    get() {
      calls++;
      throw Error('PRIVATE_NOT_TO_BE_READ');
    },
  });
  assert.deepEqual(diagnostic(f), {
    stage: 'wire_bounds',
    category: 'bounds_rejected',
  });
  assert.equal(calls, 0);
});

test('native catalog OID wire must be an exact u32 number with no string coercion', () => {
  const f = normalizedFixture().wire;
  const atMax = { ...f, database: { ...f.database, oid: 4294967295 } };
  assert.equal(receiveNativeCatalogCandidateV2(atMax).catalog.database.oid, 4294967295);
  for (const value of ['4294967295', '1', 0, 4294967296, 1.5, -1, null]) {
    assert.deepEqual(diagnostic({ ...f, database: { ...f.database, oid: value } }), {
      stage: 'wire_schema',
      category: 'schema_rejected',
    });
  }
});

test('hash-valid native routine metadata retains strict numeric OID semantics', () => {
  const f = normalizedFixture().wire;
  const entry = must(must(f.pools.routines)[0]);
  const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(entry.pgJsonbText));
  entry.pgJsonbText = JSON.stringify({ ...metadata, returnType: '17' });
  entry.metadataSha256 = createHash('sha256').update(entry.pgJsonbText).digest('hex');
  assert.deepEqual(diagnostic(f), {
    stage: 'pool_routines',
    category: 'schema_rejected',
  });
});

function mutatePhysicalType(
  wire: ReturnType<typeof normalizedFixture>['wire'],
  name: string,
  change: (metadata: Record<string, unknown>) => void,
) {
  const schema = z.record(z.string(), z.unknown());
  const entry = must(
    must(wire.pools.physicalTypes).find(
      (value) => schema.parse(JSON.parse(value.pgJsonbText)).name === name,
    ),
  );
  const metadata = schema.parse(JSON.parse(entry.pgJsonbText));
  change(metadata);
  entry.pgJsonbText = JSON.stringify(metadata);
  entry.metadataSha256 = createHash('sha256').update(entry.pgJsonbText).digest('hex');
}
test('PG17 name scalar char element and uuid/inet arrays retain distinct exact identities', () => {
  const result = receiveNativeCatalogCandidateV2(normalizedFixture().wire);
  const entries = result.catalog.pools.physicalTypes.map((entry) =>
    z.record(z.string(), z.unknown()).parse(JSON.parse(entry.pgJsonbText)),
  );
  const scalar = must(entries.find((entry) => entry.name === 'name'));
  assert.equal(scalar.category, 'S');
  assert.equal(scalar.elementOid, 18);
  assert.equal(z.record(z.string(), z.unknown()).parse(scalar.elementType).name, 'char');
  for (const [name, oid, elementName] of [
    ['_uuid', 2950, 'uuid'],
    ['_inet', 869, 'inet'],
  ] as const) {
    const array = must(entries.find((entry) => entry.name === name));
    assert.equal(array.category, 'A');
    assert.equal(array.elementOid, oid);
    assert.equal(z.record(z.string(), z.unknown()).parse(array.elementType).name, elementName);
  }
  assert.equal(result.registryTrusted, false);
});
test('hash-valid name char identity schema category and absent element drift reject', () => {
  const object = z.record(z.string(), z.unknown());
  for (const change of [
    (m: Record<string, unknown>) => {
      m.category = 'A';
    },
    (m: Record<string, unknown>) => {
      m.elementOid = 2950;
      m.elementType = { ...object.parse(m.elementType), oid: 2950 };
    },
    (m: Record<string, unknown>) => {
      m.elementType = { ...object.parse(m.elementType), name: 'uuid' };
    },
    (m: Record<string, unknown>) => {
      m.elementType = { ...object.parse(m.elementType), schema: 'public' };
    },
    (m: Record<string, unknown>) => {
      m.elementOid = 0;
      m.elementType = null;
    },
  ]) {
    const wire = normalizedFixture().wire;
    // Assign a fresh plain object because Zod parse returns a clone.
    mutatePhysicalType(wire, 'name', (metadata) => {
      const e = metadata.elementType;
      if (e !== null) metadata.elementType = object.parse(e);
      change(metadata);
    });
    assert.throws(() => receiveNativeCatalogCandidateV2(wire));
  }
});
test('hash-valid array cross-type and scalar unexpected vector-style element reject', () => {
  const object = z.record(z.string(), z.unknown());
  for (const type of ['_uuid', '_inet'] as const) {
    const wire = normalizedFixture().wire;
    mutatePhysicalType(wire, type, (m) => {
      const swapped = type === '_uuid' ? 869 : 2950;
      m.elementOid = swapped;
      m.elementType = {
        ...object.parse(m.elementType),
        oid: swapped,
        name: type === '_uuid' ? 'inet' : 'uuid',
      };
    });
    assert.throws(() => receiveNativeCatalogCandidateV2(wire));
  }
  const wire = normalizedFixture().wire;
  const scalar = must(
    must(wire.pools.physicalTypes).find(
      (entry) => object.parse(JSON.parse(entry.pgJsonbText)).name === 'name',
    ),
  );
  const element = object.parse(JSON.parse(scalar.pgJsonbText)).elementType;
  mutatePhysicalType(wire, 'text', (m) => {
    m.elementOid = 18;
    m.elementType = element;
  });
  assert.throws(() => receiveNativeCatalogCandidateV2(wire));
});
test('allowed name element retains closed routine reference and unsigned OID rejection', () => {
  const object = z.record(z.string(), z.unknown());
  for (const change of [
    (m: Record<string, unknown>) => {
      m.elementType = {
        ...object.parse(m.elementType),
        sendRoutineOid: 4294967295,
      };
    },
    (m: Record<string, unknown>) => {
      m.elementOid = '18';
    },
    (m: Record<string, unknown>) => {
      m.elementOid = 4294967296;
    },
  ]) {
    const wire = normalizedFixture().wire;
    mutatePhysicalType(wire, 'name', change);
    assert.throws(() => receiveNativeCatalogCandidateV2(wire));
  }
});

test('package assets require fixed independently supplied pins, not caller replacement hashes', () => {
  const assets = packageAssets();
  assert.equal(sha(assets.fixedQuery), independentPins.querySha256);
  assert.equal(sha(assets.sourceOwnedRoster), independentPins.rosterSha256);
  for (const key of ['fixedQuery', 'sourceOwnedRoster'] as const) {
    const changed = packageAssets();
    changed[key][0] = 0;
    const replacementPins = {
      ...independentPins,
      [key === 'fixedQuery' ? 'querySha256' : 'rosterSha256']: sha(changed[key]),
    };
    assert.throws(
      () => createFullRestoreNativeCatalogCollectorV2(changed, replacementPins),
      NativeCatalogAssetsErrorV2,
    );
    assert.throws(
      () => createFullRestoreNativeCatalogCollectorV2(changed, independentPins),
      NativeCatalogAssetsErrorV2,
    );
  }
});
test('asset and pin accessors are invalid without executing them; reflection failures are sanitized', () => {
  let calls = 0;
  const assets = packageAssets();
  Object.defineProperty(assets, 'fixedQuery', {
    enumerable: true,
    get() {
      calls++;
      return new Uint8Array();
    },
  });
  assert.throws(
    () => createFullRestoreNativeCatalogCollectorV2(assets, independentPins),
    NativeCatalogAssetsErrorV2,
  );
  const forgedPins = { ...independentPins };
  Object.defineProperty(forgedPins, 'querySha256', {
    enumerable: true,
    get() {
      calls++;
      return independentPins.querySha256;
    },
  });
  assert.throws(
    () => createFullRestoreNativeCatalogCollectorV2(packageAssets(), forgedPins),
    NativeCatalogAssetsErrorV2,
  );
  assert.throws(
    () =>
      createFullRestoreNativeCatalogCollectorV2(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('private');
            },
          },
        ),
        independentPins,
      ),
    NativeCatalogAssetsErrorV2,
  );
  assert.equal(calls, 0);
});
test('shared, resizable, detached, excessive, and alternate byte views cannot become pinned assets', () => {
  const detached = new Uint8Array(8);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const invalid = [
    new Uint8Array(new SharedArrayBuffer(8)),
    new Uint8Array(resizableBuffer()),
    detached,
    new Uint8Array(8388609),
    Buffer.from(packageAssets().fixedQuery),
    new DataView(new ArrayBuffer(8)),
  ];
  for (const fixedQuery of invalid) {
    assert.throws(
      () =>
        createFullRestoreNativeCatalogCollectorV2(
          { ...packageAssets(), fixedQuery },
          independentPins,
        ),
      NativeCatalogAssetsErrorV2,
    );
  }
});
test('intrinsic byte view reads do not invoke forged metadata accessors', () => {
  const assets = packageAssets();
  let calls = 0;
  for (const name of ['buffer', 'byteLength']) {
    Object.defineProperty(assets.fixedQuery, name, {
      get() {
        calls++;
        throw new Error('private');
      },
    });
  }
  const value = createFullRestoreNativeCatalogCollectorV2(assets, independentPins).receive(
    normalizedFixture().wire,
  );
  assert.equal(value.authority, 'none');
  assert.equal(calls, 0);
});
test('factory snapshots asset bytes before asynchronous RR dispatch; caller mutation cannot change SQL or roster', async () => {
  const assets = packageAssets();
  const bound = createFullRestoreNativeCatalogCollectorV2(assets, independentPins);
  assets.fixedQuery.fill(0);
  assets.sourceOwnedRoster.fill(0);
  let queries = 0;
  const observed = await bound.collect({
    async withRepeatableRead(callback) {
      return callback({
        async queryFixed(sql) {
          queries++;
          assert.equal(sha(sql), independentPins.querySha256);
          return normalizedFixture().wire;
        },
      });
    },
  });
  assert.equal(queries, 1);
  assert.equal(observed.registryTrusted, false);
  assert.equal(observed.authority, 'none');
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.catalog), true);
});
function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function resizableBuffer(): ArrayBuffer {
  const value: unknown = Reflect.construct(ArrayBuffer, [8, { maxByteLength: 16 }]);
  assert.ok(value instanceof ArrayBuffer);
  return value;
}
