import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionActuals, SessionActualsQuery } from '@workout/contracts/session-actuals';
import { createApi } from '../src/app.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const response: SessionActuals = {
  definitionVersion: 'session-actuals-v1',
  observedAt: '2026-09-16T00:00:00Z',
  planVersion: { id, version: 1, title: 'Synthetic plan' },
  currentPlanVersionId: id,
  sessions: [],
  activityDataRevision: { count: 0, revisionSum: '0' },
  coverage: 'unknown',
};
const headers = { 'x-workout-session-id': 'current', cookie: 'session=fixture' };
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const repository = {
    read: vi
      .fn<(athlete: string, query: SessionActualsQuery) => Promise<SessionActuals | null>>()
      .mockResolvedValue(response),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'owner',
              sessionId: 'current',
              csrfToken: 'c'.repeat(43),
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    sessionActuals: repository,
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, repository };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});
describe('session actuals authenticated read boundary', () => {
  it('normalizes the version and derives owner without mutations', async () => {
    const { app, repository } = setup();
    const read = await app.inject({
      url: `/bff/v1/plans/versions/${id.toUpperCase()}/session-actuals`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(response);
    expect(repository.read).toHaveBeenCalledExactlyOnceWith('owner', { planVersionId: id });
    expect(read.headers['cache-control']).toBe('no-store');
  });
  it.each([
    'bad-id/session-actuals',
    `${id}/session-actuals?athleteId=other`,
    `${id}/session-actuals?offset=1`,
  ])('rejects unsupported input %s', async (suffix) => {
    const { app, repository } = setup();
    expect(
      (await app.inject({ url: `/bff/v1/plans/versions/${suffix}`, headers })).statusCode,
    ).toBe(400);
    expect(repository.read).not.toHaveBeenCalled();
  });
  it('requires authentication and the current browser session', async () => {
    const unauth = setup(false);
    expect(
      (await unauth.app.inject({ url: `/bff/v1/plans/versions/${id}/session-actuals`, headers }))
        .statusCode,
    ).toBe(401);
    expect(unauth.repository.read).not.toHaveBeenCalled();
    const stale = setup();
    expect(
      (
        await stale.app.inject({
          url: `/bff/v1/plans/versions/${id}/session-actuals`,
          headers: { ...headers, 'x-workout-session-id': 'old' },
        })
      ).statusCode,
    ).toBe(409);
    expect(stale.repository.read).not.toHaveBeenCalled();
  });
  it('uses the same missing response for unknown and foreign versions', async () => {
    const { app, repository } = setup();
    repository.read.mockResolvedValue(null);
    const read = await app.inject({ url: `/bff/v1/plans/versions/${id}/session-actuals`, headers });
    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ error: { code: 'PLAN_VERSION_NOT_FOUND' } });
  });
  it('fails closed when repository output violates the public schema', async () => {
    const { app, repository } = setup();
    repository.read.mockResolvedValue({
      ...response,
      coverage: 'guaranteed',
    } as unknown as SessionActuals);
    const read = await app.inject({ url: `/bff/v1/plans/versions/${id}/session-actuals`, headers });
    expect(read.statusCode).toBe(500);
    expect(JSON.stringify(read.json())).not.toContain('guaranteed');
  });
});
