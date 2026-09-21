import {
  routingLimits,
  walkingRouteResultSchema,
  type RouteComputationRecord,
  type RoutingGraphIdentity,
  type RoutingPosition,
  type WalkingRouteRequest,
  type WalkingRouteResult,
} from '@workout/contracts/routing';
import { z } from 'zod';

import { haversineMeters, polylineLengthMeters } from './geo.js';
import { assertVerifiedDeployment, type RoutingDeployment } from './deployment.js';
import { graphBuildIdFromManifest, type RoutingGraphManifest } from './graph-manifest.js';
import { RoutingTransportError, type RoutingEngineTransport } from './transport.js';

/**
 * Adapter for the self-hosted GraphHopper open-source engine (selected in M2-01d).
 *
 * WHAT "A STRAIGHT LINE IS NEVER A SUCCESS" MEANS HERE, EXACTLY.
 *
 * A fallback straight line is not a shape, it is an answer with no edges behind it. The
 * failure that disqualified OSRM was HTTP 200 with the two requested points and 0 m: no
 * network was traversed and none was claimed. So this adapter refuses an answer unless
 * the engine attests the edges it traversed:
 *
 * - `details.road_class` must cover the geometry as contiguous intervals from the first
 *   vertex to the last ({@link edgeDetailsCoverGeometry}). GraphHopper can only produce
 *   these from graph edges, so an answer that joined the requested points has nothing to
 *   report them from.
 * - The geometry must begin at the first snapped waypoint, end at the last and pass
 *   through the rest in the requested order ({@link geometryVisitsWaypointsInOrder}).
 * - The reported distance must agree with the geometry it came with
 *   ({@link distanceMatchesGeometry}), and be positive.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: whether the line looks straight. An earlier version
 * refused a geometry that stayed within 1 m of the chord over more than 200 m. Measured
 * against the real Seoul graph, that rule was wrong in both directions. It rejected real
 * routes — a single `cycleway` chain of 552.1 m with 0.742 m maximum deviation, and a
 * 169.9 m `residential` road returned as exactly two vertices are both legitimate answers
 * from this graph — while a fabricated straight line under the threshold, or one bowed by
 * a couple of metres, passed. Straightness does not separate a real network line from a
 * fabricated one; edge attestation does.
 *
 * THE LIMIT, STATED PLAINLY: every check above reads the engine's own bookkeeping. An
 * engine that fabricates edge intervals consistent with a line it invented will pass.
 * Nothing here is an independent check against the map, and this adapter does not claim
 * to detect a dishonest engine — only an engine that answers without traversing edges,
 * answers about somewhere else, or contradicts itself.
 *
 * A computed route is also not coverage. It says a graph had edges, not that a person can
 * walk there.
 */
/**
 * Identity the adapter holds the engine to. Internal on purpose: it is derived from a
 * {@link RoutingDeployment}, which can only be obtained by verifying files on disk, so
 * there is no exported way to assert an identity the process has not checked.
 */
interface PinnedGraph {
  readonly engineVersion: string;
  readonly engineArtifactSha256: string;
  readonly profileConfigSha256: string;
  readonly extractSha256: string;
  readonly extractRegion: string;
  readonly graphContentSha256: string;
  /** Import timestamp recorded inside the graph; the engine must report exactly this. */
  readonly graphImportedAt: string;
  readonly roadDataAt: string;
  readonly engineProfileName: string;
  readonly graphBuildId: string;
}

function pinnedGraphFromManifest(manifest: RoutingGraphManifest): PinnedGraph {
  return {
    engineVersion: manifest.engineVersion,
    engineArtifactSha256: manifest.engineArtifactSha256,
    profileConfigSha256: manifest.profileConfigSha256,
    extractSha256: manifest.extractSha256,
    extractRegion: manifest.extractRegion,
    graphContentSha256: manifest.graphContentSha256,
    graphImportedAt: manifest.graphImportedAt,
    roadDataAt: manifest.roadDataAt,
    engineProfileName: manifest.profileName,
    graphBuildId: graphBuildIdFromManifest(manifest),
  };
}

export interface RoutingClock {
  now(): Date;
}

export interface RoutingComputeContext {
  /** Caller cancellation. Aborting it ends the computation as `cancelled`. */
  readonly signal?: AbortSignal;
}

