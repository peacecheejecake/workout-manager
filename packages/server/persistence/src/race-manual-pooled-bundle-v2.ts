import type { Database } from './database.js';
import { createRaceManualPooledDeltaPublicRepositoryForBundle } from './race-manual-public.js';
import { createRaceManualPooledDeltaApprovalRepositoryForBundle } from './race-manual-approval.js';

type Options = { now?: () => Date; createId?: () => string };
/** Named server protocol. Support and approval remain separate fresh gates. */
export function createRaceManualPooledPublicRepositoryV2(
  database: Database,
  options: Options = {},
) {
  return createRaceManualPooledDeltaPublicRepositoryForBundle(database, options);
}
export function createRaceManualPooledApprovalRepositoryV2(
  database: Database,
  options: Options = {},
) {
  return createRaceManualPooledDeltaApprovalRepositoryForBundle(database, options);
}
