import { readFileSync } from 'node:fs';

import type { WalkingRouteRequest } from '@workout/contracts/routing';
import { walkingRouteResultSchema } from '@workout/contracts/routing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ENGINE_HARD_STOP_GRACE_MILLISECONDS,
  GraphHopperRoutingAdapter,
  GraphManifestError,
  RoutingTransportError,
  createRoutingEngineEndpoint,
  type GraphHopperAdapterOptions,
  edgeDetailsCoverGeometry,
  engineReserveMilliseconds,
  geometryVisitsWaypointsInOrder,
  graphBuildIdFromManifest,
  haversineMeters,
  type RoutingEngineResponse,
  type RoutingEngineTransport,
  type RoutingEngineTransportRequest,
  type RoutingGraphManifest,
} from '../src/routing/index.js';
import { verifiedDeployment } from './deployment-fixture.js';

/** A real GraphHopper 10.0 answer, captured from the loopback engine on the pinned graph. */
const realAnswer = JSON.parse(
  readFileSync(new URL('./fixtures/graphhopper-gwanghwamun.json', import.meta.url), 'utf8'),
) as {
  paths: [
    {
      distance: number;
      time: number;
      points: { coordinates: [number, number][] };
      snapped_waypoints: { coordinates: [number, number][] };
      details: { road_class: [number, number, string][] };
    },
  ];
};

const info = {
  version: '10.0',
  profiles: [{ name: 'foot' }],
  import_date: '2026-09-21T14:09:12Z',
  data_date: '2026-09-18T23:00:00Z',
};

const request: WalkingRouteRequest = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 7,
  profileId: 'foot-v1',
  waypoints: [
    [126.9769, 37.5759],
    [126.9779, 37.5663],
  ],
};

class FixedClock {
  #milliseconds: number;
  constructor(start = Date.parse('2026-09-21T12:00:00.000Z')) {
    this.#milliseconds = start;
  }
  now(): Date {
    return new Date(this.#milliseconds);
  }
  advance(by: number): void {
    this.#milliseconds += by;
  }
}

interface StubbedRoute {
  readonly status: number;
  readonly body: unknown;
}

function stubTransport(route: StubbedRoute, engineInfo: unknown = info) {
  const seen: RoutingEngineTransportRequest[] = [];
  const transport: RoutingEngineTransport = {
    async get(input) {
      seen.push(input);
      if (input.path === '/info')
        return {
          status: 200,
          bodyText: JSON.stringify(engineInfo),
          truncated: false,
          byteLength: 1,
        };
      return {
        status: route.status,
        bodyText: JSON.stringify(route.body),
        truncated: false,
        byteLength: 1,
      };
    },
  };
  return { transport, seen };
}

/** Every adapter in these tests is built from a deployment verified against real files. */
async function adapterFor(
  transport: RoutingEngineTransport,
  clock = new FixedClock(),
  manifestOverrides: Partial<RoutingGraphManifest> = {},
) {
  const { deployment, manifest } = await verifiedDeployment({
    transport,
    manifest: manifestOverrides,
  });
  return { adapter: new GraphHopperRoutingAdapter({ deployment, clock }), manifest };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the adapter refuses an unverified deployment', () => {
  /**
   * The reviewer's reproduction, end to end: a plain object with the right public shape,
   * a graph path that does not exist and a hash nothing checked, handed straight to the
   * adapter. Before the consumption guard this produced `route_computed` carrying the
   * fake hash with `identitySource: "engine"`.
   */
  it('refuses a hand-built deployment object and never routes with it', async () => {
    const { transport, seen } = stubTransport({ status: 200, body: realAnswer });
    const fabricated = {
      manifest: {
        schemaVersion: 1,
        engine: 'graphhopper',
        engineVersion: '10.0',
        engineArtifactSha256: 'a'.repeat(64),
        profileId: 'foot-v1',
        profileConfigSha256: 'a'.repeat(64),
        profileName: 'foot',
        extractSha256: 'a'.repeat(64),
        extractRegion: 'nowhere',
        extractByteLength: 1,
        graphContentSha256: 'a'.repeat(64),
        graphImportedAt: '2026-09-21T14:09:12.000Z',
        roadDataAt: '2026-09-18T23:00:00.000Z',
        builtAt: '2026-09-21T14:09:14.321Z',
      },
      graphBuildId: 'deadbeefdeadbeef',
      graphDirectory: '/does-not-exist',
      endpoint: createRoutingEngineEndpoint('http://127.0.0.1:8991/'),
      transport,
    };
    expect(
      () =>
        new GraphHopperRoutingAdapter({
          deployment: fabricated as unknown as GraphHopperAdapterOptions['deployment'],
          clock: new FixedClock(),
        }),
    ).toThrow(GraphManifestError);
    // The engine was never contacted, so no route was computed under the fake hash.
    expect(seen).toHaveLength(0);
  });
});

