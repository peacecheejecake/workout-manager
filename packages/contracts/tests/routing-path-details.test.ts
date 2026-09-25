import { describe, expect, it } from 'vitest';
import { pathDetailsCoverGeometry, walkingRouteResultSchema } from '../src/routing';

const computed = {
  outcome: 'route_computed',
  computation: {
    schemaVersion: 1,
    requestId: 'req-1',
    requestRevision: 1,
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
      waypointCount: 2,
    },
    computedAt: '2026-03-02T00:00:00.000Z',
    computationMilliseconds: 12,
    warnings: [],
  },
  geometry: {
    type: 'LineString',
    coordinates: [
      [126.97, 37.56],
      [126.971, 37.56],
      [126.972, 37.56],
    ],
  },
  distanceMeters: 180,
  durationSeconds: 130,
  snappedWaypoints: [
    { requested: [126.97, 37.56], snapped: [126.97, 37.56], snapDistanceMeters: 0 },
    { requested: [126.972, 37.56], snapped: [126.972, 37.56], snapDistanceMeters: 0 },
  ],
  pathDetails: {
    roadClass: [
      [0, 1, 'steps'],
      [1, 2, 'footway'],
    ],
    roadAccess: [[0, 2, 'private']],
    footAccess: [[0, 2, true]],
    surface: null,
  },
};

describe('path details of a computed route (M2-01ap)', () => {
  it('carries each detail the engine reported, and null for one it did not', () => {
    expect(walkingRouteResultSchema.parse(computed)).toEqual(computed);
  });

  it('refuses details that do not cover the geometry from its first vertex to its last', () => {
    for (const roadAccess of [
      [[0, 1, 'private']],
      [
        [0, 1, 'private'],
        [2, 2, 'yes'],
      ],
      [[1, 2, 'private']],
      [[0, 3, 'private']],
    ])
      expect(
        walkingRouteResultSchema.safeParse({
          ...computed,
          pathDetails: { ...computed.pathDetails, roadAccess },
        }).success,
      ).toBe(false);
  });

  it('always has a road class, and refuses values of the wrong kind', () => {
    for (const pathDetails of [
      { ...computed.pathDetails, roadClass: null },
      { ...computed.pathDetails, footAccess: [[0, 2, 'yes']] },
      { ...computed.pathDetails, roadAccess: [[0, 2, 'Private Road']] },
    ])
      expect(walkingRouteResultSchema.safeParse({ ...computed, pathDetails }).success).toBe(false);
    const withoutDetails: Record<string, unknown> = { ...computed };
    delete withoutDetails['pathDetails'];
    expect(walkingRouteResultSchema.safeParse(withoutDetails).success).toBe(false);
  });

  it('checks coverage as one contiguous run', () => {
    expect(pathDetailsCoverGeometry([[0, 2, 'x']], 3)).toBe(true);
    expect(pathDetailsCoverGeometry([], 3)).toBe(false);
    expect(pathDetailsCoverGeometry([[0, 2, 'x']], 1)).toBe(false);
  });
});