export interface GraphHopperAdapterOptions {
  /** The verified deployment. It carries both the identity and the transport to reach it. */
  readonly deployment: RoutingDeployment;
  readonly clock: RoutingClock;
  readonly deadlineMilliseconds?: number;
  readonly maxVisitedNodes?: number;
  readonly snapLimitMeters?: number;
}

const positionSchema = z
  .array(z.number().finite())
  .min(2)
  .max(3)
  .transform((value): RoutingPosition => [value[0] ?? 0, value[1] ?? 0]);
const lineSchema = z.object({ coordinates: z.array(positionSchema) });
const engineInfoSchema = z.object({
  version: z.string().min(1).max(64).nullish(),
  profiles: z.array(z.object({ name: z.string() })),
  import_date: z.string().min(1).max(64),
  data_date: z.string().min(1).max(64),
});
/**
 * `[fromVertex, toVertex, value]` intervals over the returned geometry. GraphHopper can
 * only produce these from the edges it actually traversed, so their presence and their
 * exact coverage of the geometry is the adapter's evidence that the line follows the
 * graph rather than being drawn between the requested points.
 */
const detailIntervalSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.union([z.string().min(1).max(64), z.number(), z.boolean()]),
]);
const enginePathSchema = z.object({
  distance: z.number().finite(),
  time: z.number().finite(),
  points: lineSchema,
  snapped_waypoints: lineSchema,
  details: z.object({ road_class: z.array(detailIntervalSchema) }),
});
const engineRouteSchema = z.object({ paths: z.array(enginePathSchema).min(1) });
const engineErrorSchema = z.object({
  message: z.string().max(2000).nullish(),
  hints: z
    .array(z.object({ details: z.string().max(200).nullish() }))
    .max(64)
    .nullish(),
});

type FailureOutcome = Exclude<WalkingRouteResult['outcome'], 'route_computed'>;
type Warning = RouteComputationRecord['warnings'][number];

