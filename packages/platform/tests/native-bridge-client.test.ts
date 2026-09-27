import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeBridgeClient, type NativeBridgePort } from '../src/native-bridge-client.js';

const capabilities = {
  'app.openSettings': true,
  'healthkit.read': false,
  'auth.transport': false,
} as const;

function clientWith(exchange: NativeBridgePort['exchange']) {
  let number = 0;
  return createNativeBridgeClient({
    port: { exchange },
    createId: () => `req_${++number}`,
    timeoutMs: 100,
  });
}

afterEach(() => vi.useRealTimers());

describe('native bridge client', () => {
  it('handshakes and sends the sole allowed command with a distinct ID', async () => {
    const seen: string[] = [];
    const client = clientWith(async (request) => {
      seen.push(request.id);
      return request.kind === 'hello'
        ? { kind: 'hello.result', version: 2, id: request.id, capabilities }
        : {
            kind: 'command.result',
            version: 2,
            id: request.id,
            method: 'app.openSettings',
            status: 'opened',
          };
    });
    expect(await client.connect()).toEqual({ ok: true, value: capabilities });
    expect(await client.openSettings()).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual(['req_1', 'req_2']);
  });

  it('does not send a command when disconnected or capability is unavailable', async () => {
    const exchange = vi.fn(async (request: { id: string }) => ({
      kind: 'hello.result',
      version: 2,
      id: request.id,
      capabilities: { ...capabilities, 'app.openSettings': false },
    }));
    const client = clientWith(exchange);
    expect(await client.openSettings()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(exchange).not.toHaveBeenCalled();
    expect((await client.connect()).ok).toBe(true);
    expect(await client.openSettings()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(exchange).toHaveBeenCalledTimes(1);
    const noPort = createNativeBridgeClient({ port: null, createId: () => 'req' });
    expect(await noPort.connect()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('does not let callers change the capability used for command admission', async () => {
    const exchange = vi.fn(async (request: { id: string }) => ({
      kind: 'hello.result',
      version: 2,
      id: request.id,
      capabilities: { ...capabilities, 'app.openSettings': false },
    }));
    const client = clientWith(exchange);
    const result = await client.connect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Reflect.set(result.value, 'app.openSettings', true)).toBe(false);
    expect(Reflect.set(client.getCapabilities() ?? {}, 'app.openSettings', true)).toBe(false);
    expect(await client.openSettings()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('rejects old and future replies, invalid payloads, and mismatched IDs', async () => {
    for (const version of [1, 3]) {
      const client = clientWith(async (request) => ({
        kind: 'hello.result',
        version,
        id: request.id,
        capabilities,
      }));
      expect(await client.connect()).toEqual({ ok: false, code: 'UNSUPPORTED_VERSION' });
    }
    expect(
      await clientWith(async () => ({
        kind: 'hello.result',
        version: 2,
        id: 'wrong',
        capabilities,
      })).connect(),
    ).toEqual({ ok: false, code: 'INVALID_REPLY' });
    expect(
      await clientWith(async (request) => ({
        kind: 'hello.result',
        version: 2,
        id: request.id,
        capabilities,
        token: 'secret',
      })).connect(),
    ).toEqual({ ok: false, code: 'INVALID_REPLY' });
    expect(
      await clientWith(async (request) => ({
        kind: 'command.result',
        version: 2,
        id: request.id,
        method: 'app.openSettings',
        status: 'opened',
      })).connect(),
    ).toEqual({ ok: false, code: 'INVALID_REPLY' });
  });

  it('rejects an invalid generated request ID before calling the port', async () => {
    const exchange = vi.fn(async () => null);
    const client = createNativeBridgeClient({ port: { exchange }, createId: () => 'bad id' });
    expect(await client.connect()).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('passes a host unsupported-method error explicitly', async () => {
    const client = clientWith(async (request) =>
      request.kind === 'hello'
        ? { kind: 'hello.result', version: 2, id: request.id, capabilities }
        : { kind: 'error', version: 2, id: request.id, code: 'UNSUPPORTED_METHOD' },
    );
    expect((await client.connect()).ok).toBe(true);
    expect(await client.openSettings()).toEqual({ ok: false, code: 'UNSUPPORTED_METHOD' });
  });

  it('returns timeout and cancellation without accepting late replies', async () => {
    vi.useFakeTimers();
    const client = clientWith(() => new Promise(() => undefined));
    const timed = client.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(await timed).toEqual({ ok: false, code: 'TIMEOUT' });

    const controller = new AbortController();
    const cancelled = client.connect(controller.signal);
    controller.abort();
    expect(await cancelled).toEqual({ ok: false, code: 'CANCELLED' });
  });

  it('maps thrown port failures to unavailable', async () => {
    const client = clientWith(async () => {
      throw new Error('native unavailable');
    });
    expect(await client.connect()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('does not restore capabilities from a superseded handshake', async () => {
    let finishFirst: ((reply: unknown) => void) | undefined;
    const client = clientWith((request) => {
      if (request.id === 'req_1') {
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve({
        kind: 'hello.result',
        version: 2,
        id: request.id,
        capabilities: { ...capabilities, 'app.openSettings': false },
      });
    });
    const first = client.connect();
    const second = client.connect();
    expect(await second).toEqual({
      ok: true,
      value: { ...capabilities, 'app.openSettings': false },
    });
    finishFirst?.({ kind: 'hello.result', version: 2, id: 'req_1', capabilities });
    expect(await first).toEqual({ ok: false, code: 'CANCELLED' });
    expect(client.getCapabilities()).toEqual({ ...capabilities, 'app.openSettings': false });
  });
});
