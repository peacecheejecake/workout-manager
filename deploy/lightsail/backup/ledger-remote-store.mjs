import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const TEMP_ROOT = realpathSync(tmpdir());

function reject() {
  throw new Error('LEDGER_REMOTE_FAILED');
}

function validateConfig(config, client) {
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
      ['bucket', 'expectedBucketOwner', 'prefix', 'region', 'schemaVersion'].sort().join(',') ||
    !client ||
    Object.keys(config).some((key) => client.config?.[key] !== config[key]) ||
    Object.keys(client.config ?? {}).length !== Object.keys(config).length
  )
    reject();
}

function secureFile(path, synthetic) {
  if (!isAbsolute(path) || resolve(path) !== path) reject();
  if (synthetic && !path.startsWith(`${TEMP_ROOT}${sep}`)) reject();
  let current = path;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) reject();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (!synthetic && stat.uid !== 0) ||
    stat.size < 1 ||
    stat.size > MAX_SEGMENT_BYTES
  )
    reject();
  return stat.size;
}

function digest(path, synthetic) {
  const expectedBytes = secureFile(path, synthetic);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  let bytes = 0;
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > MAX_SEGMENT_BYTES) reject();
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  if (bytes !== expectedBytes) reject();
  return { sha256: hash.digest('hex'), bytes };
}

function assertDigest(path, expected, synthetic = true) {
  const actual = digest(path, synthetic);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) reject();
}

function assertVersion(versionId) {
  if (typeof versionId !== 'string' || !versionId || versionId === 'null') reject();
}

async function verifyVersion(client, key, versionId, expected, directory) {
  assertVersion(versionId);
  const head = await client.head(key, versionId);
  if (head?.versionId !== versionId || head.encryption !== 'AES256') reject();
  const target = join(directory, 'versioned');
  const result = await client.get(key, versionId, target);
  if (result?.versionId !== versionId) reject();
  assertDigest(target, expected);
}

async function verifiedLatest(client, key, expected, directory) {
  const target = join(directory, 'latest');
  const latest = await client.getLatestOrNull(key, target);
  if (!latest) return null;
  assertVersion(latest.versionId);
  if (latest.encryption !== 'AES256') reject();
  assertDigest(target, expected);
  await verifyVersion(client, key, latest.versionId, expected, directory);
  return latest.versionId;
}

/** Verifies storage of one opaque segment; it makes no ledger coverage or WAL acknowledgement claim. */
async function storeSegment({ segmentPath, segmentId, config, client, synthetic = false }) {
  validateConfig(config, client);
  if (!synthetic && process.getuid?.() !== 0) reject();
  if (typeof segmentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(segmentId)) reject();
  const expected = digest(segmentPath, synthetic);
  const key = `${config.prefix}/segments/${segmentId}.bin`;
  if ((await client.versioning()) !== 'Enabled' || (await client.location()) !== config.region)
    reject();

  const directory = mkdtempSync(join(TEMP_ROOT, 'wm-ledger-verify-'));
  chmodSync(directory, 0o700);
  try {
    const existing = await verifiedLatest(client, key, expected, directory);
    if (existing) return { segmentId, versionId: existing, alreadyStored: true };

    let versionId;
    try {
      versionId = await client.putIfAbsent(key, segmentPath);
    } catch {
      // A timeout after a successful conditional put and a competing writer look identical here.
      // Only exact, versioned remote bytes can make either retry safe.
      const concurrent = await verifiedLatest(client, key, expected, directory);
      if (!concurrent) reject();
      assertDigest(segmentPath, expected, synthetic);
      return { segmentId, versionId: concurrent, alreadyStored: true };
    }
    assertVersion(versionId);
    assertDigest(segmentPath, expected, synthetic);
    await verifyVersion(client, key, versionId, expected, directory);
    const latest = await verifiedLatest(client, key, expected, directory);
    if (latest !== versionId) reject();
    return { segmentId, versionId, alreadyStored: false };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function uploadLedgerSegment(options) {
  try {
    return await storeSegment(options);
  } catch {
    reject();
  }
}

// This adapter accepts only opaque ciphertext and authenticated-head bytes. The
// caller owns their meaning, keys, and completeness checks. The injected client
// must issue owner-bound, conditional, versioned requests to one private bucket.
const MAX_HEAD_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function boundedBytes(value, limit) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > limit) reject();
  return Buffer.from(value);
}

