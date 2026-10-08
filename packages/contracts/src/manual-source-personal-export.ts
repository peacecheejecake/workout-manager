import { z } from 'zod';
import { raceManualInternalWholePlainSchema } from './race-manual-internal-personal-export.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const opaque = z.string().min(1);
const revision = z.number().int().min(0).max(2147483647);
const positiveRevision = revision.min(1);
const instant = z.iso.datetime({ precision: 6 }).regex(/Z$/);
const versionIdentity = <K extends string>(
  kind: K,
  sourceId: z.ZodType<string> = uuid,
  versionId: z.ZodType<string> = uuid,
) => z.strictObject({ kind: z.literal(kind), sourceId, versionId });
const activitySource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual'), sourceRecordId: uuid, sourceRevision: revision }),
  z.strictObject({
    kind: z.enum(['fit', 'fixture', 'healthkit', 'garmin']),
    sourceRevision: revision,
    identifier: z.literal('sensitive_identifier_not_exported'),
  }),
]);
/** Saved product tuples only. A provider key is not a manual source UUID. */
export const manualSourcePersonalIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('race-event'), sourceId: uuid, revision: positiveRevision }),
  z.strictObject({ kind: z.literal('plan-snapshot'), sourceId: opaque, version: positiveRevision }),
  versionIdentity('nutrition-plan-version'),
  versionIdentity('routine-schedule-version', opaque, opaque),
  versionIdentity('routine-blueprint-version', opaque, opaque),
  z.strictObject({ kind: z.literal('routine-occurrence'), sourceId: opaque }),
  z.strictObject({ kind: z.literal('routine-run'), sourceId: opaque, revision }),
  z.strictObject({
    kind: z.literal('session-completion'),
    sourceId: opaque,
    planVersionId: uuid,
    revision,
  }),
  versionIdentity('food-definition-version', opaque),
  versionIdentity('recovery-method-version'),
  versionIdentity('recovery-strategy-version'),
  versionIdentity('supplementary-exercise-version'),
  versionIdentity('workout-template-version'),
  z.strictObject({
    kind: z.literal('supplementary-session-copy'),
    sourceId: uuid,
    sessionId: opaque,
  }),
  z.strictObject({
    kind: z.literal('activity-canonical-values'),
    sourceId: uuid,
    revision: positiveRevision,
  }),
  z.strictObject({
    kind: z.literal('manual-activity-source'),
    sourceId: uuid,
    source: activitySource,
  }),
  z.strictObject({ kind: z.literal('activity-overlay'), sourceId: uuid, revision }),
  z.strictObject({ kind: z.literal('intake-revision'), sourceId: opaque, revisionId: uuid }),
  z.strictObject({
    kind: z.literal('checkin-revision'),
    sourceId: uuid,
    revision: positiveRevision,
  }),
  z.strictObject({
    kind: z.literal('checklist-confirmation'),
    sourceId: opaque,
    revisionId: uuid,
    runId: opaque,
    stepId: opaque,
  }),
  z.strictObject({ kind: z.literal('routine-timer'), sourceId: opaque, stepId: opaque, revision }),
  z.strictObject({
    kind: z.literal('course-revision'),
    sourceId: uuid,
    revisionId: uuid,
    revision,
  }),
  z.strictObject({
    kind: z.literal('course-head-descriptor'),
    sourceId: uuid,
    revision: positiveRevision,
  }),
  z.strictObject({
    kind: z.literal('activity-track-descriptor'),
    sourceId: uuid,
    trackId: uuid,
    revision,
  }),
  versionIdentity('resource-text-version'),
  z.strictObject({
    kind: z.literal('race-timing-pin-fragment'),
    sourceId: uuid,
    revision: positiveRevision,
  }),
  z.strictObject({
    kind: z.literal('gallery-descriptor'),
    sourceId: uuid,
    accessRevision: revision,
  }),
]);
export type ManualSourcePersonalIdentity = z.infer<typeof manualSourcePersonalIdentitySchema>;
const versionParent = <K extends string>(
  family: K,
  id: z.ZodType<string> = uuid,
  version: z.ZodType<string> = uuid,
) => z.strictObject({ family: z.literal(family), sourceId: id, versionId: version.nullable() });
/** SQL versionKey strings and membershipKey arrays are decoded to these finite
 * tuples by the trusted reader; no raw SQL relation or key namespace escapes. */
