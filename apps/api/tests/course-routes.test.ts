import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import type { WalkingRouteResult } from '@workout/contracts/routing';
import type { MapPath } from '@workout/contracts/tracks';
import { courseGeometrySha256 } from '@workout/server-persistence/courses';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import type { ActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import { CourseStateError, type CourseRepository } from '@workout/server-persistence/courses';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const activityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const trackId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const uploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const courseId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const proposalId = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const createdAt = '2026-09-19T01:00:00.000Z';
const csrfToken = 'c'.repeat(43);
const baseHeaders = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};
const commandHeaders = { ...baseHeaders, 'idempotency-key': 'course-command-0001' };

const mapPath: MapPath = {
  schemaVersion: 1,
  role: 'recorded',
  sourceRevision: {
    kind: 'activity-source',
    activityId,
    sourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    sourceRevision: 2,
    trackRevision: 1,
  },
  simplificationVersion: 1,
  toleranceMeters: 2.5,
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [127.02, 37.5],
        [127.0201, 37.5001],
        [127.0202, 37.5002],
      ],
    ],
  },
  vertexSampleIds: [['0:0', '0:1', '0:2']],
  lineSegmentIndices: [0],
  points: [],
  insufficient: [],
  displayedPolylineLengthMeters: 30,
  crossesAntimeridian: false,
  outsideDisplayLatitude: false,
};
const mapPathBytes = Buffer.from(JSON.stringify(mapPath), 'utf8');
const mapPathSha = createHash('sha256').update(mapPathBytes).digest('hex');
const mapPathRef = `private/v1/tenants/${athleteId}/activities/${activityId}/tracks/${trackId}/map_path/uploads/${uploadId}/sha256/${mapPathSha}.json`;

const track = {
  trackId,
  activityId,
  sourceKind: 'fit' as const,
  sourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  sourceRevision: 2,
  trackRevision: 1,
  recordedSourceKind: 'gpx-trk' as const,
  correspondence: {
    algorithm: 'track-correspondence-v1' as const,
    parserId: 'gpx-track-v1' as const,
    parserVersion: 1 as const,
    digest: 'a'.repeat(64),
  },
  file: {
    originalFileName: 'run.gpx',
    format: 'gpx' as const,
    byteSize: 100,
    sha256: 'd'.repeat(64),
  },
  derivatives: [
    { kind: 'normalized' as const, byteSize: 512, sha256: 'b'.repeat(64) },
    { kind: 'map_path' as const, byteSize: mapPathBytes.byteLength, sha256: mapPathSha },
  ],
  sampleCount: 3,
  positionedSampleCount: 3,
  segmentCount: 1,
  segmentPolicy: { version: 1 as const, maxGapSeconds: 60, maxGapMeters: 200 },
  distances: { deviceReportedMeters: null, recomputedFromPositionsMeters: 30 },
  createdAt,
};

const courseHead = {
  status: 'available' as const,
  courseId,
  name: 'Seoul loop',
  visibility: 'private' as const,
  headRevision: 1,
  revisionId: '99999999-9999-4999-8999-999999999999',
  createdAt,
  updatedAt: createdAt,
};
const courseRevision = {
  courseId,
  courseRevision: 1,
  revisionId: courseHead.revisionId,
  name: 'Seoul loop',
  geometry: {
    type: 'LineString' as const,
    coordinates: [[127.02, 37.5] as [number, number], [127.0201, 37.5001] as [number, number]],
  },
  waypoints: [
    {
      role: 'start' as const,
      position: [127.02, 37.5] as [number, number],
      name: null,
      sourceSampleId: '0:0',
      locked: false,
    },
    {
      role: 'finish' as const,
      position: [127.0201, 37.5001] as [number, number],
      name: null,
      sourceSampleId: '0:1',
      locked: false,
    },
  ],
  generation: {
    kind: 'recorded-segment' as const,
    activityId,
    trackId,
    trackRevision: 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: '0:1',
    vertexCount: 2,
    mapPathContentSha256: mapPathSha,
    simplificationVersion: 1 as const,
    toleranceMeters: 2.5,
  },
  edit: { kind: 'created' as const },
  lineage: [{ activityId, trackId, trackRevision: 1 }],
  distanceMeters: 14.2,
  contentDigest: 'e'.repeat(64),
  createdAt,
};

