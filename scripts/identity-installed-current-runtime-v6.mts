import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  installCurrentRuntimeV6,
  currentRuntimeV6ExtensionMember,
  currentRuntimeV6ParentManifestSha256,
} from '@workout/server-persistence/current-runtime-installation-v6';
import {
  grantCurrentRuntimeV6Profile,
  currentRuntimeV6RpcSignatures,
} from '@workout/server-persistence/current-runtime-grants-v6';
import {
  grantCurrentRuntimeAppBaselineV2,
  currentRuntimeAppGrantRecipeV2,
} from '@workout/server-persistence/current-runtime-app-grants-v2';
import type { Database } from '@workout/server-persistence/database';
import { currentRuntimeMigrationMembers } from '@workout/server-persistence/current-runtime-installation';
import { currentRuntimeV2ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v2';
import { currentRuntimeV3ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v3';
import { currentRuntimeV4ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v4';
import { currentRuntimeV5ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v5';
import { createNutritionRacePlanV4Writer } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { createNutritionRacePlanV4PreviewRepository } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { createRaceResultV2Repository } from '@workout/server-persistence/race-result-v2';
import { createRaceManualPublicRepository } from '@workout/server-persistence/race-manual-public';
import { createOperationsV38BatchRepository } from '@workout/server-persistence/operations';

/** Explicit disposable acceptance composition, never production admission.
 * Existing installed-runtime17 and profile21 helpers are not modified. */
export class IdentityInstalledCurrentRuntimeV6Error extends Error {
  constructor(
    readonly code: 'IDENTITY_CURRENT_INPUT_INVALID' | 'IDENTITY_CURRENT_PROFILE_INVALID',
  ) {
    super(code);
  }
}
function fail(code: IdentityInstalledCurrentRuntimeV6Error['code']): never {
  throw new IdentityInstalledCurrentRuntimeV6Error(code);
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
const parentMembers = [
  ...currentRuntimeMigrationMembers,
  ...[
    currentRuntimeV2ExtensionMember,
    currentRuntimeV3ExtensionMember,
    currentRuntimeV4ExtensionMember,
    currentRuntimeV5ExtensionMember,
  ].map((member, index) => ({
    step: 18 + index,
    sourceDdlId: member.sourceDdlId,
    filename: member.filename,
    sha256: member.sha256,
  })),
];
const extension = z.strictObject({
  extensionStep: z.literal(1),
  sourceDdlId: z.literal(132),
  filename: z.literal(currentRuntimeV6ExtensionMember.filename),
  sha256: z.literal(currentRuntimeV6ExtensionMember.sha256),
});
const observedProfile = z.strictObject({
  profileVersion: z.literal(6),
  baselineSchemaVersion: z.literal(107),
  parentRuntimeStep: z.literal(21),
  extensionStep: z.literal(1),
  runtimeStep: z.literal(22),
  sourceDdlTip: z.literal(132),
  parentManifestSha256: z.literal(currentRuntimeV6ParentManifestSha256),
  extensionMember: extension,
  extensionReceipt: extension.extend({
    parentManifestSha256: z.literal(currentRuntimeV6ParentManifestSha256),
  }),
  parentAppliedMembers: z
    .array(
      z.strictObject({
        step: z.number().int(),
        sourceDdlId: z.number().int(),
        filename: z.string(),
        sha256: z.string(),
      }),
    )
    .length(21)
    .refine((value) => JSON.stringify(value) === JSON.stringify(parentMembers)),
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
 * Parent installation and final33 grants each preserve their atomic protocol. */
export async function setupIdentityInstalledCurrentRuntimeV6(raw: unknown) {
  let input: z.infer<typeof setupInput>;
  try {
    createBoundedPlainJsonSchema(8192).parse(raw);
    input = setupInput.parse(raw);
  } catch {
    return fail('IDENTITY_CURRENT_INPUT_INVALID');
  }
  const installed = profile(await installCurrentRuntimeV6(input.ownerConnectionString));
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
  const grantedRaw: unknown = await grantCurrentRuntimeV6Profile(
    input.ownerConnectionString,
    input.runtimeRole,
  );
  const grantedParsed = observedBound
    .pipe(
      z.strictObject({
        installation: observedProfile,
        runtimeRole: z.literal(input.runtimeRole),
        grantedFunctions: z.array(z.string()).length(33),
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
    granted.grantedFunctions.length !== 33 ||
    JSON.stringify(granted.grantedFunctions) !== JSON.stringify(currentRuntimeV6RpcSignatures)
  )
    fail('IDENTITY_CURRENT_PROFILE_INVALID');
  return Object.freeze({
    fixtureMode: 'installed-current-profile22' as const,
    ...verified,
    runtimeRole: granted.runtimeRole,
    rpcCount: granted.grantedFunctions.length,
    baselineRecipe: baseline.recipe,
    baselineAtomicity: baseline.atomicity,
    productionActivation: false as const,
    sourceExportBatch: 'installed_profile22_batch132' as const,
    analysisFixtureGrants: 'not_applied' as const,
  });
}
/** Only Root's explicit fixture composition consumes a trusted Database port.
 * No JSON capability/readiness boolean, handle, clock or hash grants authority.
 * Per-command services still enforce their authenticated snapshot/app policies.
 * SQL132 is explicitly installed and its batch composer is explicitly selected. */
export function composeIdentityInstalledCurrentRuntimeV6Ports(database: Database) {
  return {
    nutritionV4Writer: createNutritionRacePlanV4Writer(database),
    nutritionV4Preview: createNutritionRacePlanV4PreviewRepository(database),
    raceResultsV2: createRaceResultV2Repository(database),
    operations: createOperationsV38BatchRepository(database),
    raceManualPublic: createRaceManualPublicRepository(database),
  };
}
