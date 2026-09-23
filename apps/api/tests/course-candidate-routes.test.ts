import { Writable } from 'node:stream';

import type { WalkingRouteResult } from '@workout/contracts/routing';
import { targetDistanceLimits } from '@workout/contracts/courses';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import type { ActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import {
  CourseStateError,
  type CourseRepository,
  type StoredCandidateSetInput,
} from '@workout/server-persistence/courses';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/app.js';

/**
 * The target-distance candidate endpoint (M2-01i).
 *
 * What these tests hold: generating candidates changes nothing about the course, a search
 * that found none is a named 200 answer rather than an error, a refusal by the engine is
 * neither of those, no outcome returns a geometry the caller sent in, and picking one is
 * the only thing that writes. The engine itself is not under test here — it has its own
 * suite — so the port is a fixture whose answers this file controls.
 */
const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const activityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const trackId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const courseId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const setId = '99999999-9999-4999-8999-999999999999';
const proposalId = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const createdAt = '2026-09-19T01:00:00.000Z';
const csrfToken = 'c'.repeat(43);
const baseHeaders = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};
const commandHeaders = { ...baseHeaders, 'idempotency-key': 'course-command-0009' };

const origin: [number, number] = [126.9779, 37.5665];
const graph = {
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

const courseHead = {
  status: 'available' as const,
  courseId,
  name: 'Seoul loop',
  visibility: 'private' as const,
  headRevision: 1,
  revisionId: '44444444-4444-4444-8444-444444444444',
  createdAt,
  updatedAt: createdAt,
};

const courseRevision = {
  courseId,
  courseRevision: 1,
  revisionId: courseHead.revisionId,
  name: 'Seoul loop',
  geometry: { type: 'LineString' as const, coordinates: [origin, [126.98, 37.567]] },
  waypoints: [
    { role: 'start' as const, position: origin, name: null, sourceSampleId: '0:0', locked: false },
    {
      role: 'finish' as const,
      position: origin,
      name: null,
      sourceSampleId: null,
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
    endSampleId: '0:2',
    vertexCount: 2,
    mapPathContentSha256: 'e'.repeat(64),
    simplificationVersion: 1 as const,
    toleranceMeters: 2.5,
  },
  edit: { kind: 'created' as const },
  lineage: [{ activityId, trackId, trackRevision: 1 }],
  distanceMeters: 30,
  contentDigest: 'f'.repeat(64),
  createdAt,
};

const instances: ReturnType<typeof createApi>[] = [];

function bentLine(waypoints: readonly [number, number][]): [number, number][] {
  const first = waypoints[0];
  if (first === undefined) return [];
  const line: [number, number][] = [first];
  for (let index = 1; index < waypoints.length; index += 1) {
    const a = waypoints[index - 1];
    const b = waypoints[index];
    if (a === undefined || b === undefined) continue;
    line.push([(a[0] + b[0]) / 2 + 0.0004, (a[1] + b[1]) / 2 + 0.0004]);
    line.push(b);
  }
  return line;
}

function engineFixture(
  options: {
    outcome?: WalkingRouteResult['outcome'];
    distanceMeters?: number;
    retryAfterSeconds?: number | null;
  } = {},
) {
  const signals: (AbortSignal | null)[] = [];
  const compute = vi.fn(
    async (_tenant: string, request: unknown, context: { signal?: AbortSignal }) => {
      const parsed = request as {
        requestId: string;
        requestRevision: number;
        waypoints: [number, number][];
      };
      signals.push(context.signal ?? null);
      const computation = {
        schemaVersion: 1 as const,
        requestId: parsed.requestId,
        requestRevision: parsed.requestRevision,
        graph,
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
      const outcome = options.outcome ?? 'route_computed';
      if (outcome !== 'route_computed')
        return {
          result: { outcome, computation },
          retryAfterSeconds: options.retryAfterSeconds ?? null,
        };
      return {
        result: {
          outcome: 'route_computed' as const,
          computation,
          geometry: { type: 'LineString' as const, coordinates: bentLine(parsed.waypoints) },
          distanceMeters: options.distanceMeters ?? 5_000,
          durationSeconds: 3_600,
          snappedWaypoints: parsed.waypoints.map((waypoint) => ({
            requested: waypoint,
            snapped: waypoint,
            snapDistanceMeters: 0,
          })),
        },
        retryAfterSeconds: null,
      };
    },
  );
  return { compute, signals };
}

function storedCandidate(coordinates: [number, number][]) {
  return {
    candidate: {
      proposalId,
      ordinal: 0,
      attemptIndex: 1,
      candidateSeed: 'aaaaaaaabbbbbbbb',
      waypoints: [
        {
          role: 'start' as const,
          position: origin,
          name: null,
          sourceSampleId: null,
          locked: false,
        },
        {
          role: 'via' as const,
          position: [126.983, 37.569] as [number, number],
          name: null,
          sourceSampleId: null,
          locked: false,
        },
        {
          role: 'finish' as const,
          position: origin,
          name: null,
          sourceSampleId: null,
          locked: false,
        },
      ],
      geometry: { type: 'LineString' as const, coordinates },
      engineDistanceMeters: 4_800,
      engineDurationSeconds: 3_600,
      snappedWaypoints: [origin, [126.983, 37.569] as [number, number], origin].map((position) => ({
        requested: position,
        snapped: position,
        snapDistanceMeters: 0,
      })),
      computation: {
        schemaVersion: 1 as const,
        requestId: 'req-1:1',
        requestRevision: 4,
        graph,
        conditions: {
          profileId: 'foot-v1' as const,
          algorithm: 'flexible' as const,
          contractionHierarchies: false as const,
          maxVisitedNodes: 1_000_000,
          deadlineMilliseconds: 8_000,
          snapLimitMeters: 120,
          waypointCount: 3,
        },
        computedAt: createdAt,
        computationMilliseconds: 120,
        warnings: [],
      },
      evaluation: {
        evaluationVersion: 1 as const,
        targetDistanceMeters: 5_000,
        engineDistanceMeters: 4_800,
        plannedLineMeters: 4_790,
        distanceErrorMeters: -200,
        distanceErrorRatio: -0.04,
        loop: { closed: true, gapMeters: 0 },
        connectivity: 'engine-attested-edges' as const,
        repetition: { repeatedMeters: 0, repeatedRatio: 0, outAndBack: false },
        knowledge: {
          stairs: 'unknown' as const,
          surface: 'unknown' as const,
          nightAccess: 'unknown' as const,
          accessRestrictions: 'unknown' as const,
          gradient: 'unknown' as const,
        },
        gradientSource: 'none' as const,
        maxSnapDistanceMeters: 0,
        waypointCount: 3,
        vertexCount: coordinates.length,
      },
    },
    candidateSetId: setId,
    draftRevision: 4,
    targetDistanceMeters: 5_000,
    searchSeed: 'feedfacefeedface',
  };
}

function setup(
  options: {
    authenticated?: boolean;
    engine?: ReturnType<typeof engineFixture>;
    read?: unknown;
  } = {},
) {
  const courses: CourseRepository = {
    replayCommand: vi.fn().mockResolvedValue(null),
    resolveThumbnailObject: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockRejectedValue(new Error('not used')),
    read: vi.fn().mockResolvedValue(
      options.read ?? {
        status: 'available',
        course: courseHead,
        revision: courseRevision,
        thumbnail: { status: 'none' },
      },
    ),
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
      thumbnail: { status: 'none' },
    }),
    remove: vi.fn().mockResolvedValue({ deleted: true }),
    storeRouteProposal: vi.fn().mockRejectedValue(new Error('not used')),
    assertRouteProposalRoom: vi.fn().mockResolvedValue(undefined),
    readRouteProposal: vi.fn().mockResolvedValue(null),
    storeRouteCandidateSet: vi.fn(async (_tenant: string, input: StoredCandidateSetInput) => ({
      candidateSetId: setId,
      courseId,
      requestId: input.requestId,
      draftRevision: input.draftRevision,
      targetDistanceMeters: input.targetDistanceMeters,
      // Echoed, not invented: the seed the route drew is the one that must be recorded.
      searchSeed: input.searchSeed,
      generatorVersion: 'target-distance-loop-v1' as const,
      evaluationVersion: 1 as const,
      bounds: {
        maxCandidates: targetDistanceLimits.maxCandidates,
        maxAttempts: targetDistanceLimits.maxAttempts,
        searchBudgetMilliseconds: targetDistanceLimits.searchBudgetMilliseconds,
        maxSearchRadiusMeters: 2_500,
        distanceToleranceRatio: targetDistanceLimits.distanceToleranceRatio,
      },
      search: {
        attemptsMade: input.candidates.length,
        elapsedMilliseconds: 40,
        duplicatesDropped: 0,
        attempts: input.candidates.map((_, index) => ({
          attemptIndex: index,
          candidateSeed: 'aaaaaaaabbbbbbbb',
          requestedRadiusMeters: 962,
          outcome: 'accepted' as const,
          engineDistanceMeters: 5_000,
        })),
        stoppedBecause: 'candidate_limit' as const,
      },
      candidates: input.candidates.map((entry, ordinal) => ({
        ...storedCandidate([...entry.coordinates] as [number, number][]).candidate,
        ordinal,
      })),
      createdAt,
      expiresAt: '2026-09-19T01:30:00.000Z',
    })),
    readRouteCandidate: vi.fn().mockResolvedValue(null),
    affectedByActivityDeletion: vi.fn().mockRejectedValue(new Error('not used')),
  };
  const tracks = { read: vi.fn(), resolveObject: vi.fn() } as unknown as ActivityTrackRepository;
  const storage = { open: vi.fn(), stat: vi.fn() } as unknown as ObjectStorage;
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
    ...(options.engine ? { walkingRoutes: options.engine } : {}),
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, courses, engine: options.engine };
}

