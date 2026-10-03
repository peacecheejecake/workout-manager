#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const BASE_FILE = fileURLToPath(new URL('./compose.yml', import.meta.url));
const LOGICAL_FILE = fileURLToPath(new URL('./compose.logical-wal.yml', import.meta.url));
const UNITS = { MB: 1024n ** 2n, GB: 1024n ** 3n, TB: 1024n ** 4n };

export function validateLogicalWalCommand(command) {
  if (!Array.isArray(command) || command.length !== 5)
    throw new Error('INVALID_LOGICAL_WAL_COMMAND');
  if (
    command[0] !== 'postgres' ||
    command[1] !== '-c' ||
    command[2] !== 'wal_level=logical' ||
    command[3] !== '-c' ||
    typeof command[4] !== 'string'
  )
    throw new Error('INVALID_LOGICAL_WAL_COMMAND');

  const match = /^max_slot_wal_keep_size=([1-9][0-9]*)(MB|GB|TB)$/.exec(command[4]);
  if (!match) throw new Error('INVALID_LOGICAL_WAL_CAP');
  const bytes = BigInt(match[1]) * UNITS[match[2]];
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_LOGICAL_WAL_CAP');
}

export function preflight(envFile, { docker = 'docker', env = process.env } = {}) {
  if (typeof envFile !== 'string' || !envFile.startsWith('/')) {
    throw new Error('INVALID_COMPOSE_ENV_FILE');
  }
  const result = spawnSync(
    docker,
    [
      'compose',
      '--env-file',
      envFile,
      '-f',
      BASE_FILE,
      '-f',
      LOGICAL_FILE,
      'config',
      '--no-env-resolution',
      '--format',
      'json',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, env },
  );
  if (result.error || result.status !== 0) throw new Error('LOGICAL_WAL_COMPOSE_RENDER_FAILED');
  let config;
  try {
    config = JSON.parse(result.stdout);
  } catch {
    throw new Error('LOGICAL_WAL_COMPOSE_RENDER_FAILED');
  }
  validateLogicalWalCommand(config?.services?.postgres?.command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('INVALID_COMPOSE_ENV_FILE');
    preflight(process.argv[2]);
    process.stdout.write('LOGICAL_WAL_CAP_PREFLIGHT_OK\n');
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'LOGICAL_WAL_CAP_PREFLIGHT_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
