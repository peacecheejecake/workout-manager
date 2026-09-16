import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createIdentityService, type IdentityStore } from '../src/service.js';

function fixture() {
  let now = new Date('2026-09-16T00:00:00Z');
  const attempts = new Map<string, Parameters<IdentityStore['createAttempt']>[0]>();
  const sessions = new Map<string, Parameters<IdentityStore['createSession']>[0]>();
  const store: IdentityStore = {
    async createAttempt(input) {
      attempts.set(input.stateHash, input);
    },
    async consumeAttempt(state, browser, time) {
      const value = attempts.get(state);
      if (!value || value.browserHash !== browser || value.expiresAt <= time) return null;
      attempts.delete(state);
      return { nonce: value.nonce, verifier: value.verifier };
    },
    async createSession(input) {
      sessions.set(input.tokenHash, input);
      if (input.previousTokenHash !== undefined) sessions.delete(input.previousTokenHash);
      return { athleteId: 'athlete-a', sessionId: input.tokenHash };
    },
    async findSession(key, time) {
      const value = sessions.get(key);
      return value && value.expiresAt > time
        ? {
            athleteId: 'athlete-a',
            sessionId: key,
            csrfToken: value.csrfToken,
            expiresAt: value.expiresAt,
          }
        : null;
    },
    async revokeSession(key) {
      sessions.delete(key);
    },
  };
  const provider = {
    authorizationUrl: vi.fn(
      async (input: { state: string; nonce: string; verifier: string }) =>
        `https://provider.example/authorize?state=${input.state}`,
    ),
    exchange: vi.fn(async () => ({ issuer: 'https://provider.example', subject: 'subject' })),
  };
  const service = createIdentityService({
    store,
    provider,
    publicOrigin: 'https://workout.example',
    now: () => now,
  });
  async function login() {
    const start = await service.beginLogin();
    const state = new URL(start.location).searchParams.get('state');
    return {
      start,
      callback: `/bff/v1/auth/callback?code=code&state=${state}`,
      cookie: start.cookie.split(';')[0] ?? '',
    };
  }
  return {
    service,
    store,
    provider,
    sessions,
    attempts,
    login,
    setNow(time: string) {
      now = new Date(time);
    },
  };
}

describe('opaque session lifecycle and browser-bound one-use login', () => {
  it('stores only token hashes, verifies browser binding, issues HttpOnly Secure cookies and supports revocation', async () => {
    const fixtureValue = fixture();
    const login = await fixtureValue.login();
    await expect(fixtureValue.service.completeLogin(login.callback)).rejects.toThrow(
      'LOGIN_REJECTED',
    );
    expect(fixtureValue.provider.exchange).not.toHaveBeenCalled();
    const result = await fixtureValue.service.completeLogin(login.callback, login.cookie);
    const sessionCookie = result.cookies[0] ?? '';
    expect(sessionCookie).toContain('__Host-workout_session=');
    expect(sessionCookie).toContain('HttpOnly; SameSite=Lax; Max-Age=28800; Secure');
    const raw = sessionCookie.split(';')[0]?.split('=')[1] ?? '';
    expect(fixtureValue.sessions.has(raw)).toBe(false);
    expect(fixtureValue.sessions.has(createHash('sha256').update(raw).digest('hex'))).toBe(true);
    const header = sessionCookie.split(';')[0] ?? '';
    const identity = await fixtureValue.service.authenticate({ cookie: header });
    expect(identity).toMatchObject({
      athleteId: 'athlete-a',
      method: 'cookie',
      expiresAt: '2026-09-16T08:00:00.000Z',
    });
    await expect(fixtureValue.service.completeLogin(login.callback, login.cookie)).rejects.toThrow(
      'LOGIN_REJECTED',
    );
    await fixtureValue.service.logout(header);
    expect(await fixtureValue.service.authenticate({ cookie: header })).toBeNull();
  });
  it('rejects expired attempts and expires sessions without relying on browser cookie eviction', async () => {
    const data = fixture();
    const login = await data.login();
    data.setNow('2026-09-16T00:10:00Z');
    await expect(data.service.completeLogin(login.callback, login.cookie)).rejects.toThrow(
      'LOGIN_REJECTED',
    );
    const fresh = await data.login();
    const result = await data.service.completeLogin(fresh.callback, fresh.cookie);
    data.setNow('2026-09-17T00:00:00Z');
    expect(
      await data.service.authenticate({ cookie: result.cookies[0]?.split(';')[0] ?? '' }),
    ).toBeNull();
  });
  it('consumes attempts before exchange failure and rejects duplicate state and cookies', async () => {
    const data = fixture();
    const login = await data.login();
    await expect(
      data.service.completeLogin(`${login.callback}&state=duplicate`, login.cookie),
    ).rejects.toThrow('LOGIN_REJECTED');
    await expect(
      data.service.completeLogin(login.callback, `${login.cookie}; ${login.cookie}`),
    ).rejects.toThrow('LOGIN_REJECTED');
    data.provider.exchange.mockRejectedValueOnce(new Error('raw provider secret'));
    await expect(data.service.completeLogin(login.callback, login.cookie)).rejects.toThrow(
      'LOGIN_REJECTED',
    );
    await expect(data.service.completeLogin(login.callback, login.cookie)).rejects.toThrow(
      'LOGIN_REJECTED',
    );
    expect(data.provider.exchange).toHaveBeenCalledTimes(1);
  });
  it('rotates previous sessions and never accepts bearer credentials as cookies', async () => {
    const data = fixture();
    const first = await data.login();
    const firstResult = await data.service.completeLogin(first.callback, first.cookie);
    const previousCookie = firstResult.cookies[0]?.split(';')[0] ?? '';
    const second = await data.login();
    const secondResult = await data.service.completeLogin(
      second.callback,
      `${second.cookie}; ${previousCookie}`,
    );
    expect(await data.service.authenticate({ cookie: previousCookie })).toBeNull();
    expect(
      await data.service.authenticate({
        cookie: secondResult.cookies[0]?.split(';')[0] ?? '',
        authorization: 'Bearer untrusted',
      }),
    ).toBeNull();
    expect(data.sessions.size).toBe(1);
  });
  it('refuses insecure non-loopback origins and credentials embedded in an origin', () => {
    const data = fixture();
    expect(() =>
      createIdentityService({
        store: data.store,
        provider: data.provider,
        publicOrigin: 'http://workout.example',
        allowInsecureLocalhost: true,
      }),
    ).toThrow();
    expect(() =>
      createIdentityService({
        store: data.store,
        provider: data.provider,
        publicOrigin: 'https://user:secret@workout.example',
      }),
    ).toThrow();
  });
});
