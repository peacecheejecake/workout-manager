import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as V7 from '../src/current-runtime-installation-v7.js';
import type * as V9 from '../src/current-runtime-installation-v9.js';
import type { CurrentRuntimeInstallationTransaction } from '../src/current-runtime-installation.js';
import {
  currentRuntimeV8ExtensionMembers,
  currentRuntimeV8ParentManifestSha256,
} from '../src/current-runtime-installation-v8.js';
import {
  currentRuntimeV9ExtensionMembers,
  currentRuntimeV9FunctionPins,
  currentRuntimeV9ParentManifestSha256,
  currentRuntimeV9ParentMembers,
} from '../src/current-runtime-installation-v9.js';
import {
  currentRuntimeV10ParentMembers,
  currentRuntimeV10ParentManifestSha256,
  currentRuntimeV10ExtensionMembers,
  currentRuntimeV10FunctionPins,
  currentRuntimeV10GuardFunctionSignature,
  currentRuntimeV10GuardTriggerName,
  currentRuntimeV10KnownLedgers,
  installCurrentRuntimeV10In,
  verifyCurrentRuntimeV10InstalledIn,
} from '../src/current-runtime-installation-v10.js';
vi.mock('../src/current-runtime-installation-v7.js', async (original) => ({
  ...(await original<typeof V7>()),
  verifyCurrentRuntimeV7InstalledIn: vi.fn(async () => ({
    parentAppliedMembers: currentRuntimeV10ParentMembers.slice(0, 22),
    extensionReceipt: { ...currentRuntimeV10ParentMembers[22] },
  })),
}));
vi.mock('../src/current-runtime-installation-v9.js', async (original) => ({
  ...(await original<typeof V9>()),
  installCurrentRuntimeV9In: vi.fn(async () => undefined),
  verifyCurrentRuntimeV9InstalledIn: vi.fn(async () => {
    throw Error('V10_MUST_NOT_CALL_V9_VERIFY');
  }),
}));
// Mocked owner observations isolate finite protocol ordering; no DB authority.
function fixture(
  options: {
    ledger?: boolean;
    staged?: boolean;
    badParent8?: boolean;
    badParent9?: boolean;
    badLedger?: boolean;
    badFunctions?: boolean;
    missingRoot?: boolean;
    privateCount?: number;
    unknownLedger?: boolean;
    metadataChange?: boolean;
    failDdl?: boolean;
    trigger?: Record<string, unknown>;
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
          rows: [
            { ledger, staged: options.staged ?? ledger, knownLedgers: !options.unknownLedger },
          ],
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
                ? options.badParent8
                : sql.includes("relname='profile_extension_v9'")
                  ? options.badParent9
                  : options.badLedger),
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('extension_step AS')) {
        const [members, parentManifestSha256] = sql.includes('profile_extension_v8 ')
          ? [currentRuntimeV8ExtensionMembers, currentRuntimeV8ParentManifestSha256]
          : sql.includes('profile_extension_v9 ')
            ? [currentRuntimeV9ExtensionMembers, currentRuntimeV9ParentManifestSha256]
            : [currentRuntimeV10ExtensionMembers, currentRuntimeV10ParentManifestSha256];
        return {
          rows: members.map((m) => ({ ...m, parentManifestSha256 })),
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
      if (sql.includes('AS "functionUses"'))
        return {
          rows: [options.trigger ?? { count: 1, functionUses: 1, exact: true }],
          rowCount: 1,
        };
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
      if (sql.includes('CREATE FUNCTION public.guard_race_event_local_date_approval_v1')) {
        if (options.failDdl) throw Error('FIXTURE_DDL_FAILURE');
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, statements };
}
afterEach(() => vi.clearAllMocks());
it('pins parent9 physical32, one146 extension and logical26 distinctly with frozen 27+4 pins', async () => {
  expect(currentRuntimeV10ParentMembers).toHaveLength(32);
  expect(currentRuntimeV10ParentMembers.map((m) => m.step)).toEqual(
    Array.from({ length: 32 }, (_, i) => i + 1),
  );
  expect(currentRuntimeV10ParentMembers.slice(0, 31)).toEqual(currentRuntimeV9ParentMembers);
  expect(currentRuntimeV10ParentMembers[31]).toEqual({
    step: 32,
    sourceDdlId: 142,
    filename: '142_manual_pooled_parent_delta.sql',
    sha256: '7653de06a0b5017195729a20d2a21ea706c45c1e0db6b21f4b9c3a7094851cca',
  });
  expect(currentRuntimeV10ExtensionMembers).toEqual([
    {
      extensionStep: 1,
      sourceDdlId: 146,
      filename: '146_race_event_local_date_approval_guard.sql',
      sha256: '9969791a6c4f8fa3792697717acd5700a3e53aac1d2bd234dad1401985837582',
    },
  ]);
  expect(currentRuntimeV10FunctionPins).toHaveLength(27);
  expect(currentRuntimeV10FunctionPins.slice(0, 26)).toEqual(currentRuntimeV9FunctionPins);
  const guard = currentRuntimeV10FunctionPins[26];
  expect(guard?.signature).toBe(currentRuntimeV10GuardFunctionSignature);
  expect(guard).toMatchObject({
    runtimeDirect: false,
    language: 'plpgsql',
    metadata: {
      prosecdef: false,
      prorettype: '2279',
      proconfig: ['search_path=pg_catalog, pg_temp'],
    },
  });
  expect(currentRuntimeV10GuardTriggerName).toBe('race_local_date_approval_guard');
  expect(currentRuntimeV10KnownLedgers.at(-1)).toBe('profile_extension_v10');
  const encoding = JSON.stringify({
    encoding: 'current-runtime-profile-v9-parent-manifest-v1',
    profileVersion: 9,
    baselineSchemaVersion: 107,
    runtimeStep: 25,
    members: currentRuntimeV10ParentMembers.map((m) => [
      m.step,
      m.sourceDdlId,
      m.filename,
      m.sha256,
    ]),
  });
  expect(createHash('sha256').update(encoding).digest('hex')).toBe(
    currentRuntimeV10ParentManifestSha256,
  );
  for (const m of [...currentRuntimeV10ParentMembers, ...currentRuntimeV10ExtensionMembers])
    expect(
      createHash('sha256')
        .update(await readFile(new URL(`../migrations/${m.filename}`, import.meta.url)))
        .digest('hex'),
    ).toBe(m.sha256);
  expect(Object.isFrozen(guard?.metadata.proconfig)).toBe(true);
  expect(Object.isFrozen(guard)).toBe(true);
});
it('the guard pin body hash is the prosrc of the frozen 146 function', async () => {
  const sql = await readFile(
    new URL('../migrations/146_race_event_local_date_approval_guard.sql', import.meta.url),
    'utf8',
  );
  const body = /AS \$guard\$([\s\S]*?)\$guard\$;/.exec(sql)?.[1];
  expect(body).toBeTruthy();
  expect(createHash('sha256').update(z.string().parse(body)).digest('hex')).toBe(
    currentRuntimeV10FunctionPins[26]?.prosrcSha256,
  );
});
it('installs parent9 before146 with ordered fences, one receipt and no runtime grants', async () => {
  const f = fixture();
  const result = await installCurrentRuntimeV10In(f.tx);
  expect(result).toMatchObject({
    profileVersion: 10,
    parentProfileVersion: 9,
    baselineSchemaVersion: 107,
    parentRuntimeStep: 25,
    extensionSteps: 1,
    runtimeStep: 26,
    sourceDdlTip: 146,
    catalogSecurity: 'not_verified',
    supported: false,
    processingAuthority: 'none',
    restore: 'not_verified',
  });
  expect(result.extensionReceipts).toHaveLength(1);
  expect(f.statements.slice(0, 2)).toEqual([
    'SELECT pg_advisory_xact_lock(872194,1)',
    'SELECT pg_advisory_xact_lock(77210,1)',
  ]);
  const v9 = await import('../src/current-runtime-installation-v9.js');
  expect(v9.installCurrentRuntimeV9In).toHaveBeenCalledOnce();
  expect(v9.verifyCurrentRuntimeV9InstalledIn).not.toHaveBeenCalled();
  const create = f.statements.findIndex((s) =>
    s.startsWith('CREATE TABLE wm_runtime_installation.profile_extension_v10'),
  );
  const ddl = f.statements.findIndex((s) =>
    s.includes('CREATE TRIGGER race_local_date_approval_guard'),
  );
  const receipt = f.statements.findIndex((s) =>
    s.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v10'),
  );
  expect(create).toBeGreaterThan(0);
  expect(ddl).toBeGreaterThan(create);
  expect(receipt).toBeGreaterThan(ddl);
  expect(
    f.statements.filter((s) =>
      s.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v10'),
    ),
  ).toHaveLength(1);
  expect(f.statements.some((s) => s.startsWith('GRANT') || s === 'COMMIT')).toBe(false);
});
it('replay validates all parents, 31 pins and the trigger without running installer9 or rewriting receipts', async () => {
  const f = fixture({ ledger: true });
  await installCurrentRuntimeV10In(f.tx);
  const v9 = await import('../src/current-runtime-installation-v9.js');
  expect(v9.installCurrentRuntimeV9In).not.toHaveBeenCalled();
  expect(
    f.statements.some(
      (s) =>
        s.startsWith('CREATE TABLE') || s.startsWith('INSERT INTO') || s.includes('CREATE TRIGGER'),
    ),
  ).toBe(false);
  expect(f.statements.some((s) => s.includes('AS "functionUses"'))).toBe(true);
});
it('raw146 without receipt and unknown future ledger fail closed before adoption', async () => {
  for (const options of [{ staged: true }, { unknownLedger: true }]) {
    const f = fixture(options);
    await expect(installCurrentRuntimeV10In(f.tx)).rejects.toThrow(
      'staged' in options
        ? 'CURRENT_RUNTIME_V10_UNREGISTERED_STAGE'
        : 'CURRENT_RUNTIME_V10_LEDGER_INVALID',
    );
    expect(f.statements.some((s) => s.startsWith('CREATE TABLE'))).toBe(false);
    const v9 = await import('../src/current-runtime-installation-v9.js');
    expect(v9.installCurrentRuntimeV9In).not.toHaveBeenCalled();
  }
});
it('missing or malformed parent8/parent9/new receipts reject read-only verification', async () => {
  for (const options of [
    {},
    { ledger: true, staged: false },
    { ledger: true, badParent8: true },
    { ledger: true, badParent9: true },
    { ledger: true, badLedger: true },
  ])
    await expect(verifyCurrentRuntimeV10InstalledIn(fixture(options).tx)).rejects.toThrow(
      'CURRENT_RUNTIME_V10_LEDGER_INVALID',
    );
});
it('actual fixed body/metadata, private roster and exact trigger pin are required', async () => {
  for (const options of [
    { badFunctions: true },
    { missingRoot: true },
    { privateCount: 12 },
    { privateCount: 14 },
    { trigger: { count: 0, functionUses: 0, exact: false } },
    { trigger: { count: 1, functionUses: 1, exact: false } },
    { trigger: { count: 1, functionUses: 2, exact: true } },
    { trigger: { count: 2, functionUses: 2, exact: true } },
    { trigger: { count: 1, functionUses: 1, exact: true, extra: true } },
  ])
    await expect(
      verifyCurrentRuntimeV10InstalledIn(fixture({ ledger: true, ...options }).tx),
    ).rejects.toThrow('CURRENT_RUNTIME_V10_FUNCTION_DRIFT');
});
it('whole parent function/receipt fingerprints cannot change and failures require caller rollback', async () => {
  await expect(installCurrentRuntimeV10In(fixture({ metadataChange: true }).tx)).rejects.toThrow(
    'CURRENT_RUNTIME_V10_METADATA_CHANGED',
  );
  const f = fixture({ failDdl: true });
  await expect(installCurrentRuntimeV10In(f.tx)).rejects.toThrow('FIXTURE_DDL_FAILURE');
  expect(f.statements.includes('COMMIT')).toBe(false);
  expect(f.statements.some((s) => s.startsWith('INSERT INTO'))).toBe(false);
});
it('prefix fingerprints cover V7 RPC33 + V9 pins26 and the nine predecessor ledgers', async () => {
  const f = fixture();
  await installCurrentRuntimeV10In(f.tx);
  const ledgers = f.statements
    .filter((s) => s.includes('AS fingerprint FROM wm_runtime_installation.'))
    .map((s) => /wm_runtime_installation\.(\w+) t/.exec(s)?.[1]);
  expect(ledgers.slice(0, 9)).toEqual(currentRuntimeV10KnownLedgers.slice(0, 9));
  expect(ledgers).not.toContain('profile_extension_v10');
});
