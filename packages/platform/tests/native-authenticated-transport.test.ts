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
          version: 3,
          id: request.id,
          capabilities: {
            'app.openSettings': true,
            'healthkit.read': false,
            'healthkit.workouts': false,
            'auth.transport': true,
          },
        };
      return {
        kind: 'command.result',
        version: 3,
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

  it('carries only reviewed HealthKit decisions and activity reads through native bearer requests', async () => {
    const sent: unknown[] = [];
    let id = 0;
    const bridge = createNativeBridgeClient({
      createId: () => `request_${++id}`,
      port: {
        async exchange(request) {
          sent.push(request);
          if (request.kind === 'hello')
            return {
              kind: 'hello.result',
              version: 3,
              id: request.id,
              capabilities: {
                'app.openSettings': true,
                'healthkit.read': false,
                'healthkit.workouts': true,
                'auth.transport': true,
              },
            };
          if (request.method === 'api.activity.read')
            return {
              kind: 'command.result',
              version: 3,
              id: request.id,
              method: request.method,
              path: request.payload.path,
              status: 200,
              body: { items: [] },
            };
          if (request.method === 'api.healthkitDecision.write')
            return {
              kind: 'command.result',
              version: 3,
              id: request.id,
              method: request.method,
              status: 201,
              body: {
                sampleId: request.payload.body.sampleId,
                activityId: '11111111-1111-4111-8111-111111111111',
                activityRevision: 1,
                state: 'created_activity',
              },
            };
          throw new Error('Unexpected native method');
        },
      },
    });
    expect((await bridge.connect()).ok).toBe(true);
    const transport = createNativeAuthenticatedTransport(bridge, vi.fn());
    const query = '/bff/v1/activities?limit=20&offset=0&sort=started_desc';
    expect(
      (await transport.request({ path: query, method: 'GET', body: null, idempotencyKey: null }))
        .status,
    ).toBe(200);
    expect(
      (
        await transport.request({
          path: '/bff/v1/healthkit/workout-review?limit=50',
          method: 'GET',
          body: null,
          idempotencyKey: null,
        })
      ).status,
    ).toBe(200);
    const decision = {
      sampleId: '22222222-2222-4222-8222-222222222222',
      expectedSampleDigest: 'a'.repeat(64),
      confirmed: true,
      idempotencyKey: 'decision_123',
    };
    expect(
      (
        await transport.request({
          path: '/bff/v1/healthkit/workout-activities',
          method: 'POST',
          body: decision,
          idempotencyKey: decision.idempotencyKey,
        })
      ).status,
    ).toBe(201);
    expect(sent[3]).toMatchObject({
      method: 'api.healthkitDecision.write',
      payload: { kind: 'create', body: decision },
    });
    const link = {
      ...decision,
      targetActivityId: '11111111-1111-4111-8111-111111111111',
      expectedActivityRevision: 2,
    };
    expect(
      (
        await transport.request({
          path: '/bff/v1/healthkit/workout-bindings',
          method: 'POST',
          body: link,
          idempotencyKey: link.idempotencyKey,
        })
      ).status,
    ).toBe(201);
    expect(sent[4]).toMatchObject({
      method: 'api.healthkitDecision.write',
      payload: { kind: 'link', body: link },
    });
    for (const request of [
      { path: '/bff/v1/activities?athleteId=bob', method: 'GET', body: null, idempotencyKey: null },
      {
        path: '/bff/v1/activities?limit=20&limit=30',
        method: 'GET',
        body: null,
        idempotencyKey: null,
      },
      {
        path: '/bff/v1/healthkit/workout-activities',
        method: 'POST',
        body: decision,
        idempotencyKey: 'another_key',
      },
      {
        path: '/bff/v1/healthkit/workout-activities',
        method: 'POST',
        body: { ...decision, confirmed: false },
        idempotencyKey: decision.idempotencyKey,
      },
    ] as const)
      await expect(transport.request(request)).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(5);
    expect(JSON.stringify(sent)).not.toMatch(/accessToken|Bearer|refreshToken/);
  });
});
