import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@workout/contracts/activity';
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
const manualId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const manualBody = {
  confirmed: true,
  activity: {
    title: 'Synthetic manual run',
    kind: 'running',
    startedAt: '2022-08-03T12:00:00Z',
    timezone: 'UTC',
    distanceMeters: 0,
    durationSeconds: null,
    durationKind: 'unknown',
  },
  report: { sessionRpe: 0, note: 'Synthetic self report', planLink: null },
} as const;
const correctionBody = {
  expectedRevision: 1,
  reason: 'Synthetic correction',
  kind: 'walking',
  startedAt: '2022-08-03T13:00:00Z',
  timezone: 'Asia/Seoul',
  report: { sessionRpe: null, note: null, planLink: null },
} as const;
const correctedActivity: Activity = {
  id: manualId,
  revision: 2,
  source: { kind: 'manual', sourceId: manualId, revision: 1, contentHash: 'a'.repeat(64) },
  original: manualBody.activity,
  overlay: {
    kind: correctionBody.kind,
    startedAt: correctionBody.startedAt,
    timezone: correctionBody.timezone,
    reason: correctionBody.reason,
  },
  effective: {
    ...manualBody.activity,
    kind: 'walking',
    startedAt: correctionBody.startedAt,
    timezone: 'Asia/Seoul',
  },
  userReport: {
    sessionRpe: null,
    note: null,
    planLink: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'activity-report-v1',
    rpeReportedAt: null,
  },
};

describe('activity local tag API', () => {
  it.each(
    [
      null,
      [''],
      ['a', ' a '],
      ['café', 'café'],
      ['a'.repeat(41)],
      ['line\nbreak'],
      Array.from({ length: 21 }, (_, index) => String(index)),
    ].map((tags) => ({ tags })),
  )('rejects invalid tag set %#', async ({ tags }) => {
    const { app, activities } = setup();
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/activities/${manualId}`,
      headers,
      payload: { expectedRevision: 1, reason: 'Local organization', tags },
    });
    expect(response.statusCode).toBe(400);
    expect(activities.updateOverlay).not.toHaveBeenCalled();
  });
  it.each([['café', 'Run', '%_\\'], []].map((tags) => ({ tags })))(
    'normalizes a tag-only correction and accepts explicit clear %#',
    async ({ tags }) => {
      const { app, activities } = setup();
      activities.updateOverlay.mockResolvedValue(correctedActivity);
      const response = await app.inject({
        method: 'PATCH',
        url: `/bff/v1/activities/${manualId}`,
        headers,
        payload: { expectedRevision: 1, reason: 'Local organization', tags },
      });
      expect(response.statusCode).toBe(200);
      expect(activities.updateOverlay).toHaveBeenCalledWith(athleteId, manualId, {
        expectedRevision: 1,
        reason: 'Local organization',
        tags: tags.map((value) => value.normalize('NFC')),
        idempotencyKey: headers['idempotency-key'],
      });
    },
  );
  it('normalizes an exact literal tag query and preserves all other filters', async () => {
    const { app, activities } = setup();
    const query = new URLSearchParams({
      tag: ' café ',
      quality: 'corrected',
      source: 'fixture',
      limit: '1',
      offset: '2',
    });
    expect((await app.inject({ url: `/bff/v1/activities?${query}`, headers })).statusCode).toBe(
      200,
    );
    expect(activities.listActivities).toHaveBeenCalledWith(athleteId, {
      tag: 'café',
      quality: 'corrected',
      source: 'fixture',
      limit: 1,
      offset: 2,
    });
    expect((await app.inject({ url: '/bff/v1/activities?tag=', headers })).statusCode).toBe(400);
  });
  it('requires same-session CSRF authorization for tag edits', async () => {
    const { app, activities } = setup();
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/activities/${manualId}`,
      headers: { ...headers, 'x-csrf-token': 'wrong' },
      payload: { expectedRevision: 1, reason: 'Local organization', tags: ['local'] },
    });
    expect(response.statusCode).toBe(403);
    expect(activities.updateOverlay).not.toHaveBeenCalled();
  });
});
