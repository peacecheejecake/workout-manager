import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/app.js';
import {
  configuredGarminUnofficial,
  unofficialSessionCipher,
} from '../src/garmin-unofficial-deployment.js';
import { createGarminCipher } from '@workout/server-identity/garmin-crypto';
import {
  createGarminProfilePin,
  createGarminUnofficialService,
} from '@workout/server-integrations/garmin-unofficial-service';
import { memoryStore, scriptedWorker, testCipher } from './garmin-unofficial-fakes.js';

/**
 * Routes of the temporary unofficial collector (M1-06b-tmp): owner-only gate, the password's
 * path through the API (never logged, never echoed) and the login endpoint's bounds.
 */
const PASSWORD = 'correct-horse-battery-staple-7';
const OWNER = 'athlete-owner';
const apps: ReturnType<typeof createApi>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(
  options: { configured?: boolean; athleteId?: string; method?: 'cookie' | 'bearer' } = {},
) {
  const logs: string[] = [];
  const store = memoryStore();
  const worker = scriptedWorker();
  const activities = { importActivity: vi.fn() };
  const service = createGarminUnofficialService({
    ownerAthleteId: OWNER,
    store,
    worker,
    cipher: testCipher,
    profilePin: createGarminProfilePin(Buffer.alloc(32, 3)),
    activities,
  });
  const athleteId = options.athleteId ?? OWNER;
  const auth = {
    authenticate: vi.fn(async () =>
      options.method === 'bearer'
        ? { athleteId, sessionId: 'session-a', method: 'bearer' }
        : { athleteId, sessionId: 'session-a', method: 'cookie', csrfToken: 'c'.repeat(43) },
    ),
  };
  const app = createApi({
    auth,
    ...(options.configured === false ? {} : { garminUnofficial: service }),
    garminCollectionProvenance: {
      provenance: vi.fn(async () => ({
        provider: 'garmin-connect-unofficial' as const,
        official: false,
        garminActivityId: '9001',
        collectedAt: '2026-09-25T00:00:00.000Z',
      })),
    },
    consent: {
      getConsent: async (_athlete, kind) => ({ kind, granted: false, revision: 0 }),
      setConsent: async (_athlete, input) => ({
        kind: input.kind,
        granted: input.granted,
        revision: 1,
      }),
    },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk));
        done();
      },
    }),
  });
  apps.push(app);
  return { app, store, worker, logs, service };
}
const headers = {
  cookie: 'session=private',
  'x-workout-session-id': 'session-a',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
};
const base = '/bff/v1/integrations/garmin-unofficial';
const routes = [
  { method: 'GET', url: `${base}/status` },
  {
    method: 'POST',
    url: `${base}/login`,
    payload: { email: 'owner@example.test', password: PASSWORD },
  },
  { method: 'POST', url: `${base}/login`, payload: { nonsense: true } },
  { method: 'POST', url: `${base}/login/mfa`, payload: { code: '123456' } },
  { method: 'DELETE', url: `${base}/login` },
  { method: 'DELETE', url: `${base}/connection` },
  { method: 'PUT', url: `${base}/schedule`, payload: { enabled: true } },
  { method: 'POST', url: `${base}/runs` },
] as const;

