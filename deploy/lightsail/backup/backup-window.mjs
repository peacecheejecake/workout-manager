#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConfig, checkLocks, checkTimers, loadFenceConfig } from './check-fence.mjs';
import { finalizeBundle } from './collect.mjs';

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
    typeof container.State?.Running !== 'boolean' ||
    container.State.Restarting !== false ||
    container.State.Paused !== false ||
    container.State.Dead !== false ||
    (container.State.Running
      ? container.State.Status !== 'running'
      : !['created', 'exited'].includes(container.State.Status))
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
  const policy = container.HostConfig?.RestartPolicy;
  if (
    service !== 'postgres' &&
    (!policy ||
      !['no', 'always', 'unless-stopped', 'on-failure'].includes(policy.Name) ||
      !Number.isSafeInteger(policy.MaximumRetryCount) ||
      policy.MaximumRetryCount < 0 ||
      (policy.Name !== 'on-failure' && policy.MaximumRetryCount !== 0))
  ) {
    reject();
  }
  return { id, running: container.State.Running, policy };
}

function validateServices(run, config) {
  const app = inspect(run, config, 'app');
  const graphhopper = inspect(run, config, 'graphhopper');
  inspect(run, config, 'postgres');
  if (graphhopper.running && !app.running) reject();
  if (
    (!app.running && app.policy.Name !== 'no') ||
    (!graphhopper.running && graphhopper.policy.Name !== 'no')
  )
    reject();
  return { app, graphhopper };
}

function policyArgument(policy) {
  if (policy.Name !== 'on-failure' || policy.MaximumRetryCount === 0) return policy.Name;
  return `on-failure:${policy.MaximumRetryCount}`;
}

function expectPinned(run, config, service, expectedPolicy, expectedRunning) {
  const current = inspect(run, config, service);
  if (
    current.policy.Name !== expectedPolicy.Name ||
    current.policy.MaximumRetryCount !== expectedPolicy.MaximumRetryCount ||
    (expectedRunning !== undefined && current.running !== expectedRunning)
  ) {
    reject();
  }
  return current;
}

function updatePolicy(run, config, service, policy) {
  command(run, 'docker', [
    'update',
    `--restart=${policyArgument(policy)}`,
    config.containers[service],
  ]);
  expectPinned(run, config, service, policy);
}

const NO_RESTART = { Name: 'no', MaximumRetryCount: 0 };

function stopPinned(run, config, service, initial, attempted) {
  expectPinned(run, config, service, NO_RESTART, true);
  attempted.add(service);
  command(run, 'docker', ['stop', '--time', '30', initial.id]);
  expectPinned(run, config, service, NO_RESTART, false);
}

function restorePinned(run, config, service, initial) {
  const current = inspect(run, config, service);
  if (
    current.policy.Name === initial.policy.Name &&
    current.policy.MaximumRetryCount === initial.policy.MaximumRetryCount &&
    current.running === initial.running
  ) {
    return;
  }
  if (
    current.policy.Name !== NO_RESTART.Name ||
    current.policy.MaximumRetryCount !== NO_RESTART.MaximumRetryCount
  ) {
    // A changed policy or identity means another actor has taken control.
    reject();
  }
  let startError;
  if (initial.running && !current.running) {
    try {
      command(run, 'docker', ['start', initial.id]);
    } catch (error) {
      startError = error;
    }
    expectPinned(run, config, service, NO_RESTART, true);
  }
  if (!initial.running && current.running) reject();
  if (initial.policy.Name !== 'no') updatePolicy(run, config, service, initial.policy);
  expectPinned(run, config, service, initial.policy, initial.running);
  return startError;
}

function checkFence(run, path) {
  command(run, path, []);
}

export function runWindow({
  config,
  paths,
  run = runner,
  finalize = finalizeBundle,
  listBundles = readdirSync,
}) {
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
  const policyAttempted = new Set();
  const attempted = new Set();
  let captureError;
  let restoreError;
  let publishedId;
  try {
    for (const service of ['graphhopper', 'app']) {
      if (!initial[service].running || initial[service].policy.Name === 'no') continue;
      expectPinned(run, config, service, initial[service].policy, true);
      policyAttempted.add(service);
      updatePolicy(run, config, service, NO_RESTART);
    }
    if (initial.graphhopper.running)
      stopPinned(run, config, 'graphhopper', initial.graphhopper, attempted);
    if (initial.app.running) stopPinned(run, config, 'app', initial.app, attempted);
    for (const service of ['app', 'graphhopper'])
      expectPinned(
        run,
        config,
        service,
        initial[service].running ? NO_RESTART : initial[service].policy,
        false,
      );
    checkFence(run, paths.fence);
    for (const service of ['app', 'graphhopper'])
      expectPinned(
        run,
        config,
        service,
        initial[service].running ? NO_RESTART : initial[service].policy,
        false,
      );
    const existingBundles = new Set(listBundles(paths.outputDir));
    const output = command(
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
    const published = /^BACKUP_PUBLISHED (backup-[a-zA-Z0-9-]+)\n$/.exec(output);
    if (!published) reject();
    publishedId = published[1];
    if (existingBundles.has(publishedId) || !listBundles(paths.outputDir).includes(publishedId))
      reject();
    checkFence(run, paths.fence);
    for (const service of ['app', 'graphhopper'])
      expectPinned(
        run,
        config,
        service,
        initial[service].running ? NO_RESTART : initial[service].policy,
        false,
      );
  } catch (error) {
    captureError = error;
  } finally {
    let appRestored = !initial.app.running;
    for (const service of ['app', 'graphhopper']) {
      if (!attempted.has(service) && !policyAttempted.has(service)) continue;
      if (
        service === 'graphhopper' &&
        !appRestored &&
        !attempted.has('app') &&
        !policyAttempted.has('app')
      ) {
        try {
          expectPinned(run, config, 'app', initial.app.policy, true);
          appRestored = true;
        } catch (error) {
          restoreError = error;
        }
      }
      if (service === 'graphhopper' && initial.app.running && !appRestored) {
        restoreError = new Error('BACKUP_WINDOW_FAILED');
        continue;
      }
      try {
        const commandError = restorePinned(run, config, service, initial[service]);
        if (service === 'app') appRestored = true;
        if (commandError) restoreError = commandError;
      } catch (error) {
        restoreError = error;
      }
    }
  }
  if (captureError || restoreError) reject();
  if (!publishedId) reject();
  validateServices(run, config);
  for (const service of ['app', 'graphhopper'])
    expectPinned(run, config, service, initial[service].policy, initial[service].running);
  const bundle = join(paths.outputDir, publishedId);
  finalize(bundle, { requireRootOwned: true });
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
