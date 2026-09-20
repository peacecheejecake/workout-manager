import { resolve4, resolve6 } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import { checkServerIdentity } from 'node:tls';

import {
  IngestionFetchError,
  type IngestionResolver,
  type IngestionTransport,
  type TransportRequest,
  type TransportResponse,
} from './fetch.js';
import { MAX_RESOLVED_ADDRESSES, type ResolvedAddress } from './policy.js';

const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'accept-encoding', 'user-agent']);

export class NodeNetworkError extends Error {
  constructor(readonly code: 'DNS_FAILED' | 'HTTPS_FAILED' | 'CANCELLED' | 'INVALID_RESPONSE') {
    super(code);
    this.name = 'NodeNetworkError';
  }
}

export interface NodeDnsClient {
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
}

const coreDnsClient: NodeDnsClient = {
  resolve4,
  resolve6,
};

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new NodeNetworkError('CANCELLED'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new NodeNetworkError('CANCELLED'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      () => {
        cleanup();
        reject(new NodeNetworkError('DNS_FAILED'));
      },
    );
  });
}

export function createNodeResolver(client: NodeDnsClient = coreDnsClient): IngestionResolver {
  return {
    async resolve(hostname, signal) {
      const results = await withAbort(
        Promise.allSettled([client.resolve4(hostname), client.resolve6(hostname)]),
        signal,
      );
      const addresses: ResolvedAddress[] = [];
      let successfulQuery = false;
      const ipv4 = results[0];
      if (ipv4?.status === 'fulfilled') {
        successfulQuery = true;
        addresses.push(...ipv4.value.map((address): ResolvedAddress => ({ address, family: 4 })));
      }
      const ipv6 = results[1];
      if (ipv6?.status === 'fulfilled') {
        successfulQuery = true;
        addresses.push(...ipv6.value.map((address): ResolvedAddress => ({ address, family: 6 })));
      }
      if (!successfulQuery || addresses.length > MAX_RESOLVED_ADDRESSES)
        throw new NodeNetworkError('DNS_FAILED');
      return addresses;
    },
  };
}

export interface NodeHttpsResponseSeam {
  readonly statusCode: number | undefined;
  readonly headers: TransportResponse['headers'];
  readonly remoteAddress: string | undefined;
  readonly rawHeaderCount?: number;
  readonly body: AsyncIterable<unknown>;
  discard(): Promise<void>;
}

export interface NodeHttpsRequestHandle {
  onError(listener: () => void): void;
  end(): void;
  destroy(): void;
}

export type NodeHttpsRequestSeam = (
  options: RequestOptions,
  onResponse: (response: NodeHttpsResponseSeam) => void,
) => NodeHttpsRequestHandle;

function discardIncoming(response: IncomingMessage): Promise<void> {
  if (response.readableEnded || response.destroyed) return Promise.resolve();
  response.destroy();
  return Promise.resolve();
}

const coreHttpsRequest: NodeHttpsRequestSeam = (options, onResponse) => {
  const request = httpsRequest(options, (response) => {
    const body: AsyncIterable<unknown> = response;
    onResponse({
      statusCode: response.statusCode,
      headers: response.headers,
      remoteAddress: response.socket.remoteAddress,
      rawHeaderCount: response.rawHeaders.length / 2,
      body,
      discard: () => discardIncoming(response),
    });
  });
  return {
    onError(listener) {
      request.once('error', listener);
    },
    end() {
      request.end();
    },
    destroy() {
      request.destroy();
    },
  };
};

function originalHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function pinnedLookup(hostname: string, pinned: ResolvedAddress): LookupFunction {
  return (requestedHostname, options, callback) => {
    if (requestedHostname.toLowerCase() !== hostname.toLowerCase()) {
      callback(new NodeNetworkError('HTTPS_FAILED'), '', pinned.family);
      return;
    }
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function safeRequestHeaders(
  headers: TransportRequest['headers'],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = { connection: 'close' };
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.has(normalized)) result[normalized] = value;
  }
  return result;
}

