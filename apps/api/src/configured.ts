import { createCoachingConstraintRepository } from '@workout/server-persistence/coaching-constraints';
import { createCoreEvidenceSnapshotRepository } from '@workout/server-persistence/evidence-snapshots';
import { createCoachingThreadRepository } from '@workout/server-persistence/coaching-threads';
import { createCoachingRunRepository } from '@workout/server-persistence/coaching-runs';
import { createTrainingCandidateRepository } from '@workout/server-persistence/coaching-candidates';
import { createSessionActualsRepository } from '@workout/server-persistence/session-actuals';
import { createPlanScenarioRepository } from '@workout/server-persistence/plan-scenarios';
import { createSessionCompletionRepository } from '@workout/server-persistence/session-completions';
import { createPeriodSummaryRepository } from '@workout/server-persistence/period-summary';
import { createActivityContextRepository } from '@workout/server-persistence/activity-context';
import { createPlanningRepository } from '@workout/server-persistence/planning';
import { createNutritionRepository } from '@workout/server-persistence/nutrition-core';
import { createSupplementaryRepository } from '@workout/server-persistence/supplementary-core';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createCheckInRepository } from '@workout/server-persistence/check-ins';
import { createDashboardRepository } from '@workout/server-persistence/dashboard';
import { createOperationsRepository } from '@workout/server-persistence/operations';
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
      activities: createActivityRepository(database),
      activityContext: createActivityContextRepository(database),
      checkIns: createCheckInRepository(database),
      dashboard: createDashboardRepository(database),
      operations: createOperationsRepository(database),
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
