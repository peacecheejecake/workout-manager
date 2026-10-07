import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RaceRepository } from '@workout/server-persistence/races';
import type { RaceResultV2Repository } from '@workout/server-persistence/race-result-v2';
import { createApi } from '../src/app.js';

const unexpected = vi.fn(async () => {
  throw Error('REPOSITORY_MUST_NOT_BE_CALLED');
});
const legacy: RaceRepository = {
  listRaceEvents: unexpected,
  listRaceResults: unexpected,
  listTrainingBests: unexpected,
  createRaceEvent: unexpected,
  updateRaceEvent: unexpected,
  deleteRaceEvent: unexpected,
  getRaceEvent: unexpected,
  createRaceResult: unexpected,
  updateRaceResult: unexpected,
  deleteRaceResult: unexpected,
  getRaceResult: unexpected,
  createTrainingBest: unexpected,
  updateTrainingBest: unexpected,
  deleteTrainingBest: unexpected,
  getTrainingBest: unexpected,
};
const proof: RaceResultV2Repository = {
  create: unexpected,
  update: unexpected,
  read: unexpected,
  list: unexpected,
};
const apps: ReturnType<typeof createApi>[] = [];
const headers = { cookie: 'session=synthetic', 'x-workout-session-id': 'current' };
function setup(legacyResults: boolean, proofResultsV2: boolean, authenticated = true) {
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              sessionId: 'current',
              csrfToken: 'c'.repeat(43),
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: unexpected, setConsent: unexpected },
    ...(legacyResults ? { races: legacy } : {}),
    ...(proofResultsV2 ? { raceResultsV2: proof } : {}),
  });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  expect(unexpected).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
describe('authenticated injected race result support', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'independently exposes legacy %s and V2 %s without invoking repositories',
    async (legacyResults, proofResultsV2) => {
      const result = await setup(legacyResults, proofResultsV2).inject({
        method: 'GET',
        url: '/bff/v1/race-results/capabilities',
        headers,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ schemaVersion: 1, legacyResults, proofResultsV2 });
      expect(result.headers['cache-control']).toBe('no-store');
    },
  );
  it('does not fall through the installed legacy /:id route', async () => {
    const result = await setup(true, false).inject({
      method: 'GET',
      url: '/bff/v1/race-results/capabilities',
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ schemaVersion: 1, legacyResults: true, proofResultsV2: false });
  });
  it('rejects unauthenticated callers even with no repository', async () => {
    const result = await setup(false, false, false).inject({
      method: 'GET',
      url: '/bff/v1/race-results/capabilities',
    });
    expect(result.statusCode).toBe(401);
    expect(result.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
  it('keeps cookie session freshness checks', async () => {
    const result = await setup(true, true).inject({
      method: 'GET',
      url: '/bff/v1/race-results/capabilities',
      headers: { ...headers, 'x-workout-session-id': 'old' },
    });
    expect(result.statusCode).toBe(409);
  });
  it.each(['?ready=true', '?schemaVersion=1', '?legacyResults=true'])(
    'rejects query %s',
    async (query) => {
      const result = await setup(true, true).inject({
        method: 'GET',
        url: `/bff/v1/race-results/capabilities${query}`,
        headers,
      });
      expect(result.statusCode).toBe(400);
    },
  );
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const)(
    'does not register capability %s',
    async (method) => {
      const result = await setup(false, false).inject({
        method,
        url: '/bff/v1/race-results/capabilities',
        headers,
      });
      expect(result.statusCode).toBe(404);
    },
  );
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const)(
    'legacy dynamic routes cannot execute capability %s',
    async (method) => {
      const result = await setup(true, true).inject({
        method,
        url: '/bff/v1/race-results/capabilities',
        headers,
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
    },
  );
});
