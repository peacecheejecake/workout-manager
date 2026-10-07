import { z } from 'zod';
import { manualActivityReadProjectionInputSchema } from './race-plan-impact-manual-activity-read-facts.js';
import { assertRaceManualSourcePurposePlainV2 } from './race-manual-review-source-purpose-adapters-v2.js';
import {
  impactDependencyDigest as digest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
const inputSchema = manualActivityReadProjectionInputSchema;
const actualSchema = inputSchema.shape.actualFacts.element;
const rosterSchema = inputSchema.shape.activityRosters.element;
const hash = rosterSchema.shape.originalDigest;
const sourceTuple = z.strictObject({
  kind: z.enum(['fit', 'fixture']),
  sourceId: z.string().min(1).max(200),
  revision: z.number().int().positive().max(2147483647),
  contentHash: hash,
});
const factSchema = z
  .strictObject({
    requested: inputSchema.shape.refs.element,
    state: z.enum(['current', 'deleted', 'unavailable']),
    reason: z
      .enum([
        'owned_reference_unavailable',
        'requested_revision_unavailable',
        'local_import_source_required',
        'unsupported_detail_or_allocation',
        'source_correspondence_unavailable',
      ])
      .nullable(),
    current: actualSchema.shape.current,
    sourceTuple: sourceTuple.nullable(),
    originalDigest: hash.nullable(),
    overlayDigest: hash.nullable(),
    overlayRevision: z.number().int().positive().max(2147483647).nullable(),
  })
  .superRefine((f, ctx) => {
    if (
      f.state === 'current' &&
      (!f.current ||
        f.current.deleted ||
        !f.sourceTuple ||
        !f.originalDigest ||
        !f.overlayDigest ||
        f.reason !== null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Current imported source requires exact digest tuple',
      });
    if (f.state !== 'current' && (f.originalDigest !== null || f.overlayDigest !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'Unavailable/deleted source has no copied-body digest',
      });
    if (f.state === 'deleted' && (!f.current?.deleted || f.reason !== null || !f.sourceTuple))
      ctx.addIssue({ code: 'custom', message: 'Deleted source requires an exact tombstone' });
    if (f.state === 'unavailable' && f.reason === null)
      ctx.addIssue({ code: 'custom', message: 'Unavailable source requires a reason' });
  });
/** Metadata-only correspondence. Original/overlay body remains in captured actual
 * facts; no provider authentication, purpose admission or new source body is minted. */
export const localImportedActivityReadFactsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal('retained_local_import_activity_read'),
  athleteId: inputSchema.shape.athleteId,
  facts: z.array(factSchema).max(5000),
  authority: z.literal('none'),
  sourceAuthentication: z.literal('unverified'),
  freshness: z.literal('not_checked'),
});
export type LocalImportedActivityReadFacts = z.infer<typeof localImportedActivityReadFactsSchema>;
export type LocalImportedActivityReadProjection =
  | { status: 'projected_retained_local_import_read_facts'; facts: LocalImportedActivityReadFacts }
  | {
      status: 'blocked';
      reason: 'invalid_input' | 'bounds_exceeded' | 'reference_mismatch' | 'source_mismatch';
    };
const key = (r: z.infer<typeof inputSchema.shape.refs.element>) => JSON.stringify(r);
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function bounded(value: unknown) {
  assertRaceManualSourcePurposePlainV2(value);
}
/** Unknown input is a captured structural witness, never an authorization token.
 * Only current fit/fixture records are supported; historical bodies are not repinned. */
