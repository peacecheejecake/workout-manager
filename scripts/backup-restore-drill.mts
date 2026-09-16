import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  createDatabase,
  TenantErasedError,
  type Database,
} from '../packages/server/persistence/src/database.js';
import { migrate, grantOperations } from '../packages/server/persistence/src/migrate.js';
import { createConsentRepository } from '../packages/server/persistence/src/repositories.js';
import { createActivityRepository } from '../packages/server/persistence/src/activities.js';
import { createOperationsRepository } from '../packages/server/persistence/src/operations.js';

// No database URL is accepted, and no inherited libpq configuration reaches subprocesses.
const childEnvironment = { PATH: process.env.PATH, LC_ALL: 'C' };
function run(bin: string, name: string, args: string[]): string {
  const result = spawnSync(join(bin, name), args, {
    encoding: 'utf8',
    env: childEnvironment,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) throw new Error(`DRILL_${name.toUpperCase()}_FAILED`);
  return result.stdout.trim();
}
async function execute() {
  const candidates = [
    process.env.PG_BIN,
    '/opt/homebrew/opt/postgresql@15/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/lib/postgresql/15/bin',
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/17/bin',
  ];
  const bin = candidates.find((value): value is string =>
    Boolean(value && existsSync(join(value, 'initdb'))),
  );
  if (!bin) throw new Error('POSTGRESQL_BINARIES_UNAVAILABLE');
  const directory = await mkdtemp(join(tmpdir(), 'workout-restore-drill-'));
  const data = join(directory, 'data');
  const archive = join(directory, 'synthetic.dump');
  const ledgerFile = join(directory, 'post-backup-erasure-ledger.json');
  const pools: Pool[] = [];
  const databases: Database[] = [];
  let started = false;
  const interrupt = () => {
    try {
      if (started) run(bin, 'pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      process.exit(130);
    }
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const checks: string[] = [];
  let version = '';
  const url = (name: string, role = 'drill_admin') =>
    `postgresql://${role}@localhost/${name}?host=${encodeURIComponent(directory)}`;
  const pool = (name: string) => {
    const value = new Pool({ connectionString: url(name), max: 1, connectionTimeoutMillis: 5000 });
    pools.push(value);
    return value;
  };
  const database = (name: string) => {
    const value = createDatabase({ connectionString: url(name, 'drill_runtime') });
    databases.push(value);
    return value;
  };
  try {
    version = run(bin, 'pg_dump', ['--version']);
    run(bin, 'initdb', [
      '-D',
      data,
      '-U',
      'drill_admin',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
    ]);
    started = true;
    run(bin, 'pg_ctl', [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-k ${directory} -h ''`,
      '-w',
      'start',
    ]);
    const admin = pool('postgres');
    await admin.query(
      'CREATE ROLE drill_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
    await admin.query('CREATE DATABASE drill_source');
    await admin.query('CREATE DATABASE drill_restore');
    await migrate(url('drill_source'));
    const source = pool('drill_source');
    await source.query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,command_receipt,outbox,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO drill_runtime',
    );
    await grantOperations(url('drill_source'), 'drill_runtime');
    const sourceDb = database('drill_source');
    const deletedAthlete = randomUUID();
    const retainedAthlete = randomUUID();
    for (const [index, athleteId] of [deletedAthlete, retainedAthlete].entries()) {
      await createConsentRepository(sourceDb).setConsent(athleteId, {
        kind: 'app',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      await createActivityRepository(sourceDb).importActivity(athleteId, {
        idempotencyKey: randomUUID(),
        source: {
          kind: 'fixture',
          sourceId: randomUUID(),
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
        activity: {
          title: 'Synthetic restore drill',
          kind: 'running',
          startedAt: '2026-09-16T08:00:00+09:00',
          timezone: 'Asia/Seoul',
          durationSeconds: null,
          durationKind: 'unknown',
          distanceMeters: 0,
        },
      });
      await source.query(
        'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
        [athleteId, 'https://synthetic.invalid', `drill-${index}`],
      );
      await source.query(
        "INSERT INTO identity_private.session(token_hash,athlete_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
        [String(index + 1).repeat(64), athleteId, 'x'.repeat(32)],
      );
    }
    await source.query(
      "INSERT INTO identity_private.login_attempt VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes')",
      ['a'.repeat(64), 'b'.repeat(64), 'n'.repeat(16), 'v'.repeat(43)],
    );
    assert.equal(
      (await source.query('SELECT count(*)::int AS count FROM activity_canonical')).rows[0].count,
      2,
    );
    checks.push('two_synthetic_tenants_seeded');
    run(bin, 'pg_dump', [
      '-h',
      directory,
      '-U',
      'drill_admin',
      '-d',
      'drill_source',
      '--format=custom',
      '--file',
      archive,
    ]);
    await createOperationsRepository(sourceDb).eraseAccount(deletedAthlete);
    const ledger = (
      await source.query<{ athlete_id: string }>(
        'SELECT athlete_id FROM tenant_erasure ORDER BY athlete_id',
      )
    ).rows;
    await writeFile(ledgerFile, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
    assert.deepEqual(
      ledger.map((row) => row.athlete_id),
      [deletedAthlete],
    );
    checks.push('post_backup_erasure_ledger_captured_separately');
    run(bin, 'pg_restore', [
      '-h',
      directory,
      '-U',
      'drill_admin',
      '-d',
      'drill_restore',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      archive,
    ]);
    const restored = pool('drill_restore');
    // Admin inspection only: the runtime has not connected to the restored database yet.
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM activity_canonical WHERE athlete_id=$1',
          [deletedAthlete],
        )
      ).rows[0].count,
      1,
    );
    checks.push('trusted_custom_archive_restored_pre_deletion_rows');
    const replayLedger: unknown = JSON.parse(await readFile(ledgerFile, 'utf8'));
    assert.ok(Array.isArray(replayLedger));
    await restored.query('BEGIN');
    try {
      for (const entry of replayLedger) {
        assert.ok(
          typeof entry === 'object' &&
            entry !== null &&
            'athlete_id' in entry &&
            typeof entry.athlete_id === 'string',
        );
        await restored.query("SELECT set_config('app.athlete_id',$1,true)", [entry.athlete_id]);
        await restored.query('SELECT public.erase_account($1)', [entry.athlete_id]);
      }
      await restored.query('DELETE FROM identity_private.session');
      await restored.query('DELETE FROM identity_private.login_attempt');
      await restored.query('COMMIT');
    } catch (error) {
      await restored.query('ROLLBACK');
      throw error;
    }
    checks.push('latest_erasure_replayed_before_runtime_access');
    const tables = [
      'consent',
      'command_receipt',
      'outbox',
      'plan_snapshot',
      'plan_head',
      'plan_history',
      'activity_canonical',
      'activity_source_head',
      'activity_source_revision',
      'activity_overlay',
      'activity_overlay_revision',
      'activity_suppression',
      'activity_import_receipt',
    ];
    for (const table of tables) {
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            deletedAthlete,
          ])
        ).rows[0].count,
        0,
      );
    }
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM identity_private.account WHERE athlete_id=$1',
          [deletedAthlete],
        )
      ).rows[0].count,
      0,
    );
    checks.push('deleted_tenant_absent_from_all_13_health_and_command_tables_and_identity');
    assert.equal(
      (await restored.query('SELECT count(*)::int AS count FROM identity_private.session')).rows[0]
        .count,
      0,
    );
    assert.equal(
      (await restored.query('SELECT count(*)::int AS count FROM identity_private.login_attempt'))
        .rows[0].count,
      0,
    );
    checks.push('restored_sessions_and_login_attempts_invalidated');
    const restoreDb = database('drill_restore');
    assert.equal(
      (await createConsentRepository(restoreDb).getConsent(retainedAthlete, 'app')).granted,
      true,
    );
    assert.equal(
      (await createActivityRepository(restoreDb).listActivities(retainedAthlete)).total,
      1,
    );
    checks.push('retained_tenant_consent_and_activity_readable_through_runtime_rls');
    await assert.rejects(
      () =>
        createConsentRepository(restoreDb).setConsent(deletedAthlete, {
          kind: 'app',
          granted: true,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        }),
      TenantErasedError,
    );
    checks.push('erasure_gate_rejects_stale_runtime_write');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      await Promise.allSettled([
        ...databases.map((value) => value.close()),
        ...pools.map((value) => value.end()),
      ]);
    } finally {
      try {
        if (started) run(bin, 'pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    outcome: 'passed',
    postgresToolVersion: version,
    scope:
      'Synthetic ephemeral logical backup/restore drill only; not a production backup service or RPO/RTO evidence.',
    isolation:
      'New private Unix-socket cluster; no TCP listener or inherited database URL; separate generated source and restore databases.',
    archiveFormat: 'custom',
    trustedArchive: true,
    restoreBeforeRuntimeAccess: [
      'replay_latest_external_erasure_ledger',
      'invalidate_all_restored_sessions_and_login_attempts',
    ],
    checks,
    checkCount: checks.length,
    cleanup: { clusterStopped: true, temporaryClusterArchiveLedgerRemoved: !existsSync(directory) },
    limitations: [
      'Requires an independently retained, complete and current erasure ledger before production traffic resumes.',
      'External provider copies, encrypted remote backup storage, disaster recovery infrastructure, media, and production recovery objectives were not exercised.',
    ],
    sources: [
      'https://www.postgresql.org/docs/15/app-pgdump.html',
      'https://www.postgresql.org/docs/15/app-pgrestore.html',
    ],
  };
  await writeFile(
    new URL('../docs/implementation/research/backup-restore-result.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      outcome: report.outcome,
      checkCount: report.checkCount,
      cleanup: report.cleanup,
    }),
  );
}
if (process.argv.length === 3 && process.argv[2] === '--execute') await execute();
else
  console.log(
    'Opt-in only: pnpm exec tsx scripts/backup-restore-drill.mts --execute. Creates and destroys only a new synthetic PostgreSQL cluster.',
  );
