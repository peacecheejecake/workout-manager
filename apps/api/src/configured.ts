import { createPlanningRepository } from '@workout/server-persistence/planning';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { z } from 'zod';
import { createDatabase } from '@workout/server-persistence/database';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { createIdentityRepository } from '@workout/server-persistence/identity';
import { createIdentityService } from '@workout/server-identity/service';
import { createOidcProvider } from '@workout/server-identity/oidc';
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
});

/** The supplied database role must be the restricted runtime role, never the migration owner. */
export async function createConfiguredApi(environment: unknown) {
  const env = environmentSchema.parse(environment);
  if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_LOCALHOST === 'true')
    throw new Error('Insecure production configuration');
  const allowInsecureLocalhost = env.ALLOW_INSECURE_LOCALHOST === 'true';
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
      consent: createConsentRepository(database),
      planning: createPlanningRepository(database),
      activities: createActivityRepository(database),
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
