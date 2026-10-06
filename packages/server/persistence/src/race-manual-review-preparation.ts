import { assembleRaceManualReviewCandidate } from '@workout/server-coaching/race-manual-review-candidate';
import { verifyRaceManualReviewIntegrity } from '@workout/server-coaching/race-manual-review-integrity';
import type { Transaction } from './database.js';
import {
  previewRacePlanImpactTransaction,
  RacePlanImpactPreviewError,
} from './race-plan-impact-preview.js';
import { createRaceRelativeScheduleCalculationPorts } from './race-relative-schedule-calculation.js';

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4 * 1024 * 1024)
    throw new RacePlanImpactPreviewError('CONTEXT_LIMIT', 'decoded_bytes');
  return value;
}

/** Caller must supply its authenticated Database.tenant transaction. The shared
 * preview acquires app admission and keeps its lock through capture/calculation;
 * this function opens/commits no transaction and stores nothing. Consistent
 * integrity is not source completeness, live approval freshness or admission. */
export async function prepareRaceManualReview(tx: Transaction, unknownIntent: unknown) {
  const { context, projection } = await previewRacePlanImpactTransaction(tx, unknownIntent);
  const base = {
    context,
    storage: 'not_persisted' as const,
    sourceCompleteness: 'unverified' as const,
    approvalAllowed: false as const,
  };
  if (projection.status !== 'projected')
    return bounded({
      ...base,
      status: 'blocked' as const,
      stage: 'projection' as const,
      reason: projection.reason,
      missingFacts: projection.missingFacts,
    });
  const sourceInput = {
    athleteId: tx.athleteId,
    projectionInput: projection.input,
    sourceFacts: projection.sourceFacts,
  };
  const ports = createRaceRelativeScheduleCalculationPorts(context.consumedSources.races);
  const candidate = assembleRaceManualReviewCandidate(sourceInput, ports);
  if (candidate.status !== 'assembled')
    return bounded({
      ...base,
      status: 'blocked' as const,
      stage: 'assembly' as const,
      reason: candidate.reason,
      missingFacts: projection.missingFacts,
    });
  const binding = {
    athleteId: tx.athleteId,
    event: { id: context.event.id, revision: context.event.revision },
    readSetDigest: context.readSetDigest,
  };
  // Both bindings come from this same server capture, never an untrusted draft.
  const verified = verifyRaceManualReviewIntegrity(
    { candidate, sourceInput, capturedBinding: binding, expectedBinding: binding },
    ports,
  );
  if (verified.status !== 'consistent')
    return bounded({
      ...base,
      status: 'blocked' as const,
      stage: 'integrity' as const,
      reason: verified.reason,
      missingFacts: projection.missingFacts,
    });
  return bounded({
    ...base,
    status: 'prepared_blocked' as const,
    binding,
    sourceInput,
    candidate,
    missingFacts: projection.missingFacts,
    // Candidate is returned once; no duplicated health body in this metadata.
    integrity: {
      status: verified.status,
      readSetDigest: verified.readSetDigest,
      resolution: verified.resolution,
      sourceCompleteness: verified.sourceCompleteness,
      admissionAllowed: verified.admissionAllowed,
    },
  });
}
