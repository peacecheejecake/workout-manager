import { z } from 'zod';
import { createHash } from 'node:crypto';
import { actualRefSchema } from '@workout/contracts/routines';
import {
  activityValuesSchema,
  activityOverlaySchema,
  manualActivityCreateSchema,
} from '@workout/contracts/activity';
import { impactDependencyDigest as digest } from './race-plan-impact-dependencies.js';
const uuid = z.uuid().transform((id) => id.toLowerCase());
const revision = z.number().int().min(1).max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().min(1).max(200);
const absent = z.strictObject({ state: z.literal('absent') });
const sourceKind = z.enum(['fit', 'fixture', 'manual', 'healthkit']);
const ref = actualRefSchema.options[0]
  .extend({
    id: uuid,
    revisionId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .refine((value) => Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647),
    detailId: uuid.nullable(),
    allocationId: uuid.nullable(),
  })
  .strict();
const head = z.strictObject({ id: uuid, revision, deleted: z.boolean() });
const content = z.strictObject({
  original: activityValuesSchema,
  overlay: activityOverlaySchema.nullable(),
  detail: z
    .strictObject({
      id: uuid,
      activity_id: uuid,
      execution_id: uuid,
      current_revision: revision,
      current_revision_id: uuid,
      status: z.enum(['active', 'deleted']),
    })
    .nullable(),
});
const actual = z.strictObject({
  requested: ref,
  state: z.enum(['current', 'historical', 'deleted', 'unavailable']),
  reason: z
    .enum([
      'producer_allocation_unsupported',
      'owned_reference_unavailable',
      'requested_revision_unavailable',
      'owned_detail_unavailable',
      'detail_deleted',
    ])
    .nullable(),
  current: head.nullable(),
  content: content.nullable(),
});
const roster = head
  .extend({
    originalDigest: hash,
    overlayDigest: hash,
    source: z.union([
      absent,
      z.strictObject({
        state: z.literal('present'),
        kind: sourceKind,
        sourceId: opaque,
        sourceRevision: revision,
        contentHash: hash,
      }),
    ]),
  })
  .strict();
/** Exact bodyless projection from captureActivityAndMediaPermissions.activities. */
const metadata = head
  .extend({
    overlay: z.strictObject({
      state: z.enum(['present', 'absent']),
      revision: revision.nullable(),
    }),
    source: z.union([
      absent,
      z.strictObject({
        state: z.literal('present'),
        kind: sourceKind,
        sourceId: opaque,
        revision,
        contentHash: hash,
        suppressed: z.boolean(),
        revisionRecord: z.strictObject({ state: z.enum(['present', 'absent']) }),
      }),
    ]),
  })
  .strict();
