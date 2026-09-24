import { routingLimits } from '@workout/contracts/routing';
import { ENGINE_HARD_STOP_GRACE_MILLISECONDS } from '@workout/server-integrations/routing';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROUTING_ENGINE_CONCURRENCY,
  ROUTING_PERMIT_LEASE_MILLISECONDS,
  routingEngineConcurrency,
} from '../src/routing-admission.js';

/**
 * Configuration of the shared routing limiter (M2-01ah). The limiter itself is asserted on
 * real PostgreSQL (`routing-admission.integration.test.ts` here and in persistence).
 */
describe('ROUTING_ENGINE_CONCURRENCY', () => {
  it('defaults when unset or blank', () => {
    expect(routingEngineConcurrency({})).toBe(DEFAULT_ROUTING_ENGINE_CONCURRENCY);
    expect(routingEngineConcurrency({ ROUTING_ENGINE_CONCURRENCY: '  ' })).toBe(
      DEFAULT_ROUTING_ENGINE_CONCURRENCY,
    );
  });

  it('takes a bounded whole number', () => {
    expect(routingEngineConcurrency({ ROUTING_ENGINE_CONCURRENCY: '1' })).toBe(1);
    expect(routingEngineConcurrency({ ROUTING_ENGINE_CONCURRENCY: ' 16 ' })).toBe(16);
    expect(routingEngineConcurrency({ ROUTING_ENGINE_CONCURRENCY: '1024' })).toBe(1024);
  });

  it.each(['0', '-1', '1025', '2.5', '8x', '0x10', '1e2', 'eight'])('refuses %s', (value) => {
    expect(() => routingEngineConcurrency({ ROUTING_ENGINE_CONCURRENCY: value })).toThrow(
      expect.objectContaining({
        code: 'ROUTING_CONFIGURATION_INVALID',
        keys: ['ROUTING_ENGINE_CONCURRENCY'],
      }),
    );
  });
});

describe('the permit lease', () => {
  it('outlasts the longest a live instance can hold a permit', () => {
    // A live instance releases when the engine stops, which is at most the deadline plus the
    // hard stop that cuts a silent engine. The lease must not run out before that, or a slow
    // but live computation would stop counting while the engine still works on it.
    expect(ROUTING_PERMIT_LEASE_MILLISECONDS).toBeGreaterThan(
      routingLimits.deadlineMilliseconds + ENGINE_HARD_STOP_GRACE_MILLISECONDS,
    );
    expect(ROUTING_PERMIT_LEASE_MILLISECONDS).toBeLessThanOrEqual(600_000);
  });
});