function sameInstant(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

export class GraphHopperRoutingAdapter {
  readonly #transport: RoutingEngineTransport;
  readonly #pinned: PinnedGraph;
  readonly #clock: RoutingClock;
  readonly #deadlineMilliseconds: number;
  readonly #maxVisitedNodes: number;
  readonly #snapLimitMeters: number;

  constructor(options: GraphHopperAdapterOptions) {
    // Consumption is guarded, not just construction: a structurally identical object that
    // never went through verification is refused here rather than routed with.
    const deployment = assertVerifiedDeployment(options.deployment);
    this.#transport = deployment.transport;
    this.#pinned = pinnedGraphFromManifest(deployment.manifest);
    this.#clock = options.clock;
    this.#deadlineMilliseconds = options.deadlineMilliseconds ?? routingLimits.deadlineMilliseconds;
    this.#maxVisitedNodes = options.maxVisitedNodes ?? routingLimits.maxEngineVisitedNodes;
    this.#snapLimitMeters = options.snapLimitMeters ?? routingLimits.maxSnapMeters;
  }

  /** The identity used when the engine was never reached. Nothing here is an observation. */
  pinnedIdentity(): RoutingGraphIdentity {
    return {
      engine: 'graphhopper',
      identitySource: 'pinned',
      engineVersion: this.#pinned.engineVersion,
      engineArtifactSha256: this.#pinned.engineArtifactSha256,
      profileId: 'foot-v1',
      profileConfigSha256: this.#pinned.profileConfigSha256,
      extractSha256: this.#pinned.extractSha256,
      extractRegion: this.#pinned.extractRegion,
      graphContentSha256: this.#pinned.graphContentSha256,
      graphBuildId: this.#pinned.graphBuildId,
      graphImportedAt: null,
      roadDataAt: this.#pinned.roadDataAt,
    };
  }

  conditions(waypointCount: number): RouteComputationRecord['conditions'] {
    return {
      profileId: 'foot-v1',
      algorithm: 'flexible',
      contractionHierarchies: false,
      maxVisitedNodes: this.#maxVisitedNodes,
      deadlineMilliseconds: this.#deadlineMilliseconds,
      snapLimitMeters: this.#snapLimitMeters,
      waypointCount,
    };
  }

  /**
   * Ask the running engine who it is, on EVERY computation, and compare it to the
   * deployment this adapter was built for.
   *
   * There is no cache. A 60 s identity cache used to sit here and it made the guarantee
   * false: the engine could be swapped and the adapter would keep answering under the old
   * identity until the cache expired, because the check it skipped was the only place the
   * swap would have been seen. The cost of removing it is one extra loopback request per
   * computation, measured in single-digit milliseconds against a computation budget of
   * 8 s.
   *
   * The residual window, stated rather than hidden: the engine is asked who it is and
   * then asked to route, as two requests. A swap landing between those two would be
   * attributed to the identity read a few milliseconds earlier. Closing that needs the
   * route response itself to carry the graph identity, which this engine does not offer.
   */
  async #identity(
    signal: AbortSignal,
  ): Promise<
    { ok: true; identity: RoutingGraphIdentity } | { ok: false; outcome: FailureOutcome }
  > {
    let response;
    try {
      response = await this.#transport.get({
        path: '/info',
        query: new URLSearchParams(),
        signal,
        maxBytes: routingLimits.maxEngineResponseBytes,
      });
    } catch (error) {
      return { ok: false, outcome: transportOutcome(error, signal) };
    }
    if (response.status !== 200) return { ok: false, outcome: 'engine_unavailable' };
    let info;
    try {
      info = engineInfoSchema.parse(JSON.parse(response.bodyText));
    } catch {
      return { ok: false, outcome: 'engine_unavailable' };
    }
    if (typeof info.version !== 'string' || info.version !== this.#pinned.engineVersion)
      return { ok: false, outcome: 'graph_mismatch' };
    if (!info.profiles.some((profile) => profile.name === this.#pinned.engineProfileName))
      return { ok: false, outcome: 'graph_mismatch' };
    if (!sameInstant(info.data_date, this.#pinned.roadDataAt))
      return { ok: false, outcome: 'graph_mismatch' };
    const importedAt = new Date(info.import_date);
    if (!Number.isFinite(importedAt.getTime())) return { ok: false, outcome: 'graph_mismatch' };
    // Bound to the manifest the graph itself carries, not to a configured expectation.
    if (!sameInstant(info.import_date, this.#pinned.graphImportedAt))
      return { ok: false, outcome: 'graph_mismatch' };
    const identity: RoutingGraphIdentity = {
      ...this.pinnedIdentity(),
      identitySource: 'engine',
      engineVersion: info.version,
      graphImportedAt: importedAt.toISOString(),
    };
    return { ok: true, identity };
  }

  /**
   * One bounded computation. Never called inside a database transaction: this adapter has
   * no database handle and the caller holds none while it awaits.
   */
  async computeWalkingRoute(
    request: WalkingRouteRequest,
    context: RoutingComputeContext = {},
  ): Promise<WalkingRouteResult> {
    const startedAt = this.#clock.now().getTime();
    const callerSignal = context.signal;
    const controller = new AbortController();
    // Built by hand rather than with AbortSignal.any/timeout so the deadline cannot
    // quietly disappear on a runtime without them, and so the two reasons stay apart.
    let deadlineReached = false;
    const timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
    }, this.#deadlineMilliseconds);
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted === true) controller.abort();

    const record = (
      identity: RoutingGraphIdentity,
      warnings: Warning[],
    ): RouteComputationRecord => ({
      schemaVersion: 1,
      requestId: request.requestId,
      requestRevision: request.requestRevision,
      graph: identity,
      conditions: this.conditions(request.waypoints.length),
      computedAt: this.#clock.now().toISOString(),
      computationMilliseconds: Math.max(0, this.#clock.now().getTime() - startedAt),
      warnings,
    });
    /** Every result leaves this adapter validated against the published contract. */
    const failed = (
      outcome: FailureOutcome,
      identity: RoutingGraphIdentity,
      warnings: Warning[],
    ): WalkingRouteResult =>
      walkingRouteResultSchema.parse({ outcome, computation: record(identity, warnings) });

    try {
      const resolved = await this.#identity(controller.signal);
      if (!resolved.ok)
        return failed(
          reclassifyAbort(resolved.outcome, deadlineReached, callerSignal),
          this.pinnedIdentity(),
          [],
        );
      const identity = resolved.identity;
      const warnings: Warning[] = [];

      const query = new URLSearchParams({
        profile: this.#pinned.engineProfileName,
        'ch.disable': 'true',
        points_encoded: 'false',
        instructions: 'false',
        calc_points: 'true',
        elevation: 'false',
        // Requested so the answer can be checked against the edges it claims to use.
        details: 'road_class',
        max_visited_nodes: String(this.#maxVisitedNodes),
      });
      for (const [longitude, latitude] of request.waypoints)
        query.append('point', `${latitude},${longitude}`);

      let response;
      try {
        response = await this.#transport.get({
          path: '/route',
          query,
          signal: controller.signal,
          maxBytes: routingLimits.maxEngineResponseBytes,
        });
      } catch (error) {
        return failed(
          reclassifyAbort(
            transportOutcome(error, controller.signal),
            deadlineReached,
            callerSignal,
          ),
          identity,
          warnings,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(response.bodyText);
      } catch {
        return failed('engine_unavailable', identity, warnings);
      }

      if (response.status !== 200)
        return failed(
          this.#classifyEngineError(response.status, body, warnings),
          identity,
          warnings,
        );

      const parsed = engineRouteSchema.safeParse(body);
      if (!parsed.success) return failed('engine_contract_violation', identity, warnings);
      const path = parsed.data.paths[0];
      if (path === undefined) return failed('engine_contract_violation', identity, warnings);

      const coordinates = path.points.coordinates;
      const snapped = path.snapped_waypoints.coordinates;
      if (snapped.length !== request.waypoints.length)
        return failed('engine_contract_violation', identity, warnings);

      const snappedWaypoints = request.waypoints.map((requested, index) => {
        const landed = snapped[index] ?? requested;
        return {
          requested,
          snapped: landed,
          snapDistanceMeters: haversineMeters(requested, landed),
        };
      });
      const worstSnap = snappedWaypoints.reduce(
        (worst, entry) => Math.max(worst, entry.snapDistanceMeters),
        0,
      );
      if (worstSnap > this.#snapLimitMeters) return failed('snap_too_far', identity, warnings);
      if (worstSnap > this.#snapLimitMeters / 2) warnings.push('snap_distance_notable');

      const violation =
        coordinates.length < 2 ||
        coordinates.length > routingLimits.maxResponsePoints ||
        !(path.distance > 0) ||
        path.distance > routingLimits.maxRouteDistanceMeters ||
        !(path.time >= 0) ||
        !distanceMatchesGeometry(path.distance, coordinates) ||
        !geometryVisitsWaypointsInOrder(coordinates, snapped) ||
        !edgeDetailsCoverGeometry(path.details.road_class, coordinates.length);
      if (violation) return failed('engine_contract_violation', identity, warnings);

      const computed = walkingRouteResultSchema.safeParse({
        outcome: 'route_computed',
        computation: record(identity, warnings),
        geometry: { type: 'LineString', coordinates },
        distanceMeters: path.distance,
        durationSeconds: path.time / 1000,
        snappedWaypoints,
      });
      // The contract is the last gate: an answer that cannot be represented as a valid
      // result is a contract violation, not a route we store anyway.
      return computed.success
        ? computed.data
        : failed('engine_contract_violation', identity, warnings);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  #classifyEngineError(status: number, body: unknown, warnings: Warning[]): FailureOutcome {
    if (status === 429 || status === 503) return 'overloaded';
    const parsed = engineErrorSchema.safeParse(body);
    const details = parsed.success
      ? (parsed.data.hints ?? []).map((hint) => hint.details ?? '')
      : [];
    if (details.some((detail) => detail.endsWith('PointNotFoundException')))
      return 'outside_coverage';
    if (details.some((detail) => detail.endsWith('MaximumNodesExceededException')))
      return 'compute_budget_exceeded';
    if (details.some((detail) => detail.endsWith('ConnectionNotFoundException'))) {
      // Measured on GraphHopper 10.0: the engine answers ConnectionNotFound both for a
      // genuinely disconnected pair and for an exhausted server-side `routing.timeout_ms`.
      // The outcome stays `no_route`, but the ambiguity is recorded, never assumed away.
      warnings.push('no_route_may_be_engine_budget');
      return 'no_route';
    }
    if (status >= 500) return 'engine_unavailable';
    return 'engine_contract_violation';
  }
}

function transportOutcome(error: unknown, signal: AbortSignal): FailureOutcome {
  if (error instanceof RoutingTransportError) {
    if (error.code === 'ENGINE_ABORTED') return 'cancelled';
    if (error.code === 'ENGINE_RESPONSE_TOO_LARGE') return 'engine_contract_violation';
    return 'engine_unavailable';
  }
  return signal.aborted ? 'cancelled' : 'engine_unavailable';
}

/** An abort is only a cancellation when the caller asked; our own deadline is a timeout. */
function reclassifyAbort(
  outcome: FailureOutcome,
  deadlineReached: boolean,
  callerSignal: AbortSignal | undefined,
): FailureOutcome {
  if (outcome !== 'cancelled') return outcome;
  if (callerSignal?.aborted === true) return 'cancelled';
  return deadlineReached ? 'timeout' : 'cancelled';
}

/**
 * How far a returned geometry vertex may sit from the snapped waypoint it is supposed to
 * be. GraphHopper puts the snapped waypoints on the geometry exactly; 1 m leaves room for
 * coordinate rounding and nothing else.
 */
const WAYPOINT_ANCHOR_METERS = 1;

/**
 * The geometry must start at the first snapped waypoint, end at the last, and pass through
 * every waypoint in between IN THE REQUESTED ORDER.
 *
 * This is what rejects a geometry belonging to somewhere else entirely, or one whose legs
 * are reordered, even when the engine echoes the snapped waypoints correctly. Vertex count
 * and self-consistent distance cannot do that: both are properties of the line alone and
 * say nothing about where the line is relative to the request.
 */
export function geometryVisitsWaypointsInOrder(
  coordinates: readonly RoutingPosition[],
  snappedWaypoints: readonly RoutingPosition[],
): boolean {
  if (coordinates.length < 2 || snappedWaypoints.length < 2) return false;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  const firstWaypoint = snappedWaypoints[0];
  const lastWaypoint = snappedWaypoints[snappedWaypoints.length - 1];
  if (first === undefined || last === undefined) return false;
  if (firstWaypoint === undefined || lastWaypoint === undefined) return false;
  if (haversineMeters(first, firstWaypoint) > WAYPOINT_ANCHOR_METERS) return false;
  if (haversineMeters(last, lastWaypoint) > WAYPOINT_ANCHOR_METERS) return false;
  let cursor = 0;
  for (const waypoint of snappedWaypoints) {
    let found = -1;
    for (let index = cursor; index < coordinates.length; index += 1) {
      const vertex = coordinates[index];
      if (vertex === undefined) continue;
      if (haversineMeters(vertex, waypoint) <= WAYPOINT_ANCHOR_METERS) {
        found = index;
        break;
      }
    }
    if (found < 0) return false;
    cursor = found;
  }
  return cursor === coordinates.length - 1;
}

/**
 * Per-edge details must cover the whole geometry as contiguous intervals from the first
 * vertex to the last.
 *
 * This is the adapter's basis for believing the line follows the network. GraphHopper
 * derives these intervals from the graph edges it traversed, so a line drawn between the
 * requested points has nothing to report them from: a fabricated or straight-line answer
 * either omits them or cannot make them cover the geometry. It is evidence about the
 * engine's own bookkeeping, not an independent check of the map — an engine that lied
 * consistently would still pass, and this file says so rather than claiming proof.
 */
export function edgeDetailsCoverGeometry(
  intervals: readonly (readonly [number, number, unknown])[],
  vertexCount: number,
): boolean {
  if (vertexCount < 2 || intervals.length === 0) return false;
  let expected = 0;
  for (const interval of intervals) {
    const [from, to] = interval;
    if (from !== expected || to <= from || to > vertexCount - 1) return false;
    expected = to;
  }
  return expected === vertexCount - 1;
}

/**
 * The engine's reported distance must agree with the geometry it returned. A reported
 * distance that does not match its own line is not a route we can store.
 *
 * The tolerance is empirical: on a real GraphHopper 10.0 answer (Gwanghwamun to Seoul
 * City Hall, 43 vertices) the reported 1281.844 m differed from the great-circle length
 * of its own geometry by 0.013 m. 2 % or 10 m, whichever is larger, leaves room for a
 * different earth model without leaving room for an invented distance. On its own this
 * proves only internal consistency, which is why it is one check among several.
 */
export function distanceMatchesGeometry(
  reportedMeters: number,
  coordinates: readonly RoutingPosition[],
): boolean {
  const measured = polylineLengthMeters(coordinates);
  return Math.abs(reportedMeters - measured) <= Math.max(10, measured * 0.02);
}
