import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createIdentityService,
  type NativeIdentityStore,
  type OidcProvider,
} from '../src/service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
const verifier = 'v'.repeat(43);

function fixture(nativeEnabled = true) {
  let clock = new Date('2026-09-27T00:00:00.000Z');
  const attempts = new Map<string, Parameters<NativeIdentityStore['createNativeAttempt']>[0]>();
  const codes = new Map<string, Parameters<NativeIdentityStore['createNativeCode']>[0]>();
  const sessions = new Map<string, { kind: 'browser' | 'native'; expiresAt: Date }>();
  const store: NativeIdentityStore = {
    async createAttempt() {},
    async consumeAttempt() {
      return null;
    },
    async createSession(input) {
      sessions.set(input.tokenHash, { kind: 'browser', expiresAt: input.expiresAt });
      return { athleteId: 'athlete-a', sessionId: 'browser-a' };
    },
    async findSession(tokenHash, now, kind) {
      const row = sessions.get(tokenHash);
      return row?.kind === kind && row.expiresAt > now
        ? {
            athleteId: 'athlete-a',
            sessionId: kind === 'native' ? 'native-a' : 'browser-a',
            csrfToken: 'c'.repeat(43),
            expiresAt: row.expiresAt,
          }
        : null;
    },
    async revokeSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async createNativeAttempt(input) {
      attempts.set(input.stateHash, input);
    },
    async consumeNativeAttempt(stateHash, now) {
      const attempt = attempts.get(stateHash);
      if (attempt === undefined || attempt.expiresAt <= now) return null;
      attempts.delete(stateHash);
      return {
        nonce: attempt.nonce,
        verifier: attempt.verifier,
        codeChallenge: attempt.codeChallenge,
        createdAt: new Date(attempt.expiresAt.getTime() - 600_000),
      };
    },
    async createNativeCode(input) {
      codes.set(input.codeHash, input);
    },
    async exchangeNativeCode(input) {
      const code = codes.get(input.codeHash);
      if (
        code === undefined ||
        code.expiresAt <= input.now ||
        code.codeChallenge !== input.codeChallenge
      )
        return null;
      codes.delete(input.codeHash);
      sessions.set(input.tokenHash, { kind: 'native', expiresAt: input.expiresAt });
      return { athleteId: 'athlete-a', sessionId: 'native-a', expiresAt: input.expiresAt };
    },
  };
  const provider: OidcProvider = {
    authorizationUrl: vi.fn(async ({ state }) => `https://id.example/authorize?state=${state}`),
    exchange: vi.fn(async () => ({ issuer: 'https://id.example', subject: 'subject-a' })),
  };
  const service = createIdentityService({
    store,
    provider,
    publicOrigin: 'https://workout.example',
    now: () => clock,
    ...(nativeEnabled
      ? { native: { store, redirectUri: 'org.workoutmanager.app://auth/callback' } }
      : {}),
  });
  return {
    service,
    store,
    provider,
    attempts,
    codes,
    sessions,
    setNow(value: string) {
      clock = new Date(value);
    },
  };
}

async function start(fixtureValue: ReturnType<typeof fixture>) {
  const login = await fixtureValue.service.native?.beginLogin({
    codeChallenge: challenge(verifier),
  });
  if (login === undefined) throw new Error('Native auth disabled');
  const state = new URL(login.location).searchParams.get('state');
  if (state === null) throw new Error('No state');
  return { state, callback: `/bff/v1/auth/callback?state=${state}&code=provider-code` };
}

