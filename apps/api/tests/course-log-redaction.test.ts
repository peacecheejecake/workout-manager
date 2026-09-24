import type { WalkingRouteResult } from '@workout/contracts/routing';
import {
  auditLogLines,
  coordinateProbes,
  createLogCapture,
  formatLogFindings,
  valueProbes,
} from '@workout/server-courses/log-audit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi, unreleasedVersion } from '../src/app.js';
import type { WalkingRoutePort } from '../src/routing-routes.js';

/**
 * What the course, routing and track routes write to their log (M2-01k-c2).
 *
 * The API is given a kept stream and every adapter behind it is "leaky": each one fails
 * with an error whose message carries the owner's coordinates, a storage object key, a
 * bearer credential and a fragment of the request body — which is what a real adapter's
 * error can carry. Requests carry the same kinds of values in their bodies, headers and
 * URLs. The whole stream is then audited: none of those values, by exact probe or by shape,
 * may appear, and every line must carry a UUID `reqId` and the configured `version`.
 */

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const activityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const courseId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const csrfToken = 'k'.repeat(43);
const bearer = 'Bearer c2-bearer-credential-planted';
const release = 'c2-log-release-7';
const waypoints = [
  [126.97691, 37.57592],
  [126.97793, 37.56631],
] as const;
const ownerPosition = [127.03417, 37.51229] as const;
const objectKey = `private/v1/tenants/${athleteId}/activities/${activityId}/tracks/x/raw`;
const courseName = 'Hidden Garden Loop';
const placeQuery = 'Neighbour Doorstep';
const headers = {
  cookie: 'session=c2-cookie-planted',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};

/** The error a careless adapter throws: every forbidden kind of value in one message. */
function leakyError() {
  return new Error(
    `failed at ${ownerPosition.join(',')} via ${JSON.stringify(waypoints)} ` +
      `object ${objectKey} auth ${bearer} body {"name":"${courseName}"}`,
  );
}

/** Every method of every adapter rejects with {@link leakyError}. */
function leaky<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'then' ? undefined : vi.fn(async () => Promise.reject(leakyError())),
    },
  ) as T;
}

const probes = [
  ...coordinateProbes([ownerPosition]),
  ...coordinateProbes(waypoints, 'waypoint'),
  ...valueProbes('object_key', [objectKey]),
  ...valueProbes('token', [csrfToken, bearer, 'c2-bearer-credential-planted', 'c2-cookie-planted']),
  ...valueProbes('body', [courseName, placeQuery]),
];

const instances: ReturnType<typeof createApi>[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

function setup(options: { version?: string; compute?: WalkingRoutePort['compute'] } = {}) {
  const capture = createLogCapture();
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () => ({
        athleteId,
        sessionId: 'current',
        csrfToken,
        method: 'cookie' as const,
      }),
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    walkingRoutes: {
      compute:
        options.compute ??
        (async () => {
          throw leakyError();
        }),
    },
    courses: { courses: leaky(), tracks: leaky(), storage: leaky() },
    activityTracks: { tracks: leaky(), storage: leaky(), parser: leaky() },
    courseExtras: { courses: leaky(), preferences: leaky(), places: leaky(), elevation: null },
    logStream: capture.stream,
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  instances.push(app);
  return { app, capture };
}

const routingBody = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 1,
  profileId: 'foot-v1',
  waypoints,
};

/** Requests across the three route families, each ending in a different way. */
function requests() {
  return [
    // An adapter failure behind each family: 500, with the leaky message in hand.
    { method: 'POST', url: '/bff/v1/routing/walking-routes', payload: routingBody },
    {
      method: 'POST',
      url: '/bff/v1/courses',
      headers: { 'idempotency-key': 'c2-course-0001' },
      payload: {
        name: courseName,
        from: {
          kind: 'recorded-segment',
          activityId,
          trackRevision: 1,
          startSampleId: '0:0',
          endSampleId: '0:1',
        },
      },
    },
    { method: 'GET', url: `/bff/v1/courses/${courseId}` },
    { method: 'GET', url: `/bff/v1/courses/${courseId}/export.gpx` },
    { method: 'GET', url: `/bff/v1/activities/${activityId}/track` },
    {
      method: 'POST',
      url: '/bff/v1/courses/place-search',
      payload: { query: placeQuery, near: ownerPosition },
    },
    // Refused at the boundary: coordinates in a query string, a body that is not JSON, a
    // body over the limit and a URL no route owns.
    {
      method: 'POST',
      url: `/bff/v1/routing/walking-routes?lat=${ownerPosition[1]}&lon=${ownerPosition[0]}`,
      payload: routingBody,
    },
    {
      method: 'POST',
      url: '/bff/v1/routing/walking-routes',
      headers: { 'content-type': 'application/json' },
      payload: `{"waypoints":[[${waypoints[0].join(',')}]`,
    },
    {
      method: 'POST',
      url: '/bff/v1/routing/walking-routes',
      payload: { ...routingBody, padding: `${courseName} `.repeat(600) },
    },
    { method: 'GET', url: `/bff/v1/courses/${courseId}/${ownerPosition.join(',')}` },
    // A bearer credential alongside the cookie session.
    {
      method: 'GET',
      url: `/bff/v1/courses/${courseId}`,
      headers: { authorization: bearer },
    },
  ] as const;
}

