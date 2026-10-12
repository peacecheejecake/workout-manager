import { createRaceRepository } from '@workout/server-persistence/races';
import { createCoachingConstraintRepository } from '@workout/server-persistence/coaching-constraints';
import { createCoreEvidenceSnapshotRepository } from '@workout/server-persistence/evidence-snapshots';
import { createCoachingThreadRepository } from '@workout/server-persistence/coaching-threads';
import { createCoachingRunRepository } from '@workout/server-persistence/coaching-runs';
import { createResourceRetrievalRepository } from '@workout/server-persistence/resource-retrieval';
import { createTrainingCandidateRepository } from '@workout/server-persistence/coaching-candidates';
import { createSessionActualsRepository } from '@workout/server-persistence/session-actuals';
import { createPlanScenarioRepository } from '@workout/server-persistence/plan-scenarios';
import { createSessionCompletionRepository } from '@workout/server-persistence/session-completions';
import { createPeriodSummaryRepository } from '@workout/server-persistence/period-summary';
import { createIntegratedPlannerRepository } from '@workout/server-persistence/integrated-planner';
import { createJointApprovalRepository } from '@workout/server-persistence/joint-approval';
import { createIntegratedApprovalV4Repository } from '@workout/server-persistence/integrated-approval-v4';
import { createIntegratedFixtureV4Repository } from '@workout/server-persistence/integrated-fixture-v4';
import { createJointFixtureRepository } from '@workout/server-persistence/joint-fixture';
import { createActivityContextRepository } from '@workout/server-persistence/activity-context';
import { createPlanningRepository } from '@workout/server-persistence/planning';
import {
  createNutritionRepository,
  createNutritionPlanV4Reader,
} from '@workout/server-persistence/nutrition-core';
import { createSupplementaryRepository } from '@workout/server-persistence/supplementary-core';
import { createStretchingRepository } from '@workout/server-persistence/stretching';
import { createRoutineRepository } from '@workout/server-persistence/routine-core';
import { createRecoveryRepository } from '@workout/server-persistence/recovery-core';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createHealthKitDeregistrationRepository } from '@workout/server-persistence/healthkit-deregistration';
import { createHealthKitRegistrationRepository } from '@workout/server-persistence/healthkit-registration';
import { createHealthKitIngestionRepository } from '@workout/server-persistence/healthkit-ingestion';
import { createHealthKitBindingRepository } from '@workout/server-persistence/healthkit-binding';
import { createHealthKitActivityRepository } from '@workout/server-persistence/healthkit-activity';
import { createHealthKitProjectionRepository } from '@workout/server-persistence/healthkit-projection';
import { createCheckInRepository } from '@workout/server-persistence/check-ins';
import { createCheckInTemplateRepository } from '@workout/server-persistence/check-in-templates';
import { createDashboardRepository } from '@workout/server-persistence/dashboard';
import { createOperationsRepository } from '@workout/server-persistence/operations';
import { createRegisteredCurrentRuntimeRepositoriesV3 } from './current-runtime-repositories-registration-v3.js';
import { createVerifiedGalleryNavigationServices } from './gallery-navigation-services.js';
import { createVerifiedGalleryRenditionServices } from './gallery-rendition-services.js';
import { createAiExecutionJobService } from './ai-execution-job-routes.js';
import { createAiExecutionJobRepository } from '@workout/server-persistence/ai-execution-jobs';
import { createGalleryMediaRepository } from '@workout/server-persistence/gallery-media';
import { createActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import { createCourseRepository } from '@workout/server-persistence/courses';
import { createBoundedTrackParser } from '@workout/server-track-storage/parse-host';
import { createCoursePreferenceRepository } from '@workout/server-persistence/course-preferences';
import {
  createCourseSharingRepository,
  createSharedCourseReader,
} from '@workout/server-persistence/course-sharing';
import {
  drawShareOffset,
  shareCircles,
  sharedLineTouchesCircle,
} from '@workout/server-courses/disclosure';
import { courseSharingFromEnvironment } from './course-sharing.js';
import { loadGeoDatasets, readGeoDatasetsLicence } from './geo-datasets.js';
import {
  createConfiguredWalkingRoutes,
  type RoutingDeploymentSwitch,
} from './routing-deployment.js';
import {
  ROUTING_PERMIT_LEASE_MILLISECONDS,
  createConfiguredRoutingAdmission,
} from './routing-admission.js';
import { createPrivateTextResourceRepository } from '@workout/server-persistence/resources';
import { createResourceFileUploadRepository } from '@workout/server-persistence/resource-file-uploads';
import { createResourceUrlIngestionRepository } from '@workout/server-persistence/resource-url-ingestions';
import { createResourceAccessRepository } from '@workout/server-persistence/resource-access';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { isAbsolute, parse, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { createDatabase } from '@workout/server-persistence/database';
import { createRestoreGenerationRepository } from '@workout/server-persistence/restore-generation';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { createIdentityRepository } from '@workout/server-persistence/identity';
import { createIdentityService } from '@workout/server-identity/service';
import { createBackchannelLogoutService } from '@workout/server-identity/backchannel';
import { createOidcProvider } from '@workout/server-identity/oidc';
import { configuredGarmin } from '@workout/server-identity/garmin-config';
import {
  createGarminService,
  createUnconfiguredGarminService,
} from '@workout/server-identity/garmin-service';
import { createGarminStore } from '@workout/server-persistence/garmin';
import { createGarminUnofficialStore } from '@workout/server-persistence/garmin-unofficial';
import { createGarminUnofficialWorker } from '@workout/server-integrations/garmin-unofficial-worker';
import { createGarminUnofficialService } from '@workout/server-integrations/garmin-unofficial-service';
import { configuredGarminUnofficial } from './garmin-unofficial-deployment.js';
import { createApi } from './app.js';
import { createAiSettingsRepository } from '@workout/server-persistence/ai-settings';
import { createAiSettingsService } from './ai-settings-service.js';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  WORKOUT_RUNTIME_PROFILE: z
    .enum(['baseline107', 'installed-current-profile27'])
    .default('baseline107'),
  PUBLIC_ORIGIN: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  ALLOW_INSECURE_LOCALHOST: z.enum(['true', 'false']).default('false'),
  // M2-01w. Both default on; see docs/implementation/oidc-setup.md for when to turn off.
  OIDC_VERIFY_REAUTHENTICATION: z.enum(['true', 'false']).default('true'),
  OIDC_PROVIDER_LOGOUT: z.enum(['true', 'false']).default('true'),
  // Explicitly configured only after the app has registered this exact callback scheme.
  NATIVE_AUTH_REDIRECT_URI: z.literal('org.workoutmanager.app://auth/callback').optional(),
  COACHING_FIXTURE_ENABLED: z.enum(['true', 'false']).default('false'),
  COACHING_FIXTURE_ID: z.string().optional(),
  // M2-01k-c2. The deployed build, logged as `version` on every line. A bounded token so
  // the value can never carry anything but a release name.
  WORKOUT_RELEASE: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/)
    .optional(),
  PRIVATE_RESOURCE_STORAGE_ROOT: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value) && resolve(value) !== parse(value).root),
});

const oidcLogEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('oidc_discovery_failed'),
    reason: z.enum(['issuer_mismatch', 'insecure_endpoint', 'network', 'other']),
  }),
  z.object({
    event: z.literal('oidc_provider_logout_disabled'),
    reason: z.literal('insecure_endpoint'),
  }),
]);
const routingLogEventSchema = z.object({
  reason: z.enum(['engine_capacity', 'limiter_unavailable', 'limiter_contended']),
  engineInFlight: z.number().int().min(0).max(1024).nullable(),
  engineConcurrency: z.number().int().min(1).max(1024),
});
const garminLogEventSchema = z.object({
  event: z.enum([
    'garmin_collection_import_failed',
    'garmin_collection_activity_failed',
    'garmin_collection_failed',
    'garmin_collection_session_not_stored',
    'garmin_collection_finish_failed',
    'garmin_collection_finished',
    'garmin_unofficial_login_failed',
    'garmin_unofficial_profile_refused',
    'garmin_unofficial_connected',
    'garmin_unofficial_disconnected',
    'garmin_unofficial_sandbox_file_refused',
  ]),
  code: z.unknown().optional(),
  state: z
    .enum([
      'running',
      'succeeded',
      'partial',
      'rate_limited',
      'reconnect_required',
      'failed_transient',
      'failed_permanent',
      'cancelled',
    ])
    .optional(),
});
// Provider error names are arbitrary strings, even if they match a length/character bound.
const garminLogCodeSchema = z.enum([
  'auth',
  'mfa_invalid',
  'rate_limited',
  'CREDENTIAL_UNREADABLE',
  'RUNNER_ERROR',
  'NOT_FOUND',
  'PROTOCOL',
  'WORKER_ABORTED',
  'WORKER_EXITED',
  'WORKER_PROTOCOL',
  'WORKER_TIMEOUT',
  'MFA_EXPIRED',
  'SANDBOX_FILE_LEFT',
]);

