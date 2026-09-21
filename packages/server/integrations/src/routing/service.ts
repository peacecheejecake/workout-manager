import {
  routingLimits,
  walkingRouteRequestSchema,
  walkingRouteResultSchema,
  type WalkingRouteResult,
} from '@workout/contracts/routing';

import type { TenantAdmissionControl } from './admission.js';
import { requestedSpanMeters } from './geo.js';
import type { GraphHopperRoutingAdapter, RoutingClock } from './graphhopper-adapter.js';

/**
 * Application service for one internal routing computation.
 *
 * Order matters: the request is validated and bounded first, then the tenant's admission
 * bound is taken, and only then is the engine called. A refusal therefore costs no engine
 * work. Nothing here writes to a database, and the caller must not hold a transaction
 * open across it — persisting a result belongs to the course ledger and its outbox.
 */
export class RoutingRequestError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ROUTING_REQUEST'
      | 'ROUTING_LEG_TOO_LONG'
      | 'ROUTING_SPAN_TOO_LARGE'
      | 'ROUTING_WAYPOINT_REPEATED',
  ) {
    super(code);
    this.name = 'RoutingRequestError';
  }
}

export interface WalkingRouteComputation {
  readonly result: WalkingRouteResult;
  /** Set only when the outcome is `overloaded`, for a `retry-after` header. */
  readonly retryAfterSeconds: number | null;
}

export interface WalkingRouteServiceOptions {
  readonly adapter: GraphHopperRoutingAdapter;
  readonly admission: TenantAdmissionControl;
  readonly clock: RoutingClock;
}

export class WalkingRouteService {
  readonly #adapter: GraphHopperRoutingAdapter;
  readonly #admission: TenantAdmissionControl;
  readonly #clock: RoutingClock;

  constructor(options: WalkingRouteServiceOptions) {
    this.#adapter = options.adapter;
    this.#admission = options.admission;
    this.#clock = options.clock;
  }

  /**
   * @param tenantId Derived from the authenticated session by the caller, never from a body.
   */
  async compute(
    tenantId: string,
    rawRequest: unknown,
    context: { readonly signal?: AbortSignal } = {},
  ): Promise<WalkingRouteComputation> {
    const parsed = walkingRouteRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new RoutingRequestError('INVALID_ROUTING_REQUEST');
    const request = parsed.data;

    const { total, longestLeg } = requestedSpanMeters(request.waypoints);
    if (longestLeg > routingLimits.maxLegStraightLineMeters)
      throw new RoutingRequestError('ROUTING_LEG_TOO_LONG');
    if (total > routingLimits.maxRequestStraightLineMeters)
      throw new RoutingRequestError('ROUTING_SPAN_TOO_LARGE');
    for (let index = 1; index < request.waypoints.length; index += 1) {
      const previous = request.waypoints[index - 1];
      const current = request.waypoints[index];
      if (previous?.[0] === current?.[0] && previous?.[1] === current?.[1])
        throw new RoutingRequestError('ROUTING_WAYPOINT_REPEATED');
    }

    const lease = this.#admission.tryAcquire(tenantId);
    if (!lease.granted) {
      return {
        result: walkingRouteResultSchema.parse({
          outcome: 'overloaded',
          computation: {
            schemaVersion: 1,
            requestId: request.requestId,
            requestRevision: request.requestRevision,
            // The engine was never called, so its identity is the pin, not an observation.
            graph: this.#adapter.pinnedIdentity(),
            conditions: this.#adapter.conditions(request.waypoints.length),
            computedAt: this.#clock.now().toISOString(),
            computationMilliseconds: 0,
            warnings: [],
          },
        }),
        retryAfterSeconds: lease.retryAfterSeconds,
      };
    }
    try {
      const result = await this.#adapter.computeWalkingRoute(request, context);
      return { result, retryAfterSeconds: null };
    } finally {
      // Released on success, failure and cancellation alike: a cancelled request must not
      // keep holding a tenant's permit.
      lease.release();
    }
  }
}