async function drive(app: ReturnType<typeof createApi>) {
  const sent = requests();
  const statuses: number[] = [];
  for (const request of sent) {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: { ...headers, ...('headers' in request ? request.headers : {}) },
      ...('payload' in request ? { payload: request.payload } : {}),
    });
    statuses.push(response.statusCode);
  }
  return { count: sent.length, statuses };
}

function records(lines: readonly string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('course, routing and track route logs', () => {
  it('carry a trace id and the version, and none of what the requests and adapters held', async () => {
    const { app, capture } = setup({ version: release });
    const { count, statuses } = await drive(app);
    // The adapters really failed and the boundary really refused: nothing here was a
    // silent success that logged less.
    expect(statuses).toEqual([500, 500, 500, 500, 500, 500, 400, 400, 413, 404, 500]);

    const lines = capture.lines();
    const findings = auditLogLines(lines, {
      traceField: 'reqId',
      version: release,
      probes,
      minRecords: count,
    });
    expect(findings, formatLogFindings(findings)).toEqual([]);

    // One completion per request, each with its own trace id, and every failure is
    // correlated to the request it belongs to.
    const logged = records(lines);
    const completed = logged.filter((record) => record['event'] === 'request_completed');
    expect(completed.map((record) => record['statusCode'])).toEqual(statuses);
    const traceIds = new Set(completed.map((record) => record['reqId']));
    expect(traceIds.size).toBe(count);
    const failed = logged.filter((record) => record['event'] === 'request_failed');
    expect(failed).toHaveLength(statuses.filter((status) => status !== 404).length);
    for (const record of failed) expect(traceIds.has(record['reqId'])).toBe(true);
    expect(new Set(logged.map((record) => record['version']))).toEqual(new Set([release]));
  });

  it('logs nothing of a successful route computation either', async () => {
    const computation = {
      schemaVersion: 1,
      requestId: 'req-1',
      requestRevision: 1,
      graph: {
        engine: 'graphhopper',
        identitySource: 'engine',
        engineVersion: '10.0',
        engineArtifactSha256: 'e'.repeat(64),
        profileId: 'foot-v1',
        profileConfigSha256: 'f'.repeat(64),
        extractSha256: 'a'.repeat(64),
        extractRegion: 'Seoul (BBBike city extract)',
        graphContentSha256: 'b'.repeat(64),
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
    } satisfies WalkingRouteResult['computation'];
    const { app, capture } = setup({
      version: release,
      compute: async () => ({
        result: { outcome: 'no_route', computation } satisfies WalkingRouteResult,
        retryAfterSeconds: null,
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/routing/walking-routes',
      headers,
      payload: routingBody,
    });
    expect(response.statusCode).toBe(200);
    const findings = auditLogLines(capture.lines(), {
      traceField: 'reqId',
      version: release,
      probes: [...probes, ...valueProbes('body', ['c57f12f5975347e8'])],
      minRecords: 1,
    });
    expect(findings, formatLogFindings(findings)).toEqual([]);
  });

  it('logs the unreleased version rather than none when no release is configured', async () => {
    const { app, capture } = setup();
    await app.inject({ method: 'GET', url: `/bff/v1/courses/${courseId}`, headers });
    const findings = auditLogLines(capture.lines(), {
      traceField: 'reqId',
      version: unreleasedVersion,
      probes,
    });
    expect(findings, formatLogFindings(findings)).toEqual([]);
  });
});
