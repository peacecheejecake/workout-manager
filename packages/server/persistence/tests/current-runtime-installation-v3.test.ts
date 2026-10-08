import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type * as ParentInstallation from '../src/current-runtime-installation-v2.js';
import { currentRuntimeMigrationMembers } from '../src/current-runtime-installation.js';
import {
  currentRuntimeV2ExtensionMember,
  installCurrentRuntimeV2In,
  verifyCurrentRuntimeV2InstalledIn,
} from '../src/current-runtime-installation-v2.js';
import {
  currentRuntimeV3ParentManifestSha256,
  currentRuntimeV3ExtensionMember,
  installCurrentRuntimeV3In,
  verifyCurrentRuntimeV3InstalledIn,
} from '../src/current-runtime-installation-v3.js';
vi.mock('../src/current-runtime-installation-v2.js', async (original) => ({
  ...(await original<typeof ParentInstallation>()),
  installCurrentRuntimeV2In: vi.fn(async () => undefined),
  verifyCurrentRuntimeV2InstalledIn: vi.fn(async () => undefined),
}));
beforeEach(() => {
  vi.clearAllMocks();
});
function port() {
  const state = {
    ledger: false,
    reader: false,
    rows: [] as Record<string, unknown>[],
    catalog: { owner: true, private: true, columns: true, constraints: true, shape: true },
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT to_regclass'))
      return {
        rows: [{ ledger: state.ledger, reader: state.reader }],
        rowCount: 1,
      };
    if (sql.startsWith('CREATE TABLE wm_runtime_installation.profile_extension_v3'))
      state.ledger = true;
    if (sql.startsWith('-- Internal retained enumeration only')) {
      state.reader = true;
    }
    if (sql.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v3'))
      state.rows = [
        {
          extensionStep: 1,
          sourceDdlId: 129,
          filename: currentRuntimeV3ExtensionMember.filename,
          sha256: currentRuntimeV3ExtensionMember.sha256,
          parentManifestSha256: currentRuntimeV3ParentManifestSha256,
        },
      ];
    if (sql.startsWith('SELECT\n current_user')) return { rows: [state.catalog], rowCount: 1 };
    if (sql.startsWith('SELECT extension_step'))
      return { rows: state.rows, rowCount: state.rows.length };
    return { rows: [], rowCount: 0 };
  });
  return { state, query };
}
describe('exact runtime v3 extension installer ports (not actual PostgreSQL proof)', () => {
  it('pins the exact canonical historical18 parent tuple manifest', () => {
    const encoded = JSON.stringify({
      encoding: 'current-runtime-profile-v2-parent-manifest-v1',
      profileVersion: 2,
      baselineSchemaVersion: 107,
      runtimeStep: 18,
      members: [
        ...currentRuntimeMigrationMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
        [18, 128, currentRuntimeV2ExtensionMember.filename, currentRuntimeV2ExtensionMember.sha256],
      ],
    });
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(
      currentRuntimeV3ParentManifestSha256,
    );
    expect(currentRuntimeMigrationMembers).toHaveLength(17);
  });
  it('uses the existing lock order/parent installer and writes only extension129 before exact read verification', async () => {
    const p = port();
    const result = await installCurrentRuntimeV3In(p);
    expect(p.query.mock.calls.slice(0, 2).map((c) => c[0])).toEqual([
      'SELECT pg_advisory_xact_lock(872194,1)',
      'SELECT pg_advisory_xact_lock(77210,1)',
    ]);
    expect(installCurrentRuntimeV2In).toHaveBeenCalledWith(p);
    expect(verifyCurrentRuntimeV2InstalledIn).toHaveBeenCalledWith(p);
    expect(result).toMatchObject({
      profileVersion: 3,
      parentRuntimeStep: 18,
      runtimeStep: 19,
      sourceDdlTip: 129,
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
    const a = await installCurrentRuntimeV3In(p);
    p.query.mockClear();
    const b = await installCurrentRuntimeV3In(p);
    expect(b).toEqual(a);
    expect(
      p.query.mock.calls.some((c) => c[0].startsWith('CREATE ') || c[0].startsWith('INSERT ')),
    ).toBe(false);
  });
  it('never adopts raw129 without its private ledger', async () => {
    const p = port();
    p.state.reader = true;
    await expect(installCurrentRuntimeV3In(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_UNREGISTERED_STAGE',
    );
    expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
  });
  it('read verification cannot install missing extension artifacts', async () => {
    const p = port();
    await expect(verifyCurrentRuntimeV3InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_LEDGER_INVALID',
    );
    expect(installCurrentRuntimeV2In).not.toHaveBeenCalled();
    expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
  });
  it.each(['owner', 'private', 'columns', 'constraints', 'shape'] as const)(
    'refuses actual catalog %s mismatch rather than accepting a receipt JSON',
    async (field) => {
      const p = port();
      await installCurrentRuntimeV3In(p);
      p.state.catalog[field] = false;
      await expect(verifyCurrentRuntimeV3InstalledIn(p)).rejects.toThrow(
        'CURRENT_RUNTIME_V3_LEDGER_INVALID',
      );
    },
  );
  it('rejects empty/extra/unknown/wronghash receipts and partial reader state', async () => {
    const p = port();
    await installCurrentRuntimeV3In(p);
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
      await expect(verifyCurrentRuntimeV3InstalledIn(p)).rejects.toThrow(
        'CURRENT_RUNTIME_V3_LEDGER_INVALID',
      );
    }
    p.state.rows = [original];
    p.state.reader = false;
    await expect(verifyCurrentRuntimeV3InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_READERS_MISSING',
    );
  });
  it('preserves parent/SQL errors for caller atomic rollback without best-effort installation', async () => {
    const p = port(),
      error = new Error('synthetic source SQL failure');
    p.query.mockImplementationOnce(async () => {
      throw error;
    });
    await expect(installCurrentRuntimeV3In(p)).rejects.toBe(error);
  });
  it('denies a failed actual parent verification before any successor DDL', async () => {
    const p = port();
    const failure = new Error('CURRENT_RUNTIME_V2_LEDGER_INVALID');
    vi.mocked(verifyCurrentRuntimeV2InstalledIn).mockRejectedValueOnce(failure);
    await expect(installCurrentRuntimeV3In(p)).rejects.toBe(failure);
    expect(
      p.query.mock.calls.some((c) => c[0].startsWith('CREATE ') || c[0].startsWith('INSERT ')),
    ).toBe(false);
  });
  it('rejects malformed presence observations without fabricating absence', async () => {
    const p = port();
    p.query.mockImplementation(async (sql) => ({
      rows: sql.startsWith('SELECT to_regclass')
        ? [{ ledger: false, reader: false, unknown: true }]
        : [],
      rowCount: 0,
    }));
    await expect(installCurrentRuntimeV3In(p)).rejects.toThrow('CURRENT_RUNTIME_V3_LEDGER_INVALID');
    expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
  });
});
