import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  installCurrentRuntimeV5,
  currentRuntimeV5ExtensionMember,
  currentRuntimeV5ParentManifestSha256,
} from '@workout/server-persistence/current-runtime-installation-v5';
import {
  grantCurrentRuntimeV5Profile,
  currentRuntimeV5RpcSignatures,
} from '@workout/server-persistence/current-runtime-grants-v5';
import {
  grantCurrentRuntimeAppBaselineV1,
  currentRuntimeAppGrantRecipeV1,
} from '@workout/server-persistence/current-runtime-app-grants-v1';
import type { Database } from '@workout/server-persistence/database';
import { createNutritionRacePlanV4Writer } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { createNutritionRacePlanV4PreviewRepository } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { createRaceResultV2Repository } from '@workout/server-persistence/race-result-v2';
import { createRaceManualPublicRepository } from '@workout/server-persistence/race-manual-public';
import { createOperationsV38Repository } from '@workout/server-persistence/operations';

/** Explicit disposable acceptance composition, never production admission.
 * Existing installed-runtime17 mode and its parser are not modified. */
export class IdentityInstalledCurrentRuntimeError extends Error {
  constructor(
    readonly code: 'IDENTITY_CURRENT_INPUT_INVALID' | 'IDENTITY_CURRENT_PROFILE_INVALID',
  ) {
    super(code);
  }
}
function fail(code: IdentityInstalledCurrentRuntimeError['code']): never {
  throw new IdentityInstalledCurrentRuntimeError(code);
}
const setupInput = z.strictObject({
  ownerConnectionString: z
    .string()
    .min(1)
    .max(2048)
    .refine((raw) => {
      try {
        const url = new URL(raw);
        return (
          ['postgres:', 'postgresql:'].includes(url.protocol) &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
          url.username.length > 0 &&
          url.pathname.length > 1 &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  runtimeRole: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
});
const observedProfile = z.strictObject({
  profileVersion: z.literal(5),
  baselineSchemaVersion: z.literal(107),
  parentRuntimeStep: z.literal(20),
  runtimeStep: z.literal(21),
  sourceDdlTip: z.literal(131),
  parentManifestSha256: z.literal(currentRuntimeV5ParentManifestSha256),
  extensionMember: z.strictObject({
    extensionStep: z.literal(1),
    sourceDdlId: z.literal(131),
    filename: z.literal(currentRuntimeV5ExtensionMember.filename),
    sha256: z.literal(currentRuntimeV5ExtensionMember.sha256),
  }),
  supported: z.literal(false),
  processingAuthority: z.literal('none'),
  catalogSecurity: z.literal('not_verified'),
  restore: z.literal('not_verified'),
});
function profile(value: Awaited<ReturnType<typeof installCurrentRuntimeV5>>) {
  const parsed = observedProfile.safeParse({
    profileVersion: value.profileVersion,
    baselineSchemaVersion: value.baselineSchemaVersion,
    parentRuntimeStep: value.parentRuntimeStep,
    runtimeStep: value.runtimeStep,
    sourceDdlTip: value.sourceDdlTip,
    parentManifestSha256: value.parentManifestSha256,
    extensionMember: value.extensionMember,
    supported: value.supported,
    processingAuthority: value.processingAuthority,
    catalogSecurity: value.catalogSecurity,
    restore: value.restore,
  });
  if (!parsed.success) fail('IDENTITY_CURRENT_PROFILE_INVALID');
  return parsed.data;
}
/** Fixed named production-baseline precursor only; no analysis INSERT,
 * worker membership or broad snapshot/history UPDATE/DELETE supplements.
 * Baseline grants use separate existing transactions. Failure is not atomic
 * across the whole setup; the disposable caller must tear down the database.
 * Parent installation and final32 grants each preserve their atomic protocol. */
export async function setupIdentityInstalledCurrentRuntime(raw: unknown) {
  let input: z.infer<typeof setupInput>;
  try {
    createBoundedPlainJsonSchema(8192).parse(raw);
    input = setupInput.parse(raw);
  } catch {
    return fail('IDENTITY_CURRENT_INPUT_INVALID');
  }
  const installed = profile(await installCurrentRuntimeV5(input.ownerConnectionString));
  const baseline = await grantCurrentRuntimeAppBaselineV1(
    input.ownerConnectionString,
    input.runtimeRole,
    'core',
  );
  if (
    baseline.recipeVersion !== 1 ||
    baseline.atomicity !== 'separate_existing_grant_transactions' ||
    baseline.catalogSecurity !== 'not_verified' ||
    baseline.restore !== 'not_verified' ||
    baseline.recipe !== currentRuntimeAppGrantRecipeV1.name ||
    baseline.deployment !== 'core' ||
    baseline.runtimeRole !== input.runtimeRole ||
    baseline.supported !== false ||
    baseline.processingAuthority !== 'none'
  )
    fail('IDENTITY_CURRENT_PROFILE_INVALID');
  const granted = await grantCurrentRuntimeV5Profile(
    input.ownerConnectionString,
    input.runtimeRole,
  );
  const verified = profile(granted.installation);
  if (
    JSON.stringify(verified) !== JSON.stringify(installed) ||
    granted.catalogSecurity !== 'not_verified' ||
    granted.restore !== 'not_verified' ||
    granted.runtimeRole !== input.runtimeRole ||
    granted.supported !== false ||
    granted.processingAuthority !== 'none' ||
    granted.grantedFunctions.length !== 32 ||
    JSON.stringify(granted.grantedFunctions) !== JSON.stringify(currentRuntimeV5RpcSignatures)
  )
    fail('IDENTITY_CURRENT_PROFILE_INVALID');
  return Object.freeze({
    fixtureMode: 'installed-current-profile21' as const,
    ...verified,
    runtimeRole: granted.runtimeRole,
    rpcCount: granted.grantedFunctions.length,
    baselineRecipe: baseline.recipe,
    baselineAtomicity: baseline.atomicity,
    productionActivation: false as const,
    sourceExportBatch: 'not_installed_in_profile21' as const,
    analysisFixtureGrants: 'not_applied' as const,
  });
}
/** Only Root's explicit fixture composition consumes a trusted Database port.
 * No JSON capability/readiness boolean, handle, clock or hash grants authority.
 * Per-command services still enforce their authenticated snapshot/app policies.
 * New SQL132 is not installed or automatically selected by this helper. */
export function composeIdentityInstalledCurrentRuntimePorts(database: Database) {
  return {
    nutritionV4Writer: createNutritionRacePlanV4Writer(database),
    nutritionV4Preview: createNutritionRacePlanV4PreviewRepository(database),
    raceResultsV2: createRaceResultV2Repository(database),
    operations: createOperationsV38Repository(database),
    raceManualPublic: createRaceManualPublicRepository(database),
  };
}
