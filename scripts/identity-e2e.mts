import { createCoachingConstraintRepository } from '../packages/server/persistence/src/coaching-constraints.ts';
import { createCoreEvidenceSnapshotRepository } from '../packages/server/persistence/src/evidence-snapshots.ts';
import { createCoachingThreadRepository } from '../packages/server/persistence/src/coaching-threads.ts';
import { createCoachingRunRepository } from '../packages/server/persistence/src/coaching-runs.ts';
import { createTrainingCandidateRepository } from '../packages/server/persistence/src/coaching-candidates.ts';
import { createSessionActualsRepository } from '../packages/server/persistence/src/session-actuals.js';
import { createPlanScenarioRepository } from '../packages/server/persistence/src/plan-scenarios.ts';
import { createSessionCompletionRepository } from '../packages/server/persistence/src/session-completions.ts';
import { createPeriodSummaryRepository } from '../packages/server/persistence/src/period-summary.ts';
import { createActivityContextRepository } from '../packages/server/persistence/src/activity-context.ts';
import { createDashboardRepository } from '../packages/server/persistence/src/dashboard.ts';
import { createCheckInRepository } from '../packages/server/persistence/src/check-ins.ts';
import { identityApiPort } from './fixtures/identity-api-port.ts';
import { coachingWorkerContextPath } from './fixtures/coaching-worker-context.ts';
import { createOperationsRepository } from '../packages/server/persistence/src/operations.ts';
import { createPlanningRepository } from '../packages/server/persistence/src/planning.ts';
import { createActivityRepository } from '../packages/server/persistence/src/activities.ts';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createApi } from '../apps/api/src/app.ts';
import { createDatabase } from '../packages/server/persistence/src/database.ts';
import { createConsentRepository } from '../packages/server/persistence/src/repositories.ts';
import { createIdentityRepository } from '../packages/server/persistence/src/identity.ts';
import {
  grantIdentityFunctions,
  grantOperations,
  grantCheckIns,
  grantSessionCompletions,
  grantPlanScenarios,
  grantCoachingConstraints,
  grantCoachingThreads,
  grantCoachingRuns,
  grantCoachingCandidates,
  grantCoachingRunWorker,
  grantCoreEvidenceSnapshots,
  grantGarmin,
  grantGarminWorker,
  migrate,
} from '../packages/server/persistence/src/migrate.ts';
import { createIdentityService } from '../packages/server/identity/src/service.ts';
import { createOidcProvider } from '../packages/server/identity/src/oidc.ts';
import { fixtureOidc, startFixtureOidc } from './fixtures/oidc-provider.ts';
import { fixtureGarmin, startFixtureGarmin } from './fixtures/garmin-provider.ts';
import {
  createGarminStore,
  createGarminRevocationStore,
} from '../packages/server/persistence/src/garmin.ts';
import {
  createGarminService,
  processGarminRevocations,
} from '../packages/server/identity/src/garmin-service.ts';
import { createGarminCipher } from '../packages/server/identity/src/garmin-crypto.ts';
import { createGarminProvider } from '../packages/server/identity/src/garmin-provider.ts';

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
  const workerUrl = `postgresql://workout_coaching_worker@${endpoint}`;
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query(
      'CREATE ROLE workout_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
    await migrate(adminUrl);
    await grantIdentityFunctions(adminUrl, 'workout_runtime');
    await grantOperations(adminUrl, 'workout_runtime');
    await grantCheckIns(adminUrl, 'workout_runtime');
    await grantSessionCompletions(adminUrl, 'workout_runtime');
    await grantPlanScenarios(adminUrl, 'workout_runtime');
    await grantCoachingConstraints(adminUrl, 'workout_runtime');
    await grantCoachingThreads(adminUrl, 'workout_runtime');
    await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
    await grantCoachingRuns(adminUrl, 'workout_runtime');
    await grantCoachingCandidates(adminUrl, 'workout_runtime');
    await admin.query(
      'CREATE ROLE workout_coaching_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
    await grantCoachingRunWorker(adminUrl, 'workout_coaching_worker');
    await grantGarmin(adminUrl, 'workout_runtime');
    await admin.query(
      'CREATE ROLE workout_garmin_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
    await grantGarminWorker(adminUrl, 'workout_garmin_worker');
    await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
    await admin.query('GRANT USAGE ON SCHEMA public TO workout_coaching_worker');
    await admin.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt, plan_head, plan_snapshot, plan_history, activity_canonical, activity_source_head, activity_source_revision, activity_overlay, activity_overlay_revision, activity_suppression, activity_import_receipt TO workout_runtime',
    );
  } finally {
    await admin.end();
  }
  await rm(coachingWorkerContextPath, { force: true });
  await writeFile(
    coachingWorkerContextPath,
    JSON.stringify({ databaseUrl: runtimeUrl, workerDatabaseUrl: workerUrl }),
    { mode: 0o600 },
  );
  closers.push(() => rm(coachingWorkerContextPath, { force: true }));
  const providerServer = await startFixtureOidc();
  closers.push(() => providerServer.close());
  const garminServer = await startFixtureGarmin();
  closers.push(() => garminServer.close());
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
  const garminProvider = createGarminProvider({
    clientId: fixtureGarmin.clientId,
    clientSecret: fixtureGarmin.clientSecret,
    redirectUri: fixtureGarmin.redirectUri,
    fixtureOrigin: fixtureGarmin.origin,
    allowInsecureLocalhost: true,
  });
  const garminCipher = createGarminCipher({
    activeKeyId: 'fixture',
    keys: { fixture: Buffer.alloc(32, 7).toString('base64') },
  });
  const revocations = createGarminRevocationStore({
    connectionString: `postgresql://workout_garmin_worker@${endpoint}`,
  });
  closers.push(() => revocations.close());
  let workerRun: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (workerRun !== undefined) return;
    workerRun = processGarminRevocations({
      store: revocations,
      provider: garminProvider,
      cipher: garminCipher,
    })
      .catch(() => {
        console.error('Synthetic Garmin cleanup retry pending.');
      })
      .finally(() => {
        workerRun = undefined;
      });
  }, 250);
  closers.push(async () => {
    clearInterval(timer);
    await workerRun;
  });
  const api = createApi({
    auth: identity,
    identity,
    garmin: createGarminService({
      store: createGarminStore(database),
      provider: garminProvider,
      cipher: garminCipher,
    }),
    consent: createConsentRepository(database),
    planning: createPlanningRepository(database),
    planScenarios: createPlanScenarioRepository(database),
    coachingConstraints: createCoachingConstraintRepository(database),
    coachingThreads: createCoachingThreadRepository(database),
    coachingRuns: createCoachingRunRepository(database, {
      policy: { id: 'running-core-v2-training', version: '1' },
      source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    }),
    coachingCandidates: createTrainingCandidateRepository(database, {
      policy: { id: 'running-core-v2-training', version: '1' },
      source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    }),
    evidenceSnapshots: createCoreEvidenceSnapshotRepository(database),
    sessionCompletions: createSessionCompletionRepository(database),
    sessionActuals: createSessionActualsRepository(database),
    periodSummary: createPeriodSummaryRepository(database),
    activities: createActivityRepository(database),
    activityContext: createActivityContextRepository(database),
    operations: createOperationsRepository(database),
    checkIns: createCheckInRepository(database),
    dashboard: createDashboardRepository(database),
    allowedOrigins: ['http://127.0.0.1:3100', 'http://127.0.0.1:4200'],
  });
  closers.push(() => api.close());
  await api.listen({ host: '127.0.0.1', port: identityApiPort });
  console.log(
    `Identity E2E ready: API ${identityApiPort}, OIDC fixture 4400, Garmin fixture 4500, private PostgreSQL.`,
  );
} catch (error) {
  await close();
  throw error;
}
