import { describe, expect, it } from 'vitest';
import {
  nativeBridgeReplySchema,
  nativeBridgeRequestSchema,
  validateNativeBridgeRequest,
} from '../src/native-bridge.js';

describe('native bridge v2 boundary', () => {
  it('allows only a strict handshake and app.openSettings', () => {
    expect(validateNativeBridgeRequest({ kind: 'hello', version: 2, id: 'req_1' }).ok).toBe(true);
    expect(
      validateNativeBridgeRequest({
        kind: 'command',
        version: 2,
        id: 'req_2',
        method: 'app.openSettings',
        payload: {},
      }).ok,
    ).toBe(true);
    expect(
      nativeBridgeRequestSchema.safeParse({
        kind: 'command',
        version: 2,
        id: 'req_2',
        method: 'app.openSettings',
        payload: { url: 'https://example.com' },
      }).success,
    ).toBe(false);
  });

  it('classifies old and future versions and unknown methods', () => {
    for (const version of [1, 3]) {
      expect(validateNativeBridgeRequest({ kind: 'hello', version, id: 'req' })).toEqual({
        ok: false,
        code: 'UNSUPPORTED_VERSION',
      });
    }
    expect(
      validateNativeBridgeRequest({
        kind: 'command',
        version: 2,
        id: 'req',
        method: 'fetch',
        payload: { url: 'https://example.com' },
      }),
    ).toEqual({ ok: false, code: 'UNSUPPORTED_METHOD' });
    expect(validateNativeBridgeRequest(null)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(
      validateNativeBridgeRequest({ kind: 'hello', version: 2, id: '', token: 'secret' }),
    ).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('rejects raw health records, tokens, and unexpected reply payloads', () => {
    const base = { kind: 'hello.result', version: 2, id: 'req' };
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        capabilities: {
          'app.openSettings': true,
          'healthkit.read': false,
          'auth.transport': false,
        },
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        capabilities: { 'app.openSettings': true, 'healthkit.read': true, 'auth.transport': false },
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...base,
        capabilities: {
          'app.openSettings': true,
          'healthkit.read': false,
          'auth.transport': false,
        },
        token: 'secret',
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        kind: 'command.result',
        version: 2,
        id: 'req',
        method: 'app.openSettings',
        status: 'opened',
        rawHealth: [],
      }).success,
    ).toBe(false);
  });
});
