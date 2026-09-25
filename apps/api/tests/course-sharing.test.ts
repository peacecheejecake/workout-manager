import { describe, expect, it } from 'vitest';

import {
  clientRateKey,
  courseSharingFromEnvironment,
  createShareToken,
  resolveClientAddress,
  shareTokenDigest,
} from '../src/course-sharing.js';

/** M2-01k-o B: the flag, the token and the client address, without a database. */
describe('the sharing flag (D1, B-4, B-5)', () => {
  const key = Buffer.alloc(32, 3).toString('base64');

  it('is off when nothing is set, and when set to off', () => {
    expect(courseSharingFromEnvironment({}).enabled).toBe(false);
    expect(courseSharingFromEnvironment({ COURSE_SHARING: 'off' }).enabled).toBe(false);
  });

  it('refuses to start on without a share epoch or a rate key — there is no default', () => {
    expect(() =>
      courseSharingFromEnvironment({ COURSE_SHARING: 'on', COURSE_SHARE_RATE_KEY: key }),
    ).toThrow('COURSE_SHARE_EPOCH_REQUIRED');
    // (Each case below lacks only the setting it names.)
    expect(() =>
      courseSharingFromEnvironment({
        COURSE_SHARING: 'on',
        COURSE_SHARE_EPOCH: '0',
        COURSE_SHARE_RATE_KEY: key,
      }),
    ).toThrow('COURSE_SHARE_EPOCH_REQUIRED');
    expect(() =>
      courseSharingFromEnvironment({ COURSE_SHARING: 'on', COURSE_SHARE_EPOCH: '3' }),
    ).toThrow('COURSE_SHARE_RATE_KEY_REQUIRED');
    expect(() =>
      courseSharingFromEnvironment({
        COURSE_SHARING: 'on',
        COURSE_SHARE_EPOCH: '3',
        COURSE_SHARE_RATE_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toThrow('COURSE_SHARE_RATE_KEY_REQUIRED');
    expect(() => courseSharingFromEnvironment({ COURSE_SHARING: 'yes' })).toThrow();
  });

  // Peer review r1 item 7: every shell proxies, so without the proxies every recipient
  // would share one counter.
  it('refuses to start on without trusted proxies', () => {
    for (const proxies of [undefined, '', ' , '])
      expect(() =>
        courseSharingFromEnvironment({
          COURSE_SHARING: 'on',
          COURSE_SHARE_EPOCH: '4',
          COURSE_SHARE_RATE_KEY: key,
          ...(proxies === undefined ? {} : { COURSE_SHARE_TRUSTED_PROXIES: proxies }),
        }),
      ).toThrow('COURSE_SHARE_TRUSTED_PROXIES_REQUIRED');
  });

  it('is on with its epoch, key and trusted proxies', () => {
    const on = courseSharingFromEnvironment({
      COURSE_SHARING: 'on',
      COURSE_SHARE_EPOCH: '4',
      COURSE_SHARE_RATE_KEY: key,
      COURSE_SHARE_TRUSTED_PROXIES: '10.0.0.1, 10.0.0.2',
    });
    expect(on).toMatchObject({ enabled: true, epoch: 4, trustedProxies: ['10.0.0.1', '10.0.0.2'] });
    expect(() =>
      courseSharingFromEnvironment({
        COURSE_SHARING: 'on',
        COURSE_SHARE_EPOCH: '4',
        COURSE_SHARE_RATE_KEY: key,
        COURSE_SHARE_TRUSTED_PROXIES: 'proxy.example',
      }),
    ).toThrow('COURSE_SHARE_TRUSTED_PROXIES_INVALID');
  });
});

describe('the link token', () => {
  it('is 256 random bits in base64url, independent each time, kept only as a digest', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createShareToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(shareTokenDigest(token)).toMatch(/^[a-f0-9]{64}$/);
      expect(shareTokenDigest(token)).not.toContain(token);
    }
  });
});

describe('the client address (B-4, T23)', () => {
  it('believes only a trusted proxy about whom it forwarded', () => {
    expect(resolveClientAddress('198.51.100.9', '203.0.113.1', [])).toBe('198.51.100.9');
    expect(resolveClientAddress('198.51.100.9', '203.0.113.1', ['10.0.0.1'])).toBe('198.51.100.9');
    expect(resolveClientAddress('10.0.0.1', '203.0.113.1', ['10.0.0.1'])).toBe('203.0.113.1');
    expect(resolveClientAddress('::ffff:10.0.0.1', '203.0.113.1', ['10.0.0.1'])).toBe(
      '203.0.113.1',
    );
    // The rightmost untrusted hop: a forged left part is ignored.
    expect(
      resolveClientAddress('10.0.0.1', '1.2.3.4, 203.0.113.1, 10.0.0.2', ['10.0.0.1', '10.0.0.2']),
    ).toBe('203.0.113.1');
    // Garbage from the proxy is not an address; the socket stands.
    expect(resolveClientAddress('10.0.0.1', 'not-an-address', ['10.0.0.1'])).toBe('10.0.0.1');
    expect(resolveClientAddress('10.0.0.1', undefined, ['10.0.0.1'])).toBe('10.0.0.1');
  });

  it('keys a client by a keyed HMAC, never by the address', () => {
    const one = clientRateKey('203.0.113.1', Buffer.alloc(32, 1));
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(one).not.toContain('203');
    expect(clientRateKey('203.0.113.1', Buffer.alloc(32, 2))).not.toBe(one);
  });
});