describe('owner-only gate', () => {
  it('is absent (404) when the deployment does not configure it', async () => {
    const { app } = fixture({ configured: false });
    for (const route of routes)
      expect((await app.inject({ ...route, headers })).statusCode, route.url).toBe(404);
  });

  it('answers every other account with one stable 403 code, whatever the body', async () => {
    const { app, worker } = fixture({ athleteId: 'someone-else' });
    for (const route of routes) {
      const response = await app.inject({ ...route, headers });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'GARMIN_UNOFFICIAL_OWNER_ONLY' } });
    }
    expect(worker.logins).toEqual([]);
  });

  it('answers a non-owner 403 before looking at a malformed body, content type or query', async () => {
    const { app } = fixture({ athleteId: 'someone-else' });
    for (const request of [
      { payload: '{"email":', headers: { ...headers, 'content-type': 'application/json' } },
      { payload: 'email=x', headers: { ...headers, 'content-type': 'text/plain' } },
      { payload: '<a/>', headers: { ...headers, 'content-type': 'application/xml' } },
    ]) {
      const response = await app.inject({ method: 'POST', url: `${base}/login`, ...request });
      expect(response.statusCode, request.payload).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'GARMIN_UNOFFICIAL_OWNER_ONLY' } });
    }
    const query = await app.inject({ url: `${base}/status?probe=1`, headers });
    expect(query.statusCode).toBe(403);
  });

  it('still answers the owner 400/415 for a malformed body or content type', async () => {
    const { app } = fixture();
    const malformed = await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(malformed.statusCode).toBe(400);
    const text = await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(text.statusCode).toBe(415);
  });

  it('lets the owner read status, labelled unofficial', async () => {
    const { app } = fixture();
    const response = await app.inject({ url: `${base}/status`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: 'garmin-connect-unofficial',
      official: false,
      state: 'not_connected',
    });
  });

  it('requires a cookie session to log in (MFA state is bound to it)', async () => {
    const { app } = fixture({ method: 'bearer' });
    const response = await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers: { authorization: 'Bearer token' },
      payload: { email: 'owner@example.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'COOKIE_SESSION_REQUIRED' } });
  });

  it('refuses the deployment in CI and refuses partial configuration', () => {
    const complete = {
      GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID: OWNER,
      GARMIN_UNOFFICIAL_PYTHON: '/opt/venv/bin/python',
      GARMIN_UNOFFICIAL_TOKEN_KEY_ID: 'k1',
      GARMIN_UNOFFICIAL_TOKEN_KEYS_JSON: JSON.stringify({
        k1: Buffer.alloc(32, 1).toString('base64'),
      }),
      GARMIN_UNOFFICIAL_PROFILE_PIN_KEY: Buffer.alloc(32, 2).toString('base64'),
    };
    expect(configuredGarminUnofficial({})).toBeNull();
    // The profile pin key is required, and a short one is refused.
    const { GARMIN_UNOFFICIAL_PROFILE_PIN_KEY: _pin, ...withoutPin } = complete;
    expect(() => configuredGarminUnofficial(withoutPin)).toThrow(
      'INCOMPLETE_GARMIN_UNOFFICIAL_CONFIGURATION',
    );
    expect(() =>
      configuredGarminUnofficial({
        ...complete,
        GARMIN_UNOFFICIAL_PROFILE_PIN_KEY: Buffer.alloc(8).toString('base64'),
      }),
    ).toThrow('INVALID_GARMIN_UNOFFICIAL_PIN_KEY');
    expect(configuredGarminUnofficial({ ...complete, CI: 'true' })).toBeNull();
    expect(configuredGarminUnofficial({ ...complete, CI: 'false' })?.ownerAthleteId).toBe(OWNER);
    expect(() => configuredGarminUnofficial({ GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID: OWNER })).toThrow(
      'INCOMPLETE_GARMIN_UNOFFICIAL_CONFIGURATION',
    );
    expect(() =>
      configuredGarminUnofficial({ ...complete, GARMIN_UNOFFICIAL_PYTHON: 'python3' }),
    ).toThrow();
  });
});

