import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildBaselineAnchorFromRemote } from './baseline-anchor-remote.mjs';
import { verifyBaselineAnchorCandidate } from './baseline-anchor.mjs';
import { downloadBundle, uploadBundle } from './remote-store.mjs';

const config = {
  schemaVersion: 1,
  bucket: 'workout-private-backups',
  prefix: 'workout/v2',
  region: 'ap-northeast-2',
  expectedBucketOwner: '681892421656',
};
const snapshot = {
  snapshotName: '00000001-00000002-1',
  consistentPointLsn: '0/16B6C50',
  postgresSystemIdentifier: '123',
  replicationSlot: 'workout_slot',
  publication: 'workout_publication',
};
const gaps = [
  'SNAPSHOT_BINDING_NOT_INDEPENDENTLY_VERIFIED',
  'OWNER_ROSTER_NOT_INDEPENDENTLY_PROVEN',
  'PRE_EVENT_ERASURE_OWNER_NOT_DISCOVERABLE',
  'PRE_EVENT_HISTORY_NOT_RECONSTRUCTIBLE',
  'HEALTHKIT_RAW_ONLY_DELETION_NOT_COVERED',
  'SHARE_EPOCH_OUTSIDE_DATABASE',
  'POST_SNAPSHOT_TAIL_NOT_WITNESSED',
  'DOMAIN_HEADS_NOT_FULLY_CAPTURED',
  'DOMAIN_SCHEMA_FINGERPRINT_NOT_INDEPENDENTLY_VERIFIED',
];
const fingerprint = 'a'.repeat(64);
const digest = (bytes) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-anchor-remote-')));
  const bundle = join(root, 'backup-fixture');
  mkdirSync(bundle, { mode: 0o700 });
  mkdirSync(join(bundle, 'private'), { mode: 0o700 });
  const database = Buffer.from('PGDMPsynthetic');
  const secret = Buffer.from('synthetic-private');
  writeFileSync(join(bundle, 'database.dump'), database, { mode: 0o600 });
  writeFileSync(join(bundle, 'private', 'fixture.bin'), secret, { mode: 0o600 });
  const manifest = {
    schemaVersion: 2,
    capturedAt: '2026-09-30T00:00:00.000Z',
    consistency: 'caller-supplied-exported-snapshot-local-integrity-only',
    independentPostBackupErasureLedgerRequired: true,
    snapshot,
    database: digest(database),
    privateFiles: [{ path: 'fixture.bin', ...digest(secret) }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  writeFileSync(join(bundle, 'manifest.json'), manifestBytes, { mode: 0o600 });
  const expectations = {
    config,
    manifest,
    manifestFile: digest(manifestBytes),
    expectedSnapshot: snapshot,
    coverage: {
      schemaVersion: 2,
      domainSchemaFingerprint: fingerprint,
      snapshot: {
        snapshotName: snapshot.snapshotName,
        snapshotId: '1:2:',
        consistentPointLsn: snapshot.consistentPointLsn,
        postgresSystemIdentifier: snapshot.postgresSystemIdentifier,
        replicationSlot: snapshot.replicationSlot,
      },
      owners: [],
      complete: false,
      gaps,
    },
    expectedOwners: [],
    expectedDomainSchemaFingerprint: fingerprint,
    expectedPublication: snapshot.publication,
    coverageHmacKey: Buffer.alloc(32, 7),
    anchorHmacKey: Buffer.alloc(32, 9),
  };
  return { root, bundle, expectations };
}

class FakeS3 {
  objects = new Map();
  next = 0;

  async versioning() {
    return 'Enabled';
  }

  async location() {
    return config.region;
  }

  async put(key, path) {
    const versionId = `opaque-${++this.next}`;
    this.objects.set(key, { versionId, data: readFileSync(path), encryption: 'AES256' });
    return versionId;
  }

  async putIfAbsent(key, path) {
    if (this.objects.has(key)) throw new Error('present');
    return this.put(key, path);
  }

  async head(key) {
    const { versionId, encryption } = this.objects.get(key);
    return { versionId, encryption };
  }

  async get(key, versionId, target) {
    const object = this.objects.get(key);
    if (object.versionId !== versionId) throw new Error('wrong version');
    writeFileSync(target, object.data, { mode: 0o600 });
    return { versionId };
  }

  async getLatestOrNull(key, target) {
    const object = this.objects.get(key);
    if (!object) return null;
    writeFileSync(target, object.data, { mode: 0o600 });
    return { versionId: object.versionId, encryption: object.encryption };
  }
}

test('v2 upload and download results build the same incomplete, authenticated candidate', async () => {
  const { root, bundle, expectations } = fixture();
  const client = new FakeS3();
  try {
    const uploaded = await uploadBundle({ bundle, config, client, synthetic: true });
    const candidate = buildBaselineAnchorFromRemote({ ...expectations, result: uploaded });
    assert.equal(candidate.complete, false);
    assert.equal(candidate.restoreAccessAllowed, false);
    assert.equal(candidate.remote.completionVersionId, uploaded.versionId);
    assert.ok(candidate.gaps.includes('REMOTE_DURABILITY_NOT_INDEPENDENTLY_PROVEN'));
    assert.equal(
      verifyBaselineAnchorCandidate(candidate, {
        backupId: uploaded.bundleId,
        snapshot,
        archives: candidate.archives,
        remote: candidate.remote,
        coverage: expectations.coverage,
        expectedOwners: expectations.expectedOwners,
        expectedDomainSchemaFingerprint: fingerprint,
        expectedPublication: snapshot.publication,
        coverageHmacKey: expectations.coverageHmacKey,
        anchorHmacKey: expectations.anchorHmacKey,
      }),
      true,
    );
    const downloaded = await downloadBundle({
      bundleId: uploaded.bundleId,
      destination: join(root, 'downloaded'),
      config,
      client,
      synthetic: true,
    });
    assert.deepEqual(
      buildBaselineAnchorFromRemote({ ...expectations, result: downloaded }),
      candidate,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge rejects mismatched or incomplete completion claims', async () => {
  const { root, bundle, expectations } = fixture();
  const client = new FakeS3();
  try {
    const result = await uploadBundle({ bundle, config, client, synthetic: true });
    const changed = (mutate) => {
      const copy = {
        ...structuredClone({ ...expectations, result }),
        coverageHmacKey: expectations.coverageHmacKey,
        anchorHmacKey: expectations.anchorHmacKey,
      };
      mutate(copy);
      assert.throws(
        () => buildBaselineAnchorFromRemote(copy),
        /BASELINE_ANCHOR_REMOTE_UNVERIFIED|BASELINE_ANCHOR_CANDIDATE_UNVERIFIED/,
      );
    };
    changed((value) => {
      value.result.completion.schemaVersion = 1;
    });
    changed((value) => {
      value.manifest.schemaVersion = 1;
    });
    changed((value) => {
      value.result.completion.snapshot.publication = 'other_publication';
    });
    changed((value) => {
      value.manifest.snapshot.replicationSlot = 'other_slot';
    });
    changed((value) => {
      value.result.completion.bucket = 'another-bucket';
    });
    changed((value) => {
      value.config.prefix = 'different/prefix';
    });
    changed((value) => {
      value.result.bundleId = 'backup-other';
    });
    changed((value) => {
      value.result.versionId = '';
    });
    changed((value) => {
      value.result.completion.files[1].versionId = 'null';
    });
    changed((value) => {
      value.result.completion.files[1].bytes += 1;
    });
    changed((value) => {
      value.result.completion.files[1].sha256 = 'b'.repeat(64);
    });
    changed((value) => {
      value.result.completion.files.push({
        ...value.result.completion.files[2],
        path: 'private/extra.bin',
      });
    });
    changed((value) => {
      value.result.completion.files.splice(0, 1);
    });
    changed((value) => {
      value.result.completion.files.reverse();
    });
    changed((value) => {
      value.result.completion.files[2] = { ...value.result.completion.files[1] };
    });
    changed((value) => {
      value.manifestFile.sha256 = 'c'.repeat(64);
    });
    changed((value) => {
      value.manifest.privateFiles = [];
    });
    changed((value) => {
      value.result.completion.restoreAccessAllowed = true;
    });
    changed((value) => {
      value.result.completion.ledgerCompleteness = 'verified';
    });
    changed((value) => {
      value.expectedPublication = 'different_publication';
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
