import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadBundle, uploadBundle } from './remote-store.mjs';

const config = {
  schemaVersion: 1,
  bucket: 'workout-private-backups',
  prefix: 'workout/v1',
  region: 'ap-northeast-2',
  expectedBucketOwner: '681892421656',
};

function digest(value) {
  return { sha256: createHash('sha256').update(value).digest('hex'), bytes: value.length };
}

const snapshot = {
  snapshotName: '00000001-00000002-1',
  consistentPointLsn: '0/16B6C50',
  postgresSystemIdentifier: '1234567890123456789',
  replicationSlot: 'workout_slot',
  publication: 'workout_publication',
};

function fixture(schemaVersion = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-remote-test-')));
  const bundle = join(root, 'backup-fixture');
  mkdirSync(bundle, { mode: 0o700 });
  mkdirSync(join(bundle, 'private'), { mode: 0o700 });
  const database = Buffer.from('PGDMPsynthetic');
  const privateFile = Buffer.from('synthetic-private');
  writeFileSync(join(bundle, 'database.dump'), database, { mode: 0o600 });
  writeFileSync(join(bundle, 'private', 'fixture.bin'), privateFile, { mode: 0o600 });
  writeFileSync(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      schemaVersion,
      capturedAt: '2026-09-30T00:00:00.000Z',
      consistency:
        schemaVersion === 2
          ? 'caller-supplied-exported-snapshot-local-integrity-only'
          : 'operator-enforced-quiesced-write-fence',
      independentPostBackupErasureLedgerRequired: true,
      ...(schemaVersion === 2 ? { snapshot } : {}),
      database: digest(database),
      privateFiles: [{ path: 'fixture.bin', ...digest(privateFile) }],
    }),
    { mode: 0o600 },
  );
  return { root, bundle };
}

class FakeS3 {
  objects = new Map();
  next = 0;
  enabled = true;
  region = config.region;
  corrupt = false;
  failAt = -1;

  async versioning() {
    return this.enabled ? 'Enabled' : 'Suspended';
  }

  async location() {
    return this.region;
  }

  async put(key, path) {
    if (this.next === this.failAt) throw new Error('upload interrupted');
    const versionId = String(++this.next);
    const versions = this.objects.get(key) ?? [];
    versions.push({ versionId, data: readFileSync(path), encryption: 'AES256' });
    this.objects.set(key, versions);
    return versionId;
  }

  async putIfAbsent(key, path) {
    if (this.objects.has(key)) throw new Error('precondition failed');
    return this.put(key, path);
  }

  find(key, versionId) {
    const versions = this.objects.get(key) ?? [];
    const item = versionId ? versions.find((v) => v.versionId === versionId) : versions.at(-1);
    if (!item) throw new Error('missing');
    return item;
  }

  async head(key, versionId) {
    const item = this.find(key, versionId);
    return { versionId: item.versionId, encryption: item.encryption };
  }

  async get(key, versionId, target) {
    const item = this.find(key, versionId);
    writeFileSync(target, this.corrupt ? Buffer.from('corrupted') : item.data, { mode: 0o600 });
    chmodSync(target, 0o600);
    return { versionId: item.versionId };
  }

  async getLatestOrNull(key, target) {
    if (!this.objects.has(key)) return null;
    const item = this.find(key);
    writeFileSync(target, item.data, { mode: 0o600 });
    return { versionId: item.versionId, encryption: item.encryption };
  }
}

