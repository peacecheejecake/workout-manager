import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type * as ParentInstallation from '../src/current-runtime-installation-v5.js';
import { readFile } from 'node:fs/promises';
import { currentRuntimeMigrationMembers } from '../src/current-runtime-installation.js';
import { currentRuntimeV3ExtensionMember } from '../src/current-runtime-installation-v3.js';
import { currentRuntimeV2ExtensionMember } from '../src/current-runtime-installation-v2.js';
import { currentRuntimeV4ExtensionMember } from '../src/current-runtime-installation-v4.js';
import {
  currentRuntimeV5ExtensionMember,
  installCurrentRuntimeV5In,
  verifyCurrentRuntimeV5InstalledIn,
} from '../src/current-runtime-installation-v5.js';
import {
  currentRuntimeV6ParentManifestSha256,
  currentRuntimeV6ExtensionMember,
  installCurrentRuntimeV6In,
  verifyCurrentRuntimeV6InstalledIn,
} from '../src/current-runtime-installation-v6.js';
vi.mock('../src/current-runtime-installation-v5.js', async (original) => ({
  ...(await original<typeof ParentInstallation>()),
  installCurrentRuntimeV5In: vi.fn(async () => undefined),
  verifyCurrentRuntimeV5InstalledIn: vi.fn(async () => undefined),
}));
beforeEach(() => {
  vi.clearAllMocks();
});
function port() {
  const state = {
    rpc: {
      owner: true,
      language: 'plpgsql',
      resultType: 'jsonb',
      definer: true,
      volatility: 'v',
      parallel: 'u',
      strict: false,
      setReturning: false,
      configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
      privatePublic: true,
      safeDelegation: true,
      body: '',
    },
    ledger: false,
    batch: false,
    rows: [] as Record<string, unknown>[],
    catalog: { owner: true, private: true, columns: true, constraints: true, shape: true },
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT to_regclass'))
      return {
        rows: [
          {
            ledger: state.ledger,
            batch: state.batch,
          },
        ],
        rowCount: 1,
      };
    if (sql.startsWith('CREATE TABLE wm_runtime_installation.profile_extension_v6'))
      state.ledger = true;
    if (sql.startsWith('-- Additive same-RR server-private batch.')) {
      state.batch = true;
      state.rpc.body = sql.split('$$')[1] ?? '';
    }
    if (sql.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v6'))
      state.rows = [
        {
          extensionStep: 1,
          sourceDdlId: 132,
          filename: currentRuntimeV6ExtensionMember.filename,
          sha256: currentRuntimeV6ExtensionMember.sha256,
          parentManifestSha256: currentRuntimeV6ParentManifestSha256,
        },
      ];
    if (sql.startsWith('SELECT\n current_user')) return { rows: [state.catalog], rowCount: 1 };
    if (sql.startsWith('SELECT p.proowner')) return { rows: [state.rpc], rowCount: 1 };
    if (sql.startsWith('SELECT extension_step'))
      return { rows: state.rows, rowCount: state.rows.length };
    return { rows: [], rowCount: 0 };
  });
  return { state, query };
}
describe('exact runtime v6 extension installer ports (not actual PostgreSQL proof)', () => {
  it('pins the exact canonical historical21 parent tuple manifest', () => {
    const encoded = JSON.stringify({
      encoding: 'current-runtime-profile-v5-parent-manifest-v1',
      profileVersion: 5,
      baselineSchemaVersion: 107,
      runtimeStep: 21,
      members: [
        ...currentRuntimeMigrationMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
        [18, 128, currentRuntimeV2ExtensionMember.filename, currentRuntimeV2ExtensionMember.sha256],
        [19, 129, currentRuntimeV3ExtensionMember.filename, currentRuntimeV3ExtensionMember.sha256],
        [20, 130, currentRuntimeV4ExtensionMember.filename, currentRuntimeV4ExtensionMember.sha256],
        [21, 131, currentRuntimeV5ExtensionMember.filename, currentRuntimeV5ExtensionMember.sha256],
      ],
    });
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(
      currentRuntimeV6ParentManifestSha256,
    );
    expect(currentRuntimeMigrationMembers).toHaveLength(17);
  });
  it('uses the existing lock order/parent installer and writes only extension132 before exact read verification', async () => {
    const p = port();
    const result = await installCurrentRuntimeV6In(p);
    expect(p.query.mock.calls.slice(0, 2).map((c) => c[0])).toEqual([
      'SELECT pg_advisory_xact_lock(872194,1)',
      'SELECT pg_advisory_xact_lock(77210,1)',
    ]);
    expect(installCurrentRuntimeV5In).toHaveBeenCalledWith(p);
    expect(verifyCurrentRuntimeV5InstalledIn).toHaveBeenCalledWith(p);
    expect(result).toMatchObject({
      profileVersion: 6,
      parentRuntimeStep: 21,
      runtimeStep: 22,
      sourceDdlTip: 132,
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
    const a = await installCurrentRuntimeV6In(p);
    p.query.mockClear();
    const b = await installCurrentRuntimeV6In(p);
    expect(b).toEqual(a);
    expect(
      p.query.mock.calls.some((c) => c[0].startsWith('CREATE ') || c[0].startsWith('INSERT ')),
    ).toBe(false);
  });
  it.each(['batch'] as const)(
    'never adopts partial raw132 %s without its private ledger',
    async (object) => {
      const p = port();
      p.state[object] = true;
      await expect(installCurrentRuntimeV6In(p)).rejects.toThrow(
        'CURRENT_RUNTIME_V6_UNREGISTERED_STAGE',
      );
      expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
    },
  );
  it('read verification cannot install missing extension artifacts', async () => {
    const p = port();
    await expect(verifyCurrentRuntimeV6InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V6_LEDGER_INVALID',
    );
    expect(installCurrentRuntimeV5In).not.toHaveBeenCalled();
    expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
  });
  it.each(['owner', 'private', 'columns', 'constraints', 'shape'] as const)(
    'refuses actual catalog %s mismatch rather than accepting a receipt JSON',
    async (field) => {
      const p = port();
      await installCurrentRuntimeV6In(p);
      p.state.catalog[field] = false;
      await expect(verifyCurrentRuntimeV6InstalledIn(p)).rejects.toThrow(
        'CURRENT_RUNTIME_V6_LEDGER_INVALID',
      );
    },
  );
  it('rejects empty/extra/unknown/wronghash receipts and partial ACK state', async () => {
    const p = port();
    await installCurrentRuntimeV6In(p);
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
      await expect(verifyCurrentRuntimeV6InstalledIn(p)).rejects.toThrow(
        'CURRENT_RUNTIME_V6_LEDGER_INVALID',
      );
    }
    p.state.rows = [original];
    p.state.batch = false;
    await expect(verifyCurrentRuntimeV6InstalledIn(p)).rejects.toThrow(
      'CURRENT_RUNTIME_V6_BATCH_MISSING',
    );
  });
  it('preserves parent/SQL errors for caller atomic rollback without best-effort installation', async () => {
    const p = port(),
      error = new Error('synthetic source SQL failure');
    p.query.mockImplementationOnce(async () => {
      throw error;
    });
    await expect(installCurrentRuntimeV6In(p)).rejects.toBe(error);
  });
  it('denies a failed actual parent verification before any successor DDL', async () => {
    const p = port();
    const failure = new Error('CURRENT_RUNTIME_V6_LEDGER_INVALID');
    vi.mocked(verifyCurrentRuntimeV5InstalledIn).mockRejectedValueOnce(failure);
    await expect(installCurrentRuntimeV6In(p)).rejects.toBe(failure);
    expect(
      p.query.mock.calls.some((c) => c[0].startsWith('CREATE ') || c[0].startsWith('INSERT ')),
    ).toBe(false);
  });
  it('rejects malformed presence observations without fabricating absence', async () => {
    const p = port();
    p.query.mockImplementation(async (sql) => ({
      rows: sql.startsWith('SELECT to_regclass')
        ? [
            {
              ledger: false,
              batch: false,
              unknown: true,
            },
          ]
        : [],
      rowCount: 0,
    }));
    await expect(installCurrentRuntimeV6In(p)).rejects.toThrow('CURRENT_RUNTIME_V6_LEDGER_INVALID');
    expect(p.query.mock.calls.some((c) => c[0].startsWith('CREATE '))).toBe(false);
  });
});

it.each([
  'body',
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
] as const)('refuses batch %s drift while preserving exact ledger', async (field) => {
  const p = port();
  await installCurrentRuntimeV6In(p);
  const wrong: Record<string, unknown> = {
    ...p.state.rpc,
    [field]:
      field === 'body'
        ? 'BEGIN RETURN null; END;'
        : field === 'configuration'
          ? []
          : field === 'language' ||
              field === 'resultType' ||
              field === 'volatility' ||
              field === 'parallel'
            ? 'unexpected'
            : !p.state.rpc[field],
  };
  p.query.mockImplementation(async (sql) => ({
    rows: sql.startsWith('SELECT to_regclass')
      ? [{ ledger: true, batch: true }]
      : sql.startsWith('SELECT\n current_user')
        ? [p.state.catalog]
        : sql.startsWith('SELECT extension_step')
          ? p.state.rows
          : sql.startsWith('SELECT p.proowner')
            ? [wrong]
            : [],
    rowCount: 1,
  }));
  await expect(verifyCurrentRuntimeV6InstalledIn(p)).rejects.toThrow(
    'CURRENT_RUNTIME_V6_BATCH_DRIFT',
  );
});
it('pins source132 bytes and uses that exact function body, not caller digest input', async () => {
  const sql = await readFile(
    new URL('../migrations/132_manual_retained_source_export_batch.sql', import.meta.url),
    'utf8',
  );
  expect(createHash('sha256').update(sql).digest('hex')).toBe(
    currentRuntimeV6ExtensionMember.sha256,
  );
  const p = port();
  await installCurrentRuntimeV6In(p);
  expect(p.state.rpc.body).toBe(sql.split('$$')[1]);
});
it('bounds actual prosrc transfer before decoding and permits only non-delegating foreign EXECUTE', async () => {
  const p = port();
  await installCurrentRuntimeV6In(p);
  const call = p.query.mock.calls.find(([sql]) => sql.startsWith('SELECT p.proowner'));
  expect(call?.[0]).toContain('CASE WHEN octet_length(p.prosrc)=$2 THEN p.prosrc ELSE NULL END');
  expect(call?.[0]).toContain('a.grantee=0');
  expect(call?.[0]).toContain(
    "a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable)",
  );
  await expect(verifyCurrentRuntimeV6InstalledIn(p)).resolves.toMatchObject({
    supported: false,
    processingAuthority: 'none',
  });
});
