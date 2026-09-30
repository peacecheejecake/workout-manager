import {
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type {
  SuppressionRemoteConfig,
  SuppressionVersionedObjectClient,
} from '../../../deploy/lightsail/backup/ledger-remote-store.mjs';

const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 1_000;
const MAX_VERSIONS = 100_000;
const ETAG = /^"[a-fA-F0-9-]{1,128}"$/;

export type SuppressionLedgerS3Config = SuppressionRemoteConfig;

export interface SuppressionLedgerS3Object {
  versionId: string;
  etag: string;
  bytes: Buffer;
  encryption: 'AES256';
  deleted: false;
  owner: string;
  region: 'ap-northeast-2';
}

function fail(): never {
  throw new Error('LEDGER_REMOTE_FAILED');
}

function version(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === 'null' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    })
  )
    fail();
  return value;
}

function etag(value: unknown): string {
  if (typeof value !== 'string' || !ETAG.test(value)) fail();
  return value;
}

function contentLength(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_OBJECT_BYTES)
    fail();
  return value as number;
}

function validateConfig(config: SuppressionLedgerS3Config): void {
  if (
    config?.schemaVersion !== 1 ||
    typeof config.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    typeof config.prefix !== 'string' ||
    !/^(?:[a-z0-9-]+\/)*deletion-ledger\/v1$/.test(config.prefix) ||
    config.region !== 'ap-northeast-2' ||
    typeof config.expectedBucketOwner !== 'string' ||
    !/^\d{12}$/.test(config.expectedBucketOwner) ||
    Object.keys(config).sort().join(',') !==
      ['bucket', 'expectedBucketOwner', 'prefix', 'region', 'schemaVersion'].sort().join(',')
  )
    fail();
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    (record.name === 'NoSuchKey' || record.name === 'NotFound') &&
    record.$metadata?.httpStatusCode === 404
  );
}

async function safeSend<T>(operation: () => Promise<T>, allowMissing = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (allowMissing && isMissing(error)) throw error;
    fail();
  }
}

async function readBody(body: unknown, expectedLength: number): Promise<Buffer> {
  if (!(body instanceof Readable)) fail();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail();
      length += chunk.byteLength;
      if (length > expectedLength || length > MAX_OBJECT_BYTES) fail();
      chunks.push(Buffer.from(chunk));
    }
    if (length !== expectedLength) fail();
    return Buffer.concat(chunks, length);
  } finally {
    body.destroy();
  }
}

/** Owner-bound S3 operations for the injected ledger remote-store boundary. */
export function createSuppressionLedgerS3Client(
  config: SuppressionLedgerS3Config,
  s3: S3Client,
): SuppressionVersionedObjectClient {
  validateConfig(config);
  if (!s3 || typeof s3.send !== 'function') fail();
  const common = { Bucket: config.bucket, ExpectedBucketOwner: config.expectedBucketOwner };
  const metadata = (response: {
    VersionId?: string | undefined;
    ETag?: string | undefined;
    ServerSideEncryption?: string | undefined;
    ContentLength?: number | undefined;
    DeleteMarker?: boolean | undefined;
  }) => {
    if (response.ServerSideEncryption !== 'AES256' || response.DeleteMarker === true) fail();
    return {
      versionId: version(response.VersionId),
      etag: etag(response.ETag),
      length: contentLength(response.ContentLength),
      encryption: 'AES256' as const,
      deleted: false as const,
      owner: config.expectedBucketOwner,
      region: config.region,
    };
  };
  const get = async (
    key: string,
    requestedVersionId?: string,
  ): Promise<SuppressionLedgerS3Object> => {
    if (requestedVersionId) version(requestedVersionId);
    const response = await safeSend(
      () =>
        s3.send(
          new GetObjectCommand({
            ...common,
            Key: key,
            ...(requestedVersionId ? { VersionId: requestedVersionId } : {}),
          }),
        ),
      !requestedVersionId,
    );
    const info = metadata(response);
    if (requestedVersionId && info.versionId !== requestedVersionId) fail();
    const bytes = await readBody(response.Body, info.length);
    return { ...info, bytes };
  };
  return {
    config,
    async versioning(): Promise<string> {
      const response = await safeSend(() => s3.send(new GetBucketVersioningCommand(common)));
      if (response.Status !== 'Enabled') fail();
      return response.Status;
    },
    async location(): Promise<string> {
      const response = await safeSend(() => s3.send(new GetBucketLocationCommand(common)));
      if (response.LocationConstraint !== config.region) fail();
      return config.region;
    },
    async head(key: string, requestedVersionId: string) {
      version(requestedVersionId);
      const response = await safeSend(() =>
        s3.send(
          new HeadObjectCommand({
            ...common,
            Key: key,
            VersionId: requestedVersionId,
          }),
        ),
      );
      const info = metadata(response);
      if (info.versionId !== requestedVersionId) fail();
      return info;
    },
    get,
    async getLatestOrNull(key: string): Promise<SuppressionLedgerS3Object | null> {
      try {
        return await get(key);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async versions(key: string): Promise<string[]> {
      const found: string[] = [];
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await safeSend(() =>
          s3.send(
            new ListObjectVersionsCommand({
              ...common,
              Prefix: key,
              MaxKeys: 1_000,
              ...(keyMarker ? { KeyMarker: keyMarker } : {}),
              ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
            }),
          ),
        );
        if (
          response.Name !== config.bucket ||
          response.Prefix !== key ||
          typeof response.IsTruncated !== 'boolean'
        )
          fail();
        for (const entry of [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]) {
          if (entry.Key !== key) continue;
          const id = version(entry.VersionId);
          if (seen.has(id)) fail();
          seen.add(id);
          found.push(id);
          if (found.length > MAX_VERSIONS) fail();
        }
        if (!response.IsTruncated) return found;
        if (typeof response.NextKeyMarker !== 'string' || !response.NextKeyMarker.startsWith(key))
          fail();
        keyMarker = response.NextKeyMarker;
        versionIdMarker = version(response.NextVersionIdMarker);
        const cursor = `${keyMarker}\0${versionIdMarker}`;
        if (cursors.has(cursor)) fail();
        cursors.add(cursor);
      }
      fail();
    },
    async putIfAbsent(key: string, bytes: Buffer) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_OBJECT_BYTES) fail();
      const response = await safeSend(() =>
        s3.send(
          new PutObjectCommand({
            ...common,
            Key: key,
            Body: bytes,
            ContentLength: bytes.length,
            IfNoneMatch: '*',
            ServerSideEncryption: 'AES256',
          }),
        ),
      );
      if (response.ServerSideEncryption !== 'AES256') fail();
      return {
        versionId: version(response.VersionId),
        etag: etag(response.ETag),
        encryption: 'AES256' as const,
        deleted: false as const,
        owner: config.expectedBucketOwner,
        region: config.region,
      };
    },
    async putIfMatch(key: string, expectedEtag: string, bytes: Buffer) {
      etag(expectedEtag);
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_OBJECT_BYTES) fail();
      const response = await safeSend(() =>
        s3.send(
          new PutObjectCommand({
            ...common,
            Key: key,
            Body: bytes,
            ContentLength: bytes.length,
            IfMatch: expectedEtag,
            ServerSideEncryption: 'AES256',
          }),
        ),
      );
      if (response.ServerSideEncryption !== 'AES256') fail();
      return {
        versionId: version(response.VersionId),
        etag: etag(response.ETag),
        encryption: 'AES256' as const,
        deleted: false as const,
        owner: config.expectedBucketOwner,
        region: config.region,
      };
    },
  };
}
