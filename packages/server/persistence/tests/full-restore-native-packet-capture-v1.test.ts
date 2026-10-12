import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createFullRestoreNativePacketCaptureV1 } from '../src/full-restore-native-packet-capture-v1.js';
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
function driver(rows: unknown[]) {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    fields: [],
    oid: 0,
    get _types() {
      throw Error('must_not_read_driver_metadata');
    },
  };
}
function harness(
  options: {
    visibility?: (rows: unknown[]) => unknown[];
    identity?: (last: boolean) => unknown;
    carrier?: (index: number, parameters: readonly unknown[]) => unknown;
    cleanupFailure?: boolean;
    controller?: AbortController;
    onQuery?: (index: number) => void;
  } = {},
) {
  let identityCalls = 0;
  let planCalls = 0;
  let cleanup = false;
  const parameters: (readonly unknown[])[] = [];
  const sql: string[] = [];
  const transaction = {
    query: async (statement: string, values: readonly unknown[]) => {
      sql.push(statement);
      options.onQuery?.(sql.length);
      if (statement.includes('current_database()')) {
        return driver([options.identity?.(++identityCalls > 1) ?? { ...identityRow }]);
      }
      if (statement.includes('has_table_privilege')) {
        const rows = factory.allPlans.map((plan) => ({
          schema: plan.schema,
          relation: plan.relation,
          readable: true,
          filtered: false,
        }));
        return driver(options.visibility?.(rows) ?? rows);
      }
      parameters.push(values);
      return driver([options.carrier?.(planCalls++, values) ?? carrier('[]')]);
    },
  };
  const port = {
    withRepeatableReadOnly: async <T>(callback: (tx: typeof transaction) => Promise<T>) => {
      let result: T;
      try {
        result = await callback(transaction);
      } finally {
        cleanup = true;
      }
      if (options.cleanupFailure) throw Error('cleanup_failure_private');
      return result;
    },
  };
  return {
    capture: createFullRestoreNativePacketCaptureV1(assets, pins, port).capture,
    parameters,
    sql,
    port,
    transaction,
    cleaned: () => cleanup,
    plans: () => planCalls,
  };
}

