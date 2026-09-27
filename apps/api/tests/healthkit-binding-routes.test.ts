import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HealthKitBindingError } from '@workout/server-persistence/healthkit-binding';
import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const command = {
  sampleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  targetActivityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  expectedActivityRevision: 2,
  expectedSampleDigest: 'd'.repeat(64),
  confirmed: true,
  idempotencyKey: 'bind-request-001',
} as const;
const result = {
  sampleId: command.sampleId,
  activityId: command.targetActivityId,
  activityRevision: command.expectedActivityRevision,
  state: 'linked_existing',
} as const;
const instances: ReturnType<typeof createApi>[] = [];

function setup(method: 'bearer' | 'cookie' | null = 'bearer') {
  const bindExisting = vi.fn().mockResolvedValue(result);
  const app = createApi({
    auth: {
      authenticate: async () =>
        method === null
          ? null
          : method === 'bearer'
            ? { athleteId, sessionId: 'native-session', method }
            : {
                athleteId,
                sessionId: 'browser-session',
                method,
                csrfToken: 'c'.repeat(43),
              },
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    healthKitBinding: { bindExisting },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  instances.push(app);
  return { app, bindExisting };
}

afterEach(async () => Promise.all(instances.splice(0).map((app) => app.close())));

it('binds only for the authenticated owner after explicit confirmation', async () => {
  const { app, bindExisting } = setup();
  const response = await app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-bindings',
    headers: { authorization: 'Bearer native-token' },
    payload: command,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(result);
  expect(bindExisting).toHaveBeenCalledWith(athleteId, command);
});

it('rejects missing confirmation, client ownership, and malformed digests', async () => {
  const { app, bindExisting } = setup();
  for (const payload of [
    { ...command, confirmed: false },
    { ...command, athleteId },
    { ...command, expectedSampleDigest: 'bad' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-bindings',
      headers: { authorization: 'Bearer native-token' },
      payload,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(bindExisting).not.toHaveBeenCalled();
});

it('requires cookie CSRF and rejects unauthenticated writes before storage', async () => {
  const { app, bindExisting } = setup('cookie');
  const rejected = await app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-bindings',
    headers: {
      cookie: 'session=fixture',
      origin: 'https://workout.example',
      'x-workout-session-id': 'browser-session',
    },
    payload: command,
  });
  expect(rejected.statusCode).toBe(403);
  expect(bindExisting).not.toHaveBeenCalled();

  const accepted = await app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-bindings',
    headers: {
      cookie: 'session=fixture',
      origin: 'https://workout.example',
      'x-workout-session-id': 'browser-session',
      'x-csrf-token': 'c'.repeat(43),
    },
    payload: command,
  });
  expect(accepted.statusCode).toBe(200);

  const unauthenticated = setup(null);
  const response = await unauthenticated.app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-bindings',
    payload: command,
  });
  expect(response.statusCode).toBe(401);
  expect(unauthenticated.bindExisting).not.toHaveBeenCalled();
});

it('maps stale source and reused idempotency keys to stable conflicts', async () => {
  const { app, bindExisting } = setup();
  for (const code of ['DIGEST_CONFLICT', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT'] as const) {
    bindExisting.mockRejectedValueOnce(new HealthKitBindingError(code));
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-bindings',
      headers: { authorization: 'Bearer native-token' },
      payload: command,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(code);
  }
});