describe('graph identity', () => {
  it('is stable for the same manifest and changes when any bound fact changes', async () => {
    const { manifest } = await adapterFor(
      stubTransport({ status: 200, body: realAnswer }).transport,
    );
    expect(graphBuildIdFromManifest(manifest)).toBe(graphBuildIdFromManifest({ ...manifest }));
    expect(graphBuildIdFromManifest(manifest)).toMatch(/^[0-9a-f]{16}$/);
    for (const changed of [
      { extractSha256: 'a'.repeat(64) },
      { profileConfigSha256: 'b'.repeat(64) },
      { engineArtifactSha256: 'c'.repeat(64) },
      // The bytes on disk and the import timestamp are bound too, so a graph rebuilt from
      // the same inputs is a different deployment rather than the same id.
      { graphContentSha256: 'd'.repeat(64) },
      { graphImportedAt: '2026-09-22T00:00:00.000Z' },
    ])
      expect(graphBuildIdFromManifest({ ...manifest, ...changed })).not.toBe(
        graphBuildIdFromManifest(manifest),
      );
  });

  it('records the engine that actually answered, not the pin', async () => {
    const { transport } = stubTransport({ status: 200, body: realAnswer });
    const { adapter, manifest } = await adapterFor(transport);
    const result = await adapter.computeWalkingRoute(request);
    expect(result.computation.graph.identitySource).toBe('engine');
    expect(result.computation.graph.engineVersion).toBe('10.0');
    expect(result.computation.graph.graphImportedAt).toBe('2026-09-21T14:09:12.000Z');
    expect(result.computation.graph.graphContentSha256).toBe(manifest.graphContentSha256);
    expect(result.computation.graph.graphBuildId).toBe(graphBuildIdFromManifest(manifest));
    expect(result.computation.requestId).toBe('req-1');
    expect(result.computation.requestRevision).toBe(7);
  });

  it('asks the engine who it is on every computation, so a swap cannot be outlived', async () => {
    // The cache this replaces returned the old identity for 60 s after a swap.
    let engineInfo: Record<string, unknown> = { ...info };
    let infoCalls = 0;
    const transport: RoutingEngineTransport = {
      async get(input) {
        if (input.path === '/info') {
          infoCalls += 1;
          return {
            status: 200,
            bodyText: JSON.stringify(engineInfo),
            truncated: false,
            byteLength: 1,
          };
        }
        return {
          status: 200,
          bodyText: JSON.stringify(realAnswer),
          truncated: false,
          byteLength: 1,
        };
      },
    };
    const { adapter } = await adapterFor(transport);
    expect((await adapter.computeWalkingRoute(request)).outcome).toBe('route_computed');
    expect(infoCalls).toBe(1);
    // The engine is swapped underneath: same configuration, new import.
    engineInfo = { ...info, import_date: '2026-09-22T09:00:00Z' };
    const afterSwap = await adapter.computeWalkingRoute(request);
    expect(infoCalls).toBe(2);
    expect(afterSwap.outcome).toBe('graph_mismatch');
  });

  it.each([
    ['a different engine version', { ...info, version: '9.1' }],
    ['no engine version at all', { ...info, version: null }],
    ['a missing profile', { ...info, profiles: [{ name: 'bike' }] }],
    ['different road data', { ...info, data_date: '2026-01-01T00:00:00Z' }],
    // A re-import under the same configuration is a different deployment, not the same one.
    ['a re-imported graph', { ...info, import_date: '2026-09-22T09:00:00Z' }],
  ])('refuses to compute against %s', async (_label, engineInfo) => {
    const { transport } = stubTransport({ status: 200, body: realAnswer }, engineInfo);
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('graph_mismatch');
    expect(result.computation.graph.identitySource).toBe('pinned');
  });
});

