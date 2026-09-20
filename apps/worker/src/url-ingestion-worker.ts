import { createHash } from 'node:crypto';

import {
  createLocalFilesystemObjectStorage,
  createUrlFinalObjectKey,
  createUrlTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
  type ObjectStorage,
} from '@workout/server-media';
import {
  BoundedParserError,
  createExactHostAllowlist,
  createNodeNetworkAdapters,
  fetchBoundedResource,
  IngestionFetchError,
  parseBoundedDocument,
  type IngestionResolver,
  type IngestionTransport,
} from '@workout/server-resource-ingestion';
import {
  createResourceUrlIngestionWorkerRepository,
  type ResourceUrlFragment,
  type ResourceUrlIngestionLease,
} from '@workout/server-persistence/resource-url-ingestions';

import type { ResourceUrlIngestionWorkerConfig } from './url-ingestion.js';

const FETCH_POLICY_VERSION = 'resource-url-fetch-v1';
const PARSER_VERSION = '1';
const MAX_PARSED_ARTIFACT_BYTES = 1024 * 1024;
const MAX_PERSISTED_FRAGMENTS_BYTES = 512 * 1024;

export type UrlIngestionWorkerResult =
  'empty' | 'raw_published' | 'finalized' | 'bookmark_only' | 'failed' | 'lease_lost';

export interface UrlIngestionWorkerRepository {
  lease(durationSeconds?: number): Promise<ResourceUrlIngestionLease | null>;
  recordHop(
    lease: ResourceUrlIngestionLease,
    input: {
      index: number;
      displayUrl: string;
      urlDigest: string;
      responseStatus?: number;
      resolvedAddresses: string[];
      policyVersion: string;
    },
  ): Promise<boolean>;
  prepareRaw(
    lease: ResourceUrlIngestionLease,
    input: { storageRef: string; sha256: string; sizeBytes: number; mediaType: string },
  ): Promise<boolean>;
  markRawPublished(lease: ResourceUrlIngestionLease): Promise<boolean>;
  prepareParsed(
    lease: ResourceUrlIngestionLease,
    input: {
      storageRef: string;
      sha256: string;
      sizeBytes: number;
      text: string;
      fragments: ResourceUrlFragment[];
      parserName: string;
      parserVersion: string;
    },
  ): Promise<boolean>;
  markParsedPublished(lease: ResourceUrlIngestionLease): Promise<boolean>;
  abandonPublishedObject(lease: ResourceUrlIngestionLease, storageRef: string): Promise<boolean>;
  finalize(lease: ResourceUrlIngestionLease): Promise<unknown | null>;
  fail(
    lease: ResourceUrlIngestionLease,
    code: string,
    options?: { retryable?: boolean; retryAfterSeconds?: number },
  ): Promise<boolean>;
  bookmarkOnly(
    lease: ResourceUrlIngestionLease,
    parser: { name: string; version: string },
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface ClosableObjectStorage extends ObjectStorage {
  close?(): Promise<void>;
}

export interface UrlIngestionWorkerDependencies {
  createStorage(rootDirectory: string): Promise<ClosableObjectStorage>;
  createRepository(options: {
    connectionString: string;
    workerId?: string;
  }): UrlIngestionWorkerRepository;
  resolver: IngestionResolver;
  transport: IngestionTransport;
  logger?: (event: {
    event: 'resource_url_ingestion_finished';
    phase: ResourceUrlIngestionLease['phase'];
    result: UrlIngestionWorkerResult;
  }) => void;
}

class LeaseLostError extends Error {
  constructor() {
    super('URL_INGESTION_LEASE_LOST');
    this.name = 'LeaseLostError';
  }
}

class RawArtifactError extends Error {
  constructor(readonly code: 'RAW_ARTIFACT_MISSING' | 'RAW_ARTIFACT_INTEGRITY_FAILED') {
    super(code);
    this.name = 'RawArtifactError';
  }
}

function oneChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield value;
  })();
}

async function collect(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new BoundedParserError('PARSER_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function rawExtension(contentType: string): 'html' | 'xhtml' | 'txt' | 'md' {
  if (contentType === 'text/html') return 'html';
  if (contentType === 'application/xhtml+xml') return 'xhtml';
  if (contentType === 'text/markdown') return 'md';
  return 'txt';
}

function parsedArtifact(document: ReturnType<typeof parseBoundedDocument>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      parser: document.parser,
      contentType: document.contentType,
      sourceSha256: document.sourceSha256,
      textSha256: document.textSha256,
      ...(document.title ? { title: document.title } : {}),
      text: document.text,
      fragments: document.fragments,
    }),
  );
}

