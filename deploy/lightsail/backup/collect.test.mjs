import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const collector = new URL('./collect.mjs', import.meta.url).pathname;

function invoke(args, path) {
  return spawnSync(process.execPath, [collector, ...args, '--synthetic-test', 'yes'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PATH: `${path}:${process.env.PATH}` },
  });
}

function hash(path) {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

test('collects a fenced synthetic PostgreSQL-command and private bundle; rejects incomplete inputs', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-backup-test-')));
  const bin = join(root, 'bin');
  const privateDir = join(root, 'private');
  const output = join(root, 'output');
  const ledger = join(root, 'ledger');
  const dbFile = join(root, 'database-url');
  const fence = join(root, 'check-fence.sh');
  try {
    for (const dir of [bin, privateDir, output, ledger]) mkdirSync(dir, { mode: 0o700 });
    writeFileSync(
      join(bin, 'pg_dump'),
      '#!/bin/sh\nwhile [ "$1" != "-f" ]; do shift; done\nshift\nprintf "synthetic-archive\\n" > "$1"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, 'pg_restore'),
      '#!/bin/sh\n[ "$1" = "--list" ] || exit 1\n[ "$(cat "$2")" = "synthetic-archive" ]\n',
      { mode: 0o700 },
    );
    writeFileSync(dbFile, 'postgresql://fixture:fixture@localhost:5432/workout_backup_fixture\n', {
      mode: 0o600,
    });
    writeFileSync(fence, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    mkdirSync(join(privateDir, 'private', 'v1'), { recursive: true, mode: 0o700 });
    const source = join(privateDir, 'private', 'v1', 'fixture.bin');
    writeFileSync(source, Buffer.from([0, 1, 2, 3, 255]));
    const collectArgs = [
      'collect',
      '--database-url-file',
      dbFile,
      '--private-dir',
      privateDir,
      '--output-dir',
      output,
      '--fence-check',
      fence,
    ];
    const collected = invoke(collectArgs, bin);
    assert.equal(collected.status, 0, collected.stderr);
    assert.match(collected.stdout, /^BACKUP_PUBLISHED backup-/);
    const bundle = join(output, readdirSync(output)[0]);
    assert.equal(statSync(bundle).mode & 0o777, 0o700);
    assert.equal(statSync(join(bundle, 'database.dump')).mode & 0o777, 0o600);
    assert.equal(statSync(join(bundle, 'manifest.json')).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.privateFiles[0], { path: 'private/v1/fixture.bin', ...hash(source) });
    assert.equal(manifest.independentPostBackupErasureLedgerRequired, true);
    const verifyArgs = ['verify', '--bundle', bundle, '--post-backup-ledger-dir', ledger];
    assert.match(invoke(verifyArgs, bin).stderr, /BACKUP_LEDGER_REQUIRED/);
    const ledgerFile = join(ledger, 'independent-deletions.json');
    writeFileSync(ledgerFile, '{"synthetic":true}\n', { mode: 0o600 });
    writeFileSync(
      join(ledger, 'ledger-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        source: 'independent-post-backup-deletion-ledger',
        backupCapturedAt: manifest.capturedAt,
        replayThrough: new Date(Date.parse(manifest.capturedAt) + 1000).toISOString(),
        files: [{ path: 'independent-deletions.json', ...hash(ledgerFile) }],
      }),
      { mode: 0o600 },
    );
    const verified = invoke(verifyArgs, bin);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /REPLAY_NOT_VERIFIED/);
    writeFileSync(ledgerFile, 'tampered');
    assert.match(invoke(verifyArgs, bin).stderr, /BACKUP_LEDGER_MISMATCH/);
    writeFileSync(ledgerFile, '{"synthetic":true}\n');
    writeFileSync(join(bundle, 'private', 'private', 'v1', 'fixture.bin'), 'corrupt');
    assert.match(invoke(verifyArgs, bin).stderr, /BACKUP_PRIVATE_MISMATCH/);

    const before = readdirSync(output).length;
    const disk = invoke([...collectArgs, '--min-free-bytes', String(Number.MAX_SAFE_INTEGER)], bin);
    assert.match(disk.stderr, /BACKUP_DISK_LOW/);
    assert.equal(readdirSync(output).length, before);
    writeFileSync(fence, '#!/bin/sh\nexit 1\n');
    chmodSync(fence, 0o700);
    assert.match(invoke(collectArgs, bin).stderr, /BACKUP_SUBPROCESS_FAILED/);
    assert.equal(readdirSync(output).length, before);
    symlinkSync(source, join(privateDir, 'private', 'v1', 'bad-link'));
    assert.match(invoke(collectArgs, bin).stderr, /BACKUP_UNSAFE_PRIVATE_ENTRY/);
    assert.equal(readdirSync(output).length, before);
    rmSync(join(privateDir, 'private', 'v1', 'bad-link'));
    writeFileSync(fence, '#!/bin/sh\nexit 0\n');
    writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\nexit 4\n');
    assert.match(invoke(collectArgs, bin).stderr, /BACKUP_SUBPROCESS_FAILED/);
    assert.equal(readdirSync(output).length, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses an opt-in archive transport and rejects ambiguous database sources', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-backup-transport-test-')));
  const privateDir = join(root, 'private');
  const output = join(root, 'output');
  const transport = join(root, 'transport.sh');
  const fence = join(root, 'fence.sh');
  const dbFile = join(root, 'database-url');
  try {
    mkdirSync(privateDir, { mode: 0o700 });
    mkdirSync(output, { mode: 0o700 });
    writeFileSync(fence, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(dbFile, 'postgresql://fixture:fixture@localhost/workout\n', { mode: 0o600 });
    writeFileSync(
      transport,
      '#!/bin/sh\n[ "$1" = "--output" ] || exit 1\nprintf "PGDMPsynthetic-validated-archive" > "$2"\nchmod 600 "$2"\n',
      { mode: 0o700 },
    );
    const shared = [
      'collect',
      '--private-dir',
      privateDir,
      '--output-dir',
      output,
      '--fence-check',
      fence,
    ];
    assert.match(invoke(shared, '').stderr, /BACKUP_DATABASE_SOURCE_REQUIRED/);
    assert.match(
      invoke([...shared, '--database-url-file', dbFile, '--database-transport', transport], '')
        .stderr,
      /BACKUP_DATABASE_SOURCE_REQUIRED/,
    );
    const collected = invoke([...shared, '--database-transport', transport], '');
    assert.equal(collected.status, 0, collected.stderr);
    const bundle = join(output, readdirSync(output)[0]);
    assert.equal(
      readFileSync(join(bundle, 'database.dump'), 'utf8'),
      'PGDMPsynthetic-validated-archive',
    );
    assert.equal(statSync(join(bundle, 'database.dump')).mode & 0o777, 0o600);
    writeFileSync(transport, '#!/bin/sh\nexit 0\n');
    assert.match(
      invoke([...shared, '--database-transport', transport], '').stderr,
      /BACKUP_TRANSPORT_OUTPUT_MISSING/,
    );
    assert.equal(readdirSync(output).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'collects and checks an actual disposable PostgreSQL archive',
  {
    skip:
      process.env.WORKOUT_BACKUP_REAL_PG !== '1' &&
      'Set WORKOUT_BACKUP_REAL_PG=1 for opt-in database test',
  },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-backup-pg-')));
    const cluster = join(root, 'cluster');
    const socket = join(root, 'socket');
    const privateDir = join(root, 'private');
    const output = join(root, 'output');
    const ledger = join(root, 'ledger');
    const dbFile = join(root, 'database-url');
    const fence = join(root, 'check-fence.sh');
    const port = 40000 + Math.floor(Math.random() * 10000);
    const user = process.env.USER;
    let started = false;
    function checked(command, args, env = process.env) {
      const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      return result.stdout;
    }
    try {
      assert.ok(user);
      for (const dir of [socket, privateDir, output, ledger]) mkdirSync(dir, { mode: 0o700 });
      checked('initdb', ['-D', cluster, '--auth=trust', '--no-instructions']);
      checked('pg_ctl', [
        '-D',
        cluster,
        '-l',
        join(root, 'postgres.log'),
        '-o',
        `-h '' -k ${socket} -p ${port}`,
        '-w',
        'start',
      ]);
      started = true;
      const pgEnv = { ...process.env, PGHOST: socket, PGPORT: String(port), PGUSER: user };
      checked('createdb', ['workout_backup_fixture'], pgEnv);
      checked(
        'psql',
        [
          '-d',
          'workout_backup_fixture',
          '-c',
          "CREATE TABLE fixture(id integer PRIMARY KEY, value text); INSERT INTO fixture VALUES (1, 'synthetic-only');",
        ],
        pgEnv,
      );
      const url = new URL(
        `postgresql://${encodeURIComponent(user)}:synthetic@localhost:${port}/workout_backup_fixture`,
      );
      url.searchParams.set('host', socket);
      writeFileSync(dbFile, `${url}\n`, { mode: 0o600 });
      writeFileSync(fence, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(join(privateDir, 'synthetic.bin'), Buffer.from([17, 0, 255]));
      const collected = invoke(
        [
          'collect',
          '--database-url-file',
          dbFile,
          '--private-dir',
          privateDir,
          '--output-dir',
          output,
          '--fence-check',
          fence,
        ],
        '',
      );
      assert.equal(collected.status, 0, collected.stderr);
      const bundle = join(output, readdirSync(output)[0]);
      const dump = join(bundle, 'database.dump');
      assert.match(checked('pg_restore', ['--list', dump]), /TABLE DATA public fixture/);
      for (const args of [['--list'], ['--file=/dev/null']]) {
        const fd = openSync(dump, 'r');
        try {
          const streamed = spawnSync('pg_restore', args, {
            stdio: [fd, 'pipe', 'pipe'],
            encoding: 'utf8',
            timeout: 120_000,
          });
          assert.equal(streamed.status, 0, streamed.stderr);
          if (args[0] === '--list') assert.match(streamed.stdout, /TABLE DATA public fixture/);
        } finally {
          closeSync(fd);
        }
      }
      assert.equal(
        readFileSync(join(bundle, 'private', 'synthetic.bin')).equals(Buffer.from([17, 0, 255])),
        true,
      );
      const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
      assert.match(
        invoke(['verify', '--bundle', bundle, '--post-backup-ledger-dir', ledger], '').stderr,
        /BACKUP_LEDGER_REQUIRED/,
      );
      const ledgerFile = join(ledger, 'independent-deletions.json');
      writeFileSync(ledgerFile, '{"synthetic":true}\n', { mode: 0o600 });
      writeFileSync(
        join(ledger, 'ledger-manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          source: 'independent-post-backup-deletion-ledger',
          backupCapturedAt: manifest.capturedAt,
          replayThrough: new Date(Date.parse(manifest.capturedAt) + 1000).toISOString(),
          files: [{ path: 'independent-deletions.json', ...hash(ledgerFile) }],
        }),
        { mode: 0o600 },
      );
      assert.equal(
        invoke(['verify', '--bundle', bundle, '--post-backup-ledger-dir', ledger], '').status,
        0,
      );
      writeFileSync(dump, 'not-a-postgres-archive');
      assert.match(
        invoke(['verify', '--bundle', bundle, '--post-backup-ledger-dir', ledger], '').stderr,
        /BACKUP_DATABASE_MISMATCH/,
      );
    } finally {
      if (started)
        spawnSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
