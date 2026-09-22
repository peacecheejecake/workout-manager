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
