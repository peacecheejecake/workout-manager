import { beforeEach, expect, it, vi } from 'vitest';
import { currentRuntimeV3RpcSourcePins } from '../src/current-runtime-grants-v3.js';
import {
  currentRuntimeV4RpcSignatures,
  currentRuntimeV4RpcSourcePins,
  grantCurrentRuntimeV4ProfileIn,
} from '../src/current-runtime-grants-v4.js';
import {
  currentRuntimeV4ParentManifestSha256,
  currentRuntimeV4ExtensionMember,
  verifyCurrentRuntimeV4InstalledIn,
} from '../src/current-runtime-installation-v4.js';
vi.mock(import('../src/current-runtime-installation-v4.js'), async (original) => ({
  ...(await original()),
  verifyCurrentRuntimeV4InstalledIn: vi.fn(),
}));
const verify = vi.mocked(verifyCurrentRuntimeV4InstalledIn);
const profile = {
  profileVersion: 4,
  baselineSchemaVersion: 107,
  parentRuntimeStep: 19,
  extensionStep: 1,
  runtimeStep: 20,
  sourceDdlTip: 130,
  parentManifestSha256: currentRuntimeV4ParentManifestSha256,
  extensionReceipt: {
    ...currentRuntimeV4ExtensionMember,
    parentManifestSha256: currentRuntimeV4ParentManifestSha256,
  },
  parentAppliedMembers: [],
  extensionMember: currentRuntimeV4ExtensionMember,
  excludedTargetTransforms: [117, 119, 125],
  catalogSecurity: 'not_verified',
  supported: false,
  processingAuthority: 'none',
  restore: 'not_verified',
} as const;
function rpcRows() {
  return currentRuntimeV4RpcSourcePins.map((pin, index) => ({
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
it('grants exactly31 static application functions after the ledger verifier and safety checks', async () => {
  const tx = fixture();
  const result = await grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app');
  expect(verify).toHaveBeenCalledOnce();
  expect(tx.calls.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(
    tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT')).map((call) => call[0]),
  ).toEqual(
    currentRuntimeV4RpcSignatures.map(
      (signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO "runtime_app"`,
    ),
  );
  expect(result).toMatchObject({
    runtimeRole: 'runtime_app',
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(new Set(currentRuntimeV4RpcSignatures).size).toBe(31);
});
it.each(['public; DROP ROLE owner', 'Owner', 'a'.repeat(64), '', 'a"'])(
  'rejects unsafe role syntax %s before queries',
  async (role) => {
    const tx = fixture();
    await expect(grantCurrentRuntimeV4ProfileIn(tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_V4_INVALID_ROLE',
    );
    expect(tx.calls).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);
it('propagates normal107 or raw-without-ledger verifier denial before ACL mutation', async () => {
  verify.mockRejectedValue(new Error('CURRENT_RUNTIME_LEDGER_INVALID'));
  const tx = fixture();
  await expect(grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app')).rejects.toThrow(
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
  await expect(grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V4_UNSAFE_ROLE',
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
  else if (field === 'signature') row[field] = currentRuntimeV4RpcSignatures[1];
  else if (field === 'result_type') row[field] = 'jsonb';
  else if (field === 'source_sha256') row[field] = '0'.repeat(64);
  else if (field === 'volatility') row[field] = 'i';
  else if (field === 'extra') row.extra = true;
  else rows.pop();
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V4_RPC_INVALID',
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
  await expect(grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app')).rejects.toThrow('ACL failure');
  expect(tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT'))).toHaveLength(1);
});

it('preserves exact original29 pins and adds only the actual two130 reader roots', () => {
  expect(currentRuntimeV4RpcSourcePins.slice(0, 29)).toEqual(currentRuntimeV3RpcSourcePins);
  expect(currentRuntimeV4RpcSignatures.at(-1)).toBe(
    'public.read_nutrition_disconnection_personal_export_v1(integer)',
  );
  expect(currentRuntimeV4RpcSourcePins.every(Object.isFrozen)).toBe(true);
});
it('denies drift in the last new root before granting any earlier root', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const last = rows.at(-1);
  if (!last) throw new Error('fixture');
  last.source_sha256 = '0'.repeat(64);
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V4_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some((c) => c[0].startsWith('GRANT'))).toBe(false);
});

it('never grants130 private helper or schema/table privileges', async () => {
  const tx = fixture();
  await grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app');
  const grants = tx.calls.mock.calls.filter(([sql]) => sql.startsWith('GRANT')).map(([sql]) => sql);
  expect(grants).toHaveLength(31);
  expect(grants.every((sql) => sql.startsWith('GRANT EXECUTE ON FUNCTION public.'))).toBe(true);
  expect(grants.some((sql) => sql.includes('manual_source_personal_row_exists_v1'))).toBe(false);
  const safety = tx.calls.mock.calls.find(([sql]) => sql.startsWith('SELECT\n    NOT'))?.[0];
  expect(safety).toContain(
    "NOT has_function_privilege(r.oid,'public.manual_source_personal_row_exists_v1(jsonb,jsonb)','EXECUTE')",
  );
  expect(safety).toContain("'wm_runtime_installation.profile_extension_v4'");
});

it('pins both130 roots to the independent exact metadata witness', () => {
  expect(
    currentRuntimeV4RpcSourcePins.slice(29).map((pin) => [pin.signature, pin.prosrcSha256]),
  ).toEqual([
    [
      'public.read_manual_race_source_personal_export_v1(integer)',
      'bb052b6eb730612f5b6cceb2dd333b4fec77be6740c800b006e7d4182463d924',
    ],
    [
      'public.read_nutrition_disconnection_personal_export_v1(integer)',
      '852f5eae05d62fe6ed706532e24e02fd2772055c0d647644cff38382103ccef1',
    ],
  ]);
});
it('rejects additional future metadata roots instead of widening the whitelist', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const first = rows[0];
  if (!first) throw Error('FIXTURE_REQUIRED');
  rows.push({ ...first, ordinal: 32, signature: 'public.future_rpc(jsonb)' });
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV4ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V4_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some(([sql]) => sql.startsWith('GRANT'))).toBe(false);
});
