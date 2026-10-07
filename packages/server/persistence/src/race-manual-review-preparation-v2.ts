import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';
import type { SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  assembleRaceManualReviewCandidateCompatibleV4,
  raceManualReviewCandidateV2InputSchema,
  raceManualReviewCandidateV2ResultSchema,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
import { projectRaceRelativeScheduleImpactCompatibleV4 } from '@workout/server-coaching/race-relative-schedule-impact';
import type { Database, Transaction } from './database.js';
import {
  previewRacePlanImpactTransaction,
  RacePlanImpactPreviewError,
} from './race-plan-impact-preview.js';
import {
  createRacePlanImpactCapturedCalculationPorts,
  raceProjectionIntentSchema,
} from './race-plan-impact-projection-input.js';
import {
  raceImpactConsumedCaptureSchema,
  raceImpactConsumedScopeSchema,
  validateRaceImpactConsumedManifest,
} from './race-plan-impact-complete-manifest.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

const limitations = {
  storage: 'not_persisted' as const,
  sourceCompleteness: 'unverified' as const,
  approvalAllowed: false as const,
  authority: 'none' as const,
  freshness: 'not_checked' as const,
};
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4194304)
    throw new RacePlanImpactPreviewError('CONTEXT_LIMIT', 'decoded_bytes');
  return value;
}

// Only domain set arrays are normalized. Blueprint steps and actual progress
// retain their meaningful sequence; no general-purpose JSON array sorting.
function canonicalProjection(
  projection: Extract<
    ReturnType<typeof projectRaceRelativeScheduleImpactCompatibleV4>,
    { status: 'projected' }
  >,
) {
  const sort = <T>(rows: readonly T[], key: (row: T) => string) =>
    [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    ...projection,
    nutrition: sort(projection.nutrition, (row) => row.planVersionId).map((row) => ({
      ...row,
      items: sort(row.items, (item) => item.itemId),
    })),
    routines: sort(projection.routines, (row) => row.scheduleVersionId).map((row) => ({
      ...row,
      occurrences: sort(row.occurrences, (item) => item.id),
      runs: sort(row.runs, (item) => item.id),
      ...(row.state === 'affected'
        ? {
            projection: {
              ...row.projection,
              plannedOccurrences: sort(row.projection.plannedOccurrences, (item) => item.id),
              retainedOccurrences: sort(row.projection.retainedOccurrences, (item) => item.id),
              expansion:
                row.projection.expansion.state === 'expanded'
                  ? {
                      ...row.projection.expansion,
                      occurrences: sort(row.projection.expansion.occurrences, (item) => item.id),
                    }
                  : row.projection.expansion,
            },
          }
        : {}),
    })),
    completionReports: sort(projection.completionReports, (row) => row.sessionId),
  };
}

/** Same caller-owned fenced transaction throughout. No receipt, stored review,
 * source seal, legacy SQL106 or approval is produced. The supplied transaction
 * determines snapshot coherence; the service below requires the snapshot port. */
