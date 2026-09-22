import { describe, expect, it, vi } from 'vitest';
import {
  courseGenerationSchema,
  targetDistanceLimits,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import type { RouteComputationRecord } from '@workout/contracts/routing';

import {
  CandidateSearchError,
  deriveCandidateSeed,
  destinationPoint,
  generateTargetDistanceCandidates,
  polylineMeters,
  repeatedSection,
  shapeOverlapRatio,
  traversedCells,
  targetDistanceGeneration,
  type CandidateDeadlineScheduler,
  type CandidateLegRouter,
  type CandidateRouteAnswer,
  type CandidateRouteOutcome,
} from '../src/candidates.js';
import { greatCircleMeters } from '../src/geo.js';

const origin: CoursePosition = [126.9779, 37.5665];

function computationFor(waypointCount: number): RouteComputationRecord {
  return {
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
      waypointCount,
    },
    computedAt: '2026-03-02T00:00:00.000Z',
    computationMilliseconds: 12,
    warnings: [],
  };
}

/**
 * A line that visits every requested waypoint with a bend in each leg, so it is never the
 * chord between two points. The fake stands in for the engine only in shape: every real
 * answer has already passed the adapter's edge attestation before it reaches this module.
 */
function bentLine(waypoints: readonly CoursePosition[]): CoursePosition[] {
  const first = waypoints[0];
  if (first === undefined) return [];
  const line: CoursePosition[] = [first];
  for (let index = 1; index < waypoints.length; index += 1) {
    const a = waypoints[index - 1];
    const b = waypoints[index];
    if (a === undefined || b === undefined) continue;
    line.push([(a[0] + b[0]) / 2 + 0.0004, (a[1] + b[1]) / 2 + 0.0004]);
    line.push(b);
  }
  return line;
}

interface FakeOptions {
  readonly distanceFor?: (line: readonly CoursePosition[], attempt: number) => number;
  readonly lineFor?: (
    waypoints: readonly CoursePosition[],
    attempt: number,
  ) => readonly CoursePosition[];
  readonly refuseWith?: (attempt: number) => CandidateRouteOutcome | null;
  /** Runs inside the call, so a test can make time pass or fire the search's deadline. */
  readonly during?: (attempt: number, signal: AbortSignal) => void;
}

function fakeRouter(options: FakeOptions = {}) {
  const calls: { requestId: string; waypoints: readonly CoursePosition[] }[] = [];
  const signals: AbortSignal[] = [];
  let attempt = 0;
  const router: CandidateLegRouter = {
    async route(input, context): Promise<CandidateRouteAnswer> {
      const index = attempt;
      attempt += 1;
      calls.push({ requestId: input.requestId, waypoints: input.waypoints });
      signals.push(context.signal);
      options.during?.(index, context.signal);
      // A real adapter reports a caller abort as a cancellation rather than a route.
      if (context.signal.aborted)
        return {
          kind: 'refused',
          outcome: 'cancelled',
          computation: computationFor(input.waypoints.length),
        };
      const refusal = options.refuseWith?.(index) ?? null;
      if (refusal !== null)
        return {
          kind: 'refused',
          outcome: refusal,
          computation: computationFor(input.waypoints.length),
        };
      const line = options.lineFor
        ? options.lineFor(input.waypoints, index)
        : bentLine(input.waypoints);
      return {
        kind: 'computed',
        coordinates: line,
        distanceMeters: options.distanceFor
          ? options.distanceFor(line, index)
          : polylineMeters(line),
        durationSeconds: 1200,
        snappedWaypoints: input.waypoints.map((position) => ({
          requested: position,
          snapped: position,
          snapDistanceMeters: 0,
        })),
        computation: computationFor(input.waypoints.length),
      };
    },
  };
  return { router, calls, signals };
}

function waypointList(extra: CourseWaypoint[] = []): CourseWaypoint[] {
  return [
    { role: 'start', position: origin, name: '출발', sourceSampleId: '0:0', locked: false },
    ...extra,
    { role: 'finish', position: origin, name: null, sourceSampleId: null, locked: false },
  ];
}

const fixedClock = { now: () => new Date('2026-04-01T00:00:00.000Z') };