function persistenceFragments(
  document: ReturnType<typeof parseBoundedDocument>,
): ResourceUrlFragment[] {
  return document.fragments.map((fragment) => ({
    ordinal: fragment.locator.index,
    kind: fragment.locator.kind,
    headingPath: 'headingPath' in fragment.locator ? [...fragment.locator.headingPath] : [],
    ...('paragraphIndex' in fragment.locator
      ? { paragraphIndex: fragment.locator.paragraphIndex }
      : {}),
    text: fragment.text,
    startOffset: fragment.locator.startOffset,
    endOffset: fragment.locator.endOffset,
  }));
}

function fetchFailure(error: unknown): {
  code: string;
  retryable: boolean;
  retryAfterSeconds: number;
} {
  if (!(error instanceof IngestionFetchError))
    return { code: 'FETCH_FAILED', retryable: true, retryAfterSeconds: 60 };
  if (error.code === 'HTTP_STATUS_REJECTED') {
    const statusCode = error.details?.statusCode;
    const retryable =
      statusCode === 408 ||
      statusCode === 425 ||
      statusCode === 429 ||
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504;
    return {
      code: error.code,
      retryable,
      retryAfterSeconds: retryable ? (error.details?.retryAfterSeconds ?? 60) : 0,
    };
  }
  const retryable = new Set(['FETCH_TIMEOUT', 'FETCH_FAILED', 'DNS_RESOLUTION_FAILED']).has(
    error.code,
  );
  return { code: error.code, retryable, retryAfterSeconds: retryable ? 60 : 0 };
}

async function cleanupUncommittedArtifact(
  repository: UrlIngestionWorkerRepository,
  lease: ResourceUrlIngestionLease,
  storage: ClosableObjectStorage,
  temporaryKey: Parameters<ObjectStorage['delete']>[0],
  finalKey: Parameters<ObjectStorage['delete']>[0],
  finalWasPublished: boolean,
): Promise<void> {
  await storage.delete(temporaryKey).catch(() => undefined);
  if (finalWasPublished && !(await repository.abandonPublishedObject(lease, finalKey)))
    throw new Error('URL_INGESTION_CLEANUP_NOT_QUEUED');
}

async function fetchPhase(
  config: ResourceUrlIngestionWorkerConfig,
  lease: ResourceUrlIngestionLease,
  repository: UrlIngestionWorkerRepository,
  storage: ClosableObjectStorage,
  dependencies: Pick<UrlIngestionWorkerDependencies, 'resolver' | 'transport'>,
): Promise<UrlIngestionWorkerResult> {
  let temporaryKey: ReturnType<typeof createUrlTemporaryObjectKey> | undefined;
  let finalKey: ReturnType<typeof createUrlFinalObjectKey> | undefined;
  let artifactCommitted = false;
  let publishedByThisRun = false;
  try {
    const fetched = await fetchBoundedResource({
      rawUrl: lease.requestedUrl,
      policy: { allowedHosts: createExactHostAllowlist(config.allowedHosts), maxRedirectHops: 5 },
      resolver: dependencies.resolver,
      transport: dependencies.transport,
      onHop: async (observation) => {
        const recorded = await repository.recordHop(lease, {
          index: observation.hopIndex,
          displayUrl: observation.displayUrl,
          urlDigest: observation.normalizedUrlSha256,
          responseStatus: observation.responseStatus,
          resolvedAddresses: observation.resolvedAddresses.map((answer) => answer.address),
          policyVersion: FETCH_POLICY_VERSION,
        });
        if (!recorded) throw new LeaseLostError();
      },
    });
    temporaryKey = createUrlTemporaryObjectKey({
      tenantId: lease.athleteId,
      resourceId: lease.resourceId,
      ingestionId: lease.requestId,
      artifactKind: 'raw',
    });
    if (lease.rawTemporaryRef !== temporaryKey) throw new Error('RAW_ARTIFACT_MISMATCH');
    finalKey = createUrlFinalObjectKey({
      tenantId: lease.athleteId,
      resourceId: lease.resourceId,
      ingestionId: lease.requestId,
      artifactKind: 'raw',
      sha256: fetched.sha256,
      extension: rawExtension(fetched.contentType),
    });
    await storage.writeTemporary(temporaryKey, oneChunk(fetched.body));
    if (
      !(await repository.prepareRaw(lease, {
        storageRef: finalKey,
        sha256: fetched.sha256,
        sizeBytes: fetched.body.byteLength,
        mediaType: fetched.contentType,
      }))
    )
      throw new LeaseLostError();
    const publication = await storage.publishTemporary(temporaryKey, finalKey, {
      sha256: fetched.sha256,
      sizeBytes: fetched.body.byteLength,
    });
    publishedByThisRun = publication.outcome === 'published';
    if (!(await repository.markRawPublished(lease))) throw new LeaseLostError();
    artifactCommitted = true;
    return 'raw_published';
  } catch (error) {
    if (!artifactCommitted && temporaryKey && finalKey)
      await cleanupUncommittedArtifact(
        repository,
        lease,
        storage,
        temporaryKey,
        finalKey,
        publishedByThisRun,
      );
    if (error instanceof LeaseLostError) return 'lease_lost';
    const failure = fetchFailure(error);
    const recorded = await repository.fail(lease, failure.code, {
      retryable: failure.retryable,
      retryAfterSeconds: failure.retryAfterSeconds,
    });
    return recorded ? 'failed' : 'lease_lost';
  }
}

