import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createIdentityRepository, type IdentityRepository } from '../src/identity.js';
import { migrate, grantIdentityFunctions } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let repository: IdentityRepository;
const hash = (input = randomUUID()) => createHash('sha256').update(input).digest('hex');
const attempt = () => ({
  stateHash: hash(),
  browserHash: hash(),
  nonce: randomUUID(),
  verifier: 'a'.repeat(43),
  expiresAt: new Date(Date.now() + 60_000),
});
const session = () => ({
  tokenHash: hash(),
  csrfToken: hash(),
  issuer: 'https://id.example',
  subject: randomUUID(),
  now: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
});
beforeAll(async () => {
  await migrate(adminUrl);
  await grantIdentityFunctions(adminUrl, 'workout_runtime');
  repository = createIdentityRepository({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await repository?.close();
  await admin.end();
  await runtime.end();
});

describe('M1-01 identity private persistence', () => {
  it('atomically consumes a browser-bound login attempt once under concurrency', async () => {
    const input = attempt();
    await repository.createAttempt(input);
    expect(await repository.consumeAttempt(input.stateHash, hash(), new Date())).toBeNull();
    const results = await Promise.all([
      repository.consumeAttempt(input.stateHash, input.browserHash, new Date()),
      repository.consumeAttempt(input.stateHash, input.browserHash, new Date()),
    ]);
    expect(results.filter(Boolean)).toEqual([{ nonce: input.nonce, verifier: input.verifier }]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });
  it('rejects expired attempts and deletes them without nonce exposure', async () => {
    const input = attempt();
    await repository.createAttempt(input);
    expect(
      await repository.consumeAttempt(
        input.stateHash,
        input.browserHash,
        new Date(input.expiresAt.getTime() + 1),
      ),
    ).toBeNull();
    const row = await admin.query(
      'SELECT * FROM identity_private.login_attempt WHERE state_hash = $1',
      [input.stateHash],
    );
    expect(row.rowCount).toBe(0);
  });
  it('bounds login and session expiry instead of allowing permanent credentials', async () => {
    await expect(
      repository.createAttempt({ ...attempt(), expiresAt: new Date(Date.now() + 60 * 60_000) }),
    ).rejects.toThrow();
    const input = session();
    await expect(
      repository.createSession({
        ...input,
        expiresAt: new Date(input.now.getTime() + 25 * 60 * 60_000),
      }),
    ).rejects.toThrow();
  });
  it('maps issuer and subject, never email, to a stable identity', async () => {
    const input = session();
    const first = await repository.createSession(input);
    const second = await repository.createSession({ ...input, tokenHash: hash() });
    const otherIssuer = await repository.createSession({
      ...input,
      tokenHash: hash(),
      issuer: 'https://other.example',
    });
    expect(second.athleteId).toBe(first.athleteId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(otherIssuer.athleteId).not.toBe(first.athleteId);
    const stored = await repository.findSession(input.tokenHash, input.now);
    expect(stored).toEqual({ ...first, csrfToken: input.csrfToken, expiresAt: input.expiresAt });
  });
  it('expires and revokes sessions, with no raw bearer token column', async () => {
    const input = session();
    await repository.createSession(input);
    expect(await repository.findSession(input.tokenHash, input.expiresAt)).toBeNull();
    await repository.revokeSession(input.tokenHash);
    expect(await repository.findSession(input.tokenHash, input.now)).toBeNull();
    const columns = await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='identity_private' AND table_name='session'",
    );
    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).not.toContain(
      'token',
    );
  });
  it('rotates sessions atomically and rolls back revocation when replacement fails', async () => {
    const original = session();
    await repository.createSession(original);
    const duplicate = session();
    await repository.createSession(duplicate);
    await expect(
      repository.createSession({ ...duplicate, previousTokenHash: original.tokenHash }),
    ).rejects.toThrow();
    expect(await repository.findSession(original.tokenHash, original.now)).not.toBeNull();
    const replacement = { ...original, tokenHash: hash(), previousTokenHash: original.tokenHash };
    await repository.createSession(replacement);
    expect(await repository.findSession(original.tokenHash, original.now)).toBeNull();
    expect(await repository.findSession(replacement.tokenHash, original.now)).not.toBeNull();
  });
  it('denies runtime table access and PUBLIC function execution', async () => {
    await expect(runtime.query('SELECT * FROM identity_private.session')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(runtime.query('SELECT * FROM identity_private.account')).rejects.toMatchObject({
      code: '42501',
    });
    const result = await admin.query(
      "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, LATERAL aclexplode(p.proacl) acl WHERE n.nspname='public' AND p.proname LIKE 'auth_%' AND acl.grantee=0 AND acl.privilege_type='EXECUTE'",
    );
    expect(result.rows).toEqual([]);
  });
  it('rejects privileged identity runtime credentials', async () => {
    const unsafe = createIdentityRepository({ connectionString: adminUrl });
    try {
      await expect(unsafe.findSession(hash(), new Date())).rejects.toThrow();
    } finally {
      await unsafe.close();
    }
  });
});
