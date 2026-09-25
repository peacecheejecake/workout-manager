import { describe, expect, it } from 'vitest';
import {
  courseCandidateEvaluationSchema,
  courseGenerationGraphBuildId,
  courseGenerationSchema,
  courseRouteCandidateRequestSchema,
  courseRouteCandidateResultSchema,
  courseUpdateRequestSchema,
  targetDistanceLimits,
} from '../src/courses';
import { walkingRouteResultSchema } from '../src/routing';

const uuid = (fill: string) =>
  `${fill.repeat(8)}-${fill.repeat(4)}-4${fill.repeat(3)}-8${fill.repeat(3)}-${fill.repeat(12)}`;
const courseId = uuid('1');
const setId = uuid('2');
const proposalId = uuid('3');

const computation = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 3,
  graph: {
    engine: 'graphhopper',
    identitySource: 'engine',
    engineVersion: '10.0',
    engineArtifactSha256: 'a'.repeat(64),
    profileId: 'foot-v1',
    profileConfigSha256: 'b'.repeat(64),
    extractSha256: 'c'.repeat(64),
    extractRegion: 'seoul',
    graphContentSha256: 'd'.repeat(64),
    graphBuildId: '0123456789abcdef',
    graphImportedAt: '2026-03-01T00:00:00.000Z',
    roadDataAt: '2026-02-01T00:00:00.000Z',
  },
  conditions: {
    profileId: 'foot-v1',
    algorithm: 'flexible',
    contractionHierarchies: false,
    maxVisitedNodes: 1_000_000,
    deadlineMilliseconds: 8_000,
    snapLimitMeters: 120,
    waypointCount: 4,
  },
  computedAt: '2026-03-02T00:00:00.000Z',
  computationMilliseconds: 120,
  warnings: [],
};

const evaluation = {
  evaluationVersion: 1,
  targetDistanceMeters: 5_000,
  engineDistanceMeters: 4_800,
  plannedLineMeters: 4_790,
  distanceErrorMeters: -200,
  distanceErrorRatio: -0.04,
  loop: { closed: true, gapMeters: 1.2 },
  connectivity: 'engine-attested-edges',
  repetition: { repeatedMeters: 40, repeatedRatio: 0.008, outAndBack: false },
  knowledge: {
    stairs: 'unknown',
    surface: 'unknown',
    nightAccess: 'unknown',
    accessRestrictions: 'unknown',
    gradient: 'unknown',
  },
  gradientSource: 'none',
  maxSnapDistanceMeters: 3,
  waypointCount: 4,
  vertexCount: 120,
};

const waypoints = [
  { role: 'start', position: [126.9779, 37.5665], name: null, sourceSampleId: null, locked: false },
  { role: 'via', position: [126.983, 37.569], name: null, sourceSampleId: null, locked: false },
  {
    role: 'finish',
    position: [126.9779, 37.5665],
    name: null,
    sourceSampleId: null,
    locked: false,
  },
];

const candidate = {
  proposalId,
  ordinal: 0,
  attemptIndex: 1,
  candidateSeed: 'aaaaaaaabbbbbbbb',
  waypoints,
  geometry: {
    type: 'LineString',
    coordinates: [
      [126.9779, 37.5665],
      [126.983, 37.569],
      [126.9779, 37.5665],
    ],
  },
  engineDistanceMeters: 4_800,
  engineDurationSeconds: 3_600,
  snappedWaypoints: waypoints.map((waypoint) => ({
    requested: waypoint.position,
    snapped: waypoint.position,
    snapDistanceMeters: 0,
  })),
  computation: { ...computation, conditions: { ...computation.conditions, waypointCount: 3 } },
  evaluation: { ...evaluation, waypointCount: 3, vertexCount: 3 },
};

const search = {
  attemptsMade: 3,
  elapsedMilliseconds: 900,
  duplicatesDropped: 1,
  attempts: [
    {
      attemptIndex: 0,
      candidateSeed: '1111111111111111',
      requestedRadiusMeters: 962,
      outcome: 'off_target',
      engineDistanceMeters: 2_100,
    },
    {
      attemptIndex: 1,
      candidateSeed: 'aaaaaaaabbbbbbbb',
      requestedRadiusMeters: 1_200,
      outcome: 'accepted',
      engineDistanceMeters: 4_800,
    },
    {
      attemptIndex: 2,
      candidateSeed: '2222222222222222',
      requestedRadiusMeters: 1_200,
      outcome: 'duplicate',
      engineDistanceMeters: 4_810,
    },
  ],
  stoppedBecause: 'attempt_limit',
};

