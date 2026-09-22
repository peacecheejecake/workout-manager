import {
  courseLimits,
  type CourseGeneration,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import type { RouteComputationRecord, RoutingPosition } from '@workout/contracts/routing';

/**
 * Turning one reviewed computation into the conditions a course revision keeps (M2-01h).
 *
 * M2-01g produces a {@link RouteComputationRecord} and deliberately stores nothing. This is
 * where that record becomes durable: the engine, profile and **graph identity** that
 * actually answered, the conditions it ran under, the request revision it belongs to and
 * the warnings it came with are written into the immutable revision alongside the geometry.
 * That is what makes "a stored course is never silently recomputed on a newer graph"
 * checkable at all — without it a saved course would not remember what computed it.
 *
 * No coordinate is copied in here. The line belongs to the revision's geometry and the
 * waypoints to its waypoint list; the conditions are the part the account export carries,
 * and it must stay free of positions.
 */
export class RoutedCourseError extends Error {
  constructor(
    readonly code:
      'ROUTE_WAYPOINT_COUNT_MISMATCH' | 'ROUTE_SNAP_WAYPOINT_MISMATCH' | 'ROUTE_GEOMETRY_TOO_SHORT',
  ) {
    super(code);
    this.name = 'RoutedCourseError';
  }
}

export interface RoutedCourseInput {
  readonly computation: RouteComputationRecord;
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly engineDistanceMeters: number;
  readonly engineDurationSeconds: number;
  readonly snappedWaypoints: readonly {
    readonly requested: RoutingPosition;
    readonly snapped: RoutingPosition;
    readonly snapDistanceMeters: number;
  }[];
}

/** Furthest any waypoint had to move onto the network. `0` when there were none to move. */
export function maxSnapDistanceMeters(
  snapped: readonly { readonly snapDistanceMeters: number }[],
): number {
  let furthest = 0;
  for (const waypoint of snapped) furthest = Math.max(furthest, waypoint.snapDistanceMeters);
  return furthest;
}

export function routedCourseGeneration(input: RoutedCourseInput): CourseGeneration {
  // The answer must be about the waypoints that were asked for. The adapter already checks
  // that the geometry visits them in order; this checks that the record, the list the
  // course will store and the snap report all describe the same number of them, so a
  // revision cannot claim conditions belonging to a different request.
  if (input.computation.conditions.waypointCount !== input.waypoints.length)
    throw new RoutedCourseError('ROUTE_WAYPOINT_COUNT_MISMATCH');
  if (input.snappedWaypoints.length !== input.waypoints.length)
    throw new RoutedCourseError('ROUTE_SNAP_WAYPOINT_MISMATCH');
  if (input.coordinates.length < 2 || input.coordinates.length > courseLimits.vertices)
    throw new RoutedCourseError('ROUTE_GEOMETRY_TOO_SHORT');
  return {
    kind: 'routed-waypoints',
    computation: input.computation,
    engineDistanceMeters: input.engineDistanceMeters,
    engineDurationSeconds: input.engineDurationSeconds,
    maxSnapDistanceMeters: maxSnapDistanceMeters(input.snappedWaypoints),
    waypointCount: input.waypoints.length,
    vertexCount: input.coordinates.length,
  };
}
