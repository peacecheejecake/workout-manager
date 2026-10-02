import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { migrate } from '../../../packages/server/persistence/src/migrate.ts';
import { withPersistentExportedSlotSnapshot } from './persistent-slot-snapshot.mjs';
import { buildSnapshotCoverage } from './snapshot-coverage.mjs';

const database = 'workout_pg17_proof';
const marker = 'WM_DISPOSABLE_PG17_PROOF';
const ownerId = '00000000-0000-4000-8000-000000000001';
// Derived offline from checked-in source-registry.json migration checksums and
// the 16 pinned relation/column descriptions, with coverage_owner as table owner.
// Never derive this expected value from the database under test.
const schemaPin = 'ccea92c9a8af78015d48ed0c35e05642b67d4b7d2263c61c1fd5123a0370ccc4';
const urlInput = process.env.WORKOUT_SNAPSHOT_COVERAGE_PG17_URL;
const pgDump = process.env.WORKOUT_PG17_DUMP_BIN ?? 'pg_dump';
const pgRestore =
  process.env.WORKOUT_PG17_RESTORE_BIN ??
  (isAbsolute(pgDump) ? join(dirname(pgDump), 'pg_restore') : 'pg_restore');

function safeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PG17_COVERAGE_UNSAFE_TARGET');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== `/${database}` ||
    url.search ||
    url.hash
  )
    throw new Error('PG17_COVERAGE_UNSAFE_TARGET');
  return url;
}

async function connect(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await client.query("SET statement_timeout = '15s'");
  return client;
}

