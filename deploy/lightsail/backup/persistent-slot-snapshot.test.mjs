import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { withPersistentExportedSlotSnapshot } from './persistent-slot-snapshot.mjs';

const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@14/bin';
const marker = 'a'.repeat(64);

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

test('rejects invalid inputs before connecting', async () => {
  await assert.rejects(
    withPersistentExportedSlotSnapshot({
      connectionString: 'postgresql://localhost/postgres',
      expectedDatabase: 'postgres',
      expectedSystemIdentifier: '1',
      slotName: 'unsafe;DROP',
      expectedCompletionMarker: marker,
      capture: async () => ({ completionMarker: marker }),
    }),
    /PERSISTENT_SLOT_SNAPSHOT_FAILED/,
  );
});

test(
  'real PG14 replication snapshot remains valid during callback and successful slot persists',
  {
    skip: process.env.WORKOUT_PERSISTENT_SLOT_REAL_PG !== '1',
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-persistent-slot-'));
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
      try {
        const expectedSystemIdentifier = (
          await sql.query('SELECT system_identifier::text FROM pg_control_system()')
        ).rows[0].system_identifier;
        const base = {
          connectionString,
          expectedDatabase: 'postgres',
          expectedSystemIdentifier,
          expectedCompletionMarker: marker,
        };
        await sql.query(
          'CREATE TABLE snapshot_probe (id integer PRIMARY KEY, label text NOT NULL)',
        );
        await sql.query(
          "CREATE PUBLICATION snapshot_probe_pub FOR TABLE snapshot_probe WITH (publish = 'insert,delete')",
        );
        await sql.query("INSERT INTO snapshot_probe VALUES (1, 'before-delete')");
        const { snapshot, output } = await withPersistentExportedSlotSnapshot({
          ...base,
          slotName: 'persistent_probe',
          capture: async (contract) => {
            await sql.query('DELETE FROM snapshot_probe WHERE id = 1');
            await sql.query("INSERT INTO snapshot_probe VALUES (2, 'after-snapshot')");
            run(join(bin, 'pg_dump'), [
              '--format=custom',
              `--snapshot=${contract.snapshotName}`,
              '--file',
              archive,
              connectionString,
            ]);
            const changes = await sql.query(
              "SELECT data FROM pg_logical_slot_peek_binary_changes($1, NULL, 100, 'proto_version', '1', 'publication_names', 'snapshot_probe_pub')",
              ['persistent_probe'],
            );
            const kinds = changes.rows.map(({ data: bytes }) => String.fromCharCode(bytes[0]));
            assert.equal(kinds.filter((kind) => kind === 'D').length, 1);
            assert.equal(kinds.filter((kind) => kind === 'I').length, 1);
            return { completionMarker: marker, output: readFileSync(archive).length };
          },
        });
        assert.ok(output > 5);
        assert.equal(snapshot.postgresSystemIdentifier, expectedSystemIdentifier);
        const dump = run(join(bin, 'pg_restore'), ['--data-only', '--file=-', archive]);
        assert.match(dump, /before-delete/);
        assert.doesNotMatch(dump, /after-snapshot/);
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
        assert.notEqual(expired.status, 0);
        const retained = await sql.query(
          "SELECT slot_name, plugin, temporary, active FROM pg_replication_slots WHERE slot_name = 'persistent_probe'",
        );
        assert.deepEqual(retained.rows, [
          { slot_name: 'persistent_probe', plugin: 'pgoutput', temporary: false, active: false },
        ]);
        await assert.rejects(
          withPersistentExportedSlotSnapshot({
            ...base,
            slotName: 'persistent_probe',
            capture: async () => {
              throw new Error('must not capture');
            },
          }),
          /PERSISTENT_SLOT_ALREADY_EXISTS/,
        );
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = 'persistent_probe'",
            )
          ).rows[0].n,
          1,
        );

        await assert.rejects(
          withPersistentExportedSlotSnapshot({
            ...base,
            slotName: 'failed_probe',
            capture: async () => {
              throw new Error('dump failed');
            },
          }),
          /dump failed/,
        );
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = 'failed_probe'",
            )
          ).rows[0].n,
          0,
        );
        await assert.rejects(
          withPersistentExportedSlotSnapshot({
            ...base,
            slotName: 'proof_probe',
            capture: async () => ({ completionMarker: 'b'.repeat(64) }),
          }),
          /PERSISTENT_SLOT_CAPTURE_PROOF_FAILED/,
        );
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = 'proof_probe'",
            )
          ).rows[0].n,
          0,
        );
        await assert.rejects(
          withPersistentExportedSlotSnapshot({
            ...base,
            expectedSystemIdentifier: '1',
            slotName: 'identity_probe',
            capture: async () => ({ completionMarker: marker }),
          }),
          /PERSISTENT_SLOT_SNAPSHOT_FAILED/,
        );
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = 'identity_probe'",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await sql.end();
      }
    } finally {
      if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
