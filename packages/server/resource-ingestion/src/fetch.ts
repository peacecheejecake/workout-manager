import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip } from 'node:zlib';

import {
  addressesEqual,
  assertSafeDnsAnswers,
  IngestionPolicyError,
  parseAllowedUrl,
  type ResolvedAddress,
  type UrlPolicy,
} from './policy.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RETRY_AFTER_SECONDS = 60 * 60;
const DEFAULT_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/markdown',
  'text/plain',
]);

export interface IngestionResolver {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]>;
}

export interface TransportRequest {
  readonly method: 'GET';
  readonly url: URL;
  readonly pinnedAddress: ResolvedAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxHeaderBytes: number;
  readonly maxHeaderCount: number;
}

export interface TransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly remoteAddress: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly discard: () => Promise<void>;
}

export interface IngestionTransport {
  request(input: TransportRequest): Promise<TransportResponse>;
}

export interface FetchLimits {
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxHeaderBytes?: number;
  readonly maxHeaderCount?: number;
  readonly maxCompressedBytes?: number;
  readonly maxDecodedBytes?: number;
  readonly maxCompressionRatio?: number;
  readonly allowedContentTypes?: ReadonlySet<string>;
}

export interface FetchHopObservation {
  readonly hopIndex: number;
  readonly displayUrl: string;
  readonly normalizedUrlSha256: string;
  readonly responseStatus: number;
  readonly resolvedAddresses: readonly ResolvedAddress[];
}

export interface FetchedResource {
  readonly finalUrl: string;
  readonly contentType: 'text/html' | 'application/xhtml+xml' | 'text/markdown' | 'text/plain';
  readonly body: Uint8Array;
  readonly sha256: string;
  readonly redirectCount: number;
  readonly compressedBytes: number;
  readonly decodedBytes: number;
}

export class IngestionFetchError extends Error {
  constructor(
    readonly code:
      | 'FETCH_CANCELLED'
      | 'FETCH_TIMEOUT'
      | 'FETCH_FAILED'
      | 'INVALID_FETCH_LIMITS'
      | 'URL_NOT_ALLOWED'
      | 'DNS_RESOLUTION_FAILED'
      | 'DNS_ADDRESS_REJECTED'
      | 'REMOTE_ADDRESS_MISMATCH'
      | 'REDIRECT_REJECTED'
      | 'REDIRECT_LIMIT_EXCEEDED'
      | 'HTTP_STATUS_REJECTED'
      | 'RESPONSE_HEADERS_TOO_LARGE'
      | 'UNSUPPORTED_CONTENT_TYPE'
      | 'UNSUPPORTED_CONTENT_ENCODING'
      | 'COMPRESSED_RESPONSE_TOO_LARGE'
      | 'DECODED_RESPONSE_TOO_LARGE'
      | 'DECOMPRESSION_LIMIT',
    readonly details?: {
      readonly statusCode?: number;
      readonly retryAfterSeconds?: number;
    },
  ) {
    super(code);
    this.name = 'IngestionFetchError';
  }
}

function retryAfterSeconds(
  headers: TransportResponse['headers'],
  nowMilliseconds = Date.now(),
): number | undefined {
  const raw = oneHeader(headers, 'retry-after');
  if (raw === undefined || raw.length > 128) return undefined;
  if (/^(0|[1-9]\d*)$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  }
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      raw,
    )
  )
    return undefined;
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return undefined;
  const seconds = Math.max(0, Math.ceil((retryAt - nowMilliseconds) / 1000));
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function oneHeader(headers: TransportResponse['headers'], name: string): string | undefined {
  let value: string | readonly string[] | undefined;
  const normalizedName = name.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== normalizedName) continue;
    if (value !== undefined || headerValue === undefined)
      throw new IngestionFetchError('RESPONSE_HEADERS_TOO_LARGE');
    value = headerValue;
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new IngestionFetchError('RESPONSE_HEADERS_TOO_LARGE');
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
}

