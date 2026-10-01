#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  constants,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = '/srv/workout-manager/source';
const LOCK_DIRECTORY = '/run/lock/workout-manager';
const ENV_FILE = '/srv/workout-manager/compose.env';
const CONFIG_FILE = '/srv/workout-manager/admin/host-writer.json';
const COMPOSE_FILE = 'deploy/lightsail/compose.yml';
const PROJECT = 'workout-manager';
const DOCKER_HOST = 'unix:///var/run/docker.sock';
const LOCK_NAMES = ['backup.lock', 'maintenance.lock'];
const SERVICES = new Set(['app', 'graphhopper', 'postgres']);

function fail() {
  throw new Error('WORKOUT_HOST_WRITER_FAILED');
}

export function commandFor(
  args,
  { source = SOURCE, envFile = ENV_FILE, dockerProgram = '/usr/bin/docker' } = {},
) {
  const common = [
    '--host',
    DOCKER_HOST,
    'compose',
    '--project-name',
    PROJECT,
    '--env-file',
    envFile,
    '-f',
    join(source, COMPOSE_FILE),
  ];
  if (args.length === 1 && args[0] === 'build') return [dockerProgram, [...common, 'build']];
  if (args.length === 2 && args[0] === 'up' && SERVICES.has(args[1])) {
    return [dockerProgram, [...common, 'up', '-d', args[1]]];
  }
  if (args.length === 1 && args[0] === 'setup') {
    return [
      dockerProgram,
      [
        ...common,
        '--profile',
        'setup',
        'run',
        '--rm',
        '--no-deps',
        '--name',
        'wm-db-setup-one-shot',
        'db_setup',
      ],
    ];
  }
  if (args.length === 2 && args[0] === 'start' && SERVICES.has(args[1])) {
    return [dockerProgram, [...common, 'start', args[1]]];
  }
  // Exact diagnostic commands only; no shell, SQL, arbitrary executable, or supplied container ID.
  if (args.length === 2 && args[0] === 'exec' && args[1] === 'postgres-ready') {
    return [
      dockerProgram,
      [...common, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres', '-d', 'workout'],
    ];
  }
  fail();
}

function noSymlinkParents(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function secureFile(path, mode, uid) {
  noSymlinkParents(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== mode) fail();
}

function checkCompose(configFile, source, uid) {
  secureFile(configFile, 0o600, uid);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (
    config?.schemaVersion !== 1 ||
    typeof config.composeSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(config.composeSha256) ||
    Object.keys(config).sort().join(',') !== 'composeSha256,schemaVersion'
  )
    fail();
  const composePath = join(source, COMPOSE_FILE);
  noSymlinkParents(composePath);
  const info = lstatSync(composePath);
  if (!info.isFile() || (info.mode & 0o022) !== 0) fail();
  const actual = createHash('sha256').update(readFileSync(composePath)).digest('hex');
  if (actual !== config.composeSha256) fail();
}

export function childEnvironment() {
  return { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', TMPDIR: '/tmp' };
}

function prepareLocks(directory, uid) {
  noSymlinkParents(directory);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) fail();
  for (const name of LOCK_NAMES) {
    const path = join(directory, name);
    noSymlinkParents(path);
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    secureFile(path, 0o600, uid);
  }
}

export async function runWriter(args, options = {}) {
  const {
    source = SOURCE,
    envFile = ENV_FILE,
    configFile = CONFIG_FILE,
    lockDirectory = LOCK_DIRECTORY,
    uid = 0,
    program = '/usr/bin/flock',
    dockerProgram = '/usr/bin/docker',
    onSpawn,
  } = options;
  const [childProgram, childArgs] = commandFor(args, { source, envFile, dockerProgram });
  secureFile(envFile, 0o600, uid);
  checkCompose(configFile, source, uid);
  prepareLocks(lockDirectory, uid);
  const lockArgs = [
    '--no-fork',
    '--nonblock',
    '--conflict-exit-code',
    '75',
    join(lockDirectory, LOCK_NAMES[0]),
    program,
    '--no-fork',
    '--nonblock',
    '--conflict-exit-code',
    '75',
    join(lockDirectory, LOCK_NAMES[1]),
    childProgram,
    ...childArgs,
  ];
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn(program, lockArgs, {
      cwd: source,
      stdio: 'inherit',
      detached: true,
      env: childEnvironment(),
    });
    const signals = ['SIGINT', 'SIGTERM'];
    const forward = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* child already exited */
      }
    };
    for (const signal of signals) process.on(signal, forward);
    const cleanup = () => {
      for (const signal of signals) process.off(signal, forward);
    };
    onSpawn?.(child);
    child.once('error', (error) => {
      cleanup();
      rejectResult(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolveResult(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : (code ?? 1));
    });
  });
}

async function main() {
  process.umask(0o077);
  if (process.getuid?.() !== 0) fail();
  secureFile(fileURLToPath(import.meta.url), 0o700, 0);
  const status = await runWriter(process.argv.slice(2));
  if (status === 75) process.stderr.write('WORKOUT_HOST_WRITER_BUSY\n');
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('WORKOUT_HOST_WRITER_FAILED\n');
    process.exitCode = 1;
  });
}
