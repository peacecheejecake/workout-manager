import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type * as InstallationV10 from '../src/current-runtime-installation-v10.js';
import {
  currentRuntimeV10FunctionPins,
  currentRuntimeV10GuardFunctionSignature,
  verifyCurrentRuntimeV10InstalledIn,
} from '../src/current-runtime-installation-v10.js';
import {
  currentRuntimeV10RpcSourcePins,
  currentRuntimeV10RpcSignatures,
} from '../src/current-runtime-grants-v10.js';
import { currentRuntimeV9RpcSignatures } from '../src/current-runtime-grants-v9.js';
import type { CurrentRuntimeCatalogMetadataV3 } from '../src/current-runtime-catalog-witness-v3.js';
import { buildCurrentRuntimeCatalogWitnessV9 } from '../src/current-runtime-catalog-witness-v9.js';
import {
  buildCurrentRuntimeCatalogWitnessV10,
  parseCurrentRuntimeCatalogWitnessV10,
  captureCurrentRuntimeCatalogWitnessV10In,
} from '../src/current-runtime-catalog-witness-v10.js';
vi.mock('../src/current-runtime-installation-v10.js', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallationV10>();
  return { ...actual, verifyCurrentRuntimeV10InstalledIn: vi.fn().mockResolvedValue(undefined) };
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
  return currentRuntimeV10RpcSourcePins.map((p, i) => ({
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
  return currentRuntimeV10FunctionPins
    .filter((p) => !p.runtimeDirect && p.signature !== currentRuntimeV10GuardFunctionSignature)
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
function triggers(): Record<string, unknown>[] {
  const pin = currentRuntimeV10FunctionPins.find(
    (p) => p.signature === currentRuntimeV10GuardFunctionSignature,
  );
  if (!pin) throw Error('FIXTURE');
  return [
    {
      ordinal: 1,
      signature: pin.signature,
      owned: true,
      language: pin.language,
      result_type: 'trigger',
      security_definer: false,
      volatility: pin.metadata.provolatile,
      source_sha256: pin.prosrcSha256,
      configuration: [...pin.metadata.proconfig],
      return_oid: pin.metadata.prorettype,
      runtime_denied: true,
      delegation_safe: true,
    },
  ];
}
function mockTx(
  patch: {
    context?: Record<string, unknown>;
    roots?: Record<string, unknown>[];
    helpers?: Record<string, unknown>[];
    triggers?: Record<string, unknown>[];
    bytes?: string;
  } = {},
) {
  let transfers = 0;
  const body = metadata();
  return {
    get transfers() {
      return transfers;
    },
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes(' AS owner')) return { rows: [patch.context ?? context], rowCount: 1 };
      if (
        sql.includes('runtime_denied') &&
        JSON.stringify(values?.[0]) === JSON.stringify([currentRuntimeV10GuardFunctionSignature])
      )
        return { rows: patch.triggers ?? triggers(), rowCount: 1 };
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
describe('final146 catalog observation only', () => {
  it('preserves whole metadata and pins exact profile26/receipt distinction without support', () => {
    const w = buildCurrentRuntimeCatalogWitnessV10(metadata());
    expect(w.witnessVersion).toBe(10);
    expect(w.profile.profileVersion).toBe(10);
    expect(w.profile.runtimeStep).toBe(26);
    expect(w.profile.sourceDdlTip).toBe(146);
    expect(w.profile.parentMembers).toHaveLength(32);
    expect(w.profile.parentMembers.at(-1)).toMatchObject({ step: 32, sourceDdlId: 142 });
    expect(w.profile.extensionMembers).toEqual([
      expect.objectContaining({ extensionStep: 1, sourceDdlId: 146 }),
    ]);
    expect(w.profile.runtimeSteps.at(-1)).toMatchObject({ step: 26, sourceDdlId: 146 });
    expect(w.profile.runtimeSteps.at(-2)).toMatchObject({ step: 25, sourceDdlId: 142 });
    expect(w.rpcRecipe).toMatchObject({
      recipeVersion: 10,
      name: 'current-runtime-grants-v10',
      rootCount: 42,
    });
    expect(w.rpcRecipe.signatures).toEqual(currentRuntimeV10RpcSignatures);
    expect(w.rpcRecipe.signatures).toEqual(currentRuntimeV9RpcSignatures);
    expect(w.rpcRecipe.signatures).not.toContain(currentRuntimeV10GuardFunctionSignature);
    expect(w.supported).toBe(false);
    expect(w.processingAuthority).toBe('none');
    expect(parseCurrentRuntimeCatalogWitnessV10(w)).toEqual(w);
    for (const patch of [
      { supported: true },
      { witnessVersion: 9 },
      { profile: { ...w.profile, sourceDdlTip: 142 } },
      { profile: { ...w.profile, runtimeStep: 25 } },
      { profile: { ...w.profile, profileVersion: 9 } },
      { rpcRecipe: { ...w.rpcRecipe, rootCount: 41 } },
      { rpcRecipe: { ...w.rpcRecipe, recipeVersion: 9 } },
      { unknown: true },
      { closure: { ...w.closure, effectiveRecipe: 'verified' } },
    ])
      expect(() => parseCurrentRuntimeCatalogWitnessV10({ ...w, ...patch })).toThrow();
  });
  it('keeps the V9 metadata body and digest; only version/profile/recipe fields differ', () => {
    const v9 = buildCurrentRuntimeCatalogWitnessV9(metadata());
    const v10 = buildCurrentRuntimeCatalogWitnessV10(metadata());
    expect(v10.metadata).toEqual(v9.metadata);
    expect(v10.sections).toEqual(v9.sections);
    expect(v10.catalogSha256).toBe(v9.catalogSha256);
    expect(() => parseCurrentRuntimeCatalogWitnessV10(v9)).toThrow();
  });
  it('pins the exact grants-v10 source file', () => {
    const source = readFileSync(new URL('../src/current-runtime-grants-v10.ts', import.meta.url));
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      buildCurrentRuntimeCatalogWitnessV10(metadata()).rpcRecipe.grantSourceSha256,
    );
  });
  it('transfers one gated whole body after verifyV10/roots42/helpers17/guard1', async () => {
    const tx = mockTx();
    const w = await captureCurrentRuntimeCatalogWitnessV10In(tx, 'runtime');
    expect(verifyCurrentRuntimeV10InstalledIn).toHaveBeenCalled();
    expect(tx.transfers).toBe(1);
    expect(w.observation.expectedRootCount).toBe(42);
    expect(w.witnessVersion).toBe(10);
    expect(w.profile.runtimeStep).toBe(26);
    expect(w.profile.sourceDdlTip).toBe(146);
    expect(parseCurrentRuntimeCatalogWitnessV10(w)).toEqual(w);
    expect(w.supported).toBe(false);
  });
  it('fails closed before any catalog transfer when verifyV10 refuses', async () => {
    vi.mocked(verifyCurrentRuntimeV10InstalledIn).mockRejectedValueOnce(
      new Error('CURRENT_RUNTIME_V10_FUNCTION_DRIFT'),
    );
    const tx = mockTx();
    await expect(captureCurrentRuntimeCatalogWitnessV10In(tx, 'runtime')).rejects.toThrow(
      'CURRENT_RUNTIME_V10_FUNCTION_DRIFT',
    );
    expect(tx.transfers).toBe(0);
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
    await expect(captureCurrentRuntimeCatalogWitnessV10In(tx, 'runtime')).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
    expect(tx.transfers).toBe(0);
  });
  it.each([
    'runtime_denied',
    'delegation_safe',
    'owned',
    'source_sha256',
    'security_definer',
    'configuration',
    'result_type',
    'missing',
  ] as const)('rejects 146 guard %s drift before body', async (field) => {
    const rows = triggers();
    const row = rows[0];
    if (!row) throw Error('FIXTURE');
    if (field === 'missing') rows.pop();
    else if (field === 'source_sha256') row[field] = 'a'.repeat(64);
    else if (field === 'security_definer') row[field] = true;
    else if (field === 'configuration') row[field] = ['search_path=public'];
    else if (field === 'result_type') row[field] = 'void';
    else row[field] = false;
    const tx = mockTx({ triggers: rows });
    await expect(captureCurrentRuntimeCatalogWitnessV10In(tx, 'runtime')).rejects.toThrow(
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
      await expect(captureCurrentRuntimeCatalogWitnessV10In(tx, 'runtime')).rejects.toThrow(
        'CATALOG_WITNESS_INVALID',
      );
      expect(tx.transfers).toBe(0);
    },
  );
  it.each(['owner', 'runtime', 'privateHelper', 'locksHeld', 'readOnly', 'pathSafe'] as const)(
    'rejects context %s',
    async (field) => {
      const tx = mockTx({ context: { ...context, [field]: false } });
      await expect(captureCurrentRuntimeCatalogWitnessV10In(tx, 'runtime')).rejects.toThrow(
        'CATALOG_WITNESS_CONTEXT_REQUIRED',
      );
      expect(tx.transfers).toBe(0);
    },
  );
  it('keeps underreport/limit/unknown boundary rejects', async () => {
    for (const bytes of ['1', '16777217'])
      await expect(
        captureCurrentRuntimeCatalogWitnessV10In(mockTx({ bytes }), 'runtime'),
      ).rejects.toThrow();
    let calls = 0;
    await expect(
      captureCurrentRuntimeCatalogWitnessV10In(
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
    expect(() => buildCurrentRuntimeCatalogWitnessV10(raw)).toThrow();
    expect(getter).toBe(0);
  });
});
