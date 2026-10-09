import type { Database } from '@workout/server-persistence/database';
import { createCurrentRuntimeSourceBuildRepositoriesV1 } from './current-runtime-source-build-repositories-v1.js';

/** Root-owned registration for installed-current-profile25. The selected proof
 * is fixed in these source bytes; requests and environment cannot select an
 * asset, hash, version or fallback. Command admission remains in each port. */
export async function createRegisteredCurrentRuntimeRepositoriesV1(database: Database) {
  return createCurrentRuntimeSourceBuildRepositoriesV1(database);
}
