import { createHash } from 'node:crypto';

import type { ObjectStorage, ObjectKey } from '@workout/server-media';
import type {
  IngestionResolver,
  IngestionTransport,
  TransportResponse,
} from '@workout/server-resource-ingestion';
import type { ResourceUrlIngestionLease } from '@workout/server-persistence/resource-url-ingestions';
import { describe, expect, it, vi } from 'vitest';

import {
  runUrlIngestionWorker,
  type ClosableObjectStorage,
  type UrlIngestionWorkerDependencies,
  type UrlIngestionWorkerRepository,
} from '../src/url-ingestion-worker.js';

const config = {
  connectionString: 'postgres://workout_resource_ingestion_worker:secret@db/workout',
  storageRoot: '/var/lib/workout/resources',
  allowedHosts: ['example.com', 'docs.example.com'],
};
const baseLease: ResourceUrlIngestionLease = {
  athleteId: 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa',
  requestId: 'db985aaa-b96e-4aef-871a-c99a16183439',
  attemptNo: 1,
  phase: 'fetch',
  leaseToken: 'a7e54620-2507-47f2-b63d-b998e6d9ae32',
  requestedUrl: 'https://example.com/private?token=secret',
  displayUrl: 'https://example.com/private',
  resourceId: '4d6cc1ce-0643-4c53-b055-9df458fec594',
  versionId: '2ee1d9ca-983b-4b6b-80ae-8ceba294329e',
  rawTemporaryRef:
    'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/resources/4d6cc1ce-0643-4c53-b055-9df458fec594/url-ingestions/db985aaa-b96e-4aef-871a-c99a16183439/temporary/raw',
  rawStorageRef: null,
  rawMediaType: null,
  parsedTemporaryRef:
    'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/resources/4d6cc1ce-0643-4c53-b055-9df458fec594/url-ingestions/db985aaa-b96e-4aef-871a-c99a16183439/temporary/parsed',
};

function rawStorageRef(body: string, extension: 'html' | 'xhtml' | 'txt' | 'md'): string {
  const sha256 = createHash('sha256').update(body).digest('hex');
  return `private/v1/tenants/${baseLease.athleteId}/resources/${baseLease.resourceId}/url-ingestions/${baseLease.requestId}/raw/sha256/${sha256}.${extension}`;
}

function response(
  statusCode: number,
  input: { location?: string; body?: string; contentType?: string; retryAfter?: string } = {},
): TransportResponse {
  const encoded = new TextEncoder().encode(input.body ?? '');
  return {
    statusCode,
    headers: {
      ...(input.location ? { location: input.location } : {}),
      ...(input.contentType ? { 'content-type': input.contentType } : {}),
      ...(input.retryAfter ? { 'retry-after': input.retryAfter } : {}),
    },
    remoteAddress: '93.184.216.34',
    body: (async function* () {
      yield encoded;
    })(),
    discard: vi.fn(async () => undefined),
  };
}

