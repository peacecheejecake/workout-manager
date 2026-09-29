#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConfig, checkLocks, checkTimers, loadFenceConfig } from './check-fence.mjs';

const LOCK_DIRECTORY = '/run/lock/workout-manager';
const LOCKS = [join(LOCK_DIRECTORY, 'backup.lock'), join(LOCK_DIRECTORY, 'maintenance.lock')];
const BACKUP_OUTPUT_DIR = '/srv/workout-manager/backups';
const BACKUP_TIMEOUT_MS = 35 * 60_000;
const DOCKER_TIMEOUT_MS = 60_000;

function reject() {
  throw new Error('BACKUP_WINDOW_FAILED');
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

function runner(program, args, options = {}) {
  return spawnSync(program, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? DOCKER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: process.env,
  });
}

function command(run, program, args, timeout = DOCKER_TIMEOUT_MS) {
  const result = run(program, args, { timeout });
  if (result.error || result.signal || result.status !== 0) reject();
  return result.stdout;
}

function inspect(run, config, service) {
  const id = config.containers[service];
  const output = command(run, 'docker', ['inspect', id]);
  let container;
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== 1) reject();
    [container] = parsed;
  } catch {
    reject();
  }
  const labels = container?.Config?.Labels ?? {};
  if (
    container.Id !== id ||
    labels['com.docker.compose.project'] !== config.project ||
    labels['com.docker.compose.service'] !== service ||
    labels['com.docker.compose.project.config_files'] !== config.composeFile ||
    typeof container.State?.Running !== 'boolean'
  ) {
    reject();
  }
  if (service === 'app') {
    if (
      !container.Mounts?.some(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === config.privateDir &&
          mount.Destination === '/var/lib/workout/private',
      ) ||
      !container.NetworkSettings?.Networks?.[config.network]
    ) {
      reject();
    }
  }
  if (service === 'postgres') {
    if (
      !container.State.Running ||
      container.State.Health?.Status !== 'healthy' ||
      !container.Mounts?.some(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === config.postgresDir &&
          mount.Destination === '/var/lib/postgresql/data',
      ) ||
      !container.NetworkSettings?.Networks?.[config.network]
    ) {
      reject();
    }
  }
  return container.State.Running;
}

function validateServices(run, config) {
  const app = inspect(run, config, 'app');
  const graphhopper = inspect(run, config, 'graphhopper');
  inspect(run, config, 'postgres');
  if (graphhopper && !app) reject();
  return { app, graphhopper };
}

function stopPinned(run, config, service, attempted) {
  const id = config.containers[service];
  attempted.add(service);
  command(run, 'docker', ['stop', '--time', '30', id]);
  if (inspect(run, config, service)) reject();
}

function restorePinned(run, config, service) {
  const running = inspect(run, config, service);
  if (running) return;
  command(run, 'docker', ['start', config.containers[service]]);
  if (!inspect(run, config, service)) reject();
}

function checkFence(run, path) {
  command(run, path, []);
}

export function runWindow({ config, paths, run = runner }) {
  checkConfig(config);
  if (
    !paths ||
    !isAbsolute(paths.fence) ||
    !isAbsolute(paths.collector) ||
    !isAbsolute(paths.transport) ||
    paths.outputDir !== BACKUP_OUTPUT_DIR
  ) {
    reject();
  }
  checkLocks(run);
  checkTimers(run);
  const initial = validateServices(run, config);
  const attempted = new Set();
  let captureError;
  let restoreError;
  try {
    if (initial.graphhopper) stopPinned(run, config, 'graphhopper', attempted);
    if (initial.app) stopPinned(run, config, 'app', attempted);
    checkFence(run, paths.fence);
    command(
      run,
      process.execPath,
      [
        paths.collector,
        'collect',
        '--database-transport',
        paths.transport,
        '--private-dir',
        config.privateDir,
        '--output-dir',
        paths.outputDir,
        '--fence-check',
        paths.fence,
      ],
      BACKUP_TIMEOUT_MS,
    );
    checkFence(run, paths.fence);
  } catch (error) {
    captureError = error;
  } finally {
    for (const service of ['app', 'graphhopper']) {
      if (!attempted.has(service)) continue;
      try {
        restorePinned(run, config, service);
      } catch (error) {
        restoreError = error;
      }
    }
  }
  if (captureError || restoreError) reject();
  return true;
}

function prepareLocks() {
  noSymlinkParents(LOCK_DIRECTORY);
  if (!existsSync(LOCK_DIRECTORY)) mkdirSync(LOCK_DIRECTORY, { mode: 0o700 });
  secureDirectory(LOCK_DIRECTORY);
  for (const path of LOCKS) {
    noSymlinkParents(path);
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
    secureFile(path, 0o600);
  }
}

function pathsForInstalledSuite() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const paths = {
    fence: join(directory, 'check-fence.mjs'),
    collector: join(directory, 'collect.mjs'),
    transport: join(directory, 'docker-archive-transport.mjs'),
    outputDir: BACKUP_OUTPUT_DIR,
  };
  for (const path of [
    fileURLToPath(import.meta.url),
    paths.fence,
    paths.collector,
    paths.transport,
  ])
    secureFile(path, 0o700);
  secureDirectory(paths.outputDir);
  return paths;
}

function runLive() {
  process.umask(0o077);
  if (process.getuid?.() !== 0 || process.argv.length > 3) reject();
  const held = process.argv[2] === '--locks-held';
  if (process.argv.length === 3 && !held) reject();
  const config = loadFenceConfig(process.env.WORKOUT_BACKUP_FENCE_CONFIG);
  const paths = pathsForInstalledSuite();
  prepareLocks();
  if (!held) {
    const result = runner(
      'flock',
      [
        '--nonblock',
        '--conflict-exit-code',
        '75',
        LOCKS[0],
        'flock',
        '--nonblock',
        '--conflict-exit-code',
        '75',
        LOCKS[1],
        process.execPath,
        fileURLToPath(import.meta.url),
        '--locks-held',
      ],
      { timeout: 0 },
    );
    if (result.error || result.signal || result.status !== 0) reject();
    process.stdout.write('BACKUP_WINDOW_FINISHED\n');
    return;
  }
  runWindow({ config, paths });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runLive();
  } catch {
    process.stderr.write('BACKUP_WINDOW_FAILED\n');
    process.exitCode = 1;
  }
}
