import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createDomainSequenceStructureCompanionV1 } from '../src/full-restore-domain-sequence-structure-companion-v1.js';
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
      if (!map.has(col.typeName)) map.set(col.typeName, col.typeName === 'bigint' ? 20 : next++);
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
  const journalIdentity = wire.relations
    .find((r) => r.relation === 'openai_budget_journal')
    ?.columns.find((c) => c.name === 'sequence_id');
  if (journalIdentity) journalIdentity.identity = 'a';
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
  database_oid: '1',
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
const structureQuery = new Uint8Array(
  readFileSync(
    new URL('../src/full-restore-domain-sequence-structure-v1.fixed-query.sql', import.meta.url),
  ),
);
function structuralFixture() {
  const relations = f.wire.relations.map((r) => ({
    schema: r.schema,
    relation: r.relation,
    oid: String(r.oid),
    columns: r.columns.map((c) => ({
      position: c.position,
      name: c.name,
      typeOid: String(c.physicalTypeOid),
      typeSchema: 'pg_catalog',
      typeKind: 'b',
      baseOid: '0',
      typmod: c.typmod,
      nullable: c.nullable,
      identity: r.relation === 'openai_budget_journal' && c.name === 'sequence_id' ? 'a' : '',
      generated: '',
      defaultExpression: null,
    })),
    constraints: [] as {
      oid: string;
      name: string;
      kind: string;
      definition: string;
      validated: boolean;
      deferrable: boolean;
      deferred: boolean;
      key: number[];
      foreignOid: string;
      foreignKey: number[];
      updateAction: string;
      deleteAction: string;
      match: string;
      indexOid: string;
      dependencies: {
        class: string;
        oid: string;
        subid: number;
        kind: string;
        description: string;
        metadataSha256: string;
      }[];
    }[],
  }));
  const first = must(relations[0]);
  first.constraints.push({
    oid: '99001',
    name: 'synthetic_check',
    kind: 'c',
    definition: 'CHECK (synthetic is not null)',
    validated: true,
    deferrable: false,
    deferred: false,
    key: [1],
    foreignOid: '0',
    foreignKey: [],
    updateAction: ' ',
    deleteAction: ' ',
    match: ' ',
    indexOid: '0',
    dependencies: [
      {
        class: 'pg_class',
        oid: first.oid,
        subid: 1,
        kind: 'a',
        description: 'synthetic column',
        metadataSha256: 'a'.repeat(64),
      },
    ],
  });
  const journal = must(relations.find((r) => r.relation === 'openai_budget_journal'));
  const col = must(journal.columns.find((c) => c.name === 'sequence_id'));
  return {
    schemaVersion: 1,
    relations,
    domains: [] as string[],
    sequences: [
      {
        schema: 'public',
        relation: 'openai_budget_journal_sequence_id_seq',
        oid: '99000',
        owner: 'synthetic_owner',
        acl: null,
        persistence: 'p',
        typeOid: '20',
        start: '1',
        increment: '1',
        minimum: '1',
        maximum: '9223372036854775807',
        cache: '1',
        cycle: false,
        dependencies: [
          {
            class: 'pg_class',
            objid: '99000',
            objsubid: 0,
            refclass: 'pg_class',
            refobjid: journal.oid,
            refsubid: col.position,
            kind: 'i',
            schema: 'public',
            relation: 'openai_budget_journal',
            column: 'sequence_id',
            identity: 'a',
            dropped: false,
          },
        ],
      },
    ],
  };
}
const expectedStructure = bytes(structuralFixture());
const c4Assets = { ...assets, structureQuery, expectedStructure };
const c4Pins = {
  ...pins,
  structureQuerySha256: hash(structureQuery),
  expectedStructureSha256: hash(expectedStructure),
};
function h(
  modify?: (value: ReturnType<typeof structuralFixture>) => unknown,
  options: {
    cleanupFail?: boolean;
    identityDrift?: boolean;
    replaced?: boolean;
    twice?: boolean;
    lateAbort?: AbortController;
    structuralGate?: () => Promise<void>;
    rawBody?: string;
    extraField?: boolean;
  } = {},
) {
  let cleaned = false,
    leases = 0,
    queries = 0,
    nativeCalls = 0,
    identityCalls = 0;
  let escaped: ((sql: string, params: readonly unknown[]) => Promise<unknown>) | undefined;
  const port = {
    withRepeatableReadOnly: async <T>(
      callback: (tx: {
        query: (sql: string, params: readonly unknown[]) => Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T> => {
      leases++;
      let value: T;
      try {
        value = await callback({
          query: async (sql, params) => {
            queries++;
            let raw: unknown;
            if (sql.includes('current_database()')) {
              identityCalls++;
              raw = {
                ...identityRow,
                ...(options.identityDrift && identityCalls === 4 ? { snapshot: '11:20:' } : {}),
              };
            } else if (sql.includes('has_table_privilege'))
              return {
                rowCount: 239,
                rows: factory.allPlans.map((p) => ({
                  schema: p.schema,
                  relation: p.relation,
                  readable: true,
                  filtered: false,
                })),
              };
            else if (sql.includes('native_keys AS MATERIALIZED')) {
              nativeCalls++;
              raw = {
                session_ok: true,
                source_count: '0',
                supplied_count: '0',
                missing_keys: '0',
                duplicate_keys: '0',
                wrong_ordinal: '0',
              };
              expect(params).toEqual(['[]']);
            } else if (sql.includes('structure AS MATERIALIZED')) {
              await options.structuralGate?.();
              const b =
                options.rawBody ??
                JSON.stringify(modify ? modify(structuralFixture()) : structuralFixture());
              raw = {
                byte_length: String(Buffer.byteLength(b)),
                body: b,
                ...(options.extraField ? { secret: 'never' } : {}),
              };
              options.lateAbort?.abort();
            } else raw = carrier('[]');
            return { rows: [raw], rowCount: 1 };
          },
        });
      } finally {
        cleaned = true;
      }
      if (options.twice)
        await callback({
          query: async () => {
            throw Error('must not query expired lease');
          },
        });
      if (options.cleanupFail) throw Error('private cleanup');
      if (options.replaced) return structuredClone(value);
      return value;
    },
  };
  // Escaped-query test uses a distinct lease adapter, without exposing production internals.
  const preserving = {
    withRepeatableReadOnly: async <T>(
      callback: (tx: {
        query: (sql: string, params: readonly unknown[]) => Promise<unknown>;
      }) => Promise<T>,
      _signal?: AbortSignal,
    ) =>
      port.withRepeatableReadOnly(async (tx) => {
        escaped = tx.query;
        return callback(tx);
      }),
  };
  return {
    capture: createDomainSequenceStructureCompanionV1(c4Assets, c4Pins, preserving).capture,
    cleaned: () => cleaned,
    leases: () => leases,
    nativeCalls: () => nativeCalls,
    queries: () => queries,
    escaped: () => escaped,
  };
}
describe('C4 structure companion TMP; synthetic port is not actual PG evidence', () => {
  it('preserves C3 packets/order facts and compares independently supplied structure only after same-lease native239', async () => {
    const test = h();
    const value = await test.capture();
    expect(test.leases()).toBe(1);
    expect(test.nativeCalls()).toBe(239);
    expect(test.cleaned()).toBe(true);
    expect(value.captured.captured.packets).toHaveLength(239);
    expect(value.constraintCount).toBe(1);
    expect(value.expectedStructureSha256).toBe(c4Pins.expectedStructureSha256);
    expect(value.sequenceCount).toBe(1);
    expect(value.domainCount).toBe(0);
    expect(value.domainValidation).toBe('not_checked');
    expect(value.sequenceHighWater).toBe('not_checked');
    expect(value.pgDumpCorrespondence).toBe('not_checked');
    expect(value.wholeInverseLoader).toBe('not_checked');
    expect(value.admissionAllowed).toBe(false);
    expect(value.authority).toBe('none');
    expect(Object.isFrozen(value)).toBe(true);
  });
  it.each(['minimum', 'maximum', 'increment', 'cache', 'start'] as const)(
    'rejects structural %s mismatch while source row order remains valid',
    async (key) => {
      const test = h((value) => {
        must(value.sequences[0])[key] = '2';
        return value;
      });
      await expect(test.capture()).rejects.toBeInstanceOf(Error);
      expect(test.nativeCalls()).toBe(239);
      expect(test.cleaned()).toBe(true);
    },
  );
  it.each(['9223372036854775808', '-9223372036854775809', '01', '-0', '1e2', 1, null])(
    'rejects noncanonical/lossy/out-of-range sequence value %s',
    async (input) => {
      const test = h((value) => ({
        ...value,
        sequences: value.sequences.map((s) => ({ ...s, maximum: input })),
      }));
      await expect(test.capture()).rejects.toMatchObject({ code: 'STRUCTURE_REPLY_INVALID' });
      expect(test.cleaned()).toBe(true);
    },
  );
  it.each(['refclass', 'refobjid', 'refsubid', 'kind', 'identity', 'dropped'] as const)(
    'rejects ownership %s corruption',
    async (key) => {
      const test = h((value) => ({
        ...value,
        sequences: value.sequences.map((s) => ({
          ...s,
          dependencies: s.dependencies.map((d) => ({
            ...d,
            [key]: key === 'dropped' ? true : key === 'refsubid' ? 1 : 'wrong',
          })),
        })),
      }));
      await expect(test.capture()).rejects.toBeInstanceOf(Error);
      expect(test.cleaned()).toBe(true);
    },
  );
  it('rejects constraint definition/validation changes; does not claim row validation', async () => {
    for (const patch of [{ definition: 'CHECK (false)' }, { validated: false }])
      await expect(
        h((value) => ({
          ...value,
          relations: value.relations.map((r, i) =>
            i === 0 ? { ...r, constraints: r.constraints.map((c) => ({ ...c, ...patch })) } : r,
          ),
        })).capture(),
      ).rejects.toMatchObject({ code: 'STRUCTURE_MISMATCH' });
  });
  it('rejects missing/substituted roster, unexpected DOMAIN and unresolved foreign closure', async () => {
    await expect(
      h((value) => ({ ...value, relations: value.relations.slice(1) })).capture(),
    ).rejects.toMatchObject({ code: 'STRUCTURE_REPLY_INVALID' });
    await expect(h((value) => ({ ...value, domains: ['999'] })).capture()).rejects.toMatchObject({
      code: 'STRUCTURE_UNSUPPORTED',
    });
    await expect(
      h((value) => ({
        ...value,
        relations: value.relations.map((r, i) =>
          i === 0
            ? {
                ...r,
                constraints: r.constraints.map((c) => ({
                  ...c,
                  kind: 'f',
                  foreignOid: '99999',
                  foreignKey: [1],
                })),
              }
            : r,
        ),
      })).capture(),
    ).rejects.toMatchObject({ code: 'STRUCTURE_UNSUPPORTED' });
  });
  it('rejects duplicate JSON keys even when JSON.parse would erase the first declaration', async () => {
    const text = new TextDecoder()
      .decode(expectedStructure)
      .replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1');
    await expect(h(undefined, { rawBody: text }).capture()).rejects.toMatchObject({
      code: 'STRUCTURE_REPLY_INVALID',
    });
  });
  it('rejects extra reply field and final identity drift', async () => {
    await expect(h(undefined, { extraField: true }).capture()).rejects.toMatchObject({
      code: 'STRUCTURE_REPLY_INVALID',
    });
    await expect(h(undefined, { identityDrift: true }).capture()).rejects.toMatchObject({
      code: 'STRUCTURE_LIFETIME_INVALID',
    });
  });
  it('does not publish evidence on cleanup failure or replaced callback result', async () => {
    for (const options of [{ cleanupFail: true }, { replaced: true }, { twice: true }]) {
      const test = h(undefined, options);
      await expect(test.capture()).rejects.toBeInstanceOf(Error);
      expect(test.cleaned()).toBe(true);
    }
  });
  it('handles preaborted and postresponse cancellation without partial result', async () => {
    const early = new AbortController();
    early.abort();
    const test = h();
    await expect(test.capture(early.signal)).rejects.toMatchObject({ code: 'STRUCTURE_CANCELLED' });
    expect(test.queries()).toBe(0);
    const late = new AbortController();
    const test2 = h(undefined, { lateAbort: late });
    await expect(test2.capture(late.signal)).rejects.toMatchObject({ code: 'STRUCTURE_CANCELLED' });
    expect(test2.cleaned()).toBe(true);
  });
  it('rejects abort while structure query is pending after the port settles, with cleanup and no evidence', async () => {
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const controller = new AbortController();
    const test = h(undefined, {
      structuralGate: async () => {
        entered?.();
        await waiting;
      },
    });
    const result = test.capture(controller.signal);
    await seen;
    controller.abort();
    release?.();
    await expect(result).rejects.toMatchObject({ code: 'STRUCTURE_CANCELLED' });
    expect(test.cleaned()).toBe(true);
  });
  it('rejects duplicate ownership and changed dependency metadata digest', async () => {
    await expect(
      h((v) => ({
        ...v,
        sequences: v.sequences.map((s) => ({
          ...s,
          dependencies: [...s.dependencies, ...s.dependencies],
        })),
      })).capture(),
    ).rejects.toMatchObject({ code: 'STRUCTURE_MISMATCH' });
    await expect(
      h((v) => ({
        ...v,
        relations: v.relations.map((r, i) =>
          i === 0
            ? {
                ...r,
                constraints: r.constraints.map((c) => ({
                  ...c,
                  dependencies: c.dependencies.map((d) => ({
                    ...d,
                    metadataSha256: 'b'.repeat(64),
                  })),
                })),
              }
            : r,
        ),
      })).capture(),
    ).rejects.toMatchObject({ code: 'STRUCTURE_MISMATCH' });
  });
  it('refuses caller-selected SQL and reply-derived expected replacement; does not invoke asset getters', () => {
    const unused = {
      withRepeatableReadOnly: async () => {
        throw Error('never');
      },
    };
    const changed = new Uint8Array(Buffer.from('SELECT true'));
    expect(() =>
      createDomainSequenceStructureCompanionV1(
        { ...c4Assets, structureQuery: changed },
        { ...c4Pins, structureQuerySha256: hash(changed) },
        unused,
      ),
    ).toThrow();
    expect(() =>
      createDomainSequenceStructureCompanionV1(
        c4Assets,
        { ...c4Pins, expectedStructureSha256: '0'.repeat(64) },
        unused,
      ),
    ).toThrow();
    let called = 0;
    const bad = Object.defineProperty({ ...c4Assets }, 'expectedStructure', {
      get() {
        called++;
        return expectedStructure;
      },
    });
    expect(() => createDomainSequenceStructureCompanionV1(bad, c4Pins, unused)).toThrow();
    expect(called).toBe(0);
  });
});
