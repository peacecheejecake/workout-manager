import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentityService, type NativeIdentityStore } from '@workout/server-identity/service';
import { createApi } from '../src/app.js';

const verifier = 'v'.repeat(43);
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
const instances: ReturnType<typeof createApi>[] = [];
afterEach(async () => Promise.all(instances.splice(0).map((app) => app.close())));

function fixture(nativeEnabled: boolean) {
  let browserAttempt: Parameters<NativeIdentityStore['createAttempt']>[0] | undefined;
  const attempts = new Map<string, Parameters<NativeIdentityStore['createNativeAttempt']>[0]>();
  const codes = new Map<string, Parameters<NativeIdentityStore['createNativeCode']>[0]>();
  const sessions = new Map<string, 'browser' | 'native'>();
  const store: NativeIdentityStore = {
    async createAttempt(input) {
      browserAttempt = input;
    },
    async consumeAttempt(stateHash, browserHash, now) {
      const attempt = browserAttempt;
      if (
        attempt === undefined ||
        attempt.stateHash !== stateHash ||
        attempt.browserHash !== browserHash ||
        attempt.expiresAt <= now
      )
        return null;
      browserAttempt = undefined;
      return {
        nonce: attempt.nonce,
        verifier: attempt.verifier,
        createdAt: new Date(attempt.expiresAt.getTime() - 600_000),
      };
    },
    async createSession(input) {
      sessions.set(input.tokenHash, 'browser');
      return { athleteId: 'athlete-a', sessionId: 'browser-a' };
    },
    async findSession(tokenHash, _now, kind) {
      return sessions.get(tokenHash) === kind
        ? {
            athleteId: 'athlete-a',
            sessionId: kind === 'native' ? 'native-a' : 'browser-a',
            csrfToken: 'c'.repeat(43),
            expiresAt: new Date('2099-01-01'),
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
      if (code === undefined || code.codeChallenge !== input.codeChallenge) return null;
      codes.delete(input.codeHash);
      sessions.set(input.tokenHash, 'native');
      return { athleteId: 'athlete-a', sessionId: 'native-a', expiresAt: input.expiresAt };
    },
  };
  const identity = createIdentityService({
    store,
    publicOrigin: 'https://workout.example',
    provider: {
      authorizationUrl: vi.fn(async ({ state }) => `https://id.example/authorize?state=${state}`),
      exchange: vi.fn(async () => ({ issuer: 'https://id.example', subject: 'subject-a' })),
    },
    ...(nativeEnabled
      ? { native: { store, redirectUri: 'org.workoutmanager.app://auth/callback' } }
      : {}),
  });
  const logs: string[] = [];
  const app = createApi({
    auth: identity,
    identity,
    allowedOrigins: ['https://workout.example'],
    consent: {
      getConsent: async (_athleteId, kind) => ({ kind, granted: false, revision: 0 }),
      setConsent: async (_athleteId, input) => ({
        kind: input.kind,
        granted: input.granted,
        revision: 1,
      }),
    },
    logStream: new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk));
        done();
      },
    }),
  });
  instances.push(app);
  return { app, logs, store };
}

describe('M3-01c native authentication API boundary', () => {
  it('does not register native routes without the explicit callback configuration', async () => {
    const { app } = fixture(false);
    expect(
      (await app.inject({ method: 'POST', url: '/bff/v1/auth/native/start', payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/bff/v1/auth/native/exchange', payload: {} }))
        .statusCode,
    ).toBe(404);
  });

  it('validates both JSON steps, delivers only a code in the app redirect, and revokes native bearer on logout', async () => {
    const { app, logs } = fixture(true);
    const startUrl = '/bff/v1/auth/native/start';
    expect(
      (await app.inject({ method: 'POST', url: startUrl, payload: { codeChallenge: 'wrong' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: startUrl,
          payload: { codeChallenge, athleteId: 'other' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: startUrl,
          headers: { cookie: 'workout_session=x' },
          payload: { codeChallenge },
        })
      ).statusCode,
    ).toBe(400);
    const start = await app.inject({ method: 'POST', url: startUrl, payload: { codeChallenge } });
    expect(start.statusCode).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');
    const state = new URL(start.json<{ location: string }>().location).searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const callback = await app.inject(`/bff/v1/auth/callback?state=${state}&code=provider-secret`);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers['set-cookie']).toBeUndefined();
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    const redirect = new URL(String(callback.headers.location));
    expect(`${redirect.protocol}//${redirect.host}${redirect.pathname}`).toBe(
      'org.workoutmanager.app://auth/callback',
    );
    const code = redirect.searchParams.get('code');
    if (code === null) throw new Error('Missing native code');
    expect(redirect.searchParams.size).toBe(1);
    const exchangeUrl = '/bff/v1/auth/native/exchange';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: exchangeUrl,
          payload: { code, codeVerifier: 'x'.repeat(43) },
        })
      ).statusCode,
    ).toBe(401);
    const exchange = await app.inject({
      method: 'POST',
      url: exchangeUrl,
      payload: { code, codeVerifier: verifier },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers['cache-control']).toBe('no-store');
    const { accessToken } = exchange.json<{ accessToken: string }>();
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(callback.headers.location)).not.toContain(accessToken);
    const headers = { authorization: `Bearer ${accessToken}` };
    expect((await app.inject({ url: '/bff/v1/session', headers })).json()).toEqual({
      athleteId: 'athlete-a',
    });
    expect(
      (
        await app.inject({
          url: '/bff/v1/session',
          headers: { cookie: `__Host-workout_session=${accessToken}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/bff/v1/session', headers: { ...headers, cookie: 'unrelated=1' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/bff/v1/auth/logout', headers })).statusCode,
    ).toBe(204);
    expect((await app.inject({ url: '/bff/v1/session', headers })).statusCode).toBe(401);
    const output = logs.join('');
    for (const secret of [code, verifier, accessToken, 'provider-secret'])
      expect(output).not.toContain(secret);
  });

  it('returns a fixed unavailable code when storage fails without exposing its details', async () => {
    const { app, logs, store } = fixture(true);
    vi.spyOn(store, 'createNativeAttempt').mockRejectedValueOnce(
      new Error('private secret and SQL details'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/auth/native/start',
      payload: { codeChallenge },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'IDENTITY_UNAVAILABLE' } });
    expect(JSON.stringify(response.json())).not.toContain('private secret');
    expect(logs.join('')).not.toContain('private secret');
  });

  it('keeps the browser cookie callback and principal separate with native routes enabled', async () => {
    const { app } = fixture(true);
    const start = await app.inject('/bff/v1/auth/login');
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    const attemptCookie = String(start.headers['set-cookie']).split(';')[0];
    const callback = await app.inject({
      url: `/bff/v1/auth/callback?state=${state}&code=provider-code`,
      headers: { cookie: attemptCookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/account');
    const cookies = callback.headers['set-cookie'];
    if (!Array.isArray(cookies)) throw new Error('Missing browser cookies');
    const sessionCookie = cookies[0]?.split(';')[0] ?? '';
    expect(
      (await app.inject({ url: '/bff/v1/session', headers: { cookie: sessionCookie } })).json(),
    ).toMatchObject({
      athleteId: 'athlete-a',
      sessionId: 'browser-a',
      csrfToken: 'c'.repeat(43),
    });
  });
});