async function parsePhase(
  lease: ResourceUrlIngestionLease,
  repository: UrlIngestionWorkerRepository,
  storage: ClosableObjectStorage,
): Promise<UrlIngestionWorkerResult> {
  let temporaryKey: ReturnType<typeof createUrlTemporaryObjectKey> | undefined;
  let finalKey: ReturnType<typeof createUrlFinalObjectKey> | undefined;
  let artifactCommitted = false;
  let publishedByThisRun = false;
  try {
    if (!lease.rawStorageRef || !lease.rawMediaType)
      throw new RawArtifactError('RAW_ARTIFACT_MISSING');
    let parsedRawKey: ReturnType<typeof parseObjectKey>;
    try {
      parsedRawKey = parseObjectKey(lease.rawStorageRef);
    } catch {
      throw new RawArtifactError('RAW_ARTIFACT_INTEGRITY_FAILED');
    }
    if (
      parsedRawKey.kind !== 'url_final' ||
      parsedRawKey.tenantId !== lease.athleteId ||
      parsedRawKey.resourceId !== lease.resourceId ||
      parsedRawKey.ingestionId !== lease.requestId ||
      parsedRawKey.artifactKind !== 'raw' ||
      parsedRawKey.extension !== rawExtension(lease.rawMediaType)
    )
      throw new RawArtifactError('RAW_ARTIFACT_INTEGRITY_FAILED');
    const opened = await storage.open(validateObjectKey(lease.rawStorageRef));
    if (!opened) throw new RawArtifactError('RAW_ARTIFACT_MISSING');
    let body: Uint8Array;
    try {
      body = await collect(opened.body, 1024 * 1024);
    } catch (error) {
      if (error instanceof BoundedParserError)
        throw new RawArtifactError('RAW_ARTIFACT_INTEGRITY_FAILED');
      throw error;
    }
    const rawSha256 = createHash('sha256').update(body).digest('hex');
    if (rawSha256 !== parsedRawKey.sha256)
      throw new RawArtifactError('RAW_ARTIFACT_INTEGRITY_FAILED');
    let document: ReturnType<typeof parseBoundedDocument>;
    try {
      document = parseBoundedDocument({
        body,
        contentType: lease.rawMediaType,
      });
      if (document.fragments.length === 0)
        return (await repository.bookmarkOnly(lease, {
          name: document.parser.id,
          version: PARSER_VERSION,
        }))
          ? 'bookmark_only'
          : 'lease_lost';
    } catch (error) {
      if (error instanceof BoundedParserError)
        return (await repository.bookmarkOnly(lease, {
          name: 'workout-bounded-parser',
          version: PARSER_VERSION,
        }))
          ? 'bookmark_only'
          : 'lease_lost';
      throw error;
    }
    const fragments = persistenceFragments(document);
    const artifact = parsedArtifact(document);
    if (
      artifact.byteLength > MAX_PARSED_ARTIFACT_BYTES ||
      new TextEncoder().encode(JSON.stringify(fragments)).byteLength > MAX_PERSISTED_FRAGMENTS_BYTES
    )
      return (await repository.bookmarkOnly(lease, {
        name: document.parser.id,
        version: PARSER_VERSION,
      }))
        ? 'bookmark_only'
        : 'lease_lost';
    const sha256 = createHash('sha256').update(artifact).digest('hex');
    temporaryKey = createUrlTemporaryObjectKey({
      tenantId: lease.athleteId,
      resourceId: lease.resourceId,
      ingestionId: lease.requestId,
      artifactKind: 'parsed',
    });
    if (lease.parsedTemporaryRef !== temporaryKey) throw new Error('PARSED_ARTIFACT_MISMATCH');
    finalKey = createUrlFinalObjectKey({
      tenantId: lease.athleteId,
      resourceId: lease.resourceId,
      ingestionId: lease.requestId,
      artifactKind: 'parsed',
      sha256,
      extension: 'json',
    });
    await storage.writeTemporary(temporaryKey, oneChunk(artifact));
    if (
      !(await repository.prepareParsed(lease, {
        storageRef: finalKey,
        sha256,
        sizeBytes: artifact.byteLength,
        text: document.text,
        fragments,
        parserName: document.parser.id,
        parserVersion: PARSER_VERSION,
      }))
    )
      throw new LeaseLostError();
    const publication = await storage.publishTemporary(temporaryKey, finalKey, {
      sha256,
      sizeBytes: artifact.byteLength,
    });
    publishedByThisRun = publication.outcome === 'published';
    if (!(await repository.markParsedPublished(lease))) throw new LeaseLostError();
    artifactCommitted = true;
    if ((await repository.finalize(lease)) === null) throw new LeaseLostError();
    return 'finalized';
  } catch (error) {
    if (!artifactCommitted && temporaryKey && finalKey)
      await cleanupUncommittedArtifact(
        repository,
        lease,
        storage,
        temporaryKey,
        finalKey,
        publishedByThisRun,
      );
    if (error instanceof LeaseLostError) return 'lease_lost';
    const permanent = error instanceof RawArtifactError;
    const recorded = await repository.fail(lease, permanent ? error.code : 'PARSE_FAILED', {
      retryable: !permanent,
      retryAfterSeconds: permanent ? 0 : 60,
    });
    return recorded ? 'failed' : 'lease_lost';
  }
}

