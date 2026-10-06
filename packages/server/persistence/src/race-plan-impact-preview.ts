import type { Database, Transaction } from './database.js';
import { AppConsentRequiredError, requireAppAdmission } from './app-admission.js';
import {
  captureRacePlanImpactContext,
  RacePlanImpactContextError,
} from './race-plan-impact-context.js';
import {
  buildRacePlanImpactProjectionInput,
  raceProjectionIntentSchema,
} from './race-plan-impact-projection-input.js';

export class RacePlanImpactPreviewError extends Error {
  constructor(
    readonly code: 'INVALID_INTENT' | 'APP_CONSENT_REQUIRED' | RacePlanImpactContextError['code'],
    readonly bound?: RacePlanImpactContextError['bound'],
  ) {
    super(code);
    this.name = 'RacePlanImpactPreviewError';
  }
}

function bounded<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4 * 1024 * 1024)
    throw new RacePlanImpactPreviewError('CONTEXT_LIMIT', 'decoded_bytes');
  return result;
}
function previewError(error: unknown): RacePlanImpactPreviewError {
  if (error instanceof AppConsentRequiredError)
    return new RacePlanImpactPreviewError('APP_CONSENT_REQUIRED');
  if (error instanceof RacePlanImpactContextError)
    return new RacePlanImpactPreviewError(error.code, error.bound);
  if (error instanceof RacePlanImpactPreviewError) return error;
  return new RacePlanImpactPreviewError('CONTEXT_UNAVAILABLE');
}

/** Caller owns the authenticated tenant transaction and its global/lifecycle locks.
 * No nested transaction, stored review, approval authority or actual write occurs. */
export async function previewRacePlanImpactTransaction(tx: Transaction, unknownIntent: unknown) {
  const parsed = raceProjectionIntentSchema.safeParse(unknownIntent);
  if (!parsed.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
  const intent = parsed.data;
  try {
    await requireAppAdmission(tx); // tenant0 remains held through calculation/commit
    const captureInput = {
      eventId: intent.expectedEvent.id,
      expectedRevision: intent.expectedEvent.revision,
    };
    const initial = await captureRacePlanImpactContext(tx, {
      ...captureInput,
      selection: { kind: 'keep_plan' },
    });
    if (
      intent.selection.kind === 'move_period' &&
      initial.currentTraining?.snapshot.id !== intent.selection.expectedCurrentPlanVersionId
    )
      throw new RacePlanImpactPreviewError('REVISION_CONFLICT');
    const first = buildRacePlanImpactProjectionInput(initial, intent);
    if (!('collectorSelection' in first) || first.collectorSelection.kind === 'keep_plan')
      return bounded({ context: initial, projection: first });
    // Only the real calendar projector derives IDs; recapture in the same transaction.
    const context = await captureRacePlanImpactContext(tx, {
      ...captureInput,
      selection: first.collectorSelection,
    });
    return bounded({ context, projection: buildRacePlanImpactProjectionInput(context, intent) });
  } catch (error) {
    throw previewError(error);
  }
}

/** Internal read/calculation transaction only. Retained reads remain separate
 * from this processing gate; user intent never supplies captured facts. */
export function createRacePlanImpactPreviewService(database: Database) {
  return {
    async preview(athleteId: string, unknownIntent: unknown) {
      // Preserve malformed-intent rejection before opening the tenant transaction.
      const parsed = raceProjectionIntentSchema.safeParse(unknownIntent);
      if (!parsed.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
      try {
        return await database.tenant(athleteId, (tx) =>
          previewRacePlanImpactTransaction(tx, parsed.data),
        );
      } catch (error) {
        throw previewError(error);
      }
    },
  };
}
