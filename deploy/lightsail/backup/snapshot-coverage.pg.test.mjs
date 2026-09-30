import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { migrate } from '../../../packages/server/persistence/src/migrate.ts';
import { buildSnapshotCoverage, domainSchemaFingerprint } from './snapshot-coverage.mjs';

const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@14/bin';
const owners = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];
const domainTables = [
  'course_deletion',
  'course',
  'activity_canonical',
  'activity_source_head',
  'activity_suppression',
  'resource',
  'gallery_media_item',
  'check_in',
  'resource_share',
  'resource_access_audit',
  'course_share',
  'course_share_audit',
  'intake_entry',
  'recovery_action_log',
  'coaching_constraint',
  'course_share_area_budget',
];

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0)
    throw new Error(`${program} failed: ${result.error?.message ?? result.stderr}`);
}

test(
  'real PG imported snapshot, tenant RLS and runtime denial',
  { skip: process.env.WORKOUT_SNAPSHOT_COVERAGE_REAL_PG !== '1' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-snapshot-coverage-'));
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
      await admin.query('CREATE ROLE coverage_owner LOGIN NOSUPERUSER NOBYPASSRLS');
      await admin.query('CREATE ROLE coverage_runtime LOGIN NOSUPERUSER NOBYPASSRLS');
      await admin.query('GRANT CREATE ON DATABASE postgres TO coverage_owner');
      await admin.query('GRANT CREATE ON SCHEMA public TO coverage_owner');
      const owner = await connect('coverage_owner');
      await owner.query(`CREATE SCHEMA identity_private;
        CREATE TABLE public.schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL);
        INSERT INTO public.schema_migrations
          SELECT n,lpad(n::text,64,'0') FROM generate_series(1,93) n;
        CREATE TABLE identity_private.account(athlete_id uuid PRIMARY KEY);
        CREATE TABLE restore_suppression_event(athlete_id text NOT NULL, kind text NOT NULL,
          record_version integer NOT NULL);
        CREATE TABLE tenant_erasure(athlete_id text PRIMARY KEY);
        CREATE TABLE consent(athlete_id text NOT NULL,kind text NOT NULL,granted boolean NOT NULL,
          revision integer NOT NULL);
        CREATE TABLE coaching_constraint_head(athlete_id text PRIMARY KEY,revision integer NOT NULL);
        CREATE TABLE coaching_constraint(athlete_id text NOT NULL,deleted boolean NOT NULL);
        CREATE TABLE course_share_area_budget(athlete_id text NOT NULL,links_cut integer NOT NULL);
        REVOKE ALL ON identity_private.account,restore_suppression_event,tenant_erasure,
          consent,coaching_constraint_head,coaching_constraint,course_share_area_budget FROM PUBLIC;
        ALTER TABLE restore_suppression_event ENABLE ROW LEVEL SECURITY;
        ALTER TABLE restore_suppression_event FORCE ROW LEVEL SECURITY;
        CREATE POLICY event_owner ON restore_suppression_event TO coverage_owner USING(true);
        ALTER TABLE tenant_erasure ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tenant_erasure FORCE ROW LEVEL SECURITY;
        ALTER TABLE consent ENABLE ROW LEVEL SECURITY; ALTER TABLE consent FORCE ROW LEVEL SECURITY;
        ALTER TABLE coaching_constraint_head ENABLE ROW LEVEL SECURITY;
        ALTER TABLE coaching_constraint_head FORCE ROW LEVEL SECURITY;
        ALTER TABLE coaching_constraint ENABLE ROW LEVEL SECURITY;
        ALTER TABLE coaching_constraint FORCE ROW LEVEL SECURITY;
        ALTER TABLE course_share_area_budget ENABLE ROW LEVEL SECURITY;
        ALTER TABLE course_share_area_budget FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant ON tenant_erasure USING(athlete_id=nullif(current_setting('app.athlete_id',true),''));
        CREATE POLICY tenant ON consent USING(athlete_id=nullif(current_setting('app.athlete_id',true),''));
        CREATE POLICY tenant ON coaching_constraint_head USING(athlete_id=nullif(current_setting('app.athlete_id',true),''));
        CREATE POLICY tenant ON coaching_constraint USING(athlete_id=nullif(current_setting('app.athlete_id',true),''));
        CREATE POLICY tenant ON course_share_area_budget USING(athlete_id=nullif(current_setting('app.athlete_id',true),''));`);
      for (const table of domainTables.filter(
        (name) => !['coaching_constraint', 'course_share_area_budget'].includes(name),
      )) {
        await owner.query(`CREATE TABLE public.${table} (athlete_id text NOT NULL,
          object_id text NOT NULL, private_value text, grantee_principal_id text);
          ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
          ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant ON public.${table}
            USING(athlete_id=nullif(current_setting('app.athlete_id',true),''));`);
      }
      for (const athleteId of owners)
        await owner.query('INSERT INTO identity_private.account VALUES($1)', [athleteId]);
      await owner.query("SELECT pg_catalog.set_config('app.athlete_id',$1,false)", [owners[0]]);
      await owner.query("INSERT INTO consent VALUES($1,'ai',false,2)", [owners[0]]);
      await owner.query("SELECT pg_catalog.set_config('app.athlete_id',$1,false)", [owners[1]]);
      await owner.query('INSERT INTO coaching_constraint_head VALUES($1,3)', [owners[1]]);
      await owner.query('INSERT INTO coaching_constraint VALUES($1,true),($1,false)', [owners[1]]);
      await owner.query('INSERT INTO course_share_area_budget VALUES($1,4)', [owners[1]]);
      await owner.query("SELECT pg_catalog.set_config('app.athlete_id',$1,false)", [owners[0]]);
      await owner.query('INSERT INTO course VALUES($1,$2,$3,NULL)', [
        owners[0],
        'private-course-id',
        'private name and coordinates',
      ]);
      await owner.query('INSERT INTO resource_share VALUES($1,$2,$3,$4)', [
        owners[0],
        'private-share-id',
        'private share',
        owners[1],
      ]);
      await owner.query(
        "INSERT INTO restore_suppression_event VALUES($1,'ai_consent_transition',1)",
        [owners[0]],
      );
      const holder = await connect('coverage_owner');
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const exportName = (await holder.query('SELECT pg_export_snapshot() AS name')).rows[0].name;
      const expectedSnapshotId = (await holder.query('SELECT txid_current_snapshot()::text AS id'))
        .rows[0].id;
      const imported = await connect('coverage_owner');
      await imported.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await imported.query(`SET TRANSACTION SNAPSHOT '${exportName}'`);
      const catalog = (
        await imported.query(
          `SELECT n.nspname||'.'||c.relname AS table_name,
        a.attname AS column_name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner_name,
        a.attnotnull AS not_null, c.relforcerowsecurity AS force_rls,
        c.relrowsecurity AS row_security
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname||'.'||c.relname=ANY($1::text[]) AND c.relkind='r'`,
          [domainTables.map((name) => `public.${name}`)],
        )
      ).rows;
      const migrations = (
        await imported.query(
          'SELECT version,checksum FROM public.schema_migrations ORDER BY version',
        )
      ).rows;
      await owner.query("INSERT INTO restore_suppression_event VALUES($1,'course_deleted',1)", [
        owners[0],
      ]);
      await owner.query('UPDATE course SET private_value=$2 WHERE athlete_id=$1', [
        owners[0],
        'changed after snapshot',
      ]);
      const result = await buildSnapshotCoverage({
        client: imported,
        snapshot: {
          snapshotName: exportName,
          consistentPointLsn: '0/16B6C50',
          postgresSystemIdentifier: '123',
          replicationSlot: 'fixture_slot',
        },
        expectedSnapshotId,
        expectedOwners: owners,
        // Fixture-only binding check. This is not an independently pinned production fingerprint.
        expectedDomainSchemaFingerprint: domainSchemaFingerprint(catalog, migrations),
        hmacKey: Buffer.alloc(32, 9),
      });
      assert.equal(result.owners[0].events.ai_consent_transition, 1);
      assert.equal(result.owners[0].events.course_deleted, 0);
      assert.deepEqual(result.owners[2].consent.ai, { state: 'absent' });
      assert.equal(result.owners[1].coaching.tombstones, 1);
      assert.equal(result.owners[1].courseShareAreaBudget.linksCut, 4);
      assert.equal(result.owners[0].domain['public.course'].count, 1);
      await imported.query("SELECT pg_catalog.set_config('app.athlete_id',$1,true)", [owners[0]]);
      assert.equal(
        (await imported.query('SELECT private_value FROM course WHERE athlete_id=$1', [owners[0]]))
          .rows[0].private_value,
        'private name and coordinates',
      );
      assert.equal(result.owners[0].domain['public.resource_share'].count, 1);
      assert.equal(result.owners[1].domain['public.resource_share'].count, 0);
      assert.equal(result.owners[2].domain['public.course'].count, 0);
      assert.ok(!JSON.stringify(result).includes('private name and coordinates'));
      assert.ok(!JSON.stringify(result).includes('private-course-id'));
      assert.ok(!JSON.stringify(result).includes('private-share-id'));
      assert.equal(result.complete, false);
      const runtime = await connect('coverage_runtime');
      await assert.rejects(
        runtime.query('SELECT * FROM restore_suppression_event'),
        /permission denied/,
      );
      await runtime.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assert.rejects(
        buildSnapshotCoverage({
          client: runtime,
          snapshot: result.snapshot,
          expectedSnapshotId,
          expectedOwners: owners,
          expectedDomainSchemaFingerprint: domainSchemaFingerprint(catalog, migrations),
          hmacKey: Buffer.alloc(32, 9),
        }),
        /SNAPSHOT_COVERAGE_UNVERIFIED/,
      );
      await imported.query('ROLLBACK');
      await holder.query('ROLLBACK');
      await runtime.query('ROLLBACK');
      await owner.query('UPDATE course SET private_value=$2 WHERE athlete_id=$1', [
        owners[0],
        'private-' + 'x'.repeat(2 * 1024 * 1024),
      ]);
      const largeHolder = await connect('coverage_owner');
      await largeHolder.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const largeSnapshotName = (await largeHolder.query('SELECT pg_export_snapshot() AS name'))
        .rows[0].name;
      const largeSnapshotId = (
        await largeHolder.query('SELECT txid_current_snapshot()::text AS id')
      ).rows[0].id;
      const largeImported = await connect('coverage_owner');
      await largeImported.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await largeImported.query(`SET TRANSACTION SNAPSHOT '${largeSnapshotName}'`);
      let sawSuppressedRow = false;
      let inCourseCursor = false;
      let closedCourseCursor = false;
      await assert.rejects(
        buildSnapshotCoverage({
          client: {
            query: async (...queryArgs) => {
              const answer = await largeImported.query(...queryArgs);
              if (queryArgs[0].startsWith('DECLARE workout_snapshot_domain_cursor'))
                inCourseCursor = queryArgs[0].includes('FROM public.course t');
              if (inCourseCursor && queryArgs[0].startsWith('FETCH FORWARD')) {
                sawSuppressedRow = answer.rows.length === 1 && answer.rows[0].row_json === null;
              }
              if (
                inCourseCursor &&
                queryArgs[0].startsWith('CLOSE workout_snapshot_domain_cursor')
              ) {
                closedCourseCursor = true;
                inCourseCursor = false;
              }
              return answer;
            },
          },
          snapshot: {
            snapshotName: largeSnapshotName,
            consistentPointLsn: '0/16B6C50',
            postgresSystemIdentifier: '123',
            replicationSlot: 'fixture_slot',
          },
          expectedSnapshotId: largeSnapshotId,
          expectedOwners: owners,
          expectedDomainSchemaFingerprint: domainSchemaFingerprint(catalog, migrations),
          hmacKey: Buffer.alloc(32, 9),
        }),
        /SNAPSHOT_COVERAGE_UNVERIFIED/,
      );
      assert.equal(sawSuppressedRow, true);
      assert.equal(closedCourseCursor, true);
      await largeImported.query('ROLLBACK');
      await largeHolder.query('ROLLBACK');
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
      if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'real migrations 001–093 expose all 16 owner domain tables with FORCE RLS',
  { skip: process.env.WORKOUT_SNAPSHOT_COVERAGE_REAL_PG !== '1' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-snapshot-real-schema-'));
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
      await admin.query('CREATE ROLE coverage_owner LOGIN NOSUPERUSER NOBYPASSRLS');
      await admin.query('GRANT CREATE ON DATABASE postgres TO coverage_owner');
      await admin.query('GRANT CREATE ON SCHEMA public TO coverage_owner');
      await migrate(url('coverage_owner'));
      const owner = await connect('coverage_owner');
      for (const [index, athleteId] of owners.entries())
        await owner.query(
          'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
          [athleteId, 'https://issuer.example', `subject-${index}`],
        );
      await owner.query("SELECT pg_catalog.set_config('app.athlete_id',$1,false)", [owners[0]]);
      await owner.query('INSERT INTO public.course_deletion VALUES($1,$2,clock_timestamp())', [
        owners[0],
        '00000000-0000-4000-8000-000000000011',
      ]);
      const holder = await connect('coverage_owner');
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const exportName = (await holder.query('SELECT pg_export_snapshot() AS name')).rows[0].name;
      const expectedSnapshotId = (await holder.query('SELECT txid_current_snapshot()::text AS id'))
        .rows[0].id;
      const imported = await connect('coverage_owner');
      await imported.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await imported.query(`SET TRANSACTION SNAPSHOT '${exportName}'`);
      const catalog = (
        await imported.query(
          `SELECT n.nspname||'.'||c.relname AS table_name,
        a.attname AS column_name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner_name,
        a.attnotnull AS not_null, c.relforcerowsecurity AS force_rls,
        c.relrowsecurity AS row_security
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname||'.'||c.relname=ANY($1::text[]) AND c.relkind='r'`,
          [domainTables.map((name) => `public.${name}`)],
        )
      ).rows;
      const migrations = (
        await imported.query(
          'SELECT version,checksum FROM public.schema_migrations ORDER BY version',
        )
      ).rows;
      await owner.query('INSERT INTO public.course_deletion VALUES($1,$2,clock_timestamp())', [
        owners[1],
        '00000000-0000-4000-8000-000000000022',
      ]);
      const result = await buildSnapshotCoverage({
        client: imported,
        snapshot: {
          snapshotName: exportName,
          consistentPointLsn: '0/16B6C50',
          postgresSystemIdentifier: '123',
          replicationSlot: 'fixture_slot',
        },
        expectedSnapshotId,
        expectedOwners: owners,
        // Test-only current catalog; production must supply an independent pinned fingerprint.
        expectedDomainSchemaFingerprint: domainSchemaFingerprint(catalog, migrations),
        hmacKey: Buffer.alloc(32, 9),
      });
      assert.equal(result.owners[0].domain['public.course_deletion'].count, 1);
      assert.equal(result.owners[1].domain['public.course_deletion'].count, 0);
      assert.equal(result.owners[2].domain['public.course_deletion'].count, 0);
      assert.deepEqual(
        Object.keys(result.owners[0].domain).sort(),
        domainTables.map((name) => `public.${name}`).sort(),
      );
      assert.equal(result.complete, false);
      await imported.query('ROLLBACK');
      await holder.query('ROLLBACK');
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
      if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
