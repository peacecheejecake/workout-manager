import { beforeEach, expect, it, vi } from 'vitest';
import { currentRuntimeV2RpcSourcePins } from '../src/current-runtime-grants-v2.js';
import {
  currentRuntimeV3RpcSignatures,
  currentRuntimeV3RpcSourcePins,
  grantCurrentRuntimeV3ProfileIn,
} from '../src/current-runtime-grants-v3.js';
import {
  currentRuntimeV3ParentManifestSha256,
  currentRuntimeV3ExtensionMember,
  verifyCurrentRuntimeV3InstalledIn,
} from '../src/current-runtime-installation-v3.js';
vi.mock(import('../src/current-runtime-installation-v3.js'), async (original) => ({
  ...(await original()),
  verifyCurrentRuntimeV3InstalledIn: vi.fn(),
}));
const verify = vi.mocked(verifyCurrentRuntimeV3InstalledIn);
const profile = {
  profileVersion: 3,
  baselineSchemaVersion: 107,
  parentRuntimeStep: 18,
  extensionStep: 1,
  runtimeStep: 19,
  sourceDdlTip: 129,
  parentManifestSha256: currentRuntimeV3ParentManifestSha256,
  extensionReceipt: {
    ...currentRuntimeV3ExtensionMember,
    parentManifestSha256: currentRuntimeV3ParentManifestSha256,
  },
  parentAppliedMembers: [],
  extensionMember: currentRuntimeV3ExtensionMember,
  excludedTargetTransforms: [117, 119, 125],
  catalogSecurity: 'not_verified',
  supported: false,
  processingAuthority: 'none',
  restore: 'not_verified',
} as const;
function rpcRows() {
  return currentRuntimeV3RpcSourcePins.map((pin, index) => ({
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
it('grants exactly29 static application functions after the ledger verifier and safety checks', async () => {
  const tx = fixture();
  const result = await grantCurrentRuntimeV3ProfileIn(tx, 'runtime_app');
  expect(verify).toHaveBeenCalledOnce();
  expect(tx.calls.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(
    tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT')).map((call) => call[0]),
  ).toEqual(
    currentRuntimeV3RpcSignatures.map(
      (signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO "runtime_app"`,
    ),
  );
  expect(result).toMatchObject({
    runtimeRole: 'runtime_app',
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(new Set(currentRuntimeV3RpcSignatures).size).toBe(29);
});
it.each(['public; DROP ROLE owner', 'Owner', 'a'.repeat(64), '', 'a"'])(
  'rejects unsafe role syntax %s before queries',
  async (role) => {
    const tx = fixture();
    await expect(grantCurrentRuntimeV3ProfileIn(tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_INVALID_ROLE',
    );
    expect(tx.calls).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);
it('propagates normal107 or raw-without-ledger verifier denial before ACL mutation', async () => {
  verify.mockRejectedValue(new Error('CURRENT_RUNTIME_LEDGER_INVALID'));
  const tx = fixture();
  await expect(grantCurrentRuntimeV3ProfileIn(tx, 'runtime_app')).rejects.toThrow(
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
  await expect(grantCurrentRuntimeV3ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V3_UNSAFE_ROLE',
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
  else if (field === 'signature') row[field] = currentRuntimeV3RpcSignatures[1];
  else if (field === 'result_type') row[field] = 'jsonb';
  else if (field === 'source_sha256') row[field] = '0'.repeat(64);
  else if (field === 'volatility') row[field] = 'i';
  else if (field === 'extra') row.extra = true;
  else rows.pop();
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV3ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V3_RPC_INVALID',
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
  await expect(grantCurrentRuntimeV3ProfileIn(tx, 'runtime_app')).rejects.toThrow('ACL failure');
  expect(tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT'))).toHaveLength(1);
});

it('preserves exactoriginal28 pins and only adds actual129 root', () => {
  expect(currentRuntimeV3RpcSourcePins.slice(0, 28)).toEqual(currentRuntimeV2RpcSourcePins);
  expect(currentRuntimeV3RpcSignatures.at(-1)).toBe(
    'public.read_manual_race_internal_personal_export_v1(integer)',
  );
  expect(currentRuntimeV3RpcSourcePins.every(Object.isFrozen)).toBe(true);
});
it('denies drift in the last new root before granting any earlier root', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const last = rows.at(-1);
  if (!last) throw new Error('fixture');
  last.source_sha256 = '0'.repeat(64);
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV3ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V3_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some((c) => c[0].startsWith('GRANT'))).toBe(false);
});
