import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type * as Parent from '../src/current-runtime-installation-v6.js';
import { currentRuntimeMigrationMembers } from '../src/current-runtime-installation.js';
import { currentRuntimeV2ExtensionMember } from '../src/current-runtime-installation-v2.js';
import { currentRuntimeV3ExtensionMember } from '../src/current-runtime-installation-v3.js';
import { currentRuntimeV4ExtensionMember } from '../src/current-runtime-installation-v4.js';
import { currentRuntimeV5ExtensionMember } from '../src/current-runtime-installation-v5.js';
import {
  currentRuntimeV6ExtensionMember,
  installCurrentRuntimeV6In,
  verifyCurrentRuntimeV6InstalledIn,
} from '../src/current-runtime-installation-v6.js';
import {
  currentRuntimeV7ExtensionMember,
  currentRuntimeV7ParentManifestSha256,
  currentRuntimeV7FunctionTransitions,
  installCurrentRuntimeV7In,
  verifyCurrentRuntimeV7InstalledIn,
} from '../src/current-runtime-installation-v7.js';
vi.mock('../src/current-runtime-installation-v6.js', async (original) => ({
  ...(await original<typeof Parent>()),
  installCurrentRuntimeV6In: vi.fn(async () => undefined),
  verifyCurrentRuntimeV6InstalledIn: vi.fn(async () => undefined),
}));
beforeEach(() => vi.clearAllMocks());
function port() {
  const functions = currentRuntimeV7FunctionTransitions.map((f) => ({
    signature: f.signature,
    owner: true,
    language: 'plpgsql',
    resultType: f.resultType,
    definer: f.definer,
    volatility: 'v',
    parallel: 'u',
    strict: false,
    setReturning: false,
    configuration: [...f.configuration],
    privatePublic: true,
    safeDelegation: true,
    bodySha256: String(f.predecessorSha256),
    metadataSha256: 'a'.repeat(64),
  }));
  const state = {
    ledger: false,
    rows: [] as Record<string, unknown>[],
    functions,
    catalog: { owner: true, private: true, columns: true, constraints: true, shape: true },
    metadataChange: false,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT to_regclass'))
      return { rows: [{ ledger: state.ledger }], rowCount: 1 };
    if (sql.startsWith('SELECT requested.signature'))
      return { rows: state.functions.map((row) => ({ ...row })), rowCount: state.functions.length };
    if (sql.startsWith('SELECT\n current_user')) return { rows: [state.catalog], rowCount: 1 };
    if (sql.startsWith('SELECT extension_step'))
      return { rows: state.rows, rowCount: state.rows.length };
    if (sql.startsWith('CREATE TABLE wm_runtime_installation.profile_extension_v7'))
      state.ledger = true;
    if (sql.startsWith('-- Exact SQL118 nutrition V4 successor'))
      state.functions = state.functions.map((row, index) => ({
        ...row,
        bodySha256: currentRuntimeV7FunctionTransitions[index]?.successorSha256 ?? '',
        metadataSha256: state.metadataChange ? 'b'.repeat(64) : row.metadataSha256,
      }));
    if (sql.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v7'))
      state.rows = [
        {
          extensionStep: 1,
          sourceDdlId: 133,
          filename: currentRuntimeV7ExtensionMember.filename,
          sha256: currentRuntimeV7ExtensionMember.sha256,
          parentManifestSha256: currentRuntimeV7ParentManifestSha256,
        },
      ];
    return { rows: [], rowCount: 0 };
  });
  return { state, query };
}
it('independently derives exact parent22 canonical tuples and fixed source133 bytes', async () => {
  const members = [
    ...currentRuntimeMigrationMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
    ...[
      currentRuntimeV2ExtensionMember,
      currentRuntimeV3ExtensionMember,
      currentRuntimeV4ExtensionMember,
      currentRuntimeV5ExtensionMember,
      currentRuntimeV6ExtensionMember,
    ].map((m, i) => [18 + i, m.sourceDdlId, m.filename, m.sha256]),
  ];
  expect(members).toHaveLength(22);
  const canonical = JSON.stringify({
    encoding: 'current-runtime-profile-v6-parent-manifest-v1',
    profileVersion: 6,
    baselineSchemaVersion: 107,
    runtimeStep: 22,
    members,
  });
  expect(createHash('sha256').update(canonical).digest('hex')).toBe(
    currentRuntimeV7ParentManifestSha256,
  );
  const sql = await readFile(
    new URL('../migrations/133_nutrition_v4_indexed_application.sql', import.meta.url),
    'utf8',
  );
  expect(createHash('sha256').update(sql).digest('hex')).toBe(
    currentRuntimeV7ExtensionMember.sha256,
  );
  for (const f of currentRuntimeV7FunctionTransitions) expect(sql).toContain(f.successorSha256);
});
it('checks predecessor/metadata before extension and successor/fullmetadata before receipt', async () => {
  const p = port();
  const result = await installCurrentRuntimeV7In(p);
  expect(installCurrentRuntimeV6In).toHaveBeenCalledWith(p);
  expect(verifyCurrentRuntimeV6InstalledIn).toHaveBeenCalledWith(p);
  expect(p.query.mock.calls.slice(0, 2).map((c) => c[0])).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(result).toMatchObject({
    profileVersion: 7,
    parentRuntimeStep: 22,
    runtimeStep: 23,
    sourceDdlTip: 133,
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(result.parentAppliedMembers).toHaveLength(22);
  const calls = p.query.mock.calls.map((c) => c[0]);
  expect(calls.filter((s) => s.startsWith('SELECT requested.signature'))).toHaveLength(3);
  expect(calls.findIndex((s) => s.startsWith('SELECT requested.signature'))).toBeLessThan(
    calls.findIndex((s) => s.startsWith('CREATE TABLE')),
  );
  expect(calls.findIndex((s) => s.startsWith('INSERT '))).toBeGreaterThan(
    calls.findIndex((s) => s.startsWith('-- Exact SQL118')),
  );
  expect(
    calls.some((s) => /UPDATE .*profile_extension|ALTER TABLE|schema_migrations.*INSERT/.test(s)),
  ).toBe(false);
});
it('replays immutable exact23 receipt without DDL or adopting the old22 body', async () => {
  const p = port();
  const first = await installCurrentRuntimeV7In(p);
  p.query.mockClear();
  expect(await installCurrentRuntimeV7In(p)).toEqual(first);
  expect(
    p.query.mock.calls.some((c) => c[0].startsWith('CREATE ') || c[0].startsWith('INSERT ')),
  ).toBe(false);
  p.state.functions = p.state.functions.map((f, i) => ({
    ...f,
    bodySha256: currentRuntimeV7FunctionTransitions[i]?.predecessorSha256 ?? '',
  }));
  await expect(verifyCurrentRuntimeV7InstalledIn(p)).rejects.toThrow(
    'CURRENT_RUNTIME_V7_FUNCTION_DRIFT',
  );
});
it.each([0, 1])('does not adopt raw133 successor %i without ledger', async (index) => {
  const p = port();
  const row = p.state.functions[index],
    pin = currentRuntimeV7FunctionTransitions[index];
  if (!row || !pin) throw Error('fixture');
  row.bodySha256 = pin.successorSha256;
  await expect(installCurrentRuntimeV7In(p)).rejects.toThrow(
    'CURRENT_RUNTIME_V7_UNREGISTERED_STAGE',
  );
  expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
});
it('does not install on a readonly verifier or continue after parent failure', async () => {
  const p = port();
  await expect(verifyCurrentRuntimeV7InstalledIn(p)).rejects.toThrow(
    'CURRENT_RUNTIME_V7_LEDGER_INVALID',
  );
  expect(installCurrentRuntimeV6In).not.toHaveBeenCalled();
  vi.mocked(verifyCurrentRuntimeV6InstalledIn).mockRejectedValueOnce(Error('parent22 drift'));
  await expect(installCurrentRuntimeV7In(p)).rejects.toThrow('parent22 drift');
  expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
});
it.each(['owner', 'private', 'columns', 'constraints', 'shape'] as const)(
  'rejects private ledger %s drift',
  async (field) => {
    const p = port();
    await installCurrentRuntimeV7In(p);
    p.state.catalog[field] = false;
    await expect(verifyCurrentRuntimeV7InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V7_LEDGER_INVALID',
    );
  },
);
it('rejects missing/extra/unknown/hash receipts and malformed absence', async () => {
  const p = port();
  await installCurrentRuntimeV7In(p);
  const receipt = p.state.rows[0];
  if (!receipt) throw Error('fixture');
  for (const rows of [
    [],
    [receipt, receipt],
    [{ ...receipt, extra: true }],
    [{ ...receipt, sha256: 'f'.repeat(64) }],
    [{ ...receipt, parentManifestSha256: 'f'.repeat(64) }],
  ]) {
    p.state.rows = rows;
    await expect(verifyCurrentRuntimeV7InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V7_LEDGER_INVALID',
    );
  }
  p.query.mockImplementation(async () => ({
    rows: [{ ledger: false, unknown: true }],
    rowCount: 1,
  }));
  await expect(verifyCurrentRuntimeV7InstalledIn(p)).rejects.toThrow(
    'CURRENT_RUNTIME_V7_LEDGER_INVALID',
  );
});
it('rejects metadata change after successful patch before writing immutable receipt', async () => {
  const p = port();
  p.state.metadataChange = true;
  await expect(installCurrentRuntimeV7In(p)).rejects.toThrow('CURRENT_RUNTIME_V7_METADATA_CHANGED');
  expect(p.query.mock.calls.some((c) => c[0].startsWith('INSERT '))).toBe(false);
});
it.each([
  'signature',
  'owner',
  'language',
  'resultType',
  'definer',
  'volatility',
  'parallel',
  'strict',
  'setReturning',
  'configuration',
  'privatePublic',
  'safeDelegation',
  'bodySha256',
  'metadataSha256',
] as const)('rejects actual function %s drift', async (field) => {
  const p = port();
  await installCurrentRuntimeV7In(p);
  const rows = p.state.functions.map((row, i) =>
    i === 0
      ? {
          ...row,
          [field]:
            field === 'configuration'
              ? []
              : field === 'owner' ||
                  field === 'definer' ||
                  field === 'privatePublic' ||
                  field === 'safeDelegation'
                ? false
                : field === 'strict' || field === 'setReturning'
                  ? true
                  : 'unexpected',
        }
      : row,
  );
  const original = p.query.getMockImplementation();
  if (!original) throw Error('fixture');
  p.query.mockImplementation(async (sql) =>
    sql.startsWith('SELECT requested.signature') ? { rows, rowCount: rows.length } : original(sql),
  );
  await expect(verifyCurrentRuntimeV7InstalledIn(p)).rejects.toThrow(
    'CURRENT_RUNTIME_V7_FUNCTION_DRIFT',
  );
});
it('propagates SQL failure with no receipt; caller transaction owns rollback', async () => {
  const p = port();
  const original = p.query.getMockImplementation();
  if (!original) throw Error('fixture');
  const failure = Error('synthetic SQL failure');
  p.query.mockImplementation(async (sql) => {
    if (sql.startsWith('-- Exact SQL118')) throw failure;
    return original(sql);
  });
  await expect(installCurrentRuntimeV7In(p)).rejects.toBe(failure);
  expect(p.query.mock.calls.some((c) => c[0].startsWith('INSERT '))).toBe(false);
});
it('returns only bounded pg_catalog body hashes, with every original metadata field pinned across patch', async () => {
  const p = port();
  await installCurrentRuntimeV7In(p);
  const sql = p.query.mock.calls.find((c) => c[0].startsWith('SELECT requested.signature'))?.[0];
  expect(sql).toContain("(to_jsonb(p)-'prosrc')::text");
  expect(sql).toContain('AS "bodySha256"');
  expect(sql).not.toContain('p.prosrc AS body');
  expect(sql).toContain('WITH ORDINALITY');
});

it('cannot narrow compiled transitions through exposed arrays or source descriptors', () => {
  expect(Object.isFrozen(currentRuntimeV7ExtensionMember)).toBe(true);
  expect(Object.isFrozen(currentRuntimeV7FunctionTransitions)).toBe(true);
  for (const f of currentRuntimeV7FunctionTransitions) {
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.configuration)).toBe(true);
  }
});
it('rejects duplicated, reordered, missing and extra function observations', async () => {
  for (const variant of ['duplicate', 'reversed', 'missing', 'extra'] as const) {
    const p = port();
    await installCurrentRuntimeV7In(p);
    const rows = p.state.functions.map((row) => ({ ...row }));
    const first = rows[0];
    if (!first) throw Error('fixture');
    const wrong =
      variant === 'duplicate'
        ? [first, first]
        : variant === 'reversed'
          ? [...rows].reverse()
          : variant === 'missing'
            ? [first]
            : [...rows, first];
    const original = p.query.getMockImplementation();
    if (!original) throw Error('fixture');
    p.query.mockImplementation(async (sql) =>
      sql.startsWith('SELECT requested.signature')
        ? { rows: wrong, rowCount: wrong.length }
        : original(sql),
    );
    await expect(verifyCurrentRuntimeV7InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V7_FUNCTION_DRIFT',
    );
  }
});
