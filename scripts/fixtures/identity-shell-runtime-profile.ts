/**
 * Identity harness only: the two web shells mirror the runtime profile of the fixture API they
 * front. The API fixture's profile is selected by IDENTITY_E2E_RACE_MANUAL_PUBLIC (set by
 * scripts/test-identity.mjs for the current-manual suite). Only profile27 registers the gallery
 * navigation/rendition routes, so only then do the shells enable that UI: Next reads
 * WORKOUT_RUNTIME_PROFILE at request time, the mobile shell bakes VITE_WORKOUT_RUNTIME_PROFILE at
 * build time. Every other fixture leaves both variables ABSENT (not empty), including when the
 * caller's own environment carried one. This is suite plumbing, not production readiness.
 */
export const identityShellProfile27 = 'installed-current-profile27' as const;
export type IdentityShellRuntimeProfile = typeof identityShellProfile27 | undefined;

export function identityShellRuntimeProfile(
  raceManualPublic: unknown,
): IdentityShellRuntimeProfile {
  return raceManualPublic === identityShellProfile27 ? identityShellProfile27 : undefined;
}

/**
 * Playwright merges each webServer `env` over the runner's process.env, and Node's spawn omits
 * an entry whose value is undefined, so `undefined` here unsets an inherited value.
 */
export function identityShellRuntimeProfileEnv(raceManualPublic: unknown) {
  const profile = identityShellRuntimeProfile(raceManualPublic);
  return {
    web: { WORKOUT_RUNTIME_PROFILE: profile } as Record<string, string>,
    mobile: { VITE_WORKOUT_RUNTIME_PROFILE: profile } as Record<string, string>,
  };
}

/** The mobile preview accepts only the exact profile27 value or absence; anything else fails. */
export function parseIdentityMobileBuildProfile(raw: unknown): IdentityShellRuntimeProfile {
  if (raw === undefined) return undefined;
  if (raw === identityShellProfile27) return identityShellProfile27;
  throw new Error('IDENTITY_MOBILE_RUNTIME_PROFILE_INVALID');
}