const instances: ReturnType<typeof createApi>[] = [];

function storageFixture(): ObjectStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>([[mapPathRef, mapPathBytes]]);
  return {
    objects,
    async writeTemporary(key) {
      return { key, sizeBytes: 0, modifiedAt: new Date(createdAt) };
    },
    async publishTemporary(_temporaryKey, finalKey, expectation) {
      return { key: finalKey, outcome: 'published', ...expectation };
    },
    async open(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return {
        key,
        sizeBytes: bytes.byteLength,
        modifiedAt: new Date(createdAt),
        body: Readable.from([bytes]),
      };
    },
    async stat(key) {
      const bytes = objects.get(key);
      return bytes === undefined
        ? null
        : { key, sizeBytes: bytes.byteLength, modifiedAt: new Date(createdAt) };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/**
 * A walking-route port under the test's control. It is our own side of M2-01g's boundary:
 * what the tests below check is the bounded endpoint, the proposal store and the save, not
 * the engine, which has its own suite.
 */
function walkingRouteFixture(
  outcome: WalkingRouteResult['outcome'] = 'route_computed',
  retryAfterSeconds: number | null = null,
) {
  const compute = vi.fn(
    async (_athleteId: string, request: unknown, context: { signal?: AbortSignal }) => {
      const parsed = request as {
        requestId: string;
        requestRevision: number;
        waypoints: [number, number][];
      };
      seenSignals.push(context.signal ?? null);
      const computation = {
        schemaVersion: 1 as const,
        requestId: parsed.requestId,
        requestRevision: parsed.requestRevision,
        graph: routeGraph,
        conditions: {
          profileId: 'foot-v1' as const,
          algorithm: 'flexible' as const,
          contractionHierarchies: false as const,
          maxVisitedNodes: 1_000_000,
          deadlineMilliseconds: 8_000,
          snapLimitMeters: 120,
          waypointCount: parsed.waypoints.length,
        },
        computedAt: createdAt,
        computationMilliseconds: 12,
        warnings: [],
      };
      if (outcome !== 'route_computed')
        return { result: { outcome, computation }, retryAfterSeconds };
      return {
        result: {
          outcome: 'route_computed' as const,
          computation,
          geometry: { type: 'LineString' as const, coordinates: routedCoordinates },
          distanceMeters: 210.5,
          durationSeconds: 150,
          snappedWaypoints: parsed.waypoints.map((waypoint) => ({
            requested: waypoint,
            snapped: waypoint,
            snapDistanceMeters: 0,
          })),
        },
        retryAfterSeconds,
      };
    },
  );
  return { compute };
}

const seenSignals: (AbortSignal | null)[] = [];

const routeGraph = {
  engine: 'graphhopper' as const,
  identitySource: 'engine' as const,
  engineVersion: '10.0',
  engineArtifactSha256: 'a'.repeat(64),
  profileId: 'foot-v1' as const,
  profileConfigSha256: 'b'.repeat(64),
  extractSha256: 'c'.repeat(64),
  extractRegion: 'seoul',
  graphContentSha256: 'd'.repeat(64),
  graphBuildId: '0123456789abcdef',
  graphImportedAt: createdAt,
  roadDataAt: createdAt,
};

const routedCoordinates: [number, number][] = [
  [127.02, 37.5],
  [127.02005, 37.50008],
  [127.0201, 37.5001],
];

const draftWaypoints = [
  { role: 'start', position: [127.02, 37.5], name: null, sourceSampleId: null, locked: false },
  { role: 'finish', position: [127.0201, 37.5001], name: null, sourceSampleId: null, locked: true },
];

function storedProposal(draftRevision = 3, graphBuildId = '0123456789abcdef') {
  return {
    proposalId: proposalId,
    courseId,
    requestId: 'req-1',
    draftRevision,
    waypoints: draftWaypoints,
    geometry: { type: 'LineString', coordinates: routedCoordinates },
    engineDistanceMeters: 210.5,
    engineDurationSeconds: 150,
    snappedWaypoints: routedCoordinates.slice(0, 2).map((position) => ({
      requested: position,
      snapped: position,
      snapDistanceMeters: 0,
    })),
    computation: {
      schemaVersion: 1,
      requestId: 'req-1',
      requestRevision: draftRevision,
      graph: { ...routeGraph, graphBuildId },
      conditions: {
        profileId: 'foot-v1',
        algorithm: 'flexible',
        contractionHierarchies: false,
        maxVisitedNodes: 1_000_000,
        deadlineMilliseconds: 8_000,
        snapLimitMeters: 120,
        waypointCount: 2,
      },
      computedAt: createdAt,
      computationMilliseconds: 12,
      warnings: [],
    },
    createdAt,
    expiresAt: '2026-09-19T01:30:00.000Z',
  };
}

function setup(
  options: { authenticated?: boolean; walkingRoutes?: ReturnType<typeof walkingRouteFixture> } = {},
) {
  const storage = storageFixture();
  const courses: CourseRepository = {
    replayCommand: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({
      status: 'available',
      course: courseHead,
      revision: courseRevision,
    }),
    read: vi
      .fn()
      .mockResolvedValue({ status: 'available', course: courseHead, revision: courseRevision }),
    list: vi.fn().mockResolvedValue({ courses: [courseHead], total: 1 }),
    headContent: vi.fn().mockResolvedValue({
      courseId,
      courseRevision: 1,
      name: courseRevision.name,
      coordinates: courseRevision.geometry.coordinates,
      waypoints: courseRevision.waypoints,
      generation: courseRevision.generation,
      lineage: courseRevision.lineage,
    }),
    update: vi.fn().mockResolvedValue({
      status: 'available',
      course: { ...courseHead, headRevision: 2 },
      revision: { ...courseRevision, courseRevision: 2 },
    }),
    remove: vi.fn().mockResolvedValue({ deleted: true }),
    storeRouteProposal: vi.fn().mockRejectedValue(new Error('not used')),
    readRouteProposal: vi.fn().mockResolvedValue(null),
    storeRouteCandidateSet: vi.fn().mockRejectedValue(new Error('not used')),
    readRouteCandidate: vi.fn().mockResolvedValue(null),
    affectedByActivityDeletion: vi.fn().mockResolvedValue({
      activityId,
      digest: 'f'.repeat(64),
      courses: [{ courseId, name: 'Seoul loop', headRevision: 1 }],
      total: 1,
    }),
  };
  const tracks = {
    read: vi.fn().mockResolvedValue({ status: 'available', track }),
    resolveObject: vi.fn().mockResolvedValue({
      storageRef: mapPathRef,
      activityId,
      trackId,
      artifactKind: 'map_path',
      mediaType: 'application/json',
      byteSize: mapPathBytes.byteLength,
      sha256: mapPathSha,
      originalFileName: null,
      trackRevision: 1,
    }),
  } as unknown as ActivityTrackRepository;
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        options.authenticated === false
          ? null
          : { athleteId, sessionId: 'current', csrfToken, method: 'cookie' as const },
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    courses: { courses, tracks, storage },
    ...(options.walkingRoutes ? { walkingRoutes: options.walkingRoutes } : {}),
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, courses, tracks, storage, walkingRoutes: options.walkingRoutes };
}

const createPayload = {
  name: 'Seoul loop',
  from: {
    kind: 'recorded-segment',
    activityId,
    trackRevision: 1,
    startSampleId: '0:0',
    endSampleId: '0:1',
  },
};

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('course API boundaries', () => {
  it('authenticates before any course work happens', async () => {
    const { app, courses } = setup({ authenticated: false });
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses',
      headers: commandHeaders,
      payload: createPayload,
    });
    expect(response.statusCode).toBe(401);
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('requires CSRF for a cookie session on every write', async () => {
    const { app, courses } = setup();
    const headers = { cookie: 'session=fixture', 'x-workout-session-id': 'current' };
    for (const [method, url] of [
      ['POST', '/bff/v1/courses'],
      ['PATCH', `/bff/v1/courses/${courseId}`],
      ['DELETE', `/bff/v1/courses/${courseId}?expectedRevision=1`],
    ] as const) {
      const response = await app.inject({ method, url, headers });
      expect(response.statusCode).toBe(403);
    }
    expect(courses.create).not.toHaveBeenCalled();
    expect(courses.update).not.toHaveBeenCalled();
    expect(courses.remove).not.toHaveBeenCalled();
  });

  it('derives the owner from the session and has no place for an athlete id', async () => {
    const { app, courses } = setup();
    const accepted = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses',
      headers: commandHeaders,
      payload: createPayload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(courses.create).toHaveBeenCalledWith(
      athleteId,
      expect.objectContaining({ name: 'Seoul loop' }),
      'course-command-0001',
      expect.objectContaining({ kind: 'course_create' }),
    );
    const forged = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses',
      headers: commandHeaders,
      payload: { ...createPayload, athleteId: 'someone-else' },
    });
    expect(forged.statusCode).toBe(400);
  });

  it('derives the geometry from the stored recording, never from the request', async () => {
    const { app, courses, tracks } = setup();
    await app.inject({
      method: 'POST',
      url: '/bff/v1/courses',
      headers: commandHeaders,
      payload: createPayload,
    });
    expect(tracks.resolveObject).toHaveBeenCalledWith(athleteId, activityId, 'map_path');
    const [, content] = vi.mocked(courses.create).mock.calls[0] ?? [];
    expect(content?.coordinates).toEqual([
      [127.02, 37.5],
      [127.0201, 37.5001],
    ]);
    expect(content?.lineage).toEqual([{ activityId, trackId, trackRevision: 1 }]);
    expect(content?.generation).toMatchObject({
      kind: 'recorded-segment',
      mapPathContentSha256: mapPathSha,
      startSampleId: '0:0',
      endSampleId: '0:1',
    });
    // A geometry in the request body is refused outright by the strict contract.
    const injected = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses',
      headers: commandHeaders,
      payload: {
        ...createPayload,
        geometry: { type: 'LineString', coordinates: [[0, 0]] },
      },
    });
    expect(injected.statusCode).toBe(400);
  });

  it('refuses a selection made against a different stored revision', async () => {
    const { app, courses } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses',
      headers: commandHeaders,
      payload: { ...createPayload, from: { ...createPayload.from, trackRevision: 2 } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'TRACK_REVISION_CHANGED' } });
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('reports a selection that cannot be cut as an unprocessable request', async () => {
    const { app, courses } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses',
      headers: commandHeaders,
      payload: { ...createPayload, from: { ...createPayload.from, endSampleId: '0:9' } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'SEGMENT_ENDPOINT_NOT_DRAWN' } });
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('carries the expected revision into every write', async () => {
    const { app, courses } = setup();
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: { expectedRevision: 1, change: { kind: 'rename', name: 'Renamed' } },
    });
    expect(renamed.statusCode).toBe(200);
    expect(courses.update).toHaveBeenCalledWith(
      athleteId,
      courseId,
      1,
      expect.objectContaining({ name: 'Renamed', edit: { kind: 'renamed' } }),
      'course-command-0001',
      expect.objectContaining({ kind: 'course_update' }),
    );
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/bff/v1/courses/${courseId}?expectedRevision=4`,
      headers: baseHeaders,
    });
    expect(deleted.statusCode).toBe(200);
    expect(courses.remove).toHaveBeenCalledWith(athleteId, courseId, 4);
    const withoutExpectation = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: { change: { kind: 'rename', name: 'Renamed' } },
    });
    expect(withoutExpectation.statusCode).toBe(400);
    const deleteWithout = await app.inject({
      method: 'DELETE',
      url: `/bff/v1/courses/${courseId}`,
      headers: baseHeaders,
    });
    expect(deleteWithout.statusCode).toBe(400);
  });

  it('refuses a stale edit before it reaches the repository', async () => {
    const { app, courses } = setup();
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: { expectedRevision: 5, change: { kind: 'rename', name: 'Renamed' } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'COURSE_REVISION_CONFLICT' } });
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('re-cuts a course from the recording named in its own conditions', async () => {
    const { app, courses } = setup();
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: {
        expectedRevision: 1,
        change: { kind: 'retrim', startSampleId: '0:1', endSampleId: '0:2' },
      },
    });
    expect(response.statusCode).toBe(200);
    const [, , , content] = vi.mocked(courses.update).mock.calls[0] ?? [];
    expect(content?.coordinates).toEqual([
      [127.0201, 37.5001],
      [127.0202, 37.5002],
    ]);
    expect(content?.edit).toEqual({ kind: 'retrimmed' });
    expect(content?.lineage).toEqual(courseRevision.lineage);
  });

  it('exports a course as a private GPX route, never as a recorded track', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/gpx+xml; charset=utf-8');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toContain('attachment');
    // The round trip through the real GPX reader is covered where the writer lives
    // (`packages/server/courses/tests/gpx.test.ts`); what matters here is that the route
    // hands back a route document and never a recorded track.
    expect(response.body).toContain('<rte>');
    expect(response.body).toContain('<rtept lat="37.5000000" lon="127.0200000" />');
    expect(response.body).not.toContain('<trk>');
    expect(response.body).not.toContain('<trkpt');
    expect(response.body.match(/<wpt /g)).toHaveLength(2);
  });

  it('refuses to export a reclaimed course and says why', async () => {
    const { app, courses } = setup();
    vi.mocked(courses.read).mockResolvedValue({
      status: 'unavailable',
      course: {
        status: 'unavailable',
        courseId,
        name: 'Seoul loop',
        visibility: 'private',
        reason: 'source_activity_deleted',
        reclaimedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'COURSE_UNAVAILABLE' } });
  });

  it('shows the courses an activity deletion would reclaim', async () => {
    const { app, courses } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/activities/${activityId}/deletion-impact`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      activityId,
      digest: 'f'.repeat(64),
      courses: [{ courseId, name: 'Seoul loop', headRevision: 1 }],
      total: 1,
    });
    expect(courses.affectedByActivityDeletion).toHaveBeenCalledWith(athleteId, activityId);
  });

  it('never returns a storage reference', async () => {
    const { app } = setup();
    for (const url of [
      '/bff/v1/courses',
      `/bff/v1/courses/${courseId}`,
      `/bff/v1/activities/${activityId}/deletion-impact`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: baseHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('private/v1/tenants');
      expect(response.body).not.toContain(`uploads/${uploadId}`);
    }
  });

  it('exposes no route that shares a course publicly', async () => {
    const { app } = setup();
    for (const [method, url] of [
      ['POST', `/bff/v1/courses/${courseId}/shares`],
      ['PUT', `/bff/v1/courses/${courseId}/visibility`],
      ['GET', `/bff/v1/public/courses/${courseId}`],
    ] as const) {
      const response = await app.inject({ method, url, headers: commandHeaders, payload: {} });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('course command idempotency at the API boundary', () => {
  /**
   * A repository that really changes state, so a resend meets the advanced head exactly as
   * it would in production. The unit tests above use a fixed head, which cannot show this.
   */
  function statefulSetup() {
    let headRevision = 1;
    const receipts = new Map<string, { courseId: string; courseRevision: number }>();
    const requests = new Map<string, string>();
    const update = vi.fn(
      async (
        _athlete: string,
        id: string,
        expected: number,
        _content: unknown,
        key: string,
        request: unknown,
      ) => {
        const fingerprint = JSON.stringify(request);
        const recorded = requests.get(key);
        if (recorded !== undefined) {
          if (recorded !== fingerprint) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          const previous = receipts.get(key);
          return {
            status: 'available' as const,
            course: { ...courseHead, headRevision: previous?.courseRevision ?? headRevision },
            revision: {
              ...courseRevision,
              courseRevision: previous?.courseRevision ?? headRevision,
            },
          };
        }
        if (expected !== headRevision) throw new CourseStateError('COURSE_REVISION_CONFLICT');
        headRevision += 1;
        requests.set(key, fingerprint);
        receipts.set(key, { courseId: id, courseRevision: headRevision });
        return {
          status: 'available' as const,
          course: { ...courseHead, headRevision },
          revision: { ...courseRevision, courseRevision: headRevision },
        };
      },
    );
    const courses = {
      create: vi.fn(),
      read: vi.fn(async () => ({
        status: 'available' as const,
        course: { ...courseHead, headRevision },
        revision: { ...courseRevision, courseRevision: headRevision },
      })),
      list: vi.fn(),
      headContent: vi.fn(async () => ({
        courseId,
        courseRevision: headRevision,
        name: courseRevision.name,
        coordinates: courseRevision.geometry.coordinates,
        waypoints: courseRevision.waypoints,
        generation: courseRevision.generation,
        lineage: courseRevision.lineage,
      })),
      update,
      remove: vi.fn(),
      affectedByActivityDeletion: vi.fn(),
      replayCommand: vi.fn(async (_athlete: string, key: string, request: unknown) => {
        const recorded = requests.get(key);
        if (recorded === undefined) return null;
        if (recorded !== JSON.stringify(request))
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return receipts.get(key) ?? null;
      }),
    } as unknown as CourseRepository;
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
      courses: { courses, tracks: setup().tracks, storage: setup().storage },
      logStream: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    instances.push(app);
    return { app, courses, update };
  }

  it('replays an identical successful resend instead of answering a conflict', async () => {
    const { app, update } = statefulSetup();
    const payload = { expectedRevision: 1, change: { kind: 'rename', name: 'Renamed' } };
    const first = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().course.headRevision).toBe(2);
    const resend = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload,
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json().course.headRevision).toBe(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('answers a replay with the course as it is now, not with a snapshot of the command', async () => {
    const { app, update } = statefulSetup();
    const first = { expectedRevision: 1, change: { kind: 'rename', name: 'Renamed' } };
    const firstHeaders = { ...commandHeaders, 'idempotency-key': 'course-command-0001' };
    const secondHeaders = { ...commandHeaders, 'idempotency-key': 'course-command-0002' };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/bff/v1/courses/${courseId}`,
          headers: firstHeaders,
          payload: first,
        })
      ).json().course.headRevision,
    ).toBe(2);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/bff/v1/courses/${courseId}`,
          headers: secondHeaders,
          payload: { expectedRevision: 2, change: { kind: 'rename', name: 'Again' } },
        })
      ).json().course.headRevision,
    ).toBe(3);
    const resend = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: firstHeaders,
      payload: first,
    });
    // The command is not applied a second time, and what comes back is the course's
    // current state — revision 3 — not the revision the first attempt produced.
    expect(resend.statusCode).toBe(200);
    expect(resend.json().course.headRevision).toBe(3);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('refuses a different request sent under a used key', async () => {
    const { app } = statefulSetup();
    const first = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: { expectedRevision: 1, change: { kind: 'rename', name: 'Renamed' } },
    });
    expect(first.statusCode).toBe(200);
    const reused = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: { expectedRevision: 1, change: { kind: 'rename', name: 'Different' } },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

/**
 * M2-01h: asking our own engine for a route, keeping the answer as a reviewable proposal,
 * and saving one the owner reviewed. What these check is that a computation cannot become
 * a course on its own, and that a save carries no geometry of its own.
 */
describe('course route proposals', () => {
  const computeBody = {
    requestId: 'req-1',
    draftRevision: 3,
    waypoints: draftWaypoints,
  };

  it('offers no computation route at all when no engine is configured', async () => {
    const { app, courses } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-proposals`,
      headers: commandHeaders,
      payload: computeBody,
    });
    expect(response.statusCode).toBe(404);
    expect(courses.storeRouteProposal).not.toHaveBeenCalled();
  });

  it('stores a computed route as a proposal and changes no course', async () => {
    const walkingRoutes = walkingRouteFixture();
    const { app, courses } = setup({ walkingRoutes });
    courses.storeRouteProposal = vi.fn().mockResolvedValue(storedProposal());
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-proposals`,
      headers: commandHeaders,
      payload: computeBody,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { outcome: string; proposal: { proposalId: string } };
    expect(body.outcome).toBe('route_computed');
    expect(body.proposal.proposalId).toBe(proposalId);
    // The engine was asked for the draft revision, and the record carries it back.
    expect(walkingRoutes.compute.mock.calls[0]?.[1]).toMatchObject({
      requestRevision: 3,
      profileId: 'foot-v1',
    });
    // Nothing about the course moved: no revision was written.
    expect(courses.update).not.toHaveBeenCalled();
    expect(courses.create).not.toHaveBeenCalled();
    expect(courses.storeRouteProposal).toHaveBeenCalledTimes(1);
  });

  it('spends no engine time on a course that has been reclaimed', async () => {
    const walkingRoutes = walkingRouteFixture();
    const { app, courses } = setup({ walkingRoutes });
    courses.read = vi.fn().mockResolvedValue({
      status: 'unavailable',
      course: {
        status: 'unavailable',
        courseId,
        name: 'Seoul loop',
        visibility: 'private',
        reason: 'source_activity_deleted',
        reclaimedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-proposals`,
      headers: commandHeaders,
      payload: computeBody,
    });
    expect(response.statusCode).toBe(410);
    expect(walkingRoutes.compute).not.toHaveBeenCalled();
  });

  it.each([
    ['no_route', 200],
    ['outside_coverage', 200],
    ['snap_too_far', 200],
    ['timeout', 504],
    ['compute_budget_exceeded', 504],
    ['cancelled', 499],
    ['overloaded', 429],
    ['engine_unavailable', 502],
    ['engine_contract_violation', 502],
    ['graph_mismatch', 502],
  ] as const)(
    'answers %s with %i, stores nothing and returns no geometry',
    async (outcome, status) => {
      const walkingRoutes = walkingRouteFixture(outcome, outcome === 'overloaded' ? 30 : null);
      const { app, courses } = setup({ walkingRoutes });
      courses.storeRouteProposal = vi.fn();
      const response = await app.inject({
        method: 'POST',
        url: `/bff/v1/courses/${courseId}/route-proposals`,
        headers: commandHeaders,
        payload: computeBody,
      });
      expect(response.statusCode).toBe(status);
      const body = response.json() as { outcome: string; draftRevision: number };
      expect(body.outcome).toBe(outcome);
      expect(body.draftRevision).toBe(3);
      expect(response.body).not.toContain('LineString');
      expect(courses.storeRouteProposal).not.toHaveBeenCalled();
      if (outcome === 'overloaded') expect(response.headers['retry-after']).toBe('30');
    },
  );

  it('passes a cancellation signal the dropped connection can raise', async () => {
    seenSignals.length = 0;
    const walkingRoutes = walkingRouteFixture();
    const { app, courses } = setup({ walkingRoutes });
    courses.storeRouteProposal = vi.fn().mockResolvedValue(storedProposal());
    await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-proposals`,
      headers: commandHeaders,
      payload: computeBody,
    });
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('refuses a computation request that carries an engine, a URL or a geometry', async () => {
    const walkingRoutes = walkingRouteFixture();
    const { app } = setup({ walkingRoutes });
    for (const smuggled of ['engineUrl', 'profileId', 'geometry']) {
      const response = await app.inject({
        method: 'POST',
        url: `/bff/v1/courses/${courseId}/route-proposals`,
        headers: commandHeaders,
        payload: { ...computeBody, [smuggled]: 'x' },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(walkingRoutes.compute).not.toHaveBeenCalled();
  });

  it('saves a reviewed proposal with the geometry the server stored, never one sent in', async () => {
    const { app, courses } = setup({ walkingRoutes: walkingRouteFixture() });
    courses.readRouteProposal = vi.fn().mockResolvedValue(storedProposal());
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: {
        expectedRevision: 1,
        change: {
          kind: 'reroute',
          proposalId,
          draftRevision: 3,
          acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const call = vi.mocked(courses.update).mock.calls[0];
    if (!call) throw new Error('the save never reached the repository');
    const [, , expectedRevision, content, , , options] = call;
    expect(expectedRevision).toBe(1);
    expect(content.coordinates).toEqual(routedCoordinates);
    expect(content.waypoints).toEqual(draftWaypoints);
    expect(content.generation.kind).toBe('routed-waypoints');
    // Consumed inside the writing transaction, against a hash recomputed from the line
    // that is about to be written.
    expect(options?.consumeProposal).toEqual({
      proposalId,
      draftRevision: 3,
      geometrySha256: courseGeometrySha256(routedCoordinates),
    });
  });

  it('refuses a save that does not acknowledge the graph the head was computed on', async () => {
    const { app, courses } = setup({ walkingRoutes: walkingRouteFixture() });
    courses.headContent = vi.fn().mockResolvedValue({
      courseId,
      courseRevision: 1,
      name: 'Seoul loop',
      coordinates: routedCoordinates,
      waypoints: draftWaypoints,
      generation: storedProposal(3, 'aaaaaaaaaaaaaaaa').computation
        ? {
            kind: 'routed-waypoints',
            computation: storedProposal(3, 'aaaaaaaaaaaaaaaa').computation,
            engineDistanceMeters: 1,
            engineDurationSeconds: 1,
            maxSnapDistanceMeters: 0,
            waypointCount: 2,
            vertexCount: 3,
          }
        : undefined,
      lineage: [{ activityId, trackId, trackRevision: 1 }],
    });
    courses.readRouteProposal = vi.fn().mockResolvedValue(storedProposal(3, '0123456789abcdef'));
    const save = (previous: string | null) =>
      app.inject({
        method: 'PATCH',
        url: `/bff/v1/courses/${courseId}`,
        headers: commandHeaders,
        payload: {
          expectedRevision: 1,
          change: {
            kind: 'reroute',
            proposalId,
            draftRevision: 3,
            acknowledgedGraph: { previous, next: '0123456789abcdef' },
          },
        },
      });
    // The screen claims the head was not computed at all, but it was — on another graph.
    const unacknowledged = await save(null);
    expect(unacknowledged.statusCode).toBe(409);
    expect(unacknowledged.json()).toMatchObject({
      error: { code: 'COURSE_GRAPH_ACKNOWLEDGEMENT_STALE' },
    });
    expect(courses.update).not.toHaveBeenCalled();
    // Naming the graph the head really carries is accepted: the change was shown.
    const acknowledged = await save('aaaaaaaaaaaaaaaa');
    expect(acknowledged.statusCode).toBe(200);
  });

  it('refuses a save whose draft moved on, and one whose proposal is gone', async () => {
    const { app, courses } = setup({ walkingRoutes: walkingRouteFixture() });
    courses.readRouteProposal = vi.fn().mockResolvedValue(storedProposal(4));
    const stale = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: {
        expectedRevision: 1,
        change: {
          kind: 'reroute',
          proposalId,
          draftRevision: 3,
          acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
        },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'ROUTE_PROPOSAL_STALE_DRAFT' } });

    courses.readRouteProposal = vi.fn().mockResolvedValue(null);
    const missing = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: {
        expectedRevision: 1,
        change: {
          kind: 'reroute',
          proposalId,
          draftRevision: 3,
          acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
        },
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(courses.update).not.toHaveBeenCalled();
  });
});
