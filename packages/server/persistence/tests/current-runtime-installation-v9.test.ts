import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as V7 from '../src/current-runtime-installation-v7.js';
import type * as V8 from '../src/current-runtime-installation-v8.js';
import type { CurrentRuntimeInstallationTransaction } from '../src/current-runtime-installation.js';
import {
  currentRuntimeV8ExtensionMembers,
  currentRuntimeV8ParentManifestSha256,
} from '../src/current-runtime-installation-v8.js';
import {
  currentRuntimeV9ParentMembers,
  currentRuntimeV9ParentManifestSha256,
  currentRuntimeV9ExtensionMembers,
  currentRuntimeV9FunctionPins,
  installCurrentRuntimeV9In,
  verifyCurrentRuntimeV9InstalledIn,
} from '../src/current-runtime-installation-v9.js';
vi.mock('../src/current-runtime-installation-v7.js', async (original) => ({
  ...(await original<typeof V7>()),
  verifyCurrentRuntimeV7InstalledIn: vi.fn(async () => ({
    parentAppliedMembers: currentRuntimeV9ParentMembers.slice(0, 22),
    extensionReceipt: { ...currentRuntimeV9ParentMembers[22] },
  })),
}));
vi.mock('../src/current-runtime-installation-v8.js', async (original) => ({
  ...(await original<typeof V8>()),
  installCurrentRuntimeV8In: vi.fn(async () => undefined),
}));
// Mocked owner observations isolate finite protocol ordering; no DB authority.
function fixture(
  options: {
    ledger?: boolean;
    raw?: boolean;
    badParent?: boolean;
    badLedger?: boolean;
    badFunctions?: boolean;
    missingRoot?: boolean;
    privateCount?: number;
    unknownLedger?: boolean;
    metadataChange?: boolean;
    failDdl?: boolean;
  } = {},
) {
  let ledger = options.ledger ?? false,
    prefixes = 0;
  const statements: string[] = [];
  const tx: CurrentRuntimeInstallationTransaction = {
    async query(sql, args = []) {
      statements.push(sql);
      if (sql.includes('AS ledger'))
        return {
          rows: [{ ledger, pooled: options.raw ?? ledger, knownLedgers: !options.unknownLedger }],
          rowCount: 1,
        };
      if (sql.includes('AS columns'))
        return {
          rows: [
            {
              owner: true,
              private: true,
              columns: true,
              constraints: true,
              shape: !(sql.includes("relname='profile_extension_v8'")
                ? options.badParent
                : options.badLedger),
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('extension_step AS')) {
        const parent = sql.includes('profile_extension_v8');
        const members = parent
          ? currentRuntimeV8ExtensionMembers
          : currentRuntimeV9ExtensionMembers;
        return {
          rows: members.map((m) => ({
            ...m,
            parentManifestSha256: parent
              ? currentRuntimeV8ParentManifestSha256
              : currentRuntimeV9ParentManifestSha256,
          })),
          rowCount: members.length,
        };
      }
      if (sql.includes('AS "bodySha256"')) {
        const pins = z
          .array(z.object({ signature: z.string(), prosrcSha256: z.string() }))
          .parse(JSON.parse(z.string().parse(args[0])));
        return {
          rows: (options.missingRoot ? pins.slice(0, -1) : pins).map((p) => ({
            signature: p.signature,
            owner: true,
            bodySha256: options.badFunctions ? '0'.repeat(64) : p.prosrcSha256,
            metadataMatches: true,
            safeAcl: true,
            namespace: true,
          })),
          rowCount: pins.length,
        };
      }
      if (sql.includes('AS count,'))
        return { rows: [{ count: options.privateCount ?? 13, private: true }], rowCount: 1 };
      if (sql.includes('requested.signature,encode')) {
        prefixes++;
        const signatures = z.array(z.string()).parse(args[0]);
        return {
          rows: signatures.map((signature) => ({
            signature,
            fingerprint: (options.metadataChange && prefixes > 1 ? 'b' : 'a').repeat(64),
          })),
          rowCount: signatures.length,
        };
      }
      if (sql.includes('AS fingerprint'))
        return { rows: [{ fingerprint: 'a'.repeat(64) }], rowCount: 1 };
      if (sql.startsWith('CREATE TABLE')) ledger = true;
      if (sql.includes('DO $migration$') && options.failDdl) throw Error('FIXTURE_DDL_FAILURE');
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, statements };
}
afterEach(() => vi.clearAllMocks());
it('pins parent8 physical31, one142 extension and logical25 distinctly with frozen actual26 roots', async () => {
  expect(currentRuntimeV9ParentMembers.map((m) => m.step)).toEqual(
    Array.from({ length: 31 }, (_, i) => i + 1),
  );
  expect(currentRuntimeV9ParentMembers.slice(23).map((m) => m.sourceDdlId)).toEqual([
    134, 135, 136, 137, 138, 139, 140, 141,
  ]);
  expect(currentRuntimeV9ExtensionMembers.map((m) => m.sourceDdlId)).toEqual([142]);
  expect(currentRuntimeV9FunctionPins).toHaveLength(26);
  expect(currentRuntimeV9FunctionPins.filter((p) => p.runtimeDirect)).toHaveLength(9);
  expect(
    currentRuntimeV9FunctionPins.filter((p) => p.signature.startsWith('wm_manual_pooled.')),
  ).toHaveLength(13);
  const encoding = JSON.stringify({
    encoding: 'current-runtime-profile-v8-parent-manifest-v1',
    profileVersion: 8,
    baselineSchemaVersion: 107,
    runtimeStep: 24,
    members: currentRuntimeV9ParentMembers.map((m) => [
      m.step,
      m.sourceDdlId,
      m.filename,
      m.sha256,
    ]),
  });
  expect(createHash('sha256').update(encoding).digest('hex')).toBe(
    currentRuntimeV9ParentManifestSha256,
  );
  for (const m of [...currentRuntimeV9ParentMembers, ...currentRuntimeV9ExtensionMembers])
    expect(
      createHash('sha256')
        .update(await readFile(new URL(`../migrations/${m.filename}`, import.meta.url)))
        .digest('hex'),
    ).toBe(m.sha256);
  expect(Object.isFrozen(currentRuntimeV9FunctionPins[24]?.metadata.proconfig)).toBe(true);
});
it('installs actual parent8 before142 with ordered fences and one receipt without runtime grants', async () => {
  const f = fixture();
  const result = await installCurrentRuntimeV9In(f.tx);
  expect(result).toMatchObject({
    profileVersion: 9,
    parentProfileVersion: 8,
    parentRuntimeStep: 24,
    extensionSteps: 1,
    runtimeStep: 25,
    sourceDdlTip: 142,
    supported: false,
    processingAuthority: 'none',
    restore: 'not_verified',
  });
  expect(result.extensionReceipts).toHaveLength(1);
  expect(f.statements.slice(0, 2)).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  expect(
    f.statements.filter((s) =>
      s.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v9'),
    ),
  ).toHaveLength(1);
  expect(f.statements.some((s) => s.startsWith('GRANT') || s === 'COMMIT')).toBe(false);
});
it('replay validates all parents and final26+guard4 without running installer8 or rewriting receipts', async () => {
  const f = fixture({ ledger: true });
  await installCurrentRuntimeV9In(f.tx);
  const old = await import('../src/current-runtime-installation-v8.js');
  expect(old.installCurrentRuntimeV8In).not.toHaveBeenCalled();
  expect(
    f.statements.some(
      (s) =>
        s.startsWith('CREATE TABLE') || s.startsWith('INSERT INTO') || s.includes('DO $migration$'),
    ),
  ).toBe(false);
});
it('raw142 without receipt and unknown future ledger fail closed before adoption', async () => {
  for (const options of [{ raw: true }, { unknownLedger: true }]) {
    const f = fixture(options);
    await expect(installCurrentRuntimeV9In(f.tx)).rejects.toThrow(
      options.raw ? 'CURRENT_RUNTIME_V9_UNREGISTERED_STAGE' : 'CURRENT_RUNTIME_V9_LEDGER_INVALID',
    );
    expect(f.statements.some((s) => s.startsWith('CREATE TABLE'))).toBe(false);
  }
});
it('missing or malformed parent/new receipts reject read-only verification', async () => {
  for (const options of [{}, { ledger: true, badParent: true }, { ledger: true, badLedger: true }])
    await expect(verifyCurrentRuntimeV9InstalledIn(fixture(options).tx)).rejects.toThrow(
      'CURRENT_RUNTIME_V9_LEDGER_INVALID',
    );
});
it('actual fixed body/metadata and exact private roster are required, not declared profile flags', async () => {
  for (const options of [
    { badFunctions: true },
    { missingRoot: true },
    { privateCount: 12 },
    { privateCount: 14 },
  ])
    await expect(
      verifyCurrentRuntimeV9InstalledIn(fixture({ ledger: true, ...options }).tx),
    ).rejects.toThrow('CURRENT_RUNTIME_V9_FUNCTION_DRIFT');
});
it('whole parent function/receipt fingerprints cannot change and failures require caller rollback', async () => {
  await expect(installCurrentRuntimeV9In(fixture({ metadataChange: true }).tx)).rejects.toThrow(
    'CURRENT_RUNTIME_V9_METADATA_CHANGED',
  );
  const f = fixture({ failDdl: true });
  await expect(installCurrentRuntimeV9In(f.tx)).rejects.toThrow('FIXTURE_DDL_FAILURE');
  expect(f.statements.includes('COMMIT')).toBe(false);
});
