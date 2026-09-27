import { describe, expect, it } from 'vitest';
import {
  nativeBridgeReplySchema,
  nativeBridgeRequestSchema,
  validateNativeBridgeRequest,
} from '../src/native-bridge.js';

describe('native bridge v3 boundary', () => {
  it('rejects a v2 hello and every v2 command before dispatch', () => {
    for (const input of [
      { kind: 'hello', version: 2, id: 'old' },
      {
        kind: 'command',
        version: 2,
        id: 'old',
        method: 'api.read',
        payload: { path: '/bff/v1/session' },
      },
      {
        kind: 'command',
        version: 2,
        id: 'old',
        method: 'healthkit.workouts.requestAccess',
        payload: {},
      },
    ])
      expect(validateNativeBridgeRequest(input)).toEqual({
        ok: false,
        code: 'UNSUPPORTED_VERSION',
      });
  });

  it('admits only fixed HealthKit consent and workout commands', () => {
    const base = { kind: 'command', version: 3, id: 'health_1' };
    for (const method of ['healthkit.workouts.requestAccess', 'healthkit.workouts.status']) {
      expect(nativeBridgeRequestSchema.safeParse({ ...base, method, payload: {} }).success).toBe(
        true,
      );
      expect(
        nativeBridgeRequestSchema.safeParse({ ...base, method, payload: { sampleId: 'secret' } })
          .success,
      ).toBe(false);
    }
    const write = {
      ...base,
      method: 'api.healthkitConsent.write',
      payload: {
        granted: true,
        expectedRevision: 0,
        idempotencyKey: 'consent_123',
      },
    };
    expect(nativeBridgeRequestSchema.safeParse(write).success).toBe(true);
    for (const payload of [
      { ...write.payload, token: 'secret' },
      { ...write.payload, expectedRevision: -1 },
      { ...write.payload, idempotencyKey: 'short' },
      { ...write.payload, granted: 'true' },
    ])
      expect(nativeBridgeRequestSchema.safeParse({ ...write, payload }).success).toBe(false);
    expect(
      nativeBridgeRequestSchema.safeParse({
        ...base,
        method: 'api.read',
        payload: { path: '/bff/v1/consents/healthkit' },
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeRequestSchema.safeParse({
        ...base,
        method: 'api.read',
        payload: { path: '/bff/v1/healthkit/workout-batches' },
      }).success,
    ).toBe(false);
  });

  it('keeps HealthKit replies to bounded summaries and exact consent outcomes', () => {
    const base = { kind: 'command.result', version: 3, id: 'health_1' };
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        method: 'healthkit.workouts.requestAccess',
        status: 'requested',
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        method: 'healthkit.workouts.status',
        status: {
          requestState: 'requested',
          pendingCount: 256,
          pauseReason: null,
        },
      }).success,
    ).toBe(true);
    for (const status of [
      { requestState: 'granted', pendingCount: 0, pauseReason: null },
      { requestState: 'requested', pendingCount: 257, pauseReason: null },
      { requestState: 'requested', pendingCount: 0, pauseReason: null, sampleId: 'raw' },
    ])
      expect(
        nativeBridgeReplySchema.safeParse({ ...base, method: 'healthkit.workouts.status', status })
          .success,
      ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        method: 'api.healthkitConsent.write',
        status: 409,
        code: 'CONSENT_CONFLICT',
        body: null,
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        method: 'api.healthkitConsent.write',
        status: 200,
        body: { kind: 'healthkit', granted: false, revision: 2, token: 'secret' },
      }).success,
    ).toBe(false);
  });
  it('allows only a strict handshake and fixed commands with empty payloads', () => {
    expect(validateNativeBridgeRequest({ kind: 'hello', version: 3, id: 'req_1' }).ok).toBe(true);
    expect(
      validateNativeBridgeRequest({
        kind: 'command',
        version: 3,
        id: 'req_2',
        method: 'app.openSettings',
        payload: {},
      }).ok,
    ).toBe(true);
    expect(
      nativeBridgeRequestSchema.safeParse({
        kind: 'command',
        version: 3,
        id: 'req_2',
        method: 'app.openSettings',
        payload: { url: 'https://example.com' },
      }).success,
    ).toBe(false);
    for (const method of ['auth.signIn', 'auth.session', 'auth.signOut']) {
      expect(
        nativeBridgeRequestSchema.safeParse({
          kind: 'command',
          version: 3,
          id: 'req_auth',
          method,
          payload: {},
        }).success,
      ).toBe(true);
      expect(
        nativeBridgeRequestSchema.safeParse({
          kind: 'command',
          version: 3,
          id: 'req_auth',
          method,
          payload: { verifier: 'secret', url: 'https://example.com' },
        }).success,
      ).toBe(false);
    }
  });

  it('classifies old and future versions and unknown methods', () => {
    for (const version of [1, 2, 4]) {
      expect(validateNativeBridgeRequest({ kind: 'hello', version, id: 'req' })).toEqual({
        ok: false,
        code: 'UNSUPPORTED_VERSION',
      });
    }
    expect(
      validateNativeBridgeRequest({
        kind: 'command',
        version: 3,
        id: 'req',
        method: 'fetch',
        payload: { url: 'https://example.com' },
      }),
    ).toEqual({ ok: false, code: 'UNSUPPORTED_METHOD' });
    expect(validateNativeBridgeRequest(null)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(
      validateNativeBridgeRequest({ kind: 'hello', version: 3, id: '', token: 'secret' }),
    ).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('rejects raw health records, tokens, and unexpected reply payloads', () => {
    const base = { kind: 'hello.result', version: 3, id: 'req' };
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        capabilities: {
          'app.openSettings': true,
          'healthkit.read': false,
          'healthkit.workouts': false,
          'auth.transport': false,
        },
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        capabilities: {
          'app.openSettings': true,
          'healthkit.read': true,
          'healthkit.workouts': false,
          'auth.transport': false,
        },
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        capabilities: {
          'app.openSettings': true,
          'healthkit.read': false,
          'healthkit.workouts': false,
          'auth.transport': false,
        },
        token: 'secret',
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        kind: 'command.result',
        version: 3,
        id: 'req',
        method: 'app.openSettings',
        status: 'opened',
        rawHealth: [],
      }).success,
    ).toBe(false);
  });

  it('accepts bounded nonsecret native session results and rejects credentials', () => {
    const base = { kind: 'command.result', version: 3, id: 'req_auth' };
    for (const method of ['auth.signIn', 'auth.session']) {
      expect(
        nativeBridgeReplySchema.safeParse({
          ...base,
          method,
          session: { state: 'signed_out' },
        }).success,
      ).toBe(true);
      expect(
        nativeBridgeReplySchema.safeParse({
          ...base,
          method,
          session: {
            state: 'signed_in',
            athleteId: 'athlete-a',
            expiresAt: '2026-09-27T12:00:00Z',
          },
        }).success,
      ).toBe(true);
      for (const session of [
        { state: 'signed_in', athleteId: 'athlete-a', expiresAt: 'invalid' },
        { state: 'signed_in', athleteId: 'a'.repeat(201), expiresAt: '2026-09-27T12:00:00Z' },
        {
          state: 'signed_in',
          athleteId: 'athlete-a',
          expiresAt: '2026-09-27T12:00:00Z',
          token: 'secret',
        },
      ]) {
        expect(nativeBridgeReplySchema.safeParse({ ...base, method, session }).success).toBe(false);
      }
      expect(
        nativeBridgeReplySchema.safeParse({
          ...base,
          method,
          session: { state: 'signed_out' },
          accessToken: 'secret',
        }).success,
      ).toBe(false);
    }
    expect(
      nativeBridgeReplySchema.safeParse({ ...base, method: 'auth.signOut', status: 'signed_out' })
        .success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        method: 'auth.signOut',
        status: 'signed_out',
        refreshToken: 'secret',
      }).success,
    ).toBe(false);
  });

  it('permits only two fixed read paths and canonical nonsecret responses', () => {
    for (const path of ['/bff/v1/session', '/bff/v1/consents/ai']) {
      expect(
        nativeBridgeRequestSchema.safeParse({
          kind: 'command',
          version: 3,
          id: 'read_1',
          method: 'api.read',
          payload: { path },
        }).success,
      ).toBe(true);
      expect(
        nativeBridgeReplySchema.safeParse({
          kind: 'command.result',
          version: 3,
          id: 'read_1',
          method: 'api.read',
          path,
          status: 401,
          body: null,
        }).success,
      ).toBe(true);
    }
    for (const payload of [
      { path: '/bff/v1/auth/logout' },
      { path: '/bff/v1/session?athleteId=other' },
      { path: '/bff/v1/session', method: 'POST' },
      { path: '/bff/v1/session', body: {} },
      { path: '/bff/v1/session', token: 'secret' },
    ]) {
      expect(
        nativeBridgeRequestSchema.safeParse({
          kind: 'command',
          version: 3,
          id: 'read_1',
          method: 'api.read',
          payload,
        }).success,
      ).toBe(false);
    }
    for (const [path, body] of [
      ['/bff/v1/session', { athleteId: 'athlete-a' }],
      ['/bff/v1/consents/ai', { kind: 'ai', granted: false, revision: 0 }],
    ] as const) {
      expect(
        nativeBridgeReplySchema.safeParse({
          kind: 'command.result',
          version: 3,
          id: 'read_1',
          method: 'api.read',
          path,
          status: 200,
          body,
        }).success,
      ).toBe(true);
    }
    for (const [path, status, body] of [
      ['/bff/v1/session', 200, { athleteId: 'athlete-a', accessToken: 'secret' }],
      ['/bff/v1/consents/ai', 200, { kind: 'ai', granted: true, revision: -1 }],
      ['/bff/v1/consents/ai', 200, { athleteId: 'athlete-a' }],
      ['/bff/v1/session', 401, { athleteId: 'athlete-a' }],
      ['/bff/v1/session', 500, null],
    ] as const) {
      expect(
        nativeBridgeReplySchema.safeParse({
          kind: 'command.result',
          version: 3,
          id: 'read_1',
          method: 'api.read',
          path,
          status,
          body,
        }).success,
      ).toBe(false);
    }
  });
});
