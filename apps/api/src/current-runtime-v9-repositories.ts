import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import type { Database } from '@workout/server-persistence/database';
import {
  probeCurrentRuntimeReadinessV9,
  currentRuntimeReadinessV9Schema,
} from '@workout/server-persistence/current-runtime-readiness-v9';
import { createRaceManualPooledPublicRepositoryV2 } from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import { createOperationsV38PooledRepository } from '@workout/server-persistence/operations';

const boundedReadiness = createBoundedPlainJsonSchema(4096);

export class CurrentRuntimeV9RepositoriesError extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V9_UNAVAILABLE'
      | 'CURRENT_RUNTIME_V9_INCOMPATIBLE'
      | 'CURRENT_RUNTIME_V9_INVALID_READINESS',
  ) {
    super(code);
  }
}

/** Startup composition from the configured runtime Database only. Readiness is
 * checked by the closed server probe, never supplied by a caller. Each command
 * still performs its own ownership, consent, freshness and receipt validation.
 * The configured owner retains Database lifecycle ownership. */
export async function createCurrentRuntimeV9Repositories(database: Database) {
  let observed: unknown;
  try {
    observed = await probeCurrentRuntimeReadinessV9(database);
  } catch {
    throw new CurrentRuntimeV9RepositoriesError('CURRENT_RUNTIME_V9_UNAVAILABLE');
  }
  if (!boundedReadiness.safeParse(observed).success)
    throw new CurrentRuntimeV9RepositoriesError('CURRENT_RUNTIME_V9_INVALID_READINESS');
  const readiness = currentRuntimeReadinessV9Schema.safeParse(observed);
  if (!readiness.success)
    throw new CurrentRuntimeV9RepositoriesError('CURRENT_RUNTIME_V9_INVALID_READINESS');
  if (readiness.data.state === 'unavailable')
    throw new CurrentRuntimeV9RepositoriesError('CURRENT_RUNTIME_V9_UNAVAILABLE');
  if (readiness.data.state !== 'ready')
    throw new CurrentRuntimeV9RepositoriesError('CURRENT_RUNTIME_V9_INCOMPATIBLE');
  return {
    raceManualPublic: createRaceManualPooledPublicRepositoryV2(database),
    operations: createOperationsV38PooledRepository(database),
  };
}
