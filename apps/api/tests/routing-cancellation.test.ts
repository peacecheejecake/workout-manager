import { connect } from 'node:net';

import type { WalkingRouteResult } from '@workout/contracts/routing';
import { afterEach, expect, it, vi } from 'vitest';

import { coordinateProbes, valueProbes } from '@workout/server-courses/log-audit';
import { createApi } from '../src/app.js';
import { auditRouteLogs } from './log-audit-support.js';
import type { WalkingRoutePort } from '../src/routing-routes.js';

/**
 * These tests speak real HTTP over a loopback socket on purpose. `app.inject` does not
 * have a connection to drop, so it cannot tell a normal request from a disconnected one —
 * which is exactly the distinction that was broken.
 */
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
    graphContentSha256: 'a'.repeat(64),
    graphBuildId: '0123456789abcdef',
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

const body = JSON.stringify({
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 4,
  profileId: 'foot-v1',
  waypoints: [
    [126.9769, 37.5759],
    [126.9779, 37.5663],
  ],
});

const apps: ReturnType<typeof createApi>[] = [];

// Every app's log stream is kept and audited after each test (M2-01k-c2).
const logs = auditRouteLogs(
  [
    ...coordinateProbes(
      [
        [126.9769, 37.5759],
        [126.9779, 37.5663],
      ],
      'waypoint',
    ),
    ...valueProbes('token', ['c'.repeat(43)]),
  ],
  2,
);

interface Observation {
  aborted: boolean;
  abortedAt: 'never' | 'during' | 'after';
}

/** Starts a real listener and records whether the service's signal ever aborted. */
async function listening(computeDelayMilliseconds: number) {
  const observation: Observation = { aborted: false, abortedAt: 'never' };
  let settled = false;
  const compute: WalkingRoutePort['compute'] = async (_athleteId, _request, context) => {
    context.signal?.addEventListener('abort', () => {
      observation.aborted = true;
      observation.abortedAt = settled ? 'after' : 'during';
    });
    await new Promise((resolve) => setTimeout(resolve, computeDelayMilliseconds));
    settled = true;
    return {
      result: { outcome: 'no_route', computation } satisfies WalkingRouteResult,
      retryAfterSeconds: null,
    };
  };
  const app = createApi({
    auth: {
      authenticate: async () => ({
        athleteId: 'auth-athlete',
        sessionId: 'current',
        csrfToken: 'c'.repeat(43),
        method: 'cookie',
      }),
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    walkingRoutes: { compute },
    allowedOrigins: ['https://workout.example'],
    ...logs.options(),
  });
  apps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, observation };
}

const requestBytes = [
  'POST /bff/v1/routing/walking-routes HTTP/1.1',
  'host: 127.0.0.1',
  'content-type: application/json',
  `content-length: ${Buffer.byteLength(body)}`,
  'cookie: verified',
  'x-workout-session-id: current',
  'origin: https://workout.example',
  `x-csrf-token: ${'c'.repeat(43)}`,
  '',
  body,
].join('\r\n');

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('does not treat a completed request body as a cancellation', async () => {
  const { address, observation } = await listening(50);
  const response = await fetch(`${address}/bff/v1/routing/walking-routes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'verified',
      'x-workout-session-id': 'current',
      origin: 'https://workout.example',
      'x-csrf-token': 'c'.repeat(43),
    },
    body,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: 'no_route' });
  expect(observation.aborted).toBe(false);
});

it('cancels when the connection really drops before the response is written', async () => {
  const { address, observation } = await listening(400);
  const url = new URL(address);
  const socket = connect({ host: '127.0.0.1', port: Number(url.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(requestBytes);
  // Let the server read the body and enter the computation, then pull the plug.
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(observation.aborted).toBe(false);
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(observation.aborted).toBe(true);
  expect(observation.abortedAt).toBe('during');
});
