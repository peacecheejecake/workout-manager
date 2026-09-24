import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Database } from './database.js';

/**
 * Routing admission shared by every API instance (M2-01ah), over migration 047.
 *
 * The shape matches `RoutingAdmission` in `@workout/server-integrations/routing`
 * structurally; persistence does not depend on the integrations package, the API composes
 * the two.
 *
 * Each computation costs two short tenant transactions — acquire, then release — and holds
 * none while the engine works. The decision, the tenant's rate window, the tenant's
 * concurrency and the engine's concurrency over every tenant, all live in the database
 * function, under one lock, on the database's clock.
 *
 * Fails closed. A database that cannot be asked refuses the computation as
 * `limiter_unavailable`; there is no fallback to counting in this process, which is exactly
 * the per-instance limit this replaces. A release that fails is left to the lease expiry.
 */
export interface SharedRoutingAdmissionLimits {
  readonly tenantConcurrency: number;
  readonly tenantRequestsPerWindow: number;
  readonly tenantWindowMilliseconds: number;
  /** Engine computations in flight, summed over every tenant and every API instance. */
  readonly engineConcurrency: number;
  /**
   * How long a permit may hold its slots without being released: the computation's deadline
   * plus the engine's hard-stop grace plus a margin. It is what returns the permits of an
   * instance that died mid-computation.
   */
  readonly leaseMilliseconds: number;
}

export type SharedRoutingRefusalReason =
  'rate' | 'concurrency' | 'engine_capacity' | 'limiter_unavailable' | 'limiter_contended';

export interface SharedRoutingAdmissionEvent {
  readonly reason: SharedRoutingRefusalReason;
  /** The engine count the decision saw; `null` when the database could not be asked. */
  readonly engineInFlight: number | null;
  readonly engineConcurrency: number;
}

export interface SharedRoutingAdmissionOptions {
  /** Called on every refusal, without the tenant id. For the operator's log. */
  readonly onRefusal?: (event: SharedRoutingAdmissionEvent) => void;
  /** Test seam for the permit id. */
  readonly permitId?: () => string;
}

export type SharedRoutingAdmissionResult =
  | { readonly granted: true; release(): Promise<void> }
  | {
      readonly granted: false;
      readonly reason: SharedRoutingRefusalReason;
      readonly retryAfterSeconds: number;
    };

export interface SharedRoutingAdmission {
  tryAcquire(tenantId: string): Promise<SharedRoutingAdmissionResult>;
  /**
   * Wait until every permit this instance granted has been released, or until
   * `timeoutMilliseconds` pass. Called before the database pool closes on shutdown: a permit
   * whose engine search outlives the last HTTP answer (a cancelled caller) is released when
   * the engine stops, and closing the pool first would leave it to its lease expiry — one
   * engine slot held for nothing on every rolling restart.
   */
  drain(timeoutMilliseconds: number): Promise<void>;
}

const decisionSchema = z.strictObject({
  permit_granted: z.boolean(),
  refusal: z.enum(['rate', 'concurrency', 'engine_capacity']).nullable(),
  retry_after: z.number().int().min(0).max(3600),
  engine_in_flight: z.number().int().min(0),
});

function assertLimits(limits: SharedRoutingAdmissionLimits): void {
  const within = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  // The same bounds the database function enforces, checked at startup rather than on the
  // first request.
  if (
    !within(limits.tenantConcurrency, 1, 64) ||
    !within(limits.tenantRequestsPerWindow, 1, 10_000) ||
    !within(limits.tenantWindowMilliseconds, 1_000, 3_600_000) ||
    !within(limits.engineConcurrency, 1, 1_024) ||
    !within(limits.leaseMilliseconds, 100, 600_000) ||
    // Housekeeping deletes rows that have left the window and hold nothing. With a window
    // shorter than the lease a row could leave the window while its lease still holds; the
    // function's own guard keeps such a row, but the rule is enforced here and in SQL so the
    // guard is never the only thing between a live permit and deletion.
    limits.tenantWindowMilliseconds < limits.leaseMilliseconds
  )
    throw new Error('INVALID_ADMISSION_LIMITS');
}

/**
 * PostgreSQL's answers to waiting too long: `lock_timeout` (55P03, the acquisition lock under
 * contention) and `statement_timeout` (57014). The database is there and answering; it is
 * busy. Anything else — no connection, a closed pool, a missing function — is unavailable.
 */
function isContention(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
  return code === '55P03' || code === '57014';
}

export function createSharedRoutingAdmission(
  database: Database,
  limits: SharedRoutingAdmissionLimits,
  options: SharedRoutingAdmissionOptions = {},
): SharedRoutingAdmission {
  assertLimits(limits);
  const newPermitId = options.permitId ?? randomUUID;
  /** Settles when the permit's release has finished (or failed). One per granted permit. */
  const outstanding = new Set<Promise<void>>();
  const refuse = (
    reason: SharedRoutingRefusalReason,
    retryAfterSeconds: number,
    engineInFlight: number | null,
  ): SharedRoutingAdmissionResult => {
    options.onRefusal?.({ reason, engineInFlight, engineConcurrency: limits.engineConcurrency });
    return { granted: false, reason, retryAfterSeconds };
  };
  return {
    async tryAcquire(tenantId) {
      const permitId = newPermitId();
      let decision: z.infer<typeof decisionSchema>;
      try {
        decision = await database.tenant(tenantId, async (transaction) => {
          const result = await transaction.query(
            'SELECT * FROM acquire_routing_permit($1,$2,$3,$4,$5,$6)',
            [
              permitId,
              limits.tenantConcurrency,
              limits.tenantRequestsPerWindow,
              limits.tenantWindowMilliseconds,
              limits.engineConcurrency,
              limits.leaseMilliseconds,
            ],
          );
          return decisionSchema.parse(result.rows[0]);
        });
      } catch (error) {
        return refuse(isContention(error) ? 'limiter_contended' : 'limiter_unavailable', 1, null);
      }
      if (!decision.permit_granted)
        return refuse(
          decision.refusal ?? 'limiter_unavailable',
          decision.retry_after,
          decision.engine_in_flight,
        );
      let released: Promise<void> | undefined;
      let settle: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      outstanding.add(settled);
      void settled.then(() => outstanding.delete(settled));
      return {
        granted: true,
        release() {
          released ??= database
            .tenant(tenantId, async (transaction) => {
              await transaction.query('SELECT release_routing_permit($1)', [permitId]);
            })
            // Unreachable database: the lease expiry returns the permit instead.
            .catch(() => undefined)
            .finally(settle);
          return released;
        },
      };
    },
    async drain(timeoutMilliseconds) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMilliseconds));
      });
      await Promise.race([Promise.all([...outstanding]), deadline]);
      clearTimeout(timer);
    },
  };
}