/**
 * `process.env` is not a plain object (its prototype is not `Object.prototype`), and a zod 4
 * record refuses it with "expected record", so passing it straight through stopped the real
 * entrypoint from booting (M2-01aa). Copy its own entries into a plain object at the boundary.
 * Anything that is not a non-array object is left as it is, for the schema to refuse.
 */
function plainEnvironment(environment: unknown): unknown {
  return typeof environment === 'object' && environment !== null && !Array.isArray(environment)
    ? Object.fromEntries(Object.entries(environment))
    : environment;
}

export interface ConfiguredApiOptions {
  /**
   * Receives the blue/green routing control when routing is configured (M2-01k-e), so the
   * entrypoint can wire an operator trigger to it. Not called when routing is off.
   */
  readonly onRoutingDeployments?: (control: RoutingDeploymentSwitch) => void;
  /**
   * Where the API's structured log goes; stdout when unset. A probe seam (M2-01ah) so a probe
   * can read the operator events it asserts — `routing_admission_refused` above all — from
   * the production composition itself. The lines are the same redacted lines stdout gets.
   */
  readonly logStream?: Writable;
}

/** The supplied database role must be the restricted runtime role, never the migration owner. */
export async function createConfiguredApi(
  environment: unknown,
  options: ConfiguredApiOptions = {},
) {
  const env = environmentSchema.parse(environment);
  // One configuration-instance trace, unrelated to request/session/collector or CLI IDs.
  const runId = randomUUID();
  const version = env.WORKOUT_RELEASE ?? 'unreleased';
  let backgroundLog: Pick<FastifyBaseLogger, 'warn' | 'info'> | undefined;
  if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_LOCALHOST === 'true')
    throw new Error('Insecure production configuration');
  if (env.NODE_ENV === 'production' && env.COACHING_FIXTURE_ENABLED === 'true')
    throw new Error('Coaching fixture is unavailable in production');
  if (env.COACHING_FIXTURE_ENABLED === 'true' && env.COACHING_FIXTURE_ID !== 'synthetic-v1')
    throw new Error('Unsupported coaching fixture configuration');
  const allowInsecureLocalhost = env.ALLOW_INSECURE_LOCALHOST === 'true';
  const garminConfiguration = configuredGarmin(
    environment,
    env.PUBLIC_ORIGIN,
    allowInsecureLocalhost,
  );
  // M1-06b-tmp: the temporary unofficial owner-only collector. Null (off) unless configured,
  // and always null in CI.
  const garminUnofficialDeployment = configuredGarminUnofficial(environment);
  // Discovery failures carry only a fixed reason (never provider text). Before the API's
  // logger exists they go to stderr as the same one-line JSON.
  const provider = await createOidcProvider(
    {
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: new URL('/bff/v1/auth/callback', env.PUBLIC_ORIGIN).href,
      allowInsecureLocalhost,
      verifyReauthentication: env.OIDC_VERIFY_REAUTHENTICATION === 'true',
      providerLogout: env.OIDC_PROVIDER_LOGOUT === 'true',
    },
    {
      onEvent: (event) => {
        const parsed = oidcLogEventSchema.safeParse(event);
        const line = parsed.success
          ? { event: parsed.data.event, reason: parsed.data.reason, runId, version }
          : { event: 'oidc_event_refused', runId, version };
        if (backgroundLog === undefined) process.stderr.write(`${JSON.stringify(line)}\n`);
        else backgroundLog.warn(line);
      },
    },
  );
  // Discovery no longer blocks startup (M2-01w): an unreachable provider fails sign-in
  // closed, not the whole API. Warm it now; a failure is reported (onEvent) and retried on
  // the next sign-in.
  void provider.prepare?.().catch(() => undefined);
  // M2-01k-o B. Off unless `COURSE_SHARING=on`; on without an epoch, a rate key or the trusted
  // proxies refuses to start here, before any pool exists (B-4, B-5).
  const courseSharing = courseSharingFromEnvironment(
    z.record(z.string(), z.unknown()).parse(plainEnvironment(environment)),
  );
  const database = createDatabase({ connectionString: env.DATABASE_URL });
  const store = createIdentityRepository({ connectionString: env.DATABASE_URL });
  const sharedCourseReader = courseSharing.enabled
    ? createSharedCourseReader({ connectionString: env.DATABASE_URL })
    : undefined;
  // Server-side parsing runs in child processes with a real V8 heap ceiling (M2-01ai); the
  // deployment's container memory limit bounds the process tree around them. Each parser
  // runs at most its own concurrency bound of processes, and shutdown kills them.
  const courseImportParser = createBoundedTrackParser();
  const activityTrackParser = createBoundedTrackParser();
  const closeParsers = () => Promise.all([courseImportParser.close(), activityTrackParser.close()]);
  try {
    // M202-P1-02. Ports whose SQL exists only past the normal migration registry (107) are
    // composed only in the installed profile, after its cold-catalog/source-build readiness
    // passed. The race date-change review (SQL 122+) and check-in templates (SQL 123) are
    // absent under baseline107, so their routes are not registered and the date-change
    // capability answers false instead of advertising requests that cannot succeed. The
    // V34 account export reads only baseline tables and stays.
    //
    // Profile27 (V11, SQL tip 148) adds gallery albums/navigation (143), renditions (144)
    // and the AI execution job store (148). Gallery navigation and renditions are always on
    // in profile27 (no deployment flag); each is verified against the runtime role's exact
    // grants at startup and refuses to start rather than register over a missing or
    // over-granted installation. The V39 pooled export/erase covers the gallery members.
    const profile27 = env.WORKOUT_RUNTIME_PROFILE === 'installed-current-profile27';
    const runtimeRepositories = profile27
      ? {
          ...(await createRegisteredCurrentRuntimeRepositoriesV3(database)),
          checkInTemplates: createCheckInTemplateRepository(database),
          galleryNavigation: await createVerifiedGalleryNavigationServices(database),
          // M2-05a. Stores an immutable execution selection only; no provider adapter is
          // registered in this composition, so no job can be frozen until one is.
          aiExecutionJobs: createAiExecutionJobService(
            createAiExecutionJobRepository(database, {
              policy: { id: 'running-core-v2-training', version: '1' },
              registry: [],
            }),
          ),
        }
      : { operations: createOperationsRepository(database) };
    const resourceStorage = await createLocalFilesystemObjectStorage(
      env.PRIVATE_RESOURCE_STORAGE_ROOT,
    );
    const galleryRenditions = profile27
      ? {
          galleryRenditions: await createVerifiedGalleryRenditionServices(
            database,
            resourceStorage,
          ),
        }
      : {};
    const jointApproval = createJointApprovalRepository(database, {
      policy: { id: 'running-core-v3-joint', version: '1' },
    });
    const integratedApprovalV4 = createIntegratedApprovalV4Repository(database, {
      policyVersion: 'running-core-v4-integrated:1',
    });
    // Read once at startup. There is no request path into this: a dataset is a build
    // artifact in a configured directory, and an absent or malformed one leaves the
    // feature off rather than reaching for an external service.
    const geoDatasets = await loadGeoDatasets();
    const geoDatasetsLicence = await readGeoDatasetsLicence(geoDatasets);
    // The self-hosted pedestrian engine, verified against its graph manifest before any
    // route can be computed. Unset leaves the routing routes unregistered; half-set or
    // unverifiable refuses to start rather than serving under an unchecked identity.
    const routingEnvironment = z
      .record(z.string(), z.unknown())
      .parse(plainEnvironment(environment));
    // Every computation's permit comes from PostgreSQL, shared by every API instance, with
    // the engine capped over every tenant (M2-01ah). Refusals the operator must see — the
    // engine cap reached, the limiter unreachable — are logged without the tenant id; a
    // tenant hitting its own bound is the ordinary 429 and is not.
    const routingAdmission = createConfiguredRoutingAdmission(database, routingEnvironment, {
      onRefusal: (event) => {
        if (event.reason === 'rate' || event.reason === 'concurrency') return;
        const parsed = routingLogEventSchema.safeParse(event);
        const line = parsed.success
          ? {
              event: 'routing_admission_refused',
              reason: parsed.data.reason,
              engineInFlight: parsed.data.engineInFlight,
              engineConcurrency: parsed.data.engineConcurrency,
              runId,
              version,
            }
          : { event: 'routing_admission_event_refused', runId, version };
        if (backgroundLog === undefined) process.stderr.write(`${JSON.stringify(line)}\n`);
        else backgroundLog.warn(line);
      },
    });
    const routing = await createConfiguredWalkingRoutes(routingEnvironment, {
      admission: routingAdmission,
    });
    if (routing !== null) options.onRoutingDeployments?.(routing.deployments);
    const identity = createIdentityService({
      store,
      provider,
      publicOrigin: env.PUBLIC_ORIGIN,
      allowInsecureLocalhost,
      ...(env.NATIVE_AUTH_REDIRECT_URI === undefined
        ? {}
        : { native: { store, redirectUri: env.NATIVE_AUTH_REDIRECT_URI } }),
    });
    const backchannelLogout = createBackchannelLogoutService({ provider, store });
    const activities = createActivityRepository(database);
    const garminUnofficialStore = createGarminUnofficialStore(database);
    // Fixed event names and codes only; never provider text, a session or a password.
    const garminUnofficialEvent = (event: object) => {
      const parsed = garminLogEventSchema.safeParse(event);
      if (!parsed.success) {
        backgroundLog?.info({ event: 'garmin_unofficial_event_refused' });
        return;
      }
      const code = garminLogCodeSchema.safeParse(parsed.data.code);
      backgroundLog?.info({
        event: parsed.data.event,
        code: parsed.data.code === undefined ? undefined : code.success ? code.data : 'other',
        state: parsed.data.state,
      });
    };
    const garminUnofficial =
      garminUnofficialDeployment === null
        ? undefined
        : createGarminUnofficialService({
            ownerAthleteId: garminUnofficialDeployment.ownerAthleteId,
            store: garminUnofficialStore,
            worker: createGarminUnofficialWorker({
              python: garminUnofficialDeployment.python,
              onEvent: garminUnofficialEvent,
            }),
            cipher: garminUnofficialDeployment.cipher,
            profilePin: garminUnofficialDeployment.profilePin,
            activities,
            onEvent: garminUnofficialEvent,
          });
    const app = createApi({
      ...(env.WORKOUT_RELEASE === undefined ? {} : { version: env.WORKOUT_RELEASE }),
      ...(options.logStream === undefined ? {} : { logStream: options.logStream }),
      auth: identity,
      identity,
      backchannelLogout,
      garmin:
        garminConfiguration === null
          ? createUnconfiguredGarminService(createGarminStore(database))
          : createGarminService({ store: createGarminStore(database), ...garminConfiguration }),
      consent: createConsentRepository(database),
      aiSettings: createAiSettingsService(createAiSettingsRepository(database)),
      planning: createPlanningRepository(database),
      nutrition: createNutritionRepository(database),
      nutritionV4: createNutritionPlanV4Reader(database),
      restoreGeneration: createRestoreGenerationRepository(database),
      supplementary: createSupplementaryRepository(database),
      stretching: createStretchingRepository(database),
      routines: createRoutineRepository(database),
      recovery: createRecoveryRepository(database),
      planScenarios: createPlanScenarioRepository(database),
      coachingConstraints: createCoachingConstraintRepository(database),
      coachingThreads: createCoachingThreadRepository(database),
      ...(env.COACHING_FIXTURE_ENABLED === 'true'
        ? {
            coachingRuns: createCoachingRunRepository(database, {
              policy: { id: 'running-core-v2-training', version: '1' },
              source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
            }),
            coachingCandidates: createTrainingCandidateRepository(database, {
              policy: { id: 'running-core-v2-training', version: '1' },
              source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
            }),
          }
        : {}),
      evidenceSnapshots: createCoreEvidenceSnapshotRepository(database),
      sessionCompletions: createSessionCompletionRepository(database),
      sessionActuals: createSessionActualsRepository(database),
      periodSummary: createPeriodSummaryRepository(database),
      integratedPlanner: createIntegratedPlannerRepository(database),
      jointApproval,
      integratedApprovalV4,
      ...(env.COACHING_FIXTURE_ENABLED === 'true'
        ? {
            jointFixture: createJointFixtureRepository(database, jointApproval, {
              enabled: true,
              environment: env.NODE_ENV,
            }),
            integratedFixtureV4: createIntegratedFixtureV4Repository(
              database,
              integratedApprovalV4,
              { enabled: true, environment: env.NODE_ENV },
            ),
          }
        : {}),
      activities,
      races: createRaceRepository(database),
      healthKitRegistration: createHealthKitRegistrationRepository(database),
      healthKitDeregistration: createHealthKitDeregistrationRepository(database),
      healthKitIngestion: createHealthKitIngestionRepository(database),
      healthKitBinding: createHealthKitBindingRepository(database),
      healthKitActivity: createHealthKitActivityRepository(database),
      healthKitReview: createHealthKitProjectionRepository(database),
      ...(garminUnofficial === undefined ? {} : { garminUnofficial }),
      garminCollectionProvenance: garminUnofficialStore,
      activityContext: createActivityContextRepository(database),
      checkIns: createCheckInRepository(database),
      ...runtimeRepositories,
      ...galleryRenditions,
      dashboard: createDashboardRepository(database),
      resources: createPrivateTextResourceRepository(database),
      resourceFiles: {
        uploads: createResourceFileUploadRepository(database),
        storage: resourceStorage,
      },
      resourceUrls: createResourceUrlIngestionRepository(database),
      galleryMedia: {
        media: createGalleryMediaRepository(database),
        storage: resourceStorage,
      },
      courses: {
        courses: createCourseRepository(database),
        tracks: createActivityTrackRepository(database),
        storage: resourceStorage,
      },
      courseExtras: {
        courses: createCourseRepository(database),
        // A new protected area draws its secret share offset once and revokes every link
        // that touches its share circle, in the same transaction (M2-01k-o B-1, B-6).
        preferences: createCoursePreferenceRepository(database, {
          drawShareOffset: () => drawShareOffset(),
          shareTouchesNewZone: (snapshot, zone, offset) =>
            shareCircles(zone, offset).some((circle) => sharedLineTouchesCircle(snapshot, circle)),
        }),
        // The same bounded parse host stored recordings use: an imported file is parsed
        // under a real heap ceiling, a deadline and the same refusals.
        parser: courseImportParser,
        // Absent unless a dataset directory is configured, and then place search and
        // elevation answer `no_dataset` rather than reaching for anyone else's service.
        places: geoDatasets.places,
        elevation: geoDatasets.elevation,
      },
      // M2-01k-o. The privacy confirmation and the confirmed GPX are always on; link
      // management exists only with the flag, and the unauthenticated read serves only then.
      courseDisclosure: {
        sharing: createCourseSharingRepository(database, {
          drawShareOffset: () => drawShareOffset(),
        }),
        ...(courseSharing.enabled ? { links: { epoch: courseSharing.epoch } } : {}),
      },
      courseSharing,
      geoDatasetsLicence,
      mapDataScriptArtifacts: {
        ...(routing === null ? {} : { routing: () => routing.deployments.activeScriptArtifact }),
        ...(routingEnvironment['GEO_DATA_DIR'] === undefined
          ? {}
          : { geoDatasets: String(routingEnvironment['GEO_DATA_DIR']) }),
      },
      ...(sharedCourseReader === undefined ? {} : { sharedCourseReader }),
      ...(routing === null
        ? {}
        : {
            walkingRoutes: routing.walkingRoutes,
            // M0-06b-odbl: the public disclosure follows the ACTIVE deployment.
            mapDataDisclosure: () => routing.deployments.activeDisclosure,
          }),
      activityTracks: {
        tracks: createActivityTrackRepository(database),
        storage: resourceStorage,
        parser: activityTrackParser,
      },
      resourceAccess: createResourceAccessRepository(database),
      resourceRetrieval: createResourceRetrievalRepository(database),
      allowedOrigins: [env.PUBLIC_ORIGIN],
      close: async () => {
        // Permits whose engine search outlives the last answer are released when the engine
        // stops (M2-01ah); wait for that, bounded by their lease, before the pool goes away.
        //
        // The parsers close *together with* the drain, not after it (M2-01aj). Closing a
        // parser cancels its running parses and kills their processes at once; left until
        // after the drain, a parse would keep running for up to the permit lease on an API
        // that is shutting down. The two share nothing: a parser holds only its child
        // processes, and the drain waits only on routing permits released through the
        // database pool, which stays open until both have finished.
        await Promise.all([
          closeParsers(),
          routingAdmission.drain(ROUTING_PERMIT_LEASE_MILLISECONDS),
        ]);
        await Promise.all([store.close(), database.close(), sharedCourseReader?.close()]);
      },
    });
    backgroundLog = app.log.child({ runId });
    if (garminUnofficial !== undefined) {
      backgroundLog.info({ event: 'garmin_unofficial_enabled', official: false });
      garminUnofficial.start();
    }
    if (routing !== null)
      backgroundLog.info({
        event: 'routing_admission_configured',
        limiter: 'postgresql',
        engineConcurrency: routingAdmission.engineConcurrency,
      });
    return app;
  } catch (error) {
    await Promise.all([
      store.close(),
      database.close(),
      closeParsers(),
      sharedCourseReader?.close(),
    ]);
    throw error;
  }
}
