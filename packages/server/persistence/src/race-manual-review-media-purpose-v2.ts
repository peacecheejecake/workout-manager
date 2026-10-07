import { z } from 'zod';
import type { Transaction } from './database.js';
import { assertRaceManualSourcePurposePlainV2 } from './race-manual-review-source-purpose-adapters-v2.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  captureMediaRetainedReadFacts,
  validateMediaRetainedReadFacts,
  mediaRetainedReadFactsSchema,
} from './race-plan-impact-media-read-facts.js';
import { raceMediaCleanupSourceSchema } from './race-media-cleanup-source.js';
const uuid = z.uuid().transform((id) => id.toLowerCase());
const revision = z.number().int().positive().max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const raceManualMediaPurposeRequestV2Schema = z.strictObject({
  mediaItemId: uuid,
  expectedAccessRevision: revision,
  expectedDescriptorDigest: hash,
  expectedObjectIdentityDigest: hash,
});
/** Recorded processing consent and source correspondence, not provider/object authentication. */
export const raceManualMediaPurposeObservationV2Schema = z.strictObject({
  adapterVersion: z.literal(2),
  kind: z.literal('own_media_descriptor'),
  mediaItemId: uuid,
  accessRevision: revision,
  mediaConsent: z.strictObject({ kind: z.literal('media'), granted: z.literal(true), revision }),
  descriptorDigest: hash,
  originalObjectIdentityDigest: hash,
  originalLedger: mediaRetainedReadFactsSchema.shape.facts.element.shape.originalLedger.unwrap(),
  previewLedger: mediaRetainedReadFactsSchema.shape.facts.element.shape.previewLedger,
  cleanup: z.strictObject({
    digestVersion: z.literal('postgres-jsonb-v1'),
    sourceDigest: hash,
    state: z.literal('absent'),
    refs: raceMediaCleanupSourceSchema.shape.refs,
  }),
});
export const raceManualMediaPurposeReasonV2Schema = z.enum([
  'media_consent_required',
  'media_source_unavailable',
  'media_source_deleted',
  'media_source_tuple_mismatch',
  'media_cleanup_capability_unavailable',
  'media_cleanup_unavailable',
]);
const limitations = {
  authority: 'none',
  permissionAuthority: 'none',
  sourceAuthentication: 'unverified',
  freshness: 'not_checked',
  storage: 'not_persisted',
  admissionAllowed: false,
  approvalAllowed: false,
} as const;
/** Same fenced transaction and response budget as preparation. Expectations are
 * optimistic correspondence only: ownership/consent/finalization/deletion are
 * obtained from actual DB reads. Does not read object bytes or permit AI use. */
export async function captureRaceManualMediaPurposeV2In(
  tx: Transaction,
  unknownRequest: unknown,
  budget: SourceBudget,
) {
  assertRaceManualSourcePurposePlainV2(unknownRequest);
  const request = raceManualMediaPurposeRequestV2Schema.parse(unknownRequest);
  const blocked = (reason: z.infer<typeof raceManualMediaPurposeReasonV2Schema>) => ({
    status: 'blocked' as const,
    reason,
    observation: null,
    ...limitations,
  });
  reserveSourceBudget(budget, 1024n, 1);
  const consentRows = (
    await tx.query(
      "SELECT kind,granted,revision FROM consent WHERE athlete_id=$1 AND kind='media'",
      [tx.athleteId],
    )
  ).rows;
  const consents = z
    .array(z.strictObject({ kind: z.literal('media'), granted: z.boolean(), revision }))
    .max(1)
    .parse(consentRows);
  const consent = consents[0];
  if (!consent?.granted) return blocked('media_consent_required');
  const captured = await captureMediaRetainedReadFacts(tx, [request.mediaItemId], budget);
  const fact = captured.facts[0];
  if (!fact || fact.state === 'unavailable') return blocked('media_source_unavailable');
  if (fact.state === 'deleted' || fact.current?.deleted) return blocked('media_source_deleted');
  if (
    !fact.current ||
    fact.current.accessRevision !== request.expectedAccessRevision ||
    !fact.record ||
    !fact.originalLedger ||
    !fact.originalObjectIdentityDigest ||
    impactDependencyDigest(fact.record) !== request.expectedDescriptorDigest ||
    fact.originalObjectIdentityDigest !== request.expectedObjectIdentityDigest
  )
    return blocked('media_source_tuple_mismatch');
  if (
    fact.cleanup?.status === 'unavailable' &&
    fact.cleanup.reason === 'READ_CAPABILITY_UNAVAILABLE'
  )
    return blocked('media_cleanup_capability_unavailable');
  if (
    !fact.cleanup ||
    fact.cleanup.status !== 'available' ||
    validateMediaRetainedReadFacts(captured).status !== 'validated_read_sources' ||
    fact.cleanup.source.state !== 'absent'
  )
    return blocked('media_cleanup_unavailable');
  const observation = raceManualMediaPurposeObservationV2Schema.parse({
    adapterVersion: 2,
    kind: 'own_media_descriptor',
    mediaItemId: fact.current.mediaItemId,
    accessRevision: fact.current.accessRevision,
    mediaConsent: consent,
    descriptorDigest: impactDependencyDigest(fact.record),
    originalObjectIdentityDigest: fact.originalObjectIdentityDigest,
    originalLedger: fact.originalLedger,
    previewLedger: fact.previewLedger,
    cleanup: {
      digestVersion: fact.cleanup.source.digestVersion,
      sourceDigest: fact.cleanup.source.sourceDigest,
      state: fact.cleanup.source.state,
      refs: fact.cleanup.source.refs,
    },
  });
  const result = {
    status: 'observed_media_use' as const,
    reason: null,
    observation,
    ...limitations,
  };
  assertRaceManualSourcePurposePlainV2(result);
  return result;
}
