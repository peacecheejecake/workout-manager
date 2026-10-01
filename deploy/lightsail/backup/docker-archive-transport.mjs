#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkConfig, loadFenceConfig } from './check-fence.mjs';

const MAX_DURATION_MS = 30 * 60 * 1000;
const MIN_FREE_BYTES = 64 * 1024 * 1024;
const ARCHIVE_MAGIC = Buffer.from('PGDMP');
const SNAPSHOT_NAME = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i;
const WAL_LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;
const PG_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function reject() {
  throw new Error('BACKUP_TRANSPORT_FAILED');
}

export function validateSnapshotContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  const keys = [
    'snapshotName',
    'consistentPointLsn',
    'postgresSystemIdentifier',
    'replicationSlot',
    'publication',
  ];
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) reject();
  if (
    !keys.every((key) => typeof value[key] === 'string') ||
    !SNAPSHOT_NAME.test(value.snapshotName) ||
    !WAL_LSN.test(value.consistentPointLsn) ||
    !/^[1-9][0-9]{0,19}$/.test(value.postgresSystemIdentifier) ||
    BigInt(value.postgresSystemIdentifier) > 18_446_744_073_709_551_615n ||
    !PG_IDENTIFIER.test(value.replicationSlot) ||
    !PG_IDENTIFIER.test(value.publication)
  ) {
    reject();
  }
  return { ...value, consistentPointLsn: value.consistentPointLsn.toUpperCase() };
}

function noSymlinkParents(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) reject();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function secureFile(path, mode) {
  noSymlinkParents(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== mode) reject();
}

function secureDirectory(path) {
  noSymlinkParents(path);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o777) !== 0o700) reject();
}

function successful(runner, program, args, stdio) {
  const result = runner(program, args, {
    timeout: MAX_DURATION_MS,
    stdio,
    env: process.env,
  });
  if (result.error || result.signal || result.status !== 0) reject();
}

function fence(runner, executable) {
  successful(runner, executable, [], ['ignore', 'ignore', 'ignore']);
}

function digest(path) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function hasArchiveMagic(path) {
  const fd = openSync(path, 'r');
  const prefix = Buffer.alloc(ARCHIVE_MAGIC.length);
  try {
    return (
      readSync(fd, prefix, 0, prefix.length, 0) === prefix.length && prefix.equals(ARCHIVE_MAGIC)
    );
  } finally {
    closeSync(fd);
  }
}

function restoreCheck(runner, containerId, archive, mode) {
  const fd = openSync(archive, 'r');
  try {
    const args = [
      'exec',
      '--interactive',
      '--user',
      'postgres',
      containerId,
      'pg_restore',
      ...(mode === 'list' ? ['--list'] : ['--file=/dev/null']),
    ];
    successful(runner, 'docker', args, [fd, 'ignore', 'ignore']);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function captureArchive({
  output,
  fenceCheck,
  config,
  snapshotContract,
  runner = spawnSync,
}) {
  checkConfig(config);
  const snapshot =
    snapshotContract === undefined ? undefined : validateSnapshotContract(snapshotContract);
  // V2 remains a disposable local contract until the slot export and remote
  // tail are connected to an independently verified restore gate.
  if (snapshot && !realpathSync(dirname(output)).startsWith(`${realpathSync(tmpdir())}${sep}`))
    reject();
  if (
    !isAbsolute(output) ||
    resolve(output) !== output ||
    basename(output) !== 'database.dump' ||
    !isAbsolute(fenceCheck) ||
    resolve(fenceCheck) !== fenceCheck ||
    output.startsWith(`${config.privateDir}${sep}`) ||
    output.startsWith(`${config.postgresDir}${sep}`) ||
    existsSync(output)
  ) {
    reject();
  }
  const partial = `${output}.partial`;
  if (existsSync(partial)) reject();
  fence(runner, fenceCheck);
  let fd;
  let published = false;
  try {
    fd = openSync(partial, 'wx', 0o600);
    successful(
      runner,
      'docker',
      [
        'exec',
        '--user',
        'postgres',
        config.containers.postgres,
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--no-acl',
        ...(snapshot ? [`--snapshot=${snapshot.snapshotName}`] : []),
        '--dbname=workout',
      ],
      ['ignore', fd, 'ignore'],
    );
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!hasArchiveMagic(partial)) reject();
    const before = digest(partial);
    if (before.bytes <= ARCHIVE_MAGIC.length) reject();
    fence(runner, fenceCheck);
    restoreCheck(runner, config.containers.postgres, partial, 'list');
    restoreCheck(runner, config.containers.postgres, partial, 'full');
    if (JSON.stringify(digest(partial)) !== JSON.stringify(before)) reject();
    fence(runner, fenceCheck);
    renameSync(partial, output);
    published = true;
    syncDirectory(dirname(output));
    return before;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(published ? output : partial, { force: true });
    syncDirectory(dirname(output));
    throw error;
  }
}

function parseArgs(args) {
  if (args.length < 4 || args.length % 2 !== 0) reject();
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || options.has(args[i])) reject();
    options.set(args[i], args[i + 1]);
  }
  const output = options.get('--output');
  const fenceCheck = options.get('--fence-check');
  if (!output || !fenceCheck) reject();
  if (options.size === 2) return { output, fenceCheck };
  if (options.get('--synthetic-snapshot-v2') !== 'yes' || options.size !== 8) reject();
  const snapshotContract = validateSnapshotContract({
    snapshotName: options.get('--snapshot-name'),
    consistentPointLsn: options.get('--consistent-point-lsn'),
    postgresSystemIdentifier: options.get('--postgres-system-identifier'),
    replicationSlot: options.get('--replication-slot'),
    publication: options.get('--publication'),
  });
  return { output, fenceCheck, snapshotContract };
}

function runLive() {
  process.umask(0o077);
  if (process.getuid?.() !== 0) reject();
  secureFile(resolve(process.argv[1]), 0o700);
  const { output, fenceCheck, snapshotContract } = parseArgs(process.argv.slice(2));
  if (!isAbsolute(output) || !isAbsolute(fenceCheck)) reject();
  noSymlinkParents(output);
  noSymlinkParents(fenceCheck);
  secureFile(fenceCheck, 0o700);
  secureDirectory(dirname(output));
  const free = statfsSync(dirname(output));
  if (free.bavail * free.bsize < MIN_FREE_BYTES) reject();
  const config = loadFenceConfig(process.env.WORKOUT_BACKUP_FENCE_CONFIG);
  captureArchive({ output, fenceCheck, config, snapshotContract });
  process.stdout.write('BACKUP_TRANSPORT_ARCHIVE_VALIDATED\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runLive();
  } catch {
    process.stderr.write('BACKUP_TRANSPORT_FAILED\n');
    process.exitCode = 1;
  }
}
