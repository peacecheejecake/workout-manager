import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      'packages/server/persistence/tests/resource-url-ingestion-upgrade.integration.test.ts',
    ],
    { env },
  );
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
    ],
    { env },
  );
}
if (Boolean(process.env.TEST_DATABASE_URL) !== Boolean(process.env.TEST_DATABASE_ADMIN_URL)) {
  throw new Error(
    'Supply both isolated test database URLs, or neither for a local ephemeral cluster.',
  );
}
if ((logicalContract || pgoutputContract) && process.env.TEST_DATABASE_URL) {
  throw new Error('Logical decoding contract requires a local disposable PostgreSQL cluster.');
}
if (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_ADMIN_URL) {
  runIntegrationTests(process.env);
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
    const endpoint = `localhost/postgres?host=${encodeURIComponent(directory)}`;
    runIntegrationTests({
      ...process.env,
      TEST_DATABASE_ADMIN_URL: `postgresql://workout_admin@${endpoint}`,
      TEST_DATABASE_URL: `postgresql://workout_runtime@${endpoint}`,
    });
  } finally {
    if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(directory, { recursive: true, force: true });
  }
}
