import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  installCurrentRuntimeV10,
  currentRuntimeV10ExtensionMembers,
  currentRuntimeV10ParentMembers,
  currentRuntimeV10ParentManifestSha256,
} from '@workout/server-persistence/current-runtime-installation-v10';
import {
  grantCurrentRuntimeV10Profile,
  currentRuntimeV10RpcSignatures,
} from '@workout/server-persistence/current-runtime-grants-v10';
import {
  grantCurrentRuntimeAppBaselineV2,
  currentRuntimeAppGrantRecipeV2,
} from '@workout/server-persistence/current-runtime-app-grants-v2';
import type { Database } from '@workout/server-persistence/database';
import { createNutritionRacePlanV4Writer } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { createNutritionRacePlanV4PreviewRepository } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { createRaceResultV2Repository } from '@workout/server-persistence/race-result-v2';
import { createRaceManualPooledPublicRepositoryV2 } from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import { createOperationsV38PooledRepository } from '@workout/server-persistence/operations';

/** Explicit disposable acceptance composition, never production admission.
 * Existing named fixture helpers retain their historical composition. */
export class IdentityInstalledCurrentRuntimeV10Error extends Error {
  constructor(
    readonly code: 'IDENTITY_CURRENT_INPUT_INVALID' | 'IDENTITY_CURRENT_PROFILE_INVALID',
  ) {
    super(code);
  }
}
function fail(code: IdentityInstalledCurrentRuntimeV10Error['code']): never {
  throw new IdentityInstalledCurrentRuntimeV10Error(code);
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
const extension = z.strictObject({
  extensionStep: z.literal(1),
  sourceDdlId: z.literal(146),
  filename: z.literal('146_race_event_local_date_approval_guard.sql'),
  sha256: z.literal('9969791a6c4f8fa3792697717acd5700a3e53aac1d2bd234dad1401985837582'),
});
const observedProfile = z.strictObject({
  profileVersion: z.literal(10),
  parentProfileVersion: z.literal(9),
  baselineSchemaVersion: z.literal(107),
  parentRuntimeStep: z.literal(25),
  extensionSteps: z.literal(1),
  runtimeStep: z.literal(26),
  sourceDdlTip: z.literal(146),
  parentManifestSha256: z.literal(currentRuntimeV10ParentManifestSha256),
  extensionMembers: z
    .array(extension)
    .length(1)
    .refine((value) => JSON.stringify(value) === JSON.stringify(currentRuntimeV10ExtensionMembers)),
  extensionReceipts: z
    .array(
      extension.extend({
        parentManifestSha256: z.literal(currentRuntimeV10ParentManifestSha256),
      }),
    )
    .length(1),
  parentAppliedMembers: z
    .array(
      z.strictObject({
        step: z.number().int(),
        sourceDdlId: z.number().int(),
        filename: z.string(),
        sha256: z.string(),
      }),
    )
    .length(32)
    .refine((value) => JSON.stringify(value) === JSON.stringify(currentRuntimeV10ParentMembers)),
  excludedTargetTransforms: z.tuple([z.literal(117), z.literal(119), z.literal(125)]),
  supported: z.literal(false),
  processingAuthority: z.literal('none'),
  catalogSecurity: z.literal('not_verified'),
  restore: z.literal('not_verified'),
});
const observedBound = createBoundedPlainJsonSchema(65536);
function profile(value: unknown) {
  const parsed = observedBound.pipe(observedProfile).safeParse(value);
  if (!parsed.success) fail('IDENTITY_CURRENT_PROFILE_INVALID');
  return parsed.data;
}
/** Fixed named production-baseline precursor only; no analysis INSERT,
 * worker membership or broad snapshot/history UPDATE/DELETE supplements.
 * Baseline grants use separate existing transactions. Failure is not atomic
 * across the whole setup; the disposable caller must tear down the database.
 * Parent installation and final42 grants each preserve their atomic protocol. */
export async function setupIdentityInstalledCurrentRuntimeV10(raw: unknown) {
  let input: z.infer<typeof setupInput>;
  try {
    createBoundedPlainJsonSchema(8192).parse(raw);
    input = setupInput.parse(raw);
  } catch {
    return fail('IDENTITY_CURRENT_INPUT_INVALID');
  }
  const installed = profile(await installCurrentRuntimeV10(input.ownerConnectionString));
  const baselineRaw: unknown = await grantCurrentRuntimeAppBaselineV2(
    input.ownerConnectionString,
    input.runtimeRole,
    'core',
  );
  const baselineParsed = observedBound
    .pipe(
      z.strictObject({
        recipeVersion: z.literal(2),
        atomicity: z.literal('separate_existing_grant_transactions'),
        recipe: z.literal(currentRuntimeAppGrantRecipeV2.name),
        deployment: z.literal('core'),
        runtimeRole: z.literal(input.runtimeRole),
        supported: z.literal(false),
        processingAuthority: z.literal('none'),
        catalogSecurity: z.literal('not_verified'),
        restore: z.literal('not_verified'),
      }),
    )
    .safeParse(baselineRaw);
  if (!baselineParsed.success) fail('IDENTITY_CURRENT_PROFILE_INVALID');
  const baseline = baselineParsed.data;
  const grantedRaw: unknown = await grantCurrentRuntimeV10Profile(
    input.ownerConnectionString,
    input.runtimeRole,
  );
  const grantedParsed = observedBound
    .pipe(
      z.strictObject({
        installation: observedProfile,
        runtimeRole: z.literal(input.runtimeRole),
        grantedFunctions: z.array(z.string()).length(42),
        supported: z.literal(false),
        processingAuthority: z.literal('none'),
        catalogSecurity: z.literal('not_verified'),
        restore: z.literal('not_verified'),
      }),
    )
    .safeParse(grantedRaw);
  if (!grantedParsed.success) fail('IDENTITY_CURRENT_PROFILE_INVALID');
  const granted = grantedParsed.data;
  const verified = profile(granted.installation);
  if (
    JSON.stringify(verified) !== JSON.stringify(installed) ||
    granted.catalogSecurity !== 'not_verified' ||
    granted.restore !== 'not_verified' ||
    granted.runtimeRole !== input.runtimeRole ||
    granted.supported !== false ||
    granted.processingAuthority !== 'none' ||
    granted.grantedFunctions.length !== 42 ||
    JSON.stringify(granted.grantedFunctions) !== JSON.stringify(currentRuntimeV10RpcSignatures)
  )
    fail('IDENTITY_CURRENT_PROFILE_INVALID');
  return Object.freeze({
    fixtureMode: 'installed-current-profile26' as const,
    ...verified,
    runtimeRole: granted.runtimeRole,
    rpcCount: granted.grantedFunctions.length,
    baselineRecipe: baseline.recipe,
    baselineAtomicity: baseline.atomicity,
    productionActivation: false as const,
    sourceExportBatch: 'installed_profile26_pooled_batch139' as const,
    analysisFixtureGrants: 'not_applied' as const,
  });
}
/** Only Root's explicit fixture composition consumes a trusted Database port.
 * No JSON capability/readiness boolean, handle, clock or hash grants authority.
 * Per-command services still enforce their authenticated snapshot/app policies.
 * SQL139, SQL142 and the SQL146 date guard are explicitly installed; pooled V38 and
 * public V2 are selected. */
export function composeIdentityInstalledCurrentRuntimeV10Ports(database: Database) {
  return {
    nutritionV4Writer: createNutritionRacePlanV4Writer(database),
    nutritionV4Preview: createNutritionRacePlanV4PreviewRepository(database),
    raceResultsV2: createRaceResultV2Repository(database),
    operations: createOperationsV38PooledRepository(database),
    raceManualPublic: createRaceManualPooledPublicRepositoryV2(database),
  };
}
