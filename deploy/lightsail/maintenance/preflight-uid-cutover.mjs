#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = '/srv/workout-manager/source';
const CONFIG = '/srv/workout-manager/admin/uid-cutover.json';
const COMPOSE = join(SOURCE, 'deploy/lightsail/compose.yml');
const WRITER = '/srv/workout-manager/admin/run-host-writer.mjs';
const ENV = '/srv/workout-manager/compose.env';
const PRIVATE = '/srv/workout-manager/data/private';
const ROUTING = '/srv/workout-manager/data/routing';
const LOCKS = [
  '/run/lock/workout-manager/backup.lock',
  '/run/lock/workout-manager/maintenance.lock',
];
const HEX = /^[a-f0-9]{64}$/;

function fail() {
  throw new Error('UID_CUTOVER_PREFLIGHT_FAILED');
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

export function validatePins(value) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'composeSha256',
      'writerSha256',
      'postgresContainerId',
      'oldAppImageId',
      'oldGraphhopperImageId',
      'candidateAppImageId',
      'candidateGraphhopperImageId',
      'snapshotId',
    ]) ||
    value.schemaVersion !== 1 ||
    [
      'composeSha256',
      'writerSha256',
      'postgresContainerId',
      'oldAppImageId',
      'oldGraphhopperImageId',
      'candidateAppImageId',
      'candidateGraphhopperImageId',
    ].some((key) => !HEX.test(value[key])) ||
    typeof value.snapshotId !== 'string' ||
    !/^wm-[a-z0-9-]{8,80}$/.test(value.snapshotId) ||
    value.oldAppImageId === value.candidateAppImageId ||
    value.oldGraphhopperImageId === value.candidateGraphhopperImageId
  )
    fail();
  return value;
}

function securePath(path, mode, type = 'file') {
  let current = resolve(path);
  while (true) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) fail();
    if (
      current === path &&
      (info.uid !== 0 ||
        (info.mode & 0o777) !== mode ||
        (type === 'file' ? !info.isFile() : !info.isDirectory()))
    )
      fail();
    if (current !== path && (info.uid !== 0 || !info.isDirectory() || (info.mode & 0o022) !== 0))
      fail();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (realpathSync(path) !== path) fail();
}

function protectedDirectory(path) {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.uid !== 0 ||
    info.gid !== 0 ||
    (info.mode & 0o022) !== 0 ||
    realpathSync(path) !== path
  )
    fail();
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertTree(path, owner, mountpoints, limit = 100_000, group = owner) {
  const rootDevice = statSync(path).dev;
  const pending = [path];
  let checked = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (
      ++checked > limit ||
      mountpoints.some(
        (mount) =>
          (mount === entry && entry !== path) ||
          mount.startsWith(`${entry}/`) ||
          (mount === path && owner === 0),
      )
    )
      fail();
    const info = lstatSync(entry);
    if (
      info.isSymbolicLink() ||
      (!info.isFile() && !info.isDirectory()) ||
      info.dev !== rootDevice ||
      info.uid !== owner ||
      info.gid !== group
    )
      fail();
    if (owner === 0 && (info.mode & 0o022) !== 0) fail();
    if (info.isDirectory()) for (const name of readdirSync(entry)) pending.push(join(entry, name));
  }
  return checked;
}

function mountpointsFrom(contents) {
  return contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(' ');
      if (fields.length < 5 || !fields[4].startsWith('/')) fail();
      return fields[4].replace(/\\([0-7]{3})/g, (_, octal) =>
        String.fromCharCode(parseInt(octal, 8)),
      );
    });
}

function command(runner, program, args) {
  const result = runner(program, args);
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') fail();
  return result.stdout.trim();
}

function statusOutput(runner, program, args, status) {
  const result = runner(program, args);
  if (result.error || result.status !== status || typeof result.stdout !== 'string') fail();
  return result.stdout.trim();
}

function inactiveTimer(runner, timer) {
  if (statusOutput(runner, '/usr/bin/systemctl', ['is-active', timer], 3) !== 'inactive') fail();
  const result = runner('/usr/bin/systemctl', ['is-enabled', timer]);
  if (
    result.error ||
    ![0, 1].includes(result.status) ||
    !['disabled', 'masked'].includes(result.stdout?.trim())
  )
    fail();
}

function jsonCommand(runner, program, args) {
  try {
    return JSON.parse(command(runner, program, args));
  } catch {
    fail();
  }
}

function inspectContainer(runner, id) {
  const values = jsonCommand(runner, '/usr/bin/docker', [
    '--host',
    'unix:///var/run/docker.sock',
    'inspect',
    id,
  ]);
  if (
    !Array.isArray(values) ||
    values.length !== 1 ||
    values[0].Id !== id ||
    values[0].Config?.Labels?.['com.docker.compose.project'] !== 'workout-manager'
  )
    fail();
  return values[0];
}

