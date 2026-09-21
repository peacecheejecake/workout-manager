import { idSchema, instantSchema, revisionSchema } from './primitives.js';
import { z } from 'zod';

/**
 * Internal pedestrian routing contract (M2-01g).
 *
 * A planned route is not a recorded track and not a training actual. Nothing here
 * references an Activity, and a computed geometry is never an actual performance.
 * The engine answering is also not evidence that a way is walkable, accessible or
 * safe: that judgement belongs to the Korean coverage review, which is separate.
 *
 * This module describes the internal API between our own server and our own routing
 * adapter. Users never supply an engine URL; the engine endpoint is operations
 * configuration only.
 */

/**
 * Hard bounds for one internal routing request. Every one of these is enforced by the
 * server before the engine is called, or by the adapter on the engine's answer.
 */
export const routingLimits = {
  /** Fewest waypoints that can describe a route. */
  minWaypoints: 2,
  /** Waypoints in one request, start and end included. */
  maxWaypoints: 12,
  /** Straight-line distance between two consecutive waypoints. */
  maxLegStraightLineMeters: 30_000,
  /** Sum of the straight-line legs of one request. */
  maxRequestStraightLineMeters: 100_000,
  /** Route distance the engine may report before the answer is refused. */
  maxRouteDistanceMeters: 250_000,
  /** Vertices in one returned route geometry. */
  maxResponsePoints: 20_000,
  /** How far a waypoint may be moved onto the network before the answer is refused. */
  maxSnapMeters: 120,
  /** Wall-clock budget for one computation, measured by the caller. */
  deadlineMilliseconds: 8_000,
  /**
   * Engine-side search budget sent with every request. Measured on GraphHopper 10.0:
   * exceeding it answers with a distinct error, unlike the server-config timeout.
   */
  maxEngineVisitedNodes: 1_000_000,
  /** Concurrent computations one tenant may hold. */
  tenantConcurrency: 2,
  /** Computations one tenant may start inside {@link tenantWindowMilliseconds}. */
  tenantRequestsPerWindow: 20,
  tenantWindowMilliseconds: 60_000,
  /** Bytes of one engine response the adapter will read. */
  maxEngineResponseBytes: 4 * 1024 * 1024,
} as const;

/**
 * WGS84 `[longitude, latitude]`, exactly two finite dimensions. Deliberately its own
 * schema rather than a recorded-track position: a waypoint is planned input, not an
 * observation, and it carries no time, heart rate or elevation.
 */
export const routingPositionSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export type RoutingPosition = z.infer<typeof routingPositionSchema>;

/** One engine build. Adding an engine is a contract change, not a configuration flag. */
export const routingEngineIdSchema = z.literal('graphhopper');
/** One pinned pedestrian profile. The id changes whenever the profile changes. */
export const routingProfileIdSchema = z.literal('foot-v1');

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest');

/**
 * Identity of the engine, profile and graph that actually answered. A stored route is
 * only comparable to another route computed from the same identity; a route computed on
 * an older graph is never silently recomputed on a newer one.
 */
export const routingGraphIdentitySchema = z.strictObject({
  engine: routingEngineIdSchema,
  /**
   * `engine` means the running engine reported these facts in this computation;
   * `pinned` means the engine was never reached (refused before the call) and the
   * fields below are operations configuration, not observations.
   */
  identitySource: z.enum(['engine', 'pinned']),
  /** Read from the running engine, not from a constant. `null` when it did not report one. */
  engineVersion: z.string().min(1).max(64).nullable(),
  /** SHA-256 of the engine artifact pinned in the operations allowlist. */
  engineArtifactSha256: sha256Schema,
  profileId: routingProfileIdSchema,
  /** SHA-256 of the profile configuration file the engine was started with. */
  profileConfigSha256: sha256Schema,
  /** SHA-256 of the OSM extract the graph was built from. */
  extractSha256: sha256Schema,
  /** Human label of the extract region. Not a coverage claim. */
  extractRegion: z.string().min(1).max(120),
  /**
   * Hash over the built graph files, recomputed from disk when the graph was loaded.
   * This is what ties the identity to the bytes the engine is serving rather than to a
   * value someone wrote in a configuration file.
   */
  graphContentSha256: sha256Schema,
  /**
   * Stable identity of this graph: derived from the graph manifest, which binds the
   * extract, profile, engine artifact, graph content and import timestamps together.
   */
  graphBuildId: z.string().regex(/^[0-9a-f]{16}$/, 'Expected a 16 character graph build id'),
  /** When the engine imported the graph, as the engine reports it. `null` when unobserved. */
  graphImportedAt: instantSchema.nullable(),
  /** Timestamp of the road data. Pinned in configuration and checked against the engine. */
  roadDataAt: instantSchema,
});
export type RoutingGraphIdentity = z.infer<typeof routingGraphIdentitySchema>;

