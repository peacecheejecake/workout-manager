import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const MAX_URL_CHARACTERS = 2048;
const MAX_REDIRECT_HOPS = 5;
export const MAX_RESOLVED_ADDRESSES = 8;

export type AddressFamily = 4 | 6;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: AddressFamily;
}

export interface UrlPolicy {
  readonly allowedHosts: ReadonlySet<string>;
  readonly maxRedirectHops?: number;
}

export interface AllowedUrl {
  readonly url: URL;
  readonly normalizedUrl: string;
  readonly hostname: string;
}

export class IngestionPolicyError extends Error {
  constructor(
    readonly code:
      | 'URL_NOT_ALLOWED'
      | 'REDIRECT_LIMIT_EXCEEDED'
      | 'DNS_ADDRESS_REJECTED'
      | 'REMOTE_ADDRESS_MISMATCH',
  ) {
    super(code);
    this.name = 'IngestionPolicyError';
  }
}

function hasForbiddenUrlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || (codeUnit >= 0x7f && codeUnit <= 0x9f) || codeUnit === 0x5c)
      return true;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function canonicalHost(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (!host || host.endsWith('.') || host.includes('\0')) return null;
  const withoutBrackets = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(withoutBrackets) !== 0) return withoutBrackets;
  const ascii = domainToASCII(host);
  if (!ascii || ascii.endsWith('.') || ascii.length > 253) return null;
  return ascii.toLowerCase();
}

export function createExactHostAllowlist(hosts: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of hosts) {
    const host = canonicalHost(value);
    if (host === null) throw new IngestionPolicyError('URL_NOT_ALLOWED');
    result.add(host);
  }
  if (result.size === 0) throw new IngestionPolicyError('URL_NOT_ALLOWED');
  return result;
}

export function parseAllowedUrl(value: string, policy: UrlPolicy, redirectHop = 0): AllowedUrl {
  const maxRedirectHops = policy.maxRedirectHops ?? MAX_REDIRECT_HOPS;
  if (
    !Number.isInteger(redirectHop) ||
    redirectHop < 0 ||
    redirectHop > maxRedirectHops ||
    maxRedirectHops < 0 ||
    maxRedirectHops > MAX_REDIRECT_HOPS
  ) {
    throw new IngestionPolicyError('REDIRECT_LIMIT_EXCEEDED');
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_URL_CHARACTERS ||
    value !== value.trim() ||
    hasForbiddenUrlCharacter(value) ||
    value.includes('#')
  )
    throw new IngestionPolicyError('URL_NOT_ALLOWED');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IngestionPolicyError('URL_NOT_ALLOWED');
  }
  const hostname = canonicalHost(url.hostname);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.port !== '' ||
    hostname === null ||
    !policy.allowedHosts.has(hostname)
  ) {
    throw new IngestionPolicyError('URL_NOT_ALLOWED');
  }
  url.hostname = hostname.includes(':') ? `[${hostname}]` : hostname;
  if (url.href.length > MAX_URL_CHARACTERS) throw new IngestionPolicyError('URL_NOT_ALLOWED');
  return { url, normalizedUrl: url.href, hostname };
}

function parseIpv4(value: string): Uint8Array | null {
  if (isIP(value) !== 4) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || !/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) return null;
    bytes[index] = number;
  }
  return bytes;
}

function ipv4TokenGroups(token: string): readonly number[] | null {
  const bytes = parseIpv4(token);
  if (bytes === null) return null;
  return [(bytes[0] ?? 0) * 256 + (bytes[1] ?? 0), (bytes[2] ?? 0) * 256 + (bytes[3] ?? 0)];
}

