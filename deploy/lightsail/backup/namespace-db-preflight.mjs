#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkConfig, loadFenceConfig } from './check-fence.mjs';

const FAILURE = 'BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED';
const SUCCESS = 'BACKUP_NAMESPACE_DB_PREFLIGHT_CHECKED';
const DATABASE = 'workout';
const PORT = 5432;
const QUERY =
  "SELECT current_database() AS database, system_identifier::text AS system_identifier, current_setting('wal_level') AS wal_level, current_setting('server_version_num') AS server_version_num FROM pg_control_system()";

function reject() {
  throw new Error(FAILURE);
}

function validateConfig(config) {
  try {
    checkConfig(config);
  } catch {
    reject();
  }
}

function noSymlinkParents(path, io) {
  let current = path;
  while (true) {
    if (io.existsSync(current) && io.lstatSync(current).isSymbolicLink()) reject();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function secureFile(path, io) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) reject();
  noSymlinkParents(path, io);
  const info = io.lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600) reject();
}

function secureRunnerScript(path, io) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) reject();
  noSymlinkParents(path, io);
  const info = io.lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o700) reject();
}

export function readPostgresPassword(
  path,
  io = { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync },
) {
  let contents;
  let fd;
  try {
    secureFile(path, io);
    fd = io.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const info = io.fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      (info.mode & 0o777) !== 0o600 ||
      !Number.isSafeInteger(info.size) ||
      info.size < 1 ||
      info.size > 4096
    )
      reject();
    contents = io.readFileSync(fd, 'utf8');
  } catch {
    reject();
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        reject();
      }
    }
  }
  if (typeof contents !== 'string' || contents.length > 4096 || contents.includes('\0')) reject();
  const keys = new Set();
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=/.exec(trimmed);
    if (!match || keys.has(match[1])) reject();
    keys.add(match[1]);
  }
  if (
    [...keys].some((key) => !['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'].includes(key)) ||
    !keys.has('POSTGRES_DB') ||
    !keys.has('POSTGRES_PASSWORD')
  ) {
    reject();
  }
  let values;
  try {
    values = parseEnv(contents);
  } catch {
    reject();
  }
  const password = values.POSTGRES_PASSWORD;
  if (
    values.POSTGRES_DB !== DATABASE ||
    (values.POSTGRES_USER !== undefined && values.POSTGRES_USER !== 'postgres') ||
    typeof password !== 'string' ||
    password.length < 24 ||
    [...password].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    reject();
  }
  return password;
}

function command(runner, program, args, options) {
  let result;
  try {
    result = runner(program, args, options);
  } catch {
    reject();
  }
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string')
    reject();
  return result.stdout;
}

export function inspectPinnedPostgres(config, runner = spawnSync) {
  validateConfig(config);
  const id = config.containers.postgres;
  const output = command(runner, '/usr/bin/docker', ['inspect', '--type=container', id], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    reject();
  }
  if (!Array.isArray(value) || value.length !== 1) reject();
  const container = value[0];
  const labels = container?.Config?.Labels;
  const networks = Object.keys(container?.NetworkSettings?.Networks ?? {});
  const pid = container?.State?.Pid;
  if (
    container?.Id !== id ||
    container?.State?.Running !== true ||
    container?.State?.Status !== 'running' ||
    !Number.isSafeInteger(pid) ||
    pid < 2 ||
    pid > 2_147_483_647 ||
    labels?.['com.docker.compose.project'] !== config.project ||
    labels?.['com.docker.compose.service'] !== 'postgres' ||
    labels?.['com.docker.compose.project.config_files'] !== config.composeFile ||
    networks.length !== 1 ||
    networks[0] !== config.network ||
    container?.HostConfig?.NetworkMode !== config.network
  ) {
    reject();
  }
  return pid;
}

export async function probeDatabase({
  config,
  postgresEnvPath,
  ClientClass,
  readPassword = readPostgresPassword,
}) {
  validateConfig(config);
  let client;
  try {
    const password = readPassword(postgresEnvPath);
    const DatabaseClient = ClientClass ?? (await import('pg')).default.Client;
    client = new DatabaseClient({
      host: '127.0.0.1',
      port: PORT,
      user: 'postgres',
      database: DATABASE,
      password,
      ssl: false,
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
      statement_timeout: 3000,
      application_name: 'wm_backup_namespace_preflight',
    });
    await client.connect();
    const result = await client.query(QUERY);
    const row = result.rows?.[0];
    if (
      result.rows?.length !== 1 ||
      row?.database !== DATABASE ||
      row?.system_identifier !== config.postgresSystemIdentifier ||
      row?.wal_level !== 'logical' ||
      row?.server_version_num !== config.postgresVersionNum
    ) {
      reject();
    }
    return true;
  } catch {
    reject();
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        reject();
      }
    }
  }
}

export function runNamespaceChild({
  configPath,
  postgresEnvPath,
  scriptPath = process.argv[1],
  loadConfig = loadFenceConfig,
  io = { existsSync, lstatSync, readlinkSync },
  runner = spawnSync,
  probe = probeDatabase,
  platform = process.platform,
  uid = process.getuid?.(),
}) {
  if (platform !== 'linux' || uid !== 0) reject();
  secureRunnerScript(scriptPath, io);
  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    reject();
  }
  const pid = inspectPinnedPostgres(config, runner);
  let currentNetwork;
  let pinnedNetwork;
  try {
    currentNetwork = io.readlinkSync('/proc/self/ns/net');
    pinnedNetwork = io.readlinkSync(`/proc/${pid}/ns/net`);
  } catch {
    reject();
  }
  if (!/^net:\[\d+\]$/.test(currentNetwork) || currentNetwork !== pinnedNetwork) reject();
  return probe({ config, postgresEnvPath });
}

export function runNamespaceParent({
  configPath,
  postgresEnvPath,
  scriptPath,
  loadConfig = loadFenceConfig,
  runner = spawnSync,
  platform = process.platform,
  uid = process.getuid?.(),
  nodePath = process.execPath,
  io = { existsSync, lstatSync, readFileSync },
}) {
  if (platform !== 'linux' || uid !== 0) reject();
  if (!isAbsolute(nodePath)) reject();
  secureRunnerScript(scriptPath, io);
  secureFile(postgresEnvPath, io);
  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    reject();
  }
  const pid = inspectPinnedPostgres(config, runner);
  const stdout = command(
    runner,
    '/usr/bin/nsenter',
    [
      `--net=/proc/${pid}/ns/net`,
      '--',
      nodePath,
      scriptPath,
      '--child',
      configPath,
      postgresEnvPath,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    },
  );
  if (stdout !== `${SUCCESS}\n`) reject();
  return true;
}

async function runLive() {
  try {
    if (process.argv[2] === '--child' && process.argv.length === 5) {
      await runNamespaceChild({ configPath: process.argv[3], postgresEnvPath: process.argv[4] });
    } else if (process.argv[2] === '--postgres-env' && process.argv.length === 4) {
      runNamespaceParent({
        configPath: process.env.WORKOUT_BACKUP_FENCE_CONFIG,
        postgresEnvPath: process.argv[3],
        scriptPath: resolve(process.argv[1]),
      });
    } else {
      reject();
    }
    process.stdout.write(`${SUCCESS}\n`);
  } catch {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runLive();
}
