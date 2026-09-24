import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  GraphHopperRoutingAdapter,
  RoutingRequestError,
  TenantAdmissionControl,
  WalkingRouteService,
  type AdmissionLease,
  type AdmissionRefusal,
  type RoutingAdmission,
  type RoutingEngineTransport,
} from '../src/routing/index.js';
import { verifiedDeployment } from './deployment-fixture.js';

const realAnswer = JSON.parse(
  readFileSync(new URL('./fixtures/graphhopper-gwanghwamun.json', import.meta.url), 'utf8'),
) as unknown;

const info = {
  version: '10.0',
  profiles: [{ name: 'foot' }],
  import_date: '2026-09-21T14:09:12Z',
  data_date: '2026-09-18T23:00:00Z',
};

const validRequest = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 3,
  profileId: 'foot-v1',
  waypoints: [
    [126.9769, 37.5759],
    [126.9779, 37.5663],
  ],
};

class ControllableClock {
  milliseconds = Date.parse('2026-09-21T12:00:00.000Z');
  now(): Date {
    return new Date(this.milliseconds);
  }
}

async function serviceWith(
  options: { engineCalls?: { count: number }; hold?: Promise<void> } = {},
) {
  const clock = new ControllableClock();
  const transport: RoutingEngineTransport = {
    async get(input) {
      if (input.path === '/info')
        return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
      if (options.engineCalls) options.engineCalls.count += 1;
      if (options.hold) await options.hold;
      return { status: 200, bodyText: JSON.stringify(realAnswer), truncated: false, byteLength: 1 };
    },
  };
  const { deployment } = await verifiedDeployment({ transport });
  const adapter = new GraphHopperRoutingAdapter({ deployment, clock });
  const admission = new TenantAdmissionControl(
    { now: () => clock.milliseconds },
    {
      concurrency: 2,
      requestsPerWindow: 3,
      windowMilliseconds: 60_000,
      maxTrackedTenants: 2,
    },
  );
  return { service: new WalkingRouteService({ adapter, admission, clock }), clock, admission };
}

