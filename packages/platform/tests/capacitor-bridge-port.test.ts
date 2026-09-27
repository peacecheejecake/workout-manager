import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCapacitorBridgePort,
  type CapacitorBridgeEnvironment,
} from '../src/capacitor-bridge-port.js';
import { createNativeBridgeClient } from '../src/native-bridge-client.js';

const request = { kind: 'hello', version: 2, id: 'hello_1' } as const;
const reply = {
  kind: 'hello.result',
  version: 2,
  id: 'hello_1',
  capabilities: {
    'app.openSettings': true,
    'healthkit.read': false,
    'auth.transport': false,
  },
};

function environment(result: unknown, available = true) {
  const exchange = vi.fn(async () => result);
  const cancel = vi.fn(async () => ({ status: 'cancelled' }));
  const context: CapacitorBridgeEnvironment = {
    isNativePlatform: () => true,
    isPluginAvailable: () => available,
    plugin: { exchange, cancel },
  };
  return { context, exchange, cancel };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Capacitor bridge port', () => {
  it('passes only a versioned request to the registered plugin and extracts its reply', async () => {
    const { context, exchange } = environment({ reply });
    const result = await createCapacitorBridgePort(context).exchange(
      request,
      new AbortController().signal,
    );
    expect(result).toEqual(reply);
    expect(exchange).toHaveBeenCalledExactlyOnceWith({ request });
  });

  it('does not dispatch on web, missing plugin, or an already cancelled request', async () => {
    const web = environment({ reply });
    web.context.isNativePlatform = () => false;
    await expect(
      createCapacitorBridgePort(web.context).exchange(request, new AbortController().signal),
    ).rejects.toThrow('unavailable');
    expect(web.exchange).not.toHaveBeenCalled();

    const missing = environment({ reply }, false);
    await expect(
      createCapacitorBridgePort(missing.context).exchange(request, new AbortController().signal),
    ).rejects.toThrow('unavailable');
    expect(missing.exchange).not.toHaveBeenCalled();

    const cancelled = environment({ reply });
    const controller = new AbortController();
    controller.abort();
    await expect(
      createCapacitorBridgePort(cancelled.context).exchange(request, controller.signal),
    ).rejects.toThrow('cancelled');
    expect(cancelled.exchange).not.toHaveBeenCalled();
    expect(cancelled.cancel).not.toHaveBeenCalled();
  });

  it('cancels one dispatched request and waits for the native acknowledgement', async () => {
    let resolveExchange: ((value: unknown) => void) | undefined;
    let resolveCancel: ((value: { status: string }) => void) | undefined;
    const { context, cancel } = environment({ reply });
    context.plugin.exchange = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExchange = resolve;
        }),
    );
    context.plugin.cancel = cancel.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const controller = new AbortController();
    const exchange = createCapacitorBridgePort(context).exchange(request, controller.signal);
    controller.abort();
    controller.abort();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: request.id });
    let settled = false;
    void exchange.catch(() => {
      settled = true;
    });
    resolveExchange?.({ reply });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveCancel?.({ status: 'cancelled' });
    await expect(exchange).rejects.toThrow('cancelled');
  });

  it('bounds missing cancellation acknowledgement and consumes cancellation rejection', async () => {
    vi.useFakeTimers();
    const { context, cancel } = environment({ reply });
    context.plugin.exchange = vi.fn(() => new Promise(() => undefined));
    cancel.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const exchange = createCapacitorBridgePort(context).exchange(request, controller.signal);
    const rejected = expect(exchange).rejects.toThrow('cancelled');
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);

    const failing = environment({ reply });
    failing.context.plugin.exchange = vi.fn(() => new Promise(() => undefined));
    failing.cancel.mockRejectedValue(new Error('private native detail'));
    const failedController = new AbortController();
    const failed = createCapacitorBridgePort(failing.context).exchange(
      request,
      failedController.signal,
    );
    const failedRejection = expect(failed).rejects.toThrow('cancelled');
    failedController.abort();
    await failedRejection;
    vi.useRealTimers();
  });

  it('sends a timeout cancellation and waits for native cleanup before returning', async () => {
    vi.useFakeTimers();
    let resolveExchange: ((value: unknown) => void) | undefined;
    let resolveCancel: ((value: { status: string }) => void) | undefined;
    const { context, cancel } = environment({ reply });
    context.plugin.exchange = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExchange = resolve;
        }),
    );
    cancel.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const client = createNativeBridgeClient({
      port: createCapacitorBridgePort(context),
      createId: () => request.id,
      timeoutMs: 25,
    });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(25);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: request.id });
    let completed = false;
    void connecting.then(() => {
      completed = true;
    });
    resolveExchange?.({ reply });
    await Promise.resolve();
    expect(completed).toBe(false);
    resolveCancel?.({ status: 'cancelled' });
    expect(await connecting).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(client.getCapabilities()).toBeNull();
    vi.useRealTimers();
  });

  it('returns an invalid envelope as an invalid client reply', async () => {
    for (const malformed of [null, {}, { result: reply }, 'unexpected']) {
      const { context } = environment(malformed);
      const client = createNativeBridgeClient({
        port: createCapacitorBridgePort(context),
        createId: () => request.id,
      });
      expect(await client.connect()).toEqual({ ok: false, code: 'INVALID_REPLY' });
    }
  });

  it('maps plugin unavailability and rejection without exposing plugin error text', async () => {
    const missing = environment({ reply }, false);
    const unavailable = createNativeBridgeClient({
      port: createCapacitorBridgePort(missing.context),
      createId: () => request.id,
    });
    expect(await unavailable.connect()).toEqual({ ok: false, code: 'UNAVAILABLE' });

    const failing = environment({ reply });
    failing.context.plugin.exchange = vi.fn(async () => {
      throw new Error('sensitive native error');
    });
    const rejected = createNativeBridgeClient({
      port: createCapacitorBridgePort(failing.context),
      createId: () => request.id,
    });
    expect(await rejected.connect()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});
