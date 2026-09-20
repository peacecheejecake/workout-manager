import { describe, expect, it } from 'vitest';

import {
  addressesEqual,
  assertSafeDnsAnswers,
  createExactHostAllowlist,
  IngestionPolicyError,
  isSafePublicAddress,
  parseAllowedUrl,
  type ResolvedAddress,
} from '../src/policy.js';

const policy = { allowedHosts: createExactHostAllowlist(['example.com', '例え.テスト']) };

describe('URL ingestion policy', () => {
  it('accepts only exact allowlisted HTTPS hosts on the default port', () => {
    expect(parseAllowedUrl('https://EXAMPLE.com:443/path?q=1', policy)).toMatchObject({
      hostname: 'example.com',
      normalizedUrl: 'https://example.com/path?q=1',
    });
    expect(parseAllowedUrl('https://例え.テスト/page', policy).hostname).toBe(
      'xn--r8jz45g.xn--zckzah',
    );

    for (const rejected of [
      'http://example.com/',
      'https://user@example.com/',
      'https://example.com:444/',
      'https://sub.example.com/',
      'https://example.com/#fragment',
      ' https://example.com/',
      'https://example.com\\private',
      'https://example.com/\u0085private',
      'https://example.com/\ud800',
    ]) {
      expect(() => parseAllowedUrl(rejected, policy)).toThrowError(
        new IngestionPolicyError('URL_NOT_ALLOWED'),
      );
    }
  });

  it('matches the contract URL length bound before and after normalization', () => {
    const prefix = 'https://example.com/';
    expect(parseAllowedUrl(`${prefix}${'a'.repeat(2048 - prefix.length)}`, policy).hostname).toBe(
      'example.com',
    );
    expect(() =>
      parseAllowedUrl(`${prefix}${'a'.repeat(2049 - prefix.length)}`, policy),
    ).toThrowError(new IngestionPolicyError('URL_NOT_ALLOWED'));
  });

  it('caps the redirect policy at five hops', () => {
    expect(() => parseAllowedUrl('https://example.com/', policy, 6)).toThrowError(
      new IngestionPolicyError('REDIRECT_LIMIT_EXCEEDED'),
    );
    expect(() =>
      parseAllowedUrl('https://example.com/', { ...policy, maxRedirectHops: 6 }, 0),
    ).toThrowError(new IngestionPolicyError('REDIRECT_LIMIT_EXCEEDED'));
  });
});

describe('IP address policy', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.2.4',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.2',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:5db8:d822::1',
    '3fff::1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
  ])('rejects non-public address %s', (address) => {
    expect(isSafePublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'accepts globally routable address %s',
    (address) => {
      expect(isSafePublicAddress(address)).toBe(true);
    },
  );

  it('fails closed when any DNS answer is unsafe', () => {
    expect(() =>
      assertSafeDnsAnswers([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).toThrowError(new IngestionPolicyError('DNS_ADDRESS_REJECTED'));
  });

  it('accepts at most eight validated DNS answers', () => {
    const eightAnswers = Array.from({ length: 8 }, (_value, index): ResolvedAddress => ({
      address: `8.8.8.${index + 1}`,
      family: 4,
    }));
    expect(assertSafeDnsAnswers(eightAnswers)).toHaveLength(8);
    expect(() =>
      assertSafeDnsAnswers([...eightAnswers, { address: '8.8.4.4', family: 4 }]),
    ).toThrowError(new IngestionPolicyError('DNS_ADDRESS_REJECTED'));
  });

  it('deduplicates equivalent safe answers and compares mapped socket addresses', () => {
    expect(
      assertSafeDnsAnswers([
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
      ]),
    ).toHaveLength(1);
    expect(addressesEqual('8.8.8.8', '::ffff:8.8.8.8')).toBe(true);
    expect(addressesEqual('8.8.8.8', '8.8.4.4')).toBe(false);
  });
});