const bounds = {
  maxCandidates: targetDistanceLimits.maxCandidates,
  maxAttempts: targetDistanceLimits.maxAttempts,
  searchBudgetMilliseconds: targetDistanceLimits.searchBudgetMilliseconds,
  maxSearchRadiusMeters: 2_500,
  distanceToleranceRatio: targetDistanceLimits.distanceToleranceRatio,
};

const candidateSet = {
  candidateSetId: setId,
  courseId,
  requestId: 'req-1',
  draftRevision: 3,
  targetDistanceMeters: 5_000,
  searchSeed: 'feedfacefeedface',
  generatorVersion: 'target-distance-loop-v1',
  evaluationVersion: 1,
  bounds,
  search,
  candidates: [candidate],
  createdAt: '2026-03-02T00:00:00.000Z',
  expiresAt: '2026-03-02T00:30:00.000Z',
};

describe('target-distance candidate contract', () => {
  it('leaves no place for a geometry, a seed-free search or an engine in a request', () => {
    const valid = {
      requestId: 'req-1',
      draftRevision: 3,
      targetDistanceMeters: 5_000,
      seed: null,
      waypoints,
    };
    expect(courseRouteCandidateRequestSchema.safeParse(valid).success).toBe(true);
    for (const extra of [
      { geometry: { type: 'LineString', coordinates: [] } },
      { engineUrl: 'http://localhost:8989' },
      { profileId: 'foot-v1' },
      { maxCandidates: 40 },
      { searchBudgetMilliseconds: 600_000 },
    ])
      expect(courseRouteCandidateRequestSchema.safeParse({ ...valid, ...extra }).success).toBe(
        false,
      );
  });

  it.each([[499], [50_001], [0], [-5_000]])('refuses %p as a target distance', (target) => {
    expect(
      courseRouteCandidateRequestSchema.safeParse({
        requestId: 'req-1',
        draftRevision: 3,
        targetDistanceMeters: target,
        seed: null,
        waypoints,
      }).success,
    ).toBe(false);
  });

  it('accepts only a 16 character hex seed, so a recorded one can be replayed', () => {
    for (const seed of ['feedfacefeedface', null])
      expect(
        courseRouteCandidateRequestSchema.safeParse({
          requestId: 'req-1',
          draftRevision: 3,
          targetDistanceMeters: 5_000,
          seed,
          waypoints,
        }).success,
      ).toBe(true);
    for (const seed of ['', 'FEEDFACEFEEDFACE', 'feedface', 'feedfacefeedfacee', 'zzzz'])
      expect(
        courseRouteCandidateRequestSchema.safeParse({
          requestId: 'req-1',
          draftRevision: 3,
          targetDistanceMeters: 5_000,
          seed,
          waypoints,
        }).success,
      ).toBe(false);
  });

  it('cannot describe a missing fact as anything other than unknown', () => {
    for (const field of [
      'stairs',
      'surface',
      'nightAccess',
      'accessRestrictions',
      'gradient',
    ] as const)
      for (const claim of ['satisfied', 'ok', 'none', true, null])
        expect(
          courseCandidateEvaluationSchema.safeParse({
            ...evaluation,
            knowledge: { ...evaluation.knowledge, [field]: claim },
          }).success,
        ).toBe(false);
    expect(
      courseCandidateEvaluationSchema.safeParse({ ...evaluation, gradientSource: 'srtm' }).success,
    ).toBe(false);
  });

  it('reads a version-2 evaluation with stairs, surface and access measured from the engine', () => {
    const version2 = {
      ...evaluation,
      evaluationVersion: 2,
      knowledge: {
        stairs: {
          status: 'reported',
          known: [
            { value: 'not_steps', meters: 4_700, sections: 3 },
            { value: 'steps', meters: 23.6, sections: 2 },
          ],
          unknownMeters: 66.4,
        },
        surface: {
          status: 'reported',
          known: [{ value: 'paving_stones', meters: 611.2, sections: 4 }],
          unknownMeters: 4_178.8,
        },
        accessRestrictions: { status: 'not_reported' },
        nightAccess: 'unknown',
        gradient: 'unknown',
      },
    };
    expect(courseCandidateEvaluationSchema.parse(version2)).toEqual(version2);
    // Version 1 still reads exactly as it was written.
    expect(courseCandidateEvaluationSchema.parse(evaluation)).toEqual(evaluation);
    // A version cannot borrow the other version's knowledge.
    expect(
      courseCandidateEvaluationSchema.safeParse({ ...evaluation, evaluationVersion: 2 }).success,
    ).toBe(false);
    expect(
      courseCandidateEvaluationSchema.safeParse({ ...version2, evaluationVersion: 1 }).success,
    ).toBe(false);
    expect(
      courseCandidateEvaluationSchema.safeParse({ ...evaluation, evaluationVersion: 3 }).success,
    ).toBe(false);
    const withKnowledge = (knowledge: Record<string, unknown>) =>
      courseCandidateEvaluationSchema.safeParse({
        ...version2,
        knowledge: { ...version2.knowledge, ...knowledge },
      }).success;
    // `yes` and `missing` are not findings, and nothing is "satisfied".
    for (const claim of [
      {
        accessRestrictions: {
          status: 'reported',
          known: [{ value: 'road_access=yes', meters: 1, sections: 1 }],
          unknownMeters: 0,
        },
      },
      {
        surface: {
          status: 'reported',
          known: [{ value: 'missing', meters: 1, sections: 1 }],
          unknownMeters: 0,
        },
      },
      {
        stairs: {
          status: 'reported',
          known: [
            { value: 'steps', meters: 1, sections: 1 },
            { value: 'steps', meters: 2, sections: 1 },
          ],
          unknownMeters: 0,
        },
      },
      { stairs: { status: 'satisfied' } },
      { stairs: 'unknown' },
      { nightAccess: { status: 'reported', known: [], unknownMeters: 0 } },
      { gradient: 'none' },
    ])
      expect(withKnowledge(claim), JSON.stringify(claim)).toBe(false);
  });

  it('refuses a search whose candidates were measured under another evaluation version', () => {
    const parse = (value: unknown) =>
      courseRouteCandidateResultSchema.safeParse({ outcome: 'candidates_generated', set: value })
        .success;
    expect(parse(candidateSet)).toBe(true);
    expect(parse({ ...candidateSet, evaluationVersion: 2 })).toBe(false);
    expect(parse({ ...candidateSet, evaluationVersion: 3 })).toBe(false);
  });

  it('keeps the target, the engine estimate and the stored line apart', () => {
    const parsed = courseCandidateEvaluationSchema.parse(evaluation);
    expect(parsed.targetDistanceMeters).toBe(5_000);
    expect(parsed.engineDistanceMeters).toBe(4_800);
    expect(parsed.plannedLineMeters).toBe(4_790);
    expect(parsed.distanceErrorMeters).toBe(-200);
  });

  it('distinguishes the same computation outcomes the routing adapter does', () => {
    const routing = new Set(
      walkingRouteResultSchema.options.map((option) => option.shape.outcome.value),
    );
    routing.delete('route_computed');
    const candidates = new Set(
      courseRouteCandidateResultSchema.options.map((option) => option.shape.outcome.value),
    );
    candidates.delete('candidates_generated');
    // Plus one this layer has and the adapter does not: the search ran and found none.
    expect(candidates.has('no_candidate')).toBe(true);
    candidates.delete('no_candidate');
    expect([...candidates].sort()).toEqual([...routing].sort());
  });

  it('reads a generated set and names the graph that computed the candidate', () => {
    const parsed = courseRouteCandidateResultSchema.parse({
      outcome: 'candidates_generated',
      set: candidateSet,
    });
    expect(parsed.outcome).toBe('candidates_generated');
    if (parsed.outcome !== 'candidates_generated') return;
    expect(parsed.set.searchSeed).toBe('feedfacefeedface');
    expect(parsed.set.search.attempts).toHaveLength(3);
    expect(parsed.set.candidates[0]?.evaluation.connectivity).toBe('engine-attested-edges');
  });

  it('reports a search that found nothing without a computation it never had', () => {
    const parsed = courseRouteCandidateResultSchema.parse({
      outcome: 'no_candidate',
      courseId,
      draftRevision: 3,
      targetDistanceMeters: 5_000,
      searchSeed: 'feedfacefeedface',
      generatorVersion: 'target-distance-loop-v1',
      evaluationVersion: 1,
      bounds,
      search,
      computation: null,
    });
    expect(parsed.outcome).toBe('no_candidate');
    if (parsed.outcome === 'candidates_generated') return;
    expect(parsed.computation).toBeNull();
    // A failure never carries a line. There is no geometry anywhere in this shape.
    expect(JSON.stringify(parsed)).not.toContain('LineString');
  });

  it('refuses a set that offers more candidates than the search is allowed', () => {
    expect(
      courseRouteCandidateResultSchema.safeParse({
        outcome: 'candidates_generated',
        set: {
          ...candidateSet,
          candidates: Array.from(
            { length: targetDistanceLimits.maxCandidates + 1 },
            (_, ordinal) => ({ ...candidate, ordinal: Math.min(ordinal, 3) }),
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      courseRouteCandidateResultSchema.safeParse({
        outcome: 'candidates_generated',
        set: { ...candidateSet, candidates: [] },
      }).success,
    ).toBe(false);
  });

  it('leaves no place for a geometry or a waypoint list when a candidate is picked', () => {
    const valid = {
      expectedRevision: 2,
      change: {
        kind: 'pick-candidate',
        candidateSetId: setId,
        proposalId,
        draftRevision: 3,
        acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
      },
    };
    expect(courseUpdateRequestSchema.safeParse(valid).success).toBe(true);
    for (const extra of [
      { geometry: { type: 'LineString', coordinates: [] } },
      { waypoints },
      { distanceMeters: 5_000 },
      { evaluation },
      { targetDistanceMeters: 5_000 },
    ])
      expect(
        courseUpdateRequestSchema.safeParse({
          ...valid,
          change: { ...valid.change, ...extra },
        }).success,
      ).toBe(false);
  });

  it('records the search a generated revision came from, and no coordinate', () => {
    const generation = courseGenerationSchema.parse({
      kind: 'target-distance-loop',
      computation,
      engineDistanceMeters: 4_800,
      engineDurationSeconds: 3_600,
      maxSnapDistanceMeters: 3,
      waypointCount: 4,
      vertexCount: 120,
      targetDistanceMeters: 5_000,
      searchSeed: 'feedfacefeedface',
      candidateSeed: 'aaaaaaaabbbbbbbb',
      attemptIndex: 1,
      generatorVersion: 'target-distance-loop-v1',
      evaluation,
    });
    expect(courseGenerationGraphBuildId(generation)).toBe('0123456789abcdef');
    const serialised = JSON.stringify(generation);
    expect(serialised).not.toContain('126.9');
    expect(serialised).not.toContain('37.5');
    expect(serialised).not.toContain('coordinates');
  });

  it('refuses an attempt index or an ordinal outside the bounds the search has', () => {
    expect(
      courseGenerationSchema.safeParse({
        kind: 'target-distance-loop',
        computation,
        engineDistanceMeters: 4_800,
        engineDurationSeconds: 3_600,
        maxSnapDistanceMeters: 3,
        waypointCount: 4,
        vertexCount: 120,
        targetDistanceMeters: 5_000,
        searchSeed: 'feedfacefeedface',
        candidateSeed: 'aaaaaaaabbbbbbbb',
        attemptIndex: targetDistanceLimits.maxAttempts,
        generatorVersion: 'target-distance-loop-v1',
        evaluation,
      }).success,
    ).toBe(false);
    expect(
      courseRouteCandidateResultSchema.safeParse({
        outcome: 'candidates_generated',
        set: {
          ...candidateSet,
          candidates: [{ ...candidate, ordinal: targetDistanceLimits.maxCandidates }],
        },
      }).success,
    ).toBe(false);
  });
});