function headerSize(headers: TransportResponse['headers']): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      count += 1;
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    }
  }
  return { count, bytes };
}

function contentType(headers: TransportResponse['headers'], allowed: ReadonlySet<string>) {
  const raw = oneHeader(headers, 'content-type');
  if (raw === undefined || raw.length > 200)
    throw new IngestionFetchError('UNSUPPORTED_CONTENT_TYPE');
  const [typePart, ...parameters] = raw.split(';');
  const type = typePart?.trim().toLowerCase();
  if (type === undefined || !allowed.has(type))
    throw new IngestionFetchError('UNSUPPORTED_CONTENT_TYPE');
  for (const parameter of parameters) {
    const normalized = parameter.trim().toLowerCase();
    if (normalized !== '' && normalized !== 'charset=utf-8' && normalized !== 'charset="utf-8"')
      throw new IngestionFetchError('UNSUPPORTED_CONTENT_TYPE');
  }
  if (
    type !== 'text/html' &&
    type !== 'application/xhtml+xml' &&
    type !== 'text/markdown' &&
    type !== 'text/plain'
  )
    throw new IngestionFetchError('UNSUPPORTED_CONTENT_TYPE');
  return type;
}

function declaredContentLength(headers: TransportResponse['headers']): number | undefined {
  const raw = oneHeader(headers, 'content-length');
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw) || raw.length > 16)
    throw new IngestionFetchError('RESPONSE_HEADERS_TOO_LARGE');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new IngestionFetchError('RESPONSE_HEADERS_TOO_LARGE');
  return value;
}

function displayUrl(url: URL): string {
  const display = new URL(url.href);
  display.search = '';
  return display.href;
}

async function reportHop(
  callback: ((observation: FetchHopObservation) => Promise<void>) | undefined,
  input: FetchHopObservation,
): Promise<void> {
  if (callback === undefined) return;
  try {
    await callback(input);
  } catch {
    throw new IngestionFetchError('FETCH_FAILED');
  }
}

