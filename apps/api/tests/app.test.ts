import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/app.js';
import type { Principal } from '../src/ports.js';
import { PersistenceConflict } from '@workout/server-persistence/repositories';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'a-session-bound-csrf-token-of-32-bytes';
const cookiePrincipal: Principal = {
  athleteId,
  sessionId: 'session-a',
  method: 'cookie',
  csrfToken: token,
};
const instances: ReturnType<typeof createApi>[] = [];
function fixture(identity: unknown = cookiePrincipal) {
  const logs: string[] = [];
  const auth = { authenticate: vi.fn(async () => identity) };
  const consent = {
    getConsent: vi.fn(
      async (_athleteId: string, kind: 'ai' | 'app' | 'provider' | 'healthkit' | 'media') => ({
        kind,
        granted: false,
        revision: 0,
      }),
    ),
    setConsent: vi.fn(async () => ({ kind: 'ai' as const, granted: true, revision: 1 })),
  };
  const close = vi.fn(async () => undefined);
  const app = createApi({
    auth,
    consent,
    close,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, auth, consent, logs, close };
}
const headers = {
  cookie: 'session=private-cookie',
  origin: 'https://workout.example',
  'x-csrf-token': token,
  'idempotency-key': 'request-0001',
};
const payload = { granted: true, expectedRevision: 0 };
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('M0-05 API boundary (FUT-01; V2-F31)', () => {
  it('keeps health public and denies missing or invalid verified identity', async () => {
    const { app, auth } = fixture(null);
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect((await app.inject('/bff/v1/session')).statusCode).toBe(401);
  });
  it('uses authenticated athlete scope and excludes private session data', async () => {
    const { app, consent } = fixture();
    const session = await app.inject('/bff/v1/session');
    expect(session.json()).toEqual({ athleteId });
    expect(session.headers['cache-control']).toBe('no-store');
    expect((await app.inject('/bff/v1/consents/ai')).statusCode).toBe(200);
    expect(consent.getConsent).toHaveBeenCalledWith(athleteId, 'ai');
    expect((await app.inject('/bff/v1/consents/ai?athleteId=other')).statusCode).toBe(400);
  });
  it('passes only valid revisioned consent commands and stable idempotency keys', async () => {
    const { app, consent } = fixture();
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/consents/ai',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(consent.setConsent).toHaveBeenCalledWith(athleteId, {
      kind: 'ai',
      ...payload,
      idempotencyKey: 'request-0001',
    });
  });
  it.each([
    { ...headers, origin: 'https://evil.example' },
    { ...headers, origin: 'null' },
    { ...headers, origin: 'https://workout.example.evil' },
    { ...headers, 'x-csrf-token': 'wrong' },
    { cookie: headers.cookie, 'idempotency-key': headers['idempotency-key'] },
  ])('rejects cookie writes lacking exact origin and session CSRF token', async (inputHeaders) => {
    const { app, consent } = fixture();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/bff/v1/consents/ai',
          headers: inputHeaders,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(consent.setConsent).not.toHaveBeenCalled();
  });
  it('permits verified bearer transport without cookie CSRF proof', async () => {
    const { app, auth } = fixture({ athleteId, sessionId: 'native-a', method: 'bearer' });
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/consents/ai',
      headers: { authorization: 'Bearer secret', 'idempotency-key': 'native-0001' },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(auth.authenticate).toHaveBeenCalledWith({ authorization: 'Bearer secret' });
  });
  it.each([
    { ...payload, athleteId: 'other' },
    { granted: true, expectedRevision: -1 },
    { granted: 'yes', expectedRevision: 0 },
    { granted: true },
  ])('rejects malformed or client-owned tenant fields', async (body) => {
    const { app, consent } = fixture();
    expect(
      (await app.inject({ method: 'PUT', url: '/bff/v1/consents/ai', headers, payload: body }))
        .statusCode,
    ).toBe(400);
    expect(consent.setConsent).not.toHaveBeenCalled();
  });
  it('rejects invalid resource kinds and missing idempotency keys', async () => {
    const { app } = fixture();
    expect((await app.inject('/bff/v1/consents/unknown')).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/bff/v1/consents/ai',
          headers: { ...headers, 'idempotency-key': '' },
          payload,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('returns stable conflict codes without exposing adapter messages', async () => {
    const { app, consent } = fixture();
    consent.setConsent.mockRejectedValue(new PersistenceConflict('REVISION_CONFLICT'));
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/consents/ai',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONSENT_CONFLICT' } });
  });
  it('sanitizes errors and correlated operational logs', async () => {
    const { app, consent, logs } = fixture();
    consent.getConsent.mockRejectedValue(
      new Error('secret-token raw-health gps=37.123 cookie=private'),
    );
    const response = await app.inject({
      url: '/bff/v1/consents/ai',
      headers: {
        authorization: 'Bearer secret-token',
        cookie: 'session=private',
        'x-request-id': 'attacker-value',
      },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    const output = response.body + logs.join('');
    for (const value of [
      'secret-token',
      'raw-health',
      '37.123',
      'session=private',
      'attacker-value',
    ])
      expect(output).not.toContain(value);
    expect(logs.join('')).toContain('request_failed');
    expect(logs.join('')).toContain('reqId');
  });
  it('bounds body parsing and sanitizes unknown routes and malformed JSON', async () => {
    const { app } = fixture();
    const large = await app.inject({
      method: 'PUT',
      url: '/bff/v1/consents/ai',
      headers,
      payload: { ...payload, private: 'x'.repeat(20_000) },
    });
    expect(large.statusCode).toBe(413);
    const malformed = await app.inject({
      method: 'PUT',
      url: '/bff/v1/consents/ai',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{private=',
    });
    expect(malformed.statusCode).toBe(400);
    expect((await app.inject('/secret-token')).body).not.toContain('secret-token');
  });
  it('closes injected owned resources once', async () => {
    const { app, close } = fixture();
    await app.ready();
    await app.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
