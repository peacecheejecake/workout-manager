import { createPlanningRepository } from '../packages/server/persistence/src/planning.ts';
import { createActivityRepository } from '../packages/server/persistence/src/activities.ts';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createApi } from '../apps/api/src/app.ts';
import { createDatabase } from '../packages/server/persistence/src/database.ts';
import { createConsentRepository } from '../packages/server/persistence/src/repositories.ts';
import { createIdentityRepository } from '../packages/server/persistence/src/identity.ts';
import { grantIdentityFunctions, migrate } from '../packages/server/persistence/src/migrate.ts';
import { createIdentityService } from '../packages/server/identity/src/service.ts';
import { createOidcProvider } from '../packages/server/identity/src/oidc.ts';
import { fixtureOidc, startFixtureOidc } from './fixtures/oidc-provider.ts';

// Never read inherited database URLs: this harness creates and destroys its own cluster.
const detectedBin = [
  process.env['PG_BIN'],
  '/opt/homebrew/opt/postgresql@15/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
].find((value) => value !== undefined && existsSync(join(value, 'initdb')));
if (detectedBin === undefined)
  throw new Error('Identity E2E requires local PostgreSQL binaries (PG_BIN).');
const bin = detectedBin;
const directory = await mkdtemp(join(tmpdir(), 'workout-identity-e2e-'));
const data = join(directory, 'data');
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) throw new Error('Isolated PostgreSQL command failed');
}
let started = false;
const closers: Array<() => Promise<void>> = [];
let shutdown: Promise<void> | undefined;
function close() {
  shutdown ??= (async () => {
    let failed = false;
    for (const closer of closers.reverse()) {
      try {
        await closer();
      } catch {
        failed = true;
      }
    }
    try {
      if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    if (failed) throw new Error('Identity E2E resource cleanup failed');
  })();
  return shutdown;
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
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
    join(directory, 'postgres.log'),
    '-o',
    `-k ${directory} -h ''`,
    '-w',
    'start',
  ]);
  started = true;
  const endpoint = `localhost/postgres?host=${encodeURIComponent(directory)}`;
  const adminUrl = `postgresql://workout_admin@${endpoint}`;
  const runtimeUrl = `postgresql://workout_runtime@${endpoint}`;
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query(
      'CREATE ROLE workout_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
    await migrate(adminUrl);
    await grantIdentityFunctions(adminUrl, 'workout_runtime');
    await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
    await admin.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt, plan_head, plan_snapshot, plan_history, activity_canonical, activity_source_head, activity_source_revision, activity_overlay, activity_overlay_revision, activity_suppression, activity_import_receipt TO workout_runtime',
    );
  } finally {
    await admin.end();
  }
  const providerServer = await startFixtureOidc();
  closers.push(() => providerServer.close());
  const store = createIdentityRepository({ connectionString: runtimeUrl });
  closers.push(() => store.close());
  const database = createDatabase({ connectionString: runtimeUrl });
  closers.push(() => database.close());
  const provider = await createOidcProvider({ ...fixtureOidc, allowInsecureLocalhost: true });
  const identity = createIdentityService({
    store,
    provider,
    publicOrigin: 'http://127.0.0.1:3100',
    allowInsecureLocalhost: true,
  });
  const api = createApi({
    auth: identity,
    identity,
    consent: createConsentRepository(database),
    planning: createPlanningRepository(database),
    activities: createActivityRepository(database),
    allowedOrigins: ['http://127.0.0.1:3100'],
  });
  closers.push(() => api.close());
  await api.listen({ host: '127.0.0.1', port: 4300 });
  console.log('Identity E2E ready: API 4300, fixture provider 4400, private PostgreSQL.');
} catch (error) {
  await close();
  throw error;
}