function program(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0)
    throw new Error(`PG17_COVERAGE_ARCHIVE_FAILED: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

test(
  'PG17 persistent exported snapshot binds pinned 001–093 coverage and dump to one view',
  { skip: !urlInput, timeout: 180_000 },
  async () => {
    const url = safeUrl(urlInput);
    const adminUrl = url.toString();
    const ownerUrl = new URL(adminUrl);
    ownerUrl.username = 'coverage_owner';
    ownerUrl.password = url.password;
    let admin = await connect(adminUrl);
    let owner;
    let imported;
    let slotCreated = false;
    const slot = `coverage_${randomBytes(8).toString('hex')}`;
    const directory = mkdtempSync(join(tmpdir(), 'wm-pg17-coverage-'));
    const archive = join(directory, 'coverage.dump');
    let failure;
    const cleanupErrors = [];
    try {
      // Every guard precedes role creation, migration, account insertion and slot creation.
      const target = (
        await admin.query(`SELECT current_database() AS database,
          current_setting('server_version_num')::integer AS version,
          current_setting('wal_level') AS wal_level,
          system_identifier::text AS system_id,
          (SELECT shobj_description(oid, 'pg_database') FROM pg_database
            WHERE datname = current_database()) AS disposable_marker,
          to_regclass('public.schema_migrations') AS migrated
          FROM pg_control_system()`)
      ).rows[0];
      assert.equal(target.database, database, 'PG17_COVERAGE_UNSAFE_TARGET');
      assert.equal(target.disposable_marker, marker, 'PG17_COVERAGE_UNSAFE_TARGET');
      assert.equal(target.version, 170006, 'PG17_COVERAGE_WRONG_VERSION');
      assert.equal(target.wal_level, 'logical');
      assert.equal(target.migrated, null, 'PG17_COVERAGE_REQUIRES_FRESH_DATABASE');
      assert.match(program(pgDump, ['--version']), /pg_dump \(PostgreSQL\) 17\.6(?:\s|$)/);
      assert.match(program(pgRestore, ['--version']), /pg_restore \(PostgreSQL\) 17\.6(?:\s|$)/);

      await admin.query('CREATE ROLE coverage_owner LOGIN REPLICATION NOSUPERUSER NOBYPASSRLS');
      await admin.query('GRANT CREATE ON DATABASE workout_pg17_proof TO coverage_owner');
      await admin.query('GRANT CREATE ON SCHEMA public TO coverage_owner');
      await admin.end();
      admin = undefined;
      await migrate(ownerUrl.toString(), 93);
      admin = await connect(adminUrl);
      await admin.query('ALTER DATABASE workout_pg17_proof OWNER TO coverage_owner');
      await admin.query('ALTER SCHEMA public OWNER TO coverage_owner');
      await admin.end();
      admin = undefined;
      owner = await connect(ownerUrl.toString());
      await owner.query(
        'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
        [ownerId, 'https://synthetic.invalid', 'snapshot-owner'],
      );
      await owner.end();
      owner = undefined;

      const base = {
        connectionString: ownerUrl.toString(),
        expectedDatabase: database,
        expectedSystemIdentifier: target.system_id,
        slotName: slot,
        expectedPublication: 'workout_restore_suppression_events',
        expectedPublicationTables: ['public.restore_suppression_event'],
        expectedPublicationOperations: ['insert'],
        expectedCompletionMarker: 'a'.repeat(64),
      };
      await assert.rejects(
        withPersistentExportedSlotSnapshot({
          ...base,
          expectedSystemIdentifier: '123456789',
          capture: async () => {
            throw new Error('wrong cluster reached capture');
          },
        }),
        /PERSISTENT_SLOT_SNAPSHOT_FAILED/,
      );
      const result = await withPersistentExportedSlotSnapshot({
        ...base,
        capture: async (snapshot) => {
          owner = await connect(ownerUrl.toString());
          await owner.query(
            'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
            ['00000000-0000-4000-8000-000000000002', 'https://synthetic.invalid', 'late-owner'],
          );
          await owner.end();
          owner = undefined;

          imported = await connect(ownerUrl.toString());
          await imported.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          await imported.query(`SET TRANSACTION SNAPSHOT '${snapshot.snapshotName}'`);
          const snapshotId = (await imported.query('SELECT txid_current_snapshot()::text AS id'))
            .rows[0].id;
          const input = {
            client: imported,
            snapshot,
            expectedSnapshotId: snapshotId,
            expectedOwners: [ownerId], // Independently declared before DB inspection.
            expectedDomainSchemaFingerprint: schemaPin,
            hmacKey: Buffer.alloc(32, 7),
          };
          const coverage = await buildSnapshotCoverage(input);
          assert.equal(coverage.complete, false);
          assert.equal(coverage.owners.length, 1);
          assert.equal(Object.keys(coverage.owners[0].domain).length, 16);
          assert.equal(coverage.owners[0].domain['public.course'].count, 0);
          assert.deepEqual(coverage.owners[0].consent.ai, { state: 'absent' });
          await assert.rejects(
            buildSnapshotCoverage({ ...input, expectedOwners: [] }),
            /SNAPSHOT_COVERAGE_UNVERIFIED/,
          );
          await assert.rejects(
            buildSnapshotCoverage({ ...input, expectedDomainSchemaFingerprint: '0'.repeat(64) }),
            /SNAPSHOT_COVERAGE_UNVERIFIED/,
          );
          await imported.query('ROLLBACK');
          await imported.end();
          imported = undefined;

          program(pgDump, [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--snapshot=${snapshot.snapshotName}`,
            '--file',
            archive,
            adminUrl,
          ]);
          assert.equal(readFileSync(archive).subarray(0, 5).toString(), 'PGDMP');
          const dump = program(pgRestore, ['--data-only', '--table=account', '--file=-', archive]);
          assert.match(dump, /snapshot-owner/);
          assert.doesNotMatch(dump, /late-owner/);
          return { completionMarker: base.expectedCompletionMarker, output: coverage };
        },
      });
      slotCreated = true;
      assert.equal(result.output.owners.length, 1);
      assert.equal(result.snapshot.postgresSystemIdentifier, target.system_id);

      // A later catalog change must fail against the checked-in pin, even when
      // the caller supplies the now-complete roster for the newer DB view.
      owner = await connect(ownerUrl.toString());
      await owner.query('ALTER TABLE public.course ADD COLUMN coverage_drift text');
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const changedSnapshotId = (await owner.query('SELECT txid_current_snapshot()::text AS id'))
        .rows[0].id;
      await assert.rejects(
        buildSnapshotCoverage({
          client: owner,
          snapshot: result.snapshot,
          expectedSnapshotId: changedSnapshotId,
          expectedOwners: [ownerId, '00000000-0000-4000-8000-000000000002'],
          expectedDomainSchemaFingerprint: schemaPin,
          hmacKey: Buffer.alloc(32, 7),
        }),
        /SNAPSHOT_COVERAGE_UNVERIFIED/,
      );
      await owner.query('ROLLBACK');
      await owner.end();
      owner = undefined;
    } catch (error) {
      failure = error;
    } finally {
      if (imported) {
        await imported.query('ROLLBACK').catch(() => {});
        await imported.end().catch((error) => cleanupErrors.push(error));
      }
      if (owner) await owner.end().catch((error) => cleanupErrors.push(error));
      try {
        if (!admin) admin = await connect(adminUrl);
        const row = (
          await admin.query('SELECT active FROM pg_replication_slots WHERE slot_name=$1', [slot])
        ).rows[0];
        if (row) {
          assert.equal(row.active, false, 'PG17_COVERAGE_SLOT_CLEANUP_UNSAFE');
          await admin.query('SELECT pg_drop_replication_slot($1)', [slot]);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (admin) await admin.end().catch((error) => cleanupErrors.push(error));
      rmSync(directory, { recursive: true, force: true });
    }
    if (failure && cleanupErrors.length)
      throw new AggregateError([failure, ...cleanupErrors], 'PG17_COVERAGE_AND_CLEANUP_FAILED');
    if (failure) throw failure;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'PG17_COVERAGE_CLEANUP_FAILED');
    assert.equal(slotCreated, true);
  },
);
