import type { Database } from './database.js';
import { createRaceManualPooledPublicRepositoryForBundle } from './race-manual-public.js';
import { createRaceManualPooledApprovalRepositoryForBundle } from './race-manual-approval.js';

type Options = { now?: () => Date; createId?: () => string };
/** Private explicit composition only. SQL135–138 must be independently installed
 * and granted; this factory is neither runtime support nor processing admission.
 * Existing legacy factories retain their exact protocol/capability semantics. */
export function createRaceManualPooledPublicRepositoryV1(
  database: Database,
  options: Options = {},
) {
  return createRaceManualPooledPublicRepositoryForBundle(database, options);
}
export function createRaceManualPooledApprovalRepositoryV1(
  database: Database,
  options: Options = {},
) {
  return createRaceManualPooledApprovalRepositoryForBundle(database, options);
}