describe('login', () => {
  it('passes the password to the worker once and never to the log or the response', async () => {
    const { app, worker, logs, store } = fixture();
    worker.next.push({ kind: 'connected', profileId: '1001', session: '{"di_token":"t"}' });
    const response = await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers,
      payload: { email: 'owner@example.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: 'connected' });
    expect(worker.logins).toEqual([{ email: 'owner@example.test', password: PASSWORD }]);
    // Rejected and failing logins too: nothing about the body reaches a log line.
    worker.next.push({
      kind: 'failed',
      failure: { kind: 'auth', code: 'AUTHENTICATION_REJECTED' },
    });
    await app.inject({ method: 'DELETE', url: `${base}/connection`, headers });
    const rejected = await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers,
      payload: { email: 'owner@example.test', password: PASSWORD },
    });
    expect(rejected.statusCode).toBe(422);
    const invalid = await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers,
      payload: { email: 'owner@example.test', password: PASSWORD, extra: PASSWORD },
    });
    expect(invalid.statusCode).toBe(400);
    const everything = logs.join('') + response.body + rejected.body + invalid.body;
    expect(logs.length).toBeGreaterThan(0);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('owner@example.test');
    expect(JSON.stringify([...store.rows.values()])).not.toContain(PASSWORD);
  });

  it('locks the login endpoint after failures and bounds attempts per window', async () => {
    const { app, worker } = fixture();
    worker.next.push({
      kind: 'failed',
      failure: { kind: 'auth', code: 'AUTHENTICATION_REJECTED' },
    });
    const login = () =>
      app.inject({
        method: 'POST',
        url: `${base}/login`,
        headers,
        payload: { email: 'owner@example.test', password: PASSWORD },
      });
    expect((await login()).statusCode).toBe(422);
    const locked = await login();
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: { code: 'GARMIN_UNOFFICIAL_LOGIN_LOCKED' } });
    expect(worker.logins).toHaveLength(1);
    const status = (await app.inject({ url: `${base}/status`, headers })).json();
    expect(status.loginLockedUntil).not.toBeNull();
  });

  it('keeps MFA pending in memory for this session only and resumes it', async () => {
    const { app, worker } = fixture();
    const submitted: string[] = [];
    worker.next.push({
      kind: 'mfa_required',
      submit: async (code) => {
        submitted.push(code);
        return code === '123456'
          ? { kind: 'connected', profileId: '1001', session: '{"di_token":"t"}' }
          : { kind: 'failed', failure: { kind: 'mfa_invalid', code: 'MFA_REJECTED' } };
      },
      cancel: async () => {},
    });
    const started = await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers,
      payload: { email: 'owner@example.test', password: PASSWORD },
    });
    expect(started.json()).toEqual({ state: 'mfa_required' });
    const status = (await app.inject({ url: `${base}/status`, headers })).json();
    expect(status).toMatchObject({ state: 'mfa_required' });
    expect(status.mfaExpiresAt).not.toBeNull();
    const otherSession = await app.inject({
      method: 'POST',
      url: `${base}/login/mfa`,
      headers: { ...headers, 'x-workout-session-id': 'session-b' },
      payload: { code: '123456' },
    });
    // The session-id header must match the authenticated session anyway (409 SESSION_CHANGED).
    expect(otherSession.statusCode).toBe(409);
    const wrong = await app.inject({
      method: 'POST',
      url: `${base}/login/mfa`,
      headers,
      payload: { code: '000000' },
    });
    expect(wrong.statusCode).toBe(422);
    const right = await app.inject({
      method: 'POST',
      url: `${base}/login/mfa`,
      headers,
      payload: { code: '123456' },
    });
    expect(right.json()).toEqual({ state: 'connected' });
    expect(submitted).toEqual(['000000', '123456']);
    const again = await app.inject({
      method: 'POST',
      url: `${base}/login/mfa`,
      headers,
      payload: { code: '123456' },
    });
    expect(again.json()).toMatchObject({ error: { code: 'GARMIN_UNOFFICIAL_MFA_EXPIRED' } });
  });

  it('binds the pending MFA step to the app session that started it, with a TTL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { service, worker } = fixture();
      let cancelled = 0;
      worker.next.push({
        kind: 'mfa_required',
        submit: async () => ({ kind: 'connected', profileId: '1001', session: '{"di_token":"t"}' }),
        cancel: async () => {
          cancelled += 1;
        },
      });
      await service.login(OWNER, 'session-a', { email: 'owner@example.test', password: PASSWORD });
      await expect(service.submitMfa(OWNER, 'session-b', { code: '123456' })).rejects.toThrow(
        'GARMIN_UNOFFICIAL_MFA_EXPIRED',
      );
      expect((await service.status(OWNER, 'session-b')).state).toBe('not_connected');
      expect((await service.status(OWNER, 'session-a')).state).toBe('mfa_required');
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      expect(cancelled).toBe(1);
      await expect(service.submitMfa(OWNER, 'session-a', { code: '123456' })).rejects.toThrow(
        'GARMIN_UNOFFICIAL_MFA_EXPIRED',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills an in-flight login at shutdown and stores nothing from it', async () => {
    const { service, worker, store } = fixture();
    let release!: () => void;
    worker.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.next.push({ kind: 'connected', profileId: '1001', session: '{"di_token":"late"}' });
    const login = service.login(OWNER, 'session-a', {
      email: 'owner@example.test',
      password: PASSWORD,
    });
    await vi.waitFor(() => expect(worker.signals).toHaveLength(1));
    const closing = service.close();
    expect(worker.signals[0]?.aborted).toBe(true);
    release();
    await expect(login).rejects.toThrow('GARMIN_UNOFFICIAL_UNAVAILABLE');
    await closing;
    expect(store.rows.get(OWNER)?.['state']).toBe('not_connected');
  });

  it('refuses an MFA code after shutdown and keeps nothing from a submit that was in flight', async () => {
    const { service, worker, store } = fixture();
    let release!: () => void;
    const answering = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.next.push({
      kind: 'mfa_required',
      submit: async () => {
        await answering;
        return { kind: 'connected', profileId: '1001', session: '{"di_token":"late"}' };
      },
      cancel: async () => {},
    });
    await service.login(OWNER, 'session-a', { email: 'owner@example.test', password: PASSWORD });
    const inFlight = service.submitMfa(OWNER, 'session-a', { code: '123456' });
    const closing = service.close();
    release();
    await expect(inFlight).rejects.toThrow('GARMIN_UNOFFICIAL_UNAVAILABLE');
    await closing;
    await expect(service.submitMfa(OWNER, 'session-a', { code: '123456' })).rejects.toThrow(
      'GARMIN_UNOFFICIAL_UNAVAILABLE',
    );
    expect(store.rows.get(OWNER)?.['state']).toBe('not_connected');
  });

  it('pins the first Garmin profile and refuses a different one', async () => {
    const { app, worker } = fixture();
    const login = () =>
      app.inject({
        method: 'POST',
        url: `${base}/login`,
        headers,
        payload: { email: 'owner@example.test', password: PASSWORD },
      });
    worker.next.push({ kind: 'connected', profileId: '1001', session: '{"di_token":"a"}' });
    expect((await login()).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `${base}/connection`, headers });
    worker.next.push({ kind: 'connected', profileId: '2002', session: '{"di_token":"b"}' });
    const refused = await login();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'GARMIN_UNOFFICIAL_PROFILE_MISMATCH' } });
    expect((await app.inject({ url: `${base}/status`, headers })).json()).toMatchObject({
      state: 'not_connected',
      profilePinned: true,
    });
  });
});

