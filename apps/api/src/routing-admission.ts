import { routingLimits } from '@workout/contracts/routing';
import type { Database } from '@workout/server-persistence/database';
import {
  createSharedRoutingAdmission,
  type SharedRoutingAdmission,
  type SharedRoutingAdmissionEvent,
} from '@workout/server-persistence/routing-admission';
import { ENGINE_HARD_STOP_GRACE_MILLISECONDS } from '@workout/server-integrations/routing';

import { ROUTING_ENGINE_CONCURRENCY, RoutingConfigurationError } from './routing-deployment.js';

/**
 * Routing admission for the production composition (M2-01ah).
 *
 * Every API instance takes its permits from the same PostgreSQL table, so the tenant bounds
 * (two computations at once, twenty a minute) hold summed over instances, and the engine's
 * concurrency is capped over every tenant. This is what lets routing run on more than one
 * API instance; before, the bounds were counted per process and a second instance doubled
 * them. There is no in-process fallback here on purpose.
 */

/**
 * `ROUTING_ENGINE_CONCURRENCY` (optional): engine computations in flight at once, over every
 * tenant and every API instance. An integer 1–1024; unset means
 * {@link DEFAULT_ROUTING_ENGINE_CONCURRENCY}. Set without the four `ROUTING_*` keys, startup
 * fails as `ROUTING_CONFIGURATION_INCOMPLETE`, like the host allowlist.
 */
export { ROUTING_ENGINE_CONCURRENCY };

/**
 * The default engine cap. GraphHopper's flexible search is CPU-bound and one computation uses
 * one engine thread. Eight is the logical core count of the desktop the M2-01k probes ran on
 * (`hw.ncpu` 8), so a full cap keeps those cores busy without queueing searches inside the
 * engine. It is a starting point, not a measured optimum: operators set it to the core count
 * of the machine that runs the engine.
 */
export const DEFAULT_ROUTING_ENGINE_CONCURRENCY = 8;

/**
 * How long a permit may hold its slots unreleased: the deadline, then the hard stop that cuts
 * an engine connection that never answered, then a margin for the release's own round trip.
 * A live instance always releases inside it; a dead one's permits come back when it ends.
 */
export const ROUTING_PERMIT_LEASE_MILLISECONDS =
  routingLimits.deadlineMilliseconds + ENGINE_HARD_STOP_GRACE_MILLISECONDS + 2_000;

export function routingEngineConcurrency(environment: Readonly<Record<string, unknown>>): number {
  const raw = environment[ROUTING_ENGINE_CONCURRENCY];
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === ''))
    return DEFAULT_ROUTING_ENGINE_CONCURRENCY;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const value = /^[1-9][0-9]{0,3}$/.test(text) ? Number(text) : Number.NaN;
  if (!(value >= 1 && value <= 1_024))
    throw new RoutingConfigurationError('ROUTING_CONFIGURATION_INVALID', [
      ROUTING_ENGINE_CONCURRENCY,
    ]);
  return value;
}

export interface ConfiguredRoutingAdmissionOptions {
  readonly onRefusal?: (event: SharedRoutingAdmissionEvent) => void;
}

export function createConfiguredRoutingAdmission(
  database: Database,
  environment: Readonly<Record<string, unknown>>,
  options: ConfiguredRoutingAdmissionOptions = {},
): SharedRoutingAdmission & { readonly engineConcurrency: number } {
  const engineConcurrency = routingEngineConcurrency(environment);
  const admission = createSharedRoutingAdmission(
    database,
    {
      tenantConcurrency: routingLimits.tenantConcurrency,
      tenantRequestsPerWindow: routingLimits.tenantRequestsPerWindow,
      tenantWindowMilliseconds: routingLimits.tenantWindowMilliseconds,
      engineConcurrency,
      leaseMilliseconds: ROUTING_PERMIT_LEASE_MILLISECONDS,
    },
    options.onRefusal === undefined ? {} : { onRefusal: options.onRefusal },
  );
  return {
    tryAcquire: (tenantId) => admission.tryAcquire(tenantId),
    drain: (timeoutMilliseconds) => admission.drain(timeoutMilliseconds),
    engineConcurrency,
  };
}
