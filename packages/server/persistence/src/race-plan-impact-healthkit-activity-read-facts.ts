import { z } from 'zod';
import { manualActivityReadProjectionInputSchema } from './race-plan-impact-manual-activity-read-facts.js';
import {
  raceManualHealthKitPurposeObservationV2Schema,
  raceManualHealthKitPurposeReasonV2Schema,
} from './race-manual-review-healthkit-purpose-v2.js';
import { assertRaceManualSourcePurposePlainV2 } from './race-manual-review-source-purpose-adapters-v2.js';
import {
  impactDependencyDigest as digest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
const base = manualActivityReadProjectionInputSchema;
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const healthKitActivityReadSourceSchema = z
  .strictObject({
    activityId: uuid,
    observation: raceManualHealthKitPurposeObservationV2Schema.nullable(),
    reason: raceManualHealthKitPurposeReasonV2Schema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.observation === null) === (v.reason === null) ||
      (v.observation && v.activityId !== v.observation.activityId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact observed source or finite blocked reason required',
      });
  });
export const healthKitActivityReadProjectionInputSchema = base.extend({
  healthkitSources: z.array(healthKitActivityReadSourceSchema).max(1000),
});
const fact = z
  .strictObject({
    requested: base.shape.refs.element,
    state: z.enum(['current', 'unavailable']),
    reason: z
      .union([
        raceManualHealthKitPurposeReasonV2Schema,
        z.enum([
          'owned_reference_unavailable',
          'requested_revision_unavailable',
          'healthkit_source_required',
          'unsupported_detail_or_allocation',
          'source_correspondence_unavailable',
        ]),
      ])
      .nullable(),
    current: base.shape.actualFacts.element.shape.current,
    source: raceManualHealthKitPurposeObservationV2Schema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.state === 'current' &&
        (!v.current || v.current.deleted || !v.source || v.reason !== null)) ||
      (v.state === 'unavailable' && (v.source !== null || v.reason === null))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Current exact correspondence or contentless unavailable source required',
      });
  });
/** Metadata-only current primary HealthKit correspondence. Supplied witnesses
 * are not processing credentials and never establish device authenticity. */