describe('a computed route', () => {
  it('accepts the real engine answer and measures the snap of every waypoint', async () => {
    const { transport, seen } = stubTransport({ status: 200, body: realAnswer });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('route_computed');
    if (result.outcome !== 'route_computed') return;
    expect(result.distanceMeters).toBeCloseTo(1281.844, 3);
    expect(result.geometry.coordinates).toHaveLength(48);
    expect(result.snappedWaypoints).toHaveLength(2);
    expect(result.snappedWaypoints[0]?.snapDistanceMeters).toBeCloseTo(2.47, 1);
    expect(result.snappedWaypoints[1]?.snapDistanceMeters).toBeCloseTo(10.01, 1);
    expect(result.computation.warnings).toEqual([]);
    // The request carries the engine-side search budget and the flexible algorithm.
    const routeCall = seen.find((call) => call.path === '/route');
    expect(routeCall?.query.get('max_visited_nodes')).toBe('1000000');
    expect(routeCall?.query.get('ch.disable')).toBe('true');
    expect(routeCall?.query.getAll('point')).toEqual(['37.5759,126.9769', '37.5663,126.9779']);
    expect(routeCall?.query.get('profile')).toBe('foot');
    expect(routeCall?.query.get('details')).toBe('road_class');
  });

  it('is a valid contract result', async () => {
    const { transport } = stubTransport({ status: 200, body: realAnswer });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(() => walkingRouteResultSchema.parse(result)).not.toThrow();
  });

  it('measures the computation against the injected clock', async () => {
    const clock = new FixedClock();
    const transport: RoutingEngineTransport = {
      async get(input) {
        clock.advance(120);
        if (input.path === '/info')
          return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
        return {
          status: 200,
          bodyText: JSON.stringify(realAnswer),
          truncated: false,
          byteLength: 1,
        };
      },
    };
    const result = await (await adapterFor(transport, clock)).adapter.computeWalkingRoute(request);
    expect(result.computation.computationMilliseconds).toBe(240);
    expect(result.computation.computedAt).toBe('2026-09-21T12:00:00.240Z');
  });
});

/**
 * Real answers from the pinned Seoul graph. They exist to prove the rules do not reject
 * legitimate routes — including the two shapes an earlier flatness rule got wrong.
 */
const twoVertexRoad = JSON.parse(
  readFileSync(new URL('./fixtures/graphhopper-two-vertex-road.json', import.meta.url), 'utf8'),
) as typeof realAnswer;
const longStraightWay = JSON.parse(
  readFileSync(new URL('./fixtures/graphhopper-long-straight-way.json', import.meta.url), 'utf8'),
) as typeof realAnswer;

