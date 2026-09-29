#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = 'workout-manager';
const SERVICES = ['app', 'postgres', 'graphhopper'];
const COMPOSE_FILE = '/srv/workout-manager/source/deploy/lightsail/compose.yml';
const PRIVATE_DIR = '/srv/workout-manager/data/private';
const POSTGRES_DIR = '/srv/workout-manager/data/postgres';
const TIMERS = ['workout-resource-cleanup.timer', 'workout-course-thumbnails.timer'];
const LOCKS = [
  '/run/lock/workout-manager/backup.lock',
  '/run/lock/workout-manager/maintenance.lock',
];

function reject() {
  throw new Error('BACKUP_FENCE_FAILED');
}

function command(runner, program, args) {
  const result = runner(program, args);
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') reject();
  return result.stdout;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    reject();
  }
}

function isFullId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function checkConfig(config) {
  if (
    config?.schemaVersion !== 1 ||
    config.project !== PROJECT ||
    config.composeFile !== COMPOSE_FILE ||
    config.privateDir !== PRIVATE_DIR ||
    config.postgresDir !== POSTGRES_DIR ||
    typeof config.composeSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(config.composeSha256) ||
    typeof config.postgresSystemIdentifier !== 'string' ||
    !/^\d{10,25}$/.test(config.postgresSystemIdentifier) ||
    typeof config.network !== 'string' ||
    config.network !== `${PROJECT}_workout_internal` ||
    !config.containers ||
    Object.keys(config.containers).sort().join(',') !== [...SERVICES].sort().join(',') ||
    SERVICES.some((service) => !isFullId(config.containers[service])) ||
    new Set(Object.values(config.containers)).size !== SERVICES.length ||
    new Set([config.composeFile, config.privateDir, config.postgresDir]).size !== 3
  ) {
    reject();
  }
}

function hasMount(container, source, destination) {
  return container.Mounts?.some(
    (mount) =>
      mount.Type === 'bind' && mount.Source === source && mount.Destination === destination,
  );
}

function touches(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function overlaps(path, root) {
  return touches(path, root) || touches(root, path);
}

function inspectContainers(config, containers) {
  if (!Array.isArray(containers)) reject();
  const expected = new Set(Object.values(config.containers));
  const seen = new Set();
  for (const container of containers) {
    const id = container.Id;
    if (!isFullId(id)) reject();
    const labels = container.Config?.Labels ?? {};
    const project = labels['com.docker.compose.project'];
    const service = labels['com.docker.compose.service'];
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
    const mounts = container.Mounts ?? [];
    const touchesWorkoutData = mounts.some(
      (mount) =>
        typeof mount.Source === 'string' &&
        (overlaps(mount.Source, config.privateDir) || overlaps(mount.Source, config.postgresDir)),
    );
    const relevant =
      project === PROJECT ||
      networks.includes(config.network) ||
      touchesWorkoutData ||
      expected.has(id);
    if (!relevant) continue;
    if (
      !expected.has(id) ||
      project !== PROJECT ||
      config.containers[service] !== id ||
      labels['com.docker.compose.project.config_files'] !== config.composeFile ||
      seen.has(id)
    ) {
      reject();
    }
    seen.add(id);
    if (service === 'app') {
      if (
        container.State?.Running !== false ||
        !hasMount(container, config.privateDir, '/var/lib/workout/private')
      )
        reject();
      if (!networks.includes(config.network)) reject();
    } else if (service === 'postgres') {
      if (
        container.State?.Running !== true ||
        container.State?.Health?.Status !== 'healthy' ||
        !hasMount(container, config.postgresDir, '/var/lib/postgresql/data') ||
        !networks.includes(config.network)
      ) {
        reject();
      }
    } else if (service === 'graphhopper') {
      if (container.State?.Running !== false) reject();
    } else {
      reject();
    }
  }
  if (seen.size !== SERVICES.length) reject();
}

function checkTimers(runner) {
  for (const timer of TIMERS) {
    const output = command(runner, 'systemctl', [
      'show',
      '--no-page',
      '--property=LoadState,ActiveState,UnitFileState',
      timer,
    ]);
    const values = Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((line) => line.split('=', 2)),
    );
    if (
      values.ActiveState !== 'inactive' ||
      !(
        values.LoadState === 'not-found' ||
        (values.LoadState === 'loaded' && ['disabled', 'masked'].includes(values.UnitFileState))
      )
    ) {
      reject();
    }
  }
}

function checkLocks(runner) {
  for (const lock of LOCKS) {
    const result = runner('flock', ['--nonblock', '--conflict-exit-code', '75', lock, 'true']);
    if (result.error || result.status !== 75) reject();
  }
}

const DATABASE_QUERY =
  'SELECT current_database(), (pg_control_system()).system_identifier::text, ' +
  "(SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid())";

function checkDatabase(config, runner) {
  const output = command(runner, 'docker', [
    'exec',
    '--user',
    'postgres',
    config.containers.postgres,
    'psql',
    '-X',
    '-A',
    '-t',
    '-F',
    '\t',
    '-d',
    'workout',
    '-c',
    DATABASE_QUERY,
  ]);
  const rows = output.trim().split('\n');
  if (rows.length !== 1) reject();
  const [database, systemIdentifier, otherClients] = rows[0].split('\t');
  if (
    database !== 'workout' ||
    systemIdentifier !== config.postgresSystemIdentifier ||
    otherClients !== '0'
  ) {
    reject();
  }
}

export function assessFence(config, runner) {
  checkConfig(config);
  checkTimers(runner);
  checkLocks(runner);
  const ids = command(runner, 'docker', ['ps', '--all', '--no-trunc', '--quiet'])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (ids.length < SERVICES.length || ids.some((id) => !isFullId(id))) reject();
  const containers = parseJson(command(runner, 'docker', ['inspect', ...ids]));
  if (
    containers.length !== ids.length ||
    new Set(containers.map((container) => container.Id)).size !== ids.length ||
    containers.some((container) => !ids.includes(container.Id))
  ) {
    reject();
  }
  inspectContainers(config, containers);
  checkDatabase(config, runner);
  return true;
}

function assertNoSymlinkParents(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) reject();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function secureFile(path, mode) {
  assertNoSymlinkParents(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== mode) reject();
}

function liveRunner(program, args) {
  return spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function runLive() {
  if (process.getuid?.() !== 0) reject();
  secureFile(resolve(process.argv[1]), 0o700);
  const configPath = process.env.WORKOUT_BACKUP_FENCE_CONFIG;
  if (!configPath || !isAbsolute(configPath)) reject();
  secureFile(configPath, 0o600);
  for (const lock of LOCKS) secureFile(lock, 0o600);
  const config = parseJson(readFileSync(configPath, 'utf8'));
  checkConfig(config);
  for (const path of [config.composeFile, config.privateDir, config.postgresDir]) {
    assertNoSymlinkParents(path);
    if (realpathSync(path) !== path) reject();
  }
  const source = readFileSync(config.composeFile);
  if (createHash('sha256').update(source).digest('hex') !== config.composeSha256) reject();
  if (!lstatSync(config.privateDir).isDirectory() || !lstatSync(config.postgresDir).isDirectory())
    reject();
  assessFence(config, liveRunner);
  process.stdout.write('BACKUP_FENCE_CHECKED\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runLive();
  } catch {
    process.stderr.write('BACKUP_FENCE_FAILED\n');
    process.exitCode = 1;
  }
}
