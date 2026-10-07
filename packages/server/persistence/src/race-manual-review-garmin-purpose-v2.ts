import { z } from 'zod';
import { activityValuesSchema, activityOverlaySchema } from '@workout/contracts/activity';
import type { Transaction } from './database.js';
import { requireAppAdmission, AppConsentRequiredError } from './app-admission.js';
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
  kind: z.literal('fit'),
  sourceId: z.string().min(1).max(200),
  revision,
  contentHash: hash,
});
export const raceManualGarminPurposeRequestV2Schema = z.strictObject({
  activityId: uuid,
  canonicalRevision: revision,
  source,
  expectedOriginalDigest: hash,
  expectedOverlayDigest: hash.nullable(),
  expectedOverlayRevision: revision.nullable(),
});
export type RaceManualGarminPurposeRequestV2 = z.infer<
  typeof raceManualGarminPurposeRequestV2Schema
>;
/** Metadata only: exact current collected source observations do not authenticate a provider. */
const garminObservationBodySchema = z.strictObject({
  adapterVersion: z.literal(2),
  kind: z.literal('owned_garmin_current_source'),
  activityId: uuid,
  canonicalRevision: revision,
  source,
  originalDigest: hash,
  overlayDigest: hash.nullable(),
  overlayRevision: revision.nullable(),
  collectionPermission: z.literal('not_captured'),
  collection: z.strictObject({
    garminActivityId: z.string().regex(/^[1-9][0-9]{0,23}$/),
    provider: z.enum(['garmin-connect-unofficial', 'garmin-official']),
    official: z.boolean(),
    outcome: z.enum(['imported', 'unchanged', 'stale']),
    collectedAt: z.iso.datetime({ offset: true }),
  }),
});
function validateGarminSourceCorrespondence(
  v: Pick<
    z.infer<typeof garminObservationBodySchema>,
    'collection' | 'overlayDigest' | 'overlayRevision'
  >,
  ctx: z.RefinementCtx,
) {
  if (
    v.collection.official !== (v.collection.provider === 'garmin-official') ||
    (v.overlayDigest === null) !== (v.overlayRevision === null)
  )
    ctx.addIssue({
      code: 'custom',
      message: 'Exact current collection/overlay correspondence required',
    });
}
export const raceManualGarminPurposeObservationV2Schema = garminObservationBodySchema.superRefine(
  validateGarminSourceCorrespondence,
);
export type RaceManualGarminPurposeObservationV2 = z.infer<
  typeof raceManualGarminPurposeObservationV2Schema
>;
export const raceManualGarminPurposeReasonV2Schema = z.enum([
  'garmin_core_app_processing_required',
  'garmin_source_unavailable',
  'garmin_source_deleted',
  'garmin_source_tuple_mismatch',
  'garmin_provenance_unavailable',
]);
const limitations = {
  authority: 'none',
  permissionAuthority: 'none',
  sourceAuthentication: 'unverified',
  freshness: 'not_checked',
  storage: 'not_persisted',
  applicable: false,
  admissionAllowed: false,
  approvalAllowed: false,
} as const;
/** Current owned collected FIT observations in a fenced same transaction.
 * Ledger attribution is not provider authentication or historical collection epoch.
 * Connection status/credential TTL and AI consent do not grant manual processing. */
