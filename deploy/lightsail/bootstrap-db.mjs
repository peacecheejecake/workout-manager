import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requirePersistence = createRequire(
  new URL('../../packages/server/persistence/package.json', import.meta.url),
);
const { Client } = requirePersistence('pg');

const roleVariables = Object.freeze([
  ['MIGRATION_DATABASE_URL', 'workout_owner'],
  ['WORKOUT_RUNTIME_DATABASE_URL', 'workout_runtime'],
  ['RESOURCE_CLEANUP_DATABASE_URL', 'workout_resource_cleanup_worker'],
  ['COURSE_THUMBNAIL_DATABASE_URL', 'workout_course_thumbnail_worker'],
  ['RESOURCE_URL_INGESTION_DATABASE_URL', 'workout_resource_ingestion_worker'],
]);

export function connection(value, expectedRole) {
  if (!value) throw new Error('DATABASE_SETUP_CONFIGURATION_INCOMPLETE');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_SETUP_URL_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    decodeURIComponent(url.username) !== expectedRole ||
    url.hostname !== 'wm-postgres' ||
    (url.port !== '' && url.port !== '5432') ||
    url.pathname !== '/workout' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('DATABASE_SETUP_URL_INVALID');
  }
  const password = decodeURIComponent(url.password);
  if (password.length < 24 || /[\r\n\0]/.test(password)) {
    throw new Error('DATABASE_SETUP_PASSWORD_INVALID');
  }
  return { value, password };
}

export async function createOrLimitRole(client, role, password) {
  if (!roleVariables.some(([, known]) => known === role)) {
    throw new Error('DATABASE_SETUP_ROLE_INVALID');
  }
  await client.query('BEGIN');
  try {
    // Keep passwords out of SQL text and application logs. The parameter is visible only to
    // PostgreSQL and the privileged one-shot setup process, never to the app/worker services.
    await client.query("SELECT set_config('workout.role_password', $1, true)", [password]);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          EXECUTE format(
            'ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
            '${role}', current_setting('workout.role_password')
          );
        ELSE
          EXECUTE format(
            'CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
            '${role}', current_setting('workout.role_password')
          );
        END IF;
      END $$;
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function bootstrap() {
  if (process.env.NODE_ENV !== 'production') throw new Error('DATABASE_SETUP_PRODUCTION_ONLY');
  const bootstrap = connection(process.env.POSTGRES_BOOTSTRAP_URL, 'postgres');
  const roles = roleVariables.map(([variable, role]) => [
    role,
    connection(process.env[variable], role),
  ]);
  const admin = new Client({ connectionString: bootstrap.value, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    const database = await admin.query('SELECT current_database() AS name');
    if (database.rows[0]?.name !== 'workout') throw new Error('DATABASE_SETUP_WRONG_DATABASE');
    for (const [role, credentials] of roles) {
      await createOrLimitRole(admin, role, credentials.password);
    }
    await admin.query('ALTER DATABASE workout OWNER TO workout_owner');
    await admin.query('ALTER SCHEMA public OWNER TO workout_owner');
  } finally {
    await admin.end();
  }

  const ownerUrl = roles[0][1].value;
  const migrations = await import('../../packages/server/persistence/src/migrate.ts');
  await migrations.migrate(ownerUrl);
  const owner = new Client({ connectionString: ownerUrl, connectionTimeoutMillis: 5000 });
  await owner.connect();
  try {
    await owner.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
    for (const role of roles.slice(2).map(([name]) => name)) {
      await owner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    }
    // These are the base tenant tables granted by the existing identity E2E harness;
    // subsequent feature grants below add only their own bounded surfaces.
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON
      consent,outbox,command_receipt,plan_head,plan_snapshot,plan_history,
      activity_canonical,activity_source_head,activity_source_revision,
      activity_overlay,activity_overlay_revision,activity_suppression,
      activity_import_receipt TO workout_runtime`);
  } finally {
    await owner.end();
  }

  const runtimeGrants = [
    'grantIdentityFunctions',
    'grantOperations',
    'grantNutritionCore',
    'grantSupplementaryCore',
    'grantRoutineCore',
    'grantStretchingCore',
    'grantRecoveryCore',
    'grantCheckIns',
    'grantSessionCompletions',
    'grantPlanScenarios',
    'grantCoachingConstraints',
    'grantCoachingThreads',
    'grantCoreEvidenceSnapshots',
    'grantCoachingRuns',
    'grantCoachingCandidates',
    'grantIntegratedApprovalV4',
    'grantResources',
    'grantResourceRetrieval',
    'grantGalleryMedia',
    'grantActivityTracks',
    'grantCourses',
    'grantGarmin',
    'grantHealthKitIngestion',
  ];
  for (const name of runtimeGrants) await migrations[name](ownerUrl, 'workout_runtime');
  await migrations.grantResourceObjectCleanupWorker(ownerUrl, 'workout_resource_cleanup_worker');
  await migrations.grantCourseThumbnailWorker(ownerUrl, 'workout_course_thumbnail_worker');
  await migrations.grantResourceUrlIngestionWorker(ownerUrl, 'workout_resource_ingestion_worker');

  const verify = new Client({ connectionString: bootstrap.value, connectionTimeoutMillis: 5000 });
  await verify.connect();
  try {
    const result = await verify.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [roles.map(([role]) => role)],
    );
    if (
      result.rows.length !== roles.length ||
      result.rows.some(
        (row) => row.rolsuper || row.rolbypassrls || row.rolcreatedb || row.rolcreaterole,
      )
    ) {
      throw new Error('DATABASE_SETUP_ROLE_VERIFICATION_FAILED');
    }
    const memberships = await verify.query(
      `SELECT member.rolname AS name
       FROM pg_auth_members membership
       JOIN pg_roles member ON member.oid = membership.member
       WHERE member.rolname = ANY($1::text[])`,
      [roles.map(([role]) => role)],
    );
    if (memberships.rows.length !== 0) {
      throw new Error('DATABASE_SETUP_ROLE_VERIFICATION_FAILED');
    }
  } finally {
    await verify.end();
  }
  process.stdout.write('DATABASE_SETUP_COMPLETE\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await bootstrap();
  } catch {
    // Error objects may include SQL, URLs, or credentials. Deliberately generic.
    process.stderr.write('DATABASE_SETUP_FAILED\n');
    process.exitCode = 1;
  }
}
