import {
  identityGarminPort,
  identityMobileOrigin,
  identityOidcPort,
  identityWebOrigin,
} from './fixtures/identity-ports.ts';
import { createCoachingConstraintRepository } from '../packages/server/persistence/src/coaching-constraints.ts';
import { createCoreEvidenceSnapshotRepository } from '../packages/server/persistence/src/evidence-snapshots.ts';
import { createCoachingThreadRepository } from '../packages/server/persistence/src/coaching-threads.ts';
import { createCoachingRunRepository } from '../packages/server/persistence/src/coaching-runs.ts';
import { createTrainingCandidateRepository } from '../packages/server/persistence/src/coaching-candidates.ts';
import { createSessionActualsRepository } from '../packages/server/persistence/src/session-actuals.js';
import { createPlanScenarioRepository } from '../packages/server/persistence/src/plan-scenarios.ts';
import { createSessionCompletionRepository } from '../packages/server/persistence/src/session-completions.ts';
import { createPeriodSummaryRepository } from '../packages/server/persistence/src/period-summary.ts';
import { createIntegratedPlannerRepository } from '../packages/server/persistence/src/integrated-planner.ts';
import { createJointApprovalRepository } from '../packages/server/persistence/src/joint-approval.ts';
import { createIntegratedApprovalV4Repository } from '../packages/server/persistence/src/integrated-approval-v4.ts';
import { createIntegratedFixtureV4Repository } from '../packages/server/persistence/src/integrated-fixture-v4.ts';
import { createJointFixtureRepository } from '../packages/server/persistence/src/joint-fixture.ts';
import { createActivityContextRepository } from '../packages/server/persistence/src/activity-context.ts';
import { createDashboardRepository } from '../packages/server/persistence/src/dashboard.ts';
import { createCheckInRepository } from '../packages/server/persistence/src/check-ins.ts';
import { identityApiPort } from './fixtures/identity-api-port.ts';
import { coachingWorkerContextPath } from './fixtures/coaching-worker-context.ts';
import { createOperationsRepository } from '../packages/server/persistence/src/operations.ts';
import { createPlanningRepository } from '../packages/server/persistence/src/planning.ts';
import { createRaceRepository } from '../packages/server/persistence/src/races.ts';
import { createRaceResultV2Repository } from '../packages/server/persistence/src/race-result-v2.ts';
import { createNutritionRepository } from '../packages/server/persistence/src/nutrition-core.ts';
import { createSupplementaryRepository } from '../packages/server/persistence/src/supplementary-core.ts';
import { createStretchingRepository } from '../packages/server/persistence/src/stretching.ts';
import { createRoutineRepository } from '../packages/server/persistence/src/routine-core.ts';
import { createRecoveryRepository } from '../packages/server/persistence/src/recovery-core.ts';
import { createActivityRepository } from '../packages/server/persistence/src/activities.ts';
import { createPrivateTextResourceRepository } from '../packages/server/persistence/src/resources.ts';
import { createResourceAccessRepository } from '../packages/server/persistence/src/resource-access.ts';
import { createResourceRetrievalRepository } from '../packages/server/persistence/src/resource-retrieval.ts';
import { createGalleryMediaRepository } from '../packages/server/persistence/src/gallery-media.ts';
import { createResourceFileUploadRepository } from '../packages/server/persistence/src/resource-file-uploads.ts';
import { createLocalFilesystemObjectStorage } from '../packages/server/media/src/local-filesystem.ts';
import {
  createCourseThumbnailFinalObjectKey,
  createCourseThumbnailTemporaryObjectKey,
} from '../packages/server/media/src/keys.ts';
import { createCourseThumbnailWorkerRepository } from '../packages/server/persistence/src/course-thumbnails.ts';
import { renderCourseThumbnail } from '../packages/server/courses/src/thumbnail.ts';
import { createActivityTrackRepository } from '../packages/server/persistence/src/activity-tracks.ts';
import { createCourseRepository } from '../packages/server/persistence/src/courses.ts';
import { createCoursePreferenceRepository } from '../packages/server/persistence/src/course-preferences.ts';
import {
  createCourseSharingRepository,
  createSharedCourseReader,
} from '../packages/server/persistence/src/course-sharing.ts';
import {
  drawShareOffset,
  shareCircle,
  sharedLineTouchesCircle,
} from '../packages/server/courses/src/disclosure.ts';
import {
  courseSharingOff,
  type CourseSharingConfiguration,
} from '../apps/api/src/course-sharing.ts';
import { loadGeoDatasets, readGeoDatasetsLicence } from '../apps/api/src/geo-datasets.ts';
import { createFixtureWalkingRoutePort } from './fixtures/walking-route-fixture.ts';
import { createConfiguredWalkingRoutes } from '../apps/api/src/routing-deployment.ts';
import { createConfiguredRoutingAdmission } from '../apps/api/src/routing-admission.ts';
import { createBoundedTrackParser } from '../packages/server/track-storage/src/parse-host.ts';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createApi } from '../apps/api/src/app.ts';
import { createAiSettingsService } from '../apps/api/src/ai-settings-service.ts';
import { createAiSettingsRepository } from '../packages/server/persistence/src/ai-settings.ts';
import { publishInitialAiSettingsCatalog } from './fixtures/ai-settings-catalog.ts';
import {
  writeAiSettingsFixtureContext,
  parseDisposableAiSettingsPg17Proof,
  aiSettingsEphemeralCredentialDigest,
  validateAiSettingsDisposableAdminIdentity,
  type DisposableAiSettingsPg17Proof,
} from './fixtures/ai-settings-context.ts';
import { identityE2eRunId } from './fixtures/identity-e2e-run.ts';
import { createDatabase, type Database } from '../packages/server/persistence/src/database.ts';
import { createRestoreGenerationRepository } from '../packages/server/persistence/src/restore-generation.ts';
import { createConsentRepository } from '../packages/server/persistence/src/repositories.ts';
import { createIdentityRepository } from '../packages/server/persistence/src/identity.ts';
import {
  grantIdentityFunctions,
  grantAiSettings,
  grantOperations,
  grantNutritionCore,
  grantSupplementaryCore,
  grantRoutineCore,
  grantStretchingCore,
  grantRecoveryCore,
  grantCheckIns,
  grantSessionCompletions,
  grantPlanScenarios,
  grantCoachingConstraints,
  grantCoachingThreads,
  grantCoachingRuns,
  grantCoachingCandidates,
  grantIntegratedApprovalV4,
  grantGalleryMedia,
  grantActivityTracks,
  grantCourses,
  grantRaces,
  grantCourseThumbnailWorker,
  grantResources,
  grantResourceRetrieval,
  grantCoachingRunWorker,
  grantCoreEvidenceSnapshots,
  grantGarmin,
  grantGarminUnofficial,
  grantGarminWorker,
  migrate,
} from '../packages/server/persistence/src/migrate.ts';
import { createGarminUnofficialStore } from '../packages/server/persistence/src/garmin-unofficial.ts';
import { createGarminUnofficialWorker } from '../packages/server/integrations/src/garmin/unofficial-worker.ts';
import {
  createGarminProfilePin,
  createGarminUnofficialService,
} from '../packages/server/integrations/src/garmin/unofficial-service.ts';
import { unofficialSessionCipher } from '../apps/api/src/garmin-unofficial-deployment.ts';
import {
  unofficialOwner,
  unofficialPython,
  unofficialScenarioPath,
  writeUnofficialScenario,
} from './fixtures/garmin-unofficial.ts';
import { createIdentityService } from '../packages/server/identity/src/service.ts';
import { createOidcProvider } from '../packages/server/identity/src/oidc.ts';
import { fixtureOidc, startFixtureOidc } from './fixtures/oidc-provider.ts';
import { startCertifiedOidc } from './fixtures/oidc-certified-provider.ts';
import { certifiedOidcContextPath } from './fixtures/certified-oidc-context.ts';
import { sweepStaleHandoffFiles } from './fixtures/identity-handoff-sweep.ts';
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

