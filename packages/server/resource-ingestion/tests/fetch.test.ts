import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  fetchBoundedResource,
  IngestionFetchError,
  type IngestionResolver,
  type IngestionTransport,
  type TransportRequest,
  type TransportResponse,
} from '../src/fetch.js';
import { createExactHostAllowlist, type ResolvedAddress } from '../src/policy.js';

const encoder = new TextEncoder();
const publicAnswer: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const policy = {
  allowedHosts: createExactHostAllowlist(['example.com', 'second.example']),
};

async function* body(...chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

function response(
  input: {
    statusCode?: number;
    headers?: TransportResponse['headers'];
    remoteAddress?: string;
    chunks?: readonly Uint8Array[];
    onDiscard?: () => void;
  } = {},
): TransportResponse {
  return {
    statusCode: input.statusCode ?? 200,
    headers: input.headers ?? { 'content-type': 'text/plain' },
    remoteAddress: input.remoteAddress ?? publicAnswer.address,
    body: body(...(input.chunks ?? [encoder.encode('ok')])),
    discard: async () => input.onDiscard?.(),
  };
}

function resolverFor(
  records: Readonly<Record<string, readonly ResolvedAddress[]>>,
): IngestionResolver {
  return {
    async resolve(hostname) {
      const answers = records[hostname];
      if (answers === undefined) throw new Error('missing resolver fixture');
      return answers;
    },
  };
}

function queueTransport(responses: readonly TransportResponse[]): {
  readonly transport: IngestionTransport;
  readonly requests: TransportRequest[];
} {
  const queue = [...responses];
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: {
      async request(input) {
        requests.push(input);
        const next = queue.shift();
        if (next === undefined) throw new Error('missing transport fixture');
        return next;
      },
    },
  };
}

const publicResolver = resolverFor({
  'example.com': [publicAnswer],
  'second.example': [publicAnswer],
});

