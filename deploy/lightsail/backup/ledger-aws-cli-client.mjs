import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGION = 'ap-northeast-2';
const MAX_HEAD_BYTES = 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_CLI_BYTES = 1024 * 1024;
const MAX_PAGES = 128;
const VERSION_ID = /^[A-Za-z0-9+/_=.~-]{1,1024}$/;
const CLI_NEXT_TOKEN = /^[A-Za-z0-9+/_=.:-]{1,4096}$/;
const ETAG = /^"[a-fA-F0-9-]{1,128}"$/;

function fail() {
  throw new Error('LEDGER_AWS_CLI_FAILED');
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}

function validateConfig(config) {
  exactObject(config, ['schemaVersion', 'bucket', 'prefix', 'region', 'expectedBucketOwner']);
  if (
    config.schemaVersion !== 1 ||
    typeof config.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    typeof config.prefix !== 'string' ||
    !/^(?:[a-z0-9-]+\/)*deletion-ledger\/v1$/.test(config.prefix) ||
    config.region !== REGION ||
    typeof config.expectedBucketOwner !== 'string' ||
    !/^\d{12}$/.test(config.expectedBucketOwner)
  )
    fail();
}

function validateKey(key, config) {
  if (
    key !== `${config.prefix}/head.bin` &&
    !(
      typeof key === 'string' &&
      new RegExp(`^${config.prefix}/segments/[a-f0-9]{64}\\.bin$`).test(key)
    )
  )
    fail();
  return key.endsWith('/head.bin') ? MAX_HEAD_BYTES : MAX_SEGMENT_BYTES;
}

function validateVersion(versionId) {
  if (typeof versionId !== 'string' || versionId === 'null' || !VERSION_ID.test(versionId)) fail();
  return versionId;
}

function validateEtag(etag) {
  if (typeof etag !== 'string' || !ETAG.test(etag)) fail();
  return etag;
}

function validateBytes(bytes, limit) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > limit) fail();
  return Buffer.from(bytes);
}

function parseObject(stdout) {
  if (typeof stdout !== 'string' || !stdout || Buffer.byteLength(stdout) > MAX_CLI_BYTES) fail();
  try {
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value;
  } catch {
    fail();
  }
}

function assertMetadata(value, versionId, maxBytes) {
  if (
    value.VersionId !== versionId ||
    value.ServerSideEncryption !== 'AES256' ||
    value.DeleteMarker === true ||
    !Number.isSafeInteger(value.ContentLength) ||
    value.ContentLength < 1 ||
    value.ContentLength > maxBytes
  )
    fail();
  validateEtag(value.ETag);
}

/**
 * AWS CLI boundary for opaque suppression-ledger bytes. This is not a backup,
 * restore, durability, or last-tail completion proof.
 *
 * S3 If-Match compares an ETag, not a VersionId: an identical-byte ABA update
 * can pass despite an intervening head version. A delete-marker race between
 * list/head and a conditional write can also pass If-None-Match. Callers must
 * fence writers and verify exact versions; these checks cannot eliminate either
 * race by themselves.
 */
