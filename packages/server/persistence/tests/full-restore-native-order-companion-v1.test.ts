import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createNativeOrderCompanionV1 } from '../src/full-restore-native-order-companion-v1.js';
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
const assets = {
  registration: bytes(f.registration),
  catalog: f.catalog,
  fixedQuery: f.fixedQuery,
  sourceOwnedRoster: f.sourceOwnedRoster,
};
const pins = {
  registrationSha256: hash(assets.registration),
  catalogSha256: hash(assets.catalog),
  querySha256: hash(assets.fixedQuery),
  rosterSha256: hash(assets.sourceOwnedRoster),
};
const identityRow = {
  database_name: 'synthetic',
  database_oid: '123',
  current_role: 'capture',
  session_role: 'capture',
  role_oid: '456',
  snapshot: '10:20:',
  server_version: '170006',
  isolation: 'repeatable read',
  read_only: 'on',
  date_style: 'ISO, YMD',
  encoding: 'UTF8',
};
function harness(
  modify?: (row: Record<string, unknown>, index: number) => unknown,
  cleanupFail = false,
  firstBody?: string,
) {
  let nativeCalls = 0;
  let carrierCalls = 0;
  const parameters: string[] = [];
  let cleanup = false;
  const nativeSql: string[] = [];
  const port = {
    withRepeatableReadOnly: async <T>(
      callback: (tx: {
        query: (sql: string, params: readonly unknown[]) => Promise<unknown>;
      }) => Promise<T>,
    ) => {
      let result: T;
      try {
        result = await callback({
          query: async (sql, params) => {
            let row: unknown;
            if (sql.includes('current_database()')) row = { ...identityRow };
            else if (sql.includes('has_table_privilege'))
              return {
                rows: factory.allPlans.map((p) => ({
                  schema: p.schema,
                  relation: p.relation,
                  readable: true,
                  filtered: false,
                })),
                rowCount: 239,
              };
            else if (sql.includes('native_keys AS MATERIALIZED')) {
              nativeSql.push(sql);
              const body = params[0];
              if (typeof body === 'string') parameters.push(body);
              expect(typeof body).toBe('string');
              const count = typeof body === 'string' ? JSON.parse(body).length : 0;
              row = modify?.(
                {
                  session_ok: true,
                  source_count: String(count),
                  supplied_count: String(count),
                  missing_keys: '0',
                  duplicate_keys: '0',
                  wrong_ordinal: '0',
                },
                nativeCalls,
              ) ?? {
                session_ok: true,
                source_count: String(count),
                supplied_count: String(count),
                missing_keys: '0',
                duplicate_keys: '0',
                wrong_ordinal: '0',
              };
              nativeCalls++;
            } else {
              const current = carrierCalls++;
              const text = current === 0 && firstBody !== undefined ? firstBody : '[]';
              const decoded: unknown[] = JSON.parse(text);
              const max =
                decoded.length === 0
                  ? 0
                  : Math.max(...decoded.map((row) => Buffer.byteLength(JSON.stringify(row))));
              row = carrier(
                text,
                String(decoded.length),
                String(max),
                String(Buffer.byteLength(text)),
              );
            }
            return {
              rows: [row],
              rowCount: 1,
              get _types() {
                throw Error('metadata_must_not_read');
              },
            };
          },
        });
      } finally {
        cleanup = true;
      }
      if (cleanupFail) throw Error('private_cleanup_failure');
      return result;
    },
  };
  return {
    capture: createNativeOrderCompanionV1(assets, pins, port).capture,
    sql: nativeSql,
    parameters,
    count: () => nativeCalls,
    cleaned: () => cleanup,
  };
}
describe('native key order companion TMP candidate, fake I/O is not actual PG proof', () => {
  it('covers all239 in same callback lifetime and returns distinct no-authority evidence', async () => {
    const h = harness();
    const result = await h.capture();
    expect(result.relations).toHaveLength(239);
    expect(h.count()).toBe(239);
    expect(h.cleaned()).toBe(true);
    expect(Object.isFrozen(result.relations)).toBe(true);
    expect(result.captured.nativeWholeOrder).toBe('not_checked');
    expect(result.orderEvidence).toBe('validated_port_native_key_ordinal_facts');
    expect(result.registryTrusted).toBe(false);
    expect(result.pgDumpCorrespondence).toBe('not_checked');
    expect(
      h.sql.every(
        (sql) =>
          sql.includes('row_number() OVER (ORDER BY') &&
          sql.includes('IS NOT DISTINCT FROM') &&
          sql.includes('WITH ORDINALITY') &&
          sql.includes('ASC NULLS LAST'),
      ),
    ).toBe(true);
  });
  it.each([
    'missing_keys',
    'duplicate_keys',
    'wrong_ordinal',
    'source_count',
    'supplied_count',
  ] as const)('rejects %s mismatch without publishing partial native evidence', async (key) => {
    const h = harness((row) => ({ ...row, [key]: '1' }));
    await expect(h.capture()).rejects.toMatchObject({
      code: 'ORDER_KEY_MISMATCH',
    });
    expect(h.count()).toBe(1);
    expect(h.cleaned()).toBe(true);
  });
  it.each(['-1', '01', '5001', 'NaN', 1, null])(
    'rejects malformed or excessive native count %s',
    async (value) => {
      const h = harness((row) => ({ ...row, source_count: value }));
      await expect(h.capture()).rejects.toMatchObject({
        code: 'ORDER_REPLY_INVALID',
      });
      expect(h.cleaned()).toBe(true);
    },
  );
  it('does not invoke reply accessors and rejects unexpected facts fields', async () => {
    let calls = 0;
    const h = harness((row) =>
      Object.defineProperty({ ...row }, 'wrong_ordinal', {
        get() {
          calls++;
          return '0';
        },
      }),
    );
    await expect(h.capture()).rejects.toMatchObject({
      code: 'ORDER_REPLY_INVALID',
    });
    expect(calls).toBe(0);
    await expect(
      harness((row) => ({ ...row, rawSql: 'forbidden' })).capture(),
    ).rejects.toMatchObject({ code: 'ORDER_REPLY_INVALID' });
  });
  it('does not accept an incorrect session or cleanup success fabricated from completed callback', async () => {
    await expect(harness((row) => ({ ...row, session_ok: false })).capture()).rejects.toMatchObject(
      { code: 'ORDER_KEY_MISMATCH' },
    );
    const h = harness(undefined, true);
    await expect(h.capture()).rejects.toMatchObject({
      code: 'CAPTURE_IO_FAILED',
    });
    expect(h.cleaned()).toBe(true);
  });
  it('rejects preaborted invocation and does not ask native query port to run', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    await expect(h.capture(controller.signal)).rejects.toMatchObject({
      code: 'CAPTURE_CANCELLED',
    });
    expect(h.count()).toBe(0);
    expect(h.cleaned()).toBe(false);
  });
  it('does not let a getter asset or tampered independent pin supply SQL authority', () => {
    let calls = 0;
    const bad = Object.defineProperty({ ...assets }, 'catalog', {
      get() {
        calls++;
        return assets.catalog;
      },
    });
    expect(() =>
      createNativeOrderCompanionV1(bad, pins, {
        withRepeatableReadOnly: async () => {
          throw Error('never');
        },
      }),
    ).toThrow();
    expect(calls).toBe(0);
    expect(() =>
      createNativeOrderCompanionV1(
        assets,
        { ...pins, catalogSha256: '0'.repeat(64) },
        {
          withRepeatableReadOnly: async () => {
            throw Error('never');
          },
        },
      ),
    ).toThrow();
  });
  it('keeps nonempty original packet bytes and decoded key positions; never JS-sorts supplied rows', async () => {
    const plan = must(factory.allPlans[0]);
    const rows = [2, 10].map((value) => ({
      rowVersion: 2,
      columns: plan.columns.map((column) => ({
        column: column.column,
        value:
          column.pgType === 'boolean'
            ? { kind: 'boolean', value: false }
            : { kind: 'text', value: 'synthetic-' + value },
      })),
    }));
    const body = '[\n' + rows.map((row) => JSON.stringify(row)).join(',\n') + '\n]';
    const h = harness(undefined, false, body);
    const result = await h.capture();
    expect(result.relations[0]?.rows).toBe(2);
    expect(h.parameters[0]).toBe(body);
    expect(new TextDecoder().decode(must(result.captured.packets[0]).copyOriginalUtf8())).toBe(
      body,
    );
    expect(h.sql.some((sql) => sql.includes('::bigint'))).toBe(true);
    expect(h.sql.some((sql) => sql.includes('::integer'))).toBe(true);
    expect(h.sql.some((sql) => sql.includes('pg_catalog.decode('))).toBe(true);
    expect(h.sql.some((sql) => sql.includes('::timestamptz'))).toBe(true);
  });
});
