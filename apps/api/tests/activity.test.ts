import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@workout/contracts/activity';
import {
  ActivityValidationError,
  type ActivityRepository,
} from '@workout/server-persistence/activities';
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
const manualResult = { activityId: manualId, revision: 1 };
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
const manualMutations = [
  { method: 'POST', url: '/bff/v1/activities', payload: manualBody },
  { method: 'PATCH', url: `/bff/v1/activities/${manualId}`, payload: correctionBody },
] as const;

describe('manual activity command and self-report boundary', () => {
  it.each(manualMutations)(
    'rejects unauthenticated $method before storing actuals',
    async (request) => {
      const { app, activities } = setup(false);
      expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
      expect(activities.createManualActivity).not.toHaveBeenCalled();
      expect(activities.updateOverlay).not.toHaveBeenCalled();
    },
  );
  it.each(manualMutations)(
    'enforces current session, origin and CSRF on $method',
    async (request) => {
      const { app, activities } = setup();
      for (const sessionId of ['', 'previous-session']) {
        const response = await app.inject({
          ...request,
          headers: { ...headers, 'x-workout-session-id': sessionId },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('SESSION_CHANGED');
      }
      for (const override of [{ origin: 'https://foreign.example' }, { 'x-csrf-token': '' }]) {
        expect(
          (await app.inject({ ...request, headers: { ...headers, ...override } })).statusCode,
        ).toBe(403);
      }
      expect(activities.createManualActivity).not.toHaveBeenCalled();
      expect(activities.updateOverlay).not.toHaveBeenCalled();
    },
  );
  it('forwards explicit confirmation and RPE zero without accepting client provenance', async () => {
    const { app, activities } = setup();
    activities.createManualActivity.mockResolvedValue(manualResult);
    const response = await app.inject({ ...manualMutations[0], headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(manualResult);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(activities.createManualActivity).toHaveBeenCalledWith(athleteId, {
      ...manualBody,
      idempotencyKey: headers['idempotency-key'],
    });
  });
  it.each([
    { ...manualBody, confirmed: false },
    { activity: manualBody.activity, report: manualBody.report },
    { ...manualBody, athleteId: 'foreign' },
    { ...manualBody, source: correctedActivity.source },
    { ...manualBody, idempotencyKey: 'body-supplied-key' },
    { ...manualBody, activity: { ...manualBody.activity, title: null } },
    { ...manualBody, activity: { ...manualBody.activity, startedAt: null } },
    { ...manualBody, activity: { ...manualBody.activity, timezone: null } },
    { ...manualBody, report: { ...manualBody.report, sessionRpe: 11 } },
    { ...manualBody, report: { ...manualBody.report, source: 'device' } },
    { ...manualBody, report: { ...manualBody.report, rpeReportedAt: '2022-08-03T12:00:00Z' } },
    { ...manualBody, report: { ...manualBody.report, planLink: { planVersionId: 'version' } } },
    {
      ...manualBody,
      report: {
        ...manualBody.report,
        planLink: { planVersionId: 'not-a-uuid', sessionId: 'session' },
      },
    },
  ])('rejects malformed or forged manual body %#', async (payload) => {
    const { app, activities } = setup();
    expect(
      (await app.inject({ method: 'POST', url: '/bff/v1/activities', headers, payload }))
        .statusCode,
    ).toBe(400);
    expect(activities.createManualActivity).not.toHaveBeenCalled();
  });
  it.each(manualMutations)(
    'rejects query and missing idempotency boundaries for $method',
    async (request) => {
      const { app, activities } = setup();
      expect(
        (await app.inject({ ...request, url: `${request.url}?athleteId=foreign`, headers }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ ...request, headers: { ...headers, 'idempotency-key': '' } }))
          .statusCode,
      ).toBe(400);
      expect(activities.createManualActivity).not.toHaveBeenCalled();
      expect(activities.updateOverlay).not.toHaveBeenCalled();
    },
  );
  it('forwards full report replacement and paired time corrections', async () => {
    const { app, activities } = setup();
    activities.updateOverlay.mockResolvedValue(correctedActivity);
    const response = await app.inject({ ...manualMutations[1], headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(correctedActivity);
    expect(activities.updateOverlay).toHaveBeenCalledWith(athleteId, manualId, {
      ...correctionBody,
      idempotencyKey: headers['idempotency-key'],
    });
  });
  it('preserves the prior title and metric correction payload', async () => {
    const { app, activities } = setup();
    activities.updateOverlay.mockResolvedValue(correctedActivity);
    const payload = {
      expectedRevision: 1,
      reason: 'Existing correction',
      title: 'Corrected title',
      distanceMeters: 0,
    };
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/activities/${manualId}`,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(activities.updateOverlay).toHaveBeenCalledWith(athleteId, manualId, {
      ...payload,
      idempotencyKey: headers['idempotency-key'],
    });
  });
  it.each([
    { expectedRevision: 1, reason: 'Missing timezone', startedAt: '2022-08-03T12:00:00Z' },
    { expectedRevision: 1, reason: 'Missing instant', timezone: 'UTC' },
    { expectedRevision: 1, reason: 'Incomplete report', report: { sessionRpe: 0 } },
    { ...correctionBody, userReport: correctedActivity.userReport },
    { ...correctionBody, source: correctedActivity.source },
    { ...correctionBody, report: { ...correctionBody.report, method: 'self_report' } },
    {
      ...correctionBody,
      report: {
        ...correctionBody.report,
        planLink: { planVersionId: 'not-a-uuid', sessionId: 'session' },
      },
    },
    { ...correctionBody, startedAt: '0000-01-01T00:00:00Z' },
  ])('rejects incomplete correction or read-only report fields %#', async (payload) => {
    const { app, activities } = setup();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/bff/v1/activities/${manualId}`,
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(activities.updateOverlay).not.toHaveBeenCalled();
  });
  it.each(['STARTED_AT_IN_FUTURE', 'PLAN_LINK_INVALID'] as const)(
    'sanitizes domain validation %s for create and correction',
    async (code) => {
      const { app, activities } = setup();
      activities.createManualActivity.mockRejectedValue(new ActivityValidationError(code));
      activities.updateOverlay.mockRejectedValue(new ActivityValidationError(code));
      for (const request of manualMutations) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe(code);
        expect(response.body).not.toContain('Synthetic self report');
      }
    },
  );
  it('cannot forge a manual source through the provider import endpoint', async () => {
    const { app, activities } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/activity-imports',
      headers,
      payload: { activity: manualBody.activity, source: correctedActivity.source },
    });
    expect(response.statusCode).toBe(400);
    expect(activities.importActivity).not.toHaveBeenCalled();
    expect(activities.createManualActivity).not.toHaveBeenCalled();
  });
});

describe('explicit immutable linked Block query boundary', () => {
  const version = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  it('delegates the validated link pair with authenticated ownership', async () => {
    const { app, activities } = setup();
    const query = new URLSearchParams({ linkedPlanVersionId: version, linkedBlockId: 'block-old' });
    expect((await app.inject({ url: `/bff/v1/activities?${query}`, headers })).statusCode).toBe(
      200,
    );
    expect(activities.listActivities).toHaveBeenCalledWith(athleteId, {
      limit: 50,
      offset: 0,
      linkedPlanVersionId: version,
      linkedBlockId: 'block-old',
    });
  });
  it.each([
    `linkedPlanVersionId=${version}`,
    'linkedBlockId=block',
    'linkedPlanVersionId=bad&linkedBlockId=block',
    `linkedPlanVersionId=${version}&linkedBlockId=`,
    `linkedPlanVersionId=${version}&linkedBlockId=block&athleteId=foreign`,
  ])('rejects malformed or spoofed explicit link query %s', async (query) => {
    const { app, activities } = setup();
    expect((await app.inject({ url: `/bff/v1/activities?${query}`, headers })).statusCode).toBe(
      400,
    );
    expect(activities.listActivities).not.toHaveBeenCalled();
  });
});