export const manualSourcePersonalParentIdentitySchema = z.discriminatedUnion('family', [
  z.strictObject({
    family: z.literal('race-event'),
    sourceId: uuid,
    revision: positiveRevision.nullable(),
  }),
  z.strictObject({
    family: z.literal('plan-snapshot'),
    sourceId: opaque,
    version: positiveRevision.nullable(),
  }),
  versionParent('nutrition-plan'),
  versionParent('routine-schedule', opaque, opaque),
  versionParent('routine-blueprint', opaque, opaque),
  z.strictObject({ family: z.literal('routine-occurrence'), sourceId: opaque }),
  z.strictObject({
    family: z.literal('routine-run'),
    sourceId: opaque,
    version: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('revision'), revision }),
        z.strictObject({ kind: z.literal('timer'), stepId: opaque, revision }),
      ])
      .nullable(),
  }),
  z.strictObject({
    family: z.literal('session-completion'),
    sourceId: opaque,
    version: z.strictObject({ planVersionId: uuid, revision }).nullable(),
  }),
  versionParent('food-definition', opaque),
  versionParent('recovery-strategy'),
  versionParent('recovery-method'),
  versionParent('workout-template'),
  versionParent('supplementary-exercise'),
  versionParent('resource'),
  z.strictObject({
    family: z.literal('activity'),
    sourceId: uuid,
    version: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('revision'), revision }),
        z.strictObject({ kind: z.literal('source_revision'), source: activitySource }),
      ])
      .nullable(),
  }),
  z.strictObject({ family: z.literal('intake'), sourceId: opaque, revisionId: uuid.nullable() }),
  z.strictObject({ family: z.literal('intake-origin'), sourceId: uuid }),
  z.strictObject({
    family: z.literal('checkin'),
    sourceId: uuid,
    revision: positiveRevision.nullable(),
  }),
  z.strictObject({
    family: z.literal('checklist-confirmation'),
    sourceId: opaque,
    revisionId: uuid.nullable(),
  }),
  z.strictObject({
    family: z.literal('course'),
    sourceId: uuid,
    version: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('revision'), revisionId: uuid, revision }),
        z.strictObject({ kind: z.literal('head'), revision: positiveRevision }),
      ])
      .nullable(),
  }),
  z.strictObject({
    family: z.literal('activity-track'),
    sourceId: uuid,
    version: z.strictObject({ trackId: uuid, revision }).nullable(),
  }),
  z.strictObject({
    family: z.literal('gallery-media'),
    sourceId: uuid,
    accessRevision: revision.nullable(),
  }),
]);
const ordinal = z.number().int().min(1).max(5000);
const parent = z.strictObject({
  evidenceId: uuid,
  ordinal,
  identity: manualSourcePersonalParentIdentitySchema,
  role: z.enum(['source', 'parent', 'lineage', 'target', 'pin_parent', 'origin']),
  membership: z
    .discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('workout_target'),
        routineVersionId: uuid,
        targetSetId: opaque,
      }),
      z.strictObject({
        kind: z.literal('session_target'),
        planVersionId: uuid,
        sessionId: opaque,
        targetSetId: opaque,
      }),
    ])
    .nullable(),
});
const location = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('unavailable'),
    reason: z.enum([
      'payload_purged',
      'private_source_not_rendered',
      'legacy_association_unavailable',
    ]),
  }),
  z.strictObject({
    state: z.literal('known'),
    members: z
      .array(
        z.strictObject({
          domain: z.enum(['training', 'nutrition', 'recovery', 'routine_schedule', 'race']),
          aggregateId: uuid,
          side: z.enum(['before', 'hypothetical_after']),
          component: z.enum([
            'training_session',
            'nutrition_item',
            'recovery_option',
            'routine_step',
            'race_timing',
          ]),
          memberId: opaque.nullable(),
          parent: manualSourcePersonalParentIdentitySchema,
        }),
      )
      .min(1)
      .max(5000),
  }),
]);
const ref = z.strictObject({
  evidenceId: uuid,
  ordinal,
  identity: manualSourcePersonalIdentitySchema,
  parentCoverage: z.enum(['saved_parents', 'legacy_association_unavailable']),
  existence: z.strictObject({
    basis: z.literal('export_snapshot'),
    state: z.enum(['present', 'deleted', 'unavailable', 'historical_body_unavailable']),
  }),
  location,
});
const chain = z.strictObject({
  evidenceId: uuid,
  decisionId: uuid,
  proposalId: uuid,
  savedRefCount: z.number().int().min(1).max(5000),
  savedParentCount: z.number().int().min(0).max(8388608),
  savedSuppressionCount: z.number().int().min(0).max(1000000),
  body: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('present') }),
    z.strictObject({ state: z.literal('purged'), eventId: uuid, occurredAt: instant }),
  ]),
});
const eventKind = z.enum([
  'tenant_erased',
  'race_event_deleted',
  'resource_deleted',
  'gallery_media_deleted',
  'activity_deleted',
  'course_deleted',
  'intake_entry_deleted',
  'check_in_deleted',
  'manual_review_source_suppressed',
  'manual_review_source_suppressed_v2',
]);
const suppression = z.strictObject({
  evidenceId: uuid,
  eventId: uuid,
  occurredAt: instant,
  recordVersion: z.number().int().min(1).max(7),
  kind: eventKind,
  matchedRefOrdinals: z.array(ordinal).min(1).max(5000),
});
const origin = z.strictObject({
  planId: uuid,
  versionId: uuid,
  itemId: opaque,
  originVersionId: uuid,
  eventId: uuid,
  occurredAt: instant,
  eventKind: z.literal('race_event_deleted'),
});
const lineage = z.strictObject({
  planId: uuid,
  versionId: uuid,
  version: positiveRevision,
  priorVersionId: uuid,
  priorVersion: positiveRevision,
  itemId: opaque,
  originVersionId: uuid,
  eventId: uuid,
  disposition: z.enum(['retained', 'reconnected', 'carried']),
});
/** Nested codecs require an independently prebounded input. Unknown transport
 * callers must use manualSourcePersonalExportSchema, whose plain guard runs first. */
