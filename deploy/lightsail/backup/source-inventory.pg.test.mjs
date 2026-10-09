import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { migrate, migrationFileNames } from '../../../packages/server/persistence/src/migrate.ts';
import { buildSourceInventory } from './source-inventory.mjs';

const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@14/bin';

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0)
    throw new Error(`${program} failed: ${result.error?.message ?? result.stderr}`);
}

test(
  'actual 001–093 migration catalog, imported snapshot isolation, changed schema and runtime denial',
  { skip: process.env.WORKOUT_SOURCE_INVENTORY_REAL_PG !== '1' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-source-inventory-'));
    const data = join(root, 'data');
    let started = false;
    const clients = [];
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
        join(root, 'postgres.log'),
        '-o',
        `-k ${root} -h ''`,
        '-w',
        'start',
      ]);
      started = true;
      const url = (role) =>
        `postgresql://${role}@localhost/postgres?host=${encodeURIComponent(root)}`;
      async function connect(role) {
        const client = new pg.Client({ connectionString: url(role) });
        await client.connect();
        clients.push(client);
        return client;
      }
      const admin = await connect('workout_admin');
      await admin.query('CREATE ROLE source_owner LOGIN NOSUPERUSER NOBYPASSRLS');
      await admin.query('CREATE ROLE source_runtime LOGIN NOSUPERUSER NOBYPASSRLS');
      await admin.query('GRANT CREATE ON DATABASE postgres TO source_owner');
      await admin.query('GRANT CREATE ON SCHEMA public TO source_owner');
      await migrate(url('source_owner'), 93);
      // Match bootstrap-db: the migration role owns both the database and public.
      await admin.query('ALTER DATABASE postgres OWNER TO source_owner');
      await admin.query('ALTER SCHEMA public OWNER TO source_owner');
      const owner = await connect('source_owner');
      const holder = await connect('source_owner');
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshotName = (await holder.query('SELECT pg_export_snapshot() AS name')).rows[0].name;
      const snapshotId = (await holder.query('SELECT txid_current_snapshot()::text AS id')).rows[0]
        .id;
      const imported = await connect('source_owner');
      await imported.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await imported.query(`SET TRANSACTION SNAPSHOT '${snapshotName}'`);
      const first = await buildSourceInventory({
        client: imported,
        expectedSnapshotId: snapshotId,
      });
      assert.equal(first.complete, false);
      assert.equal(first.namespaceCount, 3);
      assert.equal(first.relationCount, 501);
      assert.equal(first.columnCount, 2147);
      assert.equal(first.migrationCount, 93);
      assert.deepEqual(first.classifications, { rowHmac: 16, summaryOnly: 5, uncovered: 480 });
      assert.equal(first.largeObjectCount, 0);
      assert.ok(first.uncoveredKinds.index > 0);
      assert.ok(!JSON.stringify(first).includes('source_owner'));
      await owner.query('CREATE SCHEMA newly_added');
      const sameSnapshot = await buildSourceInventory({
        client: imported,
        expectedSnapshotId: snapshotId,
      });
      assert.deepEqual(sameSnapshot, first);
      await imported.query('ROLLBACK');
      await holder.query('ROLLBACK');
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const changedId = (await owner.query('SELECT txid_current_snapshot()::text AS id')).rows[0]
        .id;
      await assert.rejects(
        buildSourceInventory({ client: owner, expectedSnapshotId: changedId }),
        /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
      );
      await owner.query('ROLLBACK');
      await owner.query('DROP SCHEMA newly_added');
      await owner.query('CREATE TABLE public.unregistered_source (private_value text)');
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tableSnapshotId = (await owner.query('SELECT txid_current_snapshot()::text AS id'))
        .rows[0].id;
      await assert.rejects(
        buildSourceInventory({ client: owner, expectedSnapshotId: tableSnapshotId }),
        /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
      );
      await owner.query('ROLLBACK');
      await owner.query('DROP TABLE public.unregistered_source');
      await owner.query('ALTER TABLE public.schema_migrations ADD COLUMN census_probe text');
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const columnSnapshotId = (await owner.query('SELECT txid_current_snapshot()::text AS id'))
        .rows[0].id;
      await assert.rejects(
        buildSourceInventory({ client: owner, expectedSnapshotId: columnSnapshotId }),
        /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
      );
      await owner.query('ROLLBACK');
      await owner.query('ALTER TABLE public.schema_migrations DROP COLUMN census_probe');
      await owner.query('SELECT pg_catalog.lo_create(0)');
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const objectSnapshotId = (await owner.query('SELECT txid_current_snapshot()::text AS id'))
        .rows[0].id;
      const withObject = await buildSourceInventory({
        client: owner,
        expectedSnapshotId: objectSnapshotId,
      });
      assert.equal(withObject.largeObjectCount, 1);
      assert.equal(withObject.complete, false);
      await owner.query('ROLLBACK');
      const runtime = await connect('source_runtime');
      await runtime.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const runtimeId = (await runtime.query('SELECT txid_current_snapshot()::text AS id')).rows[0]
        .id;
      await assert.rejects(
        buildSourceInventory({ client: runtime, expectedSnapshotId: runtimeId }),
        /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
      );
      await runtime.query('ROLLBACK');
      // Independently verify that the old pin still refuses the actual current100 schema.
      await migrate(url('source_owner'));
      assert.equal(
        (await owner.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]
          .version,
        migrationFileNames.length,
      );
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const currentId = (await owner.query('SELECT txid_current_snapshot()::text AS id')).rows[0]
        .id;
      await assert.rejects(
        buildSourceInventory({ client: owner, expectedSnapshotId: currentId }),
        /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
      );
      await owner.query('ROLLBACK');
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
      if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