function parseIpv6Side(value: string): readonly number[] | null {
  if (value === '') return [];
  const tokens = value.split(':');
  const groups: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === '') return null;
    if (token.includes('.')) {
      if (index !== tokens.length - 1) return null;
      const ipv4Groups = ipv4TokenGroups(token);
      if (ipv4Groups === null) return null;
      groups.push(...ipv4Groups);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

function parseIpv6(value: string): Uint8Array | null {
  const normalized = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (normalized.includes('%') || isIP(normalized) !== 6) return null;
  const doubleColon = normalized.indexOf('::');
  if (doubleColon !== -1 && normalized.indexOf('::', doubleColon + 2) !== -1) return null;
  const left = parseIpv6Side(doubleColon === -1 ? normalized : normalized.slice(0, doubleColon));
  const right = parseIpv6Side(doubleColon === -1 ? '' : normalized.slice(doubleColon + 2));
  if (left === null || right === null) return null;
  const omitted = 8 - left.length - right.length;
  if ((doubleColon === -1 && omitted !== 0) || (doubleColon !== -1 && omitted < 1)) return null;
  const groups = [...left, ...new Array<number>(omitted).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function prefixMatches(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits);
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

const UNSAFE_IPV4_RANGES: readonly { readonly prefix: readonly number[]; readonly bits: number }[] =
  [
    { prefix: [0], bits: 8 },
    { prefix: [10], bits: 8 },
    { prefix: [100, 64], bits: 10 },
    { prefix: [127], bits: 8 },
    { prefix: [169, 254], bits: 16 },
    { prefix: [172, 16], bits: 12 },
    { prefix: [192, 0, 0], bits: 24 },
    { prefix: [192, 0, 2], bits: 24 },
    { prefix: [192, 52, 193], bits: 24 },
    { prefix: [192, 88, 99], bits: 24 },
    { prefix: [192, 168], bits: 16 },
    { prefix: [192, 175, 48], bits: 24 },
    { prefix: [198, 18], bits: 15 },
    { prefix: [198, 51, 100], bits: 24 },
    { prefix: [203, 0, 113], bits: 24 },
    { prefix: [224], bits: 4 },
    { prefix: [240], bits: 4 },
  ];

function isSafeIpv4Bytes(bytes: Uint8Array): boolean {
  return !UNSAFE_IPV4_RANGES.some((range) => prefixMatches(bytes, range.prefix, range.bits));
}

function mappedIpv4(bytes: Uint8Array): Uint8Array | null {
  const mappedPrefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
  if (!prefixMatches(bytes, mappedPrefix, 96)) return null;
  return bytes.slice(12);
}

function isSafeIpv6Bytes(bytes: Uint8Array): boolean {
  const mapped = mappedIpv4(bytes);
  if (mapped !== null) return isSafeIpv4Bytes(mapped);
  if (!prefixMatches(bytes, [0x20], 3)) return false;
  const unsafe: readonly { readonly prefix: readonly number[]; readonly bits: number }[] = [
    { prefix: [0x20, 0x01, 0x00, 0x00], bits: 32 },
    { prefix: [0x20, 0x01, 0x00, 0x02], bits: 48 },
    { prefix: [0x20, 0x01, 0x00, 0x10], bits: 28 },
    { prefix: [0x20, 0x01, 0x00, 0x20], bits: 28 },
    { prefix: [0x20, 0x01, 0x0d, 0xb8], bits: 32 },
    { prefix: [0x20, 0x02], bits: 16 },
    { prefix: [0x3f, 0xff], bits: 20 },
  ];
  return !unsafe.some((range) => prefixMatches(bytes, range.prefix, range.bits));
}

export function isSafePublicAddress(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) return isSafeIpv4Bytes(ipv4);
  const ipv6 = parseIpv6(value);
  return ipv6 !== null && isSafeIpv6Bytes(ipv6);
}

export function assertSafeDnsAnswers(
  answers: readonly ResolvedAddress[],
): readonly ResolvedAddress[] {
  if (answers.length === 0 || answers.length > MAX_RESOLVED_ADDRESSES)
    throw new IngestionPolicyError('DNS_ADDRESS_REJECTED');
  const seen = new Set<string>();
  const normalized: ResolvedAddress[] = [];
  for (const answer of answers) {
    if (answer.family !== isIP(answer.address) || !isSafePublicAddress(answer.address))
      throw new IngestionPolicyError('DNS_ADDRESS_REJECTED');
    const key = `${answer.family}:${addressBytes(answer.address)?.join('.') ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(answer);
    }
  }
  return normalized;
}

function addressBytes(value: string): Uint8Array | null {
  return parseIpv4(value) ?? parseIpv6(value);
}

export function addressesEqual(left: string, right: string): boolean {
  const leftBytes = addressBytes(left);
  const rightBytes = addressBytes(right);
  if (leftBytes === null || rightBytes === null) return false;
  const normalizedLeft = leftBytes.length === 16 ? (mappedIpv4(leftBytes) ?? leftBytes) : leftBytes;
  const normalizedRight =
    rightBytes.length === 16 ? (mappedIpv4(rightBytes) ?? rightBytes) : rightBytes;
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((byte, index) => byte === normalizedRight[index]);
}
