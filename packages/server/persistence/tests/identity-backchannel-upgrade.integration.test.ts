import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createIdentityRepository } from '../src/identity.js';
import { grantIdentityFunctions, migrate, migrationFileNames } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const databaseName = `workout_bc_${randomUUID().replaceAll('-', '')}`;
const ownerRole = `workout_bc_owner_${randomUUID().replaceAll('-', '')}`;
function inDatabase(url: string): string {
  const value = new URL(url);
  value.pathname = `/${databaseName}`;
  return value.href;
}
function asMigrationOwner(url: string): string {
  const value = new URL(inDatabase(url));
  value.username = ownerRole;
  value.password = '';
  return value.href;
}

it('expires legacy sessions and removes the granted seven-argument login bypass on upgrade', async () => {
  const admin = new Pool({ connectionString: adminUrl });
  let runtime: Pool | undefined;
  let repository: ReturnType<typeof createIdentityRepository> | undefined;
  try {
    await admin.query(
      `CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
    const owner = asMigrationOwner(adminUrl);
    const guest = inDatabase(runtimeUrl);
    const versionBefore = migrationFileNames.findIndex(
      (file) => file === '057_oidc_backchannel.sql',
    );
    expect(versionBefore).toBeGreaterThan(0);
    await migrate(owner, versionBefore);
    const upgradeAdmin = new Pool({ connectionString: owner });
    try {
      await upgradeAdmin.query(
        'GRANT EXECUTE ON FUNCTION public.auth_create_session(text,text,text,text,timestamptz,timestamptz,text) TO workout_runtime',
      );
      runtime = new Pool({ connectionString: guest });
      const tokenHash = hash(randomUUID());
      const now = new Date();
      const args = [
        tokenHash,
        hash(randomUUID()),
        'https://id.example',
        randomUUID(),
        new Date(now.getTime() + 3_600_000),
        now,
        null,
      ];
      const oldSession = await runtime.query(
        'SELECT * FROM public.auth_create_session($1,$2,$3,$4,$5,$6,$7)',
        args,
      );
      expect(oldSession.rowCount).toBe(1);
      expect(
        (
          await upgradeAdmin.query(
            'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
          )
        ).rows[0],
      ).toMatchObject({ rolsuper: false, rolbypassrls: false });
      expect(
        (
          await upgradeAdmin.query(
            "SELECT relrowsecurity FROM pg_class WHERE oid = 'identity_private.session'::regclass",
          )
        ).rows[0],
      ).toMatchObject({ relrowsecurity: false });
      expect(
        (
          await upgradeAdmin.query('SELECT 1 FROM identity_private.session WHERE token_hash=$1', [
            tokenHash,
          ])
        ).rowCount,
      ).toBe(1);

      await migrate(owner);
      await grantIdentityFunctions(owner, 'workout_runtime');
      expect(
        (
          await upgradeAdmin.query('SELECT 1 FROM identity_private.session WHERE token_hash=$1', [
            tokenHash,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await upgradeAdmin.query(
            "SELECT to_regprocedure('public.auth_create_session(text,text,text,text,timestamptz,timestamptz,text)') AS legacy",
          )
        ).rows[0]?.legacy,
      ).toBeNull();
      await expect(
        runtime.query('SELECT * FROM public.auth_create_session($1,$2,$3,$4,$5,$6,$7)', args),
      ).rejects.toMatchObject({ code: '42883' });

      repository = createIdentityRepository({ connectionString: guest });
      const current = {
        tokenHash: hash(randomUUID()),
        csrfToken: hash(randomUUID()),
        issuer: 'https://id.example',
        subject: randomUUID(),
        providerSessionId: 'current-op-sid',
        now: new Date(),
        loginStartedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      await repository.createSession(current);
      expect(
        await repository.revokeProviderSessions({
          issuer: current.issuer,
          jtiHash: hash(randomUUID()),
          issuedAt: new Date(),
          providerSessionId: current.providerSessionId,
        }),
      ).toBe(true);
      expect(await repository.findSession(current.tokenHash, new Date())).toBeNull();
    } finally {
      await repository?.close();
      await runtime?.end();
      await upgradeAdmin.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
    await admin.end();
  }
}, 60_000);
