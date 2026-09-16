import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActivityContext } from '@workout/contracts/activity-context';
import type { ActivityContextRepository } from '@workout/server-persistence/activity-context';
import { createApi } from '../src/app.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const url = `/bff/v1/activities/${id}/context`;
const headers = { cookie: 'verified', 'x-workout-session-id': 'current' };
const values = {
  title: null,
  kind: 'running' as const,
  startedAt: null,
  timezone: null,
  distanceMeters: 0,
  durationSeconds: null,
  durationKind: 'unknown' as const,
};
const context: ActivityContext = {
  definitionVersion: 'activity-context-v1',
  observedAt: '2026-09-16T00:00:00Z',
  activity: {
    id,
    revision: 1,
    source: { kind: 'fixture', sourceId: 'synthetic', revision: 1, contentHash: 'a'.repeat(64) },
    original: values,
    overlay: {},
    effective: values,
  },
  activityDataRevision: { count: 1, revisionSum: '1' },
  planContext: { status: 'unlinked' },
};
const apps: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const activityContext = {
    read: vi.fn<ActivityContextRepository['read']>().mockResolvedValue(context),
  };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'auth-athlete',
              sessionId: 'current',
              csrfToken: 'c'.repeat(43),
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    activityContext,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, activityContext };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('authenticates context reads before repository access', async () => {
  const { app, activityContext } = setup(false);
  expect((await app.inject({ url, headers })).statusCode).toBe(401);
  expect(activityContext.read).not.toHaveBeenCalled();
});
it('rejects stale expected session before repository access', async () => {
  const { app, activityContext } = setup();
  expect(
    (await app.inject({ url, headers: { ...headers, 'x-workout-session-id': 'old' } })).statusCode,
  ).toBe(409);
  expect(activityContext.read).not.toHaveBeenCalled();
});
it.each(['/bff/v1/activities/bad/context', `${url}?athleteId=other`, `${url}?planVersionId=other`])(
  'rejects invalid path or query %s',
  async (invalid) => {
    const { app, activityContext } = setup();
    expect((await app.inject({ url: invalid, headers })).statusCode).toBe(400);
    expect(activityContext.read).not.toHaveBeenCalled();
  },
);
it('delegates authenticated tenant and preserves zero, null and unlinked state', async () => {
  const { app, activityContext } = setup();
  const response = await app.inject({ url, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(context);
  expect(activityContext.read).toHaveBeenCalledWith('auth-athlete', id);
  expect(response.headers['cache-control']).toBe('no-store');
});
it('hides foreign and deleted contexts as not found', async () => {
  const { app, activityContext } = setup();
  activityContext.read.mockResolvedValue(null);
  const response = await app.inject({ url, headers });
  expect(response.statusCode).toBe(404);
  expect(response.json().error.code).toBe('NOT_FOUND');
});
it('does not publish invalid repository output', async () => {
  const { app, activityContext } = setup();
  activityContext.read.mockResolvedValue({
    ...context,
    activityDataRevision: { count: -1, revisionSum: '1' },
  });
  const response = await app.inject({ url, headers });
  expect(response.statusCode).toBe(500);
  expect(response.json().error.code).toBe('INTERNAL_ERROR');
  expect(response.body).not.toContain('activityDataRevision');
});
