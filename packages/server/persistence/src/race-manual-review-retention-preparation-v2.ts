import type { Database, Transaction } from './database.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';
import type { SourceBudget } from './race-plan-impact-nested-sources.js';
import { prepareRaceManualReviewFullOwnedBindingV2In } from './race-manual-review-full-owned-binding-consumer-v2.js';
import {
  prepareRaceManualReviewRetainedPayloadV2,
  raceManualReviewRetainedPayloadV2Schema,
} from './race-manual-review-retained-payload-v2.js';
import { raceProjectionIntentSchema } from './race-plan-impact-projection-input.js';
import { RacePlanImpactPreviewError } from './race-plan-impact-preview.js';

const limitations = {
  authority: 'none' as const,
  freshness: 'not_checked' as const,
  storage: 'not_persisted' as const,
  admissionAllowed: false as const,
  approvalAllowed: false as const,
  budgetCoverage: 'request_source_response_reservations' as const,
  aggregatePhysicalTransfer: 'not_verified' as const,
};
/** Produces a typed successor-storage input from actual same-snapshot read ports.
 * No receipt, lifecycle seal, candidate storage or processing authority is minted.
 * Serialized equivalents cannot establish the transaction correspondence here. */
export async function prepareRaceManualReviewRetentionV2In(
  tx: Transaction,
  unknownIntent: unknown,
  requestSourceBudget: SourceBudget,
) {
  validateRaceSourceResponseBudget(requestSourceBudget);
  const binding = await prepareRaceManualReviewFullOwnedBindingV2In(
    tx,
    unknownIntent,
    requestSourceBudget,
  );
  if (binding.status === 'blocked')
    return { ...limitations, status: 'blocked' as const, preparation: binding.preparation };
  const retained = raceManualReviewRetainedPayloadV2Schema.parse(
    prepareRaceManualReviewRetainedPayloadV2({
      state: 'present',
      preparation: {
        context: binding.preparation.context,
        sourceInput: binding.preparation.sourceInput,
        candidate: binding.preparation.candidate,
      },
      inventory: binding.inventory,
      dtoObservations: binding.owned,
      sqlObservations: binding.sqlObservation,
      currentAuthority: {
        authority: 'none',
        freshness: 'not_checked',
        permissionAuthority: 'none',
        lifecycleAuthority: 'none',
        admissionAllowed: false,
        approvalAllowed: false,
      },
    }),
  );
  // Preserve the original consumed-scope diagnosis; structural payload matching
  // cannot turn a blocked permission/source manifest into prepared_readonly.
  return {
    ...limitations,
    status:
      binding.status === 'observed_readonly' && retained.status === 'structurally_corresponding'
        ? ('prepared_readonly' as const)
        : ('blocked' as const),
    bindingStatus: binding.status,
    preparationStatus: binding.preparation.status,
    consumedScope: binding.preparation.consumedScope,
    retained,
  };
}
export type RaceManualReviewRetentionPreparationV2 = Awaited<
  ReturnType<typeof prepareRaceManualReviewRetentionV2In>
>;
/** Snapshot capability is mandatory, with no READ COMMITTED fallback. */
export function createRaceManualReviewRetentionV2Service(database: Database) {
  return {
    async prepare(
      athleteId: string,
      unknownIntent: unknown,
      requestSourceBudget: SourceBudget = { bytes: 0n, sources: 0 },
    ): Promise<RaceManualReviewRetentionPreparationV2> {
      const intent = raceProjectionIntentSchema.safeParse(unknownIntent);
      if (!intent.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
      validateRaceSourceResponseBudget(requestSourceBudget);
      const snapshot = database.snapshotTenant;
      if (!snapshot) throw new RacePlanImpactPreviewError('CONTEXT_UNAVAILABLE');
      return snapshot(athleteId, (tx) =>
        prepareRaceManualReviewRetentionV2In(tx, intent.data, requestSourceBudget),
      );
    },
  };
}