describe('a straight line is never reported as a success', () => {
  const answerWith = (overrides: Record<string, unknown>) => ({
    paths: [{ ...realAnswer.paths[0], ...overrides }],
  });
  const requestFor = (answer: typeof realAnswer): WalkingRouteRequest => ({
    ...request,
    waypoints: answer.paths[0].snapped_waypoints.coordinates.map(
      ([longitude, latitude]): [number, number] => [longitude, latitude],
    ),
  });

  it('refuses the OSRM fail-open shape: the requested points and zero distance', async () => {
    const echo = {
      paths: [
        {
          distance: 0,
          time: 0,
          points: { coordinates: [...request.waypoints] },
          snapped_waypoints: { coordinates: [...request.waypoints] },
          details: { road_class: [[0, 1, 'footway']] },
        },
      ],
    };
    const { transport } = stubTransport({ status: 200, body: echo });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('engine_contract_violation');
  });

  it('refuses a straight line the engine does not attest as edges', async () => {
    const start: [number, number] = [126.9769, 37.5759];
    const end: [number, number] = [126.9779, 37.5663];
    const midpoint: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const straight = [start, midpoint, end];
    const straightMeters = haversineMeters(start, midpoint) + haversineMeters(midpoint, end);
    for (const details of [
      { road_class: [] },
      { road_class: [[0, 1, 'footway']] },
      { road_class: [[1, 2, 'footway']] },
    ]) {
      const { transport } = stubTransport({
        status: 200,
        body: answerWith({
          distance: straightMeters,
          points: { coordinates: straight },
          snapped_waypoints: { coordinates: [start, end] },
          details,
        }),
      });
      const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
      expect(result.outcome).toBe('engine_contract_violation');
    }
  });

  it('accepts a real two vertex road, which a flatness rule would have called a straight line', async () => {
    // 169.9 m of `residential` returned as exactly two vertices by the pinned graph.
    const { transport } = stubTransport({ status: 200, body: twoVertexRoad });
    const result = await (
      await adapterFor(transport)
    ).adapter.computeWalkingRoute(requestFor(twoVertexRoad));
    expect(result.outcome).toBe('route_computed');
    if (result.outcome !== 'route_computed') return;
    expect(result.geometry.coordinates).toHaveLength(2);
    expect(result.distanceMeters).toBeCloseTo(169.908, 3);
  });

  it('accepts a real long straight way, which the 200 m flatness rule rejected', async () => {
    // 552.1 m of `cycleway`, three vertices, 0.742 m maximum deviation from its own chord.
    const { transport } = stubTransport({ status: 200, body: longStraightWay });
    const result = await (
      await adapterFor(transport)
    ).adapter.computeWalkingRoute(requestFor(longStraightWay));
    expect(result.outcome).toBe('route_computed');
    if (result.outcome !== 'route_computed') return;
    expect(result.distanceMeters).toBeCloseTo(552.096, 3);
  });

  it('refuses a geometry that belongs somewhere else even when the waypoints echo back', async () => {
    const busanStart: [number, number] = [129.0756, 35.1796];
    const busanBend: [number, number] = [129.0776, 35.1826];
    const busanEnd: [number, number] = [129.0796, 35.1816];
    const { transport } = stubTransport({
      status: 200,
      body: answerWith({
        distance: haversineMeters(busanStart, busanBend) + haversineMeters(busanBend, busanEnd),
        points: { coordinates: [busanStart, busanBend, busanEnd] },
        details: { road_class: [[0, 2, 'footway']] },
      }),
    });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('engine_contract_violation');
  });

  it('refuses a route whose legs are answered out of order', async () => {
    const reversed = [...realAnswer.paths[0].points.coordinates].reverse();
    const { transport } = stubTransport({
      status: 200,
      body: answerWith({ points: { coordinates: reversed } }),
    });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('engine_contract_violation');
  });

  it('refuses an answer with no edge details to back the geometry', async () => {
    const { transport } = stubTransport({
      status: 200,
      body: answerWith({ details: { road_class: [] } }),
    });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('engine_contract_violation');
  });

  it('refuses edge details that do not cover the whole geometry', async () => {
    const { transport } = stubTransport({
      status: 200,
      body: answerWith({ details: { road_class: [[0, 5, 'footway']] } }),
    });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('engine_contract_violation');
  });

  it('documents the limit: an engine that fabricates matching edge details is accepted', async () => {
    // Not a defect to fix here, a boundary to state. Every check reads the engine's own
    // bookkeeping; a consistently dishonest engine defeats all of them, and no claim in
    // this package says otherwise.
    const start: [number, number] = [126.9769, 37.5759];
    const end: [number, number] = [126.9779, 37.5663];
    const midpoint: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const straight = [start, midpoint, end];
    const { transport } = stubTransport({
      status: 200,
      body: answerWith({
        distance: haversineMeters(start, midpoint) + haversineMeters(midpoint, end),
        points: { coordinates: straight },
        snapped_waypoints: { coordinates: [start, end] },
        details: { road_class: [[0, 2, 'footway']] },
      }),
    });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('route_computed');
  });

  it('refuses a distance that does not match the geometry the engine returned', async () => {
    const { transport } = stubTransport({
      status: 200,
      body: answerWith({ distance: realAnswer.paths[0].distance * 4 }),
    });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('engine_contract_violation');
  });

  it('refuses a snap further than the limit rather than reporting the route', async () => {
    const { transport } = stubTransport({
      status: 200,
      body: answerWith({
        snapped_waypoints: {
          coordinates: [[127.05, 37.6], realAnswer.paths[0].snapped_waypoints.coordinates[1]],
        },
      }),
    });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('snap_too_far');
  });

  it('checks the pieces directly against real answers', () => {
    for (const answer of [realAnswer, twoVertexRoad, longStraightWay]) {
      const coordinates = answer.paths[0].points.coordinates;
      expect(
        geometryVisitsWaypointsInOrder(coordinates, answer.paths[0].snapped_waypoints.coordinates),
      ).toBe(true);
      expect(edgeDetailsCoverGeometry(answer.paths[0].details.road_class, coordinates.length)).toBe(
        true,
      );
    }
  });
});