function search(options: {
  readonly router: CandidateLegRouter;
  readonly target?: number;
  readonly seed?: string;
  readonly waypoints?: CourseWaypoint[];
  readonly clock?: { now(): Date };
  readonly signal?: AbortSignal;
  readonly deadline?: CandidateDeadlineScheduler;
}) {
  return generateTargetDistanceCandidates({
    requestId: 'req-1',
    draftRevision: 3,
    targetDistanceMeters: options.target ?? 5_000,
    searchSeed: options.seed ?? '00112233445566aa',
    waypoints: options.waypoints ?? waypointList(),
    router: options.router,
    clock: options.clock ?? fixedClock,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
  });
}

describe('bounded target-distance candidate search', () => {
  it('offers nothing at all rather than a line that misses the target', async () => {
    // Every attempt comes back more than twice the target. The search spends its attempts,
    // offers none of them and says so; there is no "closest we found" consolation answer.
    const { router, calls } = fakeRouter({ distanceFor: () => 12_000 });
    const result = await search({ router });
    expect(result.candidates).toHaveLength(0);
    expect(result.terminalOutcome).toBeNull();
    expect(result.search.stoppedBecause).toBe('attempt_limit');
    expect(result.search.attempts.map((attempt) => attempt.outcome)).toEqual(
      Array.from({ length: targetDistanceLimits.maxAttempts }, () => 'off_target'),
    );
    expect(calls).toHaveLength(targetDistanceLimits.maxAttempts);
  });

  it('asks for a first shape that is already near the target', async () => {
    // The engine answers with the length of the line it was asked for, so this measures the
    // geometry the search proposes rather than a fixture's opinion of it. The first attempt
    // has measured nothing yet; if the starting radius were wrong it would be off target.
    const { router, calls } = fakeRouter({ distanceFor: (line) => polylineMeters(line) });
    const result = await search({ router, target: 5_000 });
    expect(result.search.attempts[0]?.outcome).toBe('accepted');
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const perimeter = polylineMeters([...(firstCall?.waypoints ?? [])] as CoursePosition[]);
    expect(perimeter).toBeGreaterThan(5_000 * 0.85);
    expect(perimeter).toBeLessThan(5_000 * 1.15);
  });

  it('stops at its candidate limit and reports every attempt it spent', async () => {
    const { router, calls } = fakeRouter({ distanceFor: () => 5_000 });
    const result = await search({ router });
    expect(result.candidates).toHaveLength(targetDistanceLimits.maxCandidates);
    expect(result.search.stoppedBecause).toBe('candidate_limit');
    expect(result.search.attemptsMade).toBe(calls.length);
    expect(calls.length).toBeLessThanOrEqual(targetDistanceLimits.maxAttempts);
    expect(result.bounds).toEqual({
      maxCandidates: targetDistanceLimits.maxCandidates,
      maxAttempts: targetDistanceLimits.maxAttempts,
      searchBudgetMilliseconds: targetDistanceLimits.searchBudgetMilliseconds,
      maxSearchRadiusMeters: 2_500,
      distanceToleranceRatio: targetDistanceLimits.distanceToleranceRatio,
    });
  });

  it('stops on its own wall-clock budget without asking the engine again', async () => {
    let tick = 0;
    const clock = {
      now: () => new Date(1_800_000_000_000 + (tick += 20_000)),
    };
    const { router, calls } = fakeRouter({ distanceFor: () => 12_000 });
    const result = await search({ router, clock });
    expect(result.search.stoppedBecause).toBe('time_budget');
    expect(result.candidates).toHaveLength(0);
    // The budget is checked before an attempt, so the engine is spared the rest of them.
    expect(calls.length).toBeLessThan(targetDistanceLimits.maxAttempts);
  });

  it('bounds the whole search, not the gaps between its calls', async () => {
    // Each call finishes just inside the eight-second per-call limit. Checking the budget
    // only before a call therefore bounded nothing: eight of them ran 63 s under a 30 s
    // budget, and the answer still reported the budget as if it had held.
    let now = 1_800_000_000_000;
    const clock = { now: () => new Date(now) };
    const pending: { fire: () => void; delay: number }[] = [];
    const deadline: CandidateDeadlineScheduler = {
      schedule(onDeadline, delayMilliseconds) {
        const entry = { fire: onDeadline, delay: delayMilliseconds };
        pending.push(entry);
        return () => {
          const at = pending.indexOf(entry);
          if (at >= 0) pending.splice(at, 1);
        };
      },
    };
    const { router, calls } = fakeRouter({
      distanceFor: () => 12_000,
      during: () => {
        now += 7_900;
        // Whatever time the clock has reached, the armed deadline fires when it is due.
        for (const entry of [...pending]) if (entry.delay <= 7_900) entry.fire();
      },
    });
    const result = await search({ router, clock, deadline });
    expect(result.search.stoppedBecause).toBe('time_budget');
    expect(result.search.elapsedMilliseconds).toBeLessThanOrEqual(
      targetDistanceLimits.searchBudgetMilliseconds + 7_900,
    );
    // Four calls of 7.9 s reach 31.6 s, so the fourth is the one the deadline catches.
    expect(calls).toHaveLength(4);
    expect(result.search.attempts.at(-1)?.outcome).toBe('timeout');
    // A bound being reached is not an unknown result: nothing was stored either way.
    expect(result.terminalOutcome).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });

  it('hands each call the budget that is left, and abandons it when that runs out', async () => {
    let now = 1_800_000_000_000;
    const clock = { now: () => new Date(now) };
    const delays: number[] = [];
    const deadline: CandidateDeadlineScheduler = {
      schedule(onDeadline, delayMilliseconds) {
        delays.push(delayMilliseconds);
        // Fire immediately: the budget is already gone when this call starts.
        if (delayMilliseconds <= 0) onDeadline();
        return () => undefined;
      },
    };
    const { router, signals } = fakeRouter({
      distanceFor: () => 5_000,
      during: () => {
        now += 40_000;
      },
    });
    const result = await search({ router, clock, deadline });
    expect(delays[0]).toBe(targetDistanceLimits.searchBudgetMilliseconds);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    // The first call overran on its own, so its answer is not used and the search stops.
    expect(result.search.stoppedBecause).toBe('time_budget');
    expect(result.candidates).toHaveLength(0);
    expect(result.search.attempts).toHaveLength(1);
  });

  it('never accepts a candidate from an answer that arrived after the budget', async () => {
    let now = 1_800_000_000_000;
    const clock = { now: () => new Date(now) };
    const { router } = fakeRouter({
      // A perfectly good answer, but it comes back after the search was due to stop.
      distanceFor: () => 5_000,
      during: () => {
        now += 40_000;
      },
    });
    const result = await search({ router, clock, deadline: { schedule: () => () => undefined } });
    expect(result.candidates).toHaveLength(0);
    expect(result.search.stoppedBecause).toBe('time_budget');
    expect(result.search.attempts.at(-1)?.outcome).toBe('timeout');
  });

  it('stops when the caller cancels, and reports cancellation rather than emptiness', async () => {
    const controller = new AbortController();
    const { router, calls } = fakeRouter({
      distanceFor: () => 12_000,
      lineFor: (waypoints) => {
        controller.abort();
        return bentLine(waypoints);
      },
    });
    const result = await search({ router, signal: controller.signal });
    expect(calls).toHaveLength(1);
    expect(result.search.stoppedBecause).toBe('cancelled');
    expect(result.terminalOutcome).toBe('cancelled');
    expect(result.candidates).toHaveLength(0);
  });

  it.each([
    ['overloaded' as const],
    ['timeout' as const],
    ['engine_unavailable' as const],
    ['graph_mismatch' as const],
  ])('stops immediately on %s and spends no further engine time', async (outcome) => {
    const { router, calls } = fakeRouter({ refuseWith: () => outcome });
    const result = await search({ router });
    expect(calls).toHaveLength(1);
    expect(result.terminalOutcome).toBe(outcome);
    expect(result.search.stoppedBecause).toBe('engine_refusal');
    expect(result.candidates).toHaveLength(0);
  });

  it.each([
    ['no_route' as const],
    ['outside_coverage' as const],
    ['snap_too_far' as const],
    ['request_refused' as const],
  ])('keeps looking after %s, which is about one shape and not the engine', async (outcome) => {
    const { router, calls } = fakeRouter({ refuseWith: () => outcome });
    const result = await search({ router });
    expect(calls).toHaveLength(targetDistanceLimits.maxAttempts);
    expect(result.terminalOutcome).toBeNull();
    expect(result.search.stoppedBecause).toBe('attempt_limit');
    expect(result.search.attempts.every((attempt) => attempt.outcome === outcome)).toBe(true);
  });

  it('offers one proposal, not four, when every attempt walks the same streets', async () => {
    const loop = [
      origin,
      destinationPoint(origin, 0, 400),
      destinationPoint(origin, 120, 400),
      origin,
    ];
    const { router } = fakeRouter({ lineFor: () => loop, distanceFor: () => 5_000 });
    const result = await search({ router });
    expect(result.candidates).toHaveLength(1);
    expect(result.search.duplicatesDropped).toBeGreaterThan(0);
    expect(result.search.attempts.filter((attempt) => attempt.outcome === 'duplicate').length).toBe(
      result.search.duplicatesDropped,
    );
  });

  it('searches the same way twice from one seed, and differently from another', async () => {
    const first = fakeRouter({ distanceFor: () => 5_000 });
    const again = fakeRouter({ distanceFor: () => 5_000 });
    const other = fakeRouter({ distanceFor: () => 5_000 });
    const a = await search({ router: first.router, seed: 'aaaaaaaabbbbbbbb' });
    const b = await search({ router: again.router, seed: 'aaaaaaaabbbbbbbb' });
    const c = await search({ router: other.router, seed: 'ccccccccdddddddd' });
    expect(first.calls).toEqual(again.calls);
    expect(a.candidates.map((candidate) => candidate.candidateSeed)).toEqual(
      b.candidates.map((candidate) => candidate.candidateSeed),
    );
    expect(first.calls).not.toEqual(other.calls);
    expect(a.candidates[0]?.candidateSeed).toBe(deriveCandidateSeed('aaaaaaaabbbbbbbb', 0));
    expect(c.candidates[0]?.candidateSeed).toBe(deriveCandidateSeed('ccccccccdddddddd', 0));
  });

  it('refuses a line that does not come back to where it started', async () => {
    const { router } = fakeRouter({
      lineFor: (waypoints) => {
        const line = [...bentLine(waypoints)];
        line[line.length - 1] = destinationPoint(origin, 90, 400);
        return line;
      },
      distanceFor: () => 5_000,
    });
    const result = await search({ router });
    expect(result.candidates).toHaveLength(0);
    expect(result.search.attempts.every((attempt) => attempt.outcome === 'not_a_loop')).toBe(true);
  });

  it('refuses a candidate that wanders outside the radius the search is allowed', async () => {
    const { router } = fakeRouter({
      lineFor: () => [origin, destinationPoint(origin, 45, 9_000), origin],
      distanceFor: () => 5_000,
    });
    const result = await search({ router, target: 5_000 });
    expect(result.candidates).toHaveLength(0);
    expect(
      result.search.attempts.every((attempt) => attempt.outcome === 'outside_search_area'),
    ).toBe(true);
  });

  it('keeps every locked waypoint in every candidate it asks for', async () => {
    const locked: CourseWaypoint = {
      role: 'via',
      position: destinationPoint(origin, 30, 600),
      name: '고정',
      sourceSampleId: null,
      locked: true,
    };
    const unlocked: CourseWaypoint = {
      role: 'via',
      position: destinationPoint(origin, 200, 600),
      name: null,
      sourceSampleId: null,
      locked: false,
    };
    const { router, calls } = fakeRouter({ distanceFor: () => 5_000 });
    const result = await search({
      router,
      waypoints: waypointList([locked, unlocked]),
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.waypoints).toContainEqual(locked.position);
    // The unlocked one is not a pin: the search is free to replace it.
    for (const call of calls) expect(call.waypoints).not.toContainEqual(unlocked.position);
    for (const candidate of result.candidates) {
      expect(candidate.waypoints.some((waypoint) => waypoint.locked)).toBe(true);
      expect(candidate.waypoints[0]?.role).toBe('start');
      expect(candidate.waypoints.at(-1)?.role).toBe('finish');
      // The closing point is a generated return, not the observation the start came from.
      expect(candidate.waypoints.at(-1)?.sourceSampleId).toBeNull();
    }
  });

  it('refuses a finish pinned somewhere other than the start, rather than dropping it', async () => {
    // It used to disappear: the lock collection read `slice(1, -1)`, which never looks at
    // the finish, and every candidate was built with a finish nobody asked for.
    const lockedFinish: CourseWaypoint = {
      role: 'finish',
      position: destinationPoint(origin, 45, 600),
      name: '고정 끝',
      sourceSampleId: null,
      locked: true,
    };
    const { router, calls } = fakeRouter({ distanceFor: () => 5_000 });
    await expect(
      search({
        router,
        waypoints: [
          { role: 'start', position: origin, name: null, sourceSampleId: '0:0', locked: false },
          lockedFinish,
        ],
      }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_LOCKED_FINISH_NOT_A_LOOP' });
    expect(calls).toHaveLength(0);
  });

  it('keeps a finish pinned at the start exactly as the owner left it', async () => {
    const lockedFinish: CourseWaypoint = {
      role: 'finish',
      position: origin,
      name: '고정 끝',
      sourceSampleId: '0:4',
      locked: true,
    };
    const { router } = fakeRouter({ distanceFor: () => 5_000 });
    const result = await search({
      router,
      waypoints: [
        { role: 'start', position: origin, name: null, sourceSampleId: '0:0', locked: false },
        lockedFinish,
      ],
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      const finish = candidate.waypoints.at(-1);
      expect(finish?.locked).toBe(true);
      expect(finish?.name).toBe('고정 끝');
      expect(finish?.sourceSampleId).toBe('0:4');
    }
  });

  it('refuses a search whose pinned waypoints already exceed the target', async () => {
    const locked: CourseWaypoint = {
      role: 'via',
      // Inside the radius the search may cover, but a round trip through it is already
      // longer than the target allows. The two refusals are different facts.
      position: destinationPoint(origin, 0, 900),
      name: null,
      sourceSampleId: null,
      locked: true,
    };
    const { router, calls } = fakeRouter();
    await expect(
      search({ router, target: 1_000, waypoints: waypointList([locked]) }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_LOCKED_WAYPOINTS_EXCEED_TARGET' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a pinned waypoint outside the area the search may cover', async () => {
    const locked: CourseWaypoint = {
      role: 'via',
      position: destinationPoint(origin, 0, 30_000),
      name: null,
      sourceSampleId: null,
      locked: true,
    };
    const { router, calls } = fakeRouter();
    await expect(
      search({ router, target: 5_000, waypoints: waypointList([locked]) }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_LOCKED_WAYPOINT_OUTSIDE_SEARCH_AREA' });
    expect(calls).toHaveLength(0);
  });

  it('refuses more pinned waypoints than a candidate could carry', async () => {
    const locked = Array.from({ length: 10 }, (_, index) => ({
      role: 'via' as const,
      position: destinationPoint(origin, index * 30, 20),
      name: null,
      sourceSampleId: null,
      locked: true,
    }));
    const { router, calls } = fakeRouter();
    await expect(
      generateTargetDistanceCandidates({
        requestId: 'req-1',
        draftRevision: 3,
        targetDistanceMeters: 5_000,
        searchSeed: '00112233445566aa',
        // Built by hand: the waypoint list contract caps a course at 12, and this is the
        // separate question of how many of them a generated candidate can still carry.
        waypoints: [
          { role: 'start', position: origin, name: null, sourceSampleId: null, locked: false },
          ...locked,
          { role: 'finish', position: origin, name: null, sourceSampleId: null, locked: false },
        ],
        router,
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_TOO_MANY_LOCKED_WAYPOINTS' });
    expect(calls).toHaveLength(0);
  });

  it.each([[499], [50_001], [Number.NaN]])('refuses %p as a target distance', async (target) => {
    const { router, calls } = fakeRouter();
    await expect(search({ router, target })).rejects.toBeInstanceOf(CandidateSearchError);
    expect(calls).toHaveLength(0);
  });

  it('never reports a fact it has no data for as satisfied', async () => {
    const { router } = fakeRouter({ distanceFor: () => 5_000 });
    const result = await search({ router });
    for (const candidate of result.candidates) {
      expect(candidate.evaluation.knowledge).toEqual({
        stairs: 'unknown',
        surface: 'unknown',
        nightAccess: 'unknown',
        accessRestrictions: 'unknown',
        gradient: 'unknown',
      });
      expect(candidate.evaluation.gradientSource).toBe('none');
      expect(candidate.evaluation.connectivity).toBe('engine-attested-edges');
      expect(candidate.evaluation.evaluationVersion).toBe(1);
    }
  });

  it('keeps the target error and the two distances apart', async () => {
    const { router } = fakeRouter({ distanceFor: () => 4_600 });
    const result = await search({ router, target: 5_000 });
    const evaluation = result.candidates[0]?.evaluation;
    expect(evaluation).toBeDefined();
    expect(evaluation?.engineDistanceMeters).toBe(4_600);
    expect(evaluation?.targetDistanceMeters).toBe(5_000);
    expect(evaluation?.distanceErrorMeters).toBe(-400);
    expect(evaluation?.distanceErrorRatio).toBeCloseTo(-0.08, 10);
    // The stored line's own length is measured from its vertices and is a different value.
    expect(evaluation?.plannedLineMeters).not.toBe(4_600);
  });
});

describe('measuring one candidate', () => {
  it('reports a full out-and-back as half the line repeated', () => {
    const out = [
      origin,
      destinationPoint(origin, 0, 200),
      destinationPoint(origin, 0, 400),
      destinationPoint(origin, 0, 600),
    ];
    const line = [...out, ...out.slice(0, -1).reverse()];
    const measured = repeatedSection(line);
    expect(measured.repeatedRatio).toBeCloseTo(0.5, 2);
    expect(measured.outAndBack).toBe(true);
    expect(measured.repeatedMeters).toBeGreaterThan(590);
  });

  it('reports a loop that comes back on itself only where it rejoins', () => {
    const loop = [
      origin,
      destinationPoint(origin, 0, 400),
      destinationPoint(origin, 120, 400),
      destinationPoint(origin, 240, 400),
      origin,
    ];
    const measured = repeatedSection(loop);
    // Not zero, and not pretended to be: a closed loop really does cover the ground where
    // it rejoins itself twice. It is one grid cell out of a kilometre of walking.
    expect(measured.repeatedMeters).toBeLessThan(15);
    expect(measured.repeatedRatio).toBeLessThan(0.02);
    expect(measured.outAndBack).toBe(false);
  });

  it('measures the same walk the same way however its vertices are split', () => {
    // The engine chooses where to put vertices; the walk is the same either way. Keying
    // adjacent vertex pairs made `A → B` and `A → mid → B` share nothing at all.
    const far = destinationPoint(origin, 90, 400);
    const mid = destinationPoint(origin, 90, 200);
    const quarter = destinationPoint(origin, 90, 100);
    // Well above the duplicate threshold, which is the decision this feeds: the same walk
    // under two splits is one proposal, not two. It is not exactly 1 because the sampling
    // attributes a piece to the cell of its middle, and the splits divide differently.
    for (const split of [
      [origin, mid, far],
      [origin, quarter, mid, far],
    ]) {
      const overlap = shapeOverlapRatio([origin, far], split);
      expect(overlap).toBeGreaterThan(0.95);
      expect(overlap).toBeGreaterThanOrEqual(targetDistanceLimits.duplicateOverlapRatio);
    }
    expect(traversedCells([origin, far]).size).toBe(traversedCells([origin, mid, far]).size);
  });

  it('sees an out-and-back that returns through an extra vertex', () => {
    const far = destinationPoint(origin, 90, 400);
    const mid = destinationPoint(origin, 90, 200);
    const measured = repeatedSection([origin, far, mid, origin]);
    expect(measured.repeatedRatio).toBeCloseTo(0.5, 1);
    expect(measured.outAndBack).toBe(true);
  });

  it('calls a line identical to itself, and nothing to a line somewhere else', () => {
    const a = [
      origin,
      destinationPoint(origin, 0, 400),
      destinationPoint(origin, 120, 400),
      origin,
    ];
    const far = destinationPoint(origin, 90, 20_000);
    const b = [far, destinationPoint(far, 0, 400), destinationPoint(far, 120, 400), far];
    expect(shapeOverlapRatio(a, a)).toBeCloseTo(1, 6);
    expect(shapeOverlapRatio(a, b)).toBe(0);
    // Reversing a line is the same ground, which is what stops one loop being offered twice.
    expect(shapeOverlapRatio(a, [...a].reverse())).toBeCloseTo(1, 6);
  });

  it('lands where the bearing and the distance say it should', () => {
    const point = destinationPoint(origin, 90, 1_000);
    expect(greatCircleMeters(origin, point)).toBeCloseTo(1_000, 3);
    expect(point[1]).toBeCloseTo(origin[1], 4);
    expect(point[0]).toBeGreaterThan(origin[0]);
  });
});

describe('what a picked candidate records', () => {
  it('carries the search that produced it and no coordinate at all', async () => {
    const { router } = fakeRouter({ distanceFor: () => 5_000 });
    const result = await search({ router, seed: 'feedfacefeedface' });
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    const generation = targetDistanceGeneration({
      computation: candidate.computation,
      coordinates: candidate.coordinates,
      waypoints: candidate.waypoints,
      engineDistanceMeters: candidate.engineDistanceMeters,
      engineDurationSeconds: candidate.engineDurationSeconds,
      snappedWaypoints: candidate.snappedWaypoints,
      targetDistanceMeters: 5_000,
      searchSeed: 'feedfacefeedface',
      candidateSeed: candidate.candidateSeed,
      attemptIndex: candidate.attemptIndex,
      evaluation: candidate.evaluation,
    });
    const parsed = courseGenerationSchema.parse(generation);
    expect(parsed.kind).toBe('target-distance-loop');
    if (parsed.kind !== 'target-distance-loop') return;
    expect(parsed.searchSeed).toBe('feedfacefeedface');
    expect(parsed.candidateSeed).toBe(deriveCandidateSeed('feedfacefeedface', parsed.attemptIndex));
    expect(parsed.generatorVersion).toBe('target-distance-loop-v1');
    expect(parsed.computation.graph.graphBuildId).toBe('0123456789abcdef');
    // The account export carries generation conditions verbatim. A coordinate in here would
    // leak positions out of an export that deliberately omits them.
    const serialised = JSON.stringify(parsed);
    for (const position of candidate.coordinates)
      expect(serialised).not.toContain(String(position[0]));
    expect(serialised).not.toContain(String(origin[1]));
  });

  it('refuses conditions that describe a different number of waypoints', async () => {
    const { router } = fakeRouter({ distanceFor: () => 5_000 });
    const result = await search({ router });
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(() =>
      targetDistanceGeneration({
        computation: computationFor(2),
        coordinates: candidate.coordinates,
        waypoints: candidate.waypoints,
        engineDistanceMeters: candidate.engineDistanceMeters,
        engineDurationSeconds: candidate.engineDurationSeconds,
        snappedWaypoints: candidate.snappedWaypoints,
        targetDistanceMeters: 5_000,
        searchSeed: '00112233445566aa',
        candidateSeed: candidate.candidateSeed,
        attemptIndex: candidate.attemptIndex,
        evaluation: candidate.evaluation,
      }),
    ).toThrow(CandidateSearchError);
  });

  it('refuses a snap report that does not cover every waypoint', async () => {
    const { router } = fakeRouter({ distanceFor: () => 5_000 });
    const result = await search({ router });
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(() =>
      targetDistanceGeneration({
        computation: candidate.computation,
        coordinates: candidate.coordinates,
        waypoints: candidate.waypoints,
        engineDistanceMeters: candidate.engineDistanceMeters,
        engineDurationSeconds: candidate.engineDurationSeconds,
        snappedWaypoints: candidate.snappedWaypoints.slice(1),
        targetDistanceMeters: 5_000,
        searchSeed: '00112233445566aa',
        candidateSeed: candidate.candidateSeed,
        attemptIndex: candidate.attemptIndex,
        evaluation: candidate.evaluation,
      }),
    ).toThrow(CandidateSearchError);
  });
});

describe('the search never invents a line', () => {
  it('asks the engine for every leg and builds nothing of its own', async () => {
    const route = vi.fn(async () => ({
      kind: 'refused' as const,
      outcome: 'no_route' as const,
      computation: computationFor(4),
    }));
    const result = await search({ router: { route } });
    expect(result.candidates).toHaveLength(0);
    // Not one answer came back, and not one line was produced. A straight line between the
    // generated points is not an outcome this module can reach.
    expect(route).toHaveBeenCalledTimes(targetDistanceLimits.maxAttempts);
  });
});
