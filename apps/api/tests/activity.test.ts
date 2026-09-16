import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    listActivities: vi.fn(async () => ({ items: [], total: 0 })),
    getActivity: vi.fn(async () => null),
    importActivity: vi.fn(),
    updateOverlay: vi.fn(),
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
describe('activity route authorization and wire boundaries', () => {
  it.each(['/bff/v1/activities', '/bff/v1/activities/summary'])(
    'does not read activities without authentication: %s',
    async (url) => {
      const { app, activities } = setup(false);
      expect((await app.inject({ url, headers })).statusCode).toBe(401);
      expect(activities.listActivities).not.toHaveBeenCalled();
      expect(activities.summary).not.toHaveBeenCalled();
    },
  );
  it('validates activity paging and IDs without rejecting supported query parameters', async () => {
    const { app, activities } = setup();
    expect(
      (await app.inject({ url: '/bff/v1/activities?limit=2&offset=1', headers })).statusCode,
    ).toBe(200);
    expect(activities.listActivities).toHaveBeenCalledWith(athleteId, { limit: 2, offset: 1 });
    expect(
      (await app.inject({ url: '/bff/v1/activities?athleteId=foreign', headers })).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/bff/v1/activities?limit=101', headers })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ url: '/bff/v1/activities/not-a-uuid', headers })).statusCode).toBe(
      400,
    );
    expect(activities.getActivity).not.toHaveBeenCalled();
  });
  it('returns sanitized absence for foreign or deleted activity IDs', async () => {
    const { app, activities } = setup();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = await app.inject({ url: `/bff/v1/activities/${id}`, headers });
    expect(response.statusCode).toBe(404);
    expect(activities.getActivity).toHaveBeenCalledWith(athleteId, id);
  });
  it('forwards only normalized filters, paging and authenticated ownership', async () => {
    const { app, activities } = setup();
    const defaults = await app.inject({ url: '/bff/v1/activities', headers });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.headers['cache-control']).toBe('no-store');
    expect(activities.listActivities).toHaveBeenLastCalledWith(athleteId, { limit: 50, offset: 0 });
    const query = new URLSearchParams({
      from: '2024-03-10',
      toExclusive: '2024-03-11',
      timezone: 'America/New_York',
      kind: 'running',
      source: 'fixture',
      search: '  literal %_\\ report  ',
      sort: 'distance_desc',
      limit: '2',
      offset: '1',
    });
    const response = await app.inject({ url: `/bff/v1/activities?${query}`, headers });
    expect(response.statusCode).toBe(200);
    expect(activities.listActivities).toHaveBeenLastCalledWith(athleteId, {
      from: '2024-03-10',
      toExclusive: '2024-03-11',
      timezone: 'America/New_York',
      kind: 'running',
      source: 'fixture',
      search: 'literal %_\\ report',
      sort: 'distance_desc',
      limit: 2,
      offset: 1,
    });
  });
  it.each([
    'from=2024-03-10',
    'toExclusive=2024-03-11',
    'timezone=UTC',
    'from=2024-03-10&toExclusive=2024-03-11',
    'from=2024-03-10&toExclusive=2024-03-10&timezone=UTC',
    'from=2024-03-11&toExclusive=2024-03-10&timezone=UTC',
    'from=2024-03-10&toExclusive=2024-03-11&timezone=Not_A_Timezone',
    'from=2024-02-30&toExclusive=2024-03-11&timezone=UTC',
    'from=2000-01-01&toExclusive=2024-03-11&timezone=UTC',
    'sort=provider_expression',
    'source=garmin',
    'kind=unrecognized',
    'search=%20%20',
    'sort=started_asc&sort=distance_desc',
    'owner=foreign',
    'athleteId=foreign',
    'limit=101',
    'offset=10001',
  ])('rejects an invalid activity query before repository access: %s', async (query) => {
    const { app, activities } = setup();
    const response = await app.inject({ url: `/bff/v1/activities?${query}`, headers });
    expect(response.statusCode).toBe(400);
    expect(activities.listActivities).not.toHaveBeenCalled();
  });
  it.each(['id_asc', 'started_desc', 'started_asc', 'distance_desc', 'distance_asc', 'title_asc'])(
    'accepts and forwards the finite sort option %s',
    async (sort) => {
      const { app, activities } = setup();
      expect(
        (await app.inject({ url: `/bff/v1/activities?sort=${sort}`, headers })).statusCode,
      ).toBe(200);
      expect(activities.listActivities).toHaveBeenCalledWith(athleteId, {
        limit: 50,
        offset: 0,
        sort,
      });
    },
  );
  it('keeps session binding ahead of filter access', async () => {
    const { app, activities } = setup();
    for (const sessionId of ['', 'old-session']) {
      const response = await app.inject({
        url: '/bff/v1/activities?search=synthetic&sort=started_desc',
        headers: { ...headers, 'x-workout-session-id': sessionId },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('SESSION_CHANGED');
    }
    expect(activities.listActivities).not.toHaveBeenCalled();
  });
});
