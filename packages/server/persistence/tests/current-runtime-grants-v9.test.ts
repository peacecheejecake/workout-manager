import { beforeEach, expect, it, vi } from 'vitest';
import { currentRuntimeV8RpcSourcePins as parentPins } from '../src/current-runtime-grants-v8.js';
import { currentRuntimeV7RpcSourcePins as predecessorPins } from '../src/current-runtime-grants-v7.js';
import {
  currentRuntimeV9RpcSignatures,
  currentRuntimeV9RpcSourcePins,
  currentRuntimeV9PrivateHelpers,
  currentRuntimeV9OwnerOnlyPublicHelpers,
  grantCurrentRuntimeV9ProfileIn,
} from '../src/current-runtime-grants-v9.js';
import {
  currentRuntimeV9ParentManifestSha256,
  currentRuntimeV9ExtensionMembers,
  currentRuntimeV9ParentMembers,
  verifyCurrentRuntimeV9InstalledIn,
} from '../src/current-runtime-installation-v9.js';
vi.mock(import('../src/current-runtime-installation-v9.js'), async (original) => ({
  ...(await original()),
  verifyCurrentRuntimeV9InstalledIn: vi.fn(),
}));
const verify = vi.mocked(verifyCurrentRuntimeV9InstalledIn);
const profile = {
  profileVersion: 9,
  parentProfileVersion: 8,
  baselineSchemaVersion: 107,
  parentRuntimeStep: 24,
  extensionSteps: 1,
  runtimeStep: 25,
  sourceDdlTip: 142,
  parentManifestSha256: currentRuntimeV9ParentManifestSha256,
  parentAppliedMembers: currentRuntimeV9ParentMembers,
  extensionMembers: currentRuntimeV9ExtensionMembers,
  extensionReceipts: currentRuntimeV9ExtensionMembers.map((m) => ({
    ...m,
    parentManifestSha256:
      currentRuntimeV9ParentManifestSha256 as typeof currentRuntimeV9ParentManifestSha256,
  })),
  excludedTargetTransforms: [117, 119, 125],
  catalogSecurity: 'not_verified',
  supported: false,
  processingAuthority: 'none',
  restore: 'not_verified',
} as const;
function rpcRows() {
  return currentRuntimeV9RpcSourcePins.map((pin, index) => ({
    ordinal: index + 1,
    signature: pin.signature,
    owned: true,
    language: pin.language,
    result_type: pin.result_type,
    security_definer: pin.security_definer,
    volatility: pin.volatility,
    source_sha256: pin.prosrcSha256,
    public_execute: false,
    safe_delegation: true,
    configuration: [...pin.configuration],
  }));
}
function fixture(rows: unknown[] = rpcRows(), safe: unknown = { safe: true }) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith('SELECT\n    NOT')
      ? [safe]
      : sql.startsWith('SELECT i.ordinal')
        ? rows
        : [],
    rowCount: null,
  }));
  // The mock boundary is intentionally unknown; invalid observations exercise
  // runtime validation rather than a fabricated typed authority.
  return {
    query: async (sql: string, values?: unknown[]) => {
      void values;
      const result = await query(sql);
      return { rows: result.rows.map((row) => Object.assign({}, row)), rowCount: result.rowCount };
    },
    calls: query,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  verify.mockResolvedValue(profile);
});
it('grants exactly42 static application functions after the ledger verifier and safety checks', async () => {
  const tx = fixture();
  const result = await grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app');
  expect(verify).toHaveBeenCalledOnce();
  expect(tx.calls.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(
    tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT')).map((call) => call[0]),
  ).toEqual(
    currentRuntimeV9RpcSignatures.map(
      (signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO "runtime_app"`,
    ),
  );
  expect(result).toMatchObject({
    runtimeRole: 'runtime_app',
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(new Set(currentRuntimeV9RpcSignatures).size).toBe(42);
});
it.each(['public; DROP ROLE owner', 'Owner', 'a'.repeat(64), '', 'a"'])(
  'rejects unsafe role syntax %s before queries',
  async (role) => {
    const tx = fixture();
    await expect(grantCurrentRuntimeV9ProfileIn(tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_V9_INVALID_ROLE',
    );
    expect(tx.calls).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);
it('propagates normal107 or raw-without-ledger verifier denial before ACL mutation', async () => {
  verify.mockRejectedValue(new Error('CURRENT_RUNTIME_LEDGER_INVALID'));
  const tx = fixture();
  await expect(grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_LEDGER_INVALID',
  );
  expect(tx.calls.mock.calls.some((call) => call[0].startsWith('GRANT'))).toBe(false);
});
it.each([
  { observation: null },
  { observation: { safe: false } },
  { observation: { safe: true, unexpected: true } },
])('rejects missing/elevated/unknown role observations', async ({ observation }) => {
  const tx = fixture(rpcRows(), observation);
  await expect(grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V9_UNSAFE_ROLE',
  );
  expect(tx.calls.mock.calls.some((call) => call[0].startsWith('GRANT'))).toBe(false);
});
it.each([
  'owned',
  'public_execute',
  'safe_delegation',
  'security_definer',
  'configuration',
  'ordinal',
  'signature',
  'result_type',
  'source_sha256',
  'volatility',
  'extra',
  'missing',
] as const)('rejects RPC catalog drift %s before any grants', async (field) => {
  const rows: Record<string, unknown>[] = rpcRows();
  const row = rows[0];
  if (!row) throw new Error('fixture');
  if (field === 'owned') row[field] = false;
  else if (field === 'public_execute') row[field] = true;
  else if (field === 'safe_delegation') row[field] = false;
  else if (field === 'security_definer') row[field] = false;
  else if (field === 'configuration') row[field] = ['search_path=public, pg_temp'];
  else if (field === 'ordinal') row[field] = 2;
  else if (field === 'signature') row[field] = currentRuntimeV9RpcSignatures[1];
  else if (field === 'result_type') row[field] = 'jsonb';
  else if (field === 'source_sha256') row[field] = '0'.repeat(64);
  else if (field === 'volatility') row[field] = 'i';
  else if (field === 'extra') row.extra = true;
  else rows.pop();
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V9_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some((call) => call[0].startsWith('GRANT'))).toBe(false);
});
it('propagates grant failure for the enclosing transaction to roll back, without continuing', async () => {
  const tx = fixture();
  tx.calls.mockImplementation(async (sql) => {
    if (sql.startsWith('GRANT')) throw new Error('ACL failure');
    return {
      rows: sql.startsWith('SELECT\n    NOT')
        ? [{ safe: true }]
        : sql.startsWith('SELECT i.ordinal')
          ? rpcRows()
          : [],
      rowCount: null,
    };
  });
  await expect(grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app')).rejects.toThrow('ACL failure');
  expect(tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT'))).toHaveLength(1);
});

it('preserves old33 exact pins and adds only the nine named pooled RPCs', () => {
  expect(currentRuntimeV9RpcSourcePins.slice(0, 33)).toEqual(predecessorPins);
  expect(currentRuntimeV9RpcSourcePins.slice(33)).toHaveLength(9);
  expect(currentRuntimeV9RpcSourcePins.every(Object.isFrozen)).toBe(true);
});
it('denies drift in the last new root before granting any earlier root', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const last = rows.at(-1);
  if (!last) throw new Error('fixture');
  last.source_sha256 = '0'.repeat(64);
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V9_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some((c) => c[0].startsWith('GRANT'))).toBe(false);
});

it('never grants130 private helper or schema/table privileges', async () => {
  const tx = fixture();
  await grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app');
  const grants = tx.calls.mock.calls.filter(([sql]) => sql.startsWith('GRANT')).map(([sql]) => sql);
  expect(grants).toHaveLength(42);
  expect(grants.every((sql) => sql.startsWith('GRANT EXECUTE ON FUNCTION public.'))).toBe(true);
  expect(grants.some((sql) => sql.includes('manual_source_personal_row_exists_v1'))).toBe(false);
  const safety = tx.calls.mock.calls.find(([sql]) => sql.startsWith('SELECT\n    NOT'))?.[0];
  expect(safety).toContain(
    "NOT has_function_privilege(r.oid,'public.manual_source_personal_row_exists_v1(jsonb,jsonb)','EXECUTE')",
  );
  for (const name of [
    'migration',
    'profile_extension_v2',
    'profile_extension_v3',
    'profile_extension_v4',
    'profile_extension_v5',
    'profile_extension_v6',
    'profile_extension_v7',
    'profile_extension_v8',
    'profile_extension_v9',
  ])
    expect(safety).toContain(`'wm_runtime_installation.${name}'`);
});

it('rejects additional future metadata roots instead of widening the whitelist', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const first = rows[0];
  if (!first) throw Error('FIXTURE_REQUIRED');
  rows.push({ ...first, ordinal: 43, signature: 'public.future_rpc(jsonb)' });
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V9_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some(([sql]) => sql.startsWith('GRANT'))).toBe(false);
});

it('rejects the old commit body despite otherwise correct observed33 metadata', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const index = currentRuntimeV9RpcSignatures.indexOf(
    'public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)',
  );
  const row = rows[index];
  if (!row) throw Error('COMMIT_REQUIRED');
  row.source_sha256 = 'bb5eca0bd23f90cdf1ea082e229e95188b808ce1ff01a9c34c63cfaa72f257bd';
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV9ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V9_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some(([sql]) => sql.startsWith('GRANT'))).toBe(false);
});

it('preserves exact end141 41 root prefix and adds only the actually observed142 reader', () => {
  expect(currentRuntimeV9RpcSourcePins.slice(0, 41)).toEqual(parentPins);
  expect(currentRuntimeV9RpcSourcePins[41]).toEqual({
    signature: 'public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)',
    prosrcSha256: 'e8e2bec33d0b7b828804d6162ef897de93f087c24afd72215836719da3f927cb',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
  });
  expect(currentRuntimeV9OwnerOnlyPublicHelpers).toHaveLength(4);
  expect(currentRuntimeV9PrivateHelpers).toHaveLength(13);
  expect(currentRuntimeV9PrivateHelpers.at(-1)).toBe(
    'wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)',
  );
});
