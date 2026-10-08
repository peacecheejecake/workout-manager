import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type * as ParentInstallation from '../src/current-runtime-installation.js';
import {
  currentRuntimeMigrationMembers,
  installCurrentRuntimeIn,
  verifyCurrentRuntimeInstalledIn,
} from '../src/current-runtime-installation.js';
import {
  currentRuntimeV2ParentManifestSha256,
  currentRuntimeV2ExtensionMember,
  installCurrentRuntimeV2In,
  verifyCurrentRuntimeV2InstalledIn,
} from '../src/current-runtime-installation-v2.js';
vi.mock('../src/current-runtime-installation.js', async (original) => ({
  ...(await original<typeof ParentInstallation>()),
  installCurrentRuntimeIn: vi.fn(async () => undefined),
  verifyCurrentRuntimeInstalledIn: vi.fn(async () => undefined),
}));
beforeEach(() => {
  vi.clearAllMocks();
});
function port() {
  const state = {
    ledger: false,
    first: false,
    second: false,
    rows: [] as Record<string, unknown>[],
    catalog: { owner: true, private: true, columns: true, constraints: true, shape: true },
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT to_regclass'))
      return {
        rows: [{ ledger: state.ledger, first: state.first, second: state.second }],
        rowCount: 1,
      };
    if (sql.startsWith('CREATE TABLE wm_runtime_installation.profile_extension_v2'))
      state.ledger = true;
    if (sql.startsWith('-- Explicit retained-read successor')) {
      state.first = true;
      state.second = true;
    }
    if (sql.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v2'))
      state.rows = [
        {
          extensionStep: 1,
          sourceDdlId: 128,
          filename: currentRuntimeV2ExtensionMember.filename,
          sha256: currentRuntimeV2ExtensionMember.sha256,
          parentManifestSha256: currentRuntimeV2ParentManifestSha256,
        },
      ];
    if (sql.startsWith('SELECT\n current_user')) return { rows: [state.catalog], rowCount: 1 };
    if (sql.startsWith('SELECT extension_step'))
      return { rows: state.rows, rowCount: state.rows.length };
    return { rows: [], rowCount: 0 };
  });
  return { state, query };
}
describe('exact runtime v2 extension installer ports (not actual PostgreSQL proof)', () => {
  it('pins the exact canonical historical17 parent tuple manifest', () => {
    const encoded = JSON.stringify({
      encoding: 'current-runtime-parent-manifest-v1',
      baselineSchemaVersion: 107,
      members: currentRuntimeMigrationMembers.map((m) => [
        m.step,
        m.sourceDdlId,
        m.filename,
        m.sha256,
      ]),
    });
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(
      currentRuntimeV2ParentManifestSha256,
    );
    expect(currentRuntimeMigrationMembers).toHaveLength(17);
  });
  it('uses the existing lock order/parent installer and writes only extension128 before exact read verification', async () => {
    const p = port();
    const result = await installCurrentRuntimeV2In(p);
    expect(p.query.mock.calls.slice(0, 2).map((c) => c[0])).toEqual([
      'SELECT pg_advisory_xact_lock(872194,1)',
      'SELECT pg_advisory_xact_lock(77210,1)',
    ]);
    expect(installCurrentRuntimeIn).toHaveBeenCalledWith(p);
    expect(verifyCurrentRuntimeInstalledIn).toHaveBeenCalledWith(p);
    expect(result).toMatchObject({
      profileVersion: 2,
      parentRuntimeStep: 17,
      runtimeStep: 18,
      sourceDdlTip: 128,
      supported: false,
      processingAuthority: 'none',
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
    });
    expect(p.query.mock.calls.filter((c) => c[0].startsWith('INSERT '))).toHaveLength(1);
    expect(
      p.query.mock.calls.some((c) =>
        /ALTER TABLE|UPDATE .*migration|schema_migrations.*INSERT/.test(c[0]),
      ),
    ).toBe(false);
  });
  it('reexecutes with the original exact immutable receipt and no new DDL/INSERT', async () => {
    const p = port();
    const a = await installCurrentRuntimeV2In(p);
    p.query.mockClear();
    const b = await installCurrentRuntimeV2In(p);
    expect(b).toEqual(a);
    expect(
      p.query.mock.calls.some((c) => c[0].startsWith('CREATE ') || c[0].startsWith('INSERT ')),
    ).toBe(false);
  });
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])('never adopts raw128 without its private ledger (%s/%s)', async (first, second) => {
    const p = port();
    Object.assign(p.state, { first, second });
    await expect(installCurrentRuntimeV2In(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V2_UNREGISTERED_STAGE',
    );
    expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
  });
  it('read verification cannot install missing extension artifacts', async () => {
    const p = port();
    await expect(verifyCurrentRuntimeV2InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V2_LEDGER_INVALID',
    );
    expect(installCurrentRuntimeIn).not.toHaveBeenCalled();
    expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
  });
  it.each(['owner', 'private', 'columns', 'constraints', 'shape'] as const)(
    'refuses actual catalog %s mismatch rather than accepting a receipt JSON',
    async (field) => {
      const p = port();
      await installCurrentRuntimeV2In(p);
      p.state.catalog[field] = false;
      await expect(verifyCurrentRuntimeV2InstalledIn(p)).rejects.toThrow(
        'CURRENT_RUNTIME_V2_LEDGER_INVALID',
      );
    },
  );
  it('rejects empty/extra/unknown/wronghash receipts and partial reader state', async () => {
    const p = port();
    await installCurrentRuntimeV2In(p);
    const original = p.state.rows[0];
    if (!original) throw new Error('fixture');
    for (const rows of [
      [],
      [original, original],
      [{ ...original, extra: true }],
      [{ ...original, sha256: 'a'.repeat(64) }],
      [{ ...original, parentManifestSha256: 'b'.repeat(64) }],
    ]) {
      p.state.rows = rows;
      await expect(verifyCurrentRuntimeV2InstalledIn(p)).rejects.toThrow(
        'CURRENT_RUNTIME_V2_LEDGER_INVALID',
      );
    }
    p.state.rows = [original];
    p.state.second = false;
    await expect(verifyCurrentRuntimeV2InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V2_READERS_MISSING',
    );
  });
  it('preserves parent/SQL errors for caller atomic rollback without best-effort installation', async () => {
    const p = port(),
      error = new Error('synthetic source SQL failure');
    p.query.mockImplementationOnce(async () => {
      throw error;
    });
    await expect(installCurrentRuntimeV2In(p)).rejects.toBe(error);
  });
});
