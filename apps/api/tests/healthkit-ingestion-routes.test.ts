import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HealthKitIngestionError } from '@workout/server-persistence/healthkit-ingestion';
import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const batch = {
  schemaVersion: 1,
  installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  events: [
    {
      kind: 'upsert',
      sampleId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sourceBundleId: 'com.example.watch',
      sourceVersion: null,
      activityType: 37,
      observedFrom: '2026-09-28T01:00:00.000Z',
      observedTo: '2026-09-28T01:30:00.000Z',
      durationSeconds: 1800,
      distanceMeters: 5000,
      energyKilocalories: null,
    },
  ],
} as const;
const ack = {
  schemaVersion: 1,
  installationId: batch.installationId,
  batchId: batch.batchId,
  acceptedCount: 1,
} as const;
const instances: ReturnType<typeof createApi>[] = [];
function setup(method: 'bearer' | 'cookie' | null = 'bearer') {
  const ingestBatch = vi.fn().mockResolvedValue(ack);
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
    healthKitIngestion: { ingestBatch },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  instances.push(app);
  return { app, ingestBatch };
}
afterEach(async () => Promise.all(instances.splice(0).map((app) => app.close())));

it('accepts a bounded workout batch only for the authenticated bearer owner', async () => {
  const { app, ingestBatch } = setup();
  const response = await app.inject({
    method: 'POST',
    url: '/bff/v1/healthkit/workout-batches',
    headers: { authorization: 'Bearer native-token' },
    payload: batch,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(ack);
  expect(ingestBatch).toHaveBeenCalledWith(athleteId, batch);
});

it('rejects cookie and unauthenticated writes before reaching storage', async () => {
  for (const method of ['cookie', null] as const) {
    const { app, ingestBatch } = setup(method);
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-batches',
      headers:
        method === 'cookie'
          ? {
              cookie: 'session=fixture',
              origin: 'https://workout.example',
              'x-workout-session-id': 'browser-session',
              'x-csrf-token': 'c'.repeat(43),
            }
          : {},
      payload: batch,
    });
    expect(response.statusCode).toBe(method === 'cookie' ? 403 : 401);
    expect(ingestBatch).not.toHaveBeenCalled();
  }
});

it('rejects extra fields and duplicate sample IDs before reaching storage', async () => {
  const { app, ingestBatch } = setup();
  for (const payload of [
    { ...batch, athleteId },
    { ...batch, events: [batch.events[0], batch.events[0]] },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-batches',
      headers: { authorization: 'Bearer native-token' },
      payload,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(ingestBatch).not.toHaveBeenCalled();
});

it('maps consent withdrawal and reused batch identity to stable errors', async () => {
  const { app, ingestBatch } = setup();
  for (const [code, status] of [
    ['CONSENT_REQUIRED', 403],
    ['IDEMPOTENCY_CONFLICT', 409],
  ] as const) {
    ingestBatch.mockRejectedValueOnce(new HealthKitIngestionError(code));
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/healthkit/workout-batches',
      headers: { authorization: 'Bearer native-token' },
      payload: batch,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
  }
});