export const manualActivityReadProjectionInputSchema = z.strictObject({
  athleteId: opaque,
  refs: z.array(ref).max(5000),
  actualFacts: z.array(actual).max(5000),
  activityRosters: z.array(roster).max(1000),
  activityMetadata: z.array(metadata).max(1000),
});
const fact = z.strictObject({
  requested: ref,
  state: z.enum(['current', 'deleted', 'unavailable']),
  reason: z
    .enum([
      'owned_reference_unavailable',
      'requested_revision_unavailable',
      'manual_source_required',
      'unsupported_detail_or_allocation',
      'source_correspondence_unavailable',
      'source_body_correspondence_port_missing',
    ])
    .nullable(),
  current: head.nullable(),
  content: content.nullable(),
  sourceEvidence: z.strictObject({ roster, metadata }).nullable(),
});
export const manualActivityReadFactsSchema = z.strictObject({
  purpose: z.literal('retained_manual_activity_read'),
  athleteId: opaque,
  facts: z.array(fact).max(5000),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
export type ManualActivityReadFacts = z.infer<typeof manualActivityReadFactsSchema>;
const key = (value: z.infer<typeof ref>) => JSON.stringify(value);
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
function bounded(value: unknown) {
  const text = JSON.stringify(value);
  return text !== undefined && Buffer.byteLength(text, 'utf8') <= 4194304;
}
export type ManualActivityReadProjection =
  | { status: 'projected_retained_read_facts'; facts: ManualActivityReadFacts }
  | {
      status: 'blocked';
      reason: 'invalid_input' | 'bounds_exceeded' | 'reference_mismatch' | 'source_mismatch';
    };
/** Pure server-fact correspondence, never database ownership/admission authority.
 * The caller must supply same-tenant authenticated capture facts. No SQL or I/O.
 */
export function projectManualActivityReadFacts(input: unknown): ManualActivityReadProjection {
  try {
    if (!bounded(input)) return { status: 'blocked', reason: 'bounds_exceeded' };
  } catch {
    return { status: 'blocked', reason: 'invalid_input' };
  }
  const parsed = manualActivityReadProjectionInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'blocked', reason: 'invalid_input' };
  const c = parsed.data;
  if (
    c.refs.length + c.actualFacts.length + c.activityRosters.length + c.activityMetadata.length >
    5000
  )
    return { status: 'blocked', reason: 'bounds_exceeded' };
  const refs = new Map(c.refs.map((r) => [key(r), r]));
  const actuals = new Map(c.actualFacts.map((f) => [key(f.requested), f]));
  const rosters = new Map(c.activityRosters.map((r) => [r.id, r]));
  const metas = new Map(c.activityMetadata.map((r) => [r.id, r]));
  if (
    refs.size !== c.refs.length ||
    actuals.size !== c.actualFacts.length ||
    rosters.size !== c.activityRosters.length ||
    metas.size !== c.activityMetadata.length ||
    refs.size !== actuals.size ||
    [...refs.keys()].some((k) => !actuals.has(k))
  )
    return { status: 'blocked', reason: 'reference_mismatch' };
  const facts: z.infer<typeof fact>[] = [];
  for (const [k, r] of [...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const a = actuals.get(k),
      s = rosters.get(r.id),
      m = metas.get(r.id);
    if (!a) return { status: 'blocked', reason: 'reference_mismatch' };
    const unavailable = (reason: z.infer<typeof fact>['reason']) =>
      facts.push({
        requested: r,
        state: 'unavailable',
        reason,
        current: a.current,
        content: null,
        sourceEvidence: null,
      });
    if (r.detailId !== null || r.allocationId !== null) {
      unavailable('unsupported_detail_or_allocation');
      continue;
    }
    if (!s || !m || !a.current) {
      unavailable('owned_reference_unavailable');
      continue;
    }
    if (
      !equal(a.current, { id: s.id, revision: s.revision, deleted: s.deleted }) ||
      !equal(a.current, { id: m.id, revision: m.revision, deleted: m.deleted })
    )
      return { status: 'blocked', reason: 'source_mismatch' };
    if (
      s.source.state !== 'present' ||
      m.source.state !== 'present' ||
      s.source.kind !== 'manual' ||
      m.source.kind !== 'manual'
    ) {
      unavailable('manual_source_required');
      continue;
    }
    if (
      s.source.sourceId !== m.source.sourceId ||
      s.source.sourceRevision !== m.source.revision ||
      s.source.contentHash !== m.source.contentHash ||
      m.source.revisionRecord.state !== 'present'
    ) {
      unavailable('source_correspondence_unavailable');
      continue;
    }
    if (
      Number(r.revisionId) > s.revision ||
      (m.overlay.revision !== null && m.overlay.revision > s.revision)
    )
      return { status: 'blocked', reason: 'source_mismatch' };
    if (s.deleted) {
      if (a.state !== 'deleted' || a.reason !== null || a.content !== null || !m.source.suppressed)
        return { status: 'blocked', reason: 'source_mismatch' };
      facts.push({
        requested: r,
        state: 'deleted',
        reason: null,
        current: a.current,
        content: null,
        sourceEvidence: { roster: s, metadata: m },
      });
      continue;
    }
    if (
      a.state === 'unavailable' &&
      a.reason === 'requested_revision_unavailable' &&
      a.content === null &&
      /^([1-9][0-9]*)$/.test(r.revisionId) &&
      Number(r.revisionId) < s.revision
    ) {
      unavailable('requested_revision_unavailable');
      continue;
    }
    if (
      a.state !== 'current' ||
      a.reason !== null ||
      !a.content ||
      a.content.detail !== null ||
      r.revisionId !== String(s.revision) ||
      m.source.suppressed ||
      digest(a.content.original) !== s.originalDigest ||
      digest(a.content.overlay) !== s.overlayDigest ||
      (m.overlay.state === 'present') !== (a.content.overlay !== null) ||
      (m.overlay.state === 'present' && m.overlay.revision !== s.revision)
    )
      return { status: 'blocked', reason: 'source_mismatch' };
    // Source producer hashes schema-ordered JSON; roster hashes canonical JSON.
    // They are distinct algorithms and neither digest authenticates this caller.
    const sourceBody = manualActivityCreateSchema.shape.activity.safeParse(a.content.original);
    if (!sourceBody.success) {
      unavailable('source_body_correspondence_port_missing');
      continue;
    }
    const sourceBodyHash = createHash('sha256')
      .update(JSON.stringify(sourceBody.data))
      .digest('hex');
    if (sourceBodyHash !== s.source.contentHash)
      return { status: 'blocked', reason: 'source_mismatch' };
    facts.push({
      requested: r,
      state: 'current',
      reason: null,
      current: a.current,
      content: a.content,
      sourceEvidence: { roster: s, metadata: m },
    });
  }
  const output: ManualActivityReadFacts = {
    purpose: 'retained_manual_activity_read',
    athleteId: c.athleteId,
    facts,
    authority: 'none',
    freshness: 'not_checked',
  };
  if (!bounded(output)) return { status: 'blocked', reason: 'bounds_exceeded' };
  return { status: 'projected_retained_read_facts', facts: output };
}
/** Validates copied projection against the supplied server capture, not against
 * the database. Historical unavailable facts never become a current body. */
export function validateManualActivityReadFacts(
  unknownFacts: unknown,
  expectedCapture: unknown,
):
  | { status: 'validated_retained_read_facts'; approvalAuthority: 'none'; freshness: 'not_checked' }
  | {
      status: 'blocked';
      reason: 'invalid_facts' | 'correspondence_mismatch' | 'source_unavailable';
    } {
  try {
    if (!bounded(unknownFacts)) return { status: 'blocked', reason: 'invalid_facts' };
  } catch {
    return { status: 'blocked', reason: 'invalid_facts' };
  }
  const parsed = manualActivityReadFactsSchema.safeParse(unknownFacts),
    expected = projectManualActivityReadFacts(expectedCapture);
  if (!parsed.success) return { status: 'blocked', reason: 'invalid_facts' };
  if (expected.status !== 'projected_retained_read_facts' || !equal(parsed.data, expected.facts))
    return { status: 'blocked', reason: 'correspondence_mismatch' };
  if (parsed.data.facts.some((f) => f.state === 'unavailable'))
    return { status: 'blocked', reason: 'source_unavailable' };
  return {
    status: 'validated_retained_read_facts',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  };
}
