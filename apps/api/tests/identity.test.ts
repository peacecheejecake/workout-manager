import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentityService, type IdentityStore } from '@workout/server-identity/service';
import { createApi } from '../src/app.js';
import { createConfiguredApi } from '../src/configured.js';

const instances: ReturnType<typeof createApi>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

function fixture() {
  let attempt: Parameters<IdentityStore['createAttempt']>[0] | undefined;
  let session: Parameters<IdentityStore['createSession']>[0] | undefined;
  const store: IdentityStore = {
    async createAttempt(input) {
      attempt = input;
    },
    async consumeAttempt(state, browser, now) {
      if (
        !attempt ||
        attempt.stateHash !== state ||
        attempt.browserHash !== browser ||
        attempt.expiresAt <= now
      )
        return null;
      const result = { nonce: attempt.nonce, verifier: attempt.verifier };
      attempt = undefined;
      return result;
    },
    async createSession(input) {
      session = input;
      return { athleteId: 'athlete-a', sessionId: 'session-a' };
    },
    async findSession(hash, now) {
      return session && session.tokenHash === hash && session.expiresAt > now
        ? {
            athleteId: 'athlete-a',
            sessionId: 'session-a',
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
          }
        : null;
    },
    async revokeSession(hash) {
      if (session?.tokenHash === hash) session = undefined;
    },
  };
  const exchange = vi.fn(async () => ({
    issuer: 'https://provider.example',
    subject: 'subject-a',
  }));
  const identity = createIdentityService({
    store,
    publicOrigin: 'https://workout.example',
    provider: {
      authorizationUrl: async ({ state, reauthenticate }) =>
        `https://provider.example/authorize?state=${state}${reauthenticate ? '&prompt=login' : ''}`,
      exchange,
    },
  });
  const logs: string[] = [];
  const getConsent = vi.fn(
    async (_athlete: string, kind: 'app' | 'ai' | 'provider' | 'healthkit' | 'media') => ({
      kind,
      granted: false,
      revision: 0,
    }),
  );
  const app = createApi({
    auth: identity,
    identity,
    allowedOrigins: ['https://workout.example'],
    consent: {
      getConsent,
      setConsent: async (_athlete, input) => ({
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
  async function login() {
    const start = await app.inject('/bff/v1/auth/login');
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    const response = await app.inject({
      url: `/bff/v1/auth/callback?state=${state}&code=provider-private-code`,
      headers: { cookie: String(start.headers['set-cookie']).split(';')[0] ?? '' },
    });
    const cookies = response.headers['set-cookie'];
    if (!Array.isArray(cookies)) throw new Error('Missing session cookies');
    const cookie = cookies[0]?.split(';')[0] ?? '';
    const current = await app.inject({ url: '/bff/v1/session', headers: { cookie } });
    const session: unknown = current.json();
    if (
      typeof session !== 'object' ||
      session === null ||
      !('csrfToken' in session) ||
      typeof session.csrfToken !== 'string'
    )
      throw new Error('Missing CSRF token');
    return { response, cookie, csrfToken: session.csrfToken, current };
  }
  return { app, login, exchange, logs, getConsent };
}

describe('M1-01 browser authentication boundary', () => {
  it('redirects browser-bound login and returns only local session metadata with no cache', async () => {
    const data = fixture();
    const login = await data.login();
    expect(login.response.statusCode).toBe(302);
    expect(login.response.headers.location).toBe('/account');
    expect(login.current.json()).toMatchObject({
      athleteId: 'athlete-a',
      sessionId: 'session-a',
      csrfToken: login.csrfToken,
    });
    expect(login.current.headers['cache-control']).toBe('no-store');
    const output = data.logs.join('');
    expect(output).not.toContain('provider-private-code');
    expect(output).not.toContain(login.csrfToken);
    expect(output).not.toContain(login.cookie);
    expect(
      (await data.app.inject('/bff/v1/auth/login?returnTo=https://attacker.example')).statusCode,
    ).toBe(400);
    expect(String((await data.app.inject('/bff/v1/auth/login')).headers.location)).not.toContain(
      'prompt=',
    );
    const switching = await data.app.inject({
      url: '/bff/v1/auth/login',
      headers: { cookie: login.cookie },
    });
    expect(String(switching.headers.location)).toContain('&prompt=login');
  });
  it('requires same-origin CSRF on logout and consent, then invalidates the captured cookie', async () => {
    const data = fixture();
    const login = await data.login();
    expect(
      (
        await data.app.inject({
          method: 'POST',
          url: '/bff/v1/auth/logout',
          headers: { cookie: login.cookie, 'x-workout-session-id': 'session-a' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await data.app.inject({
          method: 'POST',
          url: '/bff/v1/auth/logout',
          headers: {
            cookie: login.cookie,
            origin: 'https://attacker.example',
            'x-csrf-token': login.csrfToken,
            'x-workout-session-id': 'session-a',
          },
        })
      ).statusCode,
    ).toBe(403);
    const headers = {
      cookie: login.cookie,
      origin: 'https://workout.example',
      'x-csrf-token': login.csrfToken,
      'x-workout-session-id': 'session-a',
    };
    expect(
      (
        await data.app.inject({
          method: 'PUT',
          url: '/bff/v1/consents/ai',
          headers: { ...headers, 'idempotency-key': 'consent-request-a' },
          payload: { granted: true, expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(200);
    const logout = await data.app.inject({ method: 'POST', url: '/bff/v1/auth/logout', headers });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('Max-Age=0')]),
    );
    expect(
      (await data.app.inject({ url: '/bff/v1/session', headers: { cookie: login.cookie } }))
        .statusCode,
    ).toBe(401);
  });
  it('a sign-out that finds no live session still makes the next sign-in re-authenticate', async () => {
    const data = fixture();
    const login = await data.login();
    // The session is gone (expired or revoked elsewhere) when the user presses sign-out.
    await data.app.inject({
      method: 'POST',
      url: '/bff/v1/auth/logout',
      headers: {
        cookie: login.cookie,
        origin: 'https://workout.example',
        'x-csrf-token': login.csrfToken,
        'x-workout-session-id': 'session-a',
      },
    });
    for (const cookie of [login.cookie, '']) {
      const stale = await data.app.inject({
        method: 'POST',
        url: '/bff/v1/auth/logout',
        headers: { cookie, origin: 'https://workout.example' },
      });
      expect(stale.statusCode).toBe(401);
      const set = [stale.headers['set-cookie']].flat().map(String);
      // Only the marker: an unauthenticated response never deletes session or attempt cookies.
      expect(set).toHaveLength(1);
      const marker = set.find((line) => line.startsWith('__Host-workout_signed_out='));
      expect(marker).toMatch(/^__Host-workout_signed_out=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly/);
      const next = await data.app.inject({
        url: '/bff/v1/auth/login',
        headers: { cookie: marker?.split(';')[0] ?? '' },
      });
      expect(String(next.headers.location)).toContain('&prompt=login');
    }
    // Other unauthenticated routes set nothing.
    const session = await data.app.inject({ url: '/bff/v1/session' });
    expect(session.statusCode).toBe(401);
    expect(session.headers['set-cookie']).toBeUndefined();
  });
  it('a cross-site sign-out (Lax withholds the session cookie) sets and deletes no cookie', async () => {
    const data = fixture();
    const login = await data.login();
    // What the victim's browser sends for a top-level cross-site text/plain form: no
    // SameSite=Lax session cookie, a foreign Origin, a body Fastify accepts.
    for (const headers of [
      { origin: 'https://attacker.example', 'content-type': 'text/plain' },
      { origin: 'null', 'content-type': 'text/plain' },
      { 'content-type': 'text/plain' },
    ]) {
      const forced = await data.app.inject({
        method: 'POST',
        url: '/bff/v1/auth/logout',
        headers,
        payload: 'x=y',
      });
      expect(forced.statusCode).toBe(401);
      const set = [forced.headers['set-cookie'] ?? []].flat().map(String);
      expect(set.filter((line) => line.startsWith('__Host-workout_session='))).toEqual([]);
      expect(set.filter((line) => line.startsWith('__Host-workout_login='))).toEqual([]);
      expect(set.filter((line) => line.startsWith('__Host-workout_signed_out='))).toEqual([]);
    }
    // The victim's session is untouched.
    expect(
      (await data.app.inject({ url: '/bff/v1/session', headers: { cookie: login.cookie } }))
        .statusCode,
    ).toBe(200);
  });
  it('fails closed on provider refusal and never logs the provider error', async () => {
    const data = fixture();
    data.exchange.mockRejectedValueOnce(new Error('SECRET PROVIDER TOKEN'));
    const start = await data.app.inject('/bff/v1/auth/login');
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    const response = await data.app.inject({
      url: `/bff/v1/auth/callback?state=${state}&error=access_denied`,
      headers: { cookie: String(start.headers['set-cookie']).split(';')[0] ?? '' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'LOGIN_REJECTED' } });
    expect(data.logs.join('')).not.toContain('SECRET PROVIDER TOKEN');
  });
  it('rejects incomplete startup and insecure production before network or database access', async () => {
    await expect(createConfiguredApi({})).rejects.toThrow();
    await expect(
      createConfiguredApi({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://runtime:secret@127.0.0.1/workout',
        PUBLIC_ORIGIN: 'http://127.0.0.1:4301',
        OIDC_ISSUER: 'http://127.0.0.1:4302',
        OIDC_CLIENT_ID: 'client',
        OIDC_CLIENT_SECRET: 'secret',
        PRIVATE_RESOURCE_STORAGE_ROOT: '/private/tmp/workout-manager-resource-test',
        ALLOW_INSECURE_LOCALHOST: 'true',
      }),
    ).rejects.toThrow('Insecure production configuration');
  });
});

it('rejects cookie session substitution before consent data or writes are accessed', async () => {
  const data = fixture();
  const login = await data.login();
  for (const method of ['GET', 'PUT'] as const) {
    const rejected = await data.app.inject({
      method,
      url: '/bff/v1/consents/ai',
      headers: {
        cookie: login.cookie,
        'x-workout-session-id': 'previous-session',
        origin: 'https://workout.example',
        'x-csrf-token': login.csrfToken,
      },
      ...(method === 'PUT' ? { payload: { granted: true, expectedRevision: 0 } } : {}),
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: 'SESSION_CHANGED' } });
  }
  expect(data.getConsent).not.toHaveBeenCalled();
  const missing = await data.app.inject({
    url: '/bff/v1/consents/ai',
    headers: { cookie: login.cookie },
  });
  expect(missing.statusCode).toBe(409);
  const valid = await data.app.inject({
    url: '/bff/v1/consents/ai',
    headers: { cookie: login.cookie, 'x-workout-session-id': 'session-a' },
  });
  expect(valid.statusCode).toBe(200);
});
