import type { CoursePosition } from '@workout/contracts/courses';

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two planned positions.
 *
 * `@workout/track-parsing` has the same formula for recorded positions, and this package
 * deliberately does not import it: that package is resolved as a bundler-style barrel, and
 * pulling it into a server package that `apps/api` type-checks under `node16` resolution
 * fails. The two are kept in step by a test that computes the same length both ways rather
 * than by a comment, so the copy cannot drift silently.
 */
export function greatCircleMeters(from: CoursePosition, to: CoursePosition): number {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * How close a straight course segment comes to one position, in metres.
 *
 * A course is a line, not a bag of points: two vertices can both sit outside a protected
 * area while the line between them runs straight through it. That case is invisible to a
 * per-vertex test, so the trim measures the segment itself.
 *
 * The projection is a local equirectangular one centred on `point`: distances are computed
 * in metres east/north of it, which is accurate well past the 5 km a protected area may
 * span. Longitude differences are wrapped, so a segment spanning the antimeridian is
 * measured the short way round rather than across the whole globe.
 */
export function segmentDistanceToPointMeters(
  from: CoursePosition,
  to: CoursePosition,
  point: CoursePosition,
): number {
  const metresPerDegreeLatitude = (Math.PI / 180) * EARTH_RADIUS_METERS;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos(toRadians(point[1]));
  const wrap = (degrees: number): number => ((((degrees + 180) % 360) + 360) % 360) - 180;
  const project = (position: CoursePosition): readonly [number, number] => [
    wrap(position[0] - point[0]) * metresPerDegreeLongitude,
    (position[1] - point[1]) * metresPerDegreeLatitude,
  ];
  const [ax, ay] = project(from);
  const [bx, by] = project(to);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  // A zero-length segment is just its endpoint.
  if (lengthSquared === 0) return Math.hypot(ax, ay);
  // Where the foot of the perpendicular falls, clamped to the segment.
  const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
