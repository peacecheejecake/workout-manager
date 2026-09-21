import type { WalkingRouteResult } from '@workout/contracts/routing';
import {
  RoutingRequestError,
  type WalkingRouteComputation,
} from '@workout/server-integrations/routing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

/**
 * Internal routing endpoint (M2-01g).
 *
 * The browser talks to us, never to the routing engine: this handler is the only way in,
 * ownership comes from the authenticated session, and the request body carries no URL,
 * host, engine or profile override. The engine endpoint is operations configuration held
 * by the injected service.
 *
 * A computation is not a persisted route. Nothing here writes to the database, so a
 * failure leaves the caller's uncomputed draft exactly as it was.
 */
export interface WalkingRoutePort {
  compute(
    athleteId: string,
    request: unknown,
    context: { readonly signal?: AbortSignal },
  ): Promise<WalkingRouteComputation>;
}

/** Waypoint arrays are small; the bound is far below the app default and is enforced here. */
const ROUTING_BODY_LIMIT = 8 * 1024;

/**
 * Outcomes are carried in the body so the client can tell them apart, and the status code
 * still says what kind of answer it is. A straight line is never among them.
 */
function statusFor(outcome: WalkingRouteResult['outcome']): number {
  switch (outcome) {
    case 'route_computed':
    case 'no_route':
    case 'outside_coverage':
    case 'snap_too_far':
      return 200;
    case 'overloaded':
      return 429;
    case 'timeout':
    case 'compute_budget_exceeded':
      return 504;
    case 'cancelled':
      return 499;
    case 'engine_unavailable':
    case 'engine_contract_violation':
    case 'graph_mismatch':
      return 502;
  }
}

/**
 * Cancellation means the client went away, and nothing else.
 *
 * The obvious wiring is wrong: `close` on the REQUEST stream fires as soon as the request
 * body has been read, which on a normal POST happens long before the handler answers. That
 * turned every request whose computation took a few tens of milliseconds into a
 * cancellation. The response stream is the right one to watch, and even there `close`
 * fires on a normal finish too, so the signal is only raised when the response had not
 * been written out yet.
 */
function cancellationSignal(reply: FastifyReply): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  // The socket may already be gone before the handler starts.
  if (reply.raw.destroyed && !reply.raw.writableEnded) controller.abort();
  reply.raw.on('close', onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      reply.raw.off('close', onClose);
    },
  };
}

export function registerRoutingRoutes(
  routes: FastifyInstance,
  service: WalkingRoutePort,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post(
    '/routing/walking-routes',
    { bodyLimit: ROUTING_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      input(emptyQuery, request.query);
      const athleteId = principal(request).athleteId;
      const cancellation = cancellationSignal(reply);
      let computation: WalkingRouteComputation;
      try {
        computation = await service.compute(athleteId, request.body, {
          signal: cancellation.signal,
        });
      } catch (error) {
        if (error instanceof RoutingRequestError) throw new ProductRequestError(422, error.code);
        throw error;
      } finally {
        cancellation.dispose();
      }
      if (computation.retryAfterSeconds !== null)
        reply.header('retry-after', String(computation.retryAfterSeconds));
      return reply.code(statusFor(computation.result.outcome)).send(computation.result);
    },
  );
}
