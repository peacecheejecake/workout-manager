import type { Database } from '@workout/server-persistence/database';
import { createCurrentRuntimeSourceBuildRepositoriesV2 } from './current-runtime-source-build-repositories-v2.js';

/** Root-owned registration for installed-current-profile26. The selected proof
 * is fixed in these source bytes; requests and environment cannot select an
 * asset, hash, version or fallback. Command admission remains in each port. */
export async function createRegisteredCurrentRuntimeRepositoriesV2(database: Database) {
  return createCurrentRuntimeSourceBuildRepositoriesV2(database);
}