const draftWaypoints = [
  { role: 'start', position: origin, name: null, sourceSampleId: '0:0', locked: false },
  { role: 'finish', position: origin, name: null, sourceSampleId: null, locked: false },
];

const candidateRequest = {
  requestId: 'req-1',
  draftRevision: 4,
  targetDistanceMeters: 5_000,
  seed: null,
  waypoints: draftWaypoints,
};

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('target-distance candidate route', () => {
  it('generates candidates and changes no course at all', async () => {
    const engine = engineFixture();
    const { app, courses } = setup({ engine });
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe('candidates_generated');
    expect(body.set.candidates.length).toBeGreaterThan(0);
    expect(body.set.searchSeed).toMatch(/^[0-9a-f]{16}$/);
    expect(body.set.evaluationVersion).toBe(1);
    // A proposal, not a course: nothing was updated and nothing was created.
    expect(courses.update).not.toHaveBeenCalled();
    expect(courses.create).not.toHaveBeenCalled();
    expect(courses.storeRouteCandidateSet).toHaveBeenCalledTimes(1);
  });

  it('records the seed it drew, and replays a seed it is given', async () => {
    const first = engineFixture();
    const drawn = await setup({ engine: first }).app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    const replay = await setup({ engine: engineFixture() }).app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: { ...candidateRequest, seed: 'feedfacefeedface' },
    });
    const again = await setup({ engine: engineFixture() }).app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(drawn.json().set.searchSeed).toMatch(/^[0-9a-f]{16}$/);
    // Drawn by the server, not a constant: two searches that were not given a seed do not
    // run the same search, and the one recorded is the one that ran.
    expect(again.json().set.searchSeed).not.toBe(drawn.json().set.searchSeed);
    expect(replay.json().set.searchSeed).toBe('feedfacefeedface');
  });

  it('answers a search that found nothing with an outcome, and stores nothing', async () => {
    // Every attempt comes back far past the tolerance, so none is offered.
    const engine = engineFixture({ distanceMeters: 12_000 });
    const { app, courses } = setup({ engine });
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe('no_candidate');
    expect(body.search.attempts.every((a: { outcome: string }) => a.outcome !== 'accepted')).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toContain('LineString');
    expect(courses.storeRouteCandidateSet).not.toHaveBeenCalled();
    expect(courses.update).not.toHaveBeenCalled();
  });

  it.each([
    ['overloaded', 429],
    ['timeout', 504],
    ['engine_unavailable', 502],
    ['graph_mismatch', 502],
  ])('answers %s with %i, stores nothing and returns no geometry', async (outcome, status) => {
    const engine = engineFixture({
      outcome: outcome as WalkingRouteResult['outcome'],
      retryAfterSeconds: outcome === 'overloaded' ? 30 : null,
    });
    const { app, courses } = setup({ engine });
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().outcome).toBe(outcome);
    expect(JSON.stringify(response.json())).not.toContain('LineString');
    expect(courses.storeRouteCandidateSet).not.toHaveBeenCalled();
    // A refusal that stops the search costs exactly one computation, not eight.
    expect(engine.compute).toHaveBeenCalledTimes(1);
  });

  it('bounds how much engine time one request may spend', async () => {
    const engine = engineFixture({ distanceMeters: 12_000 });
    const { app } = setup({ engine });
    await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(engine.compute.mock.calls.length).toBeLessThanOrEqual(targetDistanceLimits.maxAttempts);
    expect(engine.compute.mock.calls.length).toBeGreaterThan(0);
  });

  it('passes a cancellation signal the dropped connection can raise', async () => {
    const engine = engineFixture();
    const { app } = setup({ engine });
    await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(engine.signals.length).toBeGreaterThan(0);
    for (const signal of engine.signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a request that carries an engine, a URL, a geometry or its own bounds', async () => {
    const engine = engineFixture();
    const { app } = setup({ engine });
    for (const extra of [
      { engineUrl: 'http://127.0.0.1:8989' },
      { profileId: 'foot-v1' },
      { geometry: { type: 'LineString', coordinates: [origin, origin] } },
      { maxCandidates: 50 },
      { targetDistanceMeters: 500_000 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/bff/v1/courses/${courseId}/route-candidates`,
        headers: baseHeaders,
        payload: { ...candidateRequest, ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(engine.compute).not.toHaveBeenCalled();
  });

  it('spends no engine time on a course that has been reclaimed', async () => {
    const engine = engineFixture();
    const { app } = setup({
      engine,
      read: {
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
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(response.statusCode).toBe(410);
    expect(engine.compute).not.toHaveBeenCalled();
  });

  it('spends no engine time when the largest search could not be stored (M2-01p)', async () => {
    const engine = engineFixture();
    const { app, courses } = setup({ engine });
    courses.assertRouteProposalRoom = vi
      .fn()
      .mockRejectedValue(new CourseStateError('ROUTE_PROPOSAL_QUOTA_EXCEEDED'));
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('ROUTE_PROPOSAL_QUOTA_EXCEEDED');
    expect(engine.compute).not.toHaveBeenCalled();
    expect(courses.storeRouteCandidateSet).not.toHaveBeenCalled();
    // Room for the largest search this route may produce, for this draft, as a search.
    expect(courses.assertRouteProposalRoom).toHaveBeenCalledWith(expect.any(String), {
      courseId,
      draftRevision: 4,
      kind: 'candidates',
      adding: targetDistanceLimits.maxCandidates,
    });
  });

  it('offers no candidate route at all when no engine is configured', async () => {
    const { app } = setup({});
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/route-candidates`,
      headers: baseHeaders,
      payload: candidateRequest,
    });
    expect(response.statusCode).toBe(404);
  });

  it('authenticates and checks CSRF before any engine work happens', async () => {
    const engine = engineFixture();
    const unauthenticated = setup({ engine, authenticated: false });
    expect(
      (
        await unauthenticated.app.inject({
          method: 'POST',
          url: `/bff/v1/courses/${courseId}/route-candidates`,
          headers: baseHeaders,
          payload: candidateRequest,
        })
      ).statusCode,
    ).toBe(401);
    const noCsrf = setup({ engine });
    const { 'x-csrf-token': _omitted, ...withoutCsrf } = baseHeaders;
    expect(
      (
        await noCsrf.app.inject({
          method: 'POST',
          url: `/bff/v1/courses/${courseId}/route-candidates`,
          headers: withoutCsrf,
          payload: candidateRequest,
        })
      ).statusCode,
    ).toBe(403);
    expect(engine.compute).not.toHaveBeenCalled();
  });
});

