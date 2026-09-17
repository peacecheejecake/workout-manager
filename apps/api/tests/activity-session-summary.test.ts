import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActivityRepository } from '@workout/server-persistence/activities';
import { createApi } from '../src/app.js';
const athleteId = 'athlete-from-auth';
const csrfToken = 'c'.repeat(43);
const headers = {
  cookie: 'session=verified-by-port',
  origin: 'https://workout.example',
  'x-csrf-token': csrfToken,
  'x-workout-session-id': 'session-current',
  'idempotency-key': 'plan-save-0001',
};
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const activities = {
    createManualActivity: vi.fn<ActivityRepository['createManualActivity']>(),
    listActivities: vi.fn(async () => ({ items: [], total: 0 })),
    getActivity: vi.fn<ActivityRepository['getActivity']>().mockResolvedValue(null),
    getActivityDetails: vi.fn<ActivityRepository['getActivityDetails']>().mockResolvedValue(null),
    importActivity: vi.fn(),
    updateOverlay: vi.fn<ActivityRepository['updateOverlay']>(),
    deleteActivity: vi.fn(),
    summary: vi.fn(async () => ({
      count: 0,
      distanceMeters: { value: null, knownCount: 0 },
      durationSeconds: {
        value: null,
        knownCount: 0,
        byKind: {
          timer: { value: null, knownCount: 0 },
          elapsed: { value: null, knownCount: 0 },
          moving: { value: null, knownCount: 0 },
          unknown: { value: null, knownCount: 0 },
        },
      },
    })),
  };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? { athleteId, sessionId: 'session-current', csrfToken, method: 'cookie' }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    activities,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, activities };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const activity = {
  title: 'Synthetic summary',
  kind: 'running',
  startedAt: '2024-01-01T12:00:00Z',
  timezone: 'UTC',
  distanceMeters: 0,
  durationSeconds: null,
  durationKind: 'unknown',
} as const;
const source = {
  kind: 'fit',
  sourceId: 'sha256:synthetic:session:0',
  revision: 3,
  contentHash: 'a'.repeat(64),
} as const;
const details = {
  schemaVersion: 2 as const,
  streamIndex: 0,
  sessionIndex: 0,
  startedAt: activity.startedAt,
  recordedAt: null,
  elapsedSeconds: null,
  records: [],
  laps: [],
  sessionSummary: { averageHeartRateBpm: 0, maximumHeartRateBpm: null },
};
describe('activity session summary wire boundary', () => {
  it.each([
    { averageHeartRateBpm: -1, maximumHeartRateBpm: null },
    { averageHeartRateBpm: 0.5, maximumHeartRateBpm: null },
    { averageHeartRateBpm: 256, maximumHeartRateBpm: null },
    { averageHeartRateBpm: '120', maximumHeartRateBpm: null },
    { averageHeartRateBpm: null },
    { averageHeartRateBpm: 0, maximumHeartRateBpm: null, source: 'estimated' },
  ])('rejects invalid session summaries %#', async (sessionSummary) => {
    const { app, activities } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/activity-imports',
          headers,
          payload: { source, activity, details: { ...details, sessionSummary } },
        })
      ).statusCode,
    ).toBe(400);
    expect(activities.importActivity).not.toHaveBeenCalled();
  });
  it('forwards explicit source v2 zero/unknown summary unchanged under authenticated ownership', async () => {
    const { app, activities } = setup();
    activities.importActivity.mockResolvedValue({
      activityId: id,
      revision: 1,
      outcome: 'imported',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/activity-imports',
      headers,
      payload: { source, activity, details },
    });
    expect(response.statusCode).toBe(200);
    expect(activities.importActivity).toHaveBeenCalledWith(athleteId, {
      source,
      activity,
      details,
      idempotencyKey: headers['idempotency-key'],
    });
    activities.getActivityDetails.mockResolvedValue({
      activityId: id,
      activityRevision: 1,
      source,
      details,
    });
    const read = await app.inject({ url: `/bff/v1/activities/${id}/details`, headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().details).toEqual(details);
    expect(activities.getActivityDetails).toHaveBeenCalledWith(athleteId, id);
  });
  it('keeps legacy detail v1 absent summary exact and rejects v2 missing summary or client ownership fields', async () => {
    const { app, activities } = setup();
    activities.importActivity.mockResolvedValue({
      activityId: id,
      revision: 1,
      outcome: 'imported',
    });
    const { sessionSummary: _, ...legacyBase } = details;
    const legacy = { ...legacyBase, schemaVersion: 1 };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/activity-imports',
          headers,
          payload: { source, activity, details: legacy },
        })
      ).statusCode,
    ).toBe(200);
    expect(activities.importActivity).toHaveBeenCalledWith(athleteId, {
      source,
      activity,
      details: legacy,
      idempotencyKey: headers['idempotency-key'],
    });
    activities.importActivity.mockClear();
    for (const payload of [
      { source, activity, details: legacyBase },
      { source, activity, details, athleteId: 'other' },
      { source, activity, details: { ...legacy, sessionSummary: details.sessionSummary } },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/bff/v1/activity-imports', headers, payload }))
          .statusCode,
      ).toBe(400);
    expect(activities.importActivity).not.toHaveBeenCalled();
  });
});
