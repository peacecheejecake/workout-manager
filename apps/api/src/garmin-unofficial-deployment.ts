import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createGarminCipher } from '@workout/server-identity/garmin-crypto';
import type { GarminCredentialCipher } from '@workout/server-integrations/garmin-collection';
import { createGarminProfilePin } from '@workout/server-integrations/garmin-unofficial-service';

/**
 * Deployment settings of the TEMPORARY, UNOFFICIAL owner-only Garmin collector (M1-06b-tmp).
 *
 * Off by default: with none of these set the adapter does not exist and its routes are not
 * registered. Partial configuration refuses to start. In CI (`CI` set to anything but an
 * empty string, `0` or `false`) it is off regardless of the other settings.
 *
 * - `GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID`: the ONE app account allowed to use it.
 * - `GARMIN_UNOFFICIAL_PYTHON`: absolute path of the Python interpreter of an environment
 *   installed with the optional `garmin` extra (`uv sync --extra garmin`).
 * - `GARMIN_UNOFFICIAL_TOKEN_KEY_ID`, `GARMIN_UNOFFICIAL_TOKEN_KEYS_JSON`: the AES-256-GCM
 *   keyring, in the same format as M1-06c's `GARMIN_TOKEN_KEYS_JSON`, supplied by the secret
 *   manager. The key is never stored in the repository or the database.
 * - `GARMIN_UNOFFICIAL_PROFILE_PIN_KEY`: base64 of at least 32 random bytes, the HMAC key of
 *   the pinned Garmin profile. Separate from the session keyring and NOT rotated with it:
 *   a new pin key makes the owner's own Garmin account look like a different one.
 */
const schema = z.object({
  GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim() === value)
    .optional(),
  GARMIN_UNOFFICIAL_PYTHON: z.string().min(1).max(4096).refine(isAbsolute).optional(),
  GARMIN_UNOFFICIAL_TOKEN_KEY_ID: z.string().min(1).max(80).optional(),
  GARMIN_UNOFFICIAL_TOKEN_KEYS_JSON: z.string().min(1).max(16384).optional(),
  GARMIN_UNOFFICIAL_PROFILE_PIN_KEY: z.string().min(1).max(1024).optional(),
  CI: z.string().optional(),
});

export interface GarminUnofficialDeployment {
  readonly ownerAthleteId: string;
  readonly python: string;
  readonly cipher: GarminCredentialCipher;
  readonly profilePin: (profileId: string) => string;
}

const sealedSchema = z.strictObject({ session: z.string().min(1).max(16_384) });
/** Bound into the AAD: an unofficial session never decrypts as an official credential. */
const UNOFFICIAL_SESSION_PURPOSE = 'unofficial-session' as const;

/** The session envelope, under its own AAD purpose: never readable as an OAuth credential. */
export function unofficialSessionCipher(options: {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
}): GarminCredentialCipher {
  const cipher = createGarminCipher(options);
  return {
    seal: (athleteId, session) =>
      cipher.encrypt(athleteId, UNOFFICIAL_SESSION_PURPOSE, { session }),
    open: (athleteId, sealed) =>
      sealedSchema.parse(cipher.decrypt(athleteId, UNOFFICIAL_SESSION_PURPOSE, sealed)).session,
  };
}

export function inContinuousIntegration(value: string | undefined): boolean {
  return value !== undefined && !['', '0', 'false'].includes(value.trim().toLowerCase());
}

export function configuredGarminUnofficial(
  environment: unknown,
): GarminUnofficialDeployment | null {
  const env = schema.parse(environment);
  if (inContinuousIntegration(env.CI)) return null;
  const {
    GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID: ownerAthleteId,
    GARMIN_UNOFFICIAL_PYTHON: python,
    GARMIN_UNOFFICIAL_TOKEN_KEY_ID: activeKeyId,
    GARMIN_UNOFFICIAL_TOKEN_KEYS_JSON: encodedKeys,
    GARMIN_UNOFFICIAL_PROFILE_PIN_KEY: pinKey,
  } = env;
  const values = [ownerAthleteId, python, activeKeyId, encodedKeys, pinKey];
  if (values.every((value) => value === undefined)) return null;
  if (!ownerAthleteId || !python || !activeKeyId || !encodedKeys || !pinKey)
    throw new Error('INCOMPLETE_GARMIN_UNOFFICIAL_CONFIGURATION');
  if (!z.string().base64().safeParse(pinKey).success)
    throw new Error('INVALID_GARMIN_UNOFFICIAL_PIN_KEY');
  const profilePin = createGarminProfilePin(Buffer.from(pinKey, 'base64'));
  let keys: Record<string, string>;
  try {
    keys = z.record(z.string(), z.string()).parse(JSON.parse(encodedKeys));
  } catch {
    throw new Error('INVALID_GARMIN_UNOFFICIAL_KEYS');
  }
  return {
    ownerAthleteId,
    python,
    cipher: unofficialSessionCipher({ activeKeyId, keys }),
    profilePin,
  };
}