describe('failures stay apart', () => {
  const engineError = (details: string) => ({
    message: details,
    hints: [{ details: `com.graphhopper.util.exceptions.${details}` }],
  });

  it.each([
    ['PointNotFoundException', 'outside_coverage'],
    ['PointOutOfBoundsException', 'outside_coverage'],
    ['ConnectionNotFoundException', 'no_route'],
    ['MaximumNodesExceededException', 'compute_budget_exceeded'],
  ])('maps %s to %s', async (exception, outcome) => {
    const { transport } = stubTransport({ status: 400, body: engineError(exception) });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe(outcome);
  });

  it('reports a ConnectionNotFound that came back inside the engine budget as no_route', async () => {
    const clock = new FixedClock();
    const transport: RoutingEngineTransport = {
      async get(input) {
        if (input.path === '/info')
          return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
        // The engine searched for less than the budget it was given, so it did not time out.
        clock.advance(Number(input.query.get('timeout_ms')) - 1);
        return {
          status: 400,
          bodyText: JSON.stringify(engineError('ConnectionNotFoundException')),
          truncated: false,
          byteLength: 1,
        };
      },
    };
    const result = await (await adapterFor(transport, clock)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('no_route');
    expect(result.computation.warnings).toEqual([]);
  });

  it('reports a ConnectionNotFound that came back after the engine budget as timeout', async () => {
    const clock = new FixedClock();
    const transport: RoutingEngineTransport = {
      async get(input) {
        if (input.path === '/info')
          return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
        // GraphHopper answers an exhausted timeout_ms exactly like a disconnected pair.
        clock.advance(Number(input.query.get('timeout_ms')));
        return {
          status: 400,
          bodyText: JSON.stringify(engineError('ConnectionNotFoundException')),
          truncated: false,
          byteLength: 1,
        };
      },
    };
    const result = await (await adapterFor(transport, clock)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('timeout');
  });

  it.each([
    [429, 'overloaded'],
    [503, 'overloaded'],
    [500, 'engine_unavailable'],
    [404, 'engine_contract_violation'],
  ])('maps HTTP %s to %s', async (status, outcome) => {
    const { transport } = stubTransport({ status, body: { message: 'nope' } });
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe(outcome);
  });

  it('reports an unreachable engine rather than any fallback geometry', async () => {
    const transport: RoutingEngineTransport = {
      async get() {
        throw new RoutingTransportError('ENGINE_UNREACHABLE');
      },
    };
    const result = await (await adapterFor(transport)).adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('engine_unavailable');
    expect(result).not.toHaveProperty('geometry');
  });

  it('reports a caller cancellation as cancelled', async () => {
    const controller = new AbortController();
    const transport: RoutingEngineTransport = {
      async get(input): Promise<RoutingEngineResponse> {
        if (input.path === '/info')
          return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
        controller.abort();
        throw new RoutingTransportError('ENGINE_ABORTED');
      },
    };
    const result = await (
      await adapterFor(transport)
    ).adapter.computeWalkingRoute(request, {
      signal: controller.signal,
    });
    expect(result.outcome).toBe('cancelled');
  });

  it('reports its own deadline as a timeout, not as a cancellation', async () => {
    vi.useFakeTimers();
    const transport: RoutingEngineTransport = {
      get(input) {
        if (input.path === '/info')
          return Promise.resolve({
            status: 200,
            bodyText: JSON.stringify(info),
            truncated: false,
            byteLength: 1,
          });
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () =>
            reject(new RoutingTransportError('ENGINE_ABORTED')),
          );
        });
      },
    };
    const { deployment } = await verifiedDeployment({ transport });
    const adapter = new GraphHopperRoutingAdapter({
      deployment,
      clock: new FixedClock(),
      deadlineMilliseconds: 1_000,
    });
    const pending = adapter.computeWalkingRoute(request);
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await pending;
    expect(result.outcome).toBe('timeout');
  });
});

