import { describe, expect, it, vi } from 'vitest';
import type * as InstallationV9 from '../src/current-runtime-installation-v9.js';
import { currentRuntimeV9FunctionPins } from '../src/current-runtime-installation-v9.js';
import { currentRuntimeV9RpcSourcePins } from '../src/current-runtime-grants-v9.js';
import type { CurrentRuntimeCatalogMetadataV3 } from '../src/current-runtime-catalog-witness-v3.js';
import {
  buildCurrentRuntimeCatalogWitnessV9,
  parseCurrentRuntimeCatalogWitnessV9,
  captureCurrentRuntimeCatalogWitnessV9In,
} from '../src/current-runtime-catalog-witness-v9.js';
vi.mock('../src/current-runtime-installation-v9.js', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallationV9>();
  return { ...actual, verifyCurrentRuntimeV9InstalledIn: vi.fn().mockResolvedValue(undefined) };
});
function metadata(): CurrentRuntimeCatalogMetadataV3 {
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

const context = {
  owner: true,
  privateHelper: true,
  locksHeld: true,
  runtime: true,
  readOnly: true,
  pathSafe: true,
  isolation: 'repeatable read',
  roleCount: 4,
};
function roots() {
  return currentRuntimeV9RpcSourcePins.map((p, i) => ({
    ordinal: i + 1,
    signature: p.signature,
    owned: true,
    language: p.language,
    result_type: p.result_type,
    security_definer: p.security_definer,
    volatility: p.volatility,
    source_sha256: p.prosrcSha256,
    configuration: [...p.configuration],
    runtime_execute: true,
    public_execute: false,
    safe_delegation: true,
  }));
}
function helpers() {
  const types: Record<string, string> = {
    '2278': 'void',
    '16': 'boolean',
    '1009': 'text[]',
    '3802': 'jsonb',
  };
  return currentRuntimeV9FunctionPins
    .filter((p) => !p.runtimeDirect)
    .map((p, i) => ({
      ordinal: i + 1,
      signature: p.signature,
      owned: true,
      language: p.language,
      result_type: types[p.metadata.prorettype],
      security_definer: p.metadata.prosecdef,
      volatility: p.metadata.provolatile,
      source_sha256: p.prosrcSha256,
      configuration: [...p.metadata.proconfig],
      return_oid: p.metadata.prorettype,
      runtime_denied: true,
      delegation_safe: true,
    }));
}
function mockTx(
  patch: {
    context?: Record<string, unknown>;
    roots?: Record<string, unknown>[];
    helpers?: Record<string, unknown>[];
    bytes?: string;
  } = {},
) {
  let transfers = 0;
  const body = metadata();
  return {
    get transfers() {
      return transfers;
    },
    query: async (sql: string) => {
      if (sql.includes(' AS owner')) return { rows: [patch.context ?? context], rowCount: 1 };
      if (sql.includes('runtime_denied')) return { rows: patch.helpers ?? helpers(), rowCount: 17 };
      if (sql.startsWith('SELECT i.ordinal')) return { rows: patch.roots ?? roots(), rowCount: 42 };
      if (sql.includes('"maxSourceBytes"'))
        return {
          rows: [{ functions: 70, relations: 23, types: 0, maxSourceBytes: 100 }],
          rowCount: 1,
        };
      if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: null };
      transfers++;
      expect(sql).toContain('CASE WHEN bytes<=16777216 THEN body ELSE NULL END metadata');
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
describe('final142 catalog observation only', () => {
  it('preserves whole metadata and pins exact profile/receipt distinction without support', () => {
    const w = buildCurrentRuntimeCatalogWitnessV9(metadata());
    expect(w.profile.runtimeStep).toBe(25);
    expect(w.profile.sourceDdlTip).toBe(142);
    expect(w.profile.parentMembers).toHaveLength(31);
    expect(w.profile.extensionMembers).toHaveLength(1);
    expect(w.rpcRecipe.signatures).toHaveLength(42);
    expect(w.supported).toBe(false);
    expect(w.processingAuthority).toBe('none');
    expect(parseCurrentRuntimeCatalogWitnessV9(w)).toEqual(w);
    for (const patch of [
      { supported: true },
      { profile: { ...w.profile, sourceDdlTip: 141 } },
      { rpcRecipe: { ...w.rpcRecipe, rootCount: 41 } },
      { unknown: true },
      { closure: { ...w.closure, effectiveRecipe: 'verified' } },
    ])
      expect(() => parseCurrentRuntimeCatalogWitnessV9({ ...w, ...patch })).toThrow();
  });
  it('transfers one gated whole body after roots42/helpers17', async () => {
    const tx = mockTx();
    const w = await captureCurrentRuntimeCatalogWitnessV9In(tx, 'runtime');
    expect(tx.transfers).toBe(1);
    expect(w.observation.expectedRootCount).toBe(42);
    expect(w.witnessVersion).toBe(9);
    expect(w.profile.runtimeStep).toBe(25);
    expect(w.profile.sourceDdlTip).toBe(142);
    expect(parseCurrentRuntimeCatalogWitnessV9(w)).toEqual(w);
    expect(w.supported).toBe(false);
  });
  it.each([
    'runtime_denied',
    'delegation_safe',
    'source_sha256',
    'ordinal',
    'configuration',
    'missing',
  ] as const)('rejects helper %s drift before body', async (field) => {
    const rows: Record<string, unknown>[] = helpers();
    const last = rows.at(-1);
    if (!last) throw Error('FIXTURE');
    if (field === 'missing') rows.pop();
    else if (field === 'source_sha256') last[field] = 'a'.repeat(64);
    else if (field === 'ordinal') last[field] = 16;
    else if (field === 'configuration') last[field] = ['search_path=public'];
    else last[field] = false;
    const tx = mockTx({ helpers: rows });
    await expect(captureCurrentRuntimeCatalogWitnessV9In(tx, 'runtime')).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
    expect(tx.transfers).toBe(0);
  });
  it.each(['runtime_execute', 'public_execute', 'source_sha256', 'missing'] as const)(
    'rejects root %s drift before body',
    async (field) => {
      const rows: Record<string, unknown>[] = roots();
      const last = rows.at(-1);
      if (!last) throw Error('FIXTURE');
      if (field === 'missing') rows.pop();
      else if (field === 'source_sha256') last[field] = 'a'.repeat(64);
      else last[field] = field === 'public_execute';
      const tx = mockTx({ roots: rows });
      await expect(captureCurrentRuntimeCatalogWitnessV9In(tx, 'runtime')).rejects.toThrow(
        'CATALOG_WITNESS_INVALID',
      );
      expect(tx.transfers).toBe(0);
    },
  );
  it.each(['owner', 'runtime', 'privateHelper', 'locksHeld', 'readOnly', 'pathSafe'] as const)(
    'rejects context %s',
    async (field) => {
      const tx = mockTx({ context: { ...context, [field]: false } });
      await expect(captureCurrentRuntimeCatalogWitnessV9In(tx, 'runtime')).rejects.toThrow(
        'CATALOG_WITNESS_CONTEXT_REQUIRED',
      );
      expect(tx.transfers).toBe(0);
    },
  );
  it('keeps underreport/limit/unknown boundary rejects', async () => {
    for (const bytes of ['1', '16777217'])
      await expect(
        captureCurrentRuntimeCatalogWitnessV9In(mockTx({ bytes }), 'runtime'),
      ).rejects.toThrow();
    let calls = 0;
    await expect(
      captureCurrentRuntimeCatalogWitnessV9In(
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
    expect(() => buildCurrentRuntimeCatalogWitnessV9(raw)).toThrow();
    expect(getter).toBe(0);
  });
});
