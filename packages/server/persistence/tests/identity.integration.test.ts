import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createIdentityRepository, type IdentityRepository } from '../src/identity.js';
import { migrate, grantIdentityFunctions, grantOperations } from '../src/migrate.js';

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
  loginStartedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
});
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
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
    expect(results.filter(Boolean)).toEqual([
      { nonce: input.nonce, verifier: input.verifier, createdAt: expect.any(Date) },
    ]);
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

describe('EXT-BACKCHANNEL atomic provider logout', () => {
  async function waitForAdvisoryWait(fragment: string) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND position($1 in query)>0 AND pid<>pg_backend_pid()",
        [fragment],
      );
      if (result.rowCount) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Expected ${fragment} to wait on the logout barrier`);
  }
  const logout = (
    overrides: Partial<Parameters<IdentityRepository['revokeProviderSessions']>[0]> = {},
  ) => ({
    issuer: 'https://id.example',
    jtiHash: hash(),
    issuedAt: new Date(),
    subject: 'logout-subject',
    ...overrides,
  });

  it('revokes only the exact issuer and subject, preserving another tenant and issuer', async () => {
    const first = { ...session(), subject: 'logout-subject', providerSessionId: 'sid-a' };
    const second = { ...session(), subject: 'another-subject', providerSessionId: 'sid-b' };
    const otherIssuer = {
      ...session(),
      issuer: 'https://other.example',
      subject: 'logout-subject',
    };
    await Promise.all([first, second, otherIssuer].map((value) => repository.createSession(value)));
    expect(await repository.revokeProviderSessions(logout())).toBe(true);
    expect(await repository.findSession(first.tokenHash, new Date())).toBeNull();
    expect(await repository.findSession(second.tokenHash, new Date())).not.toBeNull();
    expect(await repository.findSession(otherIssuer.tokenHash, new Date())).not.toBeNull();
  });

  it('sid-only revokes one provider session, while subject plus sid requires both identifiers', async () => {
    const a = { ...session(), subject: 'sid-subject', providerSessionId: 'sid-only-a' };
    const b = { ...session(), subject: 'sid-subject', providerSessionId: 'sid-only-b' };
    await Promise.all([a, b].map((value) => repository.createSession(value)));
    expect(
      await repository.revokeProviderSessions({
        issuer: 'https://id.example',
        jtiHash: hash(),
        issuedAt: new Date(),
        providerSessionId: 'sid-only-a',
      }),
    ).toBe(true);
    expect(await repository.findSession(a.tokenHash, new Date())).toBeNull();
    expect(await repository.findSession(b.tokenHash, new Date())).not.toBeNull();
    expect(
      await repository.revokeProviderSessions(
        logout({ subject: 'wrong-subject', providerSessionId: 'sid-only-b' }),
      ),
    ).toBe(true);
    expect(await repository.findSession(b.tokenHash, new Date())).not.toBeNull();
  });

  it('accepts one concurrent jti once and rolls back invalid claims without a ledger entry', async () => {
    const input = { ...session(), subject: 'replay-subject' };
    await repository.createSession(input);
    const claims = logout({ subject: input.subject });
    const accepted = await Promise.all([
      repository.revokeProviderSessions(claims),
      repository.revokeProviderSessions(claims),
    ]);
    expect(accepted.sort()).toEqual([false, true]);
    expect(await repository.findSession(input.tokenHash, new Date())).toBeNull();
    const delayed = logout({ subject: input.subject, issuedAt: new Date(Date.now() - 360_000) });
    await expect(repository.revokeProviderSessions(delayed)).rejects.toThrow();
    const ledger = await admin.query(
      'SELECT 1 FROM identity_private.logout_token_replay WHERE issuer=$1 AND jti_hash=$2',
      [delayed.issuer, delayed.jtiHash],
    );
    expect(ledger.rowCount).toBe(0);
    await expect(
      runtime.query('SELECT * FROM identity_private.logout_token_replay'),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('serializes logout before a pending callback and refuses recreation after 204', async () => {
    const subject = randomUUID();
    const providerSessionId = randomUUID();
    const loginAttempt = attempt();
    await repository.createAttempt(loginAttempt);
    const consumed = await repository.consumeAttempt(
      loginAttempt.stateHash,
      loginAttempt.browserHash,
      new Date(),
    );
    if (consumed === null) throw new Error('Missing login attempt');
    const pendingSession = {
      ...session(),
      subject,
      providerSessionId,
      loginStartedAt: consumed.createdAt,
    };
    const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77207))', [
        `oidc-sub:https://id.example:${subject}`,
      ]);
      const pendingLogout = repository.revokeProviderSessions(
        logout({ subject, providerSessionId }),
      );
      await waitForAdvisoryWait('auth_revoke_provider_sessions');
      const pendingCreate = repository.createSession(pendingSession).then(
        () => 'created',
        (error: unknown) => (error instanceof Error ? error.message : 'unexpected error'),
      );
      await waitForAdvisoryWait('auth_create_session');
      await blocker.query('COMMIT');
      expect(await pendingLogout).toBe(true);
      expect(await pendingCreate).toBe('LOGIN_REVOKED');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect(await repository.findSession(pendingSession.tokenHash, new Date())).toBeNull();
    const fresh = {
      ...session(),
      subject,
      providerSessionId: randomUUID(),
      // This login began before the logout too, but belongs to a different OP sid.
      loginStartedAt: consumed.createdAt,
    };
    expect((await repository.createSession(fresh)).athleteId).toBeTruthy();
  });

  it('lets a callback created first be revoked before logout returns', async () => {
    const pendingSession = {
      ...session(),
      subject: randomUUID(),
      providerSessionId: randomUUID(),
    };
    const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77207))', [
        `oidc-sub:https://id.example:${pendingSession.subject}`,
      ]);
      const pendingCreate = repository.createSession(pendingSession);
      await waitForAdvisoryWait('auth_create_session');
      const pendingLogout = repository.revokeProviderSessions(
        logout({
          subject: pendingSession.subject,
          providerSessionId: pendingSession.providerSessionId,
        }),
      );
      await waitForAdvisoryWait('auth_revoke_provider_sessions');
      await blocker.query('COMMIT');
      expect((await pendingCreate).athleteId).toBeTruthy();
      expect(await pendingLogout).toBe(true);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect(await repository.findSession(pendingSession.tokenHash, new Date())).toBeNull();
  });

  it('blocks an old subject-only login but allows a new login started after logout', async () => {
    const subject = randomUUID();
    const oldStart = new Date();
    expect(await repository.revokeProviderSessions(logout({ subject }))).toBe(true);
    await expect(
      repository.createSession({ ...session(), subject, loginStartedAt: oldStart }),
    ).rejects.toThrow('LOGIN_REVOKED');
    const newAttempt = attempt();
    await repository.createAttempt(newAttempt);
    const consumed = await repository.consumeAttempt(
      newAttempt.stateHash,
      newAttempt.browserHash,
      new Date(),
    );
    if (consumed === null) throw new Error('Missing new login attempt');
    const newSession = { ...session(), subject, loginStartedAt: consumed.createdAt };
    expect((await repository.createSession(newSession)).athleteId).toBeTruthy();
  });
});