function setup(input: {
  lease?: ResourceUrlIngestionLease | null;
  responses?: TransportResponse[];
  openedBody?: string;
  openFailure?: Error;
  recordHop?: boolean;
  fail?: boolean;
  prepareRaw?: boolean;
  markRawPublished?: boolean;
  prepareParsed?: boolean;
  markParsedPublished?: boolean;
  abandonPublishedObject?: boolean;
  finalize?: boolean;
  publishOutcome?: 'published' | 'already_present';
  publishFailure?: Error;
}) {
  const operations: string[] = [];
  const repository: UrlIngestionWorkerRepository = {
    lease: vi.fn(async () => input.lease ?? null),
    recordHop: vi.fn(async () => input.recordHop ?? true),
    prepareRaw: vi.fn(async () => {
      operations.push('prepareRaw');
      return input.prepareRaw ?? true;
    }),
    markRawPublished: vi.fn(async () => {
      operations.push('markRawPublished');
      return input.markRawPublished ?? true;
    }),
    prepareParsed: vi.fn(async () => {
      operations.push('prepareParsed');
      return input.prepareParsed ?? true;
    }),
    markParsedPublished: vi.fn(async () => {
      operations.push('markParsedPublished');
      return input.markParsedPublished ?? true;
    }),
    abandonPublishedObject: vi.fn(async () => input.abandonPublishedObject ?? true),
    finalize: vi.fn(async () => {
      operations.push('finalize');
      return input.finalize === false
        ? null
        : { resource_id: baseLease.resourceId, version_id: baseLease.versionId };
    }),
    fail: vi.fn(async () => input.fail ?? true),
    bookmarkOnly: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  };
  const written = new Map<string, Uint8Array>();
  const storage: ClosableObjectStorage = {
    writeTemporary: vi.fn(async (key, body) => {
      operations.push('writeTemporary');
      const chunks: Uint8Array[] = [];
      let sizeBytes = 0;
      for await (const chunk of body) {
        chunks.push(chunk);
        sizeBytes += chunk.byteLength;
      }
      const content = new Uint8Array(sizeBytes);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      written.set(key, content);
      return { key, sizeBytes, modifiedAt: new Date(0) };
    }),
    publishTemporary: vi.fn(async (temporaryKey, finalKey, expectation) => {
      operations.push('publishTemporary');
      if (input.publishFailure) throw input.publishFailure;
      return { key: finalKey, outcome: input.publishOutcome ?? 'published', ...expectation };
    }),
    open: vi.fn(async (key: ObjectKey) => {
      if (input.openFailure) throw input.openFailure;
      if (input.openedBody === undefined) return null;
      const body = new TextEncoder().encode(input.openedBody);
      return {
        key,
        sizeBytes: body.byteLength,
        modifiedAt: new Date(0),
        body: (async function* () {
          yield body;
        })(),
      };
    }),
    stat: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } satisfies ObjectStorage & { close(): Promise<void> };
  const resolver: IngestionResolver = {
    resolve: vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]),
  };
  const queuedResponses = [...(input.responses ?? [])];
  const transport: IngestionTransport = {
    request: vi.fn(async () => {
      const next = queuedResponses.shift();
      if (!next) throw new Error('no response');
      return next;
    }),
  };
  const logger = vi.fn();
  const dependencies: UrlIngestionWorkerDependencies = {
    createStorage: vi.fn(async () => storage),
    createRepository: vi.fn(() => repository),
    resolver,
    transport,
    logger,
  };
  return { dependencies, repository, storage, operations, written, logger };
}

