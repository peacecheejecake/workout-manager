import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import type { Database } from '@workout/server-persistence/database';
import {
  probeCurrentRuntimeSourceBuildReadinessV2,
  currentRuntimeSourceBuildReadinessV2Schema,
} from '@workout/server-persistence/current-runtime-source-build-readiness-v2';
import { createRaceManualPooledPublicRepositoryV2 } from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import { createOperationsV38PooledRepository } from '@workout/server-persistence/operations';
import { createNutritionRacePlanV4Writer } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { createNutritionRacePlanV4PreviewRepository } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { createRaceResultV2Repository } from '@workout/server-persistence/race-result-v2';

const boundedReadiness = createBoundedPlainJsonSchema(4096);

export class CurrentRuntimeSourceBuildRepositoriesV2Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE'
      | 'CURRENT_RUNTIME_SOURCE_BUILD_V2_INCOMPATIBLE'
      | 'CURRENT_RUNTIME_SOURCE_BUILD_V2_INVALID_READINESS',
  ) {
    super(code);
  }
}

/** Startup composition from the configured runtime Database only. Readiness is
 * checked by the closed server probe, never supplied by a caller. Each command
 * still performs its own ownership, consent, freshness and receipt validation.
 * The configured owner retains Database lifecycle ownership. */
export async function createCurrentRuntimeSourceBuildRepositoriesV2(database: Database) {
  let observed: unknown;
  try {
    observed = await probeCurrentRuntimeSourceBuildReadinessV2(database);
  } catch {
    throw new CurrentRuntimeSourceBuildRepositoriesV2Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE',
    );
  }
  if (!boundedReadiness.safeParse(observed).success)
    throw new CurrentRuntimeSourceBuildRepositoriesV2Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V2_INVALID_READINESS',
    );
  const readiness = currentRuntimeSourceBuildReadinessV2Schema.safeParse(observed);
  if (!readiness.success)
    throw new CurrentRuntimeSourceBuildRepositoriesV2Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V2_INVALID_READINESS',
    );
  if (readiness.data.state === 'unavailable')
    throw new CurrentRuntimeSourceBuildRepositoriesV2Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE',
    );
  if (readiness.data.state !== 'ready')
    throw new CurrentRuntimeSourceBuildRepositoriesV2Error(
      'CURRENT_RUNTIME_SOURCE_BUILD_V2_INCOMPATIBLE',
    );
  return {
    raceManualPublic: createRaceManualPooledPublicRepositoryV2(database),
    operations: createOperationsV38PooledRepository(database),
    nutritionV4Writer: createNutritionRacePlanV4Writer(database),
    nutritionV4Preview: createNutritionRacePlanV4PreviewRepository(database),
    raceResultsV2: createRaceResultV2Repository(database),
  };
}
