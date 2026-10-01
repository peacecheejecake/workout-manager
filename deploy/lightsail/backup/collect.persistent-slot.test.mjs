import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertSyntheticPersistentTarget } from './synthetic-persistent-guard.mjs';
import { finalizePersistentBundle } from './collect.mjs';

const collector = new URL('./collect.mjs', import.meta.url).pathname;

test('persistent finalization waits for the exact durable retained ownership receipt', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-persistent-receipt-')));
  const bundle = join(root, 'backup-fixture');
  const receiptPath = join(root, '.persistent-slot-fixture.json');
  const retained = {
    schemaVersion: 1,
    syntheticOnly: true,
    restoreAccessAllowed: false,
    slotCreationProven: true,
    state: 'retained-owner-cleanup-required',
    bundleId: 'backup-fixture',
    snapshot: { consistentPointLsn: '0/16B6C50' },
  };
  try {
    mkdirSync(bundle, { mode: 0o700 });
    writeFileSync(join(bundle, 'manifest.json'), '{}\n', { mode: 0o600 });
    assert.throws(() => finalizePersistentBundle(bundle, receiptPath, retained));
    assert.equal(existsSync(join(bundle, 'finalization.json')), false);
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...retained, state: 'reserved-investigate-before-retry' })}\n`,
      { mode: 0o600 },
    );
    assert.throws(() => finalizePersistentBundle(bundle, receiptPath, retained));
    assert.equal(existsSync(join(bundle, 'finalization.json')), false);
    writeFileSync(receiptPath, `${JSON.stringify(retained)}\n`, { mode: 0o600 });
    finalizePersistentBundle(bundle, receiptPath, retained);
    assert.equal(existsSync(join(bundle, 'finalization.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent synthetic capture rejects incomplete or mixed opt-ins before touching the database', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-persistent-guard-')));
  try {
    const privateDir = join(root, 'private');
    const outputDir = join(root, 'output');
    for (const dir of [privateDir, outputDir]) mkdirSync(dir, { mode: 0o700 });
    const databaseUrl = join(root, 'database-url');
    const fence = join(root, 'fence');
    writeFileSync(databaseUrl, 'postgresql://synthetic:synthetic@127.0.0.1:1/workout_pg17_proof', {
      mode: 0o600,
    });
    writeFileSync(fence, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const base = [
      'collect',
      '--database-url-file',
      databaseUrl,
      '--private-dir',
      privateDir,
      '--output-dir',
      outputDir,
      '--fence-check',
      fence,
      '--synthetic-persistent-slot-proof',
      'yes',
      '--persistent-expected-system-identifier',
      '1',
      '--persistent-publication-tables',
      'public.fixture',
      '--persistent-publication-operations',
      'insert',
      '--persistent-slot-owner',
      'fixture-owner',
      '--replication-slot',
      'fixture_slot',
      '--publication',
      'fixture_pub',
    ];
    const invoke = (args) =>
      spawnSync(process.execPath, [collector, ...args], { encoding: 'utf8', timeout: 10_000 });
    for (const extra of [
      [],
      ['--synthetic-test', 'no'],
      ['--synthetic-test', 'yes', '--snapshot-name', '00000003-0000001B-1'],
      ['--synthetic-test', 'yes', '--local-exported-slot-proof', 'yes'],
    ]) {
      const result = invoke([...base, ...extra]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /BACKUP_PERSISTENT_SLOT_PROOF_INACTIVE/);
      assert.deepEqual(readdirSync(outputDir), []);
    }
    const missingOwner = [...base];
    missingOwner.splice(missingOwner.indexOf('--persistent-slot-owner'), 2);
    assert.match(
      invoke([...missingOwner, '--synthetic-test', 'yes']).stderr,
      /BACKUP_PERSISTENT_SLOT_PROOF_INACTIVE/,
    );
    const unsafe = base.map((value) => (value === 'fixture-owner' ? '../unsafe' : value));
    assert.match(
      invoke([...unsafe, '--synthetic-test', 'yes']).stderr,
      /BACKUP_PERSISTENT_SLOT_PROOF_INACTIVE/,
    );
    for (let index = 0; index < 17; index += 1)
      writeFileSync(join(privateDir, `fixture-${index}`), 'synthetic');
    assert.match(
      invoke([...base, '--synthetic-test', 'yes']).stderr,
      /BACKUP_PERSISTENT_CAPTURE_LIMIT/,
    );
    for (let index = 0; index < 17; index += 1) rmSync(join(privateDir, `fixture-${index}`));
    writeFileSync(
      databaseUrl,
      'postgresql://synthetic:synthetic@remote.example/workout_pg17_proof',
      { mode: 0o600 },
    );
    assert.match(
      invoke([...base, '--synthetic-test', 'yes']).stderr,
      /BACKUP_PERSISTENT_SYNTHETIC_TARGET_REQUIRED/,
    );
    assert.deepEqual(readdirSync(outputDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('target guard refuses remote hosts, query overrides, missing credentials and non-disposable database names', async () => {
  for (const url of [
    'invalid',
    'postgresql://u:p@remote.example/workout_pg17_proof',
    'postgresql://u:p@127.0.0.1/workout',
    'postgresql://u:p@127.0.0.1/workout_pg17_proof?host=remote.example',
    'postgresql://u@127.0.0.1/workout_pg17_proof',
    'postgresql://u:p@127.0.0.1/workout_pg17_proof#fragment',
  ]) {
    await assert.rejects(
      assertSyntheticPersistentTarget(url, '1'),
      /BACKUP_PERSISTENT_SYNTHETIC_TARGET_REQUIRED/,
    );
  }
});
