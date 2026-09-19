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
if (Boolean(process.env.TEST_DATABASE_URL) !== Boolean(process.env.TEST_DATABASE_ADMIN_URL)) {
  throw new Error(
    'Supply both isolated test database URLs, or neither for a local ephemeral cluster.',
  );
}
if (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_ADMIN_URL) {
  run('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts']);
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
      `-k ${directory} -h ''`,
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
    run('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts'], {
      env: {
        ...process.env,
        TEST_DATABASE_ADMIN_URL: `postgresql://workout_admin@${endpoint}`,
        TEST_DATABASE_URL: `postgresql://workout_runtime@${endpoint}`,
      },
    });
  } finally {
    if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(directory, { recursive: true, force: true });
  }
}
