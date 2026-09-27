import { describe, expect, it, vi } from 'vitest';
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
  const context: CapacitorBridgeEnvironment = {
    isNativePlatform: () => true,
    isPluginAvailable: () => available,
    plugin: { exchange },
  };
  return { context, exchange };
}

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
