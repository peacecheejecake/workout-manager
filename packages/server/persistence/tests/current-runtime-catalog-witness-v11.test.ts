import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type * as InstallationV11 from '../src/current-runtime-installation-v11.js';
import {
  currentRuntimeV11FunctionPins,
  currentRuntimeV11Tables,
  verifyCurrentRuntimeV11InstalledIn,
} from '../src/current-runtime-installation-v11.js';
import {
  currentRuntimeV11AiDispatcherTableGrants,
  currentRuntimeV11OwnerOnlyFunctions,
  currentRuntimeV11RpcSignatures,
  currentRuntimeV11RpcSourcePins,
  currentRuntimeV11RuntimeTableGrants,
  currentRuntimeV11WorkerRpcSignatures,
} from '../src/current-runtime-grants-v11.js';
import { currentRuntimeV10RpcSignatures } from '../src/current-runtime-grants-v10.js';
import {
  currentRuntimeCatalogMetadataQueryV3,
  type CurrentRuntimeCatalogMetadataV3,
} from '../src/current-runtime-catalog-witness-v3.js';
import { buildCurrentRuntimeCatalogWitnessV10 } from '../src/current-runtime-catalog-witness-v10.js';
import {
  buildCurrentRuntimeCatalogWitnessV11,
  parseCurrentRuntimeCatalogWitnessV11,
  captureCurrentRuntimeCatalogWitnessV11In,
  currentRuntimeCatalogMetadataQueryV11,
  currentRuntimeV11PrincipalRoleTags,
} from '../src/current-runtime-catalog-witness-v11.js';
vi.mock('../src/current-runtime-installation-v11.js', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallationV11>();
  return { ...actual, verifyCurrentRuntimeV11InstalledIn: vi.fn().mockResolvedValue(undefined) };
});
function metadata(tags = ['ai_dispatcher', 'gallery_rendition_worker', 'owner', 'runtime']) {
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
  const body: CurrentRuntimeCatalogMetadataV3 = {
    serverVersion: '170006',
    schemas: [
      { name: 'public', owner: 'owner', acl: [], runtimeUsage: true, runtimeCreate: false },
    ],
    functions: [],
    relations: [],
    defaultPrivileges: [],
    roles: tags.map(role),
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
  return body;
}
const context = {
  owner: true,
  privateHelper: true,
  locksHeld: true,
  runtime: true,
  worker: true,
  dispatcher: true,
  readOnly: true,
  pathSafe: true,
  isolation: 'repeatable read',
  roleCount: 6,
};
type Row = Record<string, unknown>;
function acl(signature: string, i: number, access: 'runtime' | 'worker' | 'owner'): Row {
  const root = currentRuntimeV11RpcSourcePins.find((p) => p.signature === signature);
  const pin = currentRuntimeV11FunctionPins.find((p) => p.signature === signature);
  return {
    ordinal: i + 1,
    signature,
    owned: true,
    language: root?.language ?? pin?.language ?? 'plpgsql',
    result_type: root?.result_type ?? pin?.returns ?? 'jsonb',
    security_definer: root?.security_definer ?? pin?.securityDefiner ?? true,
    volatility: root?.volatility ?? pin?.volatility ?? 'v',
    source_sha256: root?.prosrcSha256 ?? pin?.prosrcSha256 ?? 'b'.repeat(64),
    configuration: [...(root?.configuration ?? ['search_path=pg_catalog, pg_temp'])],
    runtime_execute: access === 'runtime',
    worker_execute: access === 'worker',
    dispatcher_execute: false,
    public_execute: false,
    grantees: access === 'owner' ? [] : [access],
    safe_delegation: true,
  };
}
const roots = () => currentRuntimeV11RpcSignatures.map((s, i) => acl(s, i, 'runtime'));
const workers = () => currentRuntimeV11WorkerRpcSignatures.map((s, i) => acl(s, i, 'worker'));
const owners = () => currentRuntimeV11OwnerOnlyFunctions.map((s, i) => acl(s, i, 'owner'));
function tables(): Row[] {
  const allow = (g: readonly { table: string; privileges: readonly string[] }[], t: string) => [
    ...(g.find((v) => v.table === t)?.privileges ?? []),
  ];
  return currentRuntimeV11Tables.map((name, i) => ({
    ordinal: i + 1,
    name,
    owned: true,
    runtime: allow(currentRuntimeV11RuntimeTableGrants, name),
    worker: [],
    dispatcher: allow(currentRuntimeV11AiDispatcherTableGrants, name),
    delegation_safe: true,
    column_acl_free: true,
  }));
}
function mockTx(
  patch: {
    context?: Row;
    roots?: Row[];
    workers?: Row[];
    owners?: Row[];
    tables?: Row[];
    bytes?: string;
    body?: CurrentRuntimeCatalogMetadataV3;
  } = {},
) {
  let transfers = 0;
  const body = patch.body ?? metadata();
  const same = (values: unknown[] | undefined, list: readonly string[]) =>
    JSON.stringify(values?.[0]) === JSON.stringify(list);
  return {
    get transfers() {
      return transfers;
    },
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes(' AS owner')) return { rows: [patch.context ?? context], rowCount: 1 };
      if (sql.includes('worker_execute')) {
        if (same(values, currentRuntimeV11RpcSignatures))
          return { rows: patch.roots ?? roots(), rowCount: 51 };
        if (same(values, currentRuntimeV11WorkerRpcSignatures))
          return { rows: patch.workers ?? workers(), rowCount: 5 };
        if (same(values, currentRuntimeV11OwnerOnlyFunctions))
          return { rows: patch.owners ?? owners(), rowCount: 1 };
        throw Error('UNEXPECTED_FUNCTION_QUERY');
      }
      if (sql.includes('column_acl_free')) return { rows: patch.tables ?? tables(), rowCount: 13 };
      if (sql.includes('"maxSourceBytes"'))
        return {
          rows: [{ functions: 728, relations: 756, types: 508, maxSourceBytes: 100 }],
          rowCount: 1,
        };
      if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: null };
      transfers++;
      expect(sql).toContain('CASE WHEN bytes<=16777216 THEN body ELSE NULL END metadata');
      expect(sql).toContain("WHEN rolname='workout_ai_dispatcher' THEN 'ai_dispatcher'");
      return {
        rows: [
          {
            bytes: patch.bytes ?? String(Buffer.byteLength(JSON.stringify(body))),
            sha256: 'a'.repeat(64),
            metadata: body,
          },
        ],
        rowCount: 1,
      };
    },
  };
}
describe('final148 catalog observation only', () => {
  it('maps exactly the two fixed principals and preserves every other V3 query byte', () => {
    expect(currentRuntimeV11PrincipalRoleTags).toEqual({
      workout_gallery_rendition_worker: 'gallery_rendition_worker',
      workout_ai_dispatcher: 'ai_dispatcher',
    });
    expect(
      currentRuntimeCatalogMetadataQueryV11.replace(
        " WHEN rolname='workout_gallery_rendition_worker' THEN 'gallery_rendition_worker' WHEN rolname='workout_ai_dispatcher' THEN 'ai_dispatcher'",
        '',
      ),
    ).toBe(currentRuntimeCatalogMetadataQueryV3);
  });
  it('pins exact profile27 literals and receipts without support', () => {
    const w = buildCurrentRuntimeCatalogWitnessV11(metadata());
    expect(w.witnessVersion).toBe(11);
    expect(w.metadataEncoding).toBe('pg-catalog-runtime-security-normalized-v3-principals-v11');
    expect(w.profile).toMatchObject({ profileVersion: 11, runtimeStep: 27, sourceDdlTip: 148 });
    expect(w.profile.parentMembers).toHaveLength(33);
    expect(w.profile.parentMembers.at(-1)).toMatchObject({ step: 33, sourceDdlId: 146 });
    expect(w.profile.extensionMembers.map((m) => m.sourceDdlId)).toEqual([143, 144, 145, 147, 148]);
    expect(w.profile.runtimeSteps.slice(-6).map((s) => [s.step, s.sourceDdlId])).toEqual([
      [26, 146],
      [27, 143],
      [27, 144],
      [27, 145],
      [27, 147],
      [27, 148],
    ]);
    expect(w.rpcRecipe).toMatchObject({
      recipeVersion: 11,
      name: 'current-runtime-grants-v11',
      rootCount: 51,
      workerRootCount: 5,
      workerRole: 'workout_gallery_rendition_worker',
      dispatcherRole: 'workout_ai_dispatcher',
    });
    expect(w.rpcRecipe.signatures.slice(0, 42)).toEqual(currentRuntimeV10RpcSignatures);
    expect(w.supported).toBe(false);
    expect(w.processingAuthority).toBe('none');
    expect(w.unmappedRoleTags).toEqual([]);
    expect(parseCurrentRuntimeCatalogWitnessV11(w)).toEqual(w);
    for (const patch of [
      { supported: true },
      { witnessVersion: 10 },
      { metadataEncoding: 'pg-catalog-runtime-security-normalized-v3' },
      { profile: { ...w.profile, sourceDdlTip: 146 } },
      { profile: { ...w.profile, runtimeStep: 26 } },
      { profile: { ...w.profile, profileVersion: 10 } },
      { rpcRecipe: { ...w.rpcRecipe, rootCount: 42 } },
      { rpcRecipe: { ...w.rpcRecipe, workerRole: 'other_worker' } },
      { unknown: true },
      { closure: { ...w.closure, effectiveRecipe: 'verified' } },
    ])
      expect(() => parseCurrentRuntimeCatalogWitnessV11({ ...w, ...patch })).toThrow();
  });
  it('keeps the V10 metadata body and digest; only version/encoding/profile/recipe differ', () => {
    const v10 = buildCurrentRuntimeCatalogWitnessV10(metadata());
    const v11 = buildCurrentRuntimeCatalogWitnessV11(metadata());
    expect(v11.metadata).toEqual(v10.metadata);
    expect(v11.sections).toEqual(v10.sections);
    expect(v11.catalogSha256).toBe(v10.catalogSha256);
    expect(() => parseCurrentRuntimeCatalogWitnessV11(v10)).toThrow();
  });
  it('pins the exact grants-v11 source file', () => {
    const source = readFileSync(new URL('../src/current-runtime-grants-v11.ts', import.meta.url));
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      buildCurrentRuntimeCatalogWitnessV11(metadata()).rpcRecipe.grantSourceSha256,
    );
  });
  it('transfers one gated whole body after verifyV11/roots51/worker5/owner-only/tables', async () => {
    const tx = mockTx();
    const w = await captureCurrentRuntimeCatalogWitnessV11In(tx, 'runtime');
    expect(verifyCurrentRuntimeV11InstalledIn).toHaveBeenCalled();
    expect(tx.transfers).toBe(1);
    expect(w.observation).toMatchObject({ expectedRootCount: 51, expectedWorkerRootCount: 5 });
    expect(parseCurrentRuntimeCatalogWitnessV11(w)).toEqual(w);
    expect(w.supported).toBe(false);
  });
  it('fails closed before any catalog transfer when verifyV11 refuses', async () => {
    vi.mocked(verifyCurrentRuntimeV11InstalledIn).mockRejectedValueOnce(
      new Error('CURRENT_RUNTIME_V11_FUNCTION_DRIFT'),
    );
    const tx = mockTx();
    await expect(captureCurrentRuntimeCatalogWitnessV11In(tx, 'runtime')).rejects.toThrow(
      'CURRENT_RUNTIME_V11_FUNCTION_DRIFT',
    );
    expect(tx.transfers).toBe(0);
  });
  const drift = (rows: Row[], field: string, value: unknown) => {
    const last = rows.at(-1);
    if (!last) throw Error('FIXTURE');
    if (field === 'missing') rows.pop();
    else last[field] = value;
    return rows;
  };
  it.each([
    ['runtime_execute', false],
    ['worker_execute', true],
    ['dispatcher_execute', true],
    ['public_execute', true],
    ['grantees', ['other', 'runtime']],
    ['source_sha256', 'a'.repeat(64)],
    ['configuration', ['search_path=public']],
    ['missing', null],
  ] as const)('rejects root %s drift before body', async (field, value) => {
    const tx = mockTx({ roots: drift(roots(), field, value) });
    await expect(captureCurrentRuntimeCatalogWitnessV11In(tx, 'runtime')).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
    expect(tx.transfers).toBe(0);
  });
  it.each([
    ['worker_execute', false],
    ['runtime_execute', true],
    ['dispatcher_execute', true],
    ['grantees', ['runtime', 'worker']],
    ['security_definer', false],
    ['missing', null],
  ] as const)('rejects worker RPC %s drift before body', async (field, value) => {
    const tx = mockTx({ workers: drift(workers(), field, value) });
    await expect(captureCurrentRuntimeCatalogWitnessV11In(tx, 'runtime')).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
    expect(tx.transfers).toBe(0);
  });
  it.each([
    ['runtime_execute', true],
    ['worker_execute', true],
    ['dispatcher_execute', true],
    ['grantees', ['PUBLIC']],
    ['owned', false],
    ['missing', null],
  ] as const)('rejects owner-only %s drift before body', async (field, value) => {
    const tx = mockTx({ owners: drift(owners(), field, value) });
    await expect(captureCurrentRuntimeCatalogWitnessV11In(tx, 'runtime')).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
    expect(tx.transfers).toBe(0);
  });
  it.each([
    ['runtime', ['SELECT', 'UPDATE']],
    ['worker', ['SELECT']],
    ['dispatcher', ['SELECT']],
    ['delegation_safe', false],
    ['column_acl_free', false],
    ['missing', null],
  ] as const)('rejects V11 table %s drift before body', async (field, value) => {
    const rows = tables();
    // ai_execution_job_disposition is the last table (dispatcher-only).
    const last = rows.at(-1);
    if (!last) throw Error('FIXTURE');
    expect(last['name']).toBe('ai_execution_job_disposition');
    const tx = mockTx({ tables: drift(rows, field, value) });
    await expect(captureCurrentRuntimeCatalogWitnessV11In(tx, 'runtime')).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
    expect(tx.transfers).toBe(0);
  });
  it.each([
    'owner',
    'runtime',
    'worker',
    'dispatcher',
    'privateHelper',
    'locksHeld',
    'readOnly',
    'pathSafe',
  ] as const)('rejects context %s', async (field) => {
    const tx = mockTx({ context: { ...context, [field]: false } });
    await expect(captureCurrentRuntimeCatalogWitnessV11In(tx, 'runtime')).rejects.toThrow(
      'CATALOG_WITNESS_CONTEXT_REQUIRED',
    );
    expect(tx.transfers).toBe(0);
  });
  it('refuses a body with an unmapped role or a missing fixed principal', async () => {
    for (const tags of [
      ['ai_dispatcher', 'gallery_rendition_worker', 'owner', 'runtime', 'unmapped:intruder'],
      ['gallery_rendition_worker', 'owner', 'runtime'],
      ['ai_dispatcher', 'owner', 'runtime'],
    ])
      await expect(
        captureCurrentRuntimeCatalogWitnessV11In(mockTx({ body: metadata(tags) }), 'runtime'),
      ).rejects.toThrow('CATALOG_WITNESS_INVALID');
  });
  it('keeps underreport/limit/unknown boundary rejects', async () => {
    for (const bytes of ['1', '16777217'])
      await expect(
        captureCurrentRuntimeCatalogWitnessV11In(mockTx({ bytes }), 'runtime'),
      ).rejects.toThrow();
    let calls = 0;
    await expect(
      captureCurrentRuntimeCatalogWitnessV11In(
        {
          query: async () => {
            calls++;
            return { rows: [], rowCount: 0 };
          },
        },
        'UNSAFE role',
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    let getter = 0;
    const raw = metadata();
    Object.defineProperty(raw, 'languages', {
      enumerable: true,
      get() {
        getter++;
        return [];
      },
    });
    expect(() => buildCurrentRuntimeCatalogWitnessV11(raw)).toThrow();
    expect(getter).toBe(0);
  });
});
