import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const pgBin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@14/bin';
const collector = new URL('./collect.mjs', import.meta.url).pathname;

function checked(program, args, env = process.env) {
  const result = spawnSync(program, args, { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${program}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

test(
  'collector v2 dump uses its own disposable replication slot exported snapshot and drops the slot',
  { skip: process.env.WORKOUT_COLLECT_SLOT_REAL_PG !== '1' },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-collect-slot-')));
    const cluster = join(root, 'cluster');
    const socket = join(root, 'socket');
    const bin = join(root, 'bin');
    const privateDir = join(root, 'private');
    const output = join(root, 'output');
    const ledger = join(root, 'ledger');
    const dbFile = join(root, 'database-url');
    const fence = join(root, 'fence.sh');
    const stream = join(root, 'stream.txt');
    let started = false;
    try {
      for (const dir of [socket, bin, privateDir, output, ledger]) mkdirSync(dir, { mode: 0o700 });
      checked(join(pgBin, 'initdb'), [
        '-D',
        cluster,
        '-U',
        'workout_admin',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ]);
      checked(join(pgBin, 'pg_ctl'), [
        '-D',
        cluster,
        '-l',
        join(root, 'postgres.log'),
        '-o',
        `-k ${socket} -h '' -c wal_level=logical -c max_replication_slots=4 -c max_wal_senders=4`,
        '-w',
        'start',
      ]);
      started = true;
      const env = {
        ...process.env,
        PGHOST: socket,
        PGUSER: 'workout_admin',
        PGDATABASE: 'postgres',
        PATH: `${bin}:${pgBin}:${process.env.PATH}`,
      };
      checked(
        join(pgBin, 'psql'),
        [
          '-X',
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          "CREATE TABLE snapshot_probe (id integer PRIMARY KEY, label text NOT NULL); CREATE PUBLICATION snapshot_probe_pub FOR TABLE snapshot_probe WITH (publish = 'insert,delete'); INSERT INTO snapshot_probe VALUES (1, 'before-delete'), (2, 'before-commit');",
        ],
        env,
      );
      const systemIdentifier = checked(
        join(pgBin, 'psql'),
        ['-X', '-At', '-c', 'SELECT system_identifier::text FROM pg_control_system()'],
        env,
      ).trim();
      const url = new URL('postgresql://workout_admin:synthetic@localhost/postgres');
      url.searchParams.set('host', socket);
      writeFileSync(dbFile, `${url}\n`, { mode: 0o600 });
      writeFileSync(fence, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(join(privateDir, 'fixture.bin'), 'synthetic-only');
      writeFileSync(
        join(bin, 'pg_dump'),
        `#!/bin/sh
set -eu
if [ "\${WM_FAIL_CAPTURE:-}" = 1 ]; then exit 8; fi
"${join(pgBin, 'psql')}" -X -v ON_ERROR_STOP=1 -c "DELETE FROM snapshot_probe WHERE id = 1" >/dev/null
"${join(pgBin, 'psql')}" -X -v ON_ERROR_STOP=1 -c "INSERT INTO snapshot_probe VALUES (3, 'after-snapshot')" >/dev/null
"${join(pgBin, 'psql')}" -X -At -v ON_ERROR_STOP=1 -c "SELECT chr(get_byte(data,0)) FROM pg_logical_slot_peek_binary_changes('snapshot_proof', NULL, 100, 'proto_version', '1', 'publication_names', 'snapshot_probe_pub')" > "${stream}"
exec "${join(pgBin, 'pg_dump')}" "$@"
`,
        { mode: 0o700 },
      );
      const args = [
        'collect',
        '--database-url-file',
        dbFile,
        '--private-dir',
        privateDir,
        '--output-dir',
        output,
        '--fence-check',
        fence,
        '--local-exported-slot-proof',
        'yes',
        '--local-expected-system-identifier',
        systemIdentifier,
        '--replication-slot',
        'snapshot_proof',
        '--publication',
        'snapshot_probe_pub',
        '--synthetic-test',
        'yes',
      ];
      function invoke(extraArgs = [], extraEnv = {}) {
        return spawnSync(process.execPath, [collector, ...args, ...extraArgs], {
          env: { ...env, ...extraEnv },
          encoding: 'utf8',
          timeout: 120_000,
        });
      }
      const captured = invoke();
      assert.equal(captured.status, 0, captured.stderr);
      assert.match(captured.stdout, /^BACKUP_PUBLISHED backup-/);
      const bundle = join(output, readdirSync(output)[0]);
      const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(
        manifest.consistency,
        'replication-slot-exported-snapshot-disposable-local-proof-only',
      );
      assert.equal(manifest.snapshot.postgresSystemIdentifier, systemIdentifier);
      assert.equal(manifest.snapshot.replicationSlot, 'snapshot_proof');
      assert.equal(manifest.snapshot.publication, 'snapshot_probe_pub');
      assert.match(manifest.snapshot.consistentPointLsn, /^[0-9A-F]+\/[0-9A-F]+$/);
      const verification = spawnSync(
        process.execPath,
        [
          collector,
          'verify',
          '--bundle',
          bundle,
          '--post-backup-ledger-dir',
          ledger,
          '--synthetic-test',
          'yes',
        ],
        { env, encoding: 'utf8', timeout: 60_000 },
      );
      assert.match(verification.stderr, /BACKUP_SNAPSHOT_V2_RESTORE_NOT_READY/);
      const dump = join(bundle, 'database.dump');
      const dataSql = checked(join(pgBin, 'pg_restore'), ['--data-only', '--file=-', dump], env);
      assert.match(dataSql, /before-delete/);
      assert.match(dataSql, /before-commit/);
      assert.doesNotMatch(dataSql, /after-snapshot/);
      const kinds = readFileSync(stream, 'utf8').trim().split('\n');
      assert.equal(kinds.filter((kind) => kind === 'D').length, 1);
      assert.equal(kinds.filter((kind) => kind === 'I').length, 1);
      assert.equal(kinds.filter((kind) => kind === 'C').length, 2);
      const expired = spawnSync(
        join(pgBin, 'pg_dump'),
        [
          `--snapshot=${manifest.snapshot.snapshotName}`,
          '--format=custom',
          '--file',
          join(root, 'expired.dump'),
          'postgres',
        ],
        { env, encoding: 'utf8', timeout: 60_000 },
      );
      assert.notEqual(
        expired.status,
        0,
        'snapshot must expire after the collector closes the slot connection',
      );
      function slots() {
        return checked(
          join(pgBin, 'psql'),
          [
            '-X',
            '-At',
            '-c',
            "SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'snapshot_proof'",
          ],
          env,
        ).trim();
      }
      assert.equal(slots(), '');
      const mismatched = [...args];
      mismatched[mismatched.indexOf('--local-expected-system-identifier') + 1] = '1';
      const wrongCluster = spawnSync(process.execPath, [collector, ...mismatched], {
        env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.notEqual(wrongCluster.status, 0);
      assert.equal(slots(), '');
      const mismatchedPublication = [...args];
      mismatchedPublication[mismatchedPublication.indexOf('--publication') + 1] =
        'missing_publication';
      const wrongPublication = spawnSync(process.execPath, [collector, ...mismatchedPublication], {
        env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.match(wrongPublication.stderr, /BACKUP_LOCAL_PUBLICATION_MISSING/);
      assert.equal(slots(), '');
      const missingMode = [...args];
      missingMode.splice(missingMode.indexOf('--local-exported-slot-proof'), 2);
      const incomplete = spawnSync(process.execPath, [collector, ...missingMode], {
        env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.match(incomplete.stderr, /BACKUP_LOCAL_SLOT_PROOF_INACTIVE/);
      assert.equal(slots(), '');
      const invented = invoke(['--snapshot-name', '00000003-0000001B-1']);
      assert.match(invented.stderr, /BACKUP_LOCAL_SLOT_PROOF_INACTIVE/);
      assert.equal(slots(), '');
      const failedCapture = invoke([], { WM_FAIL_CAPTURE: '1' });
      assert.match(failedCapture.stderr, /BACKUP_SUBPROCESS_FAILED/);
      assert.equal(slots(), '');
      assert.deepEqual(
        readdirSync(output),
        [bundle.split('/').at(-1)],
        'failures leave no partial bundle',
      );
    } finally {
      if (started) checked(join(pgBin, 'pg_ctl'), ['-D', cluster, '-m', 'immediate', '-w', 'stop']);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
