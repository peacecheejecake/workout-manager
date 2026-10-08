import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import { z } from 'zod';
import type { PlanSnapshot } from '@workout/contracts/planning';
import {
  manualSourcePersonalExportSchema,
  type ManualSourcePersonalExport,
} from '@workout/contracts/manual-source-personal-export';
import { raceManualInternalWholePlainSchema } from '@workout/contracts/race-manual-internal-personal-export';
import { raceManualReviewCandidateV2ResultSchema } from '@workout/server-coaching/race-manual-review-candidate-v2';
import type { Transaction } from './database.js';
import { RetainedPersonalExportError } from './retained-personal-export.js';
import {
  raceManualReviewFullCopiedInventoryV2Schema,
  enumerateRaceManualReviewFullCopiedSourcesV2,
} from './race-manual-review-full-copied-inventory-v2.js';
import { raceManualReviewLifecycleEdgeV2Schema } from './race-manual-review-lifecycle-inventory-v2.js';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

const fields = raceManualReviewFullCopiedInventoryV2Schema.out.shape.refs.element.shape;
const maximum = 8 * 1024 * 1024;
function fail(code: RetainedPersonalExportError['code']): never {
  throw new RetainedPersonalExportError(code);
}
const manualSchema = z.strictObject({
  schemaVersion: z.literal(1),
  chains: z
    .array(
      z.strictObject({
        evidenceId: z.uuid(),
        decisionId: z.uuid(),
        proposalId: z.uuid(),
        savedRefCount: z.number().int(),
        savedParentCount: z.number().int(),
        savedSuppressionCount: z.number().int(),
        body: z.unknown(),
        preparation: z.unknown().nullable(),
      }),
    )
    .max(1000),
  refs: z.array(
    z.strictObject({
      evidenceId: z.uuid(),
      ordinal: z.number().int(),
      identity: fields.identity,
      dtoDigest: fields.dtoDigest,
      copiedLocations: fields.copiedLocations,
      trainingAggregateId: z.uuid().nullable(),
      sourceKind: z.enum(['manual', 'fit', 'fixture', 'healthkit', 'garmin']).nullable(),
      parentCoverage: z.enum(['saved_parents', 'legacy_association_unavailable']),
      existence: z.unknown(),
      location: z.unknown(),
    }),
  ),
  parents: z.array(
    z.strictObject({
      evidenceId: z.uuid(),
      ordinal: z.number().int(),
      edge: raceManualReviewLifecycleEdgeV2Schema,
    }),
  ),
  suppressions: z.array(z.unknown()),
});
const nutritionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  origins: z.array(z.unknown()),
  lineage: z.array(z.unknown()),
});
type Identity = z.infer<typeof fields.identity>;
type Edge = z.infer<typeof raceManualReviewLifecycleEdgeV2Schema>;
/** Server-private correspondence of already strictly decoded frozen observations.
 * This identifies rendered content; it grants no source or processing authority. */
export function isRenderedTrainingBeforeSource(
  current: { aggregateId: string; snapshot: PlanSnapshot } | null,
  projected: PlanSnapshot | null,
  ref: { sourceId: string; version: number },
  aggregateId: string | null,
): boolean {
  if (current === null || projected === null) {
    if (current !== null || projected !== null) fail('CORRUPT');
    return false;
  }
  if (impactDependencyDigest(current.snapshot) !== impactDependencyDigest(projected))
    fail('CORRUPT');
  if (ref.sourceId !== projected.id || ref.version !== projected.version) return false;
  if (aggregateId === null) return false;
  if (aggregateId !== current.aggregateId) fail('CORRUPT');
  return true;
}

