import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  installCurrentRuntimeV11,
  currentRuntimeV11ExtensionMembers,
  currentRuntimeV11ParentMembers,
  currentRuntimeV11ParentManifestSha256,
} from '@workout/server-persistence/current-runtime-installation-v11';
import {
  grantCurrentRuntimeV11Profile,
  grantCurrentRuntimeV11GalleryWorker,
  grantCurrentRuntimeV11AiDispatcher,
  currentRuntimeV11RpcSignatures,
  currentRuntimeV11RuntimeTableGrants,
  currentRuntimeV11WorkerRpcSignatures,
  currentRuntimeV11AiDispatcherTableGrants,
  currentRuntimeV11GalleryWorkerRole,
  currentRuntimeV11AiDispatcherRole,
} from '@workout/server-persistence/current-runtime-grants-v11';
import {
  grantCurrentRuntimeAppBaselineV2,
  currentRuntimeAppGrantRecipeV2,
} from '@workout/server-persistence/current-runtime-app-grants-v2';
import type { Database } from '@workout/server-persistence/database';
import { createNutritionRacePlanV4Writer } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { createNutritionRacePlanV4PreviewRepository } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { createRaceResultV2Repository } from '@workout/server-persistence/race-result-v2';
import { createRaceManualPooledPublicRepositoryV2 } from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import { createOperationsV40PooledRepository } from '@workout/server-persistence/operations';

/** Explicit disposable acceptance composition, never production admission.
 * Existing named fixture helpers retain their historical composition. */
