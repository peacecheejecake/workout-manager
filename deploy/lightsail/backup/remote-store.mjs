#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSnapshotContract } from './docker-archive-transport.mjs';

const MAX_FILE_BYTES = 4 * 1024 ** 3;
const MAX_RESULT_BYTES = 16 * 1024;
const TEMP_ROOT = realpathSync(tmpdir());

function reject() {
  throw new Error('BACKUP_REMOTE_FAILED');
}

function safePath(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) reject();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function secureDir(path, synthetic) {
  safePath(path);
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || (!synthetic && info.uid !== 0))
    reject();
}

function secureFile(path, synthetic) {
  safePath(path);
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    (!synthetic && info.uid !== 0) ||
    info.size > MAX_FILE_BYTES
  )
    reject();
}

function digest(path) {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function exactDigest(value, actual) {
  if (
    !value ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.sha256 !== actual.sha256 ||
    value.bytes !== actual.bytes
  )
    reject();
}

function validRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 1024 &&
    !isAbsolute(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'))
  );
}

function configCheck(config) {
  if (
    config?.schemaVersion !== 1 ||
    typeof config.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    typeof config.prefix !== 'string' ||
    !validRelative(config.prefix) ||
    config.prefix.endsWith('/') ||
    config.region !== 'ap-northeast-2' ||
    typeof config.expectedBucketOwner !== 'string' ||
    !/^\d{12}$/.test(config.expectedBucketOwner) ||
    Object.keys(config).sort().join(',') !==
      ['bucket', 'expectedBucketOwner', 'prefix', 'region', 'schemaVersion'].sort().join(',')
  )
    reject();
  return config;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function snapshotCheck(snapshot) {
  try {
    if (JSON.stringify(validateSnapshotContract(snapshot)) !== JSON.stringify(snapshot)) reject();
  } catch {
    reject();
  }
}

function manifestCheck(manifest) {
  const v2 = manifest?.schemaVersion === 2;
  if (
    (v2 &&
      (!exactKeys(manifest, [
        'schemaVersion',
        'capturedAt',
        'consistency',
        'independentPostBackupErasureLedgerRequired',
        'snapshot',
        'database',
        'privateFiles',
      ]) ||
        ![
          'caller-supplied-exported-snapshot-local-integrity-only',
          'replication-slot-exported-snapshot-disposable-local-proof-only',
        ].includes(manifest.consistency))) ||
    (!v2 &&
      (manifest?.schemaVersion !== 1 ||
        manifest.consistency !== 'operator-enforced-quiesced-write-fence' ||
        'snapshot' in manifest)) ||
    manifest.independentPostBackupErasureLedgerRequired !== true ||
    typeof manifest.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.capturedAt)) ||
    !Array.isArray(manifest.privateFiles)
  )
    reject();
  if (v2) {
    snapshotCheck(manifest.snapshot);
    if (
      !exactKeys(manifest.database, ['sha256', 'bytes']) ||
      manifest.privateFiles.some((file) => !exactKeys(file, ['path', 'sha256', 'bytes']))
    )
      reject();
  }
  return manifest;
}