async function collectDecoded(
  response: TransportResponse,
  input: {
    maxCompressedBytes: number;
    maxDecodedBytes: number;
    maxCompressionRatio: number;
  },
): Promise<{ body: Uint8Array; compressedBytes: number; decodedBytes: number }> {
  let compressedBytes = 0;
  async function* boundedCompressed(): AsyncGenerator<Uint8Array> {
    for await (const chunk of response.body) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > input.maxCompressedBytes)
        throw new IngestionFetchError('COMPRESSED_RESPONSE_TOO_LARGE');
      yield chunk;
    }
  }

  const encoding = (oneHeader(response.headers, 'content-encoding') ?? 'identity')
    .trim()
    .toLowerCase();
  let decoded: AsyncIterable<Uint8Array>;
  if (encoding === '' || encoding === 'identity') decoded = boundedCompressed();
  else if (encoding === 'gzip') decoded = Readable.from(boundedCompressed()).pipe(createGunzip());
  else if (encoding === 'br')
    decoded = Readable.from(boundedCompressed()).pipe(createBrotliDecompress());
  else throw new IngestionFetchError('UNSUPPORTED_CONTENT_ENCODING');

  const chunks: Uint8Array[] = [];
  let decodedBytes = 0;
  try {
    for await (const chunk of decoded) {
      decodedBytes += chunk.byteLength;
      if (decodedBytes > input.maxDecodedBytes)
        throw new IngestionFetchError('DECODED_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof IngestionFetchError) throw error;
    if (encoding === '' || encoding === 'identity') throw error;
    throw new IngestionFetchError('DECOMPRESSION_LIMIT');
  }
  if (compressedBytes > 0 && decodedBytes > compressedBytes * input.maxCompressionRatio)
    throw new IngestionFetchError('DECOMPRESSION_LIMIT');
  const body = new Uint8Array(decodedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, compressedBytes, decodedBytes };
}

async function discardResponse(response: TransportResponse): Promise<void> {
  try {
    await response.discard();
  } catch {
    // The primary failure remains stable and sanitized; abort also reaches the transport.
  }
}

function fetchError(error: unknown, timedOut: boolean, externallyAborted: boolean): Error {
  if (error instanceof IngestionFetchError) return error;
  if (error instanceof IngestionPolicyError) {
    if (error.code === 'DNS_ADDRESS_REJECTED')
      return new IngestionFetchError('DNS_ADDRESS_REJECTED');
    if (error.code === 'REMOTE_ADDRESS_MISMATCH')
      return new IngestionFetchError('REMOTE_ADDRESS_MISMATCH');
    if (error.code === 'REDIRECT_LIMIT_EXCEEDED')
      return new IngestionFetchError('REDIRECT_LIMIT_EXCEEDED');
    return new IngestionFetchError('URL_NOT_ALLOWED');
  }
  if (timedOut) return new IngestionFetchError('FETCH_TIMEOUT');
  if (externallyAborted) return new IngestionFetchError('FETCH_CANCELLED');
  return new IngestionFetchError('FETCH_FAILED');
}

export async function fetchBoundedResource(input: {
  readonly rawUrl: string;
  readonly policy: UrlPolicy;
  readonly resolver: IngestionResolver;
  readonly transport: IngestionTransport;
  readonly onHop?: (observation: FetchHopObservation) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly limits?: FetchLimits;
}): Promise<FetchedResource> {
  const timeoutMs = input.limits?.timeoutMs ?? 20_000;
  const maxRedirects = input.limits?.maxRedirects ?? 5;
  const maxHeaderBytes = input.limits?.maxHeaderBytes ?? 16 * 1024;
  const maxHeaderCount = input.limits?.maxHeaderCount ?? 64;
  const maxCompressedBytes = input.limits?.maxCompressedBytes ?? 1024 * 1024;
  const maxDecodedBytes = input.limits?.maxDecodedBytes ?? 1024 * 1024;
  const maxCompressionRatio = input.limits?.maxCompressionRatio ?? 20;
  const allowedContentTypes = input.limits?.allowedContentTypes ?? DEFAULT_CONTENT_TYPES;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 5 ||
    !Number.isInteger(maxHeaderBytes) ||
    maxHeaderBytes < 1 ||
    maxHeaderBytes > 64 * 1024 ||
    !Number.isInteger(maxHeaderCount) ||
    maxHeaderCount < 1 ||
    maxHeaderCount > 128 ||
    !Number.isInteger(maxCompressedBytes) ||
    maxCompressedBytes < 1 ||
    maxCompressedBytes > 1024 * 1024 ||
    !Number.isInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    maxDecodedBytes > 1024 * 1024 ||
    !Number.isFinite(maxCompressionRatio) ||
    maxCompressionRatio < 1 ||
    maxCompressionRatio > 100
  )
    throw new IngestionFetchError('INVALID_FETCH_LIMITS');

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (input.signal?.aborted === true) controller.abort();
  let onCombinedAbort: () => void = () => {};
  const abortFailure = new Promise<never>((_resolve, reject) => {
    onCombinedAbort = () =>
      reject(new IngestionFetchError(timedOut ? 'FETCH_TIMEOUT' : 'FETCH_CANCELLED'));
    if (controller.signal.aborted) onCombinedAbort();
    else controller.signal.addEventListener('abort', onCombinedAbort, { once: true });
  });
  const execute = async (): Promise<FetchedResource> => {
    let current = parseAllowedUrl(input.rawUrl, input.policy, 0);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (controller.signal.aborted)
        throw new IngestionFetchError(timedOut ? 'FETCH_TIMEOUT' : 'FETCH_CANCELLED');
      let resolved: readonly ResolvedAddress[];
      try {
        resolved = await input.resolver.resolve(current.hostname, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new IngestionFetchError('DNS_RESOLUTION_FAILED');
      }
      if (controller.signal.aborted)
        throw new IngestionFetchError(timedOut ? 'FETCH_TIMEOUT' : 'FETCH_CANCELLED');
      const addresses = assertSafeDnsAnswers(resolved);
      const pinnedAddress = addresses[0];
      if (pinnedAddress === undefined) throw new IngestionFetchError('DNS_ADDRESS_REJECTED');
      const response = await input.transport.request({
        method: 'GET',
        url: current.url,
        pinnedAddress,
        signal: controller.signal,
        maxHeaderBytes,
        maxHeaderCount,
        headers: {
          accept: 'text/html, application/xhtml+xml, text/markdown, text/plain',
          'accept-encoding': 'gzip, br',
          'user-agent': 'WorkoutManagerResourceFetcher/1',
        },
      });
      try {
        if (controller.signal.aborted)
          throw new IngestionFetchError(timedOut ? 'FETCH_TIMEOUT' : 'FETCH_CANCELLED');
        if (!addressesEqual(pinnedAddress.address, response.remoteAddress))
          throw new IngestionFetchError('REMOTE_ADDRESS_MISMATCH');
        const measuredHeaders = headerSize(response.headers);
        if (measuredHeaders.bytes > maxHeaderBytes || measuredHeaders.count > maxHeaderCount)
          throw new IngestionFetchError('RESPONSE_HEADERS_TOO_LARGE');
        await reportHop(input.onHop, {
          hopIndex: hop,
          displayUrl: displayUrl(current.url),
          normalizedUrlSha256: createHash('sha256').update(current.normalizedUrl).digest('hex'),
          responseStatus: response.statusCode,
          resolvedAddresses: addresses.map((address) => ({ ...address })),
        });
        if (REDIRECT_STATUSES.has(response.statusCode)) {
          if (hop >= maxRedirects) throw new IngestionFetchError('REDIRECT_LIMIT_EXCEEDED');
          const location = oneHeader(response.headers, 'location');
          if (location === undefined || Buffer.byteLength(location) > 2048)
            throw new IngestionFetchError('REDIRECT_REJECTED');
          let redirectUrl: string;
          try {
            redirectUrl = new URL(location, current.url).href;
          } catch {
            throw new IngestionFetchError('REDIRECT_REJECTED');
          }
          const next = parseAllowedUrl(redirectUrl, input.policy, hop + 1);
          await response.discard();
          current = next;
          continue;
        }
        if (response.statusCode >= 300 && response.statusCode < 400)
          throw new IngestionFetchError('REDIRECT_REJECTED');
        if (response.statusCode !== 200) {
          const retryAfter = retryAfterSeconds(response.headers);
          throw new IngestionFetchError('HTTP_STATUS_REJECTED', {
            statusCode: response.statusCode,
            ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
          });
        }
        const resolvedContentType = contentType(response.headers, allowedContentTypes);
        const declaredBytes = declaredContentLength(response.headers);
        if (declaredBytes !== undefined && declaredBytes > maxCompressedBytes)
          throw new IngestionFetchError('COMPRESSED_RESPONSE_TOO_LARGE');
        const collected = await collectDecoded(response, {
          maxCompressedBytes,
          maxDecodedBytes,
          maxCompressionRatio,
        });
        return {
          finalUrl: current.normalizedUrl,
          contentType: resolvedContentType,
          ...collected,
          sha256: createHash('sha256').update(collected.body).digest('hex'),
          redirectCount: hop,
        };
      } catch (error) {
        await discardResponse(response);
        throw error;
      }
    }
    throw new IngestionFetchError('REDIRECT_LIMIT_EXCEEDED');
  };
  try {
    return await Promise.race([execute(), abortFailure]);
  } catch (error) {
    throw fetchError(error, timedOut, input.signal?.aborted === true);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onCombinedAbort);
    input.signal?.removeEventListener('abort', onExternalAbort);
  }
}
