import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type * as InstallationV7 from '../src/current-runtime-installation-v7.js';
import { type CurrentRuntimeInstallationTransaction } from '../src/current-runtime-installation.js';
import {
  currentRuntimeV8ParentMembers,
  currentRuntimeV8ParentManifestSha256,
  currentRuntimeV8ExtensionMembers,
  currentRuntimeV8FunctionPins,
  installCurrentRuntimeV8In,
  verifyCurrentRuntimeV8InstalledIn,
} from '../src/current-runtime-installation-v8.js';
vi.mock('../src/current-runtime-installation-v7.js', async (original) => ({
  ...(await original<typeof InstallationV7>()),
  installCurrentRuntimeV7In: vi.fn(async () => undefined),
  verifyCurrentRuntimeV7InstalledIn: vi.fn(async () => ({
    parentAppliedMembers: currentRuntimeV8ParentMembers.slice(0, 22),
    extensionReceipt: { ...currentRuntimeV8ParentMembers[22] },
  })),
}));
// Unit query records are structural fixtures, never actual PostgreSQL authority.
function fixture(
  options: {
    ledger?: boolean;
    pooled?: boolean;
    badLedger?: boolean;
    badFunctions?: boolean;
    missing141?: boolean;
    wrongPrivateCount?: boolean;
    failDdl?: number;
    metadataChange?: boolean;
  } = {},
) {
  let ledger = options.ledger ?? false;
  const statements: string[] = [];
  let ddl = 0;
  let prefixes = 0;
  const tx: CurrentRuntimeInstallationTransaction = {
    async query(sql) {
      statements.push(sql);
      const select = sql.trimStart().startsWith('SELECT');
      if (select && sql.includes('AS ledger'))
        return {
          rows: [{ ledger, pooled: options.pooled ?? ledger, knownLedgers: true }],
          rowCount: 1,
        };
      if (select && sql.includes('AS columns'))
        return {
          rows: [
            {
              owner: true,
              private: true,
              columns: true,
              constraints: true,
              shape: !options.badLedger,
            },
          ],
          rowCount: 1,
        };
      if (select && sql.includes('extension_step AS'))
        return {
          rows: currentRuntimeV8ExtensionMembers.map((m) => ({
            ...m,
            parentManifestSha256: currentRuntimeV8ParentManifestSha256,
          })),
          rowCount: 8,
        };
      if (select && sql.includes('AS "bodySha256"'))
        return {
          rows: (options.missing141
            ? currentRuntimeV8FunctionPins.slice(0, 21)
            : currentRuntimeV8FunctionPins
          ).map((p) => ({
            signature: p.signature,
            owner: true,
            bodySha256: options.badFunctions ? '0'.repeat(64) : p.prosrcSha256,
            metadataMatches: true,
            safeAcl: true,
            namespace: true,
          })),
          rowCount: 24,
        };
      if (select && sql.includes('AS count,'))
        return {
          rows: [{ count: options.wrongPrivateCount ? 9 : 12, private: true }],
          rowCount: 1,
        };
      if (select && sql.includes('requested.signature,encode')) {
        prefixes++;
        const { currentRuntimeV7RpcSourcePins } =
          await import('../src/current-runtime-grants-v7.js');
        return {
          rows: currentRuntimeV7RpcSourcePins.map((p) => ({
            signature: p.signature,
            fingerprint: (options.metadataChange && prefixes > 1 ? 'b' : 'a').repeat(64),
          })),
          rowCount: 33,
        };
      }
      if (select && sql.includes('AS fingerprint'))
        return { rows: [{ fingerprint: 'a'.repeat(64) }], rowCount: 1 };
      if (sql.startsWith('CREATE TABLE')) ledger = true;
      if (sql.includes('DO $migration$') || sql.startsWith('-- Frozen DB-envelope')) {
        ddl++;
        if (options.failDdl === ddl) throw Error('FIXTURE_DDL_FAILURE');
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, statements };
}
afterEach(() => vi.clearAllMocks());
it('separates exact parent23, physical eight sources, logical24 and final actual24 pins', async () => {
  expect(currentRuntimeV8ParentMembers.map((m) => m.step)).toEqual(
    Array.from({ length: 23 }, (_, i) => i + 1),
  );
  expect(currentRuntimeV8ExtensionMembers.map((m) => m.sourceDdlId)).toEqual([
    134, 135, 136, 137, 138, 139, 140, 141,
  ]);
  expect(currentRuntimeV8FunctionPins).toHaveLength(24);
  expect(currentRuntimeV8FunctionPins.filter((p) => p.runtimeDirect)).toHaveLength(8);
  for (const member of currentRuntimeV8ExtensionMembers) {
    const bytes = await readFile(new URL(`../migrations/${member.filename}`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(member.sha256);
  }
  expect(Object.isFrozen(currentRuntimeV8FunctionPins[0]?.metadata.proargnames)).toBe(true);
});
it('owner transaction emits ordered source DDL and eight exact receipts with no grants', async () => {
  const f = fixture();
  const r = await installCurrentRuntimeV8In(f.tx);
  expect(r).toMatchObject({
    profileVersion: 8,
    parentRuntimeStep: 23,
    extensionSteps: 8,
    runtimeStep: 24,
    sourceDdlTip: 141,
    supported: false,
    processingAuthority: 'none',
    restore: 'not_verified',
  });
  expect(r.extensionReceipts).toHaveLength(8);
  expect(
    f.statements.filter((s) =>
      s.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v8'),
    ),
  ).toHaveLength(8);
  expect(f.statements.slice(0, 2)).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(f.statements.filter((s) => s.startsWith('GRANT'))).toHaveLength(0);
});
it('raw pooled objects without receipts are not adopted', async () => {
  const f = fixture({ pooled: true });
  await expect(installCurrentRuntimeV8In(f.tx)).rejects.toThrow(
    'CURRENT_RUNTIME_V8_UNREGISTERED_STAGE',
  );
  expect(f.statements.some((s) => s.startsWith('CREATE TABLE'))).toBe(false);
});
it('replay validates final state without rerunning successor SQL or rewriting receipts', async () => {
  const f = fixture({ ledger: true });
  await installCurrentRuntimeV8In(f.tx);
  expect(
    f.statements.some((s) => s.startsWith('CREATE TABLE') || s.startsWith('INSERT INTO')),
  ).toBe(false);
  expect(f.statements.some((s) => s.includes('DO $migration$'))).toBe(false);
});
it('read-only verifier rejects missing receipt, malformed shape and wrong actual body', async () => {
  await expect(verifyCurrentRuntimeV8InstalledIn(fixture().tx)).rejects.toThrow(
    'CURRENT_RUNTIME_V8_LEDGER_INVALID',
  );
  await expect(
    verifyCurrentRuntimeV8InstalledIn(fixture({ ledger: true, badLedger: true }).tx),
  ).rejects.toThrow('CURRENT_RUNTIME_V8_LEDGER_INVALID');
  await expect(
    verifyCurrentRuntimeV8InstalledIn(fixture({ ledger: true, badFunctions: true }).tx),
  ).rejects.toThrow('CURRENT_RUNTIME_V8_FUNCTION_DRIFT');
});
it('original prefix mutation is rejected and in-transaction failures propagate for caller rollback', async () => {
  await expect(installCurrentRuntimeV8In(fixture({ metadataChange: true }).tx)).rejects.toThrow(
    'CURRENT_RUNTIME_V8_METADATA_CHANGED',
  );
  const f = fixture({ failDdl: 2 });
  await expect(installCurrentRuntimeV8In(f.tx)).rejects.toThrow('FIXTURE_DDL_FAILURE');
  expect(f.statements.some((s) => s === 'COMMIT')).toBe(false);
});

it('exact final141 rejects end140 function or private roster even with declared eight receipts', async () => {
  for (const options of [{ missing141: true }, { wrongPrivateCount: true }]) {
    await expect(
      verifyCurrentRuntimeV8InstalledIn(fixture({ ledger: true, ...options }).tx),
    ).rejects.toThrow('CURRENT_RUNTIME_V8_FUNCTION_DRIFT');
  }
  expect(currentRuntimeV8FunctionPins[7]?.prosrcSha256).toBe(
    'f2d6e04df35f304b6e66ee457bff72429bd23d18af00879d7ba28cd53c03b7d0',
  );
  expect(currentRuntimeV8FunctionPins[8]?.prosrcSha256).toBe(
    '2a16d60ad9e74d6fd43d88353b399bc7d3e27a031836225e0eb0cd5a97e74f05',
  );
  expect(
    currentRuntimeV8FunctionPins.filter((p) => p.signature.startsWith('wm_manual_pooled.')),
  ).toHaveLength(12);
});