describe('request bounds', () => {
  it.each([
    ['an unknown field', { ...validRequest, engineUrl: 'http://evil.example/route' }],
    ['an unknown profile', { ...validRequest, profileId: 'car-v1' }],
    ['one waypoint', { ...validRequest, waypoints: [[126.9769, 37.5759]] }],
    [
      'too many waypoints',
      {
        ...validRequest,
        waypoints: Array.from({ length: 13 }, (_value, index) => [126.97 + index / 1000, 37.57]),
      },
    ],
    [
      'a non-finite coordinate',
      {
        ...validRequest,
        waypoints: [
          [Number.NaN, 37.5],
          [126.9, 37.5],
        ],
      },
    ],
  ])('refuses %s', async (_label, body) => {
    const { service } = await serviceWith();
    await expect(service.compute('athlete-1', body, {})).rejects.toBeInstanceOf(
      RoutingRequestError,
    );
  });

  it('refuses a leg longer than the straight-line bound before calling the engine', async () => {
    const engineCalls = { count: 0 };
    const { service } = await serviceWith({ engineCalls });
    await expect(
      service.compute(
        'athlete-1',
        {
          ...validRequest,
          waypoints: [
            [126.9769, 37.5759],
            [127.9769, 37.5759],
          ],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ROUTING_LEG_TOO_LONG' });
    expect(engineCalls.count).toBe(0);
  });

  it('refuses a repeated waypoint', async () => {
    const { service } = await serviceWith();
    await expect(
      service.compute(
        'athlete-1',
        {
          ...validRequest,
          waypoints: [
            [126.9769, 37.5759],
            [126.9769, 37.5759],
          ],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ROUTING_WAYPOINT_REPEATED' });
  });
});

describe('per tenant admission', () => {
  it('refuses over the rate window without calling the engine, and says when to retry', async () => {
    const engineCalls = { count: 0 };
    const { service } = await serviceWith({ engineCalls });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await service.compute('athlete-1', validRequest, {})).result.outcome).toBe(
        'route_computed',
      );
    const refused = await service.compute('athlete-1', validRequest, {});
    expect(refused.result.outcome).toBe('overloaded');
    expect(refused.retryAfterSeconds).toBe(60);
    expect(refused.result.computation.graph.identitySource).toBe('pinned');
    expect(engineCalls.count).toBe(3);
  });

  it('bounds one tenant without refusing another', async () => {
    const { service } = await serviceWith();
    for (let attempt = 0; attempt < 3; attempt += 1)
      await service.compute('athlete-1', validRequest, {});
    expect((await service.compute('athlete-1', validRequest, {})).result.outcome).toBe(
      'overloaded',
    );
    expect((await service.compute('athlete-2', validRequest, {})).result.outcome).toBe(
      'route_computed',
    );
  });

  it('refuses a third concurrent computation from the same tenant', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = await serviceWith({ hold });
    const first = service.compute('athlete-1', validRequest, {});
    const second = service.compute('athlete-1', validRequest, {});
    const third = await service.compute('athlete-1', validRequest, {});
    expect(third.result.outcome).toBe('overloaded');
    release();
    expect((await first).result.outcome).toBe('route_computed');
    expect((await second).result.outcome).toBe('route_computed');
  });

  it('returns the permit when a computation finishes, so the tenant is not stuck', async () => {
    const { service, admission } = await serviceWith();
    await service.compute('athlete-1', validRequest, {});
    const lease = admission.tryAcquire('athlete-1');
    expect(lease.granted).toBe(true);
  });

  it('refuses a new tenant once the tracked tenant bound is reached', async () => {
    const { service } = await serviceWith();
    await service.compute('athlete-1', validRequest, {});
    await service.compute('athlete-2', validRequest, {});
    const third = await service.compute('athlete-3', validRequest, {});
    expect(third.result.outcome).toBe('overloaded');
  });
});

describe('a cancelled computation keeps its permit while the engine still searches (M2-01k-e)', () => {
  it('refuses a third computation until the engine answers the two cancelled ones', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engineCalls = { count: 0 };
    const { service } = await serviceWith({ hold, engineCalls });
    const first = new AbortController();
    const second = new AbortController();
    const one = service.compute('athlete-1', validRequest, { signal: first.signal });
    const two = service.compute('athlete-1', validRequest, { signal: second.signal });
    await vi.waitFor(() => expect(engineCalls.count).toBe(2));
    first.abort();
    second.abort();
    // Both callers are answered at once...
    expect((await one).result.outcome).toBe('cancelled');
    expect((await two).result.outcome).toBe('cancelled');
    // ...but the engine is still on both searches, so the tenant has no permit to spend.
    const refused = await service.compute('athlete-1', validRequest, {});
    expect(refused.result.outcome).toBe('overloaded');
    expect(refused.retryAfterSeconds).toBe(1);
    expect(engineCalls.count).toBe(2);
    release();
    await vi.waitFor(async () =>
      expect((await service.compute('athlete-1', validRequest, {})).result.outcome).toBe(
        'route_computed',
      ),
    );
  });
});

describe('an asynchronous, shared admission (M2-01ah)', () => {
  async function withAdmission(admission: RoutingAdmission, hold?: Promise<void>) {
    const clock = new ControllableClock();
    const engineCalls = { count: 0 };
    const transport: RoutingEngineTransport = {
      async get(input) {
        if (input.path === '/info')
          return { status: 200, bodyText: JSON.stringify(info), truncated: false, byteLength: 1 };
        engineCalls.count += 1;
        if (hold) await hold;
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
    return { service: new WalkingRouteService({ adapter, admission, clock }), engineCalls };
  }

  it('answers an engine-capacity refusal as overloaded without calling the engine', async () => {
    const refusal: AdmissionRefusal = {
      granted: false,
      reason: 'engine_capacity',
      retryAfterSeconds: 1,
    };
    const { service, engineCalls } = await withAdmission({ tryAcquire: async () => refusal });
    const refused = await service.compute('athlete-1', validRequest, {});
    expect(refused.result.outcome).toBe('overloaded');
    expect(refused.retryAfterSeconds).toBe(1);
    expect(engineCalls.count).toBe(0);
  });

  it('releases an asynchronous permit only when the engine stops, even after an abort', async () => {
    let finish = () => {};
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const released = vi.fn(async () => {
      throw new Error('store unreachable; the lease expiry returns the permit instead');
    });
    const lease: AdmissionLease = { granted: true, release: released };
    const { service, engineCalls } = await withAdmission({ tryAcquire: async () => lease }, hold);
    const caller = new AbortController();
    const pending = service.compute('athlete-1', validRequest, { signal: caller.signal });
    await vi.waitFor(() => expect(engineCalls.count).toBe(1));
    caller.abort();
    expect((await pending).result.outcome).toBe('cancelled');
    // The caller has its answer; the engine is still searching, so the permit is held.
    expect(released).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1));
  });
});
