import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HealthKitRegistrationError } from '@workout/server-persistence/healthkit-registration';
import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sampleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const claimEpoch = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const command = {
  schemaVersion: 1,
  sampleIds: [sampleId],
  accountAttributionDeclared: true,
  expectedConsentRevision: 1,
  expectedRegistryRevision: 0,
  idempotencyKey: 'registration-1',
} as const;
const result = { schemaVersion: 1, claims: [{ sampleId, claimEpoch }], registryRevision: 1 };
const instances: ReturnType<typeof createApi>[] = [];
function setup(method: 'bearer' | 'cookie' | null = 'bearer', owner = athleteId) {
  const registerWorkouts = vi.fn().mockResolvedValue(result);
  const listWorkouts = vi.fn().mockResolvedValue({ ...result, nextCursor: null });
  const app = createApi({
    auth: {
      authenticate: async () =>
        method === null
          ? null
          : method === 'bearer'
            ? { athleteId: owner, sessionId: 'native-session', method }
            : { athleteId: owner, sessionId: 'browser-session', method, csrfToken: 'c'.repeat(43) },
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    healthKitRegistration: { registerWorkouts, listWorkouts },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  instances.push(app);
  return { app, registerWorkouts, listWorkouts };
}
const headers = { authorization: 'Bearer native-token' };
afterEach(async () => Promise.all(instances.splice(0).map((app) => app.close())));

it('registers only the bearer account and forwards the idempotency identity unchanged', async () => {
  const { app, registerWorkouts } = setup();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-registrations',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
  }
  expect(registerWorkouts).toHaveBeenCalledTimes(2);
  expect(registerWorkouts).toHaveBeenCalledWith(athleteId, command);
});

it('lists only the authenticated account with validated cursor and no-store', async () => {
  const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { app, listWorkouts } = setup('bearer', other);
  const response = await app.inject({
    method: 'GET',
    url: '/bff/v1/healthkit/workout-registrations?limit=25&cursor=opaque_cursor',
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(listWorkouts).toHaveBeenCalledWith(other, { limit: '25', cursor: 'opaque_cursor' });
});

it('rejects cookie and unauthenticated list/register before storage', async () => {
  for (const method of ['cookie', null] as const) {
    const { app, listWorkouts, registerWorkouts } = setup(method);
    for (const verb of ['GET', 'POST'] as const) {
      const response = await app.inject({
        method: verb,
        url: '/bff/v1/healthkit/workout-registrations',
        headers:
          method === 'cookie'
            ? {
                cookie: 'session=fixture',
                origin: 'https://workout.example',
                'x-workout-session-id': 'browser-session',
                'x-csrf-token': 'c'.repeat(43),
              }
            : {},
        ...(verb === 'POST' ? { payload: command } : {}),
      });
      expect(response.statusCode).toBe(method === 'cookie' ? 403 : 401);
    }
    expect(listWorkouts).not.toHaveBeenCalled();
    expect(registerWorkouts).not.toHaveBeenCalled();
  }
});

it('rejects undeclared attribution, duplicates, oversized commands and client ownership', async () => {
  const { app, registerWorkouts } = setup();
  for (const payload of [
    { ...command, accountAttributionDeclared: false },
    { ...command, sampleIds: [sampleId, sampleId] },
    { ...command, athleteId },
    { ...command, expectedConsentRevision: 0 },
    { ...command, idempotencyKey: 'x' },
    { ...command, sampleIds: Array(51).fill(sampleId) },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-registrations',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  }
  expect(registerWorkouts).not.toHaveBeenCalled();
});

it('rejects invalid list and registration query parameters before storage', async () => {
  const { app, listWorkouts, registerWorkouts } = setup();
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=01',
    'cursor=%2F',
    `athleteId=${athleteId}`,
    'limit=1&limit=2',
  ]) {
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/healthkit/workout-registrations?${query}`,
      headers,
    });
    expect(response.statusCode).toBe(400);
  }
  const response = await app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-registrations?extra=1',
    headers,
    payload: command,
  });
  expect(response.statusCode).toBe(400);
  expect(listWorkouts).not.toHaveBeenCalled();
  expect(registerWorkouts).not.toHaveBeenCalled();
});

it('maps conflict errors without revealing the other account or sample', async () => {
  const { app, registerWorkouts, listWorkouts } = setup();
  for (const [code, status] of [
    ['CONSENT_REQUIRED', 403],
    ['CONSENT_EPOCH_EXPIRED', 409],
    ['CLAIM_CONFLICT', 409],
    ['REGISTRY_REVISION_CONFLICT', 409],
    ['IDEMPOTENCY_CONFLICT', 409],
  ] as const) {
    registerWorkouts.mockRejectedValueOnce(new HealthKitRegistrationError(code));
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-registrations',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: { code }, requestId: expect.any(String) });
  }
  listWorkouts.mockRejectedValueOnce(new HealthKitRegistrationError('REGISTRY_REVISION_CONFLICT'));
  const response = await app.inject({
    method: 'GET',
    url: '/bff/v1/healthkit/workout-registrations?cursor=other_account_cursor',
    headers,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    error: { code: 'REGISTRY_REVISION_CONFLICT' },
    requestId: expect.any(String),
  });
});

it('sanitizes unexpected repository errors and rejects malformed acknowledgements', async () => {
  const { app, registerWorkouts } = setup();
  registerWorkouts.mockRejectedValueOnce(new Error('private account or provider payload'));
  registerWorkouts.mockResolvedValueOnce({ ...result, athleteId });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-registrations',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private account');
    expect(response.body).not.toContain(athleteId);
  }
});
