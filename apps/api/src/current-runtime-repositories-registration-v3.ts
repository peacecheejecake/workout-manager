import type { Database } from '@workout/server-persistence/database';
import { createCurrentRuntimeSourceBuildRepositoriesV3 } from './current-runtime-source-build-repositories-v3.js';

/** Root-owned registration for installed-current-profile27. The selected proof
 * is fixed in these source bytes; requests and environment cannot select an
 * asset, hash, version or fallback. Command admission remains in each port. */
export async function createRegisteredCurrentRuntimeRepositoriesV3(database: Database) {
  return createCurrentRuntimeSourceBuildRepositoriesV3(database);
}