// Ordinary inherited database URLs remain ignored. This explicit disposable-only
// maintenance URL creates new run-owned resources; seeded app data never uses it.
function disposablePg17AdminUrl(value: unknown): URL | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    value.trim() !== value
  )
    throw new Error('IDENTITY_DISPOSABLE_PG_URL_INVALID');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('IDENTITY_DISPOSABLE_PG_URL_INVALID');
  }
  if (
    parsed.protocol !== 'postgresql:' ||
    !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
    !/^[1-9][0-9]{3,4}$/.test(parsed.port) ||
    Number(parsed.port) > 65535 ||
    Number(parsed.port) < 1024 ||
    parsed.pathname !== '/postgres' ||
    parsed.username.length === 0 ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error('IDENTITY_DISPOSABLE_PG_URL_INVALID');
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error('IDENTITY_DISPOSABLE_PG_URL_INVALID');
  }
  return parsed;
}
const externalPg = disposablePg17AdminUrl(process.env['IDENTITY_E2E_DISPOSABLE_PG17_ADMIN_URL']);
const resultStage = process.env['IDENTITY_E2E_RACE_RESULTS_V2'];
if (resultStage !== undefined && resultStage !== 'staged-108-111')
  throw new Error('IDENTITY_RACE_RESULT_STAGE_INVALID');
const stageRaceResults = resultStage === 'staged-108-111';
// Explicit disposable acceptance profile; this does not register migrations or
// activate configured production repositories. Pin every raw predecessor.
const raceResultStageFiles = [
  [
    '108_nutrition_race_disconnection.sql',
    'b71fc7ab7cb863932f1472c28d46200f42f22bc25d8ca198b529b6cc564a20f4',
  ],
  [
    '109_race_result_proof_lifecycle.sql',
    'fd2ecf020660c48d39990acdedc5838651ff873e7970b882814264b58808a9fa',
  ],
  [
    '110_nutrition_disconnection_lineage.sql',
    'd2891aeaeb3af586c42e4e2ee924eb4adc9de0e61af3011219c654a185c91614',
  ],
  [
    '111_race_result_preserved_proof_updates.sql',
    '69b7689c8579575eb899d2602e979db697039cb75b8a7b8f71ab54154b0d4576',
  ],
] as const;

