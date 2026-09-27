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
    networkTimeoutMs: 100,
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
    expect(await client.signIn()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await client.session()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await client.signOut()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('accepts only the fixed nonsecret auth command results', async () => {
    const requests: Array<{ method: string; payload: unknown }> = [];
    const client = clientWith(async (request) => {
      if (request.kind === 'hello') {
        return {
          kind: 'hello.result',
          version: 2,
          id: request.id,
          capabilities: { ...capabilities, 'auth.transport': true },
        };
      }
      requests.push({ method: request.method, payload: request.payload });
      if (request.method === 'auth.signOut') {
        return {
          kind: 'command.result',
          version: 2,
          id: request.id,
          method: request.method,
          status: 'signed_out',
        };
      }
      return {
        kind: 'command.result',
        version: 2,
        id: request.id,
        method: request.method,
        session:
          request.method === 'auth.signIn'
            ? { state: 'signed_in', athleteId: 'athlete-a', expiresAt: '2026-09-27T12:00:00Z' }
            : { state: 'signed_out' },
      };
    });
    expect((await client.connect()).ok).toBe(true);
    expect(await client.signIn()).toEqual({
      ok: true,
      value: { state: 'signed_in', athleteId: 'athlete-a', expiresAt: '2026-09-27T12:00:00Z' },
    });
    expect(await client.session()).toEqual({ ok: true, value: { state: 'signed_out' } });
    expect(await client.signOut()).toEqual({ ok: true, value: undefined });
    expect(requests).toEqual([
      { method: 'auth.signIn', payload: {} },
      { method: 'auth.session', payload: {} },
      { method: 'auth.signOut', payload: {} },
    ]);
  });

  it('rejects auth results with tokens, mismatched methods, or reply IDs', async () => {
    for (const invalidReply of [
      { method: 'auth.signIn', session: { state: 'signed_out' }, accessToken: 'secret' },
      { method: 'auth.session', session: { state: 'signed_out' } },
      { method: 'auth.signIn', session: { state: 'signed_out' }, id: 'other' },
    ]) {
      const client = clientWith(async (request) =>
        request.kind === 'hello'
          ? {
              kind: 'hello.result',
              version: 2,
              id: request.id,
              capabilities: { ...capabilities, 'auth.transport': true },
            }
          : { kind: 'command.result', version: 2, id: request.id, ...invalidReply },
      );
      expect((await client.connect()).ok).toBe(true);
      expect(await client.signIn()).toEqual({ ok: false, code: 'INVALID_REPLY' });
    }
  });

  it('supports a long system sign-in while retaining ordinary command timeout and cancellation', async () => {
    vi.useFakeTimers();
    const client = clientWith(async (request) =>
      request.kind === 'hello'
        ? {
            kind: 'hello.result',
            version: 2,
            id: request.id,
            capabilities: { ...capabilities, 'auth.transport': true },
          }
        : new Promise(() => undefined),
    );
    expect((await client.connect()).ok).toBe(true);
    const signIn = client.signIn();
    await vi.advanceTimersByTimeAsync(100);
    let settled = false;
    void signIn.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const session = client.session();
    await vi.advanceTimersByTimeAsync(100);
    expect(await session).toEqual({ ok: false, code: 'TIMEOUT' });
    const controller = new AbortController();
    const cancelled = client.signOut(controller.signal);
    controller.abort();
    expect(await cancelled).toEqual({ ok: false, code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await signIn).toEqual({ ok: false, code: 'TIMEOUT' });
  });

  it('accepts only matching fixed read replies and keeps network calls alive beyond hello timeout', async () => {
    vi.useFakeTimers();
    let resolveRead: ((value: unknown) => void) | undefined;
    const client = createNativeBridgeClient({
      port: {
        exchange(request) {
          if (request.kind === 'hello')
            return Promise.resolve({
              kind: 'hello.result',
              version: 2,
              id: request.id,
              capabilities: { ...capabilities, 'auth.transport': true },
            });
          return new Promise((resolve) => {
            resolveRead = resolve;
          });
        },
      },
      createId: (() => {
        let n = 0;
        return () => `req_${++n}`;
      })(),
      timeoutMs: 100,
      networkTimeoutMs: 35_000,
    });
    expect((await client.connect()).ok).toBe(true);
    const read = client.read('/bff/v1/consents/ai');
    await vi.advanceTimersByTimeAsync(101);
    resolveRead?.({
      kind: 'command.result',
      version: 2,
      id: 'req_2',
      method: 'api.read',
      path: '/bff/v1/consents/ai',
      status: 200,
      body: { kind: 'ai', granted: false, revision: 2 },
    });
    expect(await read).toEqual({
      ok: true,
      value: {
        status: 200,
        body: { kind: 'ai', granted: false, revision: 2 },
      },
    });
  });

  it('rejects mismatched paths and credential fields in read replies', async () => {
    for (const replyFields of [
      { path: '/bff/v1/session', status: 200, body: { athleteId: 'a' } },
      {
        path: '/bff/v1/consents/ai',
        status: 200,
        body: { kind: 'ai', granted: true, revision: 1 },
        token: 'secret',
      },
      { path: '/bff/v1/consents/ai', status: 401, body: { error: 'UNAUTHENTICATED' } },
    ]) {
      const client = clientWith(async (request) =>
        request.kind === 'hello'
          ? {
              kind: 'hello.result',
              version: 2,
              id: request.id,
              capabilities: { ...capabilities, 'auth.transport': true },
            }
          : {
              kind: 'command.result',
              version: 2,
              id: request.id,
              method: 'api.read',
              ...replyFields,
            },
      );
      expect((await client.connect()).ok).toBe(true);
      expect(await client.read('/bff/v1/consents/ai')).toEqual({
        ok: false,
        code: 'INVALID_REPLY',
      });
    }
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
