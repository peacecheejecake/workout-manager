import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HealthKitReviewError } from '@workout/server-persistence/healthkit-projection';
import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const response = {
  items: [
    {
      sampleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedSampleDigest: 'c'.repeat(64),
      kind: 'running',
      observedFrom: '2026-09-20T00:00:00.000Z',
      observedTo: '2026-09-20T00:35:00.000Z',
      durationSeconds: 2100,
      distanceMeters: 5000,
    },
  ],
} as const;
const instances: ReturnType<typeof createApi>[] = [];

function setup(authenticated = true) {
  const listPendingWorkouts = vi.fn().mockResolvedValue(response);
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated ? { athleteId, sessionId: 'owner-session', method: 'bearer' } : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    healthKitReview: { listPendingWorkouts },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  instances.push(app);
  return { app, listPendingWorkouts };
}

afterEach(async () => Promise.all(instances.splice(0).map((app) => app.close())));

it('reads only the authenticated owner review queue with a bounded limit', async () => {
  const { app, listPendingWorkouts } = setup();
  const result = await app.inject({
    method: 'GET',
    url: '/bff/v1/healthkit/workout-review?limit=2',
    headers: { authorization: 'Bearer owner-token' },
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual(response);
  expect(listPendingWorkouts).toHaveBeenCalledWith(athleteId, 2);

  const defaultLimit = await app.inject({
    method: 'GET',
    url: '/bff/v1/healthkit/workout-review',
    headers: { authorization: 'Bearer owner-token' },
  });
  expect(defaultLimit.statusCode).toBe(200);
  expect(listPendingWorkouts).toHaveBeenLastCalledWith(athleteId, 50);
});

it('rejects invalid queries before storage access and requires a session', async () => {
  const { app, listPendingWorkouts } = setup();
  for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=1.5', 'athleteId=other']) {
    const result = await app.inject({
      method: 'GET',
      url: `/bff/v1/healthkit/workout-review?${query}`,
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(result.statusCode).toBe(400);
  }
  expect(listPendingWorkouts).not.toHaveBeenCalled();
  const absent = setup(false);
  const rejected = await absent.app.inject({
    method: 'GET',
    url: '/bff/v1/healthkit/workout-review',
  });
  expect(rejected.statusCode).toBe(401);
  expect(absent.listPendingWorkouts).not.toHaveBeenCalled();
});

it('reports withdrawn consent without returning a cached queue', async () => {
  const { app, listPendingWorkouts } = setup();
  listPendingWorkouts.mockRejectedValueOnce(new HealthKitReviewError('CONSENT_REQUIRED'));
  const result = await app.inject({
    method: 'GET',
    url: '/bff/v1/healthkit/workout-review',
    headers: { authorization: 'Bearer owner-token' },
  });
  expect(result.statusCode).toBe(403);
  expect(result.json().error.code).toBe('CONSENT_REQUIRED');
  expect(result.body).not.toContain(response.items[0].sampleId);
});