function bundleFiles(bundle, synthetic, expectedBundleId = basename(bundle)) {
  secureDir(bundle, synthetic);
  if (!/^backup-[a-zA-Z0-9-]+$/.test(expectedBundleId)) reject();
  const manifestPath = join(bundle, 'manifest.json');
  secureFile(manifestPath, synthetic);
  const manifest = manifestCheck(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const files = [
    { path: 'manifest.json', ...digest(manifestPath) },
    { path: 'database.dump', ...manifest.database },
    ...manifest.privateFiles.map((entry) => ({ ...entry, path: `private/${entry.path}` })),
  ];
  const expected = new Set();
  for (const file of files) {
    if (!validRelative(file.path) || expected.has(file.path)) reject();
    expected.add(file.path);
    const path = join(bundle, ...file.path.split('/'));
    secureFile(path, synthetic);
    exactDigest(file, digest(path));
  }
  const walk = (dir, prefix = '') => {
    secureDir(dir, synthetic);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${name}/`);
      else if (!entry.isFile() || !expected.has(name)) reject();
    }
  };
  walk(bundle);
  return { files, manifest };
}

function remoteKey(config, bundleId, path) {
  return `${config.prefix}/${bundleId}/${path}`;
}

function assertVersion(value) {
  if (typeof value !== 'string' || !value || value === 'null') reject();
}

async function downloadOne(client, key, versionId, expected, target) {
  assertVersion(versionId);
  const head = await client.head(key, versionId);
  if (head.versionId !== versionId || head.encryption !== 'AES256') reject();
  const result = await client.get(key, versionId, target);
  if (result.versionId !== versionId) reject();
  secureFile(target, true);
  exactDigest(expected, digest(target));
}

function completionCheck(completion, config, bundleId, files, manifest) {
  const schemaVersion = manifest?.schemaVersion ?? completion?.schemaVersion;
  if (
    completion?.schemaVersion !== schemaVersion ||
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    completion.bucket !== config.bucket ||
    completion.prefix !== config.prefix ||
    completion.region !== config.region ||
    completion.bundleId !== bundleId ||
    completion.ledgerCompleteness !== 'not_verified' ||
    !Array.isArray(completion.files) ||
    completion.files.length !== files.length
  )
    reject();
  if (schemaVersion === 2) {
    if (
      !exactKeys(completion, [
        'schemaVersion',
        'bucket',
        'prefix',
        'region',
        'bundleId',
        'snapshot',
        'ledgerCompleteness',
        'restoreAccessAllowed',
        'files',
      ]) ||
      completion.restoreAccessAllowed !== false
    )
      reject();
    snapshotCheck(completion.snapshot);
    if (manifest && JSON.stringify(completion.snapshot) !== JSON.stringify(manifest.snapshot))
      reject();
  }
  const paths = new Set();
  files.forEach((file, i) => {
    const recorded = completion.files[i];
    if (
      !recorded ||
      !validRelative(recorded.path) ||
      paths.has(recorded.path) ||
      !/^[a-f0-9]{64}$/.test(recorded.sha256) ||
      !Number.isSafeInteger(recorded.bytes) ||
      recorded.bytes < 0
    )
      reject();
    if (schemaVersion === 2 && !exactKeys(recorded, ['path', 'sha256', 'bytes', 'versionId']))
      reject();
    paths.add(recorded.path);
    if (
      recorded.path !== file.path ||
      recorded.sha256 !== file.sha256 ||
      recorded.bytes !== file.bytes
    )
      reject();
    assertVersion(recorded.versionId);
  });
  if (
    completion.files[0]?.path !== 'manifest.json' ||
    completion.files[1]?.path !== 'database.dump'
  )
    reject();
}

async function existingCompletion(client, key) {
  const temp = mkdtempSync(join(TEMP_ROOT, 'wm-remote-completion-'));
  chmodSync(temp, 0o700);
  try {
    const path = join(temp, 'completion.json');
    const result = await client.getLatestOrNull(key, path);
    if (!result) return null;
    secureFile(path, true);
    assertVersion(result.versionId);
    if (result.encryption !== 'AES256') reject();
    return { versionId: result.versionId, completion: JSON.parse(readFileSync(path, 'utf8')) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function uploadBundle({ bundle, config, client, synthetic = false }) {
  configCheck(config);
  if (!synthetic && process.getuid?.() !== 0) reject();
  if (!isAbsolute(bundle) || resolve(bundle) !== bundle) reject();
  const { files, manifest } = bundleFiles(bundle, synthetic);
  const bundleId = basename(bundle);
  const doneKey = remoteKey(config, bundleId, 'completion.json');
  if ((await client.versioning()) !== 'Enabled') reject();
  if ((await client.location()) !== config.region) reject();
  const existing = await existingCompletion(client, doneKey);
  if (existing) {
    completionCheck(existing.completion, config, bundleId, files, manifest);
    await verifyRemoteFiles(client, config, bundleId, existing.completion.files);
    return {
      bundleId,
      versionId: existing.versionId,
      alreadyComplete: true,
      ...(manifest.schemaVersion === 2 ? { completion: existing.completion } : {}),
    };
  }
  const staged = [];
  for (const file of files) {
    const key = remoteKey(config, bundleId, `files/${file.path}`);
    const versionId = await client.put(key, join(bundle, ...file.path.split('/')));
    assertVersion(versionId);
    const temp = mkdtempSync(join(TEMP_ROOT, 'wm-remote-verify-'));
    try {
      await downloadOne(client, key, versionId, file, join(temp, 'object'));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    staged.push({ ...file, versionId });
  }
  const checked = bundleFiles(bundle, synthetic);
  if (JSON.stringify(checked.files) !== JSON.stringify(files)) reject();
  if (manifest.schemaVersion === 2 && JSON.stringify(checked.manifest) !== JSON.stringify(manifest))
    reject();
  const completion = {
    schemaVersion: manifest.schemaVersion,
    bucket: config.bucket,
    prefix: config.prefix,
    region: config.region,
    bundleId,
    ...(manifest.schemaVersion === 2
      ? { snapshot: manifest.snapshot, restoreAccessAllowed: false }
      : {}),
    ledgerCompleteness: 'not_verified',
    files: staged,
  };
  const temp = mkdtempSync(join(TEMP_ROOT, 'wm-remote-publish-'));
  try {
    const path = join(temp, 'completion.json');
    writeFileSync(path, `${JSON.stringify(completion)}\n`, { mode: 0o600, flag: 'wx' });
    let versionId;
    try {
      versionId = await client.putIfAbsent(doneKey, path);
    } catch {
      const concurrent = await existingCompletion(client, doneKey);
      if (!concurrent) reject();
      completionCheck(concurrent.completion, config, bundleId, files, manifest);
      await verifyRemoteFiles(client, config, bundleId, concurrent.completion.files);
      return {
        bundleId,
        versionId: concurrent.versionId,
        alreadyComplete: true,
        ...(manifest.schemaVersion === 2 ? { completion: concurrent.completion } : {}),
      };
    }
    assertVersion(versionId);
    const published = await existingCompletion(client, doneKey);
    if (!published || published.versionId !== versionId) reject();
    completionCheck(published.completion, config, bundleId, files, manifest);
    return {
      bundleId,
      versionId,
      alreadyComplete: false,
      ...(manifest.schemaVersion === 2 ? { completion: published.completion } : {}),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function verifyRemoteFiles(client, config, bundleId, files, destination) {
  for (const file of files) {
    const key = remoteKey(config, bundleId, `files/${file.path}`);
    const temp = destination
      ? join(destination, ...file.path.split('/'))
      : join(mkdtempSync(join(TEMP_ROOT, 'wm-remote-verify-')), 'object');
    if (destination) mkdirSync(dirname(temp), { recursive: true, mode: 0o700 });
    try {
      await downloadOne(client, key, file.versionId, file, temp);
    } finally {
      if (!destination) rmSync(dirname(temp), { recursive: true, force: true });
    }
  }
}

export async function downloadBundle({ bundleId, destination, config, client, synthetic = false }) {
  configCheck(config);
  if (!synthetic && process.getuid?.() !== 0) reject();
  if (!/^backup-[a-zA-Z0-9-]+$/.test(bundleId) || !isAbsolute(destination)) reject();
  if (resolve(destination) !== destination || existsSync(destination)) reject();
  safePath(destination);
  if ((await client.versioning()) !== 'Enabled') reject();
  if ((await client.location()) !== config.region) reject();
  const completed = await existingCompletion(
    client,
    remoteKey(config, bundleId, 'completion.json'),
  );
  if (!completed) reject();
  completionCheck(completed.completion, config, bundleId, completed.completion.files);
  const staging = `${destination}.${randomUUID()}.partial`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    await verifyRemoteFiles(client, config, bundleId, completed.completion.files, staging);
    const { files, manifest } = bundleFiles(staging, synthetic, bundleId);
    completionCheck(completed.completion, config, bundleId, files, manifest);
    renameSync(staging, destination);
    return {
      bundleId,
      versionId: completed.versionId,
      ...(manifest.schemaVersion === 2 ? { completion: completed.completion } : {}),
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export class AwsCliClient {
  constructor(config) {
    this.config = config;
  }

  call(args, allowMissing = false) {
    const result = spawnSync(
      'aws',
      [
        's3api',
        ...args,
        '--bucket',
        this.config.bucket,
        '--region',
        this.config.region,
        '--expected-bucket-owner',
        this.config.expectedBucketOwner,
        '--output',
        'json',
      ],
      { encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: MAX_RESULT_BYTES, env: process.env },
    );
    if (result.error || result.signal) reject();
    if (result.status !== 0) {
      if (allowMissing && /(?:NoSuchKey|Not Found|404)/.test(result.stderr)) return null;
      reject();
    }
    try {
      return JSON.parse(result.stdout || '{}');
    } catch {
      reject();
    }
  }

  async versioning() {
    return this.call(['get-bucket-versioning']).Status;
  }

  async location() {
    return this.call(['get-bucket-location']).LocationConstraint;
  }

  async put(key, path) {
    return this.call([
      'put-object',
      '--key',
      key,
      '--body',
      path,
      '--server-side-encryption',
      'AES256',
    ]).VersionId;
  }

  async putIfAbsent(key, path) {
    return this.call([
      'put-object',
      '--key',
      key,
      '--body',
      path,
      '--server-side-encryption',
      'AES256',
      '--if-none-match',
      '*',
    ]).VersionId;
  }

  async head(key, versionId) {
    const result = this.call(['head-object', '--key', key, '--version-id', versionId]);
    return { versionId: result.VersionId, encryption: result.ServerSideEncryption };
  }

  async get(key, versionId, target) {
    const result = this.call(['get-object', '--key', key, '--version-id', versionId, target]);
    chmodSync(target, 0o600);
    return { versionId: result.VersionId };
  }

  async getLatestOrNull(key, target) {
    const result = this.call(['get-object', '--key', key, target], true);
    if (!result) return null;
    chmodSync(target, 0o600);
    return { versionId: result.VersionId, encryption: result.ServerSideEncryption };
  }
}

async function main() {
  const [command, configPath, first, second] = process.argv.slice(2);
  if (
    !['upload', 'download'].includes(command) ||
    !configPath ||
    !first ||
    (command === 'download' && !second) ||
    process.argv.length !== (command === 'upload' ? 5 : 6)
  )
    reject();
  if (process.getuid?.() !== 0 || !isAbsolute(configPath)) reject();
  secureFile(configPath, false);
  const config = configCheck(JSON.parse(readFileSync(configPath, 'utf8')));
  const client = new AwsCliClient(config);
  const result =
    command === 'upload'
      ? await uploadBundle({ bundle: first, config, client })
      : await downloadBundle({ bundleId: first, destination: second, config, client });
  const status = result.completion
    ? `BACKUP_REMOTE_${command.toUpperCase()}_LOCAL_INTEGRITY_ONLY`
    : `BACKUP_REMOTE_${command.toUpperCase()}_VERIFIED`;
  process.stdout.write(`${status} ${result.bundleId}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('BACKUP_REMOTE_FAILED\n');
    process.exitCode = 1;
  });
}
