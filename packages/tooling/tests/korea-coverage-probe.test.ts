import { describe, expect, it } from 'vitest';

import {
  checkRouteTags,
  decodeOpl,
  indexNodes,
  indexSegments,
  pedestrianAccess,
  type TagIndex,
  type TaggedNode,
  type TaggedWay,
} from '../../../scripts/routing-tag-check';

/**
 * M2-01ay: the coverage probe's tag check, on synthetic geometry.
 *
 * The M0-06b review disqualified FRY-03 for 28.6 m of `foot=no` on Gangbyeonbuk-ro, a trunk road
 * beside the route: the geometric match counts a route segment as on a way when its midpoint is
 * within 1.5 m of it and parallel. And it disqualified ACC-PRV-01 for a gate tagged
 * `access=no` + `foot=yes`, counted as a restricted node whatever its foot value. The probe now
 * reads the ways under a route from the engine's own `osm_way_id` detail and reports the
 * pedestrian access of each node.
 */
const route: [number, number][] = [
  [127.0, 37.5],
  [127.0005, 37.5],
  [127.001, 37.5],
];
/** About 1 m north of the route and parallel to it: a separate carriageway. */
const trunkBeside: TaggedWay = {
  id: 'w37395728',
  tags: { highway: 'trunk', foot: 'no', bridge: 'yes', name: 'Gangbyeonbuk-ro' },
  coordinates: [
    [126.9995, 37.500009],
    [127.0015, 37.500009],
  ],
};
const gate = (tags: Record<string, string>): TaggedNode => ({
  id: 'n1',
  tags: { barrier: 'gate', ...tags },
  position: [127.0005, 37.5],
});
const tagIndex = (nodes: TaggedNode[]): TagIndex => ({
  ways: [trunkBeside],
  nodes,
  areas: [],
  statistics: {},
});

function check(nodes: TaggedNode[], engineWays: Parameters<typeof checkRouteTags>[4]) {
  const index = tagIndex(nodes);
  return checkRouteTags(
    route,
    index,
    indexSegments(index.ways),
    indexNodes(index.nodes),
    engineWays,
  );
}

describe('the coverage probe tag check (M2-01ay)', () => {
  it('matched a parallel foot=no way by geometry, and does not with the engine way ids', () => {
    // Before M2-01ay (and still on a graph without osm_way_id): the parallel trunk counts.
    const geometric = check([], null);
    expect(geometric.wayMatchMethod).toBe('geometric');
    expect(geometric.summary.footNoMeters).toBeGreaterThan(80);

    // The engine says the route is one footway: the trunk beside it is not under the route.
    const exact = check([], {
      ways: [{ wayId: 1001, meters: 88.4 }],
      tags: new Map([[1001, { highway: 'footway', bridge: 'yes', layer: '1' }]]),
    });
    expect(exact.wayMatchMethod).toBe('engine-way-ids');
    expect(exact.summary.footNoMeters).toBe(0);
    // A bridge the route really uses is listed, so a reviewer can see which crossing it took.
    expect(exact.waysAlongRoute).toEqual([
      {
        wayId: 'w1001',
        accessClass: null,
        tags: { highway: 'footway', bridge: 'yes', layer: '1' },
        metersAlongRoute: 88.4,
      },
    ]);
  });

  it('refuses an engine way the extract does not have', () => {
    expect(() => check([], { ways: [{ wayId: 7, meters: 1 }], tags: new Map() })).toThrow(
      'ENGINE_WAY_NOT_IN_EXTRACT: w7',
    );
  });

  it('tells a gate open to pedestrians from one closed to them', () => {
    const open = check([gate({ access: 'no', foot: 'yes' })], null).summary;
    expect(open).toMatchObject({
      restrictedNodesPassed: 1,
      footRestrictedNodesPassed: 0,
      accessRestrictedNodesWithFootOverridePassed: 1,
    });
    const closed = check([gate({ access: 'private' })], null).summary;
    expect(closed).toMatchObject({
      restrictedNodesPassed: 1,
      footRestrictedNodesPassed: 1,
      accessRestrictedNodesWithFootOverridePassed: 0,
    });
    expect(pedestrianAccess({ foot: 'no', access: 'yes' })).toBe('restricted');
    expect(pedestrianAccess({ access: 'no', foot: 'yes' })).toBe(
      'foot-overrides-restrictive-access',
    );
    expect(pedestrianAccess({ access: 'destination' })).toBe('not-restricted');
  });

  it('decodes OSM tag values from OPL', () => {
    expect(decodeOpl('%bc18%%d3ec%%b300%%b85c%')).toBe('반포대로');
    expect(decodeOpl('Mo-Su%20%10:00-20:27')).toBe('Mo-Su 10:00-20:27');
  });
});