export async function prepareRaceManualReviewCompatibleV4In(
  tx: Transaction,
  unknownIntent: unknown,
  requestSourceBudget: SourceBudget = { bytes: 0n, sources: 0 },
) {
  validateRaceSourceResponseBudget(requestSourceBudget);
  const parsed = raceProjectionIntentSchema.safeParse(unknownIntent);
  if (!parsed.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
  const intent = bounded(parsed.data);
  const preview = await previewRacePlanImpactTransaction(tx, intent, requestSourceBudget);
  const decoded = raceImpactConsumedCaptureSchema.safeParse(preview.context);
  if (!decoded.success) throw new RacePlanImpactPreviewError('INVALID_CONTEXT');
  const context = decoded.data;
  if (
    context.athleteId !== tx.athleteId ||
    context.event.id !== intent.expectedEvent.id ||
    context.event.revision !== intent.expectedEvent.revision
  )
    throw new RacePlanImpactPreviewError('INVALID_CONTEXT');
  const app = context.manualBasis.app;
  if (app.state !== 'present' || !app.granted)
    return bounded({
      status: 'blocked' as const,
      stage: 'manual_basis' as const,
      reason: 'manual_admission_unavailable' as const,
      context,
      ...limitations,
    });
  const scope = raceImpactConsumedScopeSchema.parse({
    purpose: context.manualBasis.purpose,
    athleteId: context.athleteId,
    restoreGeneration: context.restoreGeneration,
    expectedEvent: { id: context.event.id, revision: context.event.revision },
    expectedPolicy: context.manualBasis.policy,
    expectedAppRevision: app.revision,
    expectedReadSetDigest: context.readSetDigest,
  });
  const consumedScope = validateRaceImpactConsumedManifest(context, scope);
  const base = { context, consumedScope, ...limitations };
  const projection = preview.projection;
  if (projection.status !== 'projected')
    return bounded({
      status: 'blocked' as const,
      stage: 'projection' as const,
      reason: projection.reason,
      missingFacts: projection.missingFacts,
      ...base,
    });
  if (
    context.calendarIntent === null ||
    context.calendarIntent === undefined ||
    impactDependencyDigest(context.calendarIntent) !== impactDependencyDigest(intent) ||
    impactDependencyDigest(context.collectorSelection) !==
      impactDependencyDigest(projection.collectorSelection) ||
    context.readSetDigest !== projection.readSetDigest
  )
    throw new RacePlanImpactPreviewError('INVALID_CONTEXT');
  const sourceInput = raceManualReviewCandidateV2InputSchema.parse({
    athleteId: tx.athleteId,
    binding: {
      purpose: scope.purpose,
      event: scope.expectedEvent,
      appRevision: scope.expectedAppRevision,
      policy: scope.expectedPolicy,
      restoreGeneration: scope.restoreGeneration,
      readSetDigest: scope.expectedReadSetDigest,
    },
    projectionInput: projection.input,
    sourceFacts: projection.sourceFacts,
  });
  bounded({ ...base, sourceInput });
  const ports = createRacePlanImpactCapturedCalculationPorts(preview.context);
  const projectedAgain = projectRaceRelativeScheduleImpactCompatibleV4(
    sourceInput.projectionInput,
    ports,
  );
  if (
    projectedAgain.status !== 'projected' ||
    impactDependencyDigest(projectedAgain) !== impactDependencyDigest(projection.projection)
  )
    throw new RacePlanImpactPreviewError('INVALID_CONTEXT');
  const candidate = raceManualReviewCandidateV2ResultSchema.parse(
    assembleRaceManualReviewCandidateCompatibleV4(sourceInput, ports),
  );
  if (candidate.status !== 'assembled_readonly')
    return bounded({
      status: 'blocked' as const,
      stage: 'assembly' as const,
      reason: candidate.reason,
      sourceInput,
      ...base,
    });
  if (
    impactDependencyDigest(canonicalProjection(projectedAgain)) !==
    impactDependencyDigest(candidate.body.projection)
  )
    throw new RacePlanImpactPreviewError('INVALID_CONTEXT');
  // Deterministic correspondence only; neither reassembly nor a digest proves
  // authenticated storage, subsequent freshness or permission to apply writes.
  const recomputed = raceManualReviewCandidateV2ResultSchema.parse(
    assembleRaceManualReviewCandidateCompatibleV4(sourceInput, ports),
  );
  if (JSON.stringify(candidate) !== JSON.stringify(recomputed))
    throw new RacePlanImpactPreviewError('INVALID_CONTEXT');
  return bounded({
    status:
      consumedScope.status === 'validated_read_scope'
        ? ('prepared_readonly' as const)
        : ('prepared_blocked' as const),
    sourceInput,
    candidate,
    correspondence: 'recomputed' as const,
    ...base,
  });
}

/** Explicit snapshot-only composition; no RC fallback or committed-preview reuse. */
export function createRaceManualReviewCompatibleV4PreparationService(database: Database) {
  return {
    async prepare(athleteId: string, unknownIntent: unknown) {
      const parsed = raceProjectionIntentSchema.safeParse(unknownIntent);
      if (!parsed.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
      bounded(parsed.data);
      const snapshot = database.snapshotTenant;
      if (!snapshot) throw new RacePlanImpactPreviewError('CONTEXT_UNAVAILABLE');
      return snapshot(athleteId, (tx) => prepareRaceManualReviewCompatibleV4In(tx, parsed.data));
    },
  };
}

export type RaceManualReviewCompatibleV4Preparation = Awaited<
  ReturnType<typeof prepareRaceManualReviewCompatibleV4In>
>;
