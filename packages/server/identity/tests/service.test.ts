import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createIdentityService,
  ProviderUnavailableError,
  type IdentityStore,
  type OidcProvider,
} from '../src/service.js';

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
      async (input: { state: string; nonce: string; verifier: string; reauthenticate: boolean }) =>
        `https://provider.example/authorize?state=${input.state}${input.reauthenticate ? '&prompt=login' : ''}`,
    ),
    exchange: vi.fn(
      async (_url: URL, _checks: Parameters<OidcProvider['exchange']>[1]) =>
        ({ issuer: 'https://provider.example', subject: 'subject' }) as {
          issuer: string;
          subject: string;
        },
    ),
    logoutUrl: vi.fn(async (): Promise<string | null> => null),
  };
  const service = createIdentityService({
    store,
    provider,
    publicOrigin: 'https://workout.example',
    now: () => now,
  });
  async function login(header?: string) {
    const start = await service.beginLogin(header);
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
  it('re-authenticates at the provider after an app sign-out or on a switch, never on a first sign-in', async () => {
    const data = fixture();
    const reauthenticated = () =>
      data.provider.authorizationUrl.mock.lastCall?.[0].reauthenticate ?? null;
    const first = await data.login();
    expect(reauthenticated()).toBe(false);
    const result = await data.service.completeLogin(first.callback, first.cookie);
    const session = result.cookies[0]?.split(';')[0] ?? '';
    // Signed in → a new sign-in is an account switch.
    await data.login(session);
    expect(reauthenticated()).toBe(true);
    // Signed out → the sign-out marker outlives the session and asks again.
    const cleared = await data.service.logout(session);
    const marker = cleared.find((line) => line.startsWith('__Host-workout_signed_out='));
    expect(marker).toMatch(
      /^__Host-workout_signed_out=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/,
    );
    const markerPair = marker?.split(';')[0] ?? '';
    const afterLogout = await data.login(markerPair);
    expect(reauthenticated()).toBe(true);
    expect(afterLogout.start.location).toContain('prompt=login');
    // Any copy, even a malformed one, counts: failing towards asking again.
    await data.login('__Host-workout_signed_out=x');
    expect(reauthenticated()).toBe(true);
    // An oversized header cannot be read, so it cannot show there is no marker: ask again.
    await data.login(`pad=${'x'.repeat(8200)}`);
    expect(reauthenticated()).toBe(true);
    await data.login(`pad=${'x'.repeat(8000)}; ${markerPair}`);
    expect(reauthenticated()).toBe(true);
    // The next completed sign-in clears the marker.
    const completed = await data.service.completeLogin(
      afterLogout.callback,
      `${afterLogout.cookie}; ${markerPair}`,
    );
    expect(completed.cookies).toContain(
      '__Host-workout_signed_out=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
    await data.login('unrelated=1');
    expect(reauthenticated()).toBe(false);
  });
  it('M2-01w: tells the exchange whether the stored attempt asked to re-authenticate', async () => {
    const data = fixture();
    const first = await data.login();
    const nonces = () => [...data.attempts.values()].map((attempt) => attempt.nonce);
    expect(nonces().every((nonce) => !nonce.startsWith('reauth.'))).toBe(true);
    const result = await data.service.completeLogin(first.callback, first.cookie);
    expect(data.provider.exchange.mock.lastCall?.[1].reauthenticate).toBe(false);
    const session = result.cookies[0]?.split(';')[0] ?? '';
    const marker =
      (await data.service.logout(session))
        .find((line) => line.startsWith('__Host-workout_signed_out='))
        ?.split(';')[0] ?? '';
    const again = await data.login(marker);
    expect(nonces().some((nonce) => /^reauth\.[A-Za-z0-9_-]{43}$/.test(nonce))).toBe(true);
    // Only the stored attempt decides: the callback's own cookies are not consulted.
    await data.service.completeLogin(again.callback, again.cookie);
    expect(data.provider.exchange.mock.lastCall?.[1].reauthenticate).toBe(true);
  });
  it('M2-01w: classifies an error response for this browser attempt by its fixed code only', async () => {
    const data = fixture();
    for (const [error, code] of [
      ['access_denied', 'LOGIN_CANCELLED'],
      ['server_error', 'LOGIN_REJECTED'],
      ['login_required', 'LOGIN_REJECTED'],
    ] as const) {
      const login = await data.login();
      await expect(
        data.service.completeLogin(
          `${login.callback}&error=${error}&error_description=%3Cscript%3E`,
          login.cookie,
        ),
      ).rejects.toThrow(code);
      // The attempt is used up either way.
      await expect(data.service.completeLogin(login.callback, login.cookie)).rejects.toThrow(
        'LOGIN_REJECTED',
      );
    }
    // Without this browser's attempt, "cancelled" is not believed.
    const login = await data.login();
    await expect(
      data.service.completeLogin(`${login.callback}&error=access_denied`),
    ).rejects.toThrow('LOGIN_REJECTED');
    expect(data.provider.exchange).not.toHaveBeenCalled();
    expect(data.sessions.size).toBe(0);
  });
  it('M2-01w: an unreachable provider is IDENTITY_UNAVAILABLE and leaves no attempt', async () => {
    const data = fixture();
    data.provider.authorizationUrl.mockRejectedValueOnce(new ProviderUnavailableError());
    await expect(data.service.beginLogin()).rejects.toThrow('IDENTITY_UNAVAILABLE');
    expect(data.attempts.size).toBe(0);
    const login = await data.login();
    data.provider.exchange.mockRejectedValueOnce(new ProviderUnavailableError());
    await expect(data.service.completeLogin(login.callback, login.cookie)).rejects.toThrow(
      'IDENTITY_UNAVAILABLE',
    );
    expect(data.sessions.size).toBe(0);
  });
  it('M2-01w: passes the provider logout URL through, or null when the provider has none', async () => {
    const data = fixture();
    expect(await data.service.providerLogoutUrl()).toBeNull();
    data.provider.logoutUrl.mockResolvedValueOnce('https://provider.example/logout?client_id=c');
    expect(await data.service.providerLogoutUrl()).toBe(
      'https://provider.example/logout?client_id=c',
    );
    const bare = createIdentityService({
      store: data.store,
      provider: {
        authorizationUrl: data.provider.authorizationUrl,
        exchange: data.provider.exchange,
      },
      publicOrigin: 'https://workout.example',
    });
    expect(await bare.providerLogoutUrl()).toBeNull();
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