describe('resource URL ingestion worker', () => {
  it('fetches one job, records every redirect hop without query data, and publishes raw in order', async () => {
    const first = response(302, { location: 'https://docs.example.com/final?code=hidden' });
    const second = response(200, { body: '# Guide', contentType: 'text/markdown' });
    const context = setup({ lease: baseLease, responses: [first, second] });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe(
      'raw_published',
    );

    expect(context.repository.recordHop).toHaveBeenCalledTimes(2);
    expect(context.repository.recordHop).toHaveBeenNthCalledWith(
      1,
      baseLease,
      expect.objectContaining({
        index: 0,
        displayUrl: 'https://example.com/private',
        responseStatus: 302,
        resolvedAddresses: ['93.184.216.34'],
      }),
    );
    expect(context.repository.recordHop).toHaveBeenNthCalledWith(
      2,
      baseLease,
      expect.objectContaining({
        index: 1,
        displayUrl: 'https://docs.example.com/final',
        responseStatus: 200,
      }),
    );
    expect(context.operations).toEqual([
      'writeTemporary',
      'prepareRaw',
      'publishTemporary',
      'markRawPublished',
    ]);
    const prepared = vi.mocked(context.repository.prepareRaw).mock.calls[0]?.[1];
    expect(prepared).toEqual(
      expect.objectContaining({
        sha256: createHash('sha256').update('# Guide').digest('hex'),
        sizeBytes: 7,
        mediaType: 'text/markdown',
      }),
    );
    expect(prepared?.storageRef).toMatch(/\/raw\/sha256\/[a-f0-9]{64}\.md$/);
    expect(context.repository.close).toHaveBeenCalledOnce();
    expect(context.storage.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(context.logger.mock.calls)).not.toContain('secret');
  });

  it('parses a previously published raw object and finalizes after parsed publication', async () => {
    const openedBody = '# Guide\n\nRun safely.';
    const rawRef = rawStorageRef(openedBody, 'md');
    const lease: ResourceUrlIngestionLease = {
      ...baseLease,
      phase: 'parse',
      rawStorageRef: rawRef,
      rawMediaType: 'text/markdown',
    };
    const context = setup({ lease, openedBody });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('finalized');

    expect(context.operations).toEqual([
      'writeTemporary',
      'prepareParsed',
      'publishTemporary',
      'markParsedPublished',
      'finalize',
    ]);
    expect(context.repository.prepareParsed).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({
        text: 'Guide\n\nRun safely.',
        parserName: 'workout-bounded-markdown',
        parserVersion: '1',
        fragments: expect.arrayContaining([
          expect.objectContaining({ kind: 'markdown_paragraph', startOffset: 0 }),
        ]),
      }),
    );
  });

  it('keeps raw as a bookmark when bounded parsing rejects the content', async () => {
    const openedBody = 'x'.repeat(65 * 1024);
    const rawRef = rawStorageRef(openedBody, 'txt');
    const context = setup({
      lease: { ...baseLease, phase: 'parse', rawStorageRef: rawRef, rawMediaType: 'text/plain' },
      openedBody,
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe(
      'bookmark_only',
    );
    expect(context.repository.bookmarkOnly).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'parse' }),
      { name: 'workout-bounded-parser', version: '1' },
    );
    expect(context.repository.prepareParsed).not.toHaveBeenCalled();
  });

  it('preserves XHTML media type in the immutable parsed artifact', async () => {
    const openedBody = '<html><body><p>Recovery guide</p></body></html>';
    const context = setup({
      lease: {
        ...baseLease,
        phase: 'parse',
        rawStorageRef: rawStorageRef(openedBody, 'xhtml'),
        rawMediaType: 'application/xhtml+xml',
      },
      openedBody,
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('finalized');

    const artifact = [...context.written.values()][0];
    expect(artifact).toBeDefined();
    if (!artifact) throw new Error('parsed artifact was not written');
    expect(JSON.parse(new TextDecoder().decode(artifact))).toEqual(
      expect.objectContaining({ contentType: 'application/xhtml+xml' }),
    );
  });

  it('closes a disallowed URL with a sanitized permanent failure', async () => {
    const context = setup({
      lease: { ...baseLease, requestedUrl: 'https://blocked.example/private?secret=1' },
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('failed');
    expect(context.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ requestedUrl: 'https://blocked.example/private?secret=1' }),
      'URL_NOT_ALLOWED',
      { retryable: false, retryAfterSeconds: 0 },
    );
    expect(context.dependencies.transport.request).not.toHaveBeenCalled();
    expect(context.repository.close).toHaveBeenCalledOnce();
    expect(context.storage.close).toHaveBeenCalledOnce();
  });

  it('returns lease_lost without publishing when hop recording loses authorization', async () => {
    const networkResponse = response(200, { body: 'safe', contentType: 'text/plain' });
    const context = setup({
      lease: baseLease,
      responses: [networkResponse],
      recordHop: false,
      fail: false,
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('lease_lost');
    expect(networkResponse.discard).toHaveBeenCalled();
    expect(context.storage.writeTemporary).not.toHaveBeenCalled();
    expect(context.repository.fail).toHaveBeenCalledWith(baseLease, 'FETCH_FAILED', {
      retryable: true,
      retryAfterSeconds: 60,
    });
  });

  it('deletes the raw temporary object when prepare loses the lease', async () => {
    const context = setup({
      lease: baseLease,
      responses: [response(200, { body: 'safe', contentType: 'text/plain' })],
      prepareRaw: false,
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('lease_lost');

    expect(context.storage.publishTemporary).not.toHaveBeenCalled();
    expect(context.storage.delete).toHaveBeenCalledOnce();
    expect(context.storage.delete).toHaveBeenCalledWith(baseLease.rawTemporaryRef);
  });

  it('durably queues a newly published raw object when authorization is lost before marking it', async () => {
    const context = setup({
      lease: baseLease,
      responses: [response(200, { body: 'safe', contentType: 'text/plain' })],
      markRawPublished: false,
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('lease_lost');

    const finalKey = vi.mocked(context.storage.publishTemporary).mock.calls[0]?.[1];
    expect(finalKey).toBeDefined();
    expect(context.storage.delete).toHaveBeenCalledWith(baseLease.rawTemporaryRef);
    expect(context.storage.delete).not.toHaveBeenCalledWith(finalKey);
    expect(context.repository.abandonPublishedObject).toHaveBeenCalledWith(baseLease, finalKey);
  });

  it('does not delete a pre-existing content-addressed object after lease loss', async () => {
    const context = setup({
      lease: baseLease,
      responses: [response(200, { body: 'safe', contentType: 'text/plain' })],
      markRawPublished: false,
      publishOutcome: 'already_present',
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('lease_lost');

    const finalKey = vi.mocked(context.storage.publishTemporary).mock.calls[0]?.[1];
    expect(context.storage.delete).toHaveBeenCalledWith(baseLease.rawTemporaryRef);
    expect(context.storage.delete).not.toHaveBeenCalledWith(finalKey);
    expect(context.repository.abandonPublishedObject).not.toHaveBeenCalled();
  });

  it('only deletes the temporary object when publication rejects before visibility', async () => {
    const context = setup({
      lease: baseLease,
      responses: [response(200, { body: 'safe', contentType: 'text/plain' })],
      publishFailure: new Error('publication failed after link'),
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('failed');

    const finalKey = vi.mocked(context.storage.publishTemporary).mock.calls[0]?.[1];
    expect(context.storage.delete).toHaveBeenCalledWith(baseLease.rawTemporaryRef);
    expect(context.storage.delete).not.toHaveBeenCalledWith(finalKey);
    expect(context.repository.fail).toHaveBeenCalledWith(baseLease, 'FETCH_FAILED', {
      retryable: true,
      retryAfterSeconds: 60,
    });
  });

  it('durably queues a newly published parsed object when authorization is lost before marking it', async () => {
    const openedBody = '# Guide\n\nRun safely.';
    const lease: ResourceUrlIngestionLease = {
      ...baseLease,
      phase: 'parse',
      rawStorageRef: rawStorageRef(openedBody, 'md'),
      rawMediaType: 'text/markdown',
    };
    const context = setup({ lease, openedBody, markParsedPublished: false });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('lease_lost');

    const finalKey = vi.mocked(context.storage.publishTemporary).mock.calls[0]?.[1];
    expect(context.storage.delete).toHaveBeenCalledWith(baseLease.parsedTemporaryRef);
    expect(context.storage.delete).not.toHaveBeenCalledWith(finalKey);
    expect(context.repository.abandonPublishedObject).toHaveBeenCalledWith(lease, finalKey);
    expect(context.repository.finalize).not.toHaveBeenCalled();
  });

  it('keeps a marked parsed object when finalization loses the lease', async () => {
    const openedBody = '# Guide\n\nRun safely.';
    const lease: ResourceUrlIngestionLease = {
      ...baseLease,
      phase: 'parse',
      rawStorageRef: rawStorageRef(openedBody, 'md'),
      rawMediaType: 'text/markdown',
    };
    const context = setup({ lease, openedBody, finalize: false });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('lease_lost');

    expect(context.storage.delete).not.toHaveBeenCalled();
  });

  it('treats 404 as permanent and retries bounded transient HTTP statuses', async () => {
    const notFound = setup({ lease: baseLease, responses: [response(404)] });
    await expect(runUrlIngestionWorker(config, notFound.dependencies)).resolves.toBe('failed');
    expect(notFound.repository.fail).toHaveBeenCalledWith(baseLease, 'HTTP_STATUS_REJECTED', {
      retryable: false,
      retryAfterSeconds: 0,
    });

    const throttled = setup({
      lease: baseLease,
      responses: [response(429, { retryAfter: '120' })],
    });
    await expect(runUrlIngestionWorker(config, throttled.dependencies)).resolves.toBe('failed');
    expect(throttled.repository.fail).toHaveBeenCalledWith(baseLease, 'HTTP_STATUS_REJECTED', {
      retryable: true,
      retryAfterSeconds: 120,
    });

    const unavailable = setup({
      lease: baseLease,
      responses: [response(503, { retryAfter: '999999999999' })],
    });
    await expect(runUrlIngestionWorker(config, unavailable.dependencies)).resolves.toBe('failed');
    expect(unavailable.repository.fail).toHaveBeenCalledWith(baseLease, 'HTTP_STATUS_REJECTED', {
      retryable: true,
      retryAfterSeconds: 3600,
    });

    const timedOut = setup({
      lease: baseLease,
      responses: [response(408, { retryAfter: 'invalid' })],
    });
    await expect(runUrlIngestionWorker(config, timedOut.dependencies)).resolves.toBe('failed');
    expect(timedOut.repository.fail).toHaveBeenCalledWith(baseLease, 'HTTP_STATUS_REJECTED', {
      retryable: true,
      retryAfterSeconds: 60,
    });
  });

  it('leases at most one job and closes resources for an empty queue', async () => {
    const context = setup({ lease: null });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('empty');
    expect(context.repository.lease).toHaveBeenCalledOnce();
    expect(context.repository.close).toHaveBeenCalledOnce();
    expect(context.storage.close).toHaveBeenCalledOnce();
  });

  it('closes storage when repository creation fails before a lease', async () => {
    const context = setup({ lease: null });
    const failure = new Error('repository unavailable');
    context.dependencies.createRepository = vi.fn(() => {
      throw failure;
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).rejects.toBe(failure);

    expect(context.storage.close).toHaveBeenCalledOnce();
  });

  it('rejects a raw object reference outside the leased ingestion before storage access', async () => {
    const crossRequestRef =
      'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/resources/4d6cc1ce-0643-4c53-b055-9df458fec594/url-ingestions/5cdb84d0-35e0-4f61-9508-731af25ce25a/raw/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt';
    const context = setup({
      lease: {
        ...baseLease,
        phase: 'parse',
        rawStorageRef: crossRequestRef,
        rawMediaType: 'text/plain',
      },
      openedBody: 'must not be read',
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('failed');

    expect(context.storage.open).not.toHaveBeenCalled();
    expect(context.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'parse' }),
      'RAW_ARTIFACT_INTEGRITY_FAILED',
      { retryable: false, retryAfterSeconds: 0 },
    );
  });

  it('permanently closes a raw artifact whose content does not match its object hash', async () => {
    const claimedBody = 'claimed content';
    const context = setup({
      lease: {
        ...baseLease,
        phase: 'parse',
        rawStorageRef: rawStorageRef(claimedBody, 'txt'),
        rawMediaType: 'text/plain',
      },
      openedBody: 'different content',
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('failed');

    expect(context.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'parse' }),
      'RAW_ARTIFACT_INTEGRITY_FAILED',
      { retryable: false, retryAfterSeconds: 0 },
    );
    expect(context.repository.prepareParsed).not.toHaveBeenCalled();
  });

  it('permanently closes a missing raw artifact with a sanitized code', async () => {
    const context = setup({
      lease: {
        ...baseLease,
        phase: 'parse',
        rawStorageRef: rawStorageRef('missing', 'txt'),
        rawMediaType: 'text/plain',
      },
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('failed');

    expect(context.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'parse' }),
      'RAW_ARTIFACT_MISSING',
      { retryable: false, retryAfterSeconds: 0 },
    );
  });

  it('retries a sanitized parse failure when storage access is transiently unavailable', async () => {
    const context = setup({
      lease: {
        ...baseLease,
        phase: 'parse',
        rawStorageRef: rawStorageRef('unread', 'txt'),
        rawMediaType: 'text/plain',
      },
      openFailure: new Error('sensitive storage root unavailable'),
    });

    await expect(runUrlIngestionWorker(config, context.dependencies)).resolves.toBe('failed');

    expect(context.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'parse' }),
      'PARSE_FAILED',
      { retryable: true, retryAfterSeconds: 60 },
    );
  });
});
