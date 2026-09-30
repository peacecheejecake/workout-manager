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
import { describe, expect, it, vi } from 'vitest';
import { createSuppressionLedgerS3Client } from '../src/suppression-ledger-s3-client.js';

const config = {
  schemaVersion: 1,
  bucket: 'private-ledger-bucket',
  prefix: 'deletion-ledger/v1',
  region: 'ap-northeast-2',
  expectedBucketOwner: '123456789012',
} as const;
const key = `${config.prefix}/head.bin`;
const base = {
  VersionId: 'version-1',
  ETag: '"abc123"',
  ContentLength: 3,
  ServerSideEncryption: 'AES256',
};

function fake(send: (command: unknown) => Promise<unknown>) {
  const spy = vi.fn(send);
  return {
    client: createSuppressionLedgerS3Client(config, { send: spy } as unknown as S3Client),
    spy,
  };
}

function commandInput(command: unknown): unknown {
  if (!command || typeof command !== 'object' || !('input' in command))
    throw new Error('missing input');
  return command.input;
}

describe('suppression ledger S3 client', () => {
  it('owner-binds every operation and reads exact versioned bytes', async () => {
    const { client, spy } = fake(async (command) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: 'Enabled' };
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: config.region };
      if (command instanceof HeadObjectCommand) return base;
      if (command instanceof GetObjectCommand)
        return { ...base, Body: Readable.from([Buffer.from('abc')]) };
      throw new Error('unexpected command');
    });
    await expect(client.versioning()).resolves.toBe('Enabled');
    await expect(client.location()).resolves.toBe(config.region);
    await expect(client.head(key, 'version-1')).resolves.toMatchObject({
      versionId: 'version-1',
      owner: config.expectedBucketOwner,
      encryption: 'AES256',
      deleted: false,
    });
    await expect(client.get(key, 'version-1')).resolves.toMatchObject({
      bytes: Buffer.from('abc'),
    });
    for (const [command] of spy.mock.calls) {
      expect(commandInput(command)).toMatchObject({
        Bucket: config.bucket,
        ExpectedBucketOwner: config.expectedBucketOwner,
      });
    }
  });

  it('paginates all versions and delete markers while ignoring sibling keys', async () => {
    let page = 0;
    const { client, spy } = fake(async (command) => {
      if (!(command instanceof ListObjectVersionsCommand)) throw new Error('unexpected');
      page += 1;
      return page === 1
        ? {
            Name: config.bucket,
            Prefix: key,
            IsTruncated: true,
            NextKeyMarker: key,
            NextVersionIdMarker: 'version-1',
            Versions: [
              { Key: key, VersionId: 'version-1' },
              { Key: `${key}.sibling`, VersionId: 'sibling' },
            ],
          }
        : {
            Name: config.bucket,
            Prefix: key,
            IsTruncated: false,
            DeleteMarkers: [{ Key: key, VersionId: 'deleted-2' }],
          };
    });
    await expect(client.versions(key)).resolves.toEqual(['version-1', 'deleted-2']);
    expect(commandInput(spy.mock.calls[1]?.[0])).toMatchObject({
      KeyMarker: key,
      VersionIdMarker: 'version-1',
      ExpectedBucketOwner: config.expectedBucketOwner,
    });
  });

  it('rejects a stalled pagination cursor', async () => {
    const { client } = fake(async () => ({
      Name: config.bucket,
      Prefix: key,
      IsTruncated: true,
      NextKeyMarker: key,
      NextVersionIdMarker: 'same',
    }));
    await expect(client.versions(key)).rejects.toThrow('LEDGER_REMOTE_FAILED');
  });

  it('preserves opaque S3 version IDs including equals signs', async () => {
    const opaque = 'fU2=opaque+id';
    const { client } = fake(async () => ({ ...base, VersionId: opaque }));
    await expect(client.head(key, opaque)).resolves.toMatchObject({ versionId: opaque });
  });

  it('uses S3 preconditions and SSE-S3 on both writes', async () => {
    const { client, spy } = fake(async (command) => {
      if (!(command instanceof PutObjectCommand)) throw new Error('unexpected');
      return base;
    });
    await client.putIfAbsent(key, Buffer.from('abc'));
    await client.putIfMatch(key, '"abc123"', Buffer.from('def'));
    expect(commandInput(spy.mock.calls[0]?.[0])).toMatchObject({
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      ContentLength: 3,
    });
    expect(commandInput(spy.mock.calls[1]?.[0])).toMatchObject({
      IfMatch: '"abc123"',
      ServerSideEncryption: 'AES256',
      ContentLength: 3,
    });
  });

  it('rejects missing or conflicting metadata and oversized streams', async () => {
    const missingVersion = fake(async () => ({
      ...base,
      VersionId: undefined,
      Body: Readable.from([Buffer.from('abc')]),
    }));
    await expect(missingVersion.client.get(key, 'version-1')).rejects.toThrow(
      'LEDGER_REMOTE_FAILED',
    );
    const oversized = fake(async () => ({ ...base, Body: Readable.from([Buffer.from('abcd')]) }));
    await expect(oversized.client.get(key, 'version-1')).rejects.toThrow('LEDGER_REMOTE_FAILED');
    const wrongSse = fake(async () => ({ ...base, ServerSideEncryption: 'aws:kms' }));
    await expect(wrongSse.client.putIfAbsent(key, Buffer.from('abc'))).rejects.toThrow(
      'LEDGER_REMOTE_FAILED',
    );
  });
});