function activitySource(kind: string | null, sourceRecordId: string, sourceRevision: number) {
  if (kind === 'manual')
    return { kind, sourceRecordId: z.uuid().parse(sourceRecordId), sourceRevision };
  if (kind === 'fit' || kind === 'fixture' || kind === 'healthkit' || kind === 'garmin')
    return { kind, sourceRevision, identifier: 'sensitive_identifier_not_exported' as const };
  return fail('CORRUPT');
}
function identity(i: Identity, kind: string | null) {
  if (i.kind !== 'manual-activity-source') return i;
  return {
    kind: i.kind,
    sourceId: i.sourceId,
    source: activitySource(kind, i.sourceRecordId, i.sourceRevision),
  };
}
function parent(e: Edge) {
  const id = { family: e.family, sourceId: e.sourceId };
  const key = e.versionKey;
  const numeric = () =>
    key === null ? null : z.number().int().min(0).max(2147483647).parse(Number(key));
  const array = () =>
    z.array(z.union([z.string(), z.number().int()])).parse(JSON.parse(z.string().parse(key)));
  switch (e.family) {
    case 'race-event':
      return { ...id, revision: numeric() };
    case 'plan-snapshot':
      return { ...id, version: numeric() };
    case 'nutrition-plan':
    case 'routine-schedule':
    case 'routine-blueprint':
    case 'food-definition':
    case 'recovery-strategy':
    case 'recovery-method':
    case 'workout-template':
    case 'supplementary-exercise':
    case 'resource':
      return { ...id, versionId: key };
    case 'routine-occurrence':
    case 'intake-origin':
      return id;
    case 'intake':
    case 'checklist-confirmation':
      return { ...id, revisionId: key };
    case 'checkin':
      return { ...id, revision: numeric() };
    case 'gallery-media':
      return { ...id, accessRevision: numeric() };
    case 'activity': {
      if (key === null) return { ...id, version: null };
      if (!key.startsWith('['))
        return { ...id, version: { kind: 'revision', revision: numeric() } };
      const a = array();
      if (a.length !== 3) fail('CORRUPT');
      return {
        ...id,
        version: {
          kind: 'source_revision',
          source: activitySource(
            z.string().parse(a[0]),
            z.string().parse(a[1]),
            z.number().int().parse(a[2]),
          ),
        },
      };
    }
    case 'routine-run': {
      if (key === null) return { ...id, version: null };
      if (!key.startsWith('['))
        return { ...id, version: { kind: 'revision', revision: numeric() } };
      const a = array();
      if (a.length !== 2) fail('CORRUPT');
      return { ...id, version: { kind: 'timer', stepId: a[0], revision: a[1] } };
    }
    case 'session-completion': {
      const a = key === null ? null : array();
      if (a && a.length !== 2) fail('CORRUPT');
      return { ...id, version: a ? { planVersionId: a[0], revision: a[1] } : null };
    }
    case 'activity-track': {
      const a = key === null ? null : array();
      if (a && a.length !== 2) fail('CORRUPT');
      return { ...id, version: a ? { trackId: a[0], revision: a[1] } : null };
    }
    case 'course': {
      if (key === null) return { ...id, version: null };
      if (!key.startsWith('[')) return { ...id, version: { kind: 'head', revision: numeric() } };
      const a = array();
      if (a.length !== 2) fail('CORRUPT');
      return { ...id, version: { kind: 'revision', revisionId: a[0], revision: a[1] } };
    }
  }
}
function membership(e: Edge) {
  if (e.role !== 'target') {
    if (e.membershipKey !== null) fail('CORRUPT');
    return null;
  }
  const a = e.membershipKey;
  if (!a) fail('CORRUPT');
  if (a.length === 2) return { kind: 'workout_target', routineVersionId: a[0], targetSetId: a[1] };
  if (a.length === 3)
    return { kind: 'session_target', planVersionId: a[0], sessionId: a[1], targetSetId: a[2] };
  return fail('CORRUPT');
}
/** Internal JSON is structural correspondence only, not a source/event credential.
 * Original frozen C/S/B is used solely for finite planned-member association;
 * raw body/path/provider IDs/SQL relation hashes never leave this projection. */