export const manualSourcePersonalExportFields = {
  manualSourceChains: z.array(chain).max(1000),
  manualSavedSourceRefs: z.array(ref).max(5000000),
  manualSavedSourceParents: z.array(parent).max(8388608),
  manualSavedSourceSuppressions: z.array(suppression).max(1000000),
  nutritionDisconnectionOrigins: z.array(origin).max(5000000),
  nutritionDisconnectionLineage: z.array(lineage).max(5000000),
};
type Data = z.infer<z.ZodObject<typeof manualSourcePersonalExportFields>>;
function key(evidenceId: string, ordinal: number) {
  return JSON.stringify([evidenceId, ordinal]);
}
function primaryParent(
  i: ManualSourcePersonalIdentity,
): z.infer<typeof manualSourcePersonalParentIdentitySchema> {
  switch (i.kind) {
    case 'race-event':
    case 'race-timing-pin-fragment':
      return { family: 'race-event', sourceId: i.sourceId, revision: i.revision };
    case 'plan-snapshot':
      return { family: 'plan-snapshot', sourceId: i.sourceId, version: i.version };
    case 'nutrition-plan-version':
      return { family: 'nutrition-plan', sourceId: i.sourceId, versionId: i.versionId };
    case 'routine-schedule-version':
      return { family: 'routine-schedule', sourceId: i.sourceId, versionId: i.versionId };
    case 'routine-blueprint-version':
      return { family: 'routine-blueprint', sourceId: i.sourceId, versionId: i.versionId };
    case 'routine-occurrence':
      return { family: 'routine-occurrence', sourceId: i.sourceId };
    case 'routine-run':
      return {
        family: 'routine-run',
        sourceId: i.sourceId,
        version: { kind: 'revision', revision: i.revision },
      };
    case 'session-completion':
      return {
        family: 'session-completion',
        sourceId: i.sourceId,
        version: { planVersionId: i.planVersionId, revision: i.revision },
      };
    case 'food-definition-version':
      return { family: 'food-definition', sourceId: i.sourceId, versionId: i.versionId };
    case 'recovery-method-version':
      return { family: 'recovery-method', sourceId: i.sourceId, versionId: i.versionId };
    case 'recovery-strategy-version':
      return { family: 'recovery-strategy', sourceId: i.sourceId, versionId: i.versionId };
    case 'supplementary-exercise-version':
      return { family: 'supplementary-exercise', sourceId: i.sourceId, versionId: i.versionId };
    case 'workout-template-version':
      return { family: 'workout-template', sourceId: i.sourceId, versionId: i.versionId };
    case 'resource-text-version':
      return { family: 'resource', sourceId: i.sourceId, versionId: i.versionId };
    case 'supplementary-session-copy':
      return { family: 'plan-snapshot', sourceId: i.sourceId, version: null };
    case 'activity-canonical-values':
    case 'activity-overlay':
      return {
        family: 'activity',
        sourceId: i.sourceId,
        version: { kind: 'revision', revision: i.revision },
      };
    case 'manual-activity-source':
      return {
        family: 'activity',
        sourceId: i.sourceId,
        version: { kind: 'source_revision', source: i.source },
      };
    case 'intake-revision':
      return { family: 'intake', sourceId: i.sourceId, revisionId: i.revisionId };
    case 'checkin-revision':
      return { family: 'checkin', sourceId: i.sourceId, revision: i.revision };
    case 'checklist-confirmation':
      return { family: 'checklist-confirmation', sourceId: i.sourceId, revisionId: i.revisionId };
    case 'routine-timer':
      return {
        family: 'routine-run',
        sourceId: i.sourceId,
        version: { kind: 'timer', stepId: i.stepId, revision: i.revision },
      };
    case 'course-revision':
      return {
        family: 'course',
        sourceId: i.sourceId,
        version: { kind: 'revision', revisionId: i.revisionId, revision: i.revision },
      };
    case 'course-head-descriptor':
      return {
        family: 'course',
        sourceId: i.sourceId,
        version: { kind: 'head', revision: i.revision },
      };
    case 'activity-track-descriptor':
      return {
        family: 'activity-track',
        sourceId: i.sourceId,
        version: { trackId: i.trackId, revision: i.revision },
      };
    case 'gallery-descriptor':
      return { family: 'gallery-media', sourceId: i.sourceId, accessRevision: i.accessRevision };
  }
}
/** Portable structural correspondence only. Source visibility, event provenance,
 * retained reader authentication and whole account census remain external. */
