import { beforeEach, expect, it, vi } from 'vitest';
import { currentRuntimeRpcSourcePins } from '../src/current-runtime-grants.js';
import {
  currentRuntimeV2RpcSignatures,
  currentRuntimeV2RpcSourcePins,
  grantCurrentRuntimeV2ProfileIn,
} from '../src/current-runtime-grants-v2.js';
import {
  currentRuntimeV2ParentManifestSha256,
  currentRuntimeV2ExtensionMember,
  verifyCurrentRuntimeV2InstalledIn,
} from '../src/current-runtime-installation-v2.js';
vi.mock(import('../src/current-runtime-installation-v2.js'), async (original) => ({
  ...(await original()),
  verifyCurrentRuntimeV2InstalledIn: vi.fn(),
}));
const verify = vi.mocked(verifyCurrentRuntimeV2InstalledIn);
const profile = {
  profileVersion: 2,
  baselineSchemaVersion: 107,
  parentRuntimeStep: 17,
  extensionStep: 1,
  runtimeStep: 18,
  sourceDdlTip: 128,
  parentManifestSha256: currentRuntimeV2ParentManifestSha256,
  extensionReceipt: {
    ...currentRuntimeV2ExtensionMember,
    parentManifestSha256: currentRuntimeV2ParentManifestSha256,
  },
  parentAppliedMembers: [],
  extensionMember: currentRuntimeV2ExtensionMember,
  excludedTargetTransforms: [117, 119, 125],
  catalogSecurity: 'not_verified',
  supported: false,
  processingAuthority: 'none',
  restore: 'not_verified',
} as const;
function rpcRows() {
  return currentRuntimeV2RpcSourcePins.map((pin, index) => ({
    ordinal: index + 1,
    signature: pin.signature,
    owned: true,
    language: pin.language,
    result_type: pin.result_type,
    security_definer: pin.security_definer,
    volatility: pin.volatility,
    source_sha256: pin.prosrcSha256,
    public_execute: false,
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
it('grants exactly28 static application functions after the ledger verifier and safety checks', async () => {
  const tx = fixture();
  const result = await grantCurrentRuntimeV2ProfileIn(tx, 'runtime_app');
  expect(verify).toHaveBeenCalledOnce();
  expect(tx.calls.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(
    tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT')).map((call) => call[0]),
  ).toEqual(
    currentRuntimeV2RpcSignatures.map(
      (signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO "runtime_app"`,
    ),
  );
  expect(result).toMatchObject({
    runtimeRole: 'runtime_app',
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(new Set(currentRuntimeV2RpcSignatures).size).toBe(28);
});
it.each(['public; DROP ROLE owner', 'Owner', 'a'.repeat(64), '', 'a"'])(
  'rejects unsafe role syntax %s before queries',
  async (role) => {
    const tx = fixture();
    await expect(grantCurrentRuntimeV2ProfileIn(tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_V2_INVALID_ROLE',
    );
    expect(tx.calls).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);
it('propagates normal107 or raw-without-ledger verifier denial before ACL mutation', async () => {
  verify.mockRejectedValue(new Error('CURRENT_RUNTIME_LEDGER_INVALID'));
  const tx = fixture();
  await expect(grantCurrentRuntimeV2ProfileIn(tx, 'runtime_app')).rejects.toThrow(
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
  await expect(grantCurrentRuntimeV2ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V2_UNSAFE_ROLE',
  );
  expect(tx.calls.mock.calls.some((call) => call[0].startsWith('GRANT'))).toBe(false);
});
it.each([
  'owned',
  'public_execute',
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
  else if (field === 'security_definer') row[field] = false;
  else if (field === 'configuration') row[field] = ['search_path=public, pg_temp'];
  else if (field === 'ordinal') row[field] = 2;
  else if (field === 'signature') row[field] = currentRuntimeV2RpcSignatures[1];
  else if (field === 'result_type') row[field] = 'jsonb';
  else if (field === 'source_sha256') row[field] = '0'.repeat(64);
  else if (field === 'volatility') row[field] = 'i';
  else if (field === 'extra') row.extra = true;
  else rows.pop();
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV2ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V2_RPC_INVALID',
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
  await expect(grantCurrentRuntimeV2ProfileIn(tx, 'runtime_app')).rejects.toThrow('ACL failure');
  expect(tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT'))).toHaveLength(1);
});

it('preserves the original26 pins and compiles only the actual two128 roots', () => {
  expect(currentRuntimeV2RpcSourcePins.slice(0, 26)).toEqual(currentRuntimeRpcSourcePins);
  expect(currentRuntimeV2RpcSignatures.slice(-2)).toEqual([
    'public.read_check_in_template_personal_export_v1(integer)',
    'public.read_race_manual_personal_export_v1(integer)',
  ]);
  expect(currentRuntimeV2RpcSourcePins.every(Object.isFrozen)).toBe(true);
});
it('denies drift in the last new root before granting any earlier root', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const last = rows.at(-1);
  if (!last) throw new Error('fixture');
  last.source_sha256 = '0'.repeat(64);
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV2ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V2_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some((c) => c[0].startsWith('GRANT'))).toBe(false);
});
