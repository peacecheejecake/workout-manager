import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commandFor } from './maintenance/run-host-writer.mjs';

const base = readFileSync(new URL('./compose.yml', import.meta.url), 'utf8');
const logical = readFileSync(new URL('./compose.logical-wal.yml', import.meta.url), 'utf8');
const baseFile = new URL('./compose.yml', import.meta.url).pathname;
const logicalFile = new URL('./compose.logical-wal.yml', import.meta.url).pathname;

function render(files, cap) {
  const env = {
    ...process.env,
    WORKOUT_RELEASE: 'local-check',
    WORKOUT_DATA_DIR: '/tmp/workout-data',
    WORKOUT_SECRETS_DIR: '/tmp/workout-secrets',
  };
  delete env.WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE;
  if (cap) env.WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE = cap;
  return spawnSync(
    'docker',
    [
      'compose',
      '--profile',
      '*',
      ...files.flatMap((file) => ['-f', file]),
      'config',
      '--no-env-resolution',
      '--format',
      'json',
    ],
    { encoding: 'utf8', env },
  );
}

test('base Compose has no logical WAL activation and writer app/routing up stays single-service', () => {
  assert.doesNotMatch(
    base,
    /wal_level=logical|max_slot_wal_keep_size|WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE/,
  );
  assert.match(logical, /wal_level=logical/);
  assert.match(logical, /max_slot_wal_keep_size=\$\{WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE:\?/);
  for (const name of ['app', 'graphhopper']) {
    const command = commandFor(['up', name])[1];
    assert.deepEqual(command.slice(-4), ['up', '-d', '--no-deps', name]);
    assert.deepEqual(
      command.filter((arg) => arg === '-f'),
      ['-f'],
    );
    assert.equal(command.includes(logicalFile), false);
  }
});

test('rendered logical WAL model requires an explicit measured-cap input', (t) => {
  const baseResult = render([baseFile]);
  if (baseResult.error?.code === 'ENOENT') {
    t.skip('Docker Compose CLI is unavailable');
    return;
  }
  assert.equal(baseResult.status, 0, baseResult.stderr);
  assert.equal(JSON.parse(baseResult.stdout).services.postgres.command, null);

  const missingCap = render([baseFile, logicalFile]);
  assert.notEqual(missingCap.status, 0);
  assert.match(missingCap.stderr, /WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE/);

  const capped = render([baseFile, logicalFile], '64MB');
  assert.equal(capped.status, 0, capped.stderr);
  assert.deepEqual(JSON.parse(capped.stdout).services.postgres.command, [
    'postgres',
    '-c',
    'wal_level=logical',
    '-c',
    'max_slot_wal_keep_size=64MB',
  ]);
});
