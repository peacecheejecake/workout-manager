import { beforeEach, expect, it, vi } from 'vitest';
import {
  currentRuntimeV9RpcSourcePins as parentPins,
  currentRuntimeV9OwnerOnlyPublicHelpers,
  currentRuntimeV9PrivateHelpers,
} from '../src/current-runtime-grants-v9.js';
import { currentRuntimeV7RpcSourcePins as predecessorPins } from '../src/current-runtime-grants-v7.js';
import {
  currentRuntimeV10RpcSignatures,
  currentRuntimeV10RpcSourcePins,
  currentRuntimeV10PrivateHelpers,
  currentRuntimeV10OwnerOnlyPublicHelpers,
  currentRuntimeV10TriggerFunctions,
  grantCurrentRuntimeV10ProfileIn,
} from '../src/current-runtime-grants-v10.js';
import {
  currentRuntimeV10ParentManifestSha256,
  currentRuntimeV10ExtensionMembers,
  currentRuntimeV10ParentMembers,
  verifyCurrentRuntimeV10InstalledIn,
} from '../src/current-runtime-installation-v10.js';
vi.mock(import('../src/current-runtime-installation-v10.js'), async (original) => ({
  ...(await original()),
  verifyCurrentRuntimeV10InstalledIn: vi.fn(),
}));
const verify = vi.mocked(verifyCurrentRuntimeV10InstalledIn);
const profile = {
  profileVersion: 10,
  parentProfileVersion: 9,
  baselineSchemaVersion: 107,
  parentRuntimeStep: 25,
  extensionSteps: 1,
  runtimeStep: 26,
  sourceDdlTip: 146,
  parentManifestSha256: currentRuntimeV10ParentManifestSha256,
  parentAppliedMembers: currentRuntimeV10ParentMembers,
  extensionMembers: currentRuntimeV10ExtensionMembers,
  extensionReceipts: currentRuntimeV10ExtensionMembers.map((m) => ({
    ...m,
    parentManifestSha256:
      currentRuntimeV10ParentManifestSha256 as typeof currentRuntimeV10ParentManifestSha256,
  })),
  excludedTargetTransforms: [117, 119, 125],
  catalogSecurity: 'not_verified',
  supported: false,
  processingAuthority: 'none',
  restore: 'not_verified',
} as const;
function rpcRows() {
  return currentRuntimeV10RpcSourcePins.map((pin, index) => ({
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
  const result = await grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app');
  expect(verify).toHaveBeenCalledOnce();
  expect(tx.calls.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(
    tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT')).map((call) => call[0]),
  ).toEqual(
    currentRuntimeV10RpcSignatures.map(
      (signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO "runtime_app"`,
    ),
  );
  expect(result).toMatchObject({
    runtimeRole: 'runtime_app',
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(new Set(currentRuntimeV10RpcSignatures).size).toBe(42);
});
it.each(['public; DROP ROLE owner', 'Owner', 'a'.repeat(64), '', 'a"'])(
  'rejects unsafe role syntax %s before queries',
  async (role) => {
    const tx = fixture();
    await expect(grantCurrentRuntimeV10ProfileIn(tx, role)).rejects.toThrow(
      'CURRENT_RUNTIME_V10_INVALID_ROLE',
    );
    expect(tx.calls).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);
it('propagates normal107 or raw-without-ledger verifier denial before ACL mutation', async () => {
  verify.mockRejectedValue(new Error('CURRENT_RUNTIME_LEDGER_INVALID'));
  const tx = fixture();
  await expect(grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app')).rejects.toThrow(
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
  await expect(grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V10_UNSAFE_ROLE',
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
  else if (field === 'signature') row[field] = currentRuntimeV10RpcSignatures[1];
  else if (field === 'result_type') row[field] = 'jsonb';
  else if (field === 'source_sha256') row[field] = '0'.repeat(64);
  else if (field === 'volatility') row[field] = 'i';
  else if (field === 'extra') row.extra = true;
  else rows.pop();
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V10_RPC_INVALID',
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
  await expect(grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app')).rejects.toThrow('ACL failure');
  expect(tx.calls.mock.calls.filter((call) => call[0].startsWith('GRANT'))).toHaveLength(1);
});

it('preserves old33 exact pins and adds only the nine named pooled RPCs', () => {
  expect(currentRuntimeV10RpcSourcePins.slice(0, 33)).toEqual(predecessorPins);
  expect(currentRuntimeV10RpcSourcePins.slice(33)).toHaveLength(9);
  expect(currentRuntimeV10RpcSourcePins.every(Object.isFrozen)).toBe(true);
});
it('denies drift in the last new root before granting any earlier root', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const last = rows.at(-1);
  if (!last) throw new Error('fixture');
  last.source_sha256 = '0'.repeat(64);
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V10_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some((c) => c[0].startsWith('GRANT'))).toBe(false);
});

it('never grants130 private helper or schema/table privileges', async () => {
  const tx = fixture();
  await grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app');
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
    'profile_extension_v10',
  ])
    expect(safety).toContain(`'wm_runtime_installation.${name}'`);
});

it('rejects additional future metadata roots instead of widening the whitelist', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const first = rows[0];
  if (!first) throw Error('FIXTURE_REQUIRED');
  rows.push({ ...first, ordinal: 43, signature: 'public.future_rpc(jsonb)' });
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V10_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some(([sql]) => sql.startsWith('GRANT'))).toBe(false);
});

it('rejects the old commit body despite otherwise correct observed33 metadata', async () => {
  const rows: Record<string, unknown>[] = rpcRows();
  const index = currentRuntimeV10RpcSignatures.indexOf(
    'public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)',
  );
  const row = rows[index];
  if (!row) throw Error('COMMIT_REQUIRED');
  row.source_sha256 = 'bb5eca0bd23f90cdf1ea082e229e95188b808ce1ff01a9c34c63cfaa72f257bd';
  const tx = fixture(rows);
  await expect(grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app')).rejects.toThrow(
    'CURRENT_RUNTIME_V10_RPC_INVALID',
  );
  expect(tx.calls.mock.calls.some(([sql]) => sql.startsWith('GRANT'))).toBe(false);
});

it('keeps the exact post142 42 roots and 17 helpers; the 146 guard is neither root nor grant', async () => {
  expect(currentRuntimeV10RpcSourcePins).toEqual(parentPins);
  expect(currentRuntimeV10OwnerOnlyPublicHelpers).toEqual(currentRuntimeV9OwnerOnlyPublicHelpers);
  expect(currentRuntimeV10PrivateHelpers).toEqual(currentRuntimeV9PrivateHelpers);
  expect(currentRuntimeV10TriggerFunctions).toEqual([
    'public.guard_race_event_local_date_approval_v1()',
  ]);
  expect(currentRuntimeV10RpcSignatures).not.toContain(
    'public.guard_race_event_local_date_approval_v1()',
  );
  const tx = fixture();
  await grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app');
  expect(
    tx.calls.mock.calls.some(([sql]) => sql.includes('guard_race_event_local_date_approval_v1')),
  ).toBe(false);
});
it('passes the guard as an unexecutable function and the v10 ledger roster to the role check', async () => {
  const seen: unknown[][] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT\n    NOT')) {
        seen.push(values ?? []);
        return { rows: [{ safe: true }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT i.ordinal')) return { rows: rpcRows(), rowCount: 42 };
      return { rows: [], rowCount: 0 };
    },
  };
  await grantCurrentRuntimeV10ProfileIn(tx, 'runtime_app');
  expect(seen).toHaveLength(1);
  expect(seen[0]?.[1]).toEqual([
    ...currentRuntimeV10OwnerOnlyPublicHelpers,
    ...currentRuntimeV10PrivateHelpers,
    'public.guard_race_event_local_date_approval_v1()',
  ]);
  expect(seen[0]?.[2]).toEqual([
    'migration',
    ...Array.from({ length: 9 }, (_, i) => `profile_extension_v${i + 2}`),
  ]);
});
