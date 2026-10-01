import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { withPersistentExportedSlotSnapshot } from './persistent-slot-snapshot.mjs';

const database = 'workout_pg17_proof';
const disposableMarker = 'WM_DISPOSABLE_PG17_PROOF';
const connectionString = process.env.WORKOUT_PERSISTENT_SLOT_PG17_URL;
const completionMarker = 'c'.repeat(64);
const pgDump = process.env.WORKOUT_PG17_DUMP_BIN ?? 'pg_dump';
const pgRestore =
  process.env.WORKOUT_PG17_RESTORE_BIN ??
  (isAbsolute(pgDump) ? join(dirname(pgDump), 'pg_restore') : 'pg_restore');

function runProgram(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`PG17_PROOF_DUMP_FAILED: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

function checkedConnectionString(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PG17_PROOF_UNSAFE_TARGET');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== `/${database}` ||
    url.search ||
    url.hash
  ) {
    throw new Error('PG17_PROOF_UNSAFE_TARGET');
  }
  return value;
}

async function connect(value) {
  const client = new pg.Client({ connectionString: value, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("SET statement_timeout = '10s'");
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

test(
  'PG17 replication EXPORT_SNAPSHOT keeps the pre-change view and a persistent pgoutput slot',
  { skip: !connectionString, timeout: 60_000 },
  async () => {
    const url = checkedConnectionString(connectionString);
    let sql = await connect(url);
    let imported;
    const archiveDir = mkdtempSync(join(tmpdir(), 'wm-pg17-archive-'));
    const archive = join(archiveDir, 'database.dump');
    const suffix = randomBytes(8).toString('hex');
    const table = `pg17_snapshot_probe_${suffix}`;
    const publication = `pg17_snapshot_pub_${suffix}`;
    const slot = `pg17_snapshot_slot_${suffix}`;
    let tableCreated = false;
    let publicationCreated = false;
    let failure;
    const cleanupErrors = [];
    try {
      const target = (
        await sql.query(`SELECT current_database() AS database,
          current_setting('server_version_num')::integer AS version,
          current_setting('wal_level') AS wal_level,
          system_identifier::text AS system_id,
          (SELECT shobj_description(oid, 'pg_database') FROM pg_database
            WHERE datname = current_database()) AS disposable_marker
          FROM pg_control_system()`)
      ).rows[0];
      assert.equal(target.database, database);
      assert.equal(target.disposable_marker, disposableMarker, 'PG17_PROOF_UNSAFE_TARGET');
      assert.equal(Math.floor(target.version / 10_000), 17, 'PG17_PROOF_WRONG_VERSION');
      assert.equal(target.wal_level, 'logical');
      assert.match(runProgram(pgDump, ['--version']), /pg_dump \(PostgreSQL\) 17\./);
      assert.match(runProgram(pgRestore, ['--version']), /pg_restore \(PostgreSQL\) 17\./);

      await sql.query(`CREATE TABLE public.${table} (id integer PRIMARY KEY, label text NOT NULL)`);
      tableCreated = true;
      await sql.query(`CREATE PUBLICATION ${publication} FOR TABLE public.${table}`);
      publicationCreated = true;
      await sql.query(`INSERT INTO public.${table} VALUES (1, 'before')`);
      await sql.end();
      sql = undefined;

      const result = await withPersistentExportedSlotSnapshot({
        connectionString: url,
        expectedDatabase: database,
        expectedSystemIdentifier: target.system_id,
        slotName: slot,
        expectedPublication: publication,
        expectedPublicationTables: [`public.${table}`],
        expectedCompletionMarker: completionMarker,
        capture: async (snapshot) => {
          const writer = await connect(url);
          try {
            const otherClients = await writer.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
            );
            assert.equal(otherClients.rows[0].n, 0, 'catalog connection must close for fence');
            await writer.query(`DELETE FROM public.${table} WHERE id = 1`);
            await writer.query(`INSERT INTO public.${table} VALUES (2, 'after')`);
          } finally {
            await writer.end();
          }

          runProgram(pgDump, [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--snapshot=${snapshot.snapshotName}`,
            '--file',
            archive,
            url,
          ]);
          assert.equal(readFileSync(archive).subarray(0, 5).toString(), 'PGDMP');
          const contents = runProgram(pgRestore, [
            '--data-only',
            `--table=${table}`,
            '--file=-',
            archive,
          ]);
          assert.match(contents, /before/);
          assert.doesNotMatch(contents, /after/);

          imported = await connect(url);
          await imported.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          await imported.query(`SET TRANSACTION SNAPSHOT '${snapshot.snapshotName}'`);
          assert.deepEqual(
            (await imported.query(`SELECT id, label FROM public.${table} ORDER BY id`)).rows,
            [{ id: 1, label: 'before' }],
          );
          const observer = await connect(url);
          let changes;
          try {
            assert.deepEqual(
              (await observer.query(`SELECT id, label FROM public.${table} ORDER BY id`)).rows,
              [{ id: 2, label: 'after' }],
            );
            changes = await observer.query(
              `SELECT data FROM pg_logical_slot_peek_binary_changes($1, NULL, 100,
                'proto_version', '1', 'publication_names', $2)`,
              [slot, publication],
            );
          } finally {
            await observer.end();
          }
          const kinds = changes.rows.map(({ data }) => String.fromCharCode(data[0]));
          assert.equal(kinds.filter((kind) => kind === 'D').length, 1);
          assert.equal(kinds.filter((kind) => kind === 'I').length, 1);
          await imported.query('ROLLBACK');
          await imported.end();
          imported = undefined;
          return { completionMarker, output: 'snapshot-and-wal-observed' };
        },
      });
      sql = await connect(url);

      assert.equal(result.snapshot.replicationSlot, slot);
      assert.equal(result.output, 'snapshot-and-wal-observed');
      assert.ok(readFileSync(archive).length > 5);
      const retained = (
        await sql.query(
          `SELECT plugin, slot_type, database, temporary, active
           FROM pg_replication_slots WHERE slot_name = $1`,
          [slot],
        )
      ).rows;
      assert.deepEqual(retained, [
        {
          plugin: 'pgoutput',
          slot_type: 'logical',
          database,
          temporary: false,
          active: false,
        },
      ]);

      imported = await connect(url);
      await imported.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assert.rejects(
        imported.query(`SET TRANSACTION SNAPSHOT '${result.snapshot.snapshotName}'`),
        /invalid snapshot identifier|snapshot .* does not exist/i,
      );
      await imported.query('ROLLBACK');
    } catch (error) {
      failure = error;
    } finally {
      if (imported) {
        await imported.query('ROLLBACK').catch(() => {});
        await imported.end().catch((error) => cleanupErrors.push(error));
      }
      try {
        if (!sql) sql = await connect(url);
        const state = await sql.query(
          'SELECT active FROM pg_replication_slots WHERE slot_name = $1',
          [slot],
        );
        if (state.rows.length === 1) {
          assert.equal(state.rows[0].active, false, 'PG17_PROOF_SLOT_CLEANUP_UNSAFE');
          await sql.query('SELECT pg_drop_replication_slot($1)', [slot]);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (sql && publicationCreated)
        await sql
          .query(`DROP PUBLICATION ${publication}`)
          .catch((error) => cleanupErrors.push(error));
      if (sql && tableCreated)
        await sql.query(`DROP TABLE public.${table}`).catch((error) => cleanupErrors.push(error));
      if (sql) await sql.end().catch((error) => cleanupErrors.push(error));
      rmSync(archiveDir, { recursive: true, force: true });
    }
    if (failure && cleanupErrors.length)
      throw new AggregateError([failure, ...cleanupErrors], 'PG17_PROOF_AND_CLEANUP_FAILED');
    if (failure) throw failure;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'PG17_PROOF_CLEANUP_FAILED');
  },
);
