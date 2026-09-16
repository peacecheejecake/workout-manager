import { Writable } from 'node:stream';
import { afterEach, it, expect, vi } from 'vitest';
import { createApi } from '../src/app.js';
import type { GarminService } from '@workout/server-identity/garmin-service';
const apps: ReturnType<typeof createApi>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(configured = true) {
  const logs: string[] = [];
  const service: GarminService = {
    status: vi.fn<GarminService['status']>(async () => ({
      configured: true,
      state: 'connected',
      permissions: ['ACTIVITY_EXPORT'],
      connectedAt: '2026-09-16T00:00:00Z',
    })),
    begin: vi.fn(async () => ({
      authorizationUrl: 'https://connect.garmin.com/oauth2Confirm?state=opaque',
    })),
    callback: vi.fn<GarminService['callback']>(async () => 'connected'),
    disconnect: vi.fn<GarminService['disconnect']>(async () => ({
      configured: true,
      state: 'disconnecting',
      permissions: [],
      connectedAt: null,
    })),
    refresh: vi.fn(async () => {}),
  };
  const auth = {
    authenticate: vi.fn(async () => ({
      athleteId: 'athlete-a',
      sessionId: 'session-a',
      method: 'cookie',
      csrfToken: 'c'.repeat(43),
    })),
  };
  const app = createApi({
    auth,
    ...(configured ? { garmin: service } : {}),
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
  return { app, service, auth, logs };
}
const headers = {
  cookie: 'session=private',
  'x-workout-session-id': 'session-a',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
};
it('keeps OIDC session identity unchanged while using a separate guarded Garmin connect endpoint', async () => {
  const { app, service } = fixture();
  const result = await app.inject({
    method: 'POST',
    url: '/bff/v1/integrations/garmin/connect',
    headers,
  });
  expect(result.statusCode).toBe(200);
  expect(service.begin).toHaveBeenCalledWith('athlete-a', 'session-a');
  expect((await app.inject({ url: '/bff/v1/session', headers })).json()).toMatchObject({
    athleteId: 'athlete-a',
    sessionId: 'session-a',
  });
  expect(
    (await app.inject({ url: '/bff/v1/integrations/garmin/status', headers })).json(),
  ).not.toHaveProperty('accessToken');
});
it('requires exact Origin, CSRF and expected session for connect and disconnect', async () => {
  const { app, service } = fixture();
  for (const method of ['POST', 'DELETE'] as const) {
    const url =
      method === 'POST'
        ? '/bff/v1/integrations/garmin/connect'
        : '/bff/v1/integrations/garmin/connection';
    expect(
      (await app.inject({ method, url, headers: { ...headers, 'x-csrf-token': 'wrong' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method,
          url,
          headers: { ...headers, origin: 'https://attacker.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method, url, headers: { ...headers, 'x-workout-session-id': 'other' } }))
        .statusCode,
    ).toBe(409);
  }
  expect(service.begin).not.toHaveBeenCalled();
  expect(service.disconnect).not.toHaveBeenCalled();
});
it('callback uses existing cookie session without the custom header and cleans credentials from redirects/logs', async () => {
  const { app, service, logs } = fixture();
  const result = await app.inject({
    url: '/bff/v1/integrations/garmin/callback?code=SECRET-CODE&state=opaque',
    headers: { cookie: headers.cookie },
  });
  expect(result.statusCode).toBe(302);
  expect(result.headers.location).toBe('/account?garmin=connected');
  expect(result.headers['referrer-policy']).toBe('no-referrer');
  expect(service.callback).toHaveBeenCalledWith('athlete-a', 'session-a', {
    code: 'SECRET-CODE',
    state: 'opaque',
  });
  expect(logs.join('')).not.toContain('SECRET-CODE');
  expect(result.body).not.toContain('SECRET-CODE');
});
it('fails callback closed without a browser cookie or on a rejected bound state', async () => {
  const { app, service } = fixture();
  expect(
    (await app.inject('/bff/v1/integrations/garmin/callback?state=wrong&code=secret')).headers
      .location,
  ).toBe('/account?garmin=failed');
  expect(service.callback).not.toHaveBeenCalled();
  vi.mocked(service.callback).mockRejectedValueOnce(new Error('raw provider secret'));
  expect(
    (
      await app.inject({
        url: '/bff/v1/integrations/garmin/callback?state=wrong&code=secret',
        headers: { cookie: headers.cookie },
      })
    ).headers.location,
  ).toBe('/account?garmin=failed');
});
it('exposes unconfigured status without breaking the application OIDC session', async () => {
  const { app } = fixture(false);
  expect((await app.inject({ url: '/bff/v1/integrations/garmin/status', headers })).json()).toEqual(
    { configured: false, state: 'not_connected', permissions: [], connectedAt: null },
  );
  expect(
    (await app.inject({ method: 'POST', url: '/bff/v1/integrations/garmin/connect', headers }))
      .statusCode,
  ).toBe(503);
  expect((await app.inject({ url: '/bff/v1/session', headers })).statusCode).toBe(200);
});
