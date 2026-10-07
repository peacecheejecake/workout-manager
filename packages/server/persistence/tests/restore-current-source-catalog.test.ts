import { describe, expect, it } from 'vitest';
import {
  captureCurrentSourceCatalogIn,
  readCurrentSourceCatalogFingerprintIn,
  type CurrentSourceCatalogProfile,
  type CurrentSourceCaptureTransaction,
} from '../src/restore-current-source-catalog.js';
const profile: CurrentSourceCatalogProfile = {
  profileVersion: 1,
  normalSchemaVersion: 107,
  explicitPins: Array.from({ length: 9 }, (_, i) => ({
    version: 108 + i,
    checksum: 'a'.repeat(64),
  })),
  normalRegistry: Array.from({ length: 107 }, (_, i) => ({
    version: i + 1,
    checksum: 'b'.repeat(64),
  })),
  schemas: ['public'],
  relations: [{ schema: 'public', name: 'example' }],
  roles: [{ tag: 'backup', name: 'offline' }],
  source: { databaseName: 'capture', databaseOid: '42', systemIdentifier: '123' },
  operator: { roleName: 'offline', roleOid: '43', superuser: true, bypassRls: false },
};
function port() {
  const calls: string[] = [];
  return {
    calls,
    tx: {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } satisfies CurrentSourceCaptureTransaction,
  };
}
describe('current source catalog untrusted ingress and read prerequisites (query mocks, not PG evidence)', () => {
  it.each([
    { ...profile, normalSchemaVersion: 118 },
    { ...profile, explicitPins: profile.explicitPins.slice(0, 8) },
    { ...profile, explicitPins: profile.explicitPins.map((p) => ({ ...p, version: 108 })) },
    { ...profile, roles: [...profile.roles, { tag: 'runtime', name: 'offline' }] },
    { ...profile, relations: [...profile.relations, ...profile.relations] },
    { ...profile, relations: [{ schema: 'public', name: 'unsafe";select' }] },
    { ...profile, untrustedAuthority: true },
  ])('rejects malformed or mismatched installed profiles before query %#', async (input) => {
    const { tx, calls } = port();
    await expect(readCurrentSourceCatalogFingerprintIn(tx, input)).rejects.toMatchObject({
      code: 'INVALID_PROFILE',
    });
    expect(calls).toEqual([]);
  });
  it('rejects accessor/sparse/cyclic/oversize plain ingress without reading getter or issuing SQL', async () => {
    let invoked = false;
    const accessor = { ...profile };
    Object.defineProperty(accessor, 'source', {
      enumerable: true,
      get() {
        invoked = true;
        return profile.source;
      },
    });
    const sparse = { ...profile, schemas: new Array(2) };
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const input of [
      accessor,
      sparse,
      cyclic,
      { ...profile, extra: '한'.repeat(6 * 1024 * 1024) },
    ]) {
      const { tx, calls } = port();
      await expect(readCurrentSourceCatalogFingerprintIn(tx, input)).rejects.toThrow();
      expect(calls).toEqual([]);
    }
    expect(invoked).toBe(false);
  });
  it('rejects missing actual transaction context and does not reach metadata or census', async () => {
    const { tx, calls } = port();
    await expect(
      captureCurrentSourceCatalogIn(tx, { ...profile, catalogSha256: 'c'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'SOURCE_CONTEXT_MISMATCH' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('pg_control_system');
    expect(calls[0]).not.toContain('pg_column_size');
  });
});

// Query fixture exercises strict metadata decoding only, never actual visibility/authentication.
function catalogPort(options: unknown) {
  const catalog = {
    database: {
      owner: 'backup',
      encoding: 'UTF8',
      collation: 'C',
      ctype: 'C',
      locale: null,
      collationVersion: null,
      allowConnections: true,
      connectionLimit: -1,
      rawAcl: null,
      acl: [],
    },
    defaultPrivileges: [],
    schemas: [{ name: 'public', owner: 'backup', rawAcl: null, acl: [] }],
    relations: [],
    functions: [],
    extensions: [],
    registry: profile.normalRegistry,
    roles: [
      {
        tag: 'backup',
        name: 'offline',
        oid: '43',
        superuser: true,
        bypassRls: false,
        inherit: true,
        createDb: false,
        createRole: false,
        login: true,
        replication: false,
        connectionLimit: -1,
        config: null,
        memberships: [
          {
            role: 'backup',
            member: 'backup',
            grantor: 'backup',
            adminOption: false,
            ...(typeof options === 'object' && options !== null ? options : {}),
          },
        ],
      },
    ],
  };
  const tx: CurrentSourceCaptureTransaction = {
    query: async (sql) => {
      if (sql.startsWith('SELECT current_database()'))
        return {
          rows: [
            {
              databaseName: 'capture',
              databaseOid: '42',
              currentRole: 'offline',
              sessionRole: 'offline',
              roleOid: '43',
              superuser: true,
              bypassRls: false,
              isolation: 'repeatable read',
              readOnly: true,
              transactionSnapshot: '10:12:',
              statementTimeout: '10000',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('nspname AS name')) return { rows: [{ name: 'public' }], rowCount: 1 };
      if (sql.includes('has_table_privilege'))
        return {
          rows: [{ schema: 'public', name: 'example', kind: 'r', readable: true, filtered: false }],
          rowCount: 1,
        };
      if (sql.includes('pg_control_system')) return { rows: [{ id: '123' }], rowCount: 1 };
      if (sql.includes('AS relations,'))
        return { rows: [{ relations: 1, functions: 0 }], rowCount: 1 };
      if (sql.includes('AS digest FROM payload'))
        return { rows: [{ bytes: '1000', digest: 'c'.repeat(64) }], rowCount: 1 };
      if (sql.includes('AS catalog FROM payload')) return { rows: [{ catalog }], rowCount: 1 };
      if (sql.includes('pg_column_size'))
        return { rows: [{ rows: '0', rowStorageBytes: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return tx;
}
it.each([
  { inheritOption: false, setOption: true },
  { inheritOption: null, setOption: null },
])('preserves actual/null membership options without default privilege truth', async (options) => {
  const c = await captureCurrentSourceCatalogIn(catalogPort(options), {
    ...profile,
    catalogSha256: 'c'.repeat(64),
  });
  expect(c.catalog.roles[0]?.memberships[0]).toMatchObject(options);
  expect(c.authentication).toBe('not_captured');
});
it.each([
  { inheritOption: 'true', setOption: false },
  { inheritOption: true },
  { inheritOption: false, setOption: false, trust: true },
])('rejects malformed/missing/extra membership flags', async (options) => {
  await expect(
    captureCurrentSourceCatalogIn(catalogPort(options), {
      ...profile,
      catalogSha256: 'c'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'CATALOG_UNSUPPORTED' });
});