function headerCount(headers: TransportResponse['headers']): number {
  let count = 0;
  for (const value of Object.values(headers)) {
    if (value === undefined) continue;
    count += Array.isArray(value) ? value.length : 1;
  }
  return count;
}

function discardWithoutFailure(response: NodeHttpsResponseSeam): void {
  void response.discard().catch(() => undefined);
}

async function* checkedBody(body: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw new NodeNetworkError('INVALID_RESPONSE');
    yield chunk;
  }
}

export function createNodeHttpsTransport(
  requestSeam: NodeHttpsRequestSeam = coreHttpsRequest,
): IngestionTransport {
  return {
    request(input) {
      if (input.signal.aborted) return Promise.reject(new NodeNetworkError('CANCELLED'));
      const hostname = originalHostname(input.url);
      if (
        input.method !== 'GET' ||
        input.url.protocol !== 'https:' ||
        input.url.port !== '' ||
        input.url.username !== '' ||
        input.url.password !== '' ||
        input.url.hash !== ''
      )
        return Promise.reject(new NodeNetworkError('HTTPS_FAILED'));

      const options: RequestOptions = {
        protocol: 'https:',
        hostname,
        port: 443,
        method: 'GET',
        path: `${input.url.pathname}${input.url.search}`,
        headers: { ...safeRequestHeaders(input.headers), host: input.url.host },
        agent: false,
        family: input.pinnedAddress.family,
        lookup: pinnedLookup(hostname, input.pinnedAddress),
        maxHeaderSize: input.maxHeaderBytes,
        insecureHTTPParser: false,
        rejectUnauthorized: true,
        servername: hostname,
        checkServerIdentity: (_checkedHostname, certificate) =>
          checkServerIdentity(hostname, certificate),
        signal: input.signal,
        setDefaultHeaders: false,
      };

      return new Promise<TransportResponse>((resolve, reject) => {
        let settled = false;
        let handle: NodeHttpsRequestHandle | undefined;
        const cleanup = () => input.signal.removeEventListener('abort', onAbort);
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          handle?.destroy();
          fail(new NodeNetworkError('CANCELLED'));
        };
        const onResponse = (response: NodeHttpsResponseSeam) => {
          if (settled) {
            discardWithoutFailure(response);
            return;
          }
          if (
            response.statusCode === undefined ||
            !Number.isInteger(response.statusCode) ||
            response.statusCode < 100 ||
            response.statusCode > 599 ||
            response.remoteAddress === undefined
          ) {
            discardWithoutFailure(response);
            fail(new NodeNetworkError('INVALID_RESPONSE'));
            return;
          }
          const measuredHeaderCount = response.rawHeaderCount ?? headerCount(response.headers);
          if (measuredHeaderCount > input.maxHeaderCount) {
            discardWithoutFailure(response);
            fail(new IngestionFetchError('RESPONSE_HEADERS_TOO_LARGE'));
            return;
          }
          settled = true;
          cleanup();
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            remoteAddress: response.remoteAddress,
            body: checkedBody(response.body),
            discard: () => response.discard(),
          });
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        try {
          handle = requestSeam(options, onResponse);
          handle.onError(() => fail(new NodeNetworkError('HTTPS_FAILED')));
          handle.end();
        } catch {
          handle?.destroy();
          fail(new NodeNetworkError('HTTPS_FAILED'));
        }
      });
    },
  };
}

export function createNodeNetworkAdapters(input?: {
  readonly dns?: NodeDnsClient;
  readonly request?: NodeHttpsRequestSeam;
}): { readonly resolver: IngestionResolver; readonly transport: IngestionTransport } {
  return {
    resolver: createNodeResolver(input?.dns),
    transport: createNodeHttpsTransport(input?.request),
  };
}