export const healthKitActivityReadFactsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal('retained_healthkit_activity_read'),
  athleteId: base.shape.athleteId,
  facts: z.array(fact).max(5000),
  authority: z.literal('none'),
  sourceAuthentication: z.literal('unverified'),
  freshness: z.literal('not_checked'),
});
export type HealthKitActivityReadFacts = z.infer<typeof healthKitActivityReadFactsSchema>;
export function projectHealthKitActivityReadFacts(input: unknown) {
  const blocked = (
    reason: 'invalid_input' | 'bounds_exceeded' | 'reference_mismatch' | 'source_mismatch',
  ) => ({ status: 'blocked' as const, reason });
  try {
    assertRaceManualSourcePurposePlainV2(input);
  } catch (e) {
    return blocked(
      e instanceof RaceImpactDependencyError && e.code === 'CONTEXT_UNAVAILABLE'
        ? 'bounds_exceeded'
        : 'invalid_input',
    );
  }
  const p = healthKitActivityReadProjectionInputSchema.safeParse(input);
  if (!p.success) return blocked('invalid_input');
  const c = p.data;
  if (
    c.refs.length +
      c.actualFacts.length +
      c.activityRosters.length +
      c.activityMetadata.length +
      c.healthkitSources.length >
    5000
  )
    return blocked('bounds_exceeded');
  const key = (r: z.infer<typeof base.shape.refs.element>) => JSON.stringify(r);
  const refs = new Map(c.refs.map((r) => [key(r), r])),
    actual = new Map<string, z.infer<typeof base.shape.actualFacts.element>>();
  for (const f of c.actualFacts) {
    const prior = actual.get(key(f.requested));
    if (prior && digest(prior) !== digest(f)) return blocked('reference_mismatch');
    actual.set(key(f.requested), f);
  }
  const ids = new Set(c.refs.map((r) => r.id)),
    rosters = new Map(c.activityRosters.map((r) => [r.id, r])),
    metadata = new Map(c.activityMetadata.map((r) => [r.id, r])),
    sources = new Map(c.healthkitSources.map((r) => [r.activityId, r]));
  if (
    actual.size !== refs.size ||
    [...actual.keys()].some((k) => !refs.has(k)) ||
    rosters.size !== c.activityRosters.length ||
    metadata.size !== c.activityMetadata.length ||
    sources.size !== c.healthkitSources.length ||
    [...rosters.keys(), ...metadata.keys(), ...sources.keys()].some((id) => !ids.has(id))
  )
    return blocked('reference_mismatch');
  const facts: HealthKitActivityReadFacts['facts'] = [];
  for (const [k, r] of [...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const a = actual.get(k),
      roster = rosters.get(r.id),
      m = metadata.get(r.id),
      s = sources.get(r.id);
    const unavailable = (
      reason: NonNullable<HealthKitActivityReadFacts['facts'][number]['reason']>,
    ) =>
      facts.push({
        requested: r,
        state: 'unavailable',
        reason,
        current: a?.current ?? null,
        source: null,
      });
    if (!a) return blocked('reference_mismatch');
    if (r.detailId || r.allocationId) {
      unavailable('unsupported_detail_or_allocation');
      continue;
    }
    if (!roster || !m || !a.current) {
      unavailable('owned_reference_unavailable');
      continue;
    }
    if (
      digest(a.current) !==
        digest({ id: roster.id, revision: roster.revision, deleted: roster.deleted }) ||
      digest(a.current) !== digest({ id: m.id, revision: m.revision, deleted: m.deleted })
    )
      return blocked('source_mismatch');
    if (
      roster.source.state !== 'present' ||
      m.source.state !== 'present' ||
      roster.source.kind !== 'healthkit' ||
      m.source.kind !== 'healthkit'
    ) {
      unavailable('healthkit_source_required');
      continue;
    }
    if (
      roster.source.sourceId !== m.source.sourceId ||
      roster.source.sourceRevision !== m.source.revision ||
      roster.source.contentHash !== m.source.contentHash
    )
      return blocked('source_mismatch');
    if (roster.deleted || m.deleted || m.source.suppressed || a.state === 'deleted') {
      if (a.content !== null) return blocked('source_mismatch');
      unavailable('healthkit_source_deleted');
      continue;
    }
    if (a.state !== 'current' || r.revisionId !== String(roster.revision)) {
      unavailable('requested_revision_unavailable');
      continue;
    }
    if (!s) {
      unavailable('healthkit_provenance_unavailable');
      continue;
    }
    if (s.reason) {
      unavailable(s.reason);
      continue;
    }
    const o = s.observation;
    if (
      !o ||
      !a.content ||
      a.content.detail !== null ||
      a.reason !== null ||
      m.source.revisionRecord.state !== 'present'
    )
      return blocked('source_mismatch');
    const originalDigest = digest(a.content.original),
      overlayDigest = a.content.overlay === null ? null : digest(a.content.overlay);
    if (
      o.canonicalRevision !== roster.revision ||
      o.source.sourceId !== roster.source.sourceId ||
      o.source.revision !== roster.source.sourceRevision ||
      o.source.contentHash !== roster.source.contentHash ||
      o.originalDigest !== originalDigest ||
      roster.originalDigest !== originalDigest ||
      roster.overlayDigest !== digest(a.content.overlay) ||
      o.overlayDigest !== overlayDigest ||
      o.overlayRevision !== m.overlay.revision ||
      (m.overlay.state === 'present') !== (a.content.overlay !== null)
    )
      return blocked('source_mismatch');
    facts.push({ requested: r, state: 'current', reason: null, current: a.current, source: o });
  }
  const output = {
    schemaVersion: 1,
    purpose: 'retained_healthkit_activity_read',
    athleteId: c.athleteId,
    facts,
    authority: 'none',
    sourceAuthentication: 'unverified',
    freshness: 'not_checked',
  };
  try {
    assertRaceManualSourcePurposePlainV2(output);
  } catch {
    return blocked('bounds_exceeded');
  }
  return {
    status: 'projected_retained_healthkit_read_facts' as const,
    facts: healthKitActivityReadFactsSchema.parse(output),
  };
}
export function validateHealthKitActivityReadFacts(
  unknownFacts: unknown,
  expectedCapture: unknown,
) {
  const blocked = (
    reason:
      | 'invalid_input'
      | 'bounds_exceeded'
      | 'reference_mismatch'
      | 'source_mismatch'
      | 'source_unavailable',
  ) => ({
    status: 'blocked' as const,
    reason,
    authority: 'none' as const,
    sourceAuthentication: 'unverified' as const,
    freshness: 'not_checked' as const,
  });
  try {
    assertRaceManualSourcePurposePlainV2(unknownFacts);
  } catch {
    return blocked('invalid_input');
  }
  const parsed = healthKitActivityReadFactsSchema.safeParse(unknownFacts);
  if (!parsed.success) return blocked('invalid_input');
  const expected = projectHealthKitActivityReadFacts(expectedCapture);
  if (expected.status === 'blocked') return blocked(expected.reason);
  if (digest(parsed.data) !== digest(expected.facts)) return blocked('source_mismatch');
  if (parsed.data.facts.some((f) => f.state !== 'current')) return blocked('source_unavailable');
  return {
    status: 'validated_retained_healthkit_read_facts' as const,
    authority: 'none' as const,
    sourceAuthentication: 'unverified' as const,
    freshness: 'not_checked' as const,
  };
}