function exactMetadata(object, config, versionId) {
  if (
    !object ||
    object.versionId !== versionId ||
    object.deleted !== false ||
    object.encryption !== 'AES256' ||
    object.owner !== config.expectedBucketOwner ||
    object.region !== config.region
  )
    reject();
}

function exactEtag(value) {
  if (typeof value !== 'string' || !/^"[a-fA-F0-9-]{1,128}"$/.test(value)) reject();
  return value;
}

function exactVersionedBytes(object, config, versionId, limit) {
  exactMetadata(object, config, versionId);
  return boundedBytes(object.bytes, limit);
}

/** A local, injected-client boundary. It does not configure AWS or seed the first signed head. */
export function createSuppressionRemoteStore({ config, client }) {
  validateConfig(config, client);
  const headKey = `${config.prefix}/head.bin`;
  const segmentKey = (id) => {
    if (typeof id !== 'string' || !SHA256.test(id)) reject();
    return `${config.prefix}/segments/${id}.bin`;
  };
  const ready = async () => {
    if ((await client.versioning()) !== 'Enabled' || (await client.location()) !== config.region)
      reject();
  };
  const versioned = async (key, versionId, limit) => {
    assertVersion(versionId);
    const metadata = await client.head(key, versionId);
    exactMetadata(metadata, config, versionId);
    const object = await client.get(key, versionId);
    return exactVersionedBytes(object, config, versionId, limit);
  };
  const latest = async (key, limit) => {
    const object = await client.getLatestOrNull(key);
    if (!object) reject(); // A missing/deleted head or segment is never evidence of completeness.
    assertVersion(object.versionId);
    exactEtag(object.etag);
    const bytes = exactVersionedBytes(object, config, object.versionId, limit);
    const exact = await versioned(key, object.versionId, limit);
    if (!bytes.equals(exact)) reject();
    return { bytes, versionId: object.versionId, etag: object.etag };
  };
  const putAndVerify = async (key, bytes, put) => {
    const written = await put();
    assertVersion(written?.versionId);
    exactMetadata(written, config, written.versionId);
    const readBack = await versioned(key, written.versionId, bytes.length);
    if (!readBack.equals(bytes)) reject();
    const current = await latest(key, bytes.length);
    if (current.versionId !== written.versionId || !current.bytes.equals(bytes)) reject();
    return written.versionId;
  };
  return {
    async readHead() {
      await ready();
      const current = await latest(headKey, MAX_HEAD_BYTES);
      return { bytes: current.bytes, versionId: current.versionId };
    },
    async readSegment(segmentId, versionId) {
      await ready();
      const key = segmentKey(segmentId);
      const bytes = await versioned(key, versionId, MAX_SEGMENT_BYTES);
      if (createHash('sha256').update(bytes).digest('hex') !== segmentId) reject();
      const current = await latest(key, MAX_SEGMENT_BYTES);
      const versions = await client.versions(key);
      if (
        current.versionId !== versionId ||
        !current.bytes.equals(bytes) ||
        !Array.isArray(versions) ||
        versions.length !== 1 ||
        versions[0] !== versionId
      )
        reject();
      return { bytes, versionId };
    },
    async putImmutableSegment(value) {
      await ready();
      const bytes = boundedBytes(value, MAX_SEGMENT_BYTES);
      const segmentId = createHash('sha256').update(bytes).digest('hex');
      const key = segmentKey(segmentId);
      // If-None-Match alone accepts a key whose current version is a delete marker.
      const before = await client.versions(key);
      if (!Array.isArray(before) || before.length !== 0) reject();
      const versionId = await putAndVerify(key, bytes, () =>
        client.putIfAbsent(key, Buffer.from(bytes)),
      );
      const after = await client.versions(key);
      if (!Array.isArray(after) || after.length !== 1 || after[0] !== versionId) reject();
      return { segmentId, versionId };
    },
    async compareAndSetHead(expectedVersionId, value) {
      await ready();
      assertVersion(expectedVersionId);
      const bytes = boundedBytes(value, MAX_HEAD_BYTES);
      const current = await latest(headKey, MAX_HEAD_BYTES);
      if (current.versionId !== expectedVersionId) reject();
      const versionId = await putAndVerify(headKey, bytes, () =>
        client.putIfMatch(headKey, current.etag, Buffer.from(bytes)),
      );
      return { versionId };
    },
  };
}