const detectedBin = [
  process.env['PG_BIN'],
  '/opt/homebrew/opt/postgresql@14/bin',
  '/opt/homebrew/opt/postgresql@15/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
].find((value) => value !== undefined && existsSync(join(value, 'initdb')));
if (externalPg === null && detectedBin === undefined)
  throw new Error('Identity E2E requires local PostgreSQL binaries (PG_BIN).');
const bin = detectedBin ?? '';
// Hand-off files of harnesses that were killed (SIGKILL skips the closers below). Only files
// whose writer is gone are removed; a concurrently running harness keeps its own.
const swept = await sweepStaleHandoffFiles();
if (swept.removed.length > 0)
  console.log(`Identity E2E: removed ${swept.removed.length} stale hand-off file(s).`);
for (const { name, reason } of swept.skipped)
  console.log(`Identity E2E: left hand-off entry ${name} in place (${reason}).`);
const directory = await mkdtemp(join(tmpdir(), 'workout-identity-e2e-'));
const data = join(directory, 'data');
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) throw new Error('Isolated PostgreSQL command failed');
}
async function identityWalkingRoutes(database: Database) {
  const mode = process.env['IDENTITY_E2E_ROUTING'] ?? 'fixture';
  if (mode === 'fixture') return { walkingRoutes: createFixtureWalkingRoutePort() };
  if (mode !== 'graphhopper') throw new Error(`Unsupported IDENTITY_E2E_ROUTING: ${mode}`);
  const environment = { ...process.env };
  // The production limiter, on this harness's PostgreSQL (M2-01ah).
  const routing = await createConfiguredWalkingRoutes(environment, {
    admission: createConfiguredRoutingAdmission(database, environment),
  });
  if (routing === null)
    throw new Error('IDENTITY_E2E_ROUTING=graphhopper needs ROUTING_* settings');
  console.log(`Identity E2E routing: self-hosted engine, graph ${routing.graphBuildId}.`);
  // M0-06b-odbl: the public disclosure of the graph this harness serves.
  return {
    walkingRoutes: routing.walkingRoutes,
    mapDataDisclosure: () => routing.deployments.activeDisclosure,
  };
}
let started = false;
const closers: Array<() => Promise<void>> = [];
let shutdown: Promise<void> | undefined;
// A signal during external provisioning waits for startup success/error before
// cleanup. Provision/catalog pools have bounded server/client deadlines; a lost
// CREATE acknowledgement remains unverified and is never permission to drop.
let finishStartup: () => void = () => undefined;
const startupSettled = new Promise<void>((resolve) => {
  finishStartup = resolve;
});
const externalDatabaseName = `workout_identity_${randomUUID().replaceAll('-', '')}`;
const externalRolePassword = randomUUID();
const fixedRoles = [
  'workout_owner',
  'workout_runtime',
  'workout_coaching_worker',
  'workout_garmin_worker',
  'workout_course_thumbnail_worker',
] as const;
const createdExternalRoles: string[] = [];
let createdExternalDatabase = false;
let externalDatabaseOid: number | undefined;
let externalServerVersion: number | undefined;
let aiSettingsExternalProof: DisposableAiSettingsPg17Proof | undefined;
const externalRoleOids = new Map<string, number>();
async function createFixtureRole(pool: Pool, role: (typeof fixedRoles)[number]) {
  // Fixed finite names preserve production worker validation. No existing role is
  // altered/reused. Track only CREATE success, including partial setup failures.
  try {
    await pool.query(
      `CREATE ROLE "${role}" LOGIN ${externalPg === null ? '' : `PASSWORD '${externalRolePassword}'`} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  } catch (error) {
    if (externalPg === null) throw error;
    throw new Error('IDENTITY_FIXTURE_ROLE_CREATE_FAILED');
  }
  if (externalPg !== null) {
    createdExternalRoles.push(role);
    const found = await pool.query('SELECT oid FROM pg_roles WHERE rolname=$1', [role]);
    const oid: unknown = found.rows[0]?.oid;
    if (found.rows.length !== 1 || typeof oid !== 'number' || !Number.isInteger(oid) || oid <= 0)
      throw new Error('IDENTITY_DISPOSABLE_PG_OWNERSHIP_UNVERIFIED');
    externalRoleOids.set(role, oid);
  }
}
function close() {
  shutdown ??= (async () => {
    if (externalPg !== null) await startupSettled;
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
  process.on(signal, () => {
    // Repeated terminal signals must await the same bounded cleanup promise.
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
try {
  if (externalPg === null) {
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
  }
  // Administration/fixture inspection stays admin; migrations/definers retain
  // a separate plain owner in both modes. The external service is never stopped.
  const management = new Pool({
    connectionString:
      externalPg?.toString() ??
      `postgresql://workout_admin@localhost/postgres?host=${encodeURIComponent(directory)}`,
    ...(externalPg === null
      ? {}
      : {
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
          query_timeout: 12000,
          max: 1,
        }),
  });
  if (externalPg !== null) {
    // Registered first: reverse-order closers shut app/worker pools before DROP.
    closers.push(async () => {
      try {
        if (createdExternalDatabase) {
          const found = await management.query(
            'SELECT oid,datdba FROM pg_database WHERE datname=$1',
            [externalDatabaseName],
          );
          if (
            externalDatabaseOid === undefined ||
            found.rows.length !== 1 ||
            found.rows[0]?.oid !== externalDatabaseOid ||
            found.rows[0]?.datdba !== externalRoleOids.get('workout_owner')
          )
            throw new Error('IDENTITY_DISPOSABLE_PG_OWNERSHIP_UNVERIFIED');
          await management.query(`DROP DATABASE "${externalDatabaseName}" WITH (FORCE)`);
          createdExternalDatabase = false;
        }
        for (const role of [...createdExternalRoles].reverse()) {
          const found = await management.query('SELECT oid FROM pg_roles WHERE rolname=$1', [role]);
          if (
            externalRoleOids.get(role) === undefined ||
            found.rows.length !== 1 ||
            found.rows[0]?.oid !== externalRoleOids.get(role)
          )
            throw new Error('IDENTITY_DISPOSABLE_PG_OWNERSHIP_UNVERIFIED');
          await management.query(`DROP ROLE "${role}"`);
          createdExternalRoles.splice(createdExternalRoles.indexOf(role), 1);
        }
      } finally {
        await management.end();
      }
    });
  }
  try {
    if (externalPg !== null) {
      const identity = await management.query(`SELECT current_database() AS database_name,
        current_user AS role_name,current_user=session_user AS direct_role,
        r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,
        current_setting('server_version_num')::integer AS server_version
        FROM pg_roles r WHERE r.rolname=current_user`);
      if (identity.rows.length !== 1) throw new Error('IDENTITY_DISPOSABLE_PG_ADMIN_INVALID');
      externalServerVersion = validateAiSettingsDisposableAdminIdentity(
        identity.rows[0],
        decodeURIComponent(externalPg.username),
      );
      const collisions = await management.query(
        'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($1)) AS roles, EXISTS(SELECT 1 FROM pg_database WHERE datname=$2) AS database',
        [[...fixedRoles], externalDatabaseName],
      );
      if (
        collisions.rows.length !== 1 ||
        collisions.rows[0]?.roles !== false ||
        collisions.rows[0]?.database !== false
      )
        throw new Error('IDENTITY_DISPOSABLE_PG_RESOURCE_COLLISION');
    }
    await createFixtureRole(management, 'workout_owner');
    await management.query(
      externalPg === null
        ? 'CREATE DATABASE workout_identity OWNER workout_owner'
        : `CREATE DATABASE "${externalDatabaseName}" OWNER workout_owner`,
    );
    if (externalPg !== null) {
      createdExternalDatabase = true;
      const found = await management.query('SELECT oid FROM pg_database WHERE datname=$1', [
        externalDatabaseName,
      ]);
      const oid: unknown = found.rows[0]?.oid;
      if (found.rows.length !== 1 || typeof oid !== 'number' || !Number.isInteger(oid) || oid <= 0)
        throw new Error('IDENTITY_DISPOSABLE_PG_OWNERSHIP_UNVERIFIED');
      externalDatabaseOid = oid;
    }
  } finally {
    if (externalPg === null) await management.end();
  }
  const endpoint = `localhost/workout_identity?host=${encodeURIComponent(directory)}`;
  function fixtureUrl(role: string) {
    if (externalPg === null) return `postgresql://${role}@${endpoint}`;
    const url = new URL(externalPg.toString());
    url.pathname = `/${externalDatabaseName}`;
    if (role !== 'admin') {
      url.username = role;
      url.password = externalRolePassword;
    }
    return url.toString();
  }
  const adminUrl = externalPg === null ? fixtureUrl('workout_admin') : fixtureUrl('admin');
  const ownerUrl = fixtureUrl('workout_owner');
  const runtimeUrl = fixtureUrl('workout_runtime');
  const workerUrl = fixtureUrl('workout_coaching_worker');
  const admin = new Pool({
    connectionString: adminUrl,
    ...(externalPg === null
      ? {}
      : {
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
          query_timeout: 12000,
        }),
  });
  try {
    await createFixtureRole(admin, 'workout_runtime');
    await admin.query('ALTER SCHEMA public OWNER TO workout_owner');
    await migrate(ownerUrl);
    if (stageRaceResults) {
      const owner = new Pool({ connectionString: ownerUrl, max: 1 });
      try {
        const role = await owner.query(
          'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
        );
        if (
          role.rows.length !== 1 ||
          role.rows[0]?.rolsuper !== false ||
          role.rows[0]?.rolbypassrls !== false
        )
          throw new Error('IDENTITY_RACE_RESULT_STAGE_OWNER_INVALID');
        const before = await owner.query(
          'SELECT version,checksum FROM schema_migrations ORDER BY version',
        );
        if (before.rows.length !== 107 || before.rows.at(-1)?.version !== 107)
          throw new Error('IDENTITY_RACE_RESULT_NORMAL_PROFILE_INVALID');
        await owner.query('BEGIN');
        try {
          for (const [filename, expected] of raceResultStageFiles) {
            const sql = await readFile(
              new URL(`../packages/server/persistence/migrations/${filename}`, import.meta.url),
            );
            if (createHash('sha256').update(sql).digest('hex') !== expected)
              throw new Error('IDENTITY_RACE_RESULT_STAGE_SHA_MISMATCH');
            await owner.query(sql.toString('utf8'));
          }
          const after = await owner.query(
            'SELECT version,checksum FROM schema_migrations ORDER BY version',
          );
          if (JSON.stringify(before.rows) !== JSON.stringify(after.rows))
            throw new Error('IDENTITY_RACE_RESULT_NORMAL_PROFILE_CHANGED');
          const table =
            await owner.query(`SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)=current_user AS owned
            FROM pg_class WHERE oid='public.race_result_proof_ref'::regclass`);
          if (
            table.rows.length !== 1 ||
            table.rows[0]?.relrowsecurity !== true ||
            table.rows[0]?.relforcerowsecurity !== true ||
            table.rows[0]?.owned !== true
          )
            throw new Error('IDENTITY_RACE_RESULT_STAGE_OWNER_INVALID');
          const functions =
            await owner.query(`SELECT pg_get_userbyid(proowner)=current_user AS owned,prosecdef,proconfig
            FROM pg_proc WHERE oid=ANY(ARRAY[
              'public.race_result_proof_source_suppressed(text,text,uuid)'::regprocedure,
              'public.guard_race_result_proof_body()'::regprocedure]::oid[])`);
          if (
            functions.rows.length !== 2 ||
            functions.rows.some(
              (row) =>
                row.owned !== true ||
                row.prosecdef !== true ||
                !Array.isArray(row.proconfig) ||
                !row.proconfig.includes('search_path=pg_catalog, pg_temp'),
            )
          )
            throw new Error('IDENTITY_RACE_RESULT_STAGE_FUNCTION_INVALID');
          await owner.query('COMMIT');
        } catch (error) {
          await owner.query('ROLLBACK');
          throw error;
        }
      } finally {
        await owner.end();
      }
    }
    const owners = await admin.query(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname IN
      ('openai_budget_fx_definition','openai_budget_price_definition','openai_budget_activation','openai_budget_month','openai_budget_reservation','openai_budget_journal')`);
    if (owners.rows.length !== 6 || owners.rows.some((row) => row.owner !== 'workout_owner'))
      throw new Error('IDENTITY_MIGRATION_OWNER_INVALID');
    const ownerRole = await admin.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='workout_owner'",
    );
    if (ownerRole.rows.length !== 1 || ownerRole.rows[0].rolsuper || ownerRole.rows[0].rolbypassrls)
      throw new Error('IDENTITY_MIGRATION_OWNER_INVALID');
    await grantIdentityFunctions(adminUrl, 'workout_runtime');
    await grantAiSettings(ownerUrl, 'workout_runtime');
    // Only synthetic unavailable catalog entries; no provider key, consent or activation.
    if (externalPg !== null) {
      const inspector = await admin.query(
        'SELECT oid,rolname FROM pg_roles WHERE rolname=current_user',
      );
      const normal = await admin.query(
        'SELECT version,checksum FROM public.schema_migrations ORDER BY version LIMIT 129',
      );
      aiSettingsExternalProof = parseDisposableAiSettingsPg17Proof({
        kind: 'disposable-pg17',
        runId: identityE2eRunId,
        harnessPid: process.pid,
        hostname: externalPg.hostname,
        port: Number(externalPg.port),
        databaseName: externalDatabaseName,
        databaseOid: externalDatabaseOid,
        ownerRoleOid: externalRoleOids.get('workout_owner'),
        adminRole: inspector.rows[0]?.rolname,
        adminRoleOid: inspector.rows[0]?.oid,
        serverVersionNum: externalServerVersion,
        credentialDigest: aiSettingsEphemeralCredentialDigest(externalRolePassword),
        normalMigrations: normal.rows,
      });
    }
    await publishInitialAiSettingsCatalog(ownerUrl, aiSettingsExternalProof);
    await grantOperations(adminUrl, 'workout_runtime');
    await grantNutritionCore(adminUrl, 'workout_runtime');
    await grantSupplementaryCore(adminUrl, 'workout_runtime');
    await grantRoutineCore(adminUrl, 'workout_runtime');
    await grantStretchingCore(adminUrl, 'workout_runtime');
    await grantRecoveryCore(adminUrl, 'workout_runtime');
    await grantCheckIns(adminUrl, 'workout_runtime');
    await grantSessionCompletions(adminUrl, 'workout_runtime');
    await grantPlanScenarios(adminUrl, 'workout_runtime');
    await grantCoachingConstraints(adminUrl, 'workout_runtime');
    await grantCoachingThreads(adminUrl, 'workout_runtime');
    await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
    await grantCoachingRuns(adminUrl, 'workout_runtime');
    await grantCoachingCandidates(adminUrl, 'workout_runtime');
    await grantIntegratedApprovalV4(adminUrl, 'workout_runtime');
    await grantResources(adminUrl, 'workout_runtime');
    await grantResourceRetrieval(adminUrl, 'workout_runtime');
    await grantGalleryMedia(adminUrl, 'workout_runtime');
    await grantActivityTracks(adminUrl, 'workout_runtime');
    await grantCourses(adminUrl, 'workout_runtime');
    await grantRaces(adminUrl, 'workout_runtime');
    if (stageRaceResults) {
      const acl = await admin.query(`SELECT
        has_function_privilege('workout_runtime','public.race_result_proof_source_suppressed(text,text,uuid)','EXECUTE') AS narrow_execute,
        has_function_privilege('workout_runtime','public.guard_race_result_proof_body()','EXECUTE') AS private_execute,
        has_table_privilege('workout_runtime','public.race_result_proof_ref','SELECT,INSERT,UPDATE,DELETE') AS private_table`);
      if (
        acl.rows.length !== 1 ||
        acl.rows[0]?.narrow_execute !== true ||
        acl.rows[0]?.private_execute !== false ||
        acl.rows[0]?.private_table !== false
      )
        throw new Error('IDENTITY_RACE_RESULT_STAGE_ACL_INVALID');
    }
    // This isolated, nonproduction fixture creates its own untrusted v3 analysis output.
    await admin.query('GRANT INSERT ON coaching_analysis_output TO workout_runtime');
    await createFixtureRole(admin, 'workout_coaching_worker');
    await grantCoachingRunWorker(adminUrl, 'workout_coaching_worker');
    await grantGarmin(adminUrl, 'workout_runtime');
    await grantGarminUnofficial(adminUrl, 'workout_runtime');
    await createFixtureRole(admin, 'workout_garmin_worker');
    await grantGarminWorker(adminUrl, 'workout_garmin_worker');
    // The course thumbnail renderer (M2-01l) runs as its own role with EXECUTE on eight
    // bounded functions and no table privileges, exactly as it would in production.
    await createFixtureRole(admin, 'workout_course_thumbnail_worker');
    await grantCourseThumbnailWorker(adminUrl, 'workout_course_thumbnail_worker');
    await admin.query('GRANT USAGE ON SCHEMA public TO workout_course_thumbnail_worker');
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
    JSON.stringify({
      databaseUrl: runtimeUrl,
      workerDatabaseUrl: workerUrl,
      // Lets a later harness tell this file from one a killed harness left behind.
      harnessPid: process.pid,
    }),
    { mode: 0o600 },
  );
  closers.push(() => rm(coachingWorkerContextPath, { force: true }));
  closers.push(
    await writeAiSettingsFixtureContext({
      ownerUrl,
      adminUrl,
      ...(aiSettingsExternalProof === undefined ? {} : { externalProof: aiSettingsExternalProof }),
    }),
  );
  // IDENTITY_E2E_OIDC=certified (opt-in, M2-01u) swaps the hand-written fixture for a
  // locally hosted OpenID Certified OP on the same issuer. Only
  // tests/identity/oidc-certified.spec.ts runs in that mode; every other spec signs in
  // through the fixture's account chooser.
  const oidcMode = process.env['IDENTITY_E2E_OIDC'] ?? 'fixture';
  if (oidcMode !== 'fixture' && oidcMode !== 'certified')
    throw new Error(`Unsupported IDENTITY_E2E_OIDC: ${oidcMode}`);
  let oidcSettings: typeof fixtureOidc = fixtureOidc;
  if (oidcMode === 'certified') {
    const certified = await startCertifiedOidc();
    closers.push(() => certified.close());
    await rm(certifiedOidcContextPath, { force: true });
    await writeFile(
      certifiedOidcContextPath,
      JSON.stringify({ passwords: certified.passwords, harnessPid: process.pid }),
      { mode: 0o600 },
    );
    closers.push(() => rm(certifiedOidcContextPath, { force: true }));
    oidcSettings = {
      issuer: certified.issuer,
      clientId: certified.clientId,
      clientSecret: certified.clientSecret,
      redirectUri: certified.redirectUri,
    };
    console.log('Identity E2E OIDC: locally hosted certified OP (oidc-provider).');
  } else {
    const providerServer = await startFixtureOidc();
    closers.push(() => providerServer.close());
  }
  // M1-06b-tmp: the temporary unofficial collector, owned by the fixture account "Carol".
  // Her account is created up front with a fixed id so the owner setting can name it, as a
  // deployment names its owner. The provider is the Python worker's synthetic one.
  if (oidcMode === 'fixture') {
    const owner = new Pool({ connectionString: adminUrl });
    try {
      await owner.query(
        'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
        [unofficialOwner.athleteId, fixtureOidc.issuer, unofficialOwner.subject],
      );
    } finally {
      await owner.end();
    }
  }
  await writeUnofficialScenario();
  closers.push(() => rm(unofficialScenarioPath(), { force: true }));
  const unofficialInterpreter = unofficialPython(join(import.meta.dirname, '..'));
  if (unofficialInterpreter === null)
    console.log(
      'Identity E2E: no Python environment (run `uv sync`); the unofficial Garmin collector is off.',
    );
  const garminServer = await startFixtureGarmin();
  closers.push(() => garminServer.close());
  const store = createIdentityRepository({ connectionString: runtimeUrl });
  closers.push(() => store.close());
  const database = createDatabase({ connectionString: runtimeUrl });
  closers.push(() => database.close());
  const sharingMode = process.env['IDENTITY_E2E_COURSE_SHARING'] ?? 'off';
  if (sharingMode !== 'on' && sharingMode !== 'off')
    throw new Error(`Unsupported IDENTITY_E2E_COURSE_SHARING: ${sharingMode}`);
  const courseSharing: CourseSharingConfiguration =
    sharingMode === 'on'
      ? {
          enabled: true,
          epoch: 1,
          rateKey: Buffer.alloc(32, 5),
          // The shells proxy from loopback; the E2E client is that loopback address.
          trustedProxies: [],
        }
      : courseSharingOff;
  const sharedCourseReader = courseSharing.enabled
    ? createSharedCourseReader({ connectionString: runtimeUrl })
    : undefined;
  if (sharedCourseReader) closers.push(() => sharedCourseReader.close());
  if (courseSharing.enabled) console.log('Identity E2E: course link sharing ON for this run.');
  const provider = await createOidcProvider({ ...oidcSettings, allowInsecureLocalhost: true });
  const identity = createIdentityService({
    store,
    provider,
    publicOrigin: identityWebOrigin,
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
    connectionString: fixtureUrl('workout_garmin_worker'),
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
  // One bounded render per tick, driven by the real lease/prepare/publish/finalize path.
  // Nothing about the screen knows this is running: it shows the drawn line until a stored
  // picture exists, which is the fallback this node is required to keep working.
  const thumbnailRenderer = createCourseThumbnailWorkerRepository({
    connectionString: fixtureUrl('workout_course_thumbnail_worker'),
  });
  closers.push(() => thumbnailRenderer.close());
  let renderRun: Promise<unknown> | undefined;
  const renderTimer = setInterval(() => {
    if (renderRun !== undefined) return;
    renderRun = (async () => {
      const lease = await thumbnailRenderer.lease(30);
      if (lease === null) return;
      const drawn = renderCourseThumbnail(lease.coordinates);
      const temporaryKey = createCourseThumbnailTemporaryObjectKey({
        tenantId: lease.athleteId,
        courseId: lease.courseId,
        jobId: lease.jobId,
      });
      const finalKey = createCourseThumbnailFinalObjectKey({
        tenantId: lease.athleteId,
        courseId: lease.courseId,
        revisionId: lease.revisionId,
        sha256: drawn.sha256,
      });
      await resourceStorage.delete(temporaryKey).catch(() => undefined);
      await resourceStorage.writeTemporary(
        temporaryKey,
        (async function* () {
          yield drawn.bytes;
        })(),
      );
      if (
        !(await thumbnailRenderer.prepare(lease, {
          storageRef: finalKey,
          sha256: drawn.sha256,
          byteSize: drawn.byteSize,
          vertexCount: drawn.vertexCount,
        }))
      )
        return;
      if (!(await thumbnailRenderer.publicationFenceOpen(lease))) return;
      await resourceStorage.publishTemporary(temporaryKey, finalKey, {
        sha256: drawn.sha256,
        sizeBytes: drawn.byteSize,
      });
      if ((await thumbnailRenderer.finalize(lease)) !== 'ready')
        await thumbnailRenderer.requeueRefs(lease);
    })()
      .catch(() => {
        console.error('Synthetic course thumbnail render retry pending.');
      })
      .finally(() => {
        renderRun = undefined;
      });
  }, 250);
  closers.push(async () => {
    clearInterval(renderTimer);
    await renderRun;
  });
  const jointApproval = createJointApprovalRepository(database, {
    policy: { id: 'running-core-v3-joint', version: '1' },
  });
  const integratedApprovalV4 = createIntegratedApprovalV4Repository(database, {
    policyVersion: 'running-core-v4-integrated:1',
  });
  const resourceStorage = await createLocalFilesystemObjectStorage(join(directory, 'resources'));
  // Present only when a dataset directory is configured for the run; otherwise place
  // search and elevation answer `no_dataset`, which is a state the screens show.
  const geoDatasets = await loadGeoDatasets();
  const geoDatasetsLicence = await readGeoDatasetsLicence(geoDatasets);
  const garminUnofficialStore = createGarminUnofficialStore(database);
  const activities = createActivityRepository(database);
  const garminUnofficial =
    unofficialInterpreter === null
      ? undefined
      : createGarminUnofficialService({
          ownerAthleteId: unofficialOwner.athleteId,
          store: garminUnofficialStore,
          worker: createGarminUnofficialWorker({
            python: unofficialInterpreter,
            fixture: unofficialScenarioPath(),
            minIntervalSeconds: 1,
          }),
          cipher: unofficialSessionCipher({
            activeKeyId: 'fixture-unofficial',
            keys: { 'fixture-unofficial': Buffer.alloc(32, 11).toString('base64') },
          }),
          profilePin: createGarminProfilePin(Buffer.alloc(32, 13)),
          activities,
        });
  garminUnofficial?.start();
  const api = createApi({
    auth: identity,
    identity,
    geoDatasetsLicence,
    ...(garminUnofficial === undefined ? {} : { garminUnofficial }),
    garminCollectionProvenance: garminUnofficialStore,
    garmin: createGarminService({
      store: createGarminStore(database),
      provider: garminProvider,
      cipher: garminCipher,
    }),
    consent: createConsentRepository(database),
    aiSettings: createAiSettingsService(createAiSettingsRepository(database)),
    planning: createPlanningRepository(database),
    races: createRaceRepository(database),
    ...(stageRaceResults ? { raceResultsV2: createRaceResultV2Repository(database) } : {}),
    nutrition: createNutritionRepository(database),
    restoreGeneration: createRestoreGenerationRepository(database),
    supplementary: createSupplementaryRepository(database),
    stretching: createStretchingRepository(database),
    routines: createRoutineRepository(database),
    recovery: createRecoveryRepository(database),
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
    integratedPlanner: createIntegratedPlannerRepository(database),
    jointApproval,
    integratedApprovalV4,
    jointFixture: createJointFixtureRepository(database, jointApproval, {
      enabled: true,
      environment: 'test',
    }),
    integratedFixtureV4: createIntegratedFixtureV4Repository(database, integratedApprovalV4, {
      enabled: true,
      environment: 'test',
    }),
    activities,
    activityContext: createActivityContextRepository(database),
    operations: createOperationsRepository(database),
    resources: createPrivateTextResourceRepository(database),
    resourceAccess: createResourceAccessRepository(database),
    resourceRetrieval: createResourceRetrievalRepository(database),
    resourceFiles: {
      uploads: createResourceFileUploadRepository(database),
      storage: resourceStorage,
    },
    galleryMedia: {
      media: createGalleryMediaRepository(database),
      storage: resourceStorage,
    },
    // Private recorded-track storage, so the stored-track route screen has a real track to
    // read. The server re-parses the bytes it stored in a heap-bounded worker.
    activityTracks: {
      tracks: createActivityTrackRepository(database),
      storage: resourceStorage,
      parser: createBoundedTrackParser(),
    },
    // The private course ledger reads the same stored derivative the route screen draws.
    courses: {
      courses: createCourseRepository(database),
      tracks: createActivityTrackRepository(database),
      storage: resourceStorage,
    },
    // M2-01j. The parse host is the real one: an imported file is parsed server-side under
    // the same heap ceiling and the same refusals a stored recording is. The datasets are
    // the ones `scripts/build-geo-datasets.mjs` produced when `GEO_DATA_DIR` names them,
    // and absent otherwise — in which case the screens say so rather than guessing.
    courseExtras: {
      courses: createCourseRepository(database),
      preferences: createCoursePreferenceRepository(database, {
        drawShareOffset: () => drawShareOffset(),
        shareTouchesNewZone: (snapshot, zone, offset) =>
          sharedLineTouchesCircle(snapshot, shareCircle(zone, offset)),
      }),
      parser: createBoundedTrackParser({ execArgv: ['--import', 'tsx'] }),
      places: geoDatasets.places,
      elevation: geoDatasets.elevation,
    },
    // By default a deterministic stand-in for the pedestrian engine. It exercises our side
    // of the port — bounds, proposal storage, review, explicit save — and is explicitly NOT
    // evidence about a real engine, a real graph or pedestrian coverage.
    // With IDENTITY_E2E_ROUTING=graphhopper (M2-01k) the port comes from the production
    // factory instead, through the same on-disk verification `configured.ts` uses; the
    // engine itself is started by the operator on loopback before this harness.
    ...(await identityWalkingRoutes(database)),
    // M2-01k-o. The privacy confirmation and the confirmed GPX, always. Link sharing is OFF
    // here exactly as in every shipped configuration, unless this run opts in with
    // IDENTITY_E2E_COURSE_SHARING=on (the test environment §8 names for the link specs).
    courseDisclosure: {
      sharing: createCourseSharingRepository(database, {
        drawShareOffset: () => drawShareOffset(),
      }),
      ...(courseSharing.enabled ? { links: { epoch: courseSharing.epoch } } : {}),
    },
    courseSharing,
    ...(sharedCourseReader === undefined ? {} : { sharedCourseReader }),
    checkIns: createCheckInRepository(database),
    dashboard: createDashboardRepository(database),
    allowedOrigins: [identityWebOrigin, identityMobileOrigin],
  });
  closers.push(() => api.close());
  await api.listen({ host: '127.0.0.1', port: identityApiPort });
  finishStartup();
  console.log(
    `Identity E2E ready: API ${identityApiPort}, OIDC fixture ${identityOidcPort}, Garmin fixture ${identityGarminPort}, private PostgreSQL.`,
  );
} catch (error) {
  finishStartup();
  await close();
  throw error;
}
