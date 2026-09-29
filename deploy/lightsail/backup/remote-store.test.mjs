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
  expectedBucketOwner: '681892421656',
};

function digest(value) {
  return { sha256: createHash('sha256').update(value).digest('hex'), bytes: value.length };
}

function fixture() {
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
      schemaVersion: 1,
      capturedAt: '2026-09-30T00:00:00.000Z',
      consistency: 'operator-enforced-quiesced-write-fence',
      independentPostBackupErasureLedgerRequired: true,
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
  corrupt = false;
  failAt = -1;

  async versioning() {
    return this.enabled ? 'Enabled' : 'Suspended';
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
