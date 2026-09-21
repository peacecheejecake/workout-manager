import { Writable } from 'node:stream';

import type { WalkingRouteResult } from '@workout/contracts/routing';
import { RoutingRequestError } from '@workout/server-integrations/routing';
import { afterEach, expect, it, vi } from 'vitest';

import { createApi } from '../src/app.js';
import type { WalkingRoutePort } from '../src/routing-routes.js';

const url = '/bff/v1/routing/walking-routes';
const headers = {
  cookie: 'verified',
  'x-workout-session-id': 'current',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
};
const body = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 4,
  profileId: 'foot-v1',
  waypoints: [
    [126.9769, 37.5759],
    [126.9779, 37.5663],
  ],
};

const computation: WalkingRouteResult['computation'] = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 4,
  graph: {
    engine: 'graphhopper',
    identitySource: 'engine',
    engineVersion: '10.0',
    engineArtifactSha256: 'e5a1268f2cd6b1e4ef849b9237e98b651bf3c31adf4a3766c6d9f5feb241bb41',
    profileId: 'foot-v1',
    profileConfigSha256: 'e72537c13ecc3fd70dc2197822ff1c247fa5fd8ab37763683419174b2730e37d',
    extractSha256: '7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea',
    extractRegion: 'Seoul (BBBike city extract)',
    graphContentSha256: 'c5fbcdecf780a5052c97e6e063ab88294523b38f691b2cf3b6a8629578a12499',
    graphBuildId: 'c57f12f5975347e8',
    graphImportedAt: '2026-09-21T11:34:55.000Z',
    roadDataAt: '2026-09-18T23:00:00Z',
  },
  conditions: {
    profileId: 'foot-v1',
    algorithm: 'flexible',
    contractionHierarchies: false,
    maxVisitedNodes: 1_000_000,
    deadlineMilliseconds: 8_000,
    snapLimitMeters: 120,
    waypointCount: 2,
  },
  computedAt: '2026-09-21T12:00:00.000Z',
  computationMilliseconds: 42,
  warnings: [],
};

const apps: ReturnType<typeof createApi>[] = [];

function setup(
  compute: WalkingRoutePort['compute'] = vi.fn(async () => ({
    result: { outcome: 'no_route', computation } satisfies WalkingRouteResult,
    retryAfterSeconds: null,
  })),
  authenticated = true,
) {
  const walkingRoutes: WalkingRoutePort = { compute };
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
    walkingRoutes,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, compute };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('authenticates before the routing service is reached', async () => {
  const compute = vi.fn();
  const { app } = setup(compute, false);
  expect((await app.inject({ method: 'POST', url, headers, payload: body })).statusCode).toBe(401);
  expect(compute).not.toHaveBeenCalled();
});

it('requires CSRF for a cookie session', async () => {
  const compute = vi.fn();
  const { app } = setup(compute);
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: 'verified', 'x-workout-session-id': 'current' },
    payload: body,
  });
  expect(response.statusCode).toBe(403);
  expect(compute).not.toHaveBeenCalled();
});

it('derives the tenant from the session, never from the body', async () => {
  const compute = vi.fn(async () => ({
    result: { outcome: 'no_route', computation } satisfies WalkingRouteResult,
    retryAfterSeconds: null,
  }));
  const { app } = setup(compute);
  await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { ...body, athleteId: 'someone-else' },
  });
  expect(compute).toHaveBeenCalledWith('auth-athlete', expect.anything(), expect.anything());
});

it('rejects a request the service refuses to bound with 422', async () => {
  const compute = vi.fn(async () => {
    throw new RoutingRequestError('ROUTING_LEG_TOO_LONG');
  });
  const { app } = setup(compute);
  const response = await app.inject({ method: 'POST', url, headers, payload: body });
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ error: { code: 'ROUTING_LEG_TOO_LONG' } });
});

it.each([
  ['route_computed', 200],
  ['no_route', 200],
  ['outside_coverage', 200],
  ['snap_too_far', 200],
  ['timeout', 504],
  ['compute_budget_exceeded', 504],
  ['engine_unavailable', 502],
  ['engine_contract_violation', 502],
  ['graph_mismatch', 502],
  ['cancelled', 499],
])('answers %s with status %s and keeps the outcome in the body', async (outcome, status) => {
  const result =
    outcome === 'route_computed'
      ? ({
          outcome: 'route_computed',
          computation,
          geometry: {
            type: 'LineString',
            coordinates: [
              [126.9769, 37.5759],
              [126.977, 37.576],
            ],
          },
          distanceMeters: 12.5,
          durationSeconds: 9,
          snappedWaypoints: [
            { requested: [126.9769, 37.5759], snapped: [126.9769, 37.5759], snapDistanceMeters: 0 },
            { requested: [126.9779, 37.5663], snapped: [126.9779, 37.5663], snapDistanceMeters: 0 },
          ],
        } as WalkingRouteResult)
      : ({ outcome, computation } as WalkingRouteResult);
  const { app } = setup(async () => ({ result, retryAfterSeconds: null }));
  const response = await app.inject({ method: 'POST', url, headers, payload: body });
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ outcome });
});

it('answers an overloaded tenant with 429 and a retry-after header', async () => {
  const { app } = setup(async () => ({
    result: { outcome: 'overloaded', computation } satisfies WalkingRouteResult,
    retryAfterSeconds: 37,
  }));
  const response = await app.inject({ method: 'POST', url, headers, payload: body });
  expect(response.statusCode).toBe(429);
  expect(response.headers['retry-after']).toBe('37');
  expect(response.json()).toMatchObject({ outcome: 'overloaded' });
});

it('passes a cancellation signal the service can observe', async () => {
  let observed: AbortSignal | undefined;
  const { app } = setup(async (_athleteId, _request, context) => {
    observed = context.signal;
    return {
      result: { outcome: 'no_route', computation } satisfies WalkingRouteResult,
      retryAfterSeconds: null,
    };
  });
  await app.inject({ method: 'POST', url, headers, payload: body });
  expect(observed).toBeInstanceOf(AbortSignal);
});

it('rejects a query string on the routing endpoint', async () => {
  const compute = vi.fn();
  const { app } = setup(compute);
  const response = await app.inject({
    method: 'POST',
    url: `${url}?profile=car`,
    headers,
    payload: body,
  });
  expect(response.statusCode).toBe(400);
  expect(compute).not.toHaveBeenCalled();
});

it('refuses a body larger than the routing bound', async () => {
  const compute = vi.fn();
  const { app } = setup(compute);
  const response = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { ...body, padding: 'x'.repeat(16 * 1024) },
  });
  expect(response.statusCode).toBe(413);
  expect(compute).not.toHaveBeenCalled();
});
