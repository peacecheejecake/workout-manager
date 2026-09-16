import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shiftDashboardDate, type DashboardReadModel } from '@workout/contracts/dashboard';
import type { DashboardRepository } from '@workout/server-persistence/dashboard';
import { createApi } from '../src/app.js';

const athleteId = 'athlete-from-auth';
const headers = {
  cookie: 'session=verified-by-port',
  'x-workout-session-id': 'session-current',
};
const query = 'anchor=2026-09-16&timezone=Asia%2FSeoul';
const url = `/bff/v1/dashboard?${query}`;
function fixture(days = 10): DashboardReadModel {
  const from = shiftDashboardDate('2026-09-16', 1 - days);
  const missing = { value: null, knownCount: 0, missingCount: 0 };
  const actual = {
    count: 1,
    distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
    durationSeconds: {
      timer: { ...missing, missingCount: 1 },
      elapsed: missing,
      moving: missing,
      unknown: missing,
    },
    sources: { fit: 1, fixture: 0 },
    overlayCount: 1,
  };
  const emptyActual = {
    count: 0,
    distanceMeters: missing,
    durationSeconds: { timer: missing, elapsed: missing, moving: missing, unknown: missing },
    sources: { fit: 0, fixture: 0 },
    overlayCount: 0,
  };
  const planned = { count: 0, distanceMeters: missing, durationSeconds: missing };
  return {
    definitionVersion: 'dashboard-v1',
    observedAt: '2026-09-16T00:00:00.000Z',
    period: {
      anchor: '2026-09-16',
      days,
      timezone: 'Asia/Seoul',
      timezoneSource: 'query',
      from,
      toExclusive: '2026-09-17',
      previousFrom: shiftDashboardDate(from, -days),
      upcomingToExclusive: '2026-09-24',
    },
    planVersion: null,
    dataRevision: { activities: { count: 1, revisionSum: '2' }, checkIns: 0 },
    currentBlock: null,
    todaySessions: [],
    upcomingSessions: [],
    current: { actual, planned, checkInCount: 0, checkInDays: 0 },
    previous: { actual: emptyActual, planned, checkInCount: 0, checkInDays: 0 },
    days: Array.from({ length: days }, (_, index) => ({
      date: shiftDashboardDate(from, index),
      actual: index === days - 1 ? actual : emptyActual,
      planned,
      checkInCount: 0,
    })),
    unplacedActivityCount: 0,
    latestCheckIn: null,
    availability: {
      coverage: 'unknown',
      comparison: 'unavailable',
      actualLoad: 'unavailable',
      providerMetrics: 'unavailable',
    },
    proposalSummary: { status: 'unavailable', reason: 'not_implemented' },
    connectionFreshness: {
      status: 'unavailable',
      reason: 'activity_sync_not_implemented',
      lastSuccessfulSyncAt: null,
    },
  };
}
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const dashboard = { read: vi.fn<DashboardRepository['read']>().mockResolvedValue(fixture()) };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? { athleteId, sessionId: 'session-current', csrfToken: 'c'.repeat(43), method: 'cookie' }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    dashboard,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, dashboard };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('dashboard API read boundary', () => {
  it('rejects unauthenticated reads before accessing personal data', async () => {
    const { app, dashboard } = setup(false);
    expect((await app.inject({ url, headers })).statusCode).toBe(401);
    expect(dashboard.read).not.toHaveBeenCalled();
  });
  it.each([undefined, 'previous-session'])(
    'rejects a missing or changed expected session: %s',
    async (sessionId) => {
      const { app, dashboard } = setup();
      const response = await app.inject({
        url,
        headers: {
          cookie: headers.cookie,
          ...(sessionId ? { 'x-workout-session-id': sessionId } : {}),
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('SESSION_CHANGED');
      expect(dashboard.read).not.toHaveBeenCalled();
    },
  );
  it('delegates only authenticated ownership and validated default query, preserving unavailable and provenance facts', async () => {
    const { app, dashboard } = setup();
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(dashboard.read).toHaveBeenCalledWith(athleteId, {
      anchor: '2026-09-16',
      timezone: 'Asia/Seoul',
      window: 10,
    });
    expect(response.json()).toEqual(fixture());
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each([3, 90])('accepts bounded window %s', async (window) => {
    const { app, dashboard } = setup();
    dashboard.read.mockResolvedValueOnce(fixture(window));
    const response = await app.inject({ url: `${url}&window=${window}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().days).toHaveLength(window);
    expect(dashboard.read).toHaveBeenCalledWith(athleteId, {
      anchor: '2026-09-16',
      timezone: 'Asia/Seoul',
      window,
    });
  });
  it.each([
    `${query}&window=2`,
    `${query}&window=91`,
    `${query}&window=3.5`,
    `${query}&window=invalid`,
    `${query}&athleteId=other`,
    `${query}&source=provider`,
    'anchor=2026-02-30&timezone=Asia%2FSeoul',
    'anchor=2026-09-16&timezone=Invalid',
    'anchor=2026-09-16',
    'timezone=UTC',
    'anchor=0001-01-01&timezone=UTC',
    'anchor=9999-12-31&timezone=UTC',
  ])('rejects malformed, unbounded, or spoofed query: %s', async (invalidQuery) => {
    const { app, dashboard } = setup();
    expect(
      (await app.inject({ url: `/bff/v1/dashboard?${invalidQuery}`, headers })).statusCode,
    ).toBe(400);
    expect(dashboard.read).not.toHaveBeenCalled();
  });
  it('does not publish inconsistent repository output or internal health errors', async () => {
    const { app, dashboard } = setup();
    const invalid = fixture();
    invalid.current.actual.distanceMeters = { value: 0, knownCount: 0, missingCount: 1 };
    dashboard.read.mockResolvedValueOnce(invalid);
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('distanceMeters');
    dashboard.read.mockRejectedValueOnce(new Error('private health payload'));
    const failed = await app.inject({ url, headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('private health');
  });
});