/** The computation conditions. Stored with the result so it can be reproduced or refused. */
export const routeConditionsSchema = z.strictObject({
  profileId: routingProfileIdSchema,
  algorithm: z.literal('flexible'),
  /** Contraction hierarchies are disabled; the flexible path is what we query. */
  contractionHierarchies: z.literal(false),
  maxVisitedNodes: z.number().int().min(1).max(100_000_000),
  deadlineMilliseconds: z.number().int().min(1).max(600_000),
  snapLimitMeters: z.number().finite().min(1).max(10_000),
  waypointCount: z.number().int().min(2).max(routingLimits.maxWaypoints),
});
export type RouteConditions = z.infer<typeof routeConditionsSchema>;

/**
 * A warning never upgrades an outcome. It records something the reader must not assume
 * away — for example that an exhausted engine budget cannot be told apart from a
 * genuinely disconnected pair.
 */
export const routeWarningCodeSchema = z.enum([
  'no_route_may_be_engine_budget',
  'snap_distance_notable',
  'response_truncated_by_engine',
  'engine_version_unknown',
]);

/**
 * Everything a `RouteRevision` must persist about one computation. The adapter produces
 * it; persistence belongs to the course ledger (M2-01f/h), which is why nothing here is
 * a database row and no identifier is invented.
 */
export const routeComputationRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Caller-supplied id of this computation request. */
  requestId: idSchema.max(128),
  /** Revision of the draft the request was made from. A result only applies to this one. */
  requestRevision: revisionSchema,
  graph: routingGraphIdentitySchema,
  conditions: routeConditionsSchema,
  /** When the computation finished, from an injected clock. */
  computedAt: instantSchema,
  /** Wall-clock milliseconds the caller measured around the engine call. */
  computationMilliseconds: z.number().int().nonnegative().max(600_000),
  warnings: z.array(routeWarningCodeSchema).max(16),
});
export type RouteComputationRecord = z.infer<typeof routeComputationRecordSchema>;

export const walkingRouteRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: idSchema.max(128),
  requestRevision: revisionSchema,
  profileId: routingProfileIdSchema,
  waypoints: z
    .array(routingPositionSchema)
    .min(routingLimits.minWaypoints)
    .max(routingLimits.maxWaypoints),
});
export type WalkingRouteRequest = z.infer<typeof walkingRouteRequestSchema>;

/** Where a waypoint landed on the network, and how far it had to move to get there. */
export const snappedWaypointSchema = z.strictObject({
  requested: routingPositionSchema,
  snapped: routingPositionSchema,
  snapDistanceMeters: z.number().finite().nonnegative().max(1_000_000),
});

const computed = z.strictObject({
  outcome: z.literal('route_computed'),
  computation: routeComputationRecordSchema,
  geometry: z.strictObject({
    type: z.literal('LineString'),
    coordinates: z.array(routingPositionSchema).min(2).max(routingLimits.maxResponsePoints),
  }),
  /** Engine estimate along the computed line. Never a recorded or training distance. */
  distanceMeters: z.number().finite().positive().max(routingLimits.maxRouteDistanceMeters),
  /** Engine estimate of walking time. Never an actual duration. */
  durationSeconds: z
    .number()
    .finite()
    .nonnegative()
    .max(30 * 24 * 3600),
  snappedWaypoints: z.array(snappedWaypointSchema).min(2).max(routingLimits.maxWaypoints),
});

const failure = <Code extends string>(code: Code) =>
  z.strictObject({
    outcome: z.literal(code),
    computation: routeComputationRecordSchema,
  });

/**
 * Every way one computation can end. These are distinct on purpose: the plan requires
 * NoRoute, outside coverage, excessive snap, timeout and overload to be told apart, and
 * a failure must leave the caller's uncomputed draft intact. There is no fallback that
 * returns a straight line, and no outcome that means "we guessed".
 */
export const walkingRouteResultSchema = z.discriminatedUnion('outcome', [
  computed,
  /** The engine found both ends on the network but no walking connection between them. */
  failure('no_route'),
  /** At least one waypoint has no pedestrian network near it at all. */
  failure('outside_coverage'),
  /** A waypoint would have to move further onto the network than the limit allows. */
  failure('snap_too_far'),
  /** The caller's deadline elapsed. The engine may still be working; nothing is stored. */
  failure('timeout'),
  /** The caller cancelled. */
  failure('cancelled'),
  /** The tenant's rate or concurrency bound refused the request before the engine saw it. */
  failure('overloaded'),
  /** The engine's own search budget was exhausted. */
  failure('compute_budget_exceeded'),
  /** The engine is unreachable, unhealthy, or answered something unusable. */
  failure('engine_unavailable'),
  /**
   * The engine answered, but the answer violates the contract — for example a geometry
   * that is just the requested points joined by a straight line, which is the specific
   * fail-open shape this design refuses to report as success.
   */
  failure('engine_contract_violation'),
  /** The running graph is not the pinned one, so its answer is not comparable. */
  failure('graph_mismatch'),
]);
export type WalkingRouteResult = z.infer<typeof walkingRouteResultSchema>;
export type WalkingRouteOutcome = WalkingRouteResult['outcome'];