export function createLedgerAwsCliClient({ config, runner = spawnSync, synthetic = false }) {
  validateConfig(config);
  if (typeof runner !== 'function' || typeof synthetic !== 'boolean') fail();
  if (!synthetic && process.getuid?.() !== 0) fail();

  function call(command, args, { missing = false } = {}) {
    let result;
    try {
      result = runner(
        'aws',
        [
          's3api',
          command,
          ...args,
          '--bucket',
          config.bucket,
          '--region',
          REGION,
          '--expected-bucket-owner',
          config.expectedBucketOwner,
          '--output',
          'json',
          '--no-cli-pager',
          ...(command === 'list-object-versions' ? [] : ['--no-paginate']),
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: MAX_CLI_BYTES,
          env: { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
        },
      );
    } catch {
      fail();
    }
    if (!result || result.error || result.signal || !Number.isInteger(result.status)) fail();
    if (result.status !== 0) {
      // Only an exact AWS NoSuchKey code is an absent latest object. All other
      // CLI errors, including owner mismatch, timeout, and 404 ambiguity, fail.
      if (
        missing &&
        typeof result.stderr === 'string' &&
        /^An error occurred \(NoSuchKey\) when calling the GetObject operation:/.test(
          result.stderr,
        ) &&
        result.stdout === ''
      )
        return null;
      fail();
    }
    if (result.stderr && result.stderr.trim()) fail();
    return parseObject(result.stdout);
  }

  function withTemp(work) {
    const directory = mkdtempSync(join(tmpdir(), 'wm-ledger-s3-'));
    chmodSync(directory, 0o700);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (!synthetic && stat.uid !== 0))
        fail();
      return work(join(directory, 'body'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function downloaded(path, expectedLength, limit) {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== expectedLength ||
      stat.size < 1 ||
      stat.size > limit ||
      (!synthetic && stat.uid !== 0)
    )
      fail();
    chmodSync(path, 0o600);
    const bytes = readFileSync(path);
    if (bytes.length !== expectedLength) fail();
    return bytes;
  }

  function metadata(versionId) {
    return {
      versionId,
      deleted: false,
      encryption: 'AES256',
      owner: config.expectedBucketOwner,
      region: REGION,
    };
  }

  function get(key, versionId) {
    const limit = validateKey(key, config);
    if (versionId !== undefined) validateVersion(versionId);
    return withTemp((path) => {
      const value = call(
        'get-object',
        ['--key', key, ...(versionId === undefined ? [] : ['--version-id', versionId]), path],
        { missing: versionId === undefined },
      );
      if (value === null) return null;
      const actualVersion = validateVersion(value.VersionId);
      if (versionId !== undefined && actualVersion !== versionId) fail();
      assertMetadata(value, actualVersion, limit);
      return {
        ...metadata(actualVersion),
        bytes: downloaded(path, value.ContentLength, limit),
        etag: value.ETag,
      };
    });
  }

  function put(key, bytes, condition) {
    const data = validateBytes(bytes, validateKey(key, config));
    return withTemp((path) => {
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
      const value = call('put-object', [
        '--key',
        key,
        '--body',
        path,
        '--server-side-encryption',
        'AES256',
        ...condition,
      ]);
      const versionId = validateVersion(value.VersionId);
      if (value.ServerSideEncryption !== 'AES256') fail();
      validateEtag(value.ETag);
      return metadata(versionId);
    });
  }

  return {
    config,
    async versioning() {
      const value = call('get-bucket-versioning', []);
      return value.Status === 'Enabled' && value.MFADelete !== 'Enabled' ? 'Enabled' : fail();
    },
    async location() {
      const value = call('get-bucket-location', []);
      return value.LocationConstraint === REGION ? REGION : fail();
    },
    async head(key, versionId) {
      const limit = validateKey(key, config);
      validateVersion(versionId);
      const value = call('head-object', ['--key', key, '--version-id', versionId]);
      assertMetadata(value, versionId, limit);
      return metadata(versionId);
    },
    async get(key, versionId) {
      return get(key, versionId);
    },
    async getLatestOrNull(key) {
      return get(key);
    },
    async versions(key) {
      validateKey(key, config);
      const versions = [];
      const seen = new Set();
      const tokens = new Set();
      let cursor = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const value = call('list-object-versions', [
          '--prefix',
          key,
          '--page-size',
          '100',
          '--max-items',
          '100',
          ...cursor,
        ]);
        if (
          (value.Versions !== undefined && !Array.isArray(value.Versions)) ||
          (value.DeleteMarkers !== undefined && !Array.isArray(value.DeleteMarkers))
        )
          fail();
        for (const entry of [...(value.Versions ?? []), ...(value.DeleteMarkers ?? [])]) {
          if (!entry || typeof entry !== 'object' || typeof entry.Key !== 'string') fail();
          if (entry.Key !== key) continue;
          const id = validateVersion(entry.VersionId);
          if (seen.has(id)) fail();
          seen.add(id);
          versions.push(id); // Delete markers count as versions and defeat immutability checks.
          if (versions.length > 10000) fail();
        }
        // AWS CLI pagination uses its opaque NextToken/--starting-token pair.
        // Service NextKeyMarker/NextVersionIdMarker are not CLI input options.
        if (typeof value.IsTruncated !== 'boolean') fail();
        if (value.NextToken === undefined) {
          if (value.IsTruncated) fail();
          return versions;
        }
        const token = value.NextToken;
        if (typeof token !== 'string' || !CLI_NEXT_TOKEN.test(token) || tokens.has(token)) fail();
        tokens.add(token);
        cursor = ['--starting-token', token];
      }
      fail();
    },
    async putIfAbsent(key, bytes) {
      return put(key, bytes, ['--if-none-match', '*']);
    },
    async putIfMatch(key, etag, bytes) {
      return put(key, bytes, ['--if-match', validateEtag(etag)]);
    },
  };
}