/** Processes at most one leased phase, with network and parsing outside database transactions. */
export async function runUrlIngestionWorker(
  config: ResourceUrlIngestionWorkerConfig,
  dependencies?: UrlIngestionWorkerDependencies,
): Promise<UrlIngestionWorkerResult> {
  const resolvedDependencies: UrlIngestionWorkerDependencies = (() => {
    if (dependencies) return dependencies;
    const adapters = createNodeNetworkAdapters();
    return {
      createStorage: createLocalFilesystemObjectStorage,
      createRepository: createResourceUrlIngestionWorkerRepository,
      resolver: adapters.resolver,
      transport: adapters.transport,
    };
  })();
  const storage = await resolvedDependencies.createStorage(config.storageRoot);
  let repository: UrlIngestionWorkerRepository | undefined;
  let result: UrlIngestionWorkerResult | undefined;
  let processingError: unknown;
  try {
    repository = resolvedDependencies.createRepository({
      connectionString: config.connectionString,
    });
    const lease = await repository.lease(60);
    if (!lease) result = 'empty';
    else {
      result =
        lease.phase === 'fetch'
          ? await fetchPhase(config, lease, repository, storage, resolvedDependencies)
          : await parsePhase(lease, repository, storage);
      resolvedDependencies.logger?.({
        event: 'resource_url_ingestion_finished',
        phase: lease.phase,
        result,
      });
    }
  } catch (error) {
    processingError = error;
  }
  const closed = await Promise.allSettled([
    Promise.resolve().then(() => repository?.close()),
    Promise.resolve().then(() => storage.close?.()),
  ]);
  if (processingError !== undefined) throw processingError;
  const failedClose = closed.find(
    (closeResult): closeResult is PromiseRejectedResult => closeResult.status === 'rejected',
  );
  if (failedClose) throw failedClose.reason;
  if (result === undefined) throw new Error('RESOURCE_URL_INGESTION_RESULT_MISSING');
  return result;
}
