import type { Database } from './database.js';
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

/** Internal read/calculation transaction only. A preview is neither a stored review
 * nor approval authority. The caller supplies intent, never captured facts or IDs
 * of affected sessions. Retained read APIs remain separate from this processing gate. */
export function createRacePlanImpactPreviewService(database: Database) {
  function bounded<T>(result: T): T {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4 * 1024 * 1024)
      throw new RacePlanImpactPreviewError('CONTEXT_LIMIT', 'decoded_bytes');
    return result;
  }
  return {
    async preview(athleteId: string, unknownIntent: unknown) {
      const parsed = raceProjectionIntentSchema.safeParse(unknownIntent);
      if (!parsed.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
      const intent = parsed.data;
      try {
        // Database.tenant establishes global shared and lifecycle locks first.
        return await database.tenant(athleteId, async (tx) => {
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
          // Only the real calendar projector derives these IDs; recapture the full
          // affected source set in this same transaction before the final projection.
          const context = await captureRacePlanImpactContext(tx, {
            ...captureInput,
            selection: first.collectorSelection,
          });
          return bounded({
            context,
            projection: buildRacePlanImpactProjectionInput(context, intent),
          });
        });
      } catch (error) {
        if (error instanceof AppConsentRequiredError)
          throw new RacePlanImpactPreviewError('APP_CONSENT_REQUIRED');
        if (error instanceof RacePlanImpactContextError)
          throw new RacePlanImpactPreviewError(error.code, error.bound);
        if (error instanceof RacePlanImpactPreviewError) throw error;
        throw new RacePlanImpactPreviewError('CONTEXT_UNAVAILABLE');
      }
    },
  };
}