describe('native one-time OIDC code and session boundary', () => {
  it('leaves native auth disabled without the exact configured app URI', () => {
    expect(fixture(false).service.native).toBeUndefined();
    expect(() =>
      createIdentityService({
        store: fixture().store,
        provider: fixture().provider,
        publicOrigin: 'https://workout.example',
        native: { store: fixture().store, redirectUri: 'https://attacker.example/callback' },
      }),
    ).toThrow('Invalid native auth redirect');
  });

  it('sends only a bound one-use code through the app URI and gives bearer only at exchange', async () => {
    const data = fixture();
    const login = await start(data);
    const attempt = data.attempts.get(hash(login.state));
    expect(attempt?.codeChallenge).toBe(challenge(verifier));
    expect(attempt?.verifier).not.toBe(verifier);
    expect(data.provider.authorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ reauthenticate: true }),
    );
    const callback = await data.service.native?.completeLogin(login.callback);
    const location = new URL(callback?.location ?? 'about:blank');
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(
      'org.workoutmanager.app://auth/callback',
    );
    expect(location.searchParams.size).toBe(1);
    const code = location.searchParams.get('code');
    if (code === null) throw new Error('No native code');
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await data.service.native?.completeLogin(login.callback)).toBeNull();
    await expect(
      data.service.native?.exchangeCode({ code, codeVerifier: 'x'.repeat(43) }),
    ).rejects.toMatchObject({ code: 'LOGIN_REJECTED' });
    const exchanged = await data.service.native?.exchangeCode({ code, codeVerifier: verifier });
    expect(exchanged?.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.href).not.toContain(exchanged?.accessToken ?? 'invalid');
    const bearer = `Bearer ${exchanged?.accessToken ?? ''}`;
    expect(await data.service.authenticate({ authorization: bearer })).toMatchObject({
      method: 'bearer',
      athleteId: 'athlete-a',
    });
    expect(
      await data.service.authenticate({ cookie: `workout_session=${exchanged?.accessToken}` }),
    ).toBeNull();
    expect(
      await data.service.authenticate({ authorization: bearer, cookie: 'unrelated=1' }),
    ).toBeNull();
    await expect(
      data.service.native?.exchangeCode({ code, codeVerifier: verifier }),
    ).rejects.toMatchObject({
      code: 'LOGIN_REJECTED',
    });
    await data.service.logoutNative(bearer);
    expect(await data.service.authenticate({ authorization: bearer })).toBeNull();
  });

  it('expires attempts and codes and maps provider errors to fixed app URI codes', async () => {
    const data = fixture();
    const expiredAttempt = await start(data);
    data.setNow('2026-09-27T00:10:01.000Z');
    expect(await data.service.native?.completeLogin(expiredAttempt.callback)).toBeNull();

    data.setNow('2026-09-27T01:00:00.000Z');
    const cancelled = await start(data);
    const destination = await data.service.native?.completeLogin(
      `/bff/v1/auth/callback?state=${cancelled.state}&error=access_denied&error_description=secret`,
    );
    expect(destination?.location).toBe('org.workoutmanager.app://auth/callback?error=cancelled');
    expect(await data.service.native?.completeLogin(cancelled.callback)).toBeNull();

    const fresh = await start(data);
    const result = await data.service.native?.completeLogin(fresh.callback);
    const code = new URL(result?.location ?? 'about:blank').searchParams.get('code');
    if (code === null) throw new Error('No native code');
    data.setNow('2026-09-27T01:02:01.000Z');
    await expect(
      data.service.native?.exchangeCode({ code, codeVerifier: verifier }),
    ).rejects.toMatchObject({
      code: 'LOGIN_REJECTED',
    });
  });

  it('rejects ambiguous callback parameters before consuming the native attempt', async () => {
    const data = fixture();
    const login = await start(data);
    expect(
      await data.service.native?.completeLogin(`${login.callback}&state=${login.state}`),
    ).toBeNull();
    expect(data.attempts.has(hash(login.state))).toBe(true);
    expect(await data.service.native?.completeLogin(login.callback)).not.toBeNull();
  });

  it('sanitizes native store failures without returning a code or credential', async () => {
    const data = fixture();
    const privateError = new Error('private code and database details');
    vi.spyOn(data.store, 'createNativeAttempt').mockRejectedValueOnce(privateError);
    await expect(
      data.service.native?.beginLogin({ codeChallenge: challenge(verifier) }),
    ).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });

    const login = await start(data);
    const destination = await data.service.native?.completeLogin(login.callback);
    const code = new URL(destination?.location ?? 'about:blank').searchParams.get('code');
    if (code === null) throw new Error('No native code');
    vi.spyOn(data.store, 'exchangeNativeCode').mockRejectedValueOnce(privateError);
    await expect(
      data.service.native?.exchangeCode({ code, codeVerifier: verifier }),
    ).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
    expect(data.sessions.size).toBe(0);

    vi.spyOn(data.store, 'exchangeNativeCode').mockRejectedValueOnce(new Error('LOGIN_REVOKED'));
    await expect(
      data.service.native?.exchangeCode({ code, codeVerifier: verifier }),
    ).rejects.toMatchObject({ code: 'LOGIN_REJECTED' });
  });
});