describe('the engine search is bounded, and cancellation is honest about it (M2-01k-e)', () => {
  const threeWaypoints: WalkingRouteRequest = {
    ...request,
    waypoints: [
      [126.9769, 37.5759],
      [126.9786, 37.5712],
      [126.9779, 37.5663],
    ],
  };

  /** A `/route` that answers only when the test says so, and records its signal. */
  function heldEngine() {
    let answer: (response: RoutingEngineResponse) => void = () => undefined;
    const routeCalls: RoutingEngineTransportRequest[] = [];
    const transport: RoutingEngineTransport = {
      get(input) {
        if (input.path === '/info')
          return Promise.resolve({
            status: 200,
            bodyText: JSON.stringify(info),
            truncated: false,
            byteLength: 1,
          });
        routeCalls.push(input);
        return new Promise((resolve, reject) => {
          answer = resolve;
          input.signal.addEventListener('abort', () =>
            reject(new RoutingTransportError('ENGINE_ABORTED')),
          );
        });
      },
    };
    return {
      transport,
      routeCalls,
      answer: () =>
        answer({
          status: 200,
          bodyText: JSON.stringify(realAnswer),
          truncated: false,
          byteLength: 1,
        }),
    };
  }

  it('sends the remaining deadline, less the reserve, as a per-leg engine timeout', async () => {
    const clock = new FixedClock();
    const seen: RoutingEngineTransportRequest[] = [];
    const transport: RoutingEngineTransport = {
      async get(input) {
        seen.push(input);
        // The identity check takes 300 ms of the deadline.
        if (input.path === '/info') {
          clock.advance(300);
          return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
        }
        return {
          status: 200,
          bodyText: JSON.stringify(realAnswer),
          truncated: false,
          byteLength: 1,
        };
      },
    };
    const { deployment } = await verifiedDeployment({ transport });
    const adapter = new GraphHopperRoutingAdapter({ deployment, clock });
    await adapter.computeWalkingRoute(threeWaypoints);
    const route = seen.find((entry) => entry.path === '/route');
    // (8000 - 300 - 500) / 2 legs: GraphHopper arms the timeout once per leg.
    expect(route?.query.get('timeout_ms')).toBe('3600');
    expect(engineReserveMilliseconds(8_000)).toBe(500);
    expect(engineReserveMilliseconds(400)).toBe(100);
  });

  it('never asks the engine to search when no budget is left', async () => {
    const clock = new FixedClock();
    const seen: string[] = [];
    const transport: RoutingEngineTransport = {
      async get(input) {
        seen.push(input.path);
        clock.advance(7_600);
        return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
      },
    };
    const { deployment } = await verifiedDeployment({ transport });
    const adapter = new GraphHopperRoutingAdapter({ deployment, clock });
    const result = await adapter.computeWalkingRoute(request);
    expect(result.outcome).toBe('timeout');
    expect(seen).toEqual(['/info']);
  });

  it('answers a cancelled caller at once but keeps the engine connection until the engine stops', async () => {
    const engine = heldEngine();
    const { adapter } = await adapterFor(engine.transport);
    const controller = new AbortController();
    const tracked = adapter.computeWalkingRouteTracked(request, { signal: controller.signal });
    let released = false;
    void tracked.engineReleased.then(() => {
      released = true;
    });
    await vi.waitFor(() => expect(engine.routeCalls).toHaveLength(1));
    controller.abort();
    expect((await tracked.result).outcome).toBe('cancelled');
    // The caller has its answer; the engine is still searching and nothing pretends otherwise.
    expect(engine.routeCalls[0]?.signal.aborted).toBe(false);
    await Promise.resolve();
    expect(released).toBe(false);
    engine.answer();
    await tracked.engineReleased;
    expect(released).toBe(true);
  });

  it('does not start the search at all when the caller cancels during the identity check', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const transport: RoutingEngineTransport = {
      async get(input) {
        seen.push(input.path);
        controller.abort();
        throw new RoutingTransportError('ENGINE_ABORTED');
      },
    };
    const { adapter } = await adapterFor(transport);
    const tracked = adapter.computeWalkingRouteTracked(request, { signal: controller.signal });
    expect((await tracked.result).outcome).toBe('cancelled');
    await tracked.engineReleased;
    expect(seen).toEqual(['/info']);
  });

  it('cuts the engine connection only at the deadline plus the grace period', async () => {
    vi.useFakeTimers();
    const engine = heldEngine();
    const { deployment } = await verifiedDeployment({ transport: engine.transport });
    const adapter = new GraphHopperRoutingAdapter({
      deployment,
      clock: new FixedClock(),
      deadlineMilliseconds: 1_000,
    });
    const tracked = adapter.computeWalkingRouteTracked(request);
    let released = false;
    void tracked.engineReleased.then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await tracked.result).outcome).toBe('timeout');
    expect(engine.routeCalls[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(ENGINE_HARD_STOP_GRACE_MILLISECONDS - 10);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(engine.routeCalls[0]?.signal.aborted).toBe(true);
    expect(released).toBe(true);
  });

  it('refuses an answer with more vertices than the configured response bound', async () => {
    const { transport } = stubTransport({ status: 200, body: realAnswer });
    const { deployment } = await verifiedDeployment({ transport });
    const vertices = realAnswer.paths[0].points.coordinates.length;
    const tight = new GraphHopperRoutingAdapter({
      deployment,
      clock: new FixedClock(),
      maxResponsePoints: vertices - 1,
    });
    expect((await tight.computeWalkingRoute(request)).outcome).toBe('engine_contract_violation');
    const exact = new GraphHopperRoutingAdapter({
      deployment,
      clock: new FixedClock(),
      maxResponsePoints: vertices,
    });
    expect((await exact.computeWalkingRoute(request)).outcome).toBe('route_computed');
    expect(
      () =>
        new GraphHopperRoutingAdapter({
          deployment,
          clock: new FixedClock(),
          maxResponsePoints: 20_001,
        }),
    ).toThrow('INVALID_RESPONSE_POINT_LIMIT');
  });

  it('verifies a running engine against the pin before anything is switched to it', async () => {
    const { transport } = stubTransport({ status: 200, body: realAnswer });
    const { adapter } = await adapterFor(transport);
    const ok = await adapter.verifyEngineIdentity();
    expect(ok.ok && ok.identity.identitySource).toBe('engine');
    const other = stubTransport(
      { status: 200, body: realAnswer },
      { ...info, import_date: '2026-09-23T04:11:56Z' },
    );
    const { adapter: pinnedElsewhere } = await adapterFor(other.transport);
    expect(await pinnedElsewhere.verifyEngineIdentity()).toEqual({
      ok: false,
      outcome: 'graph_mismatch',
    });
  });
});
