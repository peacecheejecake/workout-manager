import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { migrationFileNames } from '../src/migrate.js';
import {
  currentRuntimeMigrationMembers,
  currentRuntimeTargetTransforms,
  currentRuntimeLedgerSchema,
  installCurrentRuntimeIn,
  verifyCurrentRuntimeInstalledIn,
  type CurrentRuntimeInstallationTransaction,
} from '../src/current-runtime-installation.js';
async function fixture(
  options: {
    owner?: boolean;
    baseBad?: boolean;
    ledger?: unknown[];
    raw?: boolean;
    target?: boolean;
    catalog?: boolean;
    failStep?: number;
  } = {},
) {
  const base = await Promise.all(
    migrationFileNames.map(async (f, i) => ({
      version: i + 1,
      checksum: createHash('sha256')
        .update(await readFile(new URL(`../migrations/${f}`, import.meta.url)))
        .digest('hex'),
    })),
  );
  const sqlBodies = new Set(
    await Promise.all(
      currentRuntimeMigrationMembers.map((m) =>
        readFile(new URL(`../migrations/${m.filename}`, import.meta.url), 'utf8'),
      ),
    ),
  );
  const calls: string[] = [],
    ledger = [...(options.ledger ?? [])];
  let applied = 0;
  const tx: CurrentRuntimeInstallationTransaction = {
    async query(sql, values) {
      calls.push(sql);
      if (sql.includes(' AS plain,'))
        return {
          rows: [{ plain: options.owner !== false, owns: true, same_role: true }],
          rowCount: 1,
        };
      if (sql === 'SELECT version,checksum FROM public.schema_migrations ORDER BY version')
        return { rows: options.baseBad ? base.slice(1) : base, rowCount: base.length };
      if (sql.includes(' AS raw_stage'))
        return {
          rows: [
            {
              ledger: options.ledger !== undefined,
              target: options.target ?? false,
              raw_stage: options.raw ?? false,
            },
          ],
          rowCount: 1,
        };
      if (sql.includes(' AS schema_private,'))
        return {
          rows: [
            {
              owned: true,
              schema_owned: true,
              schema_private: true,
              table_private: true,
              columns: options.catalog !== false,
              primary_key: true,
              unique_keys: true,
            },
          ],
          rowCount: 1,
        };
      if (sql.startsWith('SELECT step,'))
        return { rows: ledger.map((row) => Object.assign({}, row)), rowCount: ledger.length };
      if (sqlBodies.has(sql)) {
        applied++;
        if (applied === options.failStep) throw Error('SYNTHETIC_INSTALL_FAILURE');
      }
      if (sql.startsWith('INSERT INTO wm_runtime_installation'))
        ledger.push({
          step: values?.[0],
          sourceDdlId: values?.[1],
          filename: values?.[2],
          sha256: values?.[3],
        });
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, calls, ledger, sqlBodies };
}
it('catalog has contiguous17 steps and exact runtime artifacts; excluded target transforms never get receipts', () => {
  expect(currentRuntimeMigrationMembers.map((m) => m.step)).toEqual(
    Array.from({ length: 17 }, (_, i) => i + 1),
  );
  expect(currentRuntimeMigrationMembers.map((m) => m.sourceDdlId)).toEqual([
    108, 109, 110, 111, 112, 113, 114, 115, 116, 118, 120, 121, 122, 123, 124, 126, 127,
  ]);
  expect(currentRuntimeTargetTransforms).toEqual([117, 119, 125]);
  expect(Object.isFrozen(currentRuntimeMigrationMembers)).toBe(true);
});
it('actual immutable source text is applied before each ledger insert; base registry is never written', async () => {
  const f = await fixture(),
    result = await installCurrentRuntimeIn(f.tx);
  expect(result).toMatchObject({
    baselineSchemaVersion: 107,
    runtimeStep: 17,
    sourceDdlTip: 127,
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(f.ledger).toEqual(currentRuntimeMigrationMembers);
  expect(f.calls.filter((sql) => f.sqlBodies.has(sql))).toHaveLength(17);
  expect(f.calls.some((sql) => /INSERT INTO (public\.)?schema_migrations/.test(sql))).toBe(false);
  const indexes = f.calls
    .map((sql, i) => (sql.startsWith('INSERT INTO wm_runtime_installation') ? i : -1))
    .filter((i) => i >= 0);
  expect(indexes.every((i) => f.sqlBodies.has(f.calls[i - 1] ?? ''))).toBe(true);
});
it('replay verifies exact ledger and performs zero SQL install; read verification has no locks or writes', async () => {
  const f = await fixture({ ledger: [...currentRuntimeMigrationMembers], raw: true });
  await installCurrentRuntimeIn(f.tx);
  expect(
    f.calls.some(
      (sql) => f.sqlBodies.has(sql) || sql.startsWith('INSERT') || sql.startsWith('CREATE SCHEMA'),
    ),
  ).toBe(false);
  const read = await fixture({ ledger: [...currentRuntimeMigrationMembers], raw: true });
  await verifyCurrentRuntimeInstalledIn(read.tx);
  expect(read.calls.some((sql) => sql.includes('pg_advisory') || !sql.startsWith('SELECT'))).toBe(
    false,
  );
});
it.each([{ owner: false }, { baseBad: true }, { target: true }, { raw: true }, { catalog: false }])(
  'denies invalid owner/base/target/rawstage/catalog without applying runtime %#',
  async (options) => {
    const f = await fixture(options);
    await expect(installCurrentRuntimeIn(f.tx)).rejects.toThrow();
    expect(f.calls.some((sql) => f.sqlBodies.has(sql))).toBe(false);
  },
);
it.each(
  [
    currentRuntimeMigrationMembers.slice(1),
    [...currentRuntimeMigrationMembers, currentRuntimeMigrationMembers[0]],
    currentRuntimeMigrationMembers.map((m, i) => (i === 3 ? { ...m, sha256: '0'.repeat(64) } : m)),
    currentRuntimeMigrationMembers.map((m, i) => (i === 3 ? { ...m, sourceDdlId: 117 } : m)),
  ].map((rows) => ({ rows })),
)('strict ledger rejects missing/duplicate/checksum/target identity %#', async ({ rows }) => {
  expect(currentRuntimeLedgerSchema.safeParse(rows).success).toBe(false);
  const f = await fixture({ ledger: rows });
  await expect(installCurrentRuntimeIn(f.tx)).rejects.toThrow('LEDGER_INVALID');
  expect(f.calls.some((sql) => f.sqlBodies.has(sql))).toBe(false);
});
it('mid-install error stops before failed-step receipt; transaction rollback is wrapper/PG acceptance', async () => {
  const f = await fixture({ failStep: 4 });
  await expect(installCurrentRuntimeIn(f.tx)).rejects.toThrow('SYNTHETIC_INSTALL_FAILURE');
  expect(f.ledger).toHaveLength(3);
});
it('valid registered prefix continues exact remaining source members; grant verifier requires complete17', async () => {
  const f = await fixture({ ledger: currentRuntimeMigrationMembers.slice(0, 3), raw: true });
  await installCurrentRuntimeIn(f.tx);
  expect(f.calls.filter((sql) => f.sqlBodies.has(sql))).toHaveLength(14);
  const incomplete = await fixture({
    ledger: currentRuntimeMigrationMembers.slice(0, 3),
    raw: true,
  });
  await expect(verifyCurrentRuntimeInstalledIn(incomplete.tx)).rejects.toThrow('LEDGER_INVALID');
});
