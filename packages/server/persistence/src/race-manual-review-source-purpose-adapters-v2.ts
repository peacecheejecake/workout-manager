import { z } from 'zod';
import {
  activitySourceSchema,
  activityValuesSchema,
  activityOverlaySchema,
} from '@workout/contracts/activity';
import type { Transaction } from './database.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  impactDependencyDigest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
import {
  courseReadManifestSchema,
  validateCourseReadManifest,
} from './race-plan-impact-course-manifest.js';
import { captureCourseReadSources } from './race-plan-impact-course-sources.js';
const revision = z.number().int().positive().max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const raceManualLocalActivityPurposeRequestV2Schema = z.strictObject({
  activityId: uuid,
  canonicalRevision: revision,
  source: activitySourceSchema,
  expectedOriginalDigest: hash.nullable(),
  expectedOverlayDigest: hash.nullable(),
  expectedOverlayRevision: revision.nullable(),
});
export const raceManualSourcePurposeObservationV2Schema = z.strictObject({
  adapterVersion: z.literal(2),
  kind: z.enum(['own_imported_activity', 'own_manual_lineage']),
  sources: z
    .array(
      z.strictObject({
        activityId: uuid,
        canonicalRevision: revision,
        source: activitySourceSchema,
        originalDigest: hash,
        overlayRevision: revision.nullable(),
        overlayDigest: hash.nullable(),
      }),
    )
    .max(13),
});
export type RaceManualSourcePurposeObservationV2 = z.infer<
  typeof raceManualSourcePurposeObservationV2Schema
