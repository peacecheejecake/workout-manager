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
import { createNutritionRepository } from '@workout/server-persistence/nutrition-core';
import { createSupplementaryRepository } from '@workout/server-persistence/supplementary-core';
import { createStretchingRepository } from '@workout/server-persistence/stretching';
import { createRoutineRepository } from '@workout/server-persistence/routine-core';
import { createRecoveryRepository } from '@workout/server-persistence/recovery-core';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createCheckInRepository } from '@workout/server-persistence/check-ins';
import { createDashboardRepository } from '@workout/server-persistence/dashboard';
import { createOperationsRepository } from '@workout/server-persistence/operations';
import { createGalleryMediaRepository } from '@workout/server-persistence/gallery-media';
import { createActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import { createCourseRepository } from '@workout/server-persistence/courses';
import { createBoundedTrackParser } from '@workout/server-track-storage/parse-host';
import { createCoursePreferenceRepository } from '@workout/server-persistence/course-preferences';
import { loadGeoDatasets } from './geo-datasets.js';
import { createConfiguredWalkingRoutes } from './routing-deployment.js';
import { createPrivateTextResourceRepository } from '@workout/server-persistence/resources';
import { createResourceFileUploadRepository } from '@workout/server-persistence/resource-file-uploads';
import { createResourceUrlIngestionRepository } from '@workout/server-persistence/resource-url-ingestions';
import { createResourceAccessRepository } from '@workout/server-persistence/resource-access';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import { isAbsolute, parse, resolve } from 'node:path';
import { z } from 'zod';
import { createDatabase } from '@workout/server-persistence/database';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { createIdentityRepository } from '@workout/server-persistence/identity';
import { createIdentityService } from '@workout/server-identity/service';
import { createOidcProvider } from '@workout/server-identity/oidc';
import { configuredGarmin } from '@workout/server-identity/garmin-config';
import {
  createGarminService,
  createUnconfiguredGarminService,
} from '@workout/server-identity/garmin-service';
import { createGarminStore } from '@workout/server-persistence/garmin';
import { createApi } from './app.js';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  PUBLIC_ORIGIN: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  ALLOW_INSECURE_LOCALHOST: z.enum(['true', 'false']).default('false'),
  COACHING_FIXTURE_ENABLED: z.enum(['true', 'false']).default('false'),
  COACHING_FIXTURE_ID: z.string().optional(),
  PRIVATE_RESOURCE_STORAGE_ROOT: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value) && resolve(value) !== parse(value).root),
});

/** The supplied database role must be the restricted runtime role, never the migration owner. */
export async function createConfiguredApi(environment: unknown) {
  const env = environmentSchema.parse(environment);
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
  const provider = await createOidcProvider({
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: new URL('/bff/v1/auth/callback', env.PUBLIC_ORIGIN).href,
    allowInsecureLocalhost,
  });
  const database = createDatabase({ connectionString: env.DATABASE_URL });
  const store = createIdentityRepository({ connectionString: env.DATABASE_URL });
  try {
    const resourceStorage = await createLocalFilesystemObjectStorage(
      env.PRIVATE_RESOURCE_STORAGE_ROOT,
    );
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
    // The self-hosted pedestrian engine, verified against its graph manifest before any
    // route can be computed. Unset leaves the routing routes unregistered; half-set or
    // unverifiable refuses to start rather than serving under an unchecked identity.
    const routing = await createConfiguredWalkingRoutes(
      z.record(z.string(), z.unknown()).parse(environment),
    );
    const identity = createIdentityService({
      store,
      provider,
      publicOrigin: env.PUBLIC_ORIGIN,
      allowInsecureLocalhost,
    });
    return createApi({
      auth: identity,
      identity,
      garmin:
        garminConfiguration === null
          ? createUnconfiguredGarminService(createGarminStore(database))
          : createGarminService({ store: createGarminStore(database), ...garminConfiguration }),
      consent: createConsentRepository(database),
      planning: createPlanningRepository(database),
      nutrition: createNutritionRepository(database),
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
      activities: createActivityRepository(database),
      activityContext: createActivityContextRepository(database),
      checkIns: createCheckInRepository(database),
      dashboard: createDashboardRepository(database),
      operations: createOperationsRepository(database),
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
        preferences: createCoursePreferenceRepository(database),
        // The same bounded parse host stored recordings use: an imported file is parsed
        // under a real heap ceiling, a deadline and the same refusals.
        parser: createBoundedTrackParser(),
        // Absent unless a dataset directory is configured, and then place search and
        // elevation answer `no_dataset` rather than reaching for anyone else's service.
        places: geoDatasets.places,
        elevation: geoDatasets.elevation,
      },
      ...(routing === null ? {} : { walkingRoutes: routing.walkingRoutes }),
      activityTracks: {
        tracks: createActivityTrackRepository(database),
        storage: resourceStorage,
        // Server-side re-parsing runs in a worker with a real V8 heap ceiling; the
        // deployment's container memory limit bounds the process around it.
        parser: createBoundedTrackParser(),
      },
      resourceAccess: createResourceAccessRepository(database),
      resourceRetrieval: createResourceRetrievalRepository(database),
      allowedOrigins: [env.PUBLIC_ORIGIN],
      close: async () => {
        await Promise.all([store.close(), database.close()]);
      },
    });
  } catch (error) {
    await Promise.all([store.close(), database.close()]);
    throw error;
  }
}
