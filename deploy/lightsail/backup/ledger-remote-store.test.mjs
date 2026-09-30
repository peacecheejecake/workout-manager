import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { uploadLedgerSegment } from './ledger-remote-store.mjs';

const config = {
  schemaVersion: 1,
  bucket: 'workout-private-backups',
  prefix: 'workout/deletion-ledger/v1',
  region: 'ap-northeast-2',
  expectedBucketOwner: '681892421656',
};

const segmentId = 'segment-0001';
const key = `${config.prefix}/segments/${segmentId}.bin`;

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wm-ledger-test-')));
  const segmentPath = join(directory, 'segment.bin');
  writeFileSync(segmentPath, 'synthetic ledger segment', { mode: 0o600 });
  return { directory, segmentPath };
}

class FakeS3 {
  config = config;
  objects = new Map();
  nextVersion = 0;
  region = config.region;
  status = 'Enabled';
  failPut = false;
  storeThenFail = false;
  failGet = false;
  corruptGet = false;

  async versioning() {
    return this.status;
  }

  async location() {
    return this.region;
  }

  async putIfAbsent(objectKey, path) {
    if (this.objects.has(objectKey) || this.failPut) throw new Error('put failed');
    const object = {
      versionId: String(++this.nextVersion),
      encryption: 'AES256',
      data: readFileSync(path),
    };
    this.objects.set(objectKey, object);
    if (this.storeThenFail) throw new Error('response lost');
    return object.versionId;
  }

  async getLatestOrNull(objectKey, path) {
    const object = this.objects.get(objectKey);
    if (!object) return null;
    this.write(object, path);
    return { versionId: object.versionId, encryption: object.encryption };
  }

  async head(objectKey, versionId) {
    const object = this.objects.get(objectKey);
    if (!object || object.versionId !== versionId) throw new Error('missing version');
    return { versionId: object.versionId, encryption: object.encryption };
  }

  async get(objectKey, versionId, path) {
    const object = this.objects.get(objectKey);
    if (!object || object.versionId !== versionId) throw new Error('missing version');
    this.write(object, path);
    return { versionId: object.versionId };
  }

  write(object, path) {
    if (this.failGet) throw new Error('read interrupted');
    writeFileSync(path, this.corruptGet ? 'corrupt' : object.data, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}

test('conditional upload verifies exact versioned bytes and duplicate returns the same version', async () => {
  const { directory, segmentPath } = fixture();
  const client = new FakeS3();
  try {
    const first = await uploadLedgerSegment({
      segmentPath,
      segmentId,
      config,
      client,
      synthetic: true,
    });
    assert.deepEqual(first, { segmentId, versionId: '1', alreadyStored: false });
    assert.deepEqual([...client.objects.keys()], [key]);
    assert.deepEqual(client.objects.get(key).data, readFileSync(segmentPath));
    const retry = await uploadLedgerSegment({
      segmentPath,
      segmentId,
      config,
      client,
      synthetic: true,
    });
    assert.deepEqual(retry, { segmentId, versionId: '1', alreadyStored: true });
    assert.equal(client.nextVersion, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lost put response succeeds only after exact versioned remote verification', async () => {
  const { directory, segmentPath } = fixture();
  const client = new FakeS3();
  client.storeThenFail = true;
  try {
    const result = await uploadLedgerSegment({
      segmentPath,
      segmentId,
      config,
      client,
      synthetic: true,
    });
    assert.deepEqual(result, { segmentId, versionId: '1', alreadyStored: true });
    assert.equal(client.nextVersion, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('conflicting key, partial put, failed readback, and wrong encryption fail closed', async () => {
  const { directory, segmentPath } = fixture();
  const client = new FakeS3();
  try {
    client.failPut = true;
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
    assert.equal(client.objects.has(key), false);
    client.failPut = false;
    client.failGet = true;
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
    assert.equal(client.objects.has(key), true);
    client.failGet = false;
    client.objects.get(key).data = Buffer.from('different segment');
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
    client.objects.get(key).data = readFileSync(segmentPath);
    client.objects.get(key).encryption = 'aws:kms';
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
    client.objects.get(key).encryption = 'AES256';
    client.corruptGet = true;
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects identity mismatch, unsafe keys/files, disabled versioning and wrong region', async () => {
  const { directory, segmentPath } = fixture();
  const client = new FakeS3();
  try {
    const invalidConfigs = [
      { ...config, expectedBucketOwner: '000000000000' },
      { ...config, bucket: 'other-bucket' },
      { ...config, prefix: 'workout/v1' },
      { ...config, prefix: '../deletion-ledger/v1' },
      { ...config, region: 'ap-northeast-1' },
    ];
    for (const invalid of invalidConfigs) {
      await assert.rejects(
        uploadLedgerSegment({ segmentPath, segmentId, config: invalid, client, synthetic: true }),
      );
    }
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId: '../other', config, client, synthetic: true }),
    );
    chmodSync(segmentPath, 0o644);
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
    chmodSync(segmentPath, 0o600);
    client.status = 'Suspended';
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
    client.status = 'Enabled';
    client.region = 'ap-northeast-1';
    await assert.rejects(
      uploadLedgerSegment({ segmentPath, segmentId, config, client, synthetic: true }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