describe('runs', () => {
  it('queues a manual run, refuses one while blocked, and never runs inside the request', async () => {
    const { app, worker, store } = fixture();
    worker.next.push({ kind: 'connected', profileId: '1001', session: '{"di_token":"a"}' });
    await app.inject({
      method: 'POST',
      url: `${base}/login`,
      headers,
      payload: { email: 'owner@example.test', password: PASSWORD },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.collect = async () => {
      await gate;
      return {
        kind: 'failed',
        failure: { kind: 'rate_limited', retryAfterSeconds: 3600 },
        credential: null,
      };
    };
    const response = await app.inject({ method: 'POST', url: `${base}/runs`, headers });
    expect(response.statusCode).toBe(202);
    expect(
      (await app.inject({ method: 'POST', url: `${base}/runs`, headers })).json(),
    ).toMatchObject({
      error: { code: 'GARMIN_UNOFFICIAL_RUN_BUSY' },
    });
    release();
    await vi.waitFor(() => expect(store.runs.at(-1)?.['state']).toBe('rate_limited'));
    const blocked = await app.inject({ method: 'POST', url: `${base}/runs`, headers });
    expect(blocked.json()).toMatchObject({ error: { code: 'GARMIN_UNOFFICIAL_RUN_BLOCKED' } });
    expect(
      (await app.inject({ url: `${base}/status`, headers })).json().blockedUntil,
    ).not.toBeNull();
  });
});

describe('provenance and session envelope', () => {
  it('serves collection provenance even when the adapter is off', async () => {
    const { app } = fixture({ configured: false, athleteId: 'someone-else' });
    const response = await app.inject({
      url: '/bff/v1/activities/00000000-0000-4000-8000-000000000001/collection-provenance',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provenance: { provider: 'garmin-connect-unofficial', official: false },
    });
  });

  it('seals the session under its own AAD purpose, unreadable as an official credential', () => {
    const keys = { k1: Buffer.alloc(32, 9).toString('base64') };
    const cipher = unofficialSessionCipher({ activeKeyId: 'k1', keys });
    const sealed = cipher.seal(OWNER, '{"di_token":"secret-di-token"}');
    expect(JSON.stringify(sealed)).not.toContain('secret-di-token');
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('latin1')).not.toContain('secret');
    expect(cipher.open(OWNER, sealed)).toBe('{"di_token":"secret-di-token"}');
    expect(() => cipher.open('another-athlete', sealed)).toThrow();
    const official = createGarminCipher({ activeKeyId: 'k1', keys });
    expect(() => official.decrypt(OWNER, 'tokens', sealed)).toThrow();
  });
});