export async function captureRaceManualGarminActivitySourceV2In(
  tx: Transaction,
  input: unknown,
  budget: SourceBudget,
) {
  assertRaceManualSourcePurposePlainV2(input);
  const p = raceManualGarminPurposeRequestV2Schema.safeParse(input);
  const blocked = (reason: z.infer<typeof raceManualGarminPurposeReasonV2Schema>) => ({
    status: 'blocked' as const,
    reason,
    observation: null,
    ...limitations,
  });
  if (!p.success) return blocked('garmin_source_tuple_mismatch');
  const r = p.data;
  reserveSourceBudget(budget, 4096n, 1);
  const found = await tx.query(
    `SELECT c.id,c.revision,c.deleted,h.kind,h.source_id,h.source_revision,h.content_hash,
    v.content_hash AS revision_hash,
    EXISTS(SELECT 1 FROM activity_suppression x WHERE x.athlete_id=h.athlete_id AND x.kind=h.kind AND x.source_id=h.source_id) AS suppressed,
    (SELECT max(revision) FROM activity_overlay_revision x WHERE x.athlete_id=c.athlete_id AND x.activity_id=c.id) AS overlay_revision,
    g.garmin_activity_id,g.provider,g.official,g.outcome,g.collected_at,
    (coalesce(octet_length(c.original::text),4)+coalesce(octet_length(o.values_json::text),4)+coalesce(octet_length(v.normalized_raw::text),4))::text AS bytes
    FROM activity_canonical c LEFT JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id
    LEFT JOIN activity_source_revision v ON v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision
    LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id
    LEFT JOIN garmin_activity_ledger_source l ON l.athlete_id=h.athlete_id AND l.kind=h.kind AND l.source_id=h.source_id
    LEFT JOIN garmin_activity_ledger g ON g.athlete_id=l.athlete_id AND g.garmin_activity_id=l.garmin_activity_id
    WHERE c.athlete_id=$1 AND c.id=$2::uuid LIMIT 2`,
    [tx.athleteId, r.activityId],
  );
  if (found.rows.length === 0) return blocked('garmin_source_unavailable');
  if (found.rows.length !== 1) return blocked('garmin_provenance_unavailable');
  const m = z
    .strictObject({
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
      garmin_activity_id: z.string().nullable(),
      provider: z.enum(['garmin-connect-unofficial', 'garmin-official']).nullable(),
      official: z.boolean().nullable(),
      outcome: z.enum(['imported', 'unchanged', 'stale', 'suppressed']).nullable(),
      collected_at: z.date().nullable(),
      bytes: z.string().regex(/^\d+$/),
    })
    .parse(found.rows[0]);
  if (m.deleted || m.suppressed || m.outcome === 'suppressed')
    return blocked('garmin_source_deleted');
  if (
    m.kind !== 'fit' ||
    !m.source_id ||
    !m.content_hash ||
    m.source_revision === null ||
    m.revision_hash !== m.content_hash ||
    !m.garmin_activity_id ||
    !m.provider ||
    m.official !== (m.provider === 'garmin-official') ||
    !m.outcome ||
    !m.collected_at
  )
    return blocked('garmin_provenance_unavailable');
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
    return blocked('garmin_source_tuple_mismatch');
  reserveSourceBudget(budget, BigInt(m.bytes) + 2048n, 1);
  const bodyRows = await tx.query(
    `SELECT c.original,o.values_json AS overlay,v.normalized_raw AS source_record FROM activity_canonical c JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id AND h.kind='fit' JOIN activity_source_revision v ON v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision AND v.content_hash=h.content_hash JOIN garmin_activity_ledger_source l ON l.athlete_id=h.athlete_id AND l.kind=h.kind AND l.source_id=h.source_id JOIN garmin_activity_ledger g ON g.athlete_id=l.athlete_id AND g.garmin_activity_id=l.garmin_activity_id LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id=$2::uuid AND c.revision=$3 AND NOT c.deleted AND g.garmin_activity_id=$4 AND g.provider=$5 AND g.official=$6 AND g.outcome=$7 AND g.collected_at=$8 FOR SHARE OF c,h,v,l,g`,
    [
      tx.athleteId,
      r.activityId,
      r.canonicalRevision,
      m.garmin_activity_id,
      m.provider,
      m.official,
      m.outcome,
      m.collected_at,
    ],
  );
  if (bodyRows.rows.length !== 1) return blocked('garmin_source_unavailable');
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
    return blocked('garmin_source_tuple_mismatch');
  const observation = raceManualGarminPurposeObservationV2Schema.parse({
    adapterVersion: 2,
    kind: 'owned_garmin_current_source',
    activityId: m.id,
    canonicalRevision: m.revision,
    source: actualSource.data,
    originalDigest,
    overlayDigest,
    overlayRevision: m.overlay_revision,
    collectionPermission: 'not_captured',
    collection: {
      garminActivityId: m.garmin_activity_id,
      provider: m.provider,
      official: m.official,
      outcome: m.outcome,
      collectedAt: m.collected_at.toISOString(),
    },
  });
  const result = {
    status: 'observed_garmin_current_source' as const,
    reason: null,
    observation,
    ...limitations,
  };
  assertRaceManualSourcePurposePlainV2(result);
  return result;
}

/** Already-owned stored canonical core DTO use, distinct from new collection or
 * historical provider-raw authorization. Structural JSON is not a processing seal. */
export const raceManualGarminCorePurposeObservationV2Schema = z
  .strictObject({
    ...garminObservationBodySchema.shape,
    kind: z.literal('own_garmin_current_core_activity'),
    appAdmission: z.strictObject({ kind: z.literal('app'), granted: z.literal(true), revision }),
  })
  .superRefine(validateGarminSourceCorrespondence);
export type RaceManualGarminCorePurposeObservationV2 = z.infer<
  typeof raceManualGarminCorePurposeObservationV2Schema
>;
export async function captureRaceManualGarminPurposeV2In(
  tx: Transaction,
  input: unknown,
  budget: SourceBudget,
) {
  assertRaceManualSourcePurposePlainV2(input);
  const request = raceManualGarminPurposeRequestV2Schema.safeParse(input);
  if (!request.success)
    return {
      status: 'blocked' as const,
      reason: 'garmin_source_tuple_mismatch' as const,
      observation: null,
      ...limitations,
    };
  // Existing admission port serializes absent app rows too. Small app response
  // reservation is distinct from the source descriptor/body reservation below.
  reserveSourceBudget(budget, 512n, 2);
  let appAdmission;
  try {
    appAdmission = await requireAppAdmission(tx);
  } catch (error) {
    if (error instanceof AppConsentRequiredError)
      return {
        status: 'blocked' as const,
        reason: 'garmin_core_app_processing_required' as const,
        observation: null,
        ...limitations,
      };
    throw error;
  }
  const captured = await captureRaceManualGarminActivitySourceV2In(tx, request.data, budget);
  if (captured.status === 'blocked') return captured;
  const observation = raceManualGarminCorePurposeObservationV2Schema.parse({
    ...captured.observation,
    kind: 'own_garmin_current_core_activity',
    appAdmission,
  });
  const result = {
    status: 'observed_saved_activity_core_use' as const,
    reason: null,
    observation,
    ...limitations,
  };
  assertRaceManualSourcePurposePlainV2(result);
  return result;
}