export function validateManualSourcePersonalExportTuples(data: Data, ctx: z.RefinementCtx) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const chains = new Map(data.manualSourceChains.map((v) => [v.evidenceId, v]));
  if (chains.size !== data.manualSourceChains.length) fail('Duplicate source chain');
  const roles = data.manualSourceChains.flatMap((v) => [v.evidenceId, v.decisionId, v.proposalId]);
  if (new Set(roles).size !== roles.length) fail('Distinct original chain roles required');
  const refs = new Map(data.manualSavedSourceRefs.map((v) => [key(v.evidenceId, v.ordinal), v]));
  if (refs.size !== data.manualSavedSourceRefs.length) fail('Duplicate source reference ordinal');
  const refsByEvidence = new Map<string, Data['manualSavedSourceRefs']>();
  const nutritionPinRefs = new Set<string>();
  for (const r of data.manualSavedSourceRefs) {
    const roster = refsByEvidence.get(r.evidenceId);
    if (roster) roster.push(r);
    else refsByEvidence.set(r.evidenceId, [r]);
    if (r.identity.kind === 'nutrition-plan-version')
      nutritionPinRefs.add(
        JSON.stringify([r.evidenceId, r.identity.sourceId, r.identity.versionId]),
      );
  }
  // Parsed finite typed tuples have the same schema-defined field order as
  // primaryParent/location tuples. Keys are exact JSON, never digest equality.
  const parentsByEvidenceOrdinal = new Map<string, Set<string>>();
  const parentCounts = new Map<string, number>();
  const suppressionCounts = new Map<string, number>();
  for (const p of data.manualSavedSourceParents) {
    const pk = key(p.evidenceId, p.ordinal);
    const identities = parentsByEvidenceOrdinal.get(pk);
    if (identities) identities.add(JSON.stringify(p.identity));
    else parentsByEvidenceOrdinal.set(pk, new Set([JSON.stringify(p.identity)]));
    parentCounts.set(p.evidenceId, (parentCounts.get(p.evidenceId) ?? 0) + 1);
  }
  for (const e of data.manualSavedSourceSuppressions)
    suppressionCounts.set(e.evidenceId, (suppressionCounts.get(e.evidenceId) ?? 0) + 1);
  const identityKeys = new Set<string>();
  for (const r of data.manualSavedSourceRefs) {
    const identityKey = JSON.stringify([r.evidenceId, r.identity]);
    // Nonmanual sourceRecordId redaction is lossy: saved ordinals must retain
    // distinct original refs that happen to have the same safe projection.
    const injective =
      r.identity.kind !== 'manual-activity-source' || r.identity.source.kind === 'manual';
    if (injective && identityKeys.has(identityKey)) fail('Duplicate saved safe source identity');
    if (injective) identityKeys.add(identityKey);
    const c = chains.get(r.evidenceId);
    if (!c) fail('Source reference requires original chain');
    if (
      c?.body.state === 'purged' &&
      (r.location.state !== 'unavailable' || r.location.reason !== 'payload_purged')
    )
      fail('Purged location must remain unavailable');
    const parents = parentsByEvidenceOrdinal.get(key(r.evidenceId, r.ordinal));
    if (
      r.parentCoverage === 'saved_parents' &&
      !parents?.has(JSON.stringify(primaryParent(r.identity)))
    )
      fail('Exact saved principal parent required');
    if (r.location.state === 'known') {
      const locations = new Set<string>();
      for (const loc of r.location.members) {
        const expectedComponent = {
          training: 'training_session',
          nutrition: 'nutrition_item',
          recovery: 'recovery_option',
          routine_schedule: 'routine_step',
          race: 'race_timing',
        }[loc.domain];
        if (loc.component !== expectedComponent) fail('Planned domain/component mismatch');
        const locationKey = JSON.stringify(loc);
        if (locations.has(locationKey)) fail('Duplicate planned location');
        locations.add(locationKey);
        if (!parents?.has(JSON.stringify(loc.parent)))
          fail('Planned location requires exact known parent');
      }
    }
  }
  for (const c of chains.values()) {
    const roster = refsByEvidence.get(c.evidenceId) ?? [];
    if (
      roster.length !== c.savedRefCount ||
      roster.some((v, i) => v.ordinal !== i + 1) ||
      (parentCounts.get(c.evidenceId) ?? 0) !== c.savedParentCount ||
      (suppressionCounts.get(c.evidenceId) ?? 0) !== c.savedSuppressionCount
    )
      fail('Exact ordered source/parent/suppression census required');
  }
  const parentKeys = new Set<string>();
  for (const p of data.manualSavedSourceParents) {
    const r = refs.get(key(p.evidenceId, p.ordinal));
    if (!r) fail('Foreign or absent source parent reference');
    const pk = JSON.stringify(p);
    if (parentKeys.has(pk)) fail('Duplicate parent membership');
    parentKeys.add(pk);
    if (p.role === 'target') {
      if (p.identity.family !== 'supplementary-exercise' || p.identity.versionId === null)
        fail('Exact exercise version target required');
      if (r?.identity.kind === 'workout-template-version') {
        if (
          p.membership?.kind !== 'workout_target' ||
          p.membership.routineVersionId !== r.identity.versionId
        )
          fail('Exact saved workout target membership required');
      } else if (r?.identity.kind === 'supplementary-session-copy') {
        if (
          p.membership?.kind !== 'session_target' ||
          p.membership.planVersionId !== r.identity.sourceId ||
          p.membership.sessionId !== r.identity.sessionId
        )
          fail('Exact saved session target membership required');
      } else fail('Target requires actual template/session source');
    } else if (p.membership !== null) fail('Unexpected parent membership');
    if (
      p.role === 'pin_parent' &&
      (r?.identity.kind !== 'race-timing-pin-fragment' ||
        p.identity.family !== 'nutrition-plan' ||
        p.identity.versionId === null ||
        !nutritionPinRefs.has(
          JSON.stringify([
            p.evidenceId,
            p.identity.sourceId,
            p.identity.family === 'nutrition-plan' ? p.identity.versionId : null,
          ]),
        ))
    )
      fail('Exact stored nutrition pin parent reference required');
  }
  const events = new Map<string, Data['manualSavedSourceSuppressions'][number]>();
  for (const e of data.manualSavedSourceSuppressions) {
    const eventKey = JSON.stringify([e.evidenceId, e.eventId]);
    if (events.has(eventKey)) fail('Duplicate suppression event');
    events.set(eventKey, e);
    if (
      !chains.has(e.evidenceId) ||
      new Set(e.matchedRefOrdinals).size !== e.matchedRefOrdinals.length ||
      e.matchedRefOrdinals.some((n) => !refs.has(key(e.evidenceId, n)))
    )
      fail('Suppression requires exact original chain/reference membership');
    if (
      (e.kind === 'manual_review_source_suppressed_v2') !== (e.recordVersion === 7) ||
      (e.kind === 'manual_review_source_suppressed' && e.recordVersion !== 6)
    )
      fail('Original suppression version/kind mismatch');
  }
  for (const c of chains.values()) {
    if (c.body.state === 'present' && c.savedSuppressionCount !== 0)
      fail('Suppressed chain body must be purged');
    if (c.body.state === 'purged') {
      const e = events.get(JSON.stringify([c.evidenceId, c.body.eventId]));
      if (!e || e.occurredAt !== c.body.occurredAt)
        fail('Exact original chain purge metadata required');
    }
  }
  const origins = new Map(
    data.nutritionDisconnectionOrigins.map((v) => [
      JSON.stringify([v.planId, v.versionId, v.itemId]),
      v,
    ]),
  );
  if (origins.size !== data.nutritionDisconnectionOrigins.length)
    fail('Duplicate nutrition disconnection origin');
  for (const o of origins.values())
    if (o.versionId !== o.originVersionId)
      fail('Direct marker origin must be its actual original version');
  const predecessors = new Map(
    data.nutritionDisconnectionLineage.map((p) => [
      JSON.stringify([p.planId, p.versionId, p.itemId]),
      p,
    ]),
  );
  const lineageKeys = new Set<string>();
  for (const l of data.nutritionDisconnectionLineage) {
    const lk = JSON.stringify([l.planId, l.versionId, l.itemId]);
    if (lineageKeys.has(lk)) fail('Duplicate nutrition lineage');
    lineageKeys.add(lk);
    const original = origins.get(JSON.stringify([l.planId, l.originVersionId, l.itemId]));
    if (
      !original ||
      original.originVersionId !== l.originVersionId ||
      original.eventId !== l.eventId ||
      l.version !== l.priorVersion + 1 ||
      l.versionId === l.priorVersionId
    )
      fail('Exact nutrition original/prior lineage required');
    const predecessor = predecessors.get(JSON.stringify([l.planId, l.priorVersionId, l.itemId]));
    if (
      (l.disposition === 'carried' || l.priorVersionId !== l.originVersionId) &&
      (!predecessor ||
        predecessor.version !== l.priorVersion ||
        predecessor.originVersionId !== l.originVersionId ||
        predecessor.eventId !== l.eventId)
    )
      fail('Lineage requires its exact predecessor association');
  }
}
export const manualSourcePersonalExportSchema = raceManualInternalWholePlainSchema.pipe(
  z
    .strictObject({
      schemaVersion: z.literal(1),
      sourceProvenanceCoverage: z.literal('saved_safe_dependency_facts'),
      sourceAuthentication: z.literal('not_authenticated'),
      originalEventAuthentication: z.literal('not_authenticated'),
      ...manualSourcePersonalExportFields,
    })
    .superRefine(validateManualSourcePersonalExportTuples),
);
export type ManualSourcePersonalExport = z.infer<typeof manualSourcePersonalExportSchema>;
