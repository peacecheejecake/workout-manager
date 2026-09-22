import type { WalkingRouteResult } from '../../packages/contracts/src/routing.ts';
import { walkingRouteRequestSchema } from '../../packages/contracts/src/routing.ts';

/**
 * A deterministic walking-route port for the identity end-to-end harness.
 *
 * **This is not the routing engine.** M2-01g's adapter talks to a real GraphHopper build
 * whose graph is verified against a manifest on disk, and that build is not present in a
 * test environment. What this fixture exercises is everything on our side of the port: the
 * bounded endpoint, the proposal store, the review step, the explicit save, the
 * consumption of a proposal inside the revision transaction and the screens around them.
 * It says nothing about pedestrian coverage, snapping, or whether a real engine would find
 * a route — those live in the coverage evidence, which this deliberately does not touch.
 *
 * Two properties keep it honest as a fixture. Its graph identity is labelled as a fixture
 * rather than borrowing a real build id, so a record written from it is recognisable. And
 * the line it answers with is **not** the waypoints joined up: each leg is bent through an
 * offset midpoint, because a straight line between waypoints is precisely the shape the
 * design refuses to present as a computed route, and a fixture that produced one would
 * make an end-to-end test that accepted it look like a passing test.
 */
const graph = {
  engine: 'graphhopper',
  identitySource: 'engine',
  engineVersion: 'identity-e2e-fixture',
  engineArtifactSha256: 'a'.repeat(64),
  profileId: 'foot-v1',
  profileConfigSha256: 'b'.repeat(64),
  extractSha256: 'c'.repeat(64),
  extractRegion: 'identity-e2e fixture (not a real extract)',
  graphContentSha256: 'd'.repeat(64),
  graphBuildId: '0123456789abcdef',
  graphImportedAt: '2026-01-01T00:00:00.000Z',
  roadDataAt: '2026-01-01T00:00:00.000Z',
} as const;

function bentLeg(
  from: readonly [number, number],
  to: readonly [number, number],
): [number, number][] {
  const midpoint: [number, number] = [
    (from[0] + to[0]) / 2 + (to[1] - from[1]) * 0.15,
    (from[1] + to[1]) / 2 - (to[0] - from[0]) * 0.15,
  ];
  return [midpoint, [to[0], to[1]]];
}

const EARTH_RADIUS_METERS = 6_371_008.8;
function metresBetween(from: readonly [number, number], to: readonly [number, number]): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(to[1] - from[1]);
  const dLon = toRadians(to[0] - from[0]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from[1])) * Math.cos(toRadians(to[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function createFixtureWalkingRoutePort() {
  return {
    async compute(_athleteId: string, rawRequest: unknown) {
      const request = walkingRouteRequestSchema.parse(rawRequest);
      const coordinates: [number, number][] = [
        [request.waypoints[0]?.[0] ?? 0, request.waypoints[0]?.[1] ?? 0],
      ];
      for (let index = 1; index < request.waypoints.length; index += 1) {
        const from = request.waypoints[index - 1];
        const to = request.waypoints[index];
        if (!from || !to) continue;
        coordinates.push(...bentLeg(from, to));
      }
      let distanceMeters = 0;
      for (let index = 1; index < coordinates.length; index += 1) {
        const previous = coordinates[index - 1];
        const current = coordinates[index];
        if (previous && current) distanceMeters += metresBetween(previous, current);
      }
      const result: WalkingRouteResult = {
        outcome: 'route_computed',
        computation: {
          schemaVersion: 1,
          requestId: request.requestId,
          requestRevision: request.requestRevision,
          graph,
          conditions: {
            profileId: 'foot-v1',
            algorithm: 'flexible',
            contractionHierarchies: false,
            maxVisitedNodes: 1_000_000,
            deadlineMilliseconds: 8_000,
            snapLimitMeters: 120,
            waypointCount: request.waypoints.length,
          },
          computedAt: new Date().toISOString(),
          computationMilliseconds: 1,
          warnings: [],
        },
        geometry: { type: 'LineString', coordinates },
        distanceMeters: Math.max(distanceMeters, 1),
        durationSeconds: Math.round(Math.max(distanceMeters, 1) / 1.4),
        snappedWaypoints: request.waypoints.map((waypoint) => ({
          requested: waypoint,
          snapped: waypoint,
          snapDistanceMeters: 0,
        })),
      };
      return { result, retryAfterSeconds: null };
    },
  };
}
