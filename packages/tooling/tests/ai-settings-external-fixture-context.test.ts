import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiSettingsEphemeralCredentialDigest,
  parseAiSettingsFixtureContext,
  parseDisposableAiSettingsPg17Proof,
  validateAiSettingsExternalUrl,
  verifyAiSettingsExternalDatabase,
  validateAiSettingsDisposableAdminIdentity,
} from '../../../scripts/fixtures/ai-settings-context.js';
import { publishAiSettingsFixtureCatalog } from '../../../scripts/fixtures/ai-settings-catalog.js';
import { identityApiPort } from '../../../scripts/fixtures/identity-api-port.js';
import { identityE2eRunId } from '../../../scripts/fixtures/identity-e2e-run.js';

// Pure boundary tests: query responses are synthetic and prove no PG/service ownership.
const { query, connect, end } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    query = query;
    connect = connect;
    end = end;
  },
}));
const password = '11111111-1111-4111-8111-111111111111';
const proof = {
  kind: 'disposable-pg17',
  runId: 'fixture-boundary',
  harnessPid: 123,
  hostname: '127.0.0.1',
  port: 50950,
  databaseName: `workout_identity_${'a'.repeat(32)}`,
  databaseOid: 20000,
  ownerRoleOid: 20001,
  adminRole: 'fixture_admin',
  adminRoleOid: 10,
  serverVersionNum: 170006,
  credentialDigest: aiSettingsEphemeralCredentialDigest(password),
  normalMigrations: [{ version: 1, checksum: 'a'.repeat(64) }],
};
const ownerUrl = `postgresql://workout_owner:${password}@127.0.0.1:50950/${proof.databaseName}`;
const metadata = {
  database_oid: proof.databaseOid,
  owner_oid: proof.ownerRoleOid,
  database_name: proof.databaseName,
  server_version: proof.serverVersionNum,
  role_oid: proof.ownerRoleOid,
  direct_role: true,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  owned_tables: 3,
  close_owner: proof.ownerRoleOid,
};
beforeEach(() => {
  query.mockReset();
  connect.mockReset();
  end.mockReset();
  end.mockResolvedValue(undefined);
});
describe('disposable AI fixture external proof boundary', () => {
  it('accepts exact bounded proof and bound ephemeral owner credential', () => {
    expect(parseDisposableAiSettingsPg17Proof(proof)).toEqual(proof);
    expect(validateAiSettingsExternalUrl(ownerUrl, 'owner', proof)).toBe(ownerUrl);
    expect(
      validateAiSettingsExternalUrl(
        ownerUrl.replace(`workout_owner:${password}`, 'fixture_admin:synthetic'),
        'admin',
        proof,
      ),
    ).toContain('fixture_admin');
  });
  it.each([
    { ...proof, extra: true },
    { ...proof, runId: 'default' },
    { ...proof, hostname: 'example.com' },
    { ...proof, port: 0 },
    { ...proof, databaseName: 'workout_identity' },
    { ...proof, databaseOid: 0 },
    { ...proof, ownerRoleOid: 0 },
    { ...proof, serverVersionNum: 160006 },
    { ...proof, normalMigrations: [{ version: 2, checksum: 'a'.repeat(64) }] },
    {
      ...proof,
      normalMigrations: Array.from({ length: 129 }, (_, index) => ({
        version: index + 1,
        checksum: 'a'.repeat(64),
      })),
    },
  ])('rejects malformed, nonisolated or unbounded proof %#', (input) => {
    expect(() => parseDisposableAiSettingsPg17Proof(input)).toThrow();
  });
  it.each([
    ownerUrl.replace('127.0.0.1', 'localhost'),
    ownerUrl.replace('50950', '50951'),
    ownerUrl.replace(proof.databaseName, 'postgres'),
    `${ownerUrl}?host=/tmp/socket`,
    `${ownerUrl}#fragment`,
    ownerUrl.replace('workout_owner', 'workout_runtime'),
    ownerUrl.replace(password, '22222222-2222-4222-8222-222222222222'),
    ownerUrl.replace(password, '%XX'),
    ` ${ownerUrl}`,
  ])('rejects URL/proof identity or credential mismatch %#', (input) => {
    expect(() => validateAiSettingsExternalUrl(input, 'owner', proof)).toThrow();
  });
  it('keeps native schema1 fixed socket/no-password and denies TCP substitution', () => {
    const input = {
      schemaVersion: 1,
      runId: identityE2eRunId,
      apiPort: identityApiPort,
      harnessPid: 123,
      ownerUrl:
        'postgresql://workout_owner@localhost/workout_identity?host=/private/tmp/fixture-only',
      adminUrl:
        'postgresql://workout_admin@localhost/workout_identity?host=/private/tmp/fixture-only',
    };
    expect(parseAiSettingsFixtureContext(input).schemaVersion).toBe(1);
    expect(() => parseAiSettingsFixtureContext({ ...input, ownerUrl })).toThrow();
    expect(() => parseAiSettingsFixtureContext({ ...input, externalProof: proof })).toThrow();
    expect(() =>
      parseAiSettingsFixtureContext({
        ...input,
        ownerUrl: input.ownerUrl.replace('workout_owner@', 'workout_owner:synthetic@'),
      }),
    ).toThrow();
  });
  it('separates schema2 handoff and binds it to the current run and harness', async () => {
    vi.stubEnv('IDENTITY_E2E_RUN_ID', proof.runId);
    vi.resetModules();
    try {
      const contextModule = await import('../../../scripts/fixtures/ai-settings-context.js');
      const input = {
        schemaVersion: 2,
        runId: proof.runId,
        apiPort: identityApiPort,
        harnessPid: proof.harnessPid,
        ownerUrl,
        adminUrl: ownerUrl.replace(`workout_owner:${password}`, 'fixture_admin:synthetic'),
        externalProof: proof,
      };
      expect(contextModule.parseAiSettingsFixtureContext(input).schemaVersion).toBe(2);
      expect(() =>
        contextModule.parseAiSettingsFixtureContext({ ...input, harnessPid: 456 }),
      ).toThrow();
      expect(() =>
        contextModule.parseAiSettingsFixtureContext({ ...input, runId: 'different-run' }),
      ).toThrow();
      expect(() =>
        contextModule.parseAiSettingsFixtureContext({ ...input, extra: true }),
      ).toThrow();
      expect(() =>
        contextModule.parseAiSettingsFixtureContext({ ...input, schemaVersion: 1 }),
      ).toThrow();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  it('accepts catalog query metadata only when identity, plain role and full roster match', async () => {
    query
      .mockResolvedValueOnce({ rows: [metadata] })
      .mockResolvedValueOnce({ rows: proof.normalMigrations });
    await expect(
      verifyAiSettingsExternalDatabase(new Pool(), proof, 'owner'),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('LIMIT 129');
  });
  it.each([
    { ...metadata, database_oid: 20002 },
    { ...metadata, owner_oid: 20002 },
    { ...metadata, role_oid: 20002 },
    { ...metadata, direct_role: false },
    { ...metadata, rolsuper: true },
    { ...metadata, rolbypassrls: true },
    { ...metadata, rolcreatedb: true },
    { ...metadata, rolcreaterole: true },
    { ...metadata, owned_tables: 2 },
    { ...metadata, close_owner: 20002 },
  ])('rejects actual catalog identity/owner capability mismatch %#', async (input) => {
    query.mockResolvedValueOnce({ rows: [input] });
    await expect(verifyAiSettingsExternalDatabase(new Pool(), proof, 'owner')).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects checksum/roster mismatch without accepting same row count', async () => {
    query
      .mockResolvedValueOnce({ rows: [metadata] })
      .mockResolvedValueOnce({ rows: [{ version: 1, checksum: 'b'.repeat(64) }] });
    await expect(verifyAiSettingsExternalDatabase(new Pool(), proof, 'owner')).rejects.toThrow(
      'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_MIGRATIONS',
    );
  });
});

describe('external disposable maintenance admin facts', () => {
  const identity = {
    database_name: 'postgres',
    role_name: 'fixture_admin',
    direct_role: true,
    rolsuper: true,
    rolbypassrls: true,
    rolcreatedb: true,
    rolcreaterole: true,
    server_version: 170006,
  };
  it('accepts only explicit PostgreSQL17 direct maintenance identity', () => {
    expect(validateAiSettingsDisposableAdminIdentity(identity, 'fixture_admin')).toBe(170006);
  });
  it.each([
    { database_name: 'user_database' },
    { role_name: 'other' },
    { direct_role: false },
    { rolsuper: false },
    { rolbypassrls: false },
    { rolcreatedb: false },
    { rolcreaterole: false },
    { server_version: 160006 },
    { extra: 'unknown' },
  ])('rejects substituted or weaker maintenance metadata %#', (changes) => {
    expect(() =>
      validateAiSettingsDisposableAdminIdentity({ ...identity, ...changes }, 'fixture_admin'),
    ).toThrow('INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_ADMIN');
  });
  it('rejects bound admin OID whose actual privileges no longer match', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...metadata, role_oid: proof.adminRoleOid }] });
    await expect(verifyAiSettingsExternalDatabase(new Pool(), proof, 'admin')).rejects.toThrow(
      'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_ADMIN',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('catalog setup failure cleanup and sanitized errors', () => {
  it('does not expose malformed owner credential URL in an error', async () => {
    await expect(
      publishAiSettingsFixtureCatalog('postgresql://secret:%XX@[broken', { selectable: true }),
    ).rejects.toThrow('INVALID_AI_SETTINGS_FIXTURE_OWNER');
    expect(connect).not.toHaveBeenCalled();
  });
  it('ends a failed connection pool before returning a stable credential-free error', async () => {
    connect.mockRejectedValueOnce(new Error('synthetic secret connection input'));
    await expect(
      publishAiSettingsFixtureCatalog(ownerUrl, {
        selectable: true,
        externalProof: parseDisposableAiSettingsPg17Proof(proof),
      }),
    ).rejects.toThrow('AI_SETTINGS_FIXTURE_CONNECTION_FAILED');
    expect(end).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});