describe('bounded resource fetch state machine', () => {
  it('pins the resolved address and sends only fixed non-credential headers', async () => {
    const queued = queueTransport([
      response({ headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    ]);

    const result = await fetchBoundedResource({
      rawUrl: 'https://example.com/article',
      policy,
      resolver: publicResolver,
      transport: queued.transport,
    });

    expect(result).toMatchObject({
      finalUrl: 'https://example.com/article',
      contentType: 'text/plain',
      redirectCount: 0,
      decodedBytes: 2,
    });
    expect(new TextDecoder().decode(result.body)).toBe('ok');
    expect(queued.requests).toHaveLength(1);
    expect(queued.requests[0]).toMatchObject({ method: 'GET', pinnedAddress: publicAnswer });
    expect(queued.requests[0]?.headers).toEqual({
      accept: 'text/html, application/xhtml+xml, text/markdown, text/plain',
      'accept-encoding': 'gzip, br',
      'user-agent': 'WorkoutManagerResourceFetcher/1',
    });
  });

  it('accepts XHTML as HTML-compatible fetched content', async () => {
    const queued = queueTransport([
      response({ headers: { 'content-type': 'application/xhtml+xml; charset=utf-8' } }),
    ]);

    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/article',
        policy,
        resolver: publicResolver,
        transport: queued.transport,
      }),
    ).resolves.toMatchObject({ contentType: 'application/xhtml+xml' });
  });

  it('re-resolves each redirect and rejects a public-to-private hop', async () => {
    const queued = queueTransport([
      response({ statusCode: 302, headers: { location: 'https://second.example/internal' } }),
    ]);
    const resolver = resolverFor({
      'example.com': [publicAnswer],
      'second.example': [{ address: '10.0.0.7', family: 4 }],
    });

    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver,
        transport: queued.transport,
      }),
    ).rejects.toMatchObject({ code: 'DNS_ADDRESS_REJECTED', message: 'DNS_ADDRESS_REJECTED' });
    expect(queued.requests).toHaveLength(1);
  });

  it('reports sanitized redirect and final hop provenance in order', async () => {
    const queued = queueTransport([
      response({
        statusCode: 302,
        headers: { location: 'https://second.example/final?private=second' },
      }),
      response({ headers: { 'content-type': 'text/plain' } }),
    ]);
    const observations: Array<{
      hopIndex: number;
      displayUrl: string;
      normalizedUrlSha256: string;
      responseStatus: number;
      resolvedAddresses: readonly ResolvedAddress[];
    }> = [];

    await fetchBoundedResource({
      rawUrl: 'https://example.com/start?private=first',
      policy,
      resolver: publicResolver,
      transport: queued.transport,
      onHop: async (observation) => {
        observations.push(observation);
      },
    });

    expect(observations).toEqual([
      {
        hopIndex: 0,
        displayUrl: 'https://example.com/start',
        normalizedUrlSha256: createHash('sha256')
          .update('https://example.com/start?private=first')
          .digest('hex'),
        responseStatus: 302,
        resolvedAddresses: [publicAnswer],
      },
      {
        hopIndex: 1,
        displayUrl: 'https://second.example/final',
        normalizedUrlSha256: createHash('sha256')
          .update('https://second.example/final?private=second')
          .digest('hex'),
        responseStatus: 200,
        resolvedAddresses: [publicAnswer],
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain('private=');
  });

  it('fails closed and discards the response when hop persistence fails', async () => {
    let discarded = false;
    const queued = queueTransport([
      response({
        onDiscard: () => {
          discarded = true;
        },
      }),
    ]);

    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/private?secret=value',
        policy,
        resolver: publicResolver,
        transport: queued.transport,
        onHop: async () => {
          throw new Error('persistence details must not escape');
        },
      }),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED', message: 'FETCH_FAILED' });
    expect(discarded).toBe(true);
  });

  it('rejects a connection whose remote address differs from the pinned answer', async () => {
    const queued = queueTransport([response({ remoteAddress: '8.8.8.8' })]);
    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver: publicResolver,
        transport: queued.transport,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_ADDRESS_MISMATCH' });
  });

  it('rejects mixed public and private DNS answers before transport', async () => {
    const queued = queueTransport([]);
    const resolver = resolverFor({
      'example.com': [publicAnswer, { address: '::ffff:127.0.0.1', family: 6 }],
    });
    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver,
        transport: queued.transport,
      }),
    ).rejects.toMatchObject({ code: 'DNS_ADDRESS_REJECTED' });
    expect(queued.requests).toHaveLength(0);
  });

  it('allows at most the configured redirect count', async () => {
    let discards = 0;
    const redirect = () =>
      response({
        statusCode: 308,
        headers: { location: '/again' },
        onDiscard: () => {
          discards += 1;
        },
      });
    const queued = queueTransport([redirect(), redirect(), redirect()]);

    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver: publicResolver,
        transport: queued.transport,
        limits: { maxRedirects: 2 },
      }),
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT_EXCEEDED' });
    expect(queued.requests).toHaveLength(3);
    expect(discards).toBe(3);
  });

  it('enforces declared and streaming compressed size limits', async () => {
    const declared = queueTransport([
      response({
        headers: { 'content-type': 'text/plain', 'content-length': '101' },
      }),
    ]);
    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver: publicResolver,
        transport: declared.transport,
        limits: { maxCompressedBytes: 100 },
      }),
    ).rejects.toMatchObject({ code: 'COMPRESSED_RESPONSE_TOO_LARGE' });

    const streamed = queueTransport([
      response({ chunks: [encoder.encode('123456'), encoder.encode('78901')] }),
    ]);
    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver: publicResolver,
        transport: streamed.transport,
        limits: { maxCompressedBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: 'COMPRESSED_RESPONSE_TOO_LARGE' });
  });

  it('bounds decoded bytes and compression ratio', async () => {
    const compressed = gzipSync('a'.repeat(10_000));
    const decodedLimit = queueTransport([
      response({
        headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        chunks: [compressed],
      }),
    ]);
    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver: publicResolver,
        transport: decodedLimit.transport,
        limits: { maxDecodedBytes: 100 },
      }),
    ).rejects.toMatchObject({ code: 'DECODED_RESPONSE_TOO_LARGE' });

    const ratioLimit = queueTransport([
      response({
        headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        chunks: [compressed],
      }),
    ]);
    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver: publicResolver,
        transport: ratioLimit.transport,
        limits: { maxDecodedBytes: 20_000, maxCompressionRatio: 5 },
      }),
    ).rejects.toMatchObject({ code: 'DECOMPRESSION_LIMIT' });
  });

  it('rejects unsupported content types without reflecting response values', async () => {
    const queued = queueTransport([
      response({ headers: { 'content-type': 'application/x-private-secret' } }),
    ]);
    const operation = fetchBoundedResource({
      rawUrl: 'https://example.com/private-token',
      policy,
      resolver: publicResolver,
      transport: queued.transport,
    });
    await expect(operation).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
      message: 'UNSUPPORTED_CONTENT_TYPE',
    });
  });

  it('discards rejected status bodies and exposes only bounded retry metadata', async () => {
    let bodyRead = false;
    let discarded = false;
    const rejected: TransportResponse = {
      statusCode: 429,
      headers: { 'retry-after': '999999999999' },
      remoteAddress: publicAnswer.address,
      body: (async function* () {
        bodyRead = true;
        yield encoder.encode('must not be consumed');
      })(),
      async discard() {
        discarded = true;
      },
    };
    const queued = queueTransport([rejected]);

    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver: publicResolver,
        transport: queued.transport,
      }),
    ).rejects.toMatchObject({
      code: 'HTTP_STATUS_REJECTED',
      message: 'HTTP_STATUS_REJECTED',
      details: { statusCode: 429, retryAfterSeconds: 3600 },
    });
    expect(bodyRead).toBe(false);
    expect(discarded).toBe(true);

    const invalid = queueTransport([
      response({ statusCode: 503, headers: { 'retry-after': 'private invalid value' } }),
    ]);
    const invalidOperation = fetchBoundedResource({
      rawUrl: 'https://example.com/',
      policy,
      resolver: publicResolver,
      transport: invalid.transport,
    });
    await expect(invalidOperation).rejects.toMatchObject({
      code: 'HTTP_STATUS_REJECTED',
      details: { statusCode: 503 },
    });
    await expect(invalidOperation).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IngestionFetchError && error.details?.retryAfterSeconds === undefined,
    );
  });

  it('enforces the total deadline even when an injected resolver does not settle', async () => {
    const resolver: IngestionResolver = {
      resolve() {
        return new Promise(() => undefined);
      },
    };
    const queued = queueTransport([]);
    await expect(
      fetchBoundedResource({
        rawUrl: 'https://example.com/',
        policy,
        resolver,
        transport: queued.transport,
        limits: { timeoutMs: 5 },
      }),
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT', message: 'FETCH_TIMEOUT' });
  });
});
