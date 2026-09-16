import { z } from 'zod';
import { createGarminCipher } from './garmin-crypto.js';
import { createGarminProvider } from './garmin-provider.js';

const schema = z.object({
  GARMIN_CLIENT_ID: z.string().min(1).max(16384).optional(),
  GARMIN_CLIENT_SECRET: z.string().min(1).max(16384).optional(),
  GARMIN_TOKEN_KEY_ID: z.string().min(1).max(80).optional(),
  GARMIN_TOKEN_KEYS_JSON: z.string().min(1).max(16384).optional(),
});

/** No provider configuration is a supported state; partial configuration fails closed. */
export function configuredGarmin(
  environment: unknown,
  publicOrigin: string,
  allowInsecureLocalhost = false,
) {
  const env = schema.parse(environment);
  const {
    GARMIN_CLIENT_ID: clientId,
    GARMIN_CLIENT_SECRET: clientSecret,
    GARMIN_TOKEN_KEY_ID: activeKeyId,
    GARMIN_TOKEN_KEYS_JSON: encodedKeys,
  } = env;
  if (Object.values(env).every((value) => value === undefined)) return null;
  if (!clientId || !clientSecret || !activeKeyId || !encodedKeys)
    throw new Error('INCOMPLETE_GARMIN_CONFIGURATION');
  let keys: Record<string, string>;
  try {
    keys = z.record(z.string(), z.string()).parse(JSON.parse(encodedKeys));
  } catch {
    throw new Error('INVALID_GARMIN_KEYS');
  }
  return {
    provider: createGarminProvider({
      clientId,
      clientSecret,
      redirectUri: new URL('/bff/v1/integrations/garmin/callback', publicOrigin).href,
      allowInsecureLocalhost,
    }),
    cipher: createGarminCipher({ activeKeyId, keys }),
  };
}
