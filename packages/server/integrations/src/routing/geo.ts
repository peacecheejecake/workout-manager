import type { RoutingPosition } from '@workout/contracts/routing';

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres. Used for request bounds and for checking how far a
 * waypoint was moved onto the network — never to produce a training distance, and never
 * to invent geometry between two points.
 */
export function haversineMeters(from: RoutingPosition, to: RoutingPosition): number {
  const [fromLongitude, fromLatitude] = from;
  const [toLongitude, toLatitude] = to;
  const deltaLatitude = toRadians(toLatitude - fromLatitude);
  const deltaLongitude = toRadians(toLongitude - fromLongitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(fromLatitude)) *
      Math.cos(toRadians(toLatitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Length of a polyline. Only used to check the engine's answer against its own geometry. */
export function polylineLengthMeters(coordinates: readonly RoutingPosition[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous === undefined || current === undefined) continue;
    total += haversineMeters(previous, current);
  }
  return total;
}

/** Sum of the straight-line legs between requested waypoints. A request bound, not a route. */
export function requestedSpanMeters(waypoints: readonly RoutingPosition[]): {
  readonly total: number;
  readonly longestLeg: number;
} {
  let total = 0;
  let longestLeg = 0;
  for (let index = 1; index < waypoints.length; index += 1) {
    const previous = waypoints[index - 1];
    const current = waypoints[index];
    if (previous === undefined || current === undefined) continue;
    const leg = haversineMeters(previous, current);
    total += leg;
    longestLeg = Math.max(longestLeg, leg);
  }
  return { total, longestLeg };
}

const METERS_PER_DEGREE_LATITUDE = 111_320;

/**
 * Perpendicular distance from `point` to the segment `a`-`b`, on a local planar
 * approximation. Distances here are hundreds of metres at most, where the approximation
 * is well inside the tolerances it is used with.
 */
export function perpendicularDistanceMeters(
  point: RoutingPosition,
  a: RoutingPosition,
  b: RoutingPosition,
): number {
  const scale = Math.cos(toRadians((a[1] + b[1]) / 2));
  const toPlane = (position: RoutingPosition): [number, number] => [
    (position[0] - a[0]) * METERS_PER_DEGREE_LATITUDE * scale,
    (position[1] - a[1]) * METERS_PER_DEGREE_LATITUDE,
  ];
  const [px, py] = toPlane(point);
  const [bx, by] = toPlane(b);
  const lengthSquared = bx * bx + by * by;
  if (lengthSquared === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared));
  return Math.hypot(px - t * bx, py - t * by);
}

/** How far the most off-line vertex strays from the chord between the two end vertices. */
export function maxDeviationFromChordMeters(coordinates: readonly RoutingPosition[]): number {
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first === undefined || last === undefined) return 0;
  let worst = 0;
  for (const coordinate of coordinates)
    worst = Math.max(worst, perpendicularDistanceMeters(coordinate, first, last));
  return worst;
}
