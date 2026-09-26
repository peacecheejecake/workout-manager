import { readFileSync } from 'node:fs';

import type { WalkingRouteRequest } from '@workout/contracts/routing';
import { describe, expect, it } from 'vitest';

import {
  GraphHopperRoutingAdapter,
  GraphManifestError,
  geometryVisitsWaypointsInOrder,
  haversineMeters,
  type RoutingEngineTransport,
  type RoutingEngineTransportRequest,
} from '../src/routing/index.js';
import { verifiedDeployment } from './deployment-fixture.js';

/**
 * M2-01ay: what the independent coverage review (M0-06b) found wrong in the adapter, against
 * real GraphHopper 10.0 answers captured from the loopback engine on graphs `c1fa89fbaf155076` and `92e0fa5f319a41df` (byte-identical answers)
 * (the national graph built in M2-01ay), for public landmark pairs of the
 * review's blinded sample. Each answer is in the exact shape the adapter asks for on a graph
 * with edge facts: road_class, road_access, foot_access, surface, road_environment, osm_way_id.
 */
interface CapturedAnswer {
  readonly paths: [
    {
      readonly distance: number;
      readonly time: number;
      readonly points: { readonly coordinates: [number, number][] };
      readonly snapped_waypoints: { readonly coordinates: [number, number][] };
      readonly details: Record<string, [number, number, string | number | boolean][]>;
    },
  ];
}
const captured = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/graphhopper-${name}.json`, import.meta.url), 'utf8'),
  ) as CapturedAnswer;
/** STR-04: Busan's 40 Steps, 93.4 m, 21.6 m of it `steps`. */
const fortySteps = captured('busan-40-steps');
/** TIM-01: Dangsan to Seonyudo Park over w270322121, `access:conditional=yes @ 6:00-24:00`. */
const seonyudo = captured('seonyudo-time-conditional');
/** FRY-01: Wolmido to Yeongjong, 2,630 m of it on the mapped ferry. */
const wolmido = captured('wolmido-ferry');
const SEONYUDO_BRIDGE_WAY = 270322121;

/** The fixture deployment's pinned dates, which the stubbed engine reports. */
const info = {
  version: '10.0',
  profiles: [{ name: 'foot' }],
  import_date: '2026-09-21T14:09:12Z',
  data_date: '2026-09-18T23:00:00Z',
};

function requestFor(answer: CapturedAnswer): WalkingRouteRequest {
  return {
    schemaVersion: 1,
    requestId: 'req-m2-01ay',
    requestRevision: 1,
    profileId: 'foot-v1',
    // The snapped points: the adapter measures the snap from the requested ones.
    waypoints: answer.paths[0].snapped_waypoints.coordinates.map(
      ([longitude, latitude]): [number, number] => [longitude, latitude],
    ),
  };
}

function stubTransport(body: unknown) {
  const routeBodies: Record<string, unknown>[] = [];
  const transport: RoutingEngineTransport = {
    async send(input: RoutingEngineTransportRequest) {
      if (input.path === '/info')
        return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
      if (input.method === 'POST') routeBodies.push({ ...input.json });
      return { status: 200, bodyText: JSON.stringify(body), truncated: false, byteLength: 1 };
    },
  };
  return { transport, routeBodies };
}

const timeConditionalWays = (wayIds: number[]) => ({
  schemaVersion: 1,
  kind: 'time-conditional-ways',
  keys: ['access:conditional', 'foot:conditional', 'opening_hours'],
  wayIds,
});

async function adapterWithEdgeFacts(body: unknown, wayIds: number[] = [SEONYUDO_BRIDGE_WAY]) {
  const { transport, routeBodies } = stubTransport(body);
  const { deployment } = await verifiedDeployment({
    transport,
    encodedValues: ['foot_access', 'road_class', 'road_environment', 'osm_way_id'],
    timeConditionalWays: timeConditionalWays(wayIds),
  });
  const clock = { now: () => new Date('2026-09-26T12:00:00.000Z') };
  return { adapter: new GraphHopperRoutingAdapter({ deployment, clock }), routeBodies };
}

async function adapterWithoutEdgeFacts(body: unknown) {
  const { transport, routeBodies } = stubTransport(body);
  const { deployment } = await verifiedDeployment({ transport });
  const clock = { now: () => new Date('2026-09-26T12:00:00.000Z') };
  return { adapter: new GraphHopperRoutingAdapter({ deployment, clock }), routeBodies };
}

describe('STR-04: a short stair route the engine returned is a route (M2-01ay)', () => {
  it('accepts the real 40 Steps answer, whose second-to-last vertex lies 0.7 m from the end', async () => {
    const coordinates = fortySteps.paths[0].points.coordinates;
    const end = fortySteps.paths[0].snapped_waypoints.coordinates[1];
    const beforeEnd = coordinates[coordinates.length - 2];
    if (end === undefined || beforeEnd === undefined) throw new Error('fixture shape');
    // The shape the old earliest-match refused: a vertex within the 1 m anchor before the end.
    expect(haversineMeters(beforeEnd, end)).toBeLessThan(1);
    const { adapter } = await adapterWithEdgeFacts(fortySteps);
    const result = await adapter.computeWalkingRoute(requestFor(fortySteps));
    expect(result.outcome).toBe('route_computed');
    if (result.outcome !== 'route_computed') return;
    expect(result.distanceMeters).toBeCloseTo(93.44, 2);
    expect(result.pathDetails.roadClass.some(([, , value]) => value === 'steps')).toBe(true);
  });

  it('still refuses a line that does not end at the last waypoint or passes the ends out of order', () => {
    const coordinates = fortySteps.paths[0].points.coordinates;
    const snapped = fortySteps.paths[0].snapped_waypoints.coordinates;
    expect(geometryVisitsWaypointsInOrder(coordinates, snapped)).toBe(true);
    // Stops two vertices short, metres before the end: the last vertex must be the end.
    expect(geometryVisitsWaypointsInOrder(coordinates.slice(0, -2), snapped)).toBe(false);
    expect(geometryVisitsWaypointsInOrder([...coordinates].reverse(), snapped)).toBe(false);
    // A middle waypoint the line only reaches after its last vertex.
    const [first, last] = snapped;
    if (first === undefined || last === undefined) throw new Error('fixture shape');
    expect(geometryVisitsWaypointsInOrder(coordinates, [first, [129.04, 35.11], last])).toBe(false);
  });
});

describe('edge facts: ferry and time-conditional access are never silent (M2-01ay)', () => {
  it('asks for road_environment and osm_way_id only on a graph that has edge facts', async () => {
    const withFacts = await adapterWithEdgeFacts(seonyudo);
    await withFacts.adapter.computeWalkingRoute(requestFor(seonyudo));
    expect(withFacts.routeBodies[0]?.details).toEqual([
      'road_class',
      'road_access',
      'foot_access',
      'surface',
      'road_environment',
      'osm_way_id',
    ]);
    // An older graph encodes no osm_way_id; asking for it would fail every request.
    const without = await adapterWithoutEdgeFacts(seonyudo);
    await without.adapter.computeWalkingRoute(requestFor(seonyudo));
    expect(without.routeBodies[0]?.details).toEqual([
      'road_class',
      'road_access',
      'foot_access',
      'surface',
    ]);
  });

  it('warns that TIM-01 crosses a time-conditional way (the Seonyudo bridge)', async () => {
    expect(
      seonyudo.paths[0].details.osm_way_id?.some(([, , id]) => id === SEONYUDO_BRIDGE_WAY),
    ).toBe(true);
    const { adapter } = await adapterWithEdgeFacts(seonyudo);
    const result = await adapter.computeWalkingRoute(requestFor(seonyudo));
    expect(result.outcome).toBe('route_computed');
    expect(result.computation.warnings).toEqual(['route_includes_time_conditional_access']);
  });

  it('says nothing about time when no way under the line is on the list', async () => {
    const { adapter } = await adapterWithEdgeFacts(seonyudo, [1, 2, 3]);
    const result = await adapter.computeWalkingRoute(requestFor(seonyudo));
    expect(result.outcome).toBe('route_computed');
    expect(result.computation.warnings).toEqual([]);
  });

  it('warns that FRY-01 takes the Wolmido ferry', async () => {
    const { adapter } = await adapterWithEdgeFacts(wolmido);
    const result = await adapter.computeWalkingRoute(requestFor(wolmido));
    expect(result.outcome).toBe('route_computed');
    expect(result.computation.warnings).toContain('route_includes_ferry');
    expect(result.computation.warnings).not.toContain('route_includes_time_conditional_access');
  });

  it('refuses an answer on such a graph that leaves out a detail it was asked for', async () => {
    for (const drop of ['osm_way_id', 'road_environment']) {
      const details = Object.fromEntries(
        Object.entries(seonyudo.paths[0].details).filter(([name]) => name !== drop),
      );
      const { adapter } = await adapterWithEdgeFacts({
        paths: [{ ...seonyudo.paths[0], details }],
      });
      const result = await adapter.computeWalkingRoute(requestFor(seonyudo));
      expect(result.outcome, drop).toBe('engine_contract_violation');
    }
  });

  it('refuses edge facts that do not cover the line or hold the wrong kind of value', async () => {
    const [head] = seonyudo.paths[0].details.osm_way_id ?? [];
    if (head === undefined) throw new Error('fixture shape');
    for (const osmWayIds of [[head], [[head[0], head[1], 'w270322121']]] as const) {
      const { adapter } = await adapterWithEdgeFacts({
        paths: [
          {
            ...seonyudo.paths[0],
            details: { ...seonyudo.paths[0].details, osm_way_id: osmWayIds },
          },
        ],
      });
      const result = await adapter.computeWalkingRoute(requestFor(seonyudo));
      expect(result.outcome).toBe('engine_contract_violation');
    }
  });
});

/** The encoded values a graph with edge facts needs: both details the adapter asks for. */
const FACT_VALUES = ['road_environment', 'osm_way_id'];

describe('a deployment reads its edge facts from the verified graph directory (M2-01ay)', () => {
  const transport: RoutingEngineTransport = {
    async send() {
      throw new Error('not called');
    },
  };

  it('has none on a graph built before M2-01ay', async () => {
    const { deployment } = await verifiedDeployment({ transport });
    expect(deployment.edgeFacts).toBeNull();
  });

  it('holds the list, read-only, when the graph encodes osm_way_id and carries it', async () => {
    const { deployment } = await verifiedDeployment({
      transport,
      encodedValues: ['road_environment', 'osm_way_id'],
      timeConditionalWays: timeConditionalWays([5, 270322121]),
    });
    expect(deployment.edgeFacts?.timeConditionalWayCount).toBe(2);
    expect(deployment.edgeFacts?.isTimeConditionalWay(270322121)).toBe(true);
    expect(deployment.edgeFacts?.isTimeConditionalWay(6)).toBe(false);
    expect(Object.isFrozen(deployment.edgeFacts)).toBe(true);
  });

  it.each([
    ['a graph that encodes osm_way_id without the list', FACT_VALUES, undefined],
    ['a list on a graph that does not encode osm_way_id', ['road_class'], timeConditionalWays([5])],
    // Codex phase review r1: the adapter would refuse every route on this graph.
    [
      'a list and osm_way_id on a graph that does not encode road_environment',
      ['osm_way_id'],
      timeConditionalWays([5]),
    ],
    ['way ids out of order', FACT_VALUES, timeConditionalWays([7, 5])],
    ['a duplicate way id', FACT_VALUES, timeConditionalWays([5, 5])],
    ['another kind of list', FACT_VALUES, { ...timeConditionalWays([5]), kind: 'something-else' }],
  ])('refuses %s', async (_name, encodedValues, list) => {
    await expect(
      verifiedDeployment({
        transport,
        encodedValues,
        ...(list === undefined ? {} : { timeConditionalWays: list }),
      }),
    ).rejects.toThrow(GraphManifestError);
    await expect(
      verifiedDeployment({
        transport,
        encodedValues,
        ...(list === undefined ? {} : { timeConditionalWays: list }),
      }),
    ).rejects.toMatchObject({ code: 'EDGE_FACTS_INVALID' });
  });
});