>;
export const raceManualSourcePurposeReasonV2Schema = z.enum([
  'source_unavailable',
  'source_tuple_mismatch',
  'source_deleted',
  'activity_provenance_unavailable',
  'healthkit_policy_adapter_unavailable',
  'garmin_policy_adapter_unavailable',
  'course_lineage_use_unavailable',
]);
const limits = {
  authority: 'none',
  sourceAuthentication: 'unverified',
  freshness: 'not_checked',
  storage: 'not_persisted',
  approvalAllowed: false,
} as const;
type PurposeReason = z.infer<typeof raceManualSourcePurposeReasonV2Schema>;
function blocked(why: PurposeReason) {
  return { status: 'blocked' as const, reason: why, observation: null, ...limits };
}
export function assertRaceManualSourcePurposePlainV2(value: unknown): void {
  const active = new WeakSet<object>();
  let visits = 0;
  let primitiveBytes = 0;
  function charge(value: string): void {
    primitiveBytes += Buffer.byteLength(value, 'utf8');
    if (primitiveBytes > 4194304)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  }
  function visit(v: unknown, depth: number): void {
    if (++visits > 4194305 || depth > 64) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (typeof v === 'string') {
      charge(v);
      return;
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return;
    if (typeof v !== 'object' || active.has(v) || Object.getOwnPropertySymbols(v).length)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    active.add(v);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && k === 'length') continue;
      if (!Array.isArray(v)) charge(k);
      if (!d.enumerable || !('value' in d)) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      visit(d.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
}
/** Same fenced transaction only. Caller expectations are correspondence checks,
 * never credentials; this function rereads owned source rows and provenance. */
export async function captureRaceManualLocalActivityPurposeV2In(
  tx: Transaction,
  unknownRequest: unknown,
  budget: SourceBudget,
) {
  assertRaceManualSourcePurposePlainV2(unknownRequest);
  const p = raceManualLocalActivityPurposeRequestV2Schema.safeParse(unknownRequest);
  if (!p.success) return blocked('source_tuple_mismatch');
  const request = p.data;
  reserveSourceBudget(budget, 4096n, 1);
  const rows = await tx.query(
    `SELECT c.id,c.revision,c.deleted,h.kind,h.source_id,h.source_revision,h.content_hash,
    v.content_hash AS revision_hash,
    EXISTS(SELECT 1 FROM activity_suppression x WHERE x.athlete_id=h.athlete_id AND x.kind=h.kind AND x.source_id=h.source_id) AS suppressed,
    EXISTS(SELECT 1 FROM garmin_activity_ledger_source l JOIN garmin_activity_ledger g ON g.athlete_id=l.athlete_id AND g.garmin_activity_id=l.garmin_activity_id WHERE l.athlete_id=h.athlete_id AND l.kind=h.kind AND l.source_id=h.source_id) AS garmin,
    (SELECT max(revision) FROM activity_overlay_revision r WHERE r.athlete_id=c.athlete_id AND r.activity_id=c.id) AS overlay_revision,
    octet_length(c.original::text)+coalesce(octet_length(o.values_json::text),4)+coalesce(octet_length(v.normalized_raw::text),4) AS bytes
    FROM activity_canonical c LEFT JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id
    LEFT JOIN activity_source_revision v ON v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision
    LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id=$2::uuid`,
    [tx.athleteId, request.activityId],
  );
  if (rows.rows.length === 0) return blocked('source_unavailable');
  const meta = z
    .strictObject({
      id: uuid,
      revision,
      deleted: z.boolean(),
      kind: activitySourceSchema.shape.kind.nullable(),
      source_id: activitySourceSchema.shape.sourceId.nullable(),
      source_revision: revision.nullable(),
      content_hash: hash.nullable(),
      revision_hash: hash.nullable(),
      suppressed: z.boolean(),
      garmin: z.boolean(),
      overlay_revision: revision.nullable(),
      bytes: z.number().int().nonnegative(),
    })
    .parse(rows.rows[0]);
  if (meta.deleted || meta.suppressed) return blocked('source_deleted');
  if (meta.kind === 'healthkit') return blocked('healthkit_policy_adapter_unavailable');
  if (meta.garmin) return blocked('garmin_policy_adapter_unavailable');
  if (
    !meta.kind ||
    !meta.source_id ||
    meta.source_revision === null ||
    meta.content_hash === null ||
    meta.revision_hash !== meta.content_hash
  )
    return blocked('activity_provenance_unavailable');
  const source = activitySourceSchema.parse({
    kind: meta.kind,
    sourceId: meta.source_id,
    revision: meta.source_revision,
    contentHash: meta.content_hash,
  });
  if (
    meta.id !== request.activityId ||
    meta.revision !== request.canonicalRevision ||
    impactDependencyDigest(source) !== impactDependencyDigest(request.source)
  )
    return blocked('source_tuple_mismatch');
  reserveSourceBudget(budget, BigInt(meta.bytes) + 2048n, 1);
  const fetched = await tx.query(
    `SELECT c.original,o.values_json AS overlay,v.normalized_raw AS source_record FROM activity_canonical c JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id JOIN activity_source_revision v ON v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision AND v.content_hash=h.content_hash LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id=$2::uuid AND c.revision=$3 AND NOT c.deleted`,
    [tx.athleteId, request.activityId, request.canonicalRevision],
  );
  if (fetched.rows.length !== 1) return blocked('source_unavailable');
  const body = z
    .strictObject({
      original: activityValuesSchema,
      overlay: activityOverlaySchema.nullable(),
      source_record: activityValuesSchema,
    })
    .parse(fetched.rows[0]);
  if (Buffer.byteLength(JSON.stringify(body)) > meta.bytes + 2048)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const originalDigest = impactDependencyDigest(body.original),
    overlayDigest = body.overlay === null ? null : impactDependencyDigest(body.overlay);
  if (
    originalDigest !== impactDependencyDigest(body.source_record) ||
    (request.expectedOriginalDigest !== null &&
      request.expectedOriginalDigest !== originalDigest) ||
    request.expectedOverlayRevision !== meta.overlay_revision ||
    request.expectedOverlayDigest !== overlayDigest
  )
    return blocked('source_tuple_mismatch');
  return {
    status: 'observed_local_use' as const,
    reason: null,
    observation: raceManualSourcePurposeObservationV2Schema.parse({
      adapterVersion: 2,
      kind: source.kind === 'manual' ? 'own_manual_lineage' : 'own_imported_activity',
      sources: [
        {
          activityId: meta.id,
          canonicalRevision: meta.revision,
          source,
          originalDigest,
          overlayRevision: meta.overlay_revision,
          overlayDigest,
        },
      ],
    }),
    ...limits,
  };
}
/** Exact owned course/track correspondence followed by each actual manual source.
 * No routing/provider permission is inferred from stored geometry or ownership. */
export async function captureRaceManualCoursePurposeV2In(
  tx: Transaction,
  unknownCourse: unknown,
  budget: SourceBudget,
) {
  assertRaceManualSourcePurposePlainV2(unknownCourse);
  const p = courseReadManifestSchema.safeParse(unknownCourse);
  if (
    !p.success ||
    p.data.owned?.revision?.generation.kind !== 'recorded-segment' ||
    !p.data.lineageSources?.length
  )
    return blocked('course_lineage_use_unavailable');
  const actual = await captureCourseReadSources(tx, p.data.ref, budget);
  if (
    !actual ||
    actual.owned?.revision?.generation.kind !== 'recorded-segment' ||
    !actual.lineageSources?.length ||
    validateCourseReadManifest({ athleteId: tx.athleteId, eventCourse: p.data.ref }, actual)
      .status !== 'validated_read_scope' ||
    impactDependencyDigest(actual) !== impactDependencyDigest(p.data)
  )
    return blocked('course_lineage_use_unavailable');
  const sources: RaceManualSourcePurposeObservationV2['sources'] = [];
  for (const line of actual.lineageSources ?? []) {
    reserveSourceBudget(budget, 1024n, 1);
    const row = (
      await tx.query(
        `SELECT h.kind,h.source_id,h.source_revision,h.content_hash,(SELECT max(revision) FROM activity_overlay_revision o WHERE o.athlete_id=h.athlete_id AND o.activity_id=h.activity_id) AS overlay_revision FROM activity_source_head h WHERE h.athlete_id=$1 AND h.activity_id=$2::uuid`,
        [tx.athleteId, line.activity.id],
      )
    ).rows[0];
    const m = z
      .strictObject({
        kind: activitySourceSchema.shape.kind,
        source_id: activitySourceSchema.shape.sourceId,
        source_revision: revision,
        content_hash: hash,
        overlay_revision: revision.nullable(),
      })
      .safeParse(row);
    if (!m.success || m.data.kind !== 'manual') return blocked('course_lineage_use_unavailable');
    // Overlay does not change the immutable recording; reread its current digest
    // to preserve the same source tuple without inventing overlay absence.
    reserveSourceBudget(budget, 65536n, 1);
    const overlay = (
      await tx.query(
        'SELECT values_json FROM activity_overlay WHERE athlete_id=$1 AND activity_id=$2::uuid',
        [tx.athleteId, line.activity.id],
      )
    ).rows[0];
    const od = overlay
      ? impactDependencyDigest(activityOverlaySchema.parse(overlay['values_json']))
      : null;
    const observed = await captureRaceManualLocalActivityPurposeV2In(
      tx,
      {
        activityId: line.activity.id,
        canonicalRevision: line.activity.revision,
        source: {
          kind: m.data.kind,
          sourceId: m.data.source_id,
          revision: m.data.source_revision,
          contentHash: m.data.content_hash,
        },
        expectedOriginalDigest: null,
        expectedOverlayDigest: od,
        expectedOverlayRevision: m.data.overlay_revision,
      },
      budget,
    );
    if (observed.status !== 'observed_local_use') return observed;
    sources.push(...observed.observation.sources);
  }
  return {
    status: 'observed_local_use' as const,
    reason: null,
    observation: raceManualSourcePurposeObservationV2Schema.parse({
      adapterVersion: 2,
      kind: 'own_manual_lineage',
      sources,
    }),
    ...limits,
  };
}
