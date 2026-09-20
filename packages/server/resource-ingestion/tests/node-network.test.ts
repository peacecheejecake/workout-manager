import type { RequestOptions } from 'node:https';

import { describe, expect, it } from 'vitest';

import type { TransportRequest } from '../src/fetch.js';
import {
  createNodeHttpsTransport,
  createNodeResolver,
  type NodeDnsClient,
  type NodeHttpsRequestSeam,
} from '../src/node-network.js';

async function* responseBody(...chunks: readonly Uint8Array[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

function transportInput(signal: AbortSignal): TransportRequest {
  return {
    method: 'GET',
    url: new URL('https://example.com/private?q=1'),
    pinnedAddress: { address: '93.184.216.34', family: 4 },
    headers: {
      accept: 'text/plain',
      'accept-encoding': 'gzip, br',
      'user-agent': 'resource-test',
      authorization: 'Bearer must-not-forward',
      cookie: 'session=must-not-forward',
      'proxy-authorization': 'must-not-forward',
    },
    signal,
    maxHeaderBytes: 4096,
    maxHeaderCount: 8,
  };
}

function lookupResult(
  options: RequestOptions,
  hostname: string,
): Promise<{
  readonly address: string;
  readonly family: number | undefined;
}> {
  const lookup = options.lookup;
  if (lookup === undefined) return Promise.reject(new Error('missing lookup'));
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: false }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof address !== 'string') {
        reject(new Error('expected one lookup address'));
        return;
      }
      resolve({ address, family });
    });
  });
}

describe('Node DNS resolver adapter', () => {
  it('resolves both A and AAAA records with explicit families', async () => {
    const client: NodeDnsClient = {
      async resolve4(hostname) {
        expect(hostname).toBe('example.com');
        return ['93.184.216.34'];
      },
      async resolve6(hostname) {
        expect(hostname).toBe('example.com');
        return ['2606:4700:4700::1111'];
      },
    };
    const answers = await createNodeResolver(client).resolve(
      'example.com',
      new AbortController().signal,
    );
    expect(answers).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it('cancels even when DNS clients do not settle', async () => {
    const pending = () => new Promise<readonly string[]>(() => undefined);
    const resolver = createNodeResolver({ resolve4: pending, resolve6: pending });
    const controller = new AbortController();
    const operation = resolver.resolve('example.com', controller.signal);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' });
  });

  it('fails closed when A and AAAA records exceed the persistence bound', async () => {
    const resolver = createNodeResolver({
      async resolve4() {
        return Array.from({ length: 8 }, (_value, index) => `8.8.8.${index + 1}`);
      },
      async resolve6() {
        return ['2606:4700:4700::1111'];
      },
    });
    await expect(
      resolver.resolve('example.com', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DNS_FAILED' });
  });
});

describe('Node HTTPS transport adapter', () => {
  it('pins lookup, preserves TLS host identity, and drops credential headers', async () => {
    let captured: RequestOptions | undefined;
    const seam: NodeHttpsRequestSeam = (options, onResponse) => {
      captured = options;
      queueMicrotask(() =>
        onResponse({
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          remoteAddress: '93.184.216.34',
          body: responseBody(new TextEncoder().encode('ok')),
          async discard() {},
        }),
      );
      return { onError() {}, end() {}, destroy() {} };
    };
    const transport = createNodeHttpsTransport(seam);
    const response = await transport.request(transportInput(new AbortController().signal));

    if (captured === undefined) throw new Error('request options were not captured');
    expect(captured).toMatchObject({
      protocol: 'https:',
      hostname: 'example.com',
      servername: 'example.com',
      port: 443,
      method: 'GET',
      path: '/private?q=1',
      agent: false,
      family: 4,
      rejectUnauthorized: true,
      maxHeaderSize: 4096,
    });
    expect(captured.headers).toEqual({
      connection: 'close',
      host: 'example.com',
      accept: 'text/plain',
      'accept-encoding': 'gzip, br',
      'user-agent': 'resource-test',
    });
    expect(captured.checkServerIdentity).toBeTypeOf('function');
    await expect(lookupResult(captured, 'example.com')).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
    await expect(lookupResult(captured, 'other.example')).rejects.toMatchObject({
      code: 'HTTPS_FAILED',
    });
    expect(response.remoteAddress).toBe('93.184.216.34');
  });

  it('destroys an outstanding request when cancelled', async () => {
    let destroyed = false;
    const seam: NodeHttpsRequestSeam = () => ({
      onError() {},
      end() {},
      destroy() {
        destroyed = true;
      },
    });
    const controller = new AbortController();
    const operation = createNodeHttpsTransport(seam).request(transportInput(controller.signal));
    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' });
    expect(destroyed).toBe(true);
  });

  it('rejects response header counts before exposing the stream', async () => {
    let discarded = false;
    const seam: NodeHttpsRequestSeam = (_options, onResponse) => {
      queueMicrotask(() =>
        onResponse({
          statusCode: 200,
          headers: { one: '1', two: '2' },
          remoteAddress: '93.184.216.34',
          body: responseBody(),
          async discard() {
            discarded = true;
          },
        }),
      );
      return { onError() {}, end() {}, destroy() {} };
    };
    const input = { ...transportInput(new AbortController().signal), maxHeaderCount: 1 };
    await expect(createNodeHttpsTransport(seam).request(input)).rejects.toMatchObject({
      code: 'RESPONSE_HEADERS_TOO_LARGE',
    });
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(discarded).toBe(true);
  });
});
