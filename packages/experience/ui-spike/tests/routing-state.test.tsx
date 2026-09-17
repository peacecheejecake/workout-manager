import { describe, expect, it, vi } from 'vitest';
import {
  createDeferredRoutingFixture,
  createRoutingStore,
  type RoutingRequest,
} from '../src/routing-state';

describe('offline route request lifetime', () => {
  it.each(['429', 'timeout', 'NoRoute'] as const)(
    'preserves draft on %s and retries only explicitly',
    async (scenario) => {
      const fixture = createDeferredRoutingFixture();
      const port = vi.fn(fixture.port);
      const store = createRoutingStore(port);
      store.getState().setScenario(scenario);
      const pending = store.getState().request();
      fixture.deliver();
      await pending;
      expect(store.getState()).toMatchObject({
        destination: 'B',
        draftRevision: 1,
        result: { status: 'error', reason: scenario },
      });
      expect(port).toHaveBeenCalledTimes(1);
      expect(fixture.count()).toBe(0);
      const retry = store.getState().request();
      expect(port).toHaveBeenCalledTimes(2);
      fixture.deliver();
      await retry;
    },
  );
  it('ignores a late successful old request after a newer result, including repeated destinations', async () => {
    const fixture = createDeferredRoutingFixture();
    const store = createRoutingStore(fixture.port);
    store.getState().setScenario('success');
    const first = store.getState().request();
    store.getState().editDestination();
    store.getState().editDestination();
    const second = store.getState().request();
    fixture.deliver('latest');
    await second;
    const latest = store.getState().result;
    expect(latest.status).toBe('computed');
    fixture.deliver();
    await first;
    expect(store.getState().result).toBe(latest);
    expect(store.getState().draftRevision).toBe(3);
    store.getState().editDestination();
    expect(store.getState().result).toEqual({ status: 'idle' });
  });
  it('aborts cancellation and disposal, ignores malformed late work and starts fresh per mount', async () => {
    let resolve: (value: unknown) => void = () => {};
    let signal: AbortSignal | undefined;
    const store = createRoutingStore((input) => {
      signal = input.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const pending = store.getState().request();
    store.getState().cancel();
    expect(signal?.aborted).toBe(true);
    resolve(null);
    await pending;
    expect(store.getState().result).toEqual({ status: 'cancelled' });
    const second = store.getState().request();
    store.getState().dispose();
    const disposed = store.getState();
    resolve(null);
    await second;
    expect(store.getState()).toBe(disposed);
    expect(signal?.aborted).toBe(true);
    expect(createRoutingStore(async () => null).getState()).toMatchObject({
      draftRevision: 1,
      destination: 'B',
      result: { status: 'idle' },
    });
  });
  it('handles actual transport rejection only while its request remains active', async () => {
    let rejectPending: (reason: Error) => void = () => {};
    const store = createRoutingStore(
      () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject;
        }),
    );
    const cancelled = store.getState().request();
    store.getState().cancel();
    rejectPending(new Error('Synthetic transport rejection after cancellation'));
    await expect(cancelled).resolves.toBeUndefined();
    expect(store.getState().result).toEqual({ status: 'cancelled' });
    const active = store.getState().request();
    rejectPending(new Error('Synthetic active transport rejection'));
    await expect(active).resolves.toBeUndefined();
    expect(store.getState().result).toEqual({ status: 'error', reason: 'request_failed' });
  });
  it.each(['null', 'stale-id', 'nonfinite', 'wrong-target', 'extra-field'])(
    'rejects malformed %s responses without straight-line fallback',
    async (kind) => {
      const store = createRoutingStore(async (input) => {
        const value = {
          kind: 'success',
          requestId: input.requestId,
          draftRevision: input.draftRevision,
          points: [
            { x: 20, y: 20 },
            { x: 80, y: 20 },
          ],
        };
        if (kind === 'null') return null;
        if (kind === 'stale-id') return { ...value, requestId: input.requestId + 1 };
        if (kind === 'extra-field') return { ...value, source: 'not trusted' };
        return {
          ...value,
          points: [
            { x: 20, y: 20 },
            { x: kind === 'nonfinite' ? Infinity : 50, y: 20 },
          ],
        };
      });
      await store.getState().request();
      expect(store.getState().result).toEqual({ status: 'error', reason: 'invalid_response' });
    },
  );
  it('holds one active request, snapshots scenario and bounds the deferred fixture queue', async () => {
    const fixture = createDeferredRoutingFixture();
    const store = createRoutingStore(fixture.port);
    const first = store.getState().request();
    await store.getState().request();
    expect(fixture.count()).toBe(1);
    store.getState().setScenario('success');
    fixture.deliver();
    await first;
    expect(store.getState().result).toEqual({ status: 'error', reason: '429' });
    const input: RoutingRequest = {
      requestId: 1,
      draftRevision: 1,
      destination: 'B',
      scenario: 'success',
      signal: new AbortController().signal,
    };
    const waits = Array.from({ length: 20 }, () => fixture.port(input));
    await expect(fixture.port(input)).rejects.toThrow('FIXTURE_QUEUE_LIMIT');
    fixture.clear();
    await Promise.all(waits);
    expect(fixture.count()).toBe(0);
  });
});
