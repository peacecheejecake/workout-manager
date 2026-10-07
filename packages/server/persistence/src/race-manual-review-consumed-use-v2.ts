import { z } from 'zod';
import type { Transaction } from './database.js';
import { prepareRaceManualReviewFullOwnedBindingV2In } from './race-manual-review-full-owned-binding-consumer-v2.js';
import { prepareRaceManualReviewRetainedPayloadV2 } from './race-manual-review-retained-payload-v2.js';
import { raceManualReviewFullCopiedInventoryV2Schema } from './race-manual-review-full-copied-inventory-v2.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { RaceImpactDependencyError } from './race-plan-impact-dependencies.js';

export function assertRaceManualPlainV2(value: unknown): void {
  const active = new WeakSet<object>();
  let visits = 0;
  function visit(v: unknown, depth: number): void {
    if (++visits > 4194305 || depth > 64) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
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
      if (!d.enumerable || !('value' in d)) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      visit(d.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
}
const identity = raceManualReviewFullCopiedInventoryV2Schema.out.shape.refs.element.shape.identity;
export const raceManualConsumedUseReasonV2Schema = z.enum([
  'preparation_blocked',
  'source_unavailable',
  'activity_provenance_unavailable',
  'healthkit_policy_adapter_unavailable',
  'garmin_policy_adapter_unavailable',
  'media_policy_adapter_unavailable',
  'course_lineage_use_unavailable',
]);
const limitations = {
  authority: 'none',
  permissionAuthority: 'none',
  storage: 'not_persisted',
  freshness: 'not_checked',
  admissionAllowed: false,
  approvalAllowed: false,
} as const;
export const raceManualConsumedUseFactsV2Schema = z.strictObject({
  purpose: z.literal('manual_race_date_change'),
  facts: z
    .array(
      z.strictObject({
        identity,
        use: z.enum(['core_manual', 'own_retained_text', 'blocked']),
        reason: raceManualConsumedUseReasonV2Schema.nullable(),
        sourceAuthentication: z.literal('unverified'),
        resourceAccess: z
          .strictObject({
            accessRevision: z.number().int().positive().max(2147483647),
            deleted: z.boolean(),
            cleanupPending: z.boolean(),
          })
          .nullable(),
      }),
    )
    .max(5000),
  authority: z.literal('none'),
  permissionAuthority: z.literal('none'),
  storage: z.literal('not_persisted'),
  freshness: z.literal('not_checked'),
  admissionAllowed: z.literal(false),
  approvalAllowed: z.literal(false),
});
function boundedResult<T>(result: T): T {
  assertRaceManualPlainV2(result);
  return result;
}
/** Finite policy requirement classification only. This pure function cannot grant
 * permission or authenticate a supplied descriptor. The entry below obtains the
 * descriptor from actual owned capture and verifies resource cleanup in SQL. */
export function classifyRaceManualConsumedSourceV2(
  kind: z.infer<typeof identity>['kind'],
  sourceKind: string | null,
  provider: 'garmin-official' | 'garmin-connect-unofficial' | null = null,
) {
  if (kind === 'gallery-descriptor') return 'media_policy_adapter_unavailable' as const;
  if (kind === 'course-revision' || kind === 'course-head-descriptor')
    return 'course_lineage_use_unavailable' as const;
  if (
    [
      'manual-activity-source',
      'activity-overlay',
      'activity-canonical-values',
      'activity-track-descriptor',
    ].includes(kind)
  ) {
    if (sourceKind === 'healthkit') return 'healthkit_policy_adapter_unavailable' as const;
    if (provider !== null) return 'garmin_policy_adapter_unavailable' as const;
    if (sourceKind !== 'manual') return 'activity_provenance_unavailable' as const;
  }
  return null;
}
/** Only intent enters this server preparation boundary. Caller JSON permissions,
 * observations and claimed source ownership are never consumed as credentials.
 * Same fenced transaction/budget as full preparation; no writes or receipt. */
export async function prepareRaceManualConsumedUseV2In(
  tx: Transaction,
  unknownIntent: unknown,
  budget: SourceBudget,
) {
  assertRaceManualPlainV2(unknownIntent);
  const binding = await prepareRaceManualReviewFullOwnedBindingV2In(tx, unknownIntent, budget);
  const bp = binding.preparation;
  const diagnostics = {
    bindingStatus: binding.status,
    preparationStatus: bp.status,
    consumedScope: 'consumedScope' in bp ? bp.consumedScope : null,
    currentManualBinding: 'currentManualBinding' in bp ? bp.currentManualBinding : null,
    originalStage: 'stage' in bp ? bp.stage : null,
    originalReason: 'reason' in bp ? bp.reason : null,
  };
  if (binding.status !== 'observed_readonly')
    return boundedResult({
      status: 'blocked' as const,
      reason: 'preparation_blocked' as const,
      ...diagnostics,
      ...limitations,
    });
  const preparation = {
    context: binding.preparation.context,
    sourceInput: binding.preparation.sourceInput,
    candidate: binding.preparation.candidate,
  };
  const retained = prepareRaceManualReviewRetainedPayloadV2({
    state: 'present',
    preparation,
    inventory: binding.inventory,
    dtoObservations: binding.owned,
    sqlObservations: binding.sqlObservation,
    currentAuthority: {
      authority: 'none',
      freshness: 'not_checked',
      permissionAuthority: 'none',
      lifecycleAuthority: 'none',
      admissionAllowed: false,
      approvalAllowed: false,
    },
  });
  if (retained.state !== 'present' || retained.status !== 'structurally_corresponding')
    return boundedResult({
      status: 'blocked' as const,
      reason: 'source_unavailable' as const,
      ...diagnostics,
      ...limitations,
    });
  const c = preparation.context;
  const activities = new Map(
    c.sourcePermissionManifest.activityMediaPermissions.activities.map((a) => [
      a.id.toLowerCase(),
      a,
    ]),
  );
  const garminSources = new Map(
    c.sourcePermissionManifest.activityMediaPermissions.garminLineage.map((f) => [
      JSON.stringify([f.kind, f.source_id]),
      f.provider,
    ]),
  );
  const resources = new Map(
    (c.resourceReadFacts?.facts ?? []).map((f) => [f.requestedVersionId.toLowerCase(), f]),
  );
  const facts: z.infer<typeof raceManualConsumedUseFactsV2Schema>['facts'] = [];
  for (const ref of binding.inventory.refs) {
    const i = ref.identity;
    const activity = activities.get(i.sourceId.toLowerCase());
    let reason: z.infer<typeof raceManualConsumedUseReasonV2Schema> | null =
      classifyRaceManualConsumedSourceV2(
        i.kind,
        activity?.source.state === 'present' ? activity.source.kind : null,
        activity?.source.state === 'present'
          ? (garminSources.get(JSON.stringify([activity.source.kind, activity.source.sourceId])) ??
              null)
          : null,
      );
    let resourceAccess: z.infer<
      typeof raceManualConsumedUseFactsV2Schema
    >['facts'][number]['resourceAccess'] = null;
    if (i.kind === 'resource-text-version') {
      const fact = resources.get(i.versionId.toLowerCase());
      if (
        !fact ||
        !fact.record ||
        !fact.current ||
        fact.current.deleted ||
        fact.record.resourceId.toLowerCase() !== i.sourceId.toLowerCase()
      )
        reason = 'source_unavailable';
      else {
        reserveSourceBudget(budget, 1024n, 1);
        const row = z
          .strictObject({ pending: z.boolean() })
          .parse(
            (
              await tx.query(
                'SELECT public.resource_derived_cleanup_pending($1::uuid) AS pending',
                [i.sourceId],
              )
            ).rows[0],
          );
        resourceAccess = {
          accessRevision: fact.current.accessRevision,
          deleted: fact.current.deleted,
          cleanupPending: row.pending,
        };
        // AI-derived cleanup is observed metadata, not withdrawal of owned raw text.
      }
    }
    facts.push({
      identity: i,
      use: reason
        ? 'blocked'
        : i.kind === 'resource-text-version'
          ? 'own_retained_text'
          : 'core_manual',
      reason,
      sourceAuthentication: 'unverified',
      resourceAccess,
    });
  }
  const uses = raceManualConsumedUseFactsV2Schema.parse({
    purpose: 'manual_race_date_change',
    facts,
    ...limitations,
  });
  const result = facts.some((f) => f.reason)
    ? {
        status: 'blocked' as const,
        reason: 'consumed_source_policy_blocked' as const,
        ...diagnostics,
        uses,
        ...limitations,
      }
    : { status: 'observed_manual_use' as const, retained, ...diagnostics, uses, ...limitations };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return result;
}
export type RaceManualConsumedUsePreparationV2 = Awaited<
  ReturnType<typeof prepareRaceManualConsumedUseV2In>
>;