test('publishes completion last, verifies exact bytes, downloads, and retries idempotently', async () => {
  const { root, bundle } = fixture();
  const client = new FakeS3();
  try {
    const first = await uploadBundle({ bundle, config, client, synthetic: true });
    assert.equal(first.alreadyComplete, false);
    const completionKey = `${config.prefix}/backup-fixture/completion.json`;
    assert.equal([...client.objects.keys()].at(-1), completionKey);
    assert.equal(JSON.parse(client.find(completionKey).data).ledgerCompleteness, 'not_verified');
    const second = await uploadBundle({ bundle, config, client, synthetic: true });
    assert.equal(second.alreadyComplete, true);
    assert.equal(client.next, 4);
    const destination = join(root, 'downloaded');
    await downloadBundle({
      bundleId: 'backup-fixture',
      destination,
      config,
      client,
      synthetic: true,
    });
    assert.deepEqual(
      readFileSync(join(destination, 'database.dump')),
      readFileSync(join(bundle, 'database.dump')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 stores exact snapshot and versioned files with explicit no-restore marker', async () => {
  const { root, bundle } = fixture(2);
  const client = new FakeS3();
  try {
    const uploaded = await uploadBundle({ bundle, config, client, synthetic: true });
    const key = `${config.prefix}/backup-fixture/completion.json`;
    const remote = JSON.parse(client.find(key).data);
    assert.deepEqual(uploaded.completion, remote);
    assert.equal(remote.schemaVersion, 2);
    assert.deepEqual(remote.snapshot, snapshot);
    assert.equal(remote.ledgerCompleteness, 'not_verified');
    assert.equal(remote.restoreAccessAllowed, false);
    assert.deepEqual(
      remote.files.map(({ path }) => path),
      ['manifest.json', 'database.dump', 'private/fixture.bin'],
    );
    for (const file of remote.files) {
      assert.equal(
        file.versionId,
        client.find(`${config.prefix}/backup-fixture/files/${file.path}`).versionId,
      );
      assert.deepEqual(
        { sha256: file.sha256, bytes: file.bytes },
        digest(readFileSync(join(bundle, ...file.path.split('/')))),
      );
    }
    const retried = await uploadBundle({ bundle, config, client, synthetic: true });
    assert.equal(retried.alreadyComplete, true);
    assert.deepEqual(retried.completion, remote);
    const downloaded = await downloadBundle({
      bundleId: 'backup-fixture',
      destination: join(root, 'downloaded'),
      config,
      client,
      synthetic: true,
    });
    assert.deepEqual(downloaded.completion, remote);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 rejects interrupted upload, changed local bytes, and forged snapshot or completion', async () => {
  const { root, bundle } = fixture(2);
  const client = new FakeS3();
  const key = `${config.prefix}/backup-fixture/completion.json`;
  try {
    client.failAt = 1;
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
    assert.equal(client.objects.has(key), false);
    client.failAt = -1;
    await uploadBundle({ bundle, config, client, synthetic: true });
    const remote = JSON.parse(client.find(key).data);
    remote.snapshot.publication = 'wrong_publication';
    client.find(key).data = Buffer.from(JSON.stringify(remote));
    await assert.rejects(
      downloadBundle({
        bundleId: 'backup-fixture',
        destination: join(root, 'bad'),
        config,
        client,
        synthetic: true,
      }),
    );
    remote.snapshot = snapshot;
    remote.restoreAccessAllowed = true;
    client.find(key).data = Buffer.from(JSON.stringify(remote));
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
    remote.restoreAccessAllowed = false;
    client.find(key).data = Buffer.from(JSON.stringify(remote));
    writeFileSync(join(bundle, 'database.dump'), 'changed');
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v1 and v2 completion schemas cannot be interchanged', async () => {
  const { root, bundle } = fixture(2);
  const client = new FakeS3();
  try {
    await uploadBundle({ bundle, config, client, synthetic: true });
    const key = `${config.prefix}/backup-fixture/completion.json`;
    const remote = JSON.parse(client.find(key).data);
    remote.schemaVersion = 1;
    client.find(key).data = Buffer.from(JSON.stringify(remote));
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
    await assert.rejects(
      downloadBundle({
        bundleId: 'backup-fixture',
        destination: join(root, 'bad'),
        config,
        client,
        synthetic: true,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 rejects unsupported consistency and malformed publication before upload', async () => {
  const { root, bundle } = fixture(2);
  const client = new FakeS3();
  const path = join(bundle, 'manifest.json');
  try {
    const original = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...original, consistency: 'operationally-restorable' }));
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        snapshot: { ...snapshot, publication: 'Invalid-Publication' },
      }),
    );
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
    assert.equal(client.objects.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 rejects altered remote bytes, encryption, and version IDs without publishing a download', async () => {
  const { root, bundle } = fixture(2);
  const client = new FakeS3();
  const destination = join(root, 'downloaded');
  const key = `${config.prefix}/backup-fixture/files/database.dump`;
  try {
    await uploadBundle({ bundle, config, client, synthetic: true });
    const object = client.find(key);
    object.data = Buffer.from('tampered');
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    assert.equal(existsSync(destination), false);
    object.data = readFileSync(join(bundle, 'database.dump'));
    object.encryption = 'aws:kms';
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    object.encryption = 'AES256';
    const completionKey = `${config.prefix}/backup-fixture/completion.json`;
    const completion = JSON.parse(client.find(completionKey).data);
    completion.files[1].versionId = 'missing';
    client.find(completionKey).data = Buffer.from(JSON.stringify(completion));
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects partial upload, corruption, suspended versioning, and conflicting completion', async () => {
  const { root, bundle } = fixture();
  const client = new FakeS3();
  try {
    client.failAt = 1;
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
    assert.equal(client.objects.has(`${config.prefix}/backup-fixture/completion.json`), false);
    client.failAt = -1;
    await uploadBundle({ bundle, config, client, synthetic: true });
    client.corrupt = true;
    const destination = join(root, 'bad-download');
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    assert.equal(existsSync(destination), false);
    client.corrupt = false;
    writeFileSync(join(bundle, 'database.dump'), 'changed');
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
    client.enabled = false;
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    await assert.rejects(
      uploadBundle({
        bundle,
        config: { ...config, region: 'NEW_REGION' },
        client,
        synthetic: true,
      }),
    );
    client.enabled = true;
    client.region = 'ap-northeast-1';
    await assert.rejects(uploadBundle({ bundle, config, client, synthetic: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a forged completion path, missing version, and wrong encryption', async () => {
  const { root, bundle } = fixture();
  const client = new FakeS3();
  try {
    await uploadBundle({ bundle, config, client, synthetic: true });
    const destination = join(root, 'downloaded');
    const key = `${config.prefix}/backup-fixture/completion.json`;
    const completion = JSON.parse(client.find(key).data);
    completion.files[2].path = '../escape';
    client.find(key).data = Buffer.from(JSON.stringify(completion));
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    assert.equal(existsSync(destination), false);
    completion.files[2].path = 'private/fixture.bin';
    completion.ledgerCompleteness = 'verified';
    client.find(key).data = Buffer.from(JSON.stringify(completion));
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    completion.ledgerCompleteness = 'not_verified';
    client.find(key).data = Buffer.from(JSON.stringify(completion));
    client.find(`${config.prefix}/backup-fixture/files/database.dump`).encryption = 'aws:kms';
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
    client.find(`${config.prefix}/backup-fixture/files/database.dump`).encryption = 'AES256';
    completion.files[1].versionId = 'missing';
    client.find(key).data = Buffer.from(JSON.stringify(completion));
    await assert.rejects(
      downloadBundle({ bundleId: 'backup-fixture', destination, config, client, synthetic: true }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
