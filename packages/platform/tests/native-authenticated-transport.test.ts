import { describe, expect, it, vi } from 'vitest';
import { createNativeBridgeClient, type NativeBridgePort } from '../src/native-bridge-client.js';
import { createNativeAuthenticatedTransport } from '../src/native-authenticated-transport.js';

const consent = { kind: 'ai', granted: false, revision: 3 };

function fixture(readReply: { status: 200 | 401; body: unknown }) {
  const sent: unknown[] = [];
  let id = 0;
  const port: NativeBridgePort = {
    async exchange(request) {
      sent.push(request);
      if (request.kind === 'hello')
        return {
          kind: 'hello.result',
          version: 2,
          id: request.id,
          capabilities: {
            'app.openSettings': true,
            'healthkit.read': false,
            'auth.transport': true,
          },
        };
      return {
        kind: 'command.result',
        version: 2,
        id: request.id,
        method: 'api.read',
        path: request.method === 'api.read' ? request.payload.path : '/bff/v1/session',
        ...readReply,
      };
    },
  };
  const bridge = createNativeBridgeClient({ port, createId: () => `req_${++id}` });
  return { bridge, sent };
}

describe('native authenticated transport', () => {
  it('forwards only canonical fixed reads, without credentials', async () => {
    const { bridge, sent } = fixture({ status: 200, body: consent });
    expect((await bridge.connect()).ok).toBe(true);
    const unauthorized = vi.fn();
    const transport = createNativeAuthenticatedTransport(bridge, unauthorized);
    expect(
      await transport.request({
        path: '/bff/v1/consents/ai',
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }),
    ).toEqual({ status: 200, body: consent, traceId: null });
    expect(sent[1]).toMatchObject({ method: 'api.read', payload: { path: '/bff/v1/consents/ai' } });
    expect(JSON.stringify(sent)).not.toMatch(/accessToken|bearer|verifier/);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('rejects writes, arbitrary paths, bodies, and idempotency keys before bridge dispatch', async () => {
    const { bridge, sent } = fixture({ status: 200, body: consent });
    expect((await bridge.connect()).ok).toBe(true);
    const transport = createNativeAuthenticatedTransport(bridge, vi.fn());
    for (const request of [
      { path: '/bff/v1/consents/ai', method: 'PUT', body: null, idempotencyKey: null },
      { path: '/bff/v1/activities', method: 'GET', body: null, idempotencyKey: null },
      { path: '/bff/v1/session?x=1', method: 'GET', body: null, idempotencyKey: null },
      { path: '/bff/v1/session', method: 'GET', body: {}, idempotencyKey: null },
      { path: '/bff/v1/session', method: 'GET', body: null, idempotencyKey: 'key' },
    ] as const) {
      await expect(transport.request(request)).rejects.toThrow(TypeError);
    }
    expect(sent).toHaveLength(1);
  });

  it('invalidates WebView scope when native reports 401', async () => {
    const { bridge } = fixture({ status: 401, body: null });
    expect((await bridge.connect()).ok).toBe(true);
    const unauthorized = vi.fn();
    const transport = createNativeAuthenticatedTransport(bridge, unauthorized);
    expect(
      await transport.request({
        path: '/bff/v1/session',
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }),
    ).toEqual({ status: 401, body: null, traceId: null });
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});
