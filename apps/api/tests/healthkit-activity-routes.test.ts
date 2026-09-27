import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HealthKitActivityError } from '@workout/server-persistence/healthkit-activity';
import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const command = {
  sampleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expectedSampleDigest: 'c'.repeat(64),
  confirmed: true,
  idempotencyKey: 'create-request-001',
} as const;
const result = {
  sampleId: command.sampleId,
  activityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  activityRevision: 1,
  state: 'created_activity',
} as const;
const instances: ReturnType<typeof createApi>[] = [];

function setup(method: 'bearer' | 'cookie' | null = 'bearer') {
  const createActivity = vi.fn().mockResolvedValue(result);
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
    healthKitActivity: { createActivity },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  instances.push(app);
  return { app, createActivity };
}

afterEach(async () => Promise.all(instances.splice(0).map((app) => app.close())));

it('uses the authenticated owner and requires an explicit source-bound decision', async () => {
  const { app, createActivity } = setup();
  const accepted = await app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-activities',
    headers: { authorization: 'Bearer native-token' },
    payload: command,
  });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toEqual(result);
  expect(createActivity).toHaveBeenCalledWith(athleteId, command);

  for (const invalid of [
    { ...command, confirmed: false },
    { ...command, athleteId: 'other' },
    { ...command, expectedSampleDigest: 'bad' },
    { ...command, title: 'invented' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-activities',
      headers: { authorization: 'Bearer native-token' },
      payload: invalid,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(createActivity).toHaveBeenCalledTimes(1);
});

it('requires a cookie CSRF proof and rejects unauthenticated requests', async () => {
  const cookie = setup('cookie');
  const rejected = await cookie.app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-activities',
    headers: {
      cookie: 'session=fixture',
      origin: 'https://workout.example',
      'x-workout-session-id': 'browser-session',
    },
    payload: command,
  });
  expect(rejected.statusCode).toBe(403);
  expect(cookie.createActivity).not.toHaveBeenCalled();

  const absent = setup(null);
  const unauthenticated = await absent.app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-activities',
    payload: command,
  });
  expect(unauthenticated.statusCode).toBe(401);
  expect(absent.createActivity).not.toHaveBeenCalled();
});

it('exposes stale and duplicate choices as bounded conflicts', async () => {
  const { app, createActivity } = setup();
  for (const code of ['DIGEST_CONFLICT', 'ALREADY_LINKED', 'IDEMPOTENCY_CONFLICT'] as const) {
    createActivity.mockRejectedValueOnce(new HealthKitActivityError(code));
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-activities',
      headers: { authorization: 'Bearer native-token' },
      payload: command,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(code);
  }
});
