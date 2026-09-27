import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentityRepository, type IdentityRepository } from '../src/identity.js';
import { grantIdentityFunctions, migrate } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');

const admin = new Pool({ connectionString: adminUrl });
let repository: IdentityRepository;
const hash = (value = randomUUID()) => createHash('sha256').update(value).digest('hex');
const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
const anotherChallenge = createHash('sha256').update('w'.repeat(43)).digest('base64url');

beforeAll(async () => {
  await migrate(adminUrl);
  await grantIdentityFunctions(adminUrl, 'workout_runtime');
  repository = createIdentityRepository({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await repository?.close();
  await admin.end();
});

describe('M3-01c native OIDC persistence', () => {
  it('consumes the native state once, independent of a browser cookie', async () => {
    const input = {
      stateHash: hash(),
      nonce: randomUUID(),
      verifier: 'a'.repeat(43),
      codeChallenge: challenge,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await repository.createNativeAttempt(input);
    expect(await repository.consumeNativeAttempt(hash(), new Date())).toBeNull();
    const results = await Promise.all([
      repository.consumeNativeAttempt(input.stateHash, new Date()),
      repository.consumeNativeAttempt(input.stateHash, new Date()),
    ]);
    expect(results.filter(Boolean)).toEqual([
      {
        nonce: input.nonce,
        verifier: input.verifier,
        codeChallenge: input.codeChallenge,
        createdAt: expect.any(Date),
      },
    ]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it('binds a short-lived code to PKCE and atomically creates only one native session', async () => {
    const now = new Date();
    const codeHash = hash();
    await repository.createNativeCode({
      codeHash,
      codeChallenge: challenge,
      issuer: 'https://id.example',
      subject: randomUUID(),
      loginStartedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    const tokenHash = hash();
    const request = {
      codeHash,
      codeChallenge: challenge,
      tokenHash,
      csrfToken: hash(),
      expiresAt: new Date(now.getTime() + 3_600_000),
      now,
    };
    expect(
      await repository.exchangeNativeCode({ ...request, codeChallenge: anotherChallenge }),
    ).toBeNull();
    const [first, second] = await Promise.all([
      repository.exchangeNativeCode(request),
      repository.exchangeNativeCode({ ...request, tokenHash: hash() }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].filter((result) => result === null)).toHaveLength(1);
    expect(await repository.findSession(tokenHash, now, 'browser')).toBeNull();
    if (first !== null) {
      expect(await repository.findSession(tokenHash, now, 'native')).toMatchObject({
        athleteId: first.athleteId,
        sessionId: first.sessionId,
      });
    }
    expect(await repository.exchangeNativeCode(request)).toBeNull();
  });

  it('does not redeem an expired native code', async () => {
    const now = new Date();
    const codeHash = hash();
    await repository.createNativeCode({
      codeHash,
      codeChallenge: challenge,
      issuer: 'https://id.example',
      subject: randomUUID(),
      loginStartedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    await admin.query(
      "UPDATE identity_private.native_exchange_code SET expires_at = clock_timestamp() - interval '1 second' WHERE code_hash = $1",
      [codeHash],
    );
    const tokenHash = hash();
    expect(
      await repository.exchangeNativeCode({
        codeHash,
        codeChallenge: challenge,
        tokenHash,
        csrfToken: hash(),
        expiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
    ).toBeNull();
    expect(await repository.findSession(tokenHash, now, 'native')).toBeNull();
  });

  it('keeps browser sessions out of bearer lookup and revokes native sessions on provider logout', async () => {
    const now = new Date();
    const subject = randomUUID();
    const providerSessionId = randomUUID();
    const browserTokenHash = hash();
    await repository.createSession({
      tokenHash: browserTokenHash,
      csrfToken: hash(),
      issuer: 'https://id.example',
      subject,
      providerSessionId,
      loginStartedAt: now,
      now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    expect(await repository.findSession(browserTokenHash, now, 'native')).toBeNull();
    expect(await repository.findSession(browserTokenHash, now, 'browser')).not.toBeNull();

    const codeHash = hash();
    await repository.createNativeCode({
      codeHash,
      codeChallenge: challenge,
      issuer: 'https://id.example',
      subject,
      providerSessionId,
      loginStartedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    const nativeTokenHash = hash();
    expect(
      await repository.exchangeNativeCode({
        codeHash,
        codeChallenge: challenge,
        tokenHash: nativeTokenHash,
        csrfToken: hash(),
        expiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
    ).not.toBeNull();
    expect(await repository.findSession(nativeTokenHash, now, 'browser')).toBeNull();
    expect(await repository.findSession(nativeTokenHash, now, 'native')).not.toBeNull();
    expect(
      await repository.revokeProviderSessions({
        issuer: 'https://id.example',
        jtiHash: hash(),
        issuedAt: now,
        subject,
        providerSessionId,
      }),
    ).toBe(true);
    expect(await repository.findSession(browserTokenHash, new Date(), 'browser')).toBeNull();
    expect(await repository.findSession(nativeTokenHash, new Date(), 'native')).toBeNull();
  });

  it('rejects a pending code after back-channel logout, without creating a session', async () => {
    const now = new Date();
    const subject = randomUUID();
    const providerSessionId = randomUUID();
    const codeHash = hash();
    await repository.createNativeCode({
      codeHash,
      codeChallenge: challenge,
      issuer: 'https://id.example',
      subject,
      providerSessionId,
      loginStartedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    await repository.revokeProviderSessions({
      issuer: 'https://id.example',
      jtiHash: hash(),
      issuedAt: now,
      subject,
      providerSessionId,
    });
    const tokenHash = hash();
    await expect(
      repository.exchangeNativeCode({
        codeHash,
        codeChallenge: challenge,
        tokenHash,
        csrfToken: hash(),
        expiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
    ).rejects.toThrow('LOGIN_REVOKED');
    expect(await repository.findSession(tokenHash, new Date(), 'native')).toBeNull();
  });

  it('erases a native session with its account', async () => {
    const now = new Date();
    const codeHash = hash();
    await repository.createNativeCode({
      codeHash,
      codeChallenge: challenge,
      issuer: 'https://id.example',
      subject: randomUUID(),
      loginStartedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    const tokenHash = hash();
    const session = await repository.exchangeNativeCode({
      codeHash,
      codeChallenge: challenge,
      tokenHash,
      csrfToken: hash(),
      expiresAt: new Date(now.getTime() + 3_600_000),
      now,
    });
    if (session === null) throw new Error('Expected native session');
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id', $1, true)", [session.athleteId]);
      await client.query('SELECT public.erase_account($1)', [session.athleteId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await repository.findSession(tokenHash, new Date(), 'native')).toBeNull();
  });

  it('has no legacy untyped session lookup or runtime table access', async () => {
    const old = await admin.query(
      "SELECT to_regprocedure('public.auth_find_session(text,timestamptz)') AS proc",
    );
    expect(old.rows[0].proc).toBeNull();
    const runtime = new Pool({ connectionString: runtimeUrl });
    try {
      await expect(
        runtime.query('SELECT * FROM identity_private.native_exchange_code'),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await runtime.end();
    }
  });
});
