import { beforeEach, expect, it, vi } from 'vitest';
import {
  currentRuntimeRpcSignatures,
  currentRuntimeRpcSourcePins,
  grantCurrentRuntimeProfileIn,
} from '../src/current-runtime-grants.js';
import { verifyCurrentRuntimeInstalledIn } from '../src/current-runtime-installation.js';
vi.mock('../src/current-runtime-installation.js', () => ({
  verifyCurrentRuntimeInstalledIn: vi.fn(),
}));
const verify = vi.mocked(verifyCurrentRuntimeInstalledIn);
const profile = {
  profileVersion: 1,
  baselineSchemaVersion: 107,
  runtimeStep: 17,
  sourceDdlTip: 127,
  appliedMembers: [],
  excludedTargetTransforms: [117, 119, 125],
  catalogSecurity: 'not_verified',
  restore: 'not_verified',
} as const;
function rpcRows() {
  return currentRuntimeRpcSourcePins.map((pin, index) => ({
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
it('grants exactly26 static application functions after the ledger verifier and safety checks', async () => {
  const tx = fixture();
  const result = await grantCurrentRuntimeProfileIn(tx, 'runtime_app');
  expect(verify).toHaveBeenCalledOnce();
  expect(tx.calls.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(
    tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT')).map((call) => call[0]),
  ).toEqual(
    currentRuntimeRpcSignatures.map(
      (signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO "runtime_app"`,
    ),
  );
  expect(result).toMatchObject({
    runtimeRole: 'runtime_app',
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(new Set(currentRuntimeRpcSignatures).size).toBe(26);
});
it.each(['public; DROP ROLE owner', 'Owner', 'a'.repeat(64), '', 'a"'])(
  'rejects unsafe role syntax %s before queries',
  async (role) => {
    const tx = fixture();
    await expect(grantCurrentRuntimeProfileIn(tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_INVALID_ROLE',
    );
    expect(tx.calls).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);
it('propagates normal107 or raw-without-ledger verifier denial before ACL mutation', async () => {
  verify.mockRejectedValue(new Error('CURRENT_RUNTIME_LEDGER_INVALID'));
  const tx = fixture();
  await expect(grantCurrentRuntimeProfileIn(tx, 'runtime_app')).rejects.toThrow(
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
  await expect(grantCurrentRuntimeProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_UNSAFE_ROLE',
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
  else if (field === 'signature') row[field] = currentRuntimeRpcSignatures[1];
  else if (field === 'result_type') row[field] = 'jsonb';
  else if (field === 'source_sha256') row[field] = '0'.repeat(64);
  else if (field === 'volatility') row[field] = 'i';
  else if (field === 'extra') row.extra = true;
  else rows.pop();
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_RPC_INVALID',
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
  await expect(grantCurrentRuntimeProfileIn(tx, 'runtime_app')).rejects.toThrow('ACL failure');
  expect(tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT'))).toHaveLength(1);
});