export function mapManualSourcePersonalExportV1(
  rawManual: unknown,
  rawNutrition: unknown,
): ManualSourcePersonalExport {
  try {
    raceManualInternalWholePlainSchema.parse({ rawManual, rawNutrition });
    const manual = manualSchema.parse(rawManual),
      nutrition = nutritionSchema.parse(rawNutrition);
    const parents = manual.parents.map((p) => ({
      evidenceId: p.evidenceId,
      ordinal: p.ordinal,
      identity: parent(p.edge),
      role: p.edge.role,
      membership: membership(p.edge),
    }));
    const parsed = new Map<
      string,
      {
        candidate: z.infer<typeof raceManualReviewCandidateV2ResultSchema>;
        context: z.infer<typeof raceImpactConsumedCaptureSchema>;
        refs: z.infer<typeof raceManualReviewFullCopiedInventoryV2Schema>['refs'];
      }
    >();
    for (const c of manual.chains)
      if (c.preparation !== null) {
        const prep = z
          .strictObject({
            context: z.unknown(),
            sourceInput: z.unknown(),
            candidate: raceManualReviewCandidateV2ResultSchema,
          })
          .parse(c.preparation);
        const inventory = enumerateRaceManualReviewFullCopiedSourcesV2(prep);
        if (inventory.inventoryState !== 'mapped' || inventory.refs.length !== c.savedRefCount)
          fail('CORRUPT');
        parsed.set(c.evidenceId, {
          candidate: prep.candidate,
          context: raceImpactConsumedCaptureSchema.parse(prep.context),
          refs: inventory.refs,
        });
      }
    const refs = manual.refs.map((r) => {
      let location = r.location;
      const c = parsed.get(r.evidenceId);
      if (c) {
        const observed = c.refs[r.ordinal - 1];
        if (
          !observed ||
          impactDependencyDigest(observed.identity) !== impactDependencyDigest(r.identity) ||
          observed.dtoDigest !== r.dtoDigest ||
          impactDependencyDigest(observed.copiedLocations) !==
            impactDependencyDigest(r.copiedLocations)
        )
          fail('CORRUPT');
        const members: unknown[] = [];
        if (c.candidate.status === 'assembled_readonly') {
          const p = c.candidate.body.projectionInput;
          if (
            r.identity.kind === 'nutrition-plan-version' &&
            r.copiedLocations.some((v) => v.startsWith('candidate.body.projectionInput.nutrition['))
          ) {
            const i = r.identity,
              row = p.nutrition.find(
                (v) => v.record.planId === i.sourceId && v.record.versionId === i.versionId,
              );
            if (row)
              for (const item of row.record.items)
                members.push({
                  domain: 'nutrition',
                  aggregateId: row.record.planId,
                  side: 'before',
                  component: 'nutrition_item',
                  memberId: item.id,
                  parent: {
                    family: 'nutrition-plan',
                    sourceId: i.sourceId,
                    versionId: i.versionId,
                  },
                });
          }
          if (
            r.identity.kind === 'plan-snapshot' &&
            r.copiedLocations.some((v) => v.startsWith('candidate.body.projectionInput.'))
          ) {
            const i = r.identity,
              row = p.currentPlan,
              edge = parents.find(
                (e) =>
                  e.evidenceId === r.evidenceId &&
                  e.ordinal === r.ordinal &&
                  e.identity.family === 'plan-snapshot',
              );
            if (
              row &&
              edge &&
              isRenderedTrainingBeforeSource(
                c.context.currentTraining,
                row,
                i,
                r.trainingAggregateId,
              )
            )
              for (const session of row.draft.sessions)
                members.push({
                  domain: 'training',
                  aggregateId: r.trainingAggregateId,
                  side: 'before',
                  component: 'training_session',
                  memberId: session.id,
                  parent: edge.identity,
                });
          }
          if (r.identity.kind === 'recovery-strategy-version') {
            const i = r.identity,
              row = c.context.recovery.find(
                (v) => v.record.strategyId === i.sourceId && v.record.versionId === i.versionId,
              );
            if (row)
              for (const option of row.record.draft.options)
                members.push({
                  domain: 'recovery',
                  aggregateId: row.aggregateId,
                  side: 'before',
                  component: 'recovery_option',
                  memberId: option.id,
                  parent: {
                    family: 'recovery-strategy',
                    sourceId: i.sourceId,
                    versionId: i.versionId,
                  },
                });
          }
          if (
            r.identity.kind === 'routine-schedule-version' ||
            r.identity.kind === 'routine-blueprint-version'
          ) {
            const i = r.identity;
            for (const row of p.routines) {
              const matches =
                i.kind === 'routine-schedule-version'
                  ? row.record.id === i.sourceId && row.record.versionId === i.versionId
                  : row.blueprint.routineId === i.sourceId &&
                    row.blueprint.versionId === i.versionId;
              const aggregate = z.uuid().safeParse(row.record.id);
              if (matches && aggregate.success)
                for (const step of row.blueprint.steps)
                  members.push({
                    domain: 'routine_schedule',
                    aggregateId: aggregate.data,
                    side: 'before',
                    component: 'routine_step',
                    memberId: step.id,
                    parent: {
                      family:
                        i.kind === 'routine-schedule-version'
                          ? 'routine-schedule'
                          : 'routine-blueprint',
                      sourceId: i.sourceId,
                      versionId: i.versionId,
                    },
                  });
            }
          }
          if (
            r.identity.kind === 'race-event' &&
            r.identity.sourceId === p.event.id &&
            r.identity.revision === p.event.revision
          )
            members.push({
              domain: 'race',
              aggregateId: p.event.id,
              side: 'before',
              component: 'race_timing',
              memberId: null,
              parent: { family: 'race-event', sourceId: p.event.id, revision: p.event.revision },
            });
        }
        if (members.length) location = { state: 'known', members };
      }
      return {
        evidenceId: r.evidenceId,
        ordinal: r.ordinal,
        identity: identity(r.identity, r.sourceKind),
        parentCoverage: r.parentCoverage,
        existence: r.existence,
        location,
      };
    });
    return manualSourcePersonalExportSchema.parse({
      schemaVersion: 1,
      sourceProvenanceCoverage: 'saved_safe_dependency_facts',
      sourceAuthentication: 'not_authenticated',
      originalEventAuthentication: 'not_authenticated',
      manualSourceChains: manual.chains.map(({ preparation: _preparation, ...c }) => c),
      manualSavedSourceRefs: refs,
      manualSavedSourceParents: parents,
      manualSavedSourceSuppressions: manual.suppressions,
      nutritionDisconnectionOrigins: nutrition.origins,
      nutritionDisconnectionLineage: nutrition.lineage,
    });
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    fail('CORRUPT');
  }
}
/** Reader availability is not whole runtime support or processing permission. */
export async function readManualSourcePersonalExportV1In(
  tx: Transaction,
  byteLimit = maximum,
  onMeasured?: (bytes: number) => void,
) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > maximum) fail('CORRUPT');
  let remaining = byteLimit;
  const read = async (signature: string) => {
    const capability = await tx.query(
      `SELECT to_regprocedure($1::text) IS NOT NULL AS installed,CASE WHEN to_regprocedure($1::text) IS NULL THEN false ELSE has_function_privilege(current_user,to_regprocedure($1::text),'EXECUTE') END AS executable`,
      [signature],
    );
    if (capability.rows.length !== 1) fail('CORRUPT');
    raceManualInternalWholePlainSchema.parse(capability.rows[0]);
    const available = z
      .strictObject({ installed: z.boolean(), executable: z.boolean() })
      .parse(capability.rows[0]);
    if (!available.installed || !available.executable) fail('UNSUPPORTED');
    if (remaining < 1) fail('TOO_LARGE');
    const name =
      signature === 'public.read_manual_race_source_personal_export_v1(integer)'
        ? 'public.read_manual_race_source_personal_export_v1'
        : 'public.read_nutrition_disconnection_personal_export_v1';
    const result = await tx.query(
      `WITH observed AS MATERIALIZED (SELECT ${name}($1::integer) AS source), measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed) SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`,
      [remaining],
    );
    if (result.rows.length !== 1) fail('CORRUPT');
    raceManualInternalWholePlainSchema.parse(result.rows[0]);
    const value = z
      .strictObject({
        bytes: z
          .string()
          .regex(/^[1-9]\d*$/)
          .max(16),
        source: z.unknown(),
      })
      .parse(result.rows[0]);
    if (BigInt(value.bytes) > BigInt(remaining)) fail('TOO_LARGE');
    if (value.source === null) fail('CORRUPT');
    // Server-reported JSONB UTF8 may include whitespace; compact JSON must
    // fit both the actual caller remainder and that reported reservation.
    // This bounded walk performs no full-string allocation or accessor call.
    createBoundedPlainJsonSchema(Math.min(remaining, Number(value.bytes))).parse(value.source);
    remaining -= Number(value.bytes);
    onMeasured?.(Number(value.bytes));
    return value.source;
  };
  try {
    const manual = await read('public.read_manual_race_source_personal_export_v1(integer)');
    const nutrition = await read('public.read_nutrition_disconnection_personal_export_v1(integer)');
    return mapManualSourcePersonalExportV1(manual, nutrition);
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    const sql = z
      .object({ message: z.string().optional(), code: z.string().optional() })
      .safeParse(error);
    if (sql.success && sql.data.message === 'MANUAL_SOURCE_EXPORT_TOO_LARGE') fail('TOO_LARGE');
    // Unknown SQL failures propagate as a sanitized failed operation; no retry in
    // an aborted transaction and no partial/empty export recovery.
    fail('CORRUPT');
  }
}
