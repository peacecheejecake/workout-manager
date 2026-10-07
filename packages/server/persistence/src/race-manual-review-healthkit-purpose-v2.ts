import { z } from 'zod';
import { activityValuesSchema, activityOverlaySchema } from '@workout/contracts/activity';
import type { Transaction } from './database.js';
import { assertRaceManualSourcePurposePlainV2 } from './race-manual-review-source-purpose-adapters-v2.js';
import {
  impactDependencyDigest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
const uuid = z.uuid().transform((v) => v.toLowerCase()),
  revision = z.number().int().positive().max(2147483647),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.strictObject({
  kind: z.literal('healthkit'),
  sourceId: uuid,
  revision,
  contentHash: hash,
});
export const raceManualHealthKitPurposeRequestV2Schema = z.strictObject({
  activityId: uuid,
  canonicalRevision: revision,
  source,
  expectedOriginalDigest: hash,
  expectedOverlayDigest: hash.nullable(),
  expectedOverlayRevision: revision.nullable(),
});
/** Metadata only: exact current registration/source observations do not establish device truth. */
export const raceManualHealthKitPurposeObservationV2Schema = z
  .strictObject({
    adapterVersion: z.literal(2),
    kind: z.literal('own_healthkit_activity'),
    activityId: uuid,
    canonicalRevision: revision,
    source,
    originalDigest: hash,
    overlayDigest: hash.nullable(),
    overlayRevision: revision.nullable(),
    healthkitConsent: z.strictObject({
      kind: z.literal('healthkit'),
      granted: z.literal(true),
      revision,
    }),
    sample: z.strictObject({ id: uuid, state: z.literal('active'), payloadDigest: hash }),
    claim: z.strictObject({ epoch: uuid, consentRevision: revision }),
    lineage: z.literal('created_activity'),
    deregistration: z.strictObject({ state: z.literal('absent') }),
  })
  .superRefine((v, ctx) => {
    if (
      v.sample.id !== v.source.sourceId ||
      v.sample.payloadDigest !== v.source.contentHash ||
      v.claim.consentRevision !== v.healthkitConsent.revision ||
      (v.overlayDigest === null) !== (v.overlayRevision === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'HealthKit source/claim/consent correspondence required',
      });
  });
export const raceManualHealthKitPurposeReasonV2Schema = z.enum([
  'healthkit_consent_required',
  'healthkit_claim_unavailable',
  'healthkit_claim_epoch_stale',
  'healthkit_deregistration_pending',
  'healthkit_source_unavailable',
  'healthkit_source_deleted',
  'healthkit_source_tuple_mismatch',
  'healthkit_provenance_unavailable',
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
/** Server same fenced transaction only. Reads current individual processing grant,
 * global claim epoch and exact primary source; unused supplementary bindings are
 * not authentication. Raw sample/batch digest is separate from canonical DTO hash. */
export async function captureRaceManualHealthKitPurposeV2In(
  tx: Transaction,
  input: unknown,
  budget: SourceBudget,
) {
  assertRaceManualSourcePurposePlainV2(input);
  const p = raceManualHealthKitPurposeRequestV2Schema.safeParse(input);
  const blocked = (reason: z.infer<typeof raceManualHealthKitPurposeReasonV2Schema>) => ({
    status: 'blocked' as const,
    reason,
    observation: null,
    ...limitations,
  });
  if (!p.success) return blocked('healthkit_source_tuple_mismatch');
  const r = p.data;
  reserveSourceBudget(budget, 4096n, 1);
  const found = await tx.query(
    `SELECT c.id,c.revision,c.deleted,h.kind,h.source_id,h.source_revision,h.content_hash,v.content_hash AS revision_hash,
 EXISTS(SELECT 1 FROM activity_suppression x WHERE x.athlete_id=h.athlete_id AND x.kind=h.kind AND x.source_id=h.source_id) AS suppressed,
 (SELECT max(revision) FROM activity_overlay_revision x WHERE x.athlete_id=c.athlete_id AND x.activity_id=c.id) AS overlay_revision,
 k.granted AS consent_granted,k.revision AS consent_revision,s.state AS sample_state,s.payload_digest,l.state AS lineage_state,
 q.claim_epoch,q.consent_revision AS claim_consent_revision,
 EXISTS(SELECT 1 FROM healthkit_workout_deregistration d WHERE d.athlete_id=q.athlete_id AND d.sample_id=q.sample_id AND d.claim_epoch=q.claim_epoch AND d.state='pending_cleanup') AS deregistration_pending,
 (coalesce(octet_length(c.original::text),4)+coalesce(octet_length(o.values_json::text),4)+coalesce(octet_length(v.normalized_raw::text),4))::text AS bytes
 FROM activity_canonical c LEFT JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id
 LEFT JOIN activity_source_revision v ON v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision
 LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id
 LEFT JOIN consent k ON k.athlete_id=c.athlete_id AND k.kind='healthkit'
 LEFT JOIN healthkit_workout_sample s ON s.athlete_id=c.athlete_id AND s.sample_id::text=h.source_id AND h.kind='healthkit'
 LEFT JOIN healthkit_workout_lineage l ON l.athlete_id=s.athlete_id AND l.sample_id=s.sample_id
 LEFT JOIN healthkit_workout_claim q ON q.athlete_id=s.athlete_id AND q.sample_id=s.sample_id
 WHERE c.athlete_id=$1 AND c.id=$2::uuid`,
    [tx.athleteId, r.activityId],
  );
  if (found.rows.length === 0) return blocked('healthkit_source_unavailable');
  const m = z
    .array(
      z.strictObject({
        id: uuid,
        revision,
        deleted: z.boolean(),
        kind: z.string().nullable(),
        source_id: z.string().nullable(),
        source_revision: revision.nullable(),
        content_hash: hash.nullable(),
        revision_hash: hash.nullable(),
        suppressed: z.boolean(),
        overlay_revision: revision.nullable(),
        consent_granted: z.boolean().nullable(),
        consent_revision: revision.nullable(),
        sample_state: z.enum(['active', 'deleted']).nullable(),
        payload_digest: hash.nullable(),
        lineage_state: z
          .enum(['pending_review', 'linked_existing', 'created_activity', 'suppressed', 'deleted'])
          .nullable(),
        claim_epoch: uuid.nullable(),
        claim_consent_revision: revision.nullable(),
        deregistration_pending: z.boolean(),
        bytes: z.string().regex(/^\d+$/),
      }),
    )
    .length(1)
    .parse(found.rows)[0];
  if (!m) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (m.deleted || m.suppressed || m.sample_state === 'deleted')
    return blocked('healthkit_source_deleted');
  if (m.consent_granted !== true || m.consent_revision === null)
    return blocked('healthkit_consent_required');
  if (m.claim_epoch === null || m.claim_consent_revision === null)
    return blocked('healthkit_claim_unavailable');
  if (m.claim_consent_revision !== m.consent_revision)
    return blocked('healthkit_claim_epoch_stale');
  if (m.deregistration_pending) return blocked('healthkit_deregistration_pending');
  if (
    m.kind !== 'healthkit' ||
    !m.source_id ||
    m.sample_state !== 'active' ||
    m.lineage_state !== 'created_activity' ||
    m.payload_digest !== m.content_hash ||
    m.revision_hash !== m.content_hash ||
    !m.content_hash ||
    m.source_revision === null
  )
    return blocked('healthkit_provenance_unavailable');
  const actualSource = source.safeParse({
    kind: m.kind,
    sourceId: m.source_id,
    revision: m.source_revision,
    contentHash: m.content_hash,
  });
  if (
    !actualSource.success ||
    m.id !== r.activityId ||
    m.revision !== r.canonicalRevision ||
    impactDependencyDigest(actualSource.data) !== impactDependencyDigest(r.source) ||
    m.overlay_revision !== r.expectedOverlayRevision
  )
    return blocked('healthkit_source_tuple_mismatch');
  reserveSourceBudget(budget, BigInt(m.bytes) + 2048n, 1);
  const bodyRows = await tx.query(
    `SELECT c.original,o.values_json AS overlay,v.normalized_raw AS source_record FROM activity_canonical c JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id AND h.kind='healthkit' JOIN activity_source_revision v ON v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision AND v.content_hash=h.content_hash LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id=$2::uuid AND c.revision=$3 AND NOT c.deleted`,
    [tx.athleteId, r.activityId, r.canonicalRevision],
  );
  if (bodyRows.rows.length !== 1) return blocked('healthkit_source_unavailable');
  const body = z
    .strictObject({
      original: activityValuesSchema,
      overlay: activityOverlaySchema.nullable(),
      source_record: activityValuesSchema,
    })
    .parse(bodyRows.rows[0]);
  if (BigInt(Buffer.byteLength(JSON.stringify(body), 'utf8')) > BigInt(m.bytes) + 2048n)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const originalDigest = impactDependencyDigest(body.original),
    overlayDigest = body.overlay === null ? null : impactDependencyDigest(body.overlay);
  if (
    originalDigest !== impactDependencyDigest(body.source_record) ||
    originalDigest !== r.expectedOriginalDigest ||
    overlayDigest !== r.expectedOverlayDigest
  )
    return blocked('healthkit_source_tuple_mismatch');
  const observation = raceManualHealthKitPurposeObservationV2Schema.parse({
    adapterVersion: 2,
    kind: 'own_healthkit_activity',
    activityId: m.id,
    canonicalRevision: m.revision,
    source: actualSource.data,
    originalDigest,
    overlayDigest,
    overlayRevision: m.overlay_revision,
    healthkitConsent: { kind: 'healthkit', granted: true, revision: m.consent_revision },
    sample: { id: actualSource.data.sourceId, state: 'active', payloadDigest: m.payload_digest },
    claim: { epoch: m.claim_epoch, consentRevision: m.claim_consent_revision },
    lineage: m.lineage_state,
    deregistration: { state: 'absent' },
  });
  const result = {
    status: 'observed_healthkit_use' as const,
    reason: null,
    observation,
    ...limitations,
  };
  assertRaceManualSourcePurposePlainV2(result);
  return result;
}
