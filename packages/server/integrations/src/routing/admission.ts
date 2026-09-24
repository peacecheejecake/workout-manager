import { routingLimits } from '@workout/contracts/routing';

/**
 * Per-tenant admission control for routing computations.
 *
 * Two separate bounds, because they fail for different reasons: a rate window stops one
 * tenant from queueing work faster than it can be served, and a concurrency permit stops
 * one tenant from holding several engine computations at once. Both are refusals, never
 * a queue that grows without a bound.
 *
 * {@link TenantAdmissionControl} below counts in-process only. The production composition
 * uses the PostgreSQL lease limiter instead (M2-01ah, `@workout/server-persistence/
 * routing-admission`), which every API instance shares and which adds a cap on the engine's
 * concurrency across all tenants. Both implement {@link RoutingAdmission}; the in-process one
 * remains for tests and offline probes that have no database.
 */
export interface AdmissionClock {
  /** Monotonic-enough milliseconds. Injected so tests do not sleep. */
  now(): number;
}

export interface AdmissionLease {
  readonly granted: true;
  /**
   * Idempotent: releasing twice does not return two permits. Never rejects; a shared limiter
   * whose release cannot reach its store lets the permit's lease expire instead.
   */
  release(): void | Promise<void>;
}

export interface AdmissionRefusal {
  readonly granted: false;
  /**
   * `rate` and `concurrency` are the tenant's own bounds. `capacity` is the in-process
   * limiter's tracked-tenant cap. `engine_capacity` is the cap on the engine's concurrency
   * summed over every tenant (M2-01ah). `limiter_unavailable` is a shared limiter that could
   * not be asked, and `limiter_contended` one that could be asked but whose lock or statement
   * timed out under contention: both refuse rather than admitting unchecked work, and are
   * kept apart so an operator can tell an outage from load.
   */
  readonly reason:
    | 'rate'
    | 'concurrency'
    | 'capacity'
    | 'engine_capacity'
    | 'limiter_unavailable'
    | 'limiter_contended';
  /** Seconds after which a retry could succeed, for `retry-after`. */
  readonly retryAfterSeconds: number;
}

/**
 * What the routing service asks before it calls the engine. A shared implementation answers
 * asynchronously; the in-process one synchronously. Either way a refusal costs no engine work.
 */
export interface RoutingAdmission {
  tryAcquire(
    tenantId: string,
  ): AdmissionLease | AdmissionRefusal | Promise<AdmissionLease | AdmissionRefusal>;
}

export interface TenantAdmissionLimits {
  readonly concurrency: number;
  readonly requestsPerWindow: number;
  readonly windowMilliseconds: number;
  /** Cap on tracked tenants so an unbounded number of ids cannot grow this map. */
  readonly maxTrackedTenants: number;
}

export const defaultTenantAdmissionLimits: TenantAdmissionLimits = Object.freeze({
  concurrency: routingLimits.tenantConcurrency,
  requestsPerWindow: routingLimits.tenantRequestsPerWindow,
  windowMilliseconds: routingLimits.tenantWindowMilliseconds,
  maxTrackedTenants: 10_000,
});

interface TenantState {
  /** Start timestamps inside the current window, oldest first. */
  starts: number[];
  inFlight: number;
  lastSeen: number;
}

export class TenantAdmissionControl implements RoutingAdmission {
  readonly #limits: TenantAdmissionLimits;
  readonly #clock: AdmissionClock;
  readonly #tenants = new Map<string, TenantState>();

  constructor(clock: AdmissionClock, limits: TenantAdmissionLimits = defaultTenantAdmissionLimits) {
    if (
      !Number.isInteger(limits.concurrency) ||
      limits.concurrency < 1 ||
      !Number.isInteger(limits.requestsPerWindow) ||
      limits.requestsPerWindow < 1 ||
      !Number.isInteger(limits.windowMilliseconds) ||
      limits.windowMilliseconds < 1 ||
      !Number.isInteger(limits.maxTrackedTenants) ||
      limits.maxTrackedTenants < 1
    )
      throw new Error('INVALID_ADMISSION_LIMITS');
    this.#limits = limits;
    this.#clock = clock;
  }

  /** Tenants currently tracked. Exposed so the bound itself can be tested. */
  get trackedTenants(): number {
    return this.#tenants.size;
  }

  tryAcquire(tenantId: string): AdmissionLease | AdmissionRefusal {
    const now = this.#clock.now();
    this.#evict(now);
    const tracked = this.#tenants.get(tenantId);
    // A tenant we are not already tracking cannot be admitted once the map is full,
    // otherwise the bound would only be a hint.
    if (tracked === undefined && this.#tenants.size >= this.#limits.maxTrackedTenants)
      return { granted: false, reason: 'capacity', retryAfterSeconds: 1 };
    const state = tracked ?? { starts: [], inFlight: 0, lastSeen: now };
    state.lastSeen = now;
    const windowStart = now - this.#limits.windowMilliseconds;
    state.starts = state.starts.filter((start) => start > windowStart);
    if (state.inFlight >= this.#limits.concurrency) {
      this.#tenants.set(tenantId, state);
      return { granted: false, reason: 'concurrency', retryAfterSeconds: 1 };
    }
    if (state.starts.length >= this.#limits.requestsPerWindow) {
      const oldest = state.starts[0] ?? now;
      this.#tenants.set(tenantId, state);
      return {
        granted: false,
        reason: 'rate',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((oldest + this.#limits.windowMilliseconds - now) / 1000),
        ),
      };
    }
    state.starts.push(now);
    state.inFlight += 1;
    this.#tenants.set(tenantId, state);
    let released = false;
    return {
      granted: true,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#tenants.get(tenantId);
        if (current === undefined) return;
        current.inFlight = Math.max(0, current.inFlight - 1);
      },
    };
  }

  /**
   * Drop idle tenants once the map is full. Tenants with work in flight are kept, so a
   * full map of busy tenants refuses new ones rather than growing.
   */
  #evict(now: number): void {
    if (this.#tenants.size < this.#limits.maxTrackedTenants) return;
    const windowStart = now - this.#limits.windowMilliseconds;
    for (const [tenantId, state] of this.#tenants) {
      if (state.inFlight === 0 && state.lastSeen <= windowStart) this.#tenants.delete(tenantId);
    }
  }
}