export class IdentityInstalledCurrentRuntimeV11Error extends Error {
  constructor(
    readonly code: 'IDENTITY_CURRENT_INPUT_INVALID' | 'IDENTITY_CURRENT_PROFILE_INVALID',
  ) {
    super(code);
  }
}
function fail(code: IdentityInstalledCurrentRuntimeV11Error['code']): never {
  throw new IdentityInstalledCurrentRuntimeV11Error(code);
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
// The V11 extension roster (gallery 143/144/145, restore admission 147, AI job store 148)
// and the V10 parent manifest are pinned by the installer module itself; this fixture
// compares the observed rows to those exact exported constants, never to caller input.
const extension = z.strictObject({
  extensionStep: z.number().int().positive(),
  sourceDdlId: z.number().int().min(143).max(148),
  filename: z.string().regex(/^14[3-8]_[a-z0-9_]+\.sql$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const observedProfile = z.strictObject({
  profileVersion: z.literal(11),
  parentProfileVersion: z.literal(10),
  baselineSchemaVersion: z.literal(107),
  parentRuntimeStep: z.literal(26),
  extensionSteps: z.literal(currentRuntimeV11ExtensionMembers.length),
  runtimeStep: z.literal(27),
  sourceDdlTip: z.literal(148),
  parentManifestSha256: z.literal(currentRuntimeV11ParentManifestSha256),
  extensionMembers: z
    .array(extension)
    .length(currentRuntimeV11ExtensionMembers.length)
    .refine((value) => JSON.stringify(value) === JSON.stringify(currentRuntimeV11ExtensionMembers)),
  extensionReceipts: z
    .array(
      extension.extend({
        parentManifestSha256: z.literal(currentRuntimeV11ParentManifestSha256),
      }),
    )
    .length(currentRuntimeV11ExtensionMembers.length)
    .refine(
      (value) =>
        JSON.stringify(value.map(({ parentManifestSha256: _, ...member }) => member)) ===
        JSON.stringify(currentRuntimeV11ExtensionMembers),
    ),
  parentAppliedMembers: z
    .array(
      z.strictObject({
        step: z.number().int(),
        sourceDdlId: z.number().int(),
        filename: z.string(),
        sha256: z.string(),
      }),
    )
    .length(currentRuntimeV11ParentMembers.length)
    .refine((value) => JSON.stringify(value) === JSON.stringify(currentRuntimeV11ParentMembers)),
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
 * worker membership (the fixed gallery worker and AI dispatcher get only their own
 * exact grants) or broad
 * snapshot/history UPDATE/DELETE supplements.
 * Baseline grants use separate existing transactions. Failure is not atomic
 * across the whole setup; the disposable caller must tear down the database.
 * Parent installation and final V11 grants each preserve their atomic protocol. */
export async function setupIdentityInstalledCurrentRuntimeV11(raw: unknown) {
  let input: z.infer<typeof setupInput>;
  try {
    createBoundedPlainJsonSchema(8192).parse(raw);
    input = setupInput.parse(raw);
  } catch {
    return fail('IDENTITY_CURRENT_INPUT_INVALID');
  }
  const installed = profile(await installCurrentRuntimeV11(input.ownerConnectionString));
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
  const grantedRaw: unknown = await grantCurrentRuntimeV11Profile(
    input.ownerConnectionString,
    input.runtimeRole,
  );
  const grantedParsed = observedBound
    .pipe(
      z.strictObject({
        installation: observedProfile,
        runtimeRole: z.literal(input.runtimeRole),
        grantedFunctions: z.array(z.string()).length(currentRuntimeV11RpcSignatures.length),
        grantedTables: z.array(z.unknown()),
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
    granted.grantedFunctions.length !== currentRuntimeV11RpcSignatures.length ||
    JSON.stringify(granted.grantedFunctions) !== JSON.stringify(currentRuntimeV11RpcSignatures) ||
    JSON.stringify(granted.grantedTables) !== JSON.stringify(currentRuntimeV11RuntimeTableGrants)
  )
    fail('IDENTITY_CURRENT_PROFILE_INVALID');
  // The profile27 catalog always contains both fixed principals with their exact grants;
  // the harness creates the roles, and the grant helpers verify the resulting ACLs.
  const worker: unknown = await grantCurrentRuntimeV11GalleryWorker(
    input.ownerConnectionString,
    currentRuntimeV11GalleryWorkerRole,
  );
  const dispatcher: unknown = await grantCurrentRuntimeV11AiDispatcher(
    input.ownerConnectionString,
    currentRuntimeV11AiDispatcherRole,
  );
  const workerParsed = observedBound
    .pipe(
      z.looseObject({
        workerRole: z.literal(currentRuntimeV11GalleryWorkerRole),
        grantedFunctions: z.array(z.string()),
      }),
    )
    .safeParse(worker);
  const dispatcherParsed = observedBound
    .pipe(
      z.looseObject({
        dispatcherRole: z.literal(currentRuntimeV11AiDispatcherRole),
        grantedTables: z.array(z.unknown()),
      }),
    )
    .safeParse(dispatcher);
  if (
    !workerParsed.success ||
    !dispatcherParsed.success ||
    JSON.stringify(workerParsed.data.grantedFunctions) !==
      JSON.stringify(currentRuntimeV11WorkerRpcSignatures) ||
    JSON.stringify(dispatcherParsed.data.grantedTables) !==
      JSON.stringify(currentRuntimeV11AiDispatcherTableGrants)
  )
    fail('IDENTITY_CURRENT_PROFILE_INVALID');
  return Object.freeze({
    fixtureMode: 'installed-current-profile27' as const,
    ...verified,
    runtimeRole: granted.runtimeRole,
    rpcCount: granted.grantedFunctions.length,
    baselineRecipe: baseline.recipe,
    baselineAtomicity: baseline.atomicity,
    productionActivation: false as const,
    sourceExportBatch: 'installed_profile27_pooled_v40' as const,
    analysisFixtureGrants: 'not_applied' as const,
  });
}
/** Only Root's explicit fixture composition consumes a trusted Database port.
 * No JSON capability/readiness boolean, handle, clock or hash grants authority.
 * Per-command services still enforce their authenticated snapshot/app policies.
 * SQL139, SQL142, the SQL146 date guard and the profile27 members (143-148) are
 * explicitly installed; pooled V40 and public V2 are selected. */
export function composeIdentityInstalledCurrentRuntimeV11Ports(database: Database) {
  return {
    nutritionV4Writer: createNutritionRacePlanV4Writer(database),
    nutritionV4Preview: createNutritionRacePlanV4PreviewRepository(database),
    raceResultsV2: createRaceResultV2Repository(database),
    operations: createOperationsV40PooledRepository(database),
    raceManualPublic: createRaceManualPooledPublicRepositoryV2(database),
  };
}
