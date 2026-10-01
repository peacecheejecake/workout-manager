import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildBaselineAnchorCandidate } from './baseline-anchor.mjs';

const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(?!null$)[A-Za-z0-9._~+=/-]{1,256}$/;
const PRIVATE_PATH = /^private\/[A-Za-z0-9._/-]+$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const CONSISTENCIES = new Set([
  'caller-supplied-exported-snapshot-local-integrity-only',
  'replication-slot-exported-snapshot-disposable-local-proof-only',
]);

function fail() {
  throw new Error('BASELINE_ANCHOR_REMOTE_UNVERIFIED');
}

function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    fail();
  return value;
}

function sameSnapshot(left, right) {
  const fields = [
    'snapshotName',
    'consistentPointLsn',
    'postgresSystemIdentifier',
    'replicationSlot',
    'publication',
  ];
  exact(left, fields);
  exact(right, fields);
  if (fields.some((field) => left[field] !== right[field])) fail();
}

function digest(value) {
  if (
    !HASH.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > 4 * 1024 ** 3
  )
    fail();
}

function path(value) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !PRIVATE_PATH.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail();
}

function version(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) fail();
}

/**
 * Map independently supplied local assertions and a v2 remote-store result to
 * an authenticated offline anchor candidate. This does not establish S3
 * durability, an independently witnessed tail, or restore readiness.
 */
export function buildBaselineAnchorFromRemote(options) {
  exact(options, [
    'result',
    'config',
    'manifest',
    'manifestBytes',
    'expectedSnapshot',
    'coverage',
    'expectedOwners',
    'expectedDomainSchemaFingerprint',
    'expectedPublication',
    'coverageHmacKey',
    'anchorHmacKey',
  ]);
  const {
    result,
    config,
    manifest,
    manifestBytes,
    expectedSnapshot,
    coverage,
    expectedOwners,
    expectedDomainSchemaFingerprint,
    expectedPublication,
    coverageHmacKey,
    anchorHmacKey,
  } = options;
  exact(config, ['schemaVersion', 'bucket', 'prefix', 'region', 'expectedBucketOwner']);
  if (config.schemaVersion !== 1) fail();
  if (
    !Buffer.isBuffer(manifestBytes) ||
    manifestBytes.length === 0 ||
    manifestBytes.length > MAX_MANIFEST_BYTES
  )
    fail();
  let parsedManifest;
  try {
    parsedManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    fail();
  }
  if (!isDeepStrictEqual(parsedManifest, manifest)) fail();
  const manifestFile = {
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    bytes: manifestBytes.length,
  };
  exact(manifest, [
    'schemaVersion',
    'capturedAt',
    'consistency',
    'independentPostBackupErasureLedgerRequired',
    'snapshot',
    'database',
    'privateFiles',
  ]);
  if (
    manifest.schemaVersion !== 2 ||
    !CONSISTENCIES.has(manifest.consistency) ||
    manifest.independentPostBackupErasureLedgerRequired !== true ||
    typeof manifest.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.capturedAt))
  )
    fail();
  sameSnapshot(manifest.snapshot, expectedSnapshot);
  exact(manifest.database, ['sha256', 'bytes']);
  digest(manifest.database);
  if (!Array.isArray(manifest.privateFiles) || manifest.privateFiles.length > 10_000) fail();
  const expectedFiles = [
    { path: 'manifest.json', ...manifestFile },
    { path: 'database.dump', ...manifest.database },
  ];
  const seen = new Set();
  for (const file of manifest.privateFiles) {
    exact(file, ['path', 'sha256', 'bytes']);
    const fullPath = `private/${file.path}`;
    path(fullPath);
    if (seen.has(fullPath)) fail();
    seen.add(fullPath);
    digest(file);
    expectedFiles.push({ path: fullPath, sha256: file.sha256, bytes: file.bytes });
  }

  const resultKeys = Object.hasOwn(result ?? {}, 'alreadyComplete')
    ? ['bundleId', 'versionId', 'alreadyComplete', 'completion']
    : ['bundleId', 'versionId', 'completion'];
  exact(result, resultKeys);
  if ('alreadyComplete' in result && typeof result.alreadyComplete !== 'boolean') fail();
  if (typeof result.bundleId !== 'string' || !/^backup-[A-Za-z0-9-]{1,120}$/.test(result.bundleId))
    fail();
  version(result.versionId);
  const completion = exact(result.completion, [
    'schemaVersion',
    'bucket',
    'prefix',
    'region',
    'bundleId',
    'snapshot',
    'restoreAccessAllowed',
    'ledgerCompleteness',
    'files',
  ]);
  if (
    completion.schemaVersion !== 2 ||
    completion.restoreAccessAllowed !== false ||
    completion.ledgerCompleteness !== 'not_verified' ||
    completion.bucket !== config.bucket ||
    completion.prefix !== config.prefix ||
    completion.region !== config.region ||
    completion.bundleId !== result.bundleId ||
    !Array.isArray(completion.files) ||
    completion.files.length !== expectedFiles.length
  )
    fail();
  sameSnapshot(completion.snapshot, expectedSnapshot);
  const archives = { manifest: undefined, database: undefined, privateFiles: [] };
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const file = exact(completion.files[index], ['path', 'sha256', 'bytes', 'versionId']);
    const expected = expectedFiles[index];
    if (
      file.path !== expected.path ||
      file.sha256 !== expected.sha256 ||
      file.bytes !== expected.bytes
    )
      fail();
    version(file.versionId);
    const archive = { path: file.path, sha256: file.sha256, versionId: file.versionId };
    if (index === 0) archives.manifest = archive;
    else if (index === 1) archives.database = archive;
    else archives.privateFiles.push(archive);
  }
  return buildBaselineAnchorCandidate({
    backupId: result.bundleId,
    snapshot: expectedSnapshot,
    archives,
    remote: {
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
      expectedBucketOwner: config.expectedBucketOwner,
      completionVersionId: result.versionId,
    },
    coverage,
    expectedOwners,
    expectedDomainSchemaFingerprint,
    expectedPublication,
    coverageHmacKey,
    anchorHmacKey,
  });
}

/** Use only the manifest bytes returned by the exact-version v2 download. */
export function buildBaselineAnchorFromDownloaded(options) {
  exact(options, [
    'result',
    'config',
    'expectedSnapshot',
    'coverage',
    'expectedOwners',
    'expectedDomainSchemaFingerprint',
    'expectedPublication',
    'coverageHmacKey',
    'anchorHmacKey',
  ]);
  const downloaded = exact(options.result, [
    'bundleId',
    'versionId',
    'completion',
    'manifestBytesBase64',
    'verifiedManifestVersionId',
  ]);
  if (downloaded.verifiedManifestVersionId !== downloaded.completion?.files?.[0]?.versionId) fail();
  const encoded = downloaded.manifestBytesBase64;
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > Math.ceil(MAX_MANIFEST_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    fail();
  const manifestBytes = Buffer.from(encoded, 'base64');
  if (manifestBytes.length === 0 || manifestBytes.length > MAX_MANIFEST_BYTES) fail();
  if (manifestBytes.toString('base64') !== encoded) fail();
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    fail();
  }
  const result = {
    bundleId: downloaded.bundleId,
    versionId: downloaded.versionId,
    completion: downloaded.completion,
  };
  return buildBaselineAnchorFromRemote({ ...options, result, manifest, manifestBytes });
}
