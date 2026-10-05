import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HealthKitDeregistrationError } from '@workout/server-persistence/healthkit-deregistration';
import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sampleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const command = {
  schemaVersion: 1,
  sampleId,
  claimEpoch: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  expectedConsentRevision: 1,
  expectedRegistryRevision: 1,
  confirmRelatedRecordDeletion: true,
  idempotencyKey: 'deregister-1',
} as const;
const result = { schemaVersion: 1, operationId, status: 'pending_cleanup', registryRevision: 2 };
const instances: ReturnType<typeof createApi>[] = [];
function setup(method: 'bearer' | 'cookie' | null = 'bearer', owner = athleteId) {
  const deregisterWorkout = vi.fn().mockResolvedValue(result);
  const getStatus = vi.fn().mockResolvedValue(result);
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
    healthKitDeregistration: { deregisterWorkout, getStatus },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  instances.push(app);
  return { app, deregisterWorkout, getStatus };
}
const headers = { authorization: 'Bearer native-token' };
const url = '/bff/v1/healthkit/workout-deregistrations';
afterEach(async () => Promise.all(instances.splice(0).map((app) => app.close())));

it('forwards the account and idempotency identity without claiming pending cleanup is released', async () => {
  const { app, deregisterWorkout } = setup();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({ method: 'POST', url, headers, payload: command });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(result);
  }
  expect(deregisterWorkout).toHaveBeenCalledTimes(2);
  expect(deregisterWorkout).toHaveBeenCalledWith(athleteId, command);
});

it('reads only the authenticated account status and preserves the repository completion fact', async () => {
  const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { app, getStatus } = setup('bearer', other);
  getStatus.mockResolvedValueOnce({ ...result, status: 'released', registryRevision: 3 });
  const response = await app.inject({
    method: 'GET',
    url: `${url}?operationId=${operationId}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({ ...result, status: 'released', registryRevision: 3 });
  expect(getStatus).toHaveBeenCalledWith(other, operationId);
});

it('rejects cookie and unauthenticated requests before either repository method', async () => {
  for (const method of ['cookie', null] as const) {
    const { app, deregisterWorkout, getStatus } = setup(method);
    for (const verb of ['GET', 'POST'] as const) {
      const response = await app.inject({
        method: verb,
        url: verb === 'GET' ? `${url}?operationId=${operationId}` : url,
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
    expect(deregisterWorkout).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  }
});

it('rejects missing confirmation, malformed epochs, client ownership or completion, and unbounded input', async () => {
  const { app, deregisterWorkout, getStatus } = setup();
  for (const payload of [
    { ...command, confirmRelatedRecordDeletion: false },
    { ...command, claimEpoch: 'invalid' },
    { ...command, athleteId },
    { ...command, status: 'released' },
    { ...command, expectedConsentRevision: 0 },
    { ...command, expectedRegistryRevision: -1 },
    { ...command, idempotencyKey: 'x'.repeat(129) },
  ]) {
    const response = await app.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(400);
  }
  for (const query of [
    '',
    'operationId=invalid',
    `operationId=${operationId}&athleteId=${athleteId}`,
    `operationId=${operationId}&operationId=${operationId}`,
    `operationId=${operationId}&complete=true`,
  ]) {
    const response = await app.inject({ method: 'GET', url: `${url}?${query}`, headers });
    expect(response.statusCode).toBe(400);
  }
  expect(
    (await app.inject({ method: 'POST', url: `${url}?extra=1`, headers, payload: command }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...command, idempotencyKey: 'x'.repeat(5000) },
      })
    ).statusCode,
  ).toBe(413);
  expect(deregisterWorkout).not.toHaveBeenCalled();
  expect(getStatus).not.toHaveBeenCalled();
});

it('maps consent, stale epoch/revision and private missing-operation errors to stable envelopes', async () => {
  const { app, deregisterWorkout, getStatus } = setup();
  for (const [code, status] of [
    ['CONSENT_REQUIRED', 403],
    ['CONSENT_EPOCH_EXPIRED', 409],
    ['CLAIM_EPOCH_EXPIRED', 409],
    ['REGISTRY_REVISION_CONFLICT', 409],
    ['IDEMPOTENCY_CONFLICT', 409],
    ['DEREGISTRATION_PENDING', 409],
    ['INVALID_REQUEST', 400],
  ] as const) {
    deregisterWorkout.mockRejectedValueOnce(new HealthKitDeregistrationError(code));
    const response = await app.inject({ method: 'POST', url, headers, payload: command });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: { code }, requestId: expect.any(String) });
    expect(response.body).not.toContain(sampleId);
  }
  getStatus.mockRejectedValueOnce(new HealthKitDeregistrationError('DEREGISTRATION_NOT_FOUND'));
  const response = await app.inject({
    method: 'GET',
    url: `${url}?operationId=${operationId}`,
    headers,
  });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({
    error: { code: 'DEREGISTRATION_NOT_FOUND' },
    requestId: expect.any(String),
  });
  expect(response.body).not.toContain(operationId);
});

it('sanitizes unexpected failures and validates acknowledgements before exposing them', async () => {
  const { app, deregisterWorkout, getStatus } = setup();
  deregisterWorkout.mockRejectedValueOnce(new Error('private account and provider payload'));
  deregisterWorkout.mockResolvedValueOnce({ ...result, sampleId });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({ method: 'POST', url, headers, payload: command });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private account');
    expect(response.body).not.toContain(sampleId);
  }
  getStatus.mockResolvedValueOnce({ ...result, status: 'complete' });
  expect(
    (await app.inject({ method: 'GET', url: `${url}?operationId=${operationId}`, headers }))
      .statusCode,
  ).toBe(500);
});

it('does not expose a client finalization route', async () => {
  const { app, deregisterWorkout, getStatus } = setup();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${url}/finalize`,
        headers,
        payload: { operationId },
      })
    ).statusCode,
  ).toBe(404);
  expect(deregisterWorkout).not.toHaveBeenCalled();
  expect(getStatus).not.toHaveBeenCalled();
});

it('refuses unknown receipt membership with a private conflict and no completion claim', async () => {
  const { app, deregisterWorkout } = setup();
  deregisterWorkout.mockRejectedValueOnce(
    new HealthKitDeregistrationError('RECEIPT_MEMBERSHIP_REQUIRED'),
  );
  const response = await app.inject({ method: 'POST', url, headers, payload: command });
  expect(response.statusCode).toBe(409);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({
    error: { code: 'RECEIPT_MEMBERSHIP_REQUIRED' },
    requestId: expect.any(String),
  });
  expect(response.body).not.toContain(sampleId);
  expect(response.body).not.toContain(athleteId);
  expect(response.body).not.toContain('released');
});
