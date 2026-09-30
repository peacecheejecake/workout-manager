import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { withLocalExportedSlotSnapshot } from './slot-snapshot.mjs';

const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@14/bin';

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

test('requires an explicitly disposable local socket before connecting', async () => {
  await assert.rejects(
    withLocalExportedSlotSnapshot({
      connectionString: 'postgresql://someone@production.example/workout',
      socketDir: '/tmp',
      expectedDatabase: 'workout',
      expectedSystemIdentifier: '1',
      slotName: 'snapshot_proof',
      capture: async () => undefined,
      disposableTest: true,
    }),
    /LOCAL_SLOT_SNAPSHOT_PROOF_FAILED/,
  );
});

test(
  'real replication-exported snapshot pins a pg_dump across concurrent writes and dies with its connection',
  {
    skip: process.env.WORKOUT_SLOT_SNAPSHOT_REAL_PG !== '1',
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-slot-snapshot-'));
    const data = join(root, 'data');
    const archive = join(root, 'snapshot.dump');
    const log = join(root, 'postgres.log');
    let started = false;
    try {
      run(join(bin, 'initdb'), [
        '-D',
        data,
        '-U',
        'workout_admin',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ]);
      run(join(bin, 'pg_ctl'), [
        '-D',
        data,
        '-l',
        log,
        '-o',
        `-k ${root} -h '' -c wal_level=logical -c max_replication_slots=4 -c max_wal_senders=4`,
        '-w',
        'start',
      ]);
      started = true;
      const connectionString = `postgresql://workout_admin@localhost/postgres?host=${encodeURIComponent(root)}`;
      const sql = new pg.Client({ connectionString });
      await sql.connect();
      let expectedSystemIdentifier;
      try {
        expectedSystemIdentifier = (
          await sql.query('SELECT system_identifier::text FROM pg_control_system()')
        ).rows[0].system_identifier;
        await sql.query(
          'CREATE TABLE snapshot_probe (id integer PRIMARY KEY, label text NOT NULL)',
        );
        await sql.query(
          "CREATE PUBLICATION snapshot_probe_pub FOR TABLE snapshot_probe WITH (publish = 'insert,delete')",
        );
        await sql.query(
          "INSERT INTO snapshot_probe VALUES (1, 'before-delete'), (2, 'before-commit')",
        );
        const { snapshot, output } = await withLocalExportedSlotSnapshot({
          connectionString,
          socketDir: root,
          expectedDatabase: 'postgres',
          expectedSystemIdentifier,
          slotName: 'snapshot_proof',
          disposableTest: true,
          capture: async (contract) => {
            await sql.query('DELETE FROM snapshot_probe WHERE id = 1');
            await sql.query("INSERT INTO snapshot_probe VALUES (3, 'after-snapshot')");
            run(join(bin, 'pg_dump'), [
              '--format=custom',
              `--snapshot=${contract.snapshotName}`,
              '--file',
              archive,
              connectionString,
            ]);
            const changes = await sql.query(
              "SELECT data FROM pg_logical_slot_peek_binary_changes($1, NULL, 100, 'proto_version', '1', 'publication_names', 'snapshot_probe_pub')",
              ['snapshot_proof'],
            );
            const messageKinds = changes.rows.map(({ data }) => {
              assert.ok(Buffer.isBuffer(data));
              return String.fromCharCode(data[0]);
            });
            assert.equal(
              messageKinds.filter((kind) => kind === 'D').length,
              1,
              'the post-snapshot delete must be in the slot stream',
            );
            assert.equal(
              messageKinds.filter((kind) => kind === 'I').length,
              1,
              'the post-snapshot insert must be in the slot stream',
            );
            assert.equal(
              messageKinds.filter((kind) => kind === 'C').length,
              2,
              'both changes must be committed transactions',
            );
            return readFileSync(archive).length;
          },
        });
        assert.ok(output > 5);
        assert.equal(snapshot.postgresSystemIdentifier, expectedSystemIdentifier);
        assert.match(snapshot.consistentPointLsn, /^[0-9A-F]+\/[0-9A-F]+$/);
        const dumpSql = run(join(bin, 'pg_restore'), ['--data-only', '--file=-', archive]);
        assert.match(dumpSql, /before-delete/);
        assert.match(dumpSql, /before-commit/);
        assert.doesNotMatch(dumpSql, /after-snapshot/);
        const expired = spawnSync(
          join(bin, 'pg_dump'),
          [
            '--format=custom',
            `--snapshot=${snapshot.snapshotName}`,
            '--file',
            join(root, 'expired.dump'),
            connectionString,
          ],
          { encoding: 'utf8', timeout: 60_000 },
        );
        assert.notEqual(
          expired.status,
          0,
          'an exported snapshot must expire with its replication connection',
        );
        const slots = await sql.query(
          "SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'snapshot_proof'",
        );
        assert.equal(slots.rows.length, 0, 'the disposable slot must be dropped');
        await assert.rejects(
          withLocalExportedSlotSnapshot({
            connectionString,
            socketDir: root,
            expectedDatabase: 'postgres',
            expectedSystemIdentifier: '1',
            slotName: 'snapshot_proof',
            disposableTest: true,
            capture: async () => {
              throw new Error('unexpected capture');
            },
          }),
          /LOCAL_SLOT_SNAPSHOT_PROOF_FAILED/,
        );
        await assert.rejects(
          withLocalExportedSlotSnapshot({
            connectionString,
            socketDir: root,
            expectedDatabase: 'postgres',
            expectedSystemIdentifier,
            slotName: 'snapshot_proof',
            disposableTest: true,
            capture: async () => {
              throw new Error('synthetic dump failure');
            },
          }),
          /synthetic dump failure/,
        );
        const afterFailure = await sql.query(
          "SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'snapshot_proof'",
        );
        assert.equal(afterFailure.rows.length, 0, 'a failed capture must drop its disposable slot');
      } finally {
        await sql.end();
      }
    } finally {
      if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
