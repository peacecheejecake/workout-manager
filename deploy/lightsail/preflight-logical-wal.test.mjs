import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { preflight, validateLogicalWalCommand } from './preflight-logical-wal.mjs';

function command(cap) {
  return ['postgres', '-c', 'wal_level=logical', '-c', `max_slot_wal_keep_size=${cap}`];
}

test('rejects unbounded, zero, missing-unit, malformed and oversized WAL caps', () => {
  for (const cap of [
    '-1',
    '0',
    '0MB',
    '-1MB',
    '1',
    '1kB',
    'InfinityMB',
    '1e3MB',
    '1PB',
    '9007199254740992MB',
  ]) {
    assert.throws(() => validateLogicalWalCommand(command(cap)), /INVALID_LOGICAL_WAL_CAP/, cap);
  }
  assert.throws(
    () =>
      validateLogicalWalCommand([
        'postgres',
        '-c',
        'wal_level=replica',
        '-c',
        'max_slot_wal_keep_size=64MB',
      ]),
    /INVALID_LOGICAL_WAL_COMMAND/,
  );
  assert.throws(
    () => validateLogicalWalCommand([...command('64MB'), '-c', 'other=1']),
    /INVALID_LOGICAL_WAL_COMMAND/,
  );
  for (const cap of ['64MB', '1GB', '2TB']) {
    assert.doesNotThrow(() => validateLogicalWalCommand(command(cap)), cap);
  }
});

test('preflight validates the effective rendered Compose model without exposing the cap', (t) => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (docker.error?.code === 'ENOENT' || docker.status !== 0) {
    t.skip('Docker Compose CLI is unavailable');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'workout-logical-wal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envFile = join(directory, 'compose.env');
  const env = { ...process.env };
  delete env.WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE;
  const prefix =
    'WORKOUT_RELEASE=local-check\nWORKOUT_DATA_DIR=/tmp/workout-data\nWORKOUT_SECRETS_DIR=/tmp/workout-secrets\n';
  for (const cap of ['-1', '0', '0MB', '64MB']) {
    writeFileSync(envFile, `${prefix}WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE=${cap}\n`, { mode: 0o600 });
    if (cap === '64MB') assert.doesNotThrow(() => preflight(envFile, { env }));
    else assert.throws(() => preflight(envFile, { env }), /INVALID_LOGICAL_WAL_CAP/, cap);
    const cli = spawnSync(
      process.execPath,
      [new URL('./preflight-logical-wal.mjs', import.meta.url).pathname, envFile],
      {
        encoding: 'utf8',
        env,
      },
    );
    assert.equal(cli.status, cap === '64MB' ? 0 : 1);
    assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, new RegExp(cap.replace(/[-]/g, '\\-')));
  }
  env.WORKOUT_PG_MAX_SLOT_WAL_KEEP_SIZE = '-1';
  assert.throws(() => preflight(envFile, { env }), /INVALID_LOGICAL_WAL_CAP/);
});
