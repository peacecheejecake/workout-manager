import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import type { Database } from '@workout/server-persistence/database';
import {
  probeCurrentRuntimeSourceBuildReadinessV3,
  currentRuntimeSourceBuildReadinessV3Schema,
} from '@workout/server-persistence/current-runtime-source-build-readiness-v3';
import { createRaceManualPooledPublicRepositoryV2 } from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import { createOperationsV39PooledRepository } from '@workout/server-persistence/operations';
import { createNutritionRacePlanV4Writer } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { createNutritionRacePlanV4PreviewRepository } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { createRaceResultV2Repository } from '@workout/server-persistence/race-result-v2';

const boundedReadiness = createBoundedPlainJsonSchema(4096);

export class CurrentRuntimeSourceBuildRepositoriesV3Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_SOURCE_BUILD_V3_UNAVAILABLE'
      | 'CURRENT_RUNTIME_SOURCE_BUILD_V3_INCOMPATIBLE'
      | 'CURRENT_RUNTIME_SOURCE_BUILD_V3_INVALID_READINESS',
  ) {
    super(code);
  }
}

/** Startup composition for installed-current-profile27 from the configured
 * runtime Database only. Readiness v3 (profile V11, runtime step 27, source DDL
 * tip 148) is checked by the closed server probe, never supplied by a caller.
 * The account export is the pooled V39 reader, so export and erase cover the
 * gallery albums (143), renditions (144) and AI execution jobs (148) installed
 * by profile27. Each command still performs its own ownership, consent,
 * freshness and receipt validation. The configured owner retains Database
 * lifecycle ownership. */
export async function createCurrentRuntimeSourceBuildRepositoriesV3(database: Database) {
  let observed: unknown;
  try {
    observed = await probeCurrentRuntimeSourceBuildReadinessV3(database);
  } catch {
    throw new CurrentRuntimeSourceBuildRepositoriesV3Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V3_UNAVAILABLE',
    );
  }
  if (!boundedReadiness.safeParse(observed).success)
    throw new CurrentRuntimeSourceBuildRepositoriesV3Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V3_INVALID_READINESS',
    );
  const readiness = currentRuntimeSourceBuildReadinessV3Schema.safeParse(observed);
  if (!readiness.success)
    throw new CurrentRuntimeSourceBuildRepositoriesV3Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V3_INVALID_READINESS',
    );
  if (readiness.data.state === 'unavailable')
    throw new CurrentRuntimeSourceBuildRepositoriesV3Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V3_UNAVAILABLE',
    );
  if (readiness.data.state !== 'ready')
    throw new CurrentRuntimeSourceBuildRepositoriesV3Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V3_INCOMPATIBLE',
    );
  return {
    raceManualPublic: createRaceManualPooledPublicRepositoryV2(database),
    operations: createOperationsV39PooledRepository(database),
    nutritionV4Writer: createNutritionRacePlanV4Writer(database),
    nutritionV4Preview: createNutritionRacePlanV4PreviewRepository(database),
    raceResultsV2: createRaceResultV2Repository(database),
  };
}