describe('picking one generated candidate', () => {
  const pickBody = {
    expectedRevision: 1,
    change: {
      kind: 'pick-candidate',
      candidateSetId: setId,
      proposalId,
      draftRevision: 4,
      acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
    },
  };

  it('saves the geometry the server stored, never one sent in', async () => {
    const { app, courses } = setup({});
    const coordinates: [number, number][] = [origin, [126.983, 37.569], origin];
    vi.mocked(courses.readRouteCandidate).mockResolvedValue(storedCandidate(coordinates));
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: pickBody,
    });
    expect(response.statusCode).toBe(200);
    const [, , , content, , , options] = vi.mocked(courses.update).mock.calls[0] ?? [];
    expect(content?.coordinates).toEqual(coordinates);
    expect(content?.edit).toEqual({ kind: 'generated' });
    expect(content?.generation.kind).toBe('target-distance-loop');
    if (content?.generation.kind === 'target-distance-loop') {
      expect(content.generation.searchSeed).toBe('feedfacefeedface');
      expect(content.generation.targetDistanceMeters).toBe(5_000);
      expect(content.generation.evaluation.knowledge.stairs).toBe('unknown');
    }
    // The lineage comes from the head: generating a loop is not a way out of reclamation.
    expect(content?.lineage).toEqual(courseRevision.lineage);
    expect(options?.consumeCandidate).toEqual({
      proposalId,
      candidateSetId: setId,
      draftRevision: 4,
      geometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('refuses a pick whose draft moved on, and one whose candidate is gone', async () => {
    const { app, courses } = setup({});
    vi.mocked(courses.readRouteCandidate).mockResolvedValue({
      ...storedCandidate([origin, [126.983, 37.569], origin]),
      draftRevision: 9,
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/bff/v1/courses/${courseId}`,
          headers: commandHeaders,
          payload: pickBody,
        })
      ).statusCode,
    ).toBe(409);
    vi.mocked(courses.readRouteCandidate).mockResolvedValue(null);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/bff/v1/courses/${courseId}`,
          headers: { ...commandHeaders, 'idempotency-key': 'course-command-0010' },
          payload: pickBody,
        })
      ).statusCode,
    ).toBe(404);
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('refuses a pick that does not acknowledge the graph the head was computed on', async () => {
    const { app, courses } = setup({});
    vi.mocked(courses.readRouteCandidate).mockResolvedValue(
      storedCandidate([origin, [126.983, 37.569], origin]),
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: {
        ...pickBody,
        change: {
          ...pickBody.change,
          acknowledgedGraph: { previous: 'fedcba9876543210', next: '0123456789abcdef' },
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('COURSE_GRAPH_ACKNOWLEDGEMENT_STALE');
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('refuses a pick whose candidate was computed on a graph nobody acknowledged', async () => {
    const { app, courses } = setup({});
    vi.mocked(courses.readRouteCandidate).mockResolvedValue(
      storedCandidate([origin, [126.983, 37.569], origin]),
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: {
        ...pickBody,
        change: {
          ...pickBody.change,
          acknowledgedGraph: { previous: null, next: 'fedcba9876543210' },
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('answers a candidate that belongs to another search with a conflict', async () => {
    const { app, courses } = setup({});
    vi.mocked(courses.readRouteCandidate).mockResolvedValue(
      storedCandidate([origin, [126.983, 37.569], origin]),
    );
    vi.mocked(courses.update).mockRejectedValue(
      new CourseStateError('ROUTE_CANDIDATE_SET_MISMATCH'),
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: commandHeaders,
      payload: pickBody,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ROUTE_CANDIDATE_SET_MISMATCH');
  });
});