function inspectImage(runner, id, user) {
  const values = jsonCommand(runner, '/usr/bin/docker', [
    '--host',
    'unix:///var/run/docker.sock',
    'image',
    'inspect',
    id,
  ]);
  if (
    !Array.isArray(values) ||
    values.length !== 1 ||
    values[0].Id !== `sha256:${id}` ||
    values[0].Config?.User !== user
  )
    fail();
}

export function assessCutover(pins, { runner, files, mountpoints }) {
  validatePins(pins);
  for (const [path, expected] of [
    [COMPOSE, pins.composeSha256],
    [WRITER, pins.writerSha256],
  ]) {
    if (files.hash(path) !== expected) fail();
  }
  files.assertTree(SOURCE, 0, mountpoints);
  files.assertTree(PRIVATE, 1000, mountpoints);
  files.assertTree(ROUTING, 1000, mountpoints);
  for (const id of [20001, 20002]) {
    if (
      statusOutput(runner, '/usr/bin/getent', ['passwd', String(id)], 2) ||
      statusOutput(runner, '/usr/bin/getent', ['group', String(id)], 2)
    )
      fail();
  }
  for (const timer of ['workout-resource-cleanup.timer', 'workout-course-thumbnails.timer']) {
    inactiveTimer(runner, timer);
  }
  for (const lock of LOCKS) {
    command(runner, '/usr/bin/flock', [
      '--nonblock',
      '--conflict-exit-code',
      '75',
      lock,
      '/usr/bin/true',
    ]);
  }
  const ids = command(runner, '/usr/bin/docker', [
    '--host',
    'unix:///var/run/docker.sock',
    'ps',
    '--all',
    '--no-trunc',
    '--filter',
    'label=com.docker.compose.project=workout-manager',
    '--format',
    '{{.ID}}',
  ])
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 3 || ids.some((id) => !HEX.test(id))) fail();
  const inspected = ids.map((id) => inspectContainer(runner, id));
  const containers = ['app', 'graphhopper', 'postgres'].map((service) => {
    const matches = inspected.filter(
      (item) => item.Config.Labels['com.docker.compose.service'] === service,
    );
    if (matches.length !== 1) fail();
    return matches[0];
  });
  const [app, graphhopper, postgres] = containers;
  if (
    postgres.Id !== pins.postgresContainerId ||
    postgres.State?.Running !== true ||
    postgres.State?.Health?.Status !== 'healthy' ||
    app.State?.Running !== true ||
    graphhopper.State?.Running !== true ||
    app.Image !== `sha256:${pins.oldAppImageId}` ||
    graphhopper.Image !== `sha256:${pins.oldGraphhopperImageId}`
  )
    fail();
  // Dockerfile USER records names; Compose supplies the numeric runtime user.
  // The name-to-ID mapping still needs a disposable-container probe.
  inspectImage(runner, pins.candidateAppImageId, 'workout:workout');
  inspectImage(runner, pins.candidateGraphhopperImageId, 'graphhopper:graphhopper');
  if (
    command(runner, '/usr/bin/docker', [
      '--host',
      'unix:///var/run/docker.sock',
      'exec',
      '--user',
      'postgres',
      postgres.Id,
      'psql',
      '-X',
      '-A',
      '-t',
      '-U',
      'postgres',
      '-d',
      'workout',
      '-c',
      'SHOW wal_level',
    ]) !== 'replica'
  )
    fail();
  return {
    status: 'local_checks_passed',
    snapshotId: pins.snapshotId,
    postgresContainerId: postgres.Id,
    checkedSource: true,
    checkedOwnership: true,
  };
}

function liveRunner(program, args) {
  return spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C' },
  });
}

function runLive() {
  if (process.getuid?.() !== 0 || process.argv.length !== 3 || process.argv[2] !== '--check')
    fail();
  securePath(fileURLToPath(import.meta.url), 0o700);
  securePath(CONFIG, 0o600);
  securePath(WRITER, 0o700);
  securePath(ENV, 0o600);
  for (const lock of LOCKS) securePath(lock, 0o600);
  for (const path of [SOURCE, PRIVATE, ROUTING]) {
    let current = path;
    while (current !== '/') {
      if (lstatSync(current).isSymbolicLink()) fail();
      current = dirname(current);
    }
  }
  protectedDirectory('/srv/workout-manager');
  const pins = validatePins(JSON.parse(readFileSync(CONFIG, 'utf8')));
  const mounts = mountpointsFrom(readFileSync('/proc/self/mountinfo', 'utf8'));
  const files = { hash, assertTree };
  const result = assessCutover(pins, { runner: liveRunner, files, mountpoints: mounts });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runLive();
  } catch {
    process.stderr.write('UID_CUTOVER_PREFLIGHT_FAILED\n');
    process.exitCode = 1;
  }
}
