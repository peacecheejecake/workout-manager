import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

// The following fake is intentionally a versioned object client, not an AWS client.
// Every response carries the metadata the adapter requires from an owner-bound request.
class VersionedFake {
  config = config;
  objects = new Map();
  nextVersion = 0;
  status = 'Enabled';
  region = config.region;
  fault = '';

  async versioning() {
    return this.status;
  }
  async location() {
    return this.region;
  }
  async versions(key) {
    return (this.objects.get(key) ?? []).map((object) => object.versionId);
  }
  metadata(object) {
    return {
      versionId: object.versionId,
      etag: object.etag,
      encryption: object.encryption ?? 'AES256',
      owner: object.owner ?? config.expectedBucketOwner,
      region: object.region ?? config.region,
      deleted: object.deleted ?? false,
    };
  }
  seed(key, bytes, changes = {}) {
    const versionId = String(++this.nextVersion);
    const object = { versionId, etag: `"${versionId}"`, bytes: Buffer.from(bytes), ...changes };
    this.objects.set(key, [...(this.objects.get(key) ?? []), object]);
    return object;
  }
  async getLatestOrNull(key) {
    const object = this.objects.get(key)?.at(-1);
    if (!object) return null;
    return { ...this.metadata(object), bytes: Buffer.from(object.bytes) };
  }
  async head(key, versionId) {
    const object = this.objects.get(key)?.find((item) => item.versionId === versionId);
    if (!object) throw new Error('missing version');
    return this.metadata(object);
  }
  async get(key, versionId) {
    const object = this.objects.get(key)?.find((item) => item.versionId === versionId);
    if (!object) throw new Error('missing version');
    return {
      ...this.metadata(object),
      bytes: Buffer.from(this.fault === 'corrupt' ? 'corrupt' : object.bytes),
    };
  }
  async putIfAbsent(key, bytes) {
    if (this.objects.get(key)?.at(-1)?.deleted === false) throw new Error('conflict');
    const object = this.seed(key, bytes);
    if (this.fault === 'lost') throw new Error('lost response');
    return this.metadata(object);
  }
  async putIfMatch(key, etag, bytes) {
    if (this.objects.get(key)?.at(-1)?.etag !== etag) throw new Error('conflict');
    const object = this.seed(key, bytes);
    if (this.fault === 'lost') throw new Error('lost response');
    return this.metadata(object);
  }
}

const headKey = `${config.prefix}/head.bin`;

test('versioned adapter verifies opaque head and immutable segment exact versions', async () => {
  const client = new VersionedFake();
  const first = client.seed(headKey, Buffer.from('signed head'));
  const { createSuppressionRemoteStore } = await import('./ledger-remote-store.mjs');
  const store = createSuppressionRemoteStore({ config, client });
  assert.deepEqual(await store.readHead(), {
    bytes: Buffer.from('signed head'),
    versionId: first.versionId,
  });
  const segment = await store.putImmutableSegment(Buffer.from('encrypted segment'));
  assert.match(segment.segmentId, /^[a-f0-9]{64}$/);
  assert.deepEqual(await store.readSegment(segment.segmentId, segment.versionId), {
    bytes: Buffer.from('encrypted segment'),
    versionId: segment.versionId,
  });
  const next = await store.compareAndSetHead(first.versionId, Buffer.from('new signed head'));
  assert.deepEqual(await store.readHead(), {
    bytes: Buffer.from('new signed head'),
    versionId: next.versionId,
  });
  await assert.rejects(store.compareAndSetHead(first.versionId, Buffer.from('stale')));
  await assert.rejects(store.putImmutableSegment(Buffer.from('encrypted segment')));
});

test('versioned adapter rejects missing head, old or deleted versions, and unsafe metadata', async () => {
  const { createSuppressionRemoteStore } = await import('./ledger-remote-store.mjs');
  const client = new VersionedFake();
  const store = createSuppressionRemoteStore({ config, client });
  await assert.rejects(store.readHead());
  const head = client.seed(headKey, Buffer.from('signed'));
  head.owner = '000000000000';
  await assert.rejects(store.readHead());
  head.owner = config.expectedBucketOwner;
  head.region = 'ap-northeast-1';
  await assert.rejects(store.readHead());
  head.region = config.region;
  head.encryption = 'aws:kms';
  await assert.rejects(store.readHead());
  head.encryption = 'AES256';
  head.deleted = true;
  await assert.rejects(store.readHead());
  head.deleted = false;
  client.status = 'Suspended';
  await assert.rejects(store.readHead());
  client.status = 'Enabled';
  await assert.rejects(store.readSegment('bad/key', head.versionId));
  await assert.rejects(store.readSegment('a'.repeat(64), head.versionId));
});

test('versioned adapter rejects uncertain writes, corrupt readback, and deleted marker reuse', async () => {
  const { createSuppressionRemoteStore } = await import('./ledger-remote-store.mjs');
  const client = new VersionedFake();
  const head = client.seed(headKey, Buffer.from('signed'));
  const store = createSuppressionRemoteStore({ config, client });
  client.fault = 'lost';
  await assert.rejects(store.compareAndSetHead(head.versionId, Buffer.from('new')));
  client.fault = '';
  await assert.rejects(store.compareAndSetHead(head.versionId, Buffer.from('stale')));
  client.fault = 'corrupt';
  await assert.rejects(store.putImmutableSegment(Buffer.from('ciphertext')));
  client.fault = '';
  const segmentId = createHash('sha256').update('deleted ciphertext').digest('hex');
  client.seed(`${config.prefix}/segments/${segmentId}.bin`, Buffer.alloc(0), { deleted: true });
  await assert.rejects(store.putImmutableSegment(Buffer.from('deleted ciphertext')));
});
