import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';

// Explicit CI URLs point to a disposable service. Never auto-connect to a developer database.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
const logicalContract = process.argv.length === 3 && process.argv[2] === '--logical-contract';
const pgoutputContract = process.argv.length === 3 && process.argv[2] === '--pgoutput-contract';
const foundationContract = process.argv.length === 3 && process.argv[2] === '--foundation-contract';
if (!logicalContract && !pgoutputContract && !foundationContract && process.argv.length !== 2) {
  throw new Error('Unknown PostgreSQL test harness argument.');
}
function runIntegrationTests(env) {
  if (foundationContract) {
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.integration.config.ts',
        'packages/server/persistence/tests/foundation.integration.test.ts',
      ],
      { env },
    );
    return;
  }
  if (logicalContract) {
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.integration.config.ts',
        'packages/server/persistence/tests/restore-suppression-logical-decoding.integration.test.ts',
      ],
      { env: { ...env, TEST_LOGICAL_DECODING: '1' } },
    );
    return;
  }
  if (pgoutputContract) {
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.integration.config.ts',
        'packages/server/persistence/tests/restore-suppression-pgoutput.integration.test.ts',
        'packages/server/persistence/tests/restore-suppression-v6-pgoutput.integration.test.ts',
        'packages/server/persistence/tests/restore-app-consent-chain.integration.test.ts',
        'packages/server/persistence/tests/restore-suppression-exporter.integration.test.ts',
        'packages/server/persistence/tests/restore-suppression-coordinator.integration.test.ts',
      ],
      { env: { ...env, TEST_PGOUTPUT_CONTRACT: '1' } },
    );
    return;
  }
  run(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      '--exclude',
      'packages/server/persistence/tests/resource-url-ingestion-upgrade.integration.test.ts',
      '--exclude',
      'packages/server/persistence/tests/restore-suppression-logical-decoding.integration.test.ts',
      '--exclude',
      'packages/server/persistence/tests/restore-suppression-pgoutput.integration.test.ts',
      '--exclude',
      'packages/server/persistence/tests/restore-suppression-coordinator.integration.test.ts',
    ],
    { env },
  );
}
function migrationEnvironment(env, ownerUrl) {
  return { ...env, TEST_DATABASE_OWNER_URL: ownerUrl };
}
function preinstall(env) {
  // Keep the public migration implementation authoritative; never reproduce SQL here.
  run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { Pool } from 'pg';
      import { migrate, migrationFileNames } from './packages/server/persistence/src/migrate.ts';
      await migrate(process.env.TEST_DATABASE_OWNER_URL);
      const pool = new Pool({ connectionString: process.env.TEST_DATABASE_OWNER_URL, connectionTimeoutMillis: 5000, max: 1 });
      try {
        const result = await pool.query('SELECT count(*)::int AS count, max(version) AS latest FROM schema_migrations');
        if (result.rows[0]?.count !== migrationFileNames.length || result.rows[0]?.latest !== migrationFileNames.length)
          throw new Error('Disposable migration registry does not match the registered latest schema.');
        console.log('Plain migration registry verified (' + migrationFileNames.length + ').');
      } finally { await pool.end(); }`,
    ],
    { env },
  );
}
function endpoint(url) {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}
function databaseUrl(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.href;
}
async function prepareAndRun(env) {
  if (
    new Set(
      [env.TEST_DATABASE_ADMIN_URL, env.TEST_DATABASE_OWNER_URL, env.TEST_DATABASE_URL].map(
        endpoint,
      ),
    ).size !== 1
  )
    throw new Error('Disposable admin, owner and runtime URLs must address the same database.');
  const admin = new Pool({
    connectionString: env.TEST_DATABASE_ADMIN_URL,
    connectionTimeoutMillis: 5000,
    max: 1,
  });
  const owner = new Pool({
    connectionString: env.TEST_DATABASE_OWNER_URL,
    connectionTimeoutMillis: 5000,
    max: 1,
  });
  const runtime = new Pool({
    connectionString: env.TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 1,
  });
  let upgradeDatabase;
  try {
    const roleQuery = `SELECT current_user AS name, session_user AS session_name,
      rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user`;
    const [administrator, installer, consumer] = await Promise.all([
      admin.query(roleQuery),
      owner.query(roleQuery),
      runtime.query(roleQuery),
    ]);
    const adminRole = administrator.rows[0],
      ownerRole = installer.rows[0],
      runtimeRole = consumer.rows[0];
    if (
      !adminRole?.rolsuper ||
      !ownerRole ||
      !runtimeRole ||
      ownerRole.name !== ownerRole.session_name ||
      runtimeRole.name !== runtimeRole.session_name ||
      ownerRole.rolsuper ||
      ownerRole.rolbypassrls ||
      ownerRole.rolcreatedb ||
      ownerRole.rolcreaterole ||
      runtimeRole.rolsuper ||
      runtimeRole.rolbypassrls ||
      runtimeRole.rolcreatedb ||
      runtimeRole.rolcreaterole ||
      runtimeRole.name !== 'workout_runtime' ||
      ownerRole.name === runtimeRole.name
    )
      throw new Error(
        'Disposable tests require a separate super admin, plain migration owner and restricted workout_runtime.',
      );
    // Reject an existing privileged installation instead of silently reassigning it.
    const mismatched = await owner.query(`SELECT EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
    ) AS found`);
    if (mismatched.rows[0]?.found)
      throw new Error(
        'Disposable database has objects owned by another role; use a fresh plain-owned database.',
      );
    preinstall(env);
    const budgetTables = [
      'openai_budget_fx_definition',
      'openai_budget_price_definition',
      'openai_budget_activation',
      'openai_budget_month',
      'openai_budget_reservation',
      'openai_budget_journal',
    ];
    const tableInvariant = await owner.query(
      `SELECT count(*)::int AS invalid
      FROM unnest($1::text[]) AS expected(name)
      LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||expected.name)
      WHERE c.oid IS NULL OR c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
        OR (expected.name<>'schema_migrations' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity))`,
      [[...budgetTables, 'schema_migrations']],
    );
    const functionInvariant = await owner.query(
      `SELECT count(*)::int AS invalid
      FROM unnest($1::text[]) AS expected(signature)
      LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||expected.signature)
      WHERE p.oid IS NULL OR p.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
      [
        [
          'assert_openai_budget_function_owner()',
          'require_openai_budget_activation()',
          'reserve_openai_budget(uuid,text,text,text,integer,integer,uuid)',
          'begin_openai_budget_dispatch(uuid,uuid,uuid,uuid,integer,uuid)',
          'settle_openai_budget(uuid,uuid,text,text,text)',
          'erase_account(text)',
          'erase_account_before_ai_settings(text)',
          'erase_account_before_global_budget(text)',
        ],
      ],
    );
    if (tableInvariant.rows[0]?.invalid !== 0 || functionInvariant.rows[0]?.invalid !== 0)
      throw new Error(
        'Disposable budget/erasure owner or FORCE RLS invariants do not match the plain installer.',
      );
    console.log('Plain budget/erasure catalog ownership and FORCE RLS verified.');
    if (!foundationContract && !logicalContract && !pgoutputContract) {
      // Migration 028→029 must remain a real rename, never run against the latest normal DB.
      upgradeDatabase = `workout_url_upgrade_${randomUUID().replaceAll('-', '')}`;
      const quotedOwner = `"${ownerRole.name.replaceAll('"', '""')}"`;
      await admin.query(`CREATE DATABASE "${upgradeDatabase}" OWNER ${quotedOwner}`);
      const upgradeOwnerUrl = databaseUrl(env.TEST_DATABASE_OWNER_URL, upgradeDatabase);
      run(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          '--config',
          'vitest.integration.config.ts',
          'packages/server/persistence/tests/resource-url-ingestion-upgrade.integration.test.ts',
        ],
        {
          env: {
            ...migrationEnvironment(env, upgradeOwnerUrl),
            TEST_DATABASE_ADMIN_URL: upgradeOwnerUrl,
            TEST_DATABASE_URL: databaseUrl(env.TEST_DATABASE_URL, upgradeDatabase),
          },
        },
      );
    }
    runIntegrationTests(env);
  } finally {
    try {
      if (upgradeDatabase)
        await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`);
    } finally {
      await Promise.all([admin.end(), owner.end(), runtime.end()]);
    }
  }
}
const suppliedUrls = [
  process.env.TEST_DATABASE_URL,
  process.env.TEST_DATABASE_ADMIN_URL,
  process.env.TEST_DATABASE_OWNER_URL,
];
if (suppliedUrls.some(Boolean) && !suppliedUrls.every(Boolean))
  throw new Error(
    'Supply isolated admin, plain owner and runtime test database URLs together, or none.',
  );
if ((logicalContract || pgoutputContract) && suppliedUrls.some(Boolean))
  throw new Error('Logical decoding contract requires a local disposable PostgreSQL cluster.');
if (suppliedUrls.every(Boolean)) {
  await prepareAndRun(process.env);
} else {
  const candidates = [
    process.env.PG_BIN,
    '/opt/homebrew/opt/postgresql@14/bin',
    '/opt/homebrew/opt/postgresql@15/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/16/bin',
  ];
  const bin = candidates.find((candidate) => candidate && existsSync(join(candidate, 'initdb')));
  if (!bin)
    throw new Error(
      'PostgreSQL binaries unavailable. Set PG_BIN or supply disposable TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'workout-pg-'));
  const data = join(directory, 'data');
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
    // A private unix socket avoids TCP listeners and cannot reach any existing instance.
    run(join(bin, 'pg_ctl'), [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-k ${directory} -h ''${logicalContract || pgoutputContract ? ' -c wal_level=logical -c max_replication_slots=4 -c max_wal_senders=4' : ''}`,
      '-w',
      'start',
    ]);
    started = true;
    run(join(bin, 'psql'), [
      '-h',
      directory,
      '-U',
      'workout_admin',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE ROLE workout_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    ]);
    run(join(bin, 'psql'), [
      '-h',
      directory,
      '-U',
      'workout_admin',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE ROLE workout_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    ]);
    run(join(bin, 'psql'), [
      '-h',
      directory,
      '-U',
      'workout_admin',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE DATABASE workout_test OWNER workout_owner',
    ]);
    const endpoint = `localhost/workout_test?host=${encodeURIComponent(directory)}`;
    await prepareAndRun({
      ...process.env,
      TEST_DATABASE_ADMIN_URL: `postgresql://workout_admin@${endpoint}`,
      TEST_DATABASE_URL: `postgresql://workout_runtime@${endpoint}`,
      TEST_DATABASE_OWNER_URL: `postgresql://workout_owner@${endpoint}`,
    });
  } finally {
    if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(directory, { recursive: true, force: true });
  }
}