describe('native packet census capture V1 (synthetic port, no actual registry authority)', () => {
  it('captures all 239 plans in one lifetime; empty packets charge bytes and driver extras stay unread', async () => {
    const h = harness();
    const result = await h.capture();
    expect(result.relationCount).toBe(239);
    expect(result.packets).toHaveLength(239);
    expect(result.rowCount).toBe(0);
    expect(result.byteLength).toBe(478);
    expect(h.parameters[0]).toEqual([5000, 16777216]);
    expect(h.parameters[238]).toEqual([5000, 16777216 - 476]);
    expect(h.sql).toHaveLength(242);
    expect(h.sql[2]).toContain('THEN body ELSE NULL');
    expect(h.cleaned()).toBe(true);
    expect(Object.isFrozen(result.packets)).toBe(true);
    const packet = must(result.packets[0]);
    const copy = packet.copyOriginalUtf8();
    copy[0] = 0;
    expect(new TextDecoder().decode(packet.copyOriginalUtf8())).toBe('[]');
    expect(result.authority).toBe('none');
    expect(result.registryTrusted).toBe(false);
    expect(result.pgDumpCorrespondence).toBe('not_checked');
  });
  it('debits actual original bytes/rows before the next relation; never resets the global row budget', async () => {
    const e = exampleRow();
    const rowSize = Buffer.byteLength(JSON.stringify(e.row));
    const h = harness({
      carrier: (index) =>
        index === 0
          ? carrier(e.text, '1', String(rowSize), String(Buffer.byteLength(e.text)))
          : carrier(null, '5000', '2', '2'),
    });
    await expect(h.capture()).rejects.toMatchObject({ code: 'CAPTURE_BUDGET_EXCEEDED' });
    expect(h.parameters[1]).toEqual([4999, 16777216 - Buffer.byteLength(e.text)]);
    expect(h.cleaned()).toBe(true);
    expect(h.plans()).toBe(2);
  });
  it('refuses a carrier beyond remaining bytes including prior empty packet overhead', async () => {
    const h = harness({
      carrier: (index) => (index === 0 ? carrier('[]') : carrier(null, '1', '2', '16777216')),
    });
    await expect(h.capture()).rejects.toMatchObject({ code: 'CAPTURE_BUDGET_EXCEEDED' });
    expect(h.parameters[1]).toEqual([5000, 16777214]);
    expect(h.cleaned()).toBe(true);
  });
  it('refuses an over-budget transferred body instead of accepting server gate misbehavior', async () => {
    const h = harness({ carrier: () => carrier('[]', '5001') });
    await expect(h.capture()).rejects.toMatchObject({ code: 'CAPTURE_REPLY_INVALID' });
  });
  it.each(['filtered', 'unreadable', 'duplicate', 'foreign', 'missing'] as const)(
    'rejects %s census, before querying any source rows',
    async (mode) => {
      const h = harness({
        visibility: (rows) => {
          const first = must(rows[0]);
          if (mode === 'missing') return rows.slice(1);
          return rows.map((row, index) =>
            index !== 0
              ? row
              : mode === 'duplicate'
                ? rows[1]
                : mode === 'foreign'
                  ? { schema: 'public', relation: 'foreign', readable: true, filtered: false }
                  : {
                      ...(first as object),
                      readable: mode !== 'unreadable',
                      filtered: mode === 'filtered',
                    },
          );
        },
      });
      await expect(h.capture()).rejects.toBeInstanceOf(Error);
      expect(h.parameters).toHaveLength(0);
      expect(h.cleaned()).toBe(true);
    },
  );
  it.each(['snapshot', 'database_oid', 'role_oid', 'current_role'] as const)(
    'rejects changed final %s without publishing partial packets',
    async (key) => {
      const h = harness({
        identity: (last) => ({
          ...identityRow,
          [key]: last
            ? key === 'snapshot'
              ? '10:21:'
              : key.endsWith('_oid')
                ? '789'
                : 'other'
            : identityRow[key],
        }),
      });
      await expect(h.capture()).rejects.toMatchObject({ code: 'CAPTURE_SNAPSHOT_INVALID' });
      expect(h.cleaned()).toBe(true);
    },
  );
  it('requires actual RR/RO/version semantics, rather than caller assurances', async () => {
    const h = harness({ identity: () => ({ ...identityRow, isolation: 'read committed' }) });
    await expect(h.capture()).rejects.toMatchObject({ code: 'CAPTURE_SNAPSHOT_INVALID' });
    expect(h.parameters).toHaveLength(0);
  });
  it('discards complete callback result if transaction cleanup fails', async () => {
    const h = harness({ cleanupFailure: true });
    await expect(h.capture()).rejects.toMatchObject({ code: 'CAPTURE_IO_FAILED' });
    expect(h.cleaned()).toBe(true);
  });
  it('cancels mid-invocation and still drains the transaction lifetime, no partial result or retry', async () => {
    const controller = new AbortController();
    const h = harness({
      onQuery: (index) => {
        if (index === 4) controller.abort();
      },
    });
    await expect(h.capture(controller.signal)).rejects.toMatchObject({ code: 'CAPTURE_CANCELLED' });
    expect(h.cleaned()).toBe(true);
    expect(h.sql).toHaveLength(4);
  });
  it('rejects a lifetime port failure before callback invocation', async () => {
    const capture = createFullRestoreNativePacketCaptureV1(assets, pins, {
      withRepeatableReadOnly: async () => {
        throw Error('not_started');
      },
    }).capture;
    await expect(capture()).rejects.toMatchObject({ code: 'CAPTURE_IO_FAILED' });
  });
  it('does not invoke malicious port or carrier getters and captures method identity at factory time', async () => {
    let calls = 0;
    const getterPort = Object.defineProperty({}, 'withRepeatableReadOnly', {
      get() {
        calls++;
      },
    });
    expect(() =>
      createFullRestoreNativePacketCaptureV1(
        assets,
        pins,
        getterPort as Parameters<typeof createFullRestoreNativePacketCaptureV1>[2],
      ),
    ).toThrow();
    const h = harness({
      carrier: () => ({
        ...carrier('[]'),
        get body() {
          calls++;
          return '[]';
        },
      }),
    });
    await expect(h.capture()).rejects.toMatchObject({ code: 'CAPTURE_REPLY_INVALID' });
    expect(calls).toBe(0);
  });
  it('preserves opaque JSONB numeric text and original UTF8 bytes without granting domain validity', async () => {
    const index = factory.allPlans.findIndex((plan) =>
      plan.columns.some((c) => c.pgType === 'jsonb'),
    );
    const plan = must(factory.allPlans[index]);
    const payload = '{"large":9007199254740993,"exponent":1e400,"null":null}';
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
    const row = {
      rowVersion: 2,
      columns: plan.columns.map((column) => ({
        column: column.column,
        value: samples[column.pgType],
      })),
    };
    // Whitespace is a physical byte fact. It must not be reserialized away.
    const body = '[\n' + JSON.stringify(row) + '\n]';
    const h = harness({
      carrier: (current) =>
        current === index
          ? carrier(
              body,
              '1',
              String(Buffer.byteLength(JSON.stringify(row))),
              String(Buffer.byteLength(body)),
            )
          : carrier('[]'),
    });
    const result = await h.capture();
    const packet = must(result.packets[index]);
    expect(new TextDecoder().decode(packet.copyOriginalUtf8())).toBe(body);
    expect(packet.rowsSha256).toBe(hash(body));
    expect(packet.domainValidation).toBe('not_checked');
    expect(
      packet.rows[0]?.columns.find((column) => column.value.kind === 'jsonb')?.value,
    ).toMatchObject({ text: payload });
  });
  it('captures query method once per lease despite port mutation, without invoking a replacement', async () => {
    const h = harness();
    const port = {
      withRepeatableReadOnly: async <T>(
        callback: (tx: {
          query: (sql: string, params: readonly unknown[]) => Promise<unknown>;
        }) => Promise<T>,
      ) => {
        let calls = 0;
        const tx = {
          query: async (sql: string, _params: readonly unknown[]) => {
            calls++;
            if (calls === 1)
              tx.query = async () => {
                throw Error('mutated_method_must_not_run');
              };
            if (sql.includes('current_database()')) return driver([{ ...identityRow }]);
            if (sql.includes('has_table_privilege'))
              return driver(
                factory.allPlans.map((p) => ({
                  schema: p.schema,
                  relation: p.relation,
                  readable: true,
                  filtered: false,
                })),
              );
            return driver([carrier('[]')]);
          },
        };
        return callback(tx);
      },
    };
    expect(
      (await createFullRestoreNativePacketCaptureV1(assets, pins, port).capture()).packets,
    ).toHaveLength(239);
    expect(h.plans()).toBe(0);
  });
  it('requires exactly one callback even when a port suppresses its second invocation error', async () => {
    const h = harness();
    const port = {
      withRepeatableReadOnly: async <T>(callback: (tx: typeof h.transaction) => Promise<T>) => {
        const first = await h.port.withRepeatableReadOnly(callback);
        await callback(h.transaction).catch(() => undefined);
        return first;
      },
    };
    await expect(
      createFullRestoreNativePacketCaptureV1(assets, pins, port).capture(),
    ).rejects.toMatchObject({ code: 'CAPTURE_LIFETIME_INVALID' });
    expect(h.sql).toHaveLength(242);
  });
  it('rejects an already cancelled capture before acquiring any lease', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    await expect(h.capture(controller.signal)).rejects.toMatchObject({ code: 'CAPTURE_CANCELLED' });
    expect(h.sql).toHaveLength(0);
    expect(h.cleaned()).toBe(false);
  });
});
