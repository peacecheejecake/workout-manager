import {
  parseCurrentRuntimeCatalogMetadataV3 as parseCurrentRuntimeCatalogMetadataV5,
  type CurrentRuntimeCatalogMetadataV3 as CurrentRuntimeCatalogMetadataV5,
} from '../src/current-runtime-catalog-witness-v3.js';
import { describe, expect, it, vi } from 'vitest';
import type * as InstallationV5 from '../src/current-runtime-installation-v5.js';
import {
  buildCurrentRuntimeCatalogWitnessV5,
  parseCurrentRuntimeCatalogWitnessV5,
  captureCurrentRuntimeCatalogWitnessV5In,
} from '../src/current-runtime-catalog-witness-v5.js';
vi.mock('../src/current-runtime-installation-v5.js', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallationV5>();
  return { ...actual, verifyCurrentRuntimeV5InstalledIn: vi.fn().mockResolvedValue(undefined) };
});
function first<T>(values: T[]): T {
  const v = values[0];
  if (v === undefined) throw new Error('fixture item missing');
  return v;
}
function metadata(): CurrentRuntimeCatalogMetadataV5 {
  const role = (tag: string) => ({
    tag,
    superuser: false,
    bypassRls: false,
    createRole: false,
    createDb: false,
    inherit: true,
    login: true,
    replication: false,
    configurationSha256: null,
  });
  return {
    serverVersion: '170006',
    schemas: [
      { name: 'public', owner: 'owner', acl: [], runtimeUsage: true, runtimeCreate: false },
    ],
    functions: [],
    relations: [],
    defaultPrivileges: [],
    roles: [role('owner'), role('runtime')],
    memberships: [],
    extensions: [],
    types: [],
    collations: [],
    dependencies: [],
    typeDetails: [],
    functionDetails: [],
    relationDetails: [],
    operators: [],
    casts: [],
    languages: [],
    accessMethods: [],
    eventTriggers: [],
    foreignWrappers: [],
    foreignServers: [],
    foreignTables: [],
    userMappings: [],
    operatorClasses: [],
    operatorFamilies: [],
    aggregates: [],
    transforms: [],
    additionalDependencies: [],
    sharedDependencies: [],
  };
}
function withType(): CurrentRuntimeCatalogMetadataV5 {
  const m = metadata();
  m.types.push({
    schema: 'public',
    name: '범위Domain',
    owner: 'owner',
    kind: 'd',
    definition: 'actual observed type',
  });
  m.typeDetails.push({
    schema: 'public',
    name: '범위Domain',
    owner: 'owner',
    acl: [],
    runtimeUsage: true,
    kind: 'd',
    length: 4,
    byValue: true,
    category: 'N',
    preferred: false,
    defined: true,
    delimiter: ',',
    alignment: 'i',
    storage: 'p',
    notNull: false,
    dimensions: 0,
    element: null,
    array: null,
    base: 'integer',
    typmod: -1,
    collation: null,
    input: 'domain_in(cstring, oid, integer)',
    output: 'int4out(integer)',
    receive: null,
    send: null,
    typmodIn: null,
    typmodOut: null,
    analyze: null,
    subscript: null,
    default: null,
    enumLabels: [],
    domainConstraints: [
      {
        name: 'positive',
        kind: 'c',
        definition: 'CHECK (VALUE > 0)',
        validated: true,
        deferrable: false,
        deferred: false,
      },
    ],
    attributes: [],
    range: null,
  });
  return m;
}
describe('profile21 whole catalog observation is not admission', () => {
  it('pins actual21 profile and32 roots without promoting any remaining closure', () => {
    const w = buildCurrentRuntimeCatalogWitnessV5(metadata());
    expect(w.profile.runtimeSteps.map((v) => v.sourceDdlId)).toEqual([
      108, 109, 110, 111, 112, 113, 114, 115, 116, 118, 120, 121, 122, 123, 124, 126, 127, 128, 129,
      130, 131,
    ]);
    expect(w.profile.runtimeStep).toBe(21);
    expect(w.supported).toBe(false);
    expect(w.processingAuthority).toBe('none');
    expect(w.closure).toEqual({
      catalogObservation: 'enumerated',
      dynamicDependencies: 'not_verified',
      strictCallerWire: 'not_verified',
      effectiveRecipe: 'not_verified',
      independentNormalization: 'not_verified',
    });
  });
  it('validates artifact integrity without accepting caller-minted profile/support/closure claims', () => {
    const w = buildCurrentRuntimeCatalogWitnessV5(metadata());
    expect(parseCurrentRuntimeCatalogWitnessV5(w)).toEqual(w);
    expect(() => parseCurrentRuntimeCatalogWitnessV5({ ...w, supported: true })).toThrow();
    expect(() =>
      parseCurrentRuntimeCatalogWitnessV5({ ...w, profile: { ...w.profile, runtimeStep: 18 } }),
    ).toThrow();
    expect(() =>
      parseCurrentRuntimeCatalogWitnessV5({ ...w, catalogSha256: 'b'.repeat(64) }),
    ).toThrow();
  });
  it('preserves actual Unicode names and changes digest for domain/ACL/type facts', () => {
    const m = withType(),
      before = buildCurrentRuntimeCatalogWitnessV5(m);
    expect(before.metadata.typeDetails[0]?.name).toBe('범위Domain');
    first(first(m.typeDetails).domainConstraints).definition = 'CHECK (VALUE >= 0)';
    expect(buildCurrentRuntimeCatalogWitnessV5(m).catalogSha256).not.toBe(before.catalogSha256);
    first(m.typeDetails).acl = [
      { grantee: 'runtime', grantor: 'owner', privilege: 'USAGE', grantable: true },
    ];
    expect(buildCurrentRuntimeCatalogWitnessV5(m).metadata.typeDetails[0]?.acl[0]?.grantable).toBe(
      true,
    );
  });
  it('requires exact type and relation counterpart rosters', () => {
    const m = withType();
    m.typeDetails = [];
    expect(() => parseCurrentRuntimeCatalogMetadataV5(m)).toThrow('CATALOG_WITNESS_INVALID');
  });
  it('retains unknown ACL principals only with their actual role facts', () => {
    const m = withType();
    first(m.typeDetails).acl = [
      { grantee: 'unmapped:ActualOther', grantor: 'owner', privilege: 'USAGE', grantable: false },
    ];
    expect(() => parseCurrentRuntimeCatalogMetadataV5(m)).toThrow('CATALOG_WITNESS_INVALID');
    m.roles.push({ ...first(m.roles), tag: 'unmapped:ActualOther' });
    expect(parseCurrentRuntimeCatalogMetadataV5(m).typeDetails[0]?.acl[0]?.grantee).toBe(
      'unmapped:ActualOther',
    );
  });
  it('does not collapse overloaded operators or operators with distinct actual signatures', () => {
    const m = metadata(),
      op = {
        schema: 'public',
        name: '===',
        owner: 'owner',
        kind: 'b',
        left: 'integer',
        right: 'integer',
        result: 'boolean',
        procedure: 'int4eq(integer,integer)',
        commutator: null,
        negator: null,
        restrict: null,
        join: null,
        hashes: false,
        merges: false,
      };
    m.operators = [op, { ...op, left: 'bigint' }];
    expect(parseCurrentRuntimeCatalogMetadataV5(m).operators).toHaveLength(2);
    m.operators.push({ ...op });
    expect(() => parseCurrentRuntimeCatalogMetadataV5(m)).toThrow('CATALOG_WITNESS_INVALID');
  });
  it('keeps user RI lookalikes and semantic dependency changes', () => {
    const m = metadata();
    m.additionalDependencies = [
      {
        dependent: 'trigger "RI_ConstraintTrigger_a_12345" on public.user_table',
        referenced: 'function public.user_guard()',
        kind: 'n',
      },
    ];
    const before = buildCurrentRuntimeCatalogWitnessV5(m);
    first(m.additionalDependencies).referenced = 'function public.changed_guard()';
    expect(buildCurrentRuntimeCatalogWitnessV5(m).catalogSha256).not.toBe(before.catalogSha256);
    expect(before.metadata.additionalDependencies[0]?.dependent).toContain('12345');
  });
  it('observes every finite object section, including genuinely empty censuses', () => {
    const m = metadata();
    m.foreignWrappers = [
      {
        name: 'Wrapper',
        owner: 'owner',
        handler: null,
        validator: null,
        optionsSha256: 'a'.repeat(64),
        acl: [],
        runtimeUsage: false,
      },
    ];
    expect(buildCurrentRuntimeCatalogWitnessV5(m).metadata.foreignWrappers[0]?.optionsSha256).toBe(
      'a'.repeat(64),
    );
    const forged = {
      ...m,
      foreignWrappers: [{ ...m.foreignWrappers[0], options: ['password=secret'] }],
    };
    expect(() => parseCurrentRuntimeCatalogMetadataV5(forged)).toThrow('CATALOG_WITNESS_INVALID');
  });
  it('rejects malformed/extra/getter/cycle before schema or I/O', async () => {
    let calls = 0;
    const tx = {
      query: async () => {
        calls++;
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(captureCurrentRuntimeCatalogWitnessV5In(tx, 'UNSAFE role')).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
    expect(calls).toBe(0);
    const m = metadata();
    expect(() => parseCurrentRuntimeCatalogMetadataV5({ ...m, unknown: 1 })).toThrow();
    let getter = 0;
    const raw = { ...m };
    Object.defineProperty(raw, 'languages', {
      get() {
        getter++;
        return [];
      },
      enumerable: true,
    });
    expect(() => parseCurrentRuntimeCatalogMetadataV5(raw)).toThrow();
    expect(getter).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => parseCurrentRuntimeCatalogMetadataV5(cycle)).toThrow();
  });
  it('preserves 16MiB/depth32 bounds and actual63 UTF8 byte names', () => {
    const m = metadata();
    first(m.schemas).name = '가'.repeat(22);
    expect(() => parseCurrentRuntimeCatalogMetadataV5(m)).toThrow();
    first(m.schemas).name = '가'.repeat(21);
    expect(parseCurrentRuntimeCatalogMetadataV5(m).schemas[0]?.name).toHaveLength(21);
    expect(() => parseCurrentRuntimeCatalogMetadataV5('x'.repeat(16 * 1024 * 1024 + 1))).toThrow(
      'CATALOG_WITNESS_LIMIT',
    );
    let nested: unknown = null;
    for (let i = 0; i < 34; i++) nested = [nested];
    expect(() => parseCurrentRuntimeCatalogMetadataV5(nested)).toThrow('CATALOG_WITNESS_LIMIT');
  });
  it('returns one gated catalog envelope and rejects oversized or underreported metadata', async () => {
    const body = metadata();
    const honest = {
      bytes: String(Buffer.byteLength(JSON.stringify(body), 'utf8')),
      sha256: 'a'.repeat(64),
      metadata: body,
    };
    for (const [response, code] of [
      [honest, null],
      [{ ...honest, bytes: '16777217', metadata: null }, 'CATALOG_WITNESS_LIMIT'],
      [{ ...honest, bytes: '1' }, 'CATALOG_WITNESS_INVALID'],
      [{ ...honest, metadata: null }, 'CATALOG_WITNESS_INVALID'],
    ] as const) {
      let catalogCalls = 0;
      const tx = {
        query: async (
          sql: string,
        ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> => {
          if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: null };
          if (sql.includes(' AS owner'))
            return {
              rowCount: 1,
              rows: [
                {
                  owner: true,
                  locksHeld: true,
                  runtime: true,
                  readOnly: true,
                  pathSafe: true,
                  isolation: 'repeatable read',
                  roleCount: 4,
                },
              ],
            };
          if (sql.includes('"maxSourceBytes"'))
            return {
              rowCount: 1,
              rows: [{ functions: 32, relations: 23, types: 0, maxSourceBytes: 100 }],
            };
          catalogCalls++;
          return { rowCount: 1, rows: [response] };
        },
      };
      const result = captureCurrentRuntimeCatalogWitnessV5In(tx, 'runtime');
      if (code === null) {
        const observed = await result;
        expect(observed.metadata).toEqual(body);
        expect(observed.observation.metadataBytes).toBe(honest.bytes);
        expect(observed.supported).toBe(false);
      } else await expect(result).rejects.toThrow(code);
      expect(catalogCalls).toBe(1);
    }
  });
  it('uses the reused actual FK description column in dependency and shared dependency queries', async () => {
    let measuredSql = '';
    const stop = new Error('synthetic measured query boundary');
    const tx = {
      query: async (
        sql: string,
      ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> => {
        if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: null };
        if (sql.includes(' AS owner'))
          return {
            rowCount: 1,
            rows: [
              {
                owner: true,
                locksHeld: true,
                runtime: true,
                readOnly: true,
                pathSafe: true,
                isolation: 'repeatable read',
                roleCount: 4,
              },
            ],
          };
        if (sql.includes('"maxSourceBytes"'))
          return {
            rowCount: 1,
            rows: [{ functions: 32, relations: 23, types: 0, maxSourceBytes: 100 }],
          };
        measuredSql = sql;
        throw stop;
      },
    };
    await expect(captureCurrentRuntimeCatalogWitnessV5In(tx, 'runtime')).rejects.toBe(stop);
    expect(measuredSql).toContain('::text AS description');
    expect(measuredSql).toContain('coalesce(dt.description,dm.identity,');
    expect(measuredSql).toContain('coalesce(rt.description,rm.identity,');
    expect(measuredSql).toContain('coalesce(t.description,m.identity,');
    expect(measuredSql).not.toContain('dt.identity');
    expect(measuredSql).not.toContain('rt.identity');
    expect(measuredSql).toContain('enriched AS MATERIALIZED');
    expect(measuredSql).toContain('measured AS MATERIALIZED');
    expect(measuredSql).toContain('CASE WHEN bytes<=16777216 THEN body ELSE NULL END metadata');
  });
  it('rejects ordinary/runtime/wrong isolation context and propagates SQL errors', async () => {
    await expect(
      captureCurrentRuntimeCatalogWitnessV5In(
        {
          query: async () => ({
            rowCount: 1,
            rows: [
              {
                owner: true,
                locksHeld: true,
                runtime: true,
                readOnly: false,
                isolation: 'read committed',
                roleCount: 4,
              },
            ],
          }),
        },
        'runtime',
      ),
    ).rejects.toThrow('CATALOG_WITNESS_CONTEXT_REQUIRED');
    const error = new Error('synthetic catalog SQL failure');
    await expect(
      captureCurrentRuntimeCatalogWitnessV5In(
        {
          query: async () => {
            throw error;
          },
        },
        'runtime',
      ),
    ).rejects.toBe(error);
  });
});

it('rejects missing lifecycle/installer locks before installer or full catalog queries', async () => {
  let queries = 0;
  await expect(
    captureCurrentRuntimeCatalogWitnessV5In(
      {
        query: async () => {
          queries++;
          return {
            rowCount: 1,
            rows: [
              {
                owner: true,
                runtime: true,
                readOnly: true,
                pathSafe: true,
                isolation: 'repeatable read',
                roleCount: 4,
                locksHeld: false,
              },
            ],
          };
        },
      },
      'runtime',
    ),
  ).rejects.toThrow('CATALOG_WITNESS_CONTEXT_REQUIRED');
  expect(queries).toBe(1);
});
it('rejects old20 source profile, extension hash drift and source131 caller support claims', () => {
  const w = buildCurrentRuntimeCatalogWitnessV5(metadata());
  expect(() =>
    parseCurrentRuntimeCatalogWitnessV5({
      ...w,
      profile: { ...w.profile, runtimeSteps: w.profile.runtimeSteps.slice(0, 20) },
    }),
  ).toThrow();
  const altered = {
    ...w,
    profile: {
      ...w.profile,
      runtimeSteps: w.profile.runtimeSteps.map((member, index) =>
        index === 20 ? { ...member, sha256: 'b'.repeat(64) } : member,
      ),
    },
  };
  expect(() => parseCurrentRuntimeCatalogWitnessV5(altered)).toThrow();
  expect(() => parseCurrentRuntimeCatalogWitnessV5({ ...w, supported: true })).toThrow();
  expect(() =>
    parseCurrentRuntimeCatalogWitnessV5({
      ...w,
      observation: {
        clusterRoleCount: 4,
        metadataBytes: '1000',
        sqlJsonbSha256: 'a'.repeat(64),
        expectedRootCount: 31,
      },
    }),
  ).toThrow();
});