export function projectLocalImportedActivityReadFacts(
  unknownInput: unknown,
): LocalImportedActivityReadProjection {
  try {
    bounded(unknownInput);
  } catch (error) {
    return {
      status: 'blocked',
      reason:
        error instanceof RaceImpactDependencyError && error.code === 'CONTEXT_UNAVAILABLE'
          ? 'bounds_exceeded'
          : 'invalid_input',
    };
  }
  const p = inputSchema.safeParse(unknownInput);
  if (!p.success) return { status: 'blocked', reason: 'invalid_input' };
  const c = p.data;
  if (
    c.refs.length + c.actualFacts.length + c.activityRosters.length + c.activityMetadata.length >
    5000
  )
    return { status: 'blocked', reason: 'bounds_exceeded' };
  const refs = new Map(c.refs.map((r) => [key(r), r]));
  const actuals = new Map<string, z.infer<typeof actualSchema>>();
  for (const a of c.actualFacts) {
    const k = key(a.requested),
      prior = actuals.get(k);
    if (prior && !same(prior, a)) return { status: 'blocked', reason: 'reference_mismatch' };
    actuals.set(k, a);
  }
  const rosters = new Map(c.activityRosters.map((r) => [r.id, r])),
    metas = new Map(c.activityMetadata.map((r) => [r.id, r]));
  const requestedIds = new Set(c.refs.map((r) => r.id));
  if (
    rosters.size !== c.activityRosters.length ||
    metas.size !== c.activityMetadata.length ||
    actuals.size !== refs.size ||
    [...refs.keys()].some((k) => !actuals.has(k)) ||
    [...rosters.keys(), ...metas.keys()].some((id) => !requestedIds.has(id))
  )
    return { status: 'blocked', reason: 'reference_mismatch' };
  const facts: LocalImportedActivityReadFacts['facts'] = [];
  for (const [k, r] of [...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const a = actuals.get(k),
      s = rosters.get(r.id),
      m = metas.get(r.id);
    if (!a) return { status: 'blocked', reason: 'reference_mismatch' };
    function unavailable(reason: z.infer<typeof factSchema>['reason']) {
      facts.push({
        requested: r,
        state: 'unavailable',
        reason,
        current: a?.current ?? null,
        sourceTuple: null,
        originalDigest: null,
        overlayDigest: null,
        overlayRevision: null,
      });
    }
    if (r.detailId !== null || r.allocationId !== null) {
      unavailable('unsupported_detail_or_allocation');
      continue;
    }
    if (!s || !m || !a.current) {
      unavailable('owned_reference_unavailable');
      continue;
    }
    if (
      !same(a.current, { id: s.id, revision: s.revision, deleted: s.deleted }) ||
      !same(a.current, { id: m.id, revision: m.revision, deleted: m.deleted })
    )
      return { status: 'blocked', reason: 'source_mismatch' };
    if (
      s.source.state !== 'present' ||
      m.source.state !== 'present' ||
      !['fit', 'fixture'].includes(s.source.kind) ||
      s.source.kind !== m.source.kind
    ) {
      unavailable('local_import_source_required');
      continue;
    }
    if (
      s.source.sourceId !== m.source.sourceId ||
      s.source.sourceRevision !== m.source.revision ||
      s.source.contentHash !== m.source.contentHash ||
      m.source.revisionRecord.state !== 'present' ||
      Number(r.revisionId) > s.revision ||
      (m.overlay.revision !== null && m.overlay.revision > s.revision)
    )
      return { status: 'blocked', reason: 'source_mismatch' };
    const source = sourceTuple.parse({
      kind: s.source.kind,
      sourceId: s.source.sourceId,
      revision: s.source.sourceRevision,
      contentHash: s.source.contentHash,
    });
    if (s.deleted) {
      if (a.state !== 'deleted' || a.reason !== null || a.content !== null || !m.source.suppressed)
        return { status: 'blocked', reason: 'source_mismatch' };
      facts.push({
        requested: r,
        state: 'deleted',
        reason: null,
        current: a.current,
        sourceTuple: source,
        originalDigest: null,
        overlayDigest: null,
        overlayRevision: m.overlay.revision,
      });
      continue;
    }
    if (
      Number(r.revisionId) < s.revision ||
      a.state === 'historical' ||
      (a.state === 'unavailable' && a.reason === 'requested_revision_unavailable')
    ) {
      unavailable('requested_revision_unavailable');
      continue;
    }
    if (
      a.state !== 'current' ||
      a.reason !== null ||
      !a.content ||
      a.content.detail !== null ||
      m.source.suppressed ||
      digest(a.content.original) !== s.originalDigest ||
      digest(a.content.overlay) !== s.overlayDigest ||
      (m.overlay.state === 'present') !== (a.content.overlay !== null) ||
      (m.overlay.state === 'present'
        ? m.overlay.revision !== s.revision
        : m.overlay.revision !== null)
    )
      return { status: 'blocked', reason: 'source_mismatch' };
    facts.push({
      requested: r,
      state: 'current',
      reason: null,
      current: a.current,
      sourceTuple: source,
      originalDigest: s.originalDigest,
      overlayDigest: s.overlayDigest,
      overlayRevision: m.overlay.revision,
    });
  }
  const output: LocalImportedActivityReadFacts = {
    schemaVersion: 1,
    purpose: 'retained_local_import_activity_read',
    athleteId: c.athleteId,
    facts,
    authority: 'none',
    sourceAuthentication: 'unverified',
    freshness: 'not_checked',
  };
  try {
    bounded(output);
  } catch {
    return { status: 'blocked', reason: 'bounds_exceeded' };
  }
  return {
    status: 'projected_retained_local_import_read_facts',
    facts: localImportedActivityReadFactsSchema.parse(output),
  };
}
/** Recomputes correspondence from the supplied expected capture. Real owned DB
 * source/purpose checks remain in the caller; this pure comparator grants nothing. */
export function validateLocalImportedActivityReadFacts(
  unknownFacts: unknown,
  expectedCapture: unknown,
) {
  try {
    bounded(unknownFacts);
  } catch {
    return { status: 'blocked' as const, reason: 'invalid_facts' as const };
  }
  const p = localImportedActivityReadFactsSchema.safeParse(unknownFacts),
    expected = projectLocalImportedActivityReadFacts(expectedCapture);
  if (!p.success) return { status: 'blocked' as const, reason: 'invalid_facts' as const };
  if (
    expected.status !== 'projected_retained_local_import_read_facts' ||
    !same(p.data, expected.facts)
  )
    return { status: 'blocked' as const, reason: 'correspondence_mismatch' as const };
  if (p.data.facts.some((f) => f.state === 'unavailable'))
    return { status: 'blocked' as const, reason: 'source_unavailable' as const };
  return {
    status: 'validated_retained_local_import_read_facts' as const,
    approvalAuthority: 'none' as const,
    sourceAuthentication: 'unverified' as const,
    freshness: 'not_checked' as const,
  };
}
