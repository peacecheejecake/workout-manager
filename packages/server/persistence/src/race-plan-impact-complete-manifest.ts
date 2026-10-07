import { localImportedActivityReadFactsSchema } from './race-plan-impact-local-imported-activity-read-facts.js';
import { mediaRetainedReadFactsSchema } from './race-plan-impact-media-read-facts.js';
import {
  validateMediaReadManifest,
  type MediaReadManifestBlocker,
} from './race-plan-impact-media-read-manifest.js';
import {
  validateRoutineScheduleReadManifest,
  type RoutineScheduleReadBlocker,
} from './race-plan-impact-routine-schedule-read-manifest.js';
import { projectRacePlanImpact } from '@workout/server-coaching/race-plan-impact';
import {
  raceProjectionIntentSchema,
  racePlanImpactCollectorSelectionSchema,
  deriveRacePlanImpactCollectorSelection,
} from './race-plan-impact-projection-input.js';
import {
  validateWorkoutTemplateReadSources,
  type WorkoutTemplateReadBlocker,
} from './race-plan-impact-workout-template-manifest.js';
import { workoutTemplateSourceFactsSchema } from './race-plan-impact-workout-template-sources.js';
import { resourceRetainedReadFactsSchema } from './race-plan-impact-resource-read-facts.js';
import {
  validateResourceReadManifest,
  type ResourceReadManifestBlocker,
} from './race-plan-impact-resource-manifest.js';
import { manualActivityReadFactsSchema } from './race-plan-impact-manual-activity-read-facts.js';
import { manualIntakeReadFactsSchema } from './race-plan-impact-intake-read-facts.js';
import {
  courseReadManifestSchema,
  validateCourseReadManifest,
  type CourseReadBlocker,
} from './race-plan-impact-course-manifest.js';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { foodDefinitionVersionSchema } from '@workout/contracts/nutrition-core';
import { nutritionAnchorSchema } from '@workout/contracts/nutrition';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  sessionCompletionSchema,
  preservesSessionCompletions,
} from '@workout/contracts/session-completion';
import { routineRunReadSchema } from '@workout/contracts/routine-commands';
import { coreEvidenceDependencyManifestSchema } from '@workout/contracts/evidence-dependencies';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
  domainPlanRefSchema,
  routineStepContentSchema,
} from '@workout/contracts/routines';
import { supplementarySessionLinkSchema } from '@workout/contracts/supplementary-core';
import {
  decodeIntegratedDependencyInventory,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';

import { recoverySourceFactsSchema } from './race-plan-impact-recovery-sources.js';
import {
  recoveryReadSourcesProjectionSchema,
  validateRecoveryReadSources,
  type RecoveryReadSourceBlocker,
} from './race-plan-impact-recovery-manifest.js';

import {
  routineReadManifestSchema,
  validateRoutineReadSources,
  type RoutineReadBlocker,
} from './race-plan-impact-routine-manifest.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.uuid();
const id = z.string().min(1).max(200),
  count = z.number().int().min(0).max(5000);
const revision = z.number().int().min(1).max(2147483647);
const jsonRows = z.array(z.json()).max(5000);
const missing = [
  'complete_catalog_and_actual_manifest',
  'supplementary_reference_manifest',
  'routine_occurrences_and_started_runs',
  'complete_source_permission_manifest',
  'manual_purpose_app_and_policy_binding',
] as const;
const capturedKinds = [
  'integrated_dependency_inventory',
  'immutable_supplementary_copy_references',
  'routine_occurrence_run_and_actual_reference_facts',
  'partial_owned_planned_reference_and_resource_permission_facts',
  'nested_nutrition_plan_food_anchor_and_activity_media_provider_facts',
  'manual_purpose_app_and_policy_facts',
] as const;
const permissionMissing = [
  'unsupported_domain_item_membership',
  'immutable_training_aggregate_history',
  'media_cleanup_status_port',
  'media_and_provider_source_permissions',
  'manual_purpose_app_and_policy_binding',
] as const;
const consent = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({ state: z.literal('present'), granted: z.boolean(), revision }),
]);
const policy = z.strictObject({
  id: z.literal('manual-race-date-impact'),
  version: z.literal(1),
  digest: hash,
});
const manual = z.strictObject({
  purpose: z.literal('manual_race_date_change'),
  policy,
  app: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({ state: z.literal('present'), granted: z.boolean(), revision }),
  ]),
});
export const raceImpactConsumedScopeSchema = z.strictObject({
  purpose: z.literal('manual_race_date_change'),
  athleteId: id,
  restoreGeneration: uuid,
  expectedEvent: z.strictObject({ id: uuid, revision }),
  expectedPolicy: policy,
  expectedAppRevision: revision,
  expectedReadSetDigest: hash,
});
export type RaceImpactConsumedScope = z.infer<typeof raceImpactConsumedScopeSchema>;
const tuple = z.strictObject({ aggregateId: uuid, versionId: uuid });
const tupleKey = (row: { aggregateId: string; versionId: string }) =>
  JSON.stringify([row.aggregateId.toLowerCase(), row.versionId.toLowerCase()]);
const relative = z.strictObject({
  itemId: z.string(),
  entity: z.enum(['race', 'session']),
  entityId: z.string(),
  sourceVersionId: uuid.nullable(),
  affected: z.boolean(),
  point: z.enum(['start', 'end']),
  timing: z.literal('not_resolved'),
  sourceRaceRevision: revision.optional(),
  sourceRaceDigest: hash.optional(),
});
const nutrition = z.strictObject({
  aggregateId: uuid,
  versionId: uuid,
  record: nutritionPlanVersionCompatibleV4Schema,
  sourceRelation: z.enum(['absent', 'current', 'historical']),
  relativeItems: z.array(relative).max(5000),
});
const target = z.strictObject({ block_id: id, target_set_id: id, exercise_version_id: uuid });
const supplementary = z.strictObject({
  sessions: z
    .array(
      z.strictObject({
        planVersionId: uuid,
        plannedSessionId: id,
        state: z.enum(['present', 'absent']),
      }),
    )
    .max(5000),
  copies: z
    .array(
      z.strictObject({
        link: supplementarySessionLinkSchema,
        targetSource: z.enum(['session_copy', 'routine_version']),
        contentDigest: hash,
        targets: z.array(target).max(5000),
      }),
    )
    .max(5000),
  routines: z
    .array(
      z.strictObject({ routineId: uuid, versionId: uuid, version: revision, contentDigest: hash }),
    )
    .max(5000),
  exercises: z
    .array(
      z.strictObject({
        exerciseId: uuid,
        versionId: uuid,
        version: revision,
        contentDigest: hash,
        resourceVersionIds: z.array(z.string()).max(5000),
        mediaAssetIds: z.array(z.string()).max(5000),
      }),
    )
    .max(5000),
});
const presentVersion = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({ state: z.literal('present'), versionId: uuid }),
]);
const blueprint = z.strictObject({
  record: routineBlueprintVersionSchema,
  version: revision,
  currentHead: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({
      state: z.literal('present'),
      versionId: uuid,
      version: revision,
      visibility: z.enum(['active', 'archived', 'deleted']),
      favorite: z.boolean(),
    }),
  ]),
  unsupportedContent: jsonRows,
});
const schedule = z.strictObject({
  scheduleId: uuid,
  versionId: uuid,
  sourcePlanVersionId: uuid.nullable(),
  record: routineScheduleVersionSchema,
  currentHead: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({
      state: z.literal('present'),
      versionId: uuid,
      notificationMuted: z.boolean(),
    }),
  ]),
});
const routine = z.strictObject({
  aggregateId: uuid,
  versionId: uuid,
  record: routineScheduleVersionSchema,
  sourceVersionId: uuid.nullable(),
  sourceRelation: z.enum(['absent', 'current', 'historical']),
  affected: z.boolean(),
});
const sourceKind = z.enum(['fit', 'fixture', 'manual', 'healthkit']);
const actualHeadMetadata = z.strictObject({
  id: uuid,
  revision,
  deleted: z.boolean(),
  originalDigest: hash,
  overlayDigest: hash,
  source: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({
      state: z.literal('present'),
      kind: sourceKind,
      sourceId: id.nullable(),
      sourceRevision: revision.nullable(),
      contentHash: hash.nullable(),
    }),
  ]),
});
const ledgerHeadMetadata = z.strictObject({
  id,
  revision,
  revisionId: uuid,
  status: z.enum(['active', 'deleted']),
  contentDigest: hash,
});
const routineActual = z.strictObject({
  uniqueSourceCount: count,
  occurrences: z
    .array(
      z.strictObject({
        record: routineOccurrenceSchema,
        currentSchedule: presentVersion,
        startedRun: z.discriminatedUnion('state', [
          z.strictObject({ state: z.literal('absent') }),
          z.strictObject({
            state: z.literal('present'),
            runId: uuid,
            revision: z.number().int().min(0).max(2147483646),
          }),
        ]),
      }),
    )
    .max(1000),
  runs: routineReadManifestSchema.shape.runs,
  blueprints: z.array(blueprint).max(5000),
  schedules: z.array(schedule).max(5000),
  actualRosters: z.strictObject({
    activities: z.array(actualHeadMetadata).max(1000),
    intake: z.array(ledgerHeadMetadata).max(1000),
    recovery: z.array(ledgerHeadMetadata).max(1000),
  }),
});
const planned = z.strictObject({
  requested: domainPlanRefSchema,
  state: z.enum(['current', 'historical', 'unavailable']),
  reason: z.string().nullable(),
  currentHead: z.strictObject({ aggregate_id: uuid, version_id: uuid }).nullable(),
  content: z.strictObject({ digest: hash }).nullable(),
  aggregateIdentity: z.enum(['current_head_association_only', 'immutable_version']).optional(),
  exactOwnedVersion: z.strictObject({ aggregateId: uuid, versionId: uuid }).nullable().optional(),
});
// Internal facts from the owned source producer, not a public approval codec.
const foodProvenance = z
  .strictObject({
    kind: foodDefinitionVersionSchema.shape.provenance.shape.kind,
    reviewState: foodDefinitionVersionSchema.shape.provenance.shape.reviewState,
    capturedAt: foodDefinitionVersionSchema.shape.provenance.shape.capturedAt,
    reference: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('absent') }),
      z.strictObject({ state: z.literal('present'), digest: hash }),
    ]),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'user_entered' && value.reference.state === 'absent')
      ctx.addIssue({
        code: 'custom',
        message: 'External provenance requires its frozen reference',
      });
  });
const nestedFood = z.strictObject({
  requestedVersionId: uuid,
  state: z.enum(['current', 'historical', 'unavailable']),
  content: z
    .strictObject({
      foodId: foodDefinitionVersionSchema.shape.foodId,
      versionId: uuid,
      digest: hash,
      provenance: foodProvenance,
      record: foodDefinitionVersionSchema,
    })
    .nullable(),
  currentHead: z
    .union([
      z.strictObject({ state: z.literal('absent') }),
      z.strictObject({ versionId: uuid, provenance: foodProvenance.nullable() }),
    ])
    .nullable(),
});
const linkedNutritionPlan = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({
    state: z.enum(['current', 'historical', 'unavailable']),
    requestedVersionId: uuid,
    content: z.strictObject({ digest: hash }).nullable(),
    currentHead: z.strictObject({ aggregate_id: uuid, version_id: uuid }).nullable(),
  }),
]);
const nestedAnchor = z.strictObject({
  itemId: z.string().min(1),
  anchor: nutritionAnchorSchema.options[1],
  source: z.union([
    z.strictObject({ state: z.literal('owned'), planVersionId: uuid }),
    z.strictObject({ state: z.literal('unavailable'), content: z.null() }),
    z.strictObject({ requestedId: uuid, state: z.literal('unavailable'), content: z.null() }),
    z.strictObject({ requestedId: uuid, state: z.literal('deleted'), revision, content: z.null() }),
    z.strictObject({
      requestedId: uuid,
      state: z.literal('current'),
      revision,
      content: z.strictObject({ digest: hash }).nullable(),
    }),
  ]),
});
const nestedNutrition = z.strictObject({
  versionId: uuid,
  recordDigest: hash.optional(),
  foods: z.array(nestedFood).max(5000),
  anchors: z.array(nestedAnchor).max(5000),
  linkedPlan: linkedNutritionPlan,
});
const recoveryNutritionSources = z.strictObject({
  records: z.array(nutritionPlanVersionCompatibleV4Schema).max(5000),
  facts: z
    .array(
      z.strictObject({
        requested: tuple,
        state: z.enum(['current', 'historical', 'unavailable']),
        reason: z.literal('owned_version_unavailable').nullable(),
        content: z.strictObject({ digest: hash }).nullable(),
        currentHead: tuple.nullable(),
      }),
    )
    .max(5000),
  nestedSources: z.strictObject({
    nutrition: z.array(nestedNutrition).max(5000),
    loadedPlans: z.array(planSnapshotSchema).max(5000),
  }),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
const optionalRegistry = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({ state: z.literal('present'), revision }),
]);
const channelConsent = z.discriminatedUnion('state', [
  z.strictObject({ kind: z.enum(['provider', 'healthkit', 'media']), state: z.literal('absent') }),
  z.strictObject({
    kind: z.enum(['provider', 'healthkit', 'media']),
    state: z.literal('present'),
    granted: z.boolean(),
    revision,
  }),
]);
const generation = z.number().int().min(0).max(2147483647);
const garminMetadata = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({
    state: z.literal('present'),
    connection: z.strictObject({
      generation,
      state: z.enum(['disconnected', 'connecting', 'connected', 'reconnect_required']),
      permissions: z.array(z.string().min(1).max(100)).max(32),
      access_expires_at: z.iso.datetime().nullable(),
      refresh_expires_at: z.iso.datetime().nullable(),
    }),
  }),
]);
const unofficialMetadata = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({
    state: z.literal('present'),
    connection: z.strictObject({
      session_generation: generation,
      state: z.enum(['not_connected', 'connected', 'reconnect_required']),
      schedule_enabled: z.boolean(),
      schedule_paused: z.boolean(),
    }),
  }),
]);
const activityMetadata = z
  .strictObject({
    id: uuid,
    revision,
    deleted: z.boolean(),
    overlay: z.strictObject({
      state: z.enum(['present', 'absent']),
      revision: revision.nullable(),
    }),
    source: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('absent') }),
      z.strictObject({
        state: z.literal('present'),
        kind: sourceKind,
        sourceId: id,
        revision,
        contentHash: hash,
        suppressed: z.boolean(),
        revisionRecord: z.strictObject({ state: z.enum(['present', 'absent']) }),
      }),
    ]),
  })
  .superRefine((row, ctx) => {
    if (
      row.source.state === 'present' &&
      row.source.kind === 'healthkit' &&
      !uuid.safeParse(row.source.sourceId).success
    )
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'sourceId'],
        message: 'Expected HealthKit UUID',
      });
  });
const garminLineageMetadata = z.strictObject({
  kind: sourceKind,
  source_id: id,
  provider: z.enum(['garmin-official', 'garmin-connect-unofficial']),
  official: z.boolean(),
  outcome: z.enum(['imported', 'unchanged', 'stale', 'suppressed']),
});
const healthkitMetadata = z.strictObject({
  id: uuid,
  sample: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({
      state: z.literal('present'),
      status: z.enum(['active', 'deleted']),
      payloadDigest: hash.nullable(),
    }),
  ]),
  lineage: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({
      state: z.literal('present'),
      status: z.enum([
        'pending_review',
        'linked_existing',
        'created_activity',
        'suppressed',
        'deleted',
      ]),
    }),
  ]),
  claim: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({ state: z.literal('present'), epoch: uuid, consentRevision: revision }),
  ]),
  binding: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({
      state: z.literal('present'),
      activityId: uuid,
      targetRevision: revision,
      sampleDigest: hash,
    }),
  ]),
});
const activityMedia = z.strictObject({
  activities: z.array(activityMetadata).max(5000),
  garminLineage: z.array(garminLineageMetadata).max(5000),
  healthkit: z.array(healthkitMetadata).max(5000),
  healthkitRegistry: optionalRegistry,
  consents: z
    .array(channelConsent)
    .length(3)
    .refine(
      (rows) => new Set(rows.map((row) => row.kind)).size === 3,
      'Exact consent kinds required',
    ),
  garmin: garminMetadata,
  garminUnofficial: unofficialMetadata,
  media: jsonRows,
});
const catalog = z.strictObject({
  requested: routineStepContentSchema,
  state: z.enum(['current', 'historical', 'unavailable']),
  reason: z.string().nullable(),
  content: z.strictObject({ digest: hash }).nullable(),
  currentHead: z.strictObject({ aggregate_id: uuid, version_id: uuid }).nullable(),
  exercises: jsonRows.optional(),
  provenance: z
    .strictObject({
      source: z.literal('user_recorded'),
      reviewState: z.literal('unreviewed'),
      reviewedAt: z.null(),
    })
    .nullable()
    .optional(),
});
const permissions = z.strictObject({
  complete: z.literal(false),
  planned: z.array(planned).max(5000),
  resources: jsonRows,
  catalog: z.array(catalog).max(5000),
  nestedNutritionSources: z.array(nestedNutrition).max(5000),
  activityMediaPermissions: activityMedia,
  aiConsent: consent,
  missing: z.array(z.enum(permissionMissing)).length(5),
});
export const raceImpactConsumedCaptureSchema = z.strictObject({
  status: z.literal('blocked'),
  coverage: z.strictObject({
    complete: z.literal(false),
    missing: z.array(z.enum(missing)).length(5),
    captured: z.array(z.enum(capturedKinds)).length(6),
  }),
  restoreGeneration: uuid,
  athleteId: id,
  calendarIntent: raceProjectionIntentSchema.nullable().optional(),
  collectorSelection: racePlanImpactCollectorSelectionSchema.optional(),
  manualBasis: manual,
  event: raceEventSchema,
  collections: z
    .array(
      z.strictObject({
        kind: z.enum(['race-event', 'race-result', 'training-best']),
        revision,
        privacy_generation: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .max(100),
      }),
    )
    .max(3),
  linkedPlan: planSnapshotSchema.nullable(),
  currentTraining: z.strictObject({ aggregateId: uuid, snapshot: planSnapshotSchema }).nullable(),
  completions: z.array(sessionCompletionSchema).max(1000),
  course: courseReadManifestSchema.nullable(),
  rosters: z.strictObject({
    nutrition: z.array(tuple).max(1000),
    recovery: z.array(tuple).max(1000),
    routine: z.array(tuple).max(1000),
  }),
  nutrition: z.array(nutrition).max(1000),
  recovery: recoveryReadSourcesProjectionSchema.shape.recovery,
  recoverySources: recoverySourceFactsSchema.optional(),
  recoveryNutritionSources: recoveryNutritionSources.optional(),
  routineTimerReads: z.array(routineRunReadSchema).max(1000).optional(),
  manualIntakeReadFacts: manualIntakeReadFactsSchema.optional(),
  manualActivityReadFacts: manualActivityReadFactsSchema.optional(),
  localImportedActivityReadFacts: localImportedActivityReadFactsSchema.optional(),
  workoutTemplateSources: workoutTemplateSourceFactsSchema.optional(),
  resourceReadFacts: resourceRetainedReadFactsSchema.optional(),
  mediaReadFacts: mediaRetainedReadFactsSchema.optional(),
  routines: z.array(routine).max(1000),
  coreDependencies: coreEvidenceDependencyManifestSchema,
  dependencyInventory: z.array(z.json()).length(12),
  supplementaryManifest: supplementary,
  routineActualManifest: routineActual,
  sourcePermissionManifest: permissions,
  consumedSources: z.strictObject({
    plans: z.array(planSnapshotSchema).max(5000),
    races: z.array(raceEventSchema).max(5000),
  }),
  readSetDigest: hash,
  affected: z.strictObject({
    nutrition: z.array(uuid).max(1000),
    routine: z.array(uuid).max(1000),
  }),
});
/** Runtime shape only; parsing does not grant ownership, freshness or approval. */
export type RaceImpactConsumedCapture = z.infer<typeof raceImpactConsumedCaptureSchema>;
export type RaceImpactManifestBlocker = {
  readonly path: string;
  readonly reason:
    | 'invalid_capture'
    | 'scope_mismatch'
    | 'digest_mismatch'
    | 'manual_admission_unavailable'
    | 'completion_plan_source_missing'
    | 'completion_revision_mismatch'
    | 'missing_source'
    | 'source_identity_mismatch'
    | 'unsupported_consumed_channel'
    | 'source_membership_mismatch'
    | 'permission_port_missing'
    | 'bounds_exceeded'
    | RecoveryReadSourceBlocker['reason']
    | RoutineReadBlocker['reason']
    | CourseReadBlocker
    | WorkoutTemplateReadBlocker['reason']
    | ResourceReadManifestBlocker['reason']
    | RoutineScheduleReadBlocker
    | MediaReadManifestBlocker['reason'];
};
export type RaceImpactConsumedManifestResult =
  | { readonly status: 'blocked'; readonly blockers: readonly RaceImpactManifestBlocker[] }
  | {
      readonly status: 'validated_read_scope';
      readonly purpose: 'manual_race_date_change';
      readonly semanticDigest: string;
      readonly capturedReadSetDigest: string;
      readonly nutritionVersions: readonly { planId: string; versionId: string }[];
      readonly plannedRefs: readonly z.infer<typeof domainPlanRefSchema>[];
      readonly approvalAuthority: 'none';
      readonly freshness: 'not_checked';
      readonly remaining: readonly string[];
    };
const equal = (a: unknown, b: unknown) =>
  a !== undefined && b !== undefined && impactDependencyDigest(a) === impactDependencyDigest(b);
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function bounded(value: unknown) {
  const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0,
    bytes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    if (entry.leave) {
      if (entry.value !== null && typeof entry.value === 'object') ancestors.delete(entry.value);
      continue;
    }
    if (++nodes > 100000 || entry.depth > 64) return false;
    if (typeof entry.value === 'string') bytes += Buffer.byteLength(entry.value, 'utf8');
    if (bytes > 4194304) return false;
    if (entry.value !== null && typeof entry.value === 'object') {
      if (
        ancestors.has(entry.value) ||
        (!Array.isArray(entry.value) && Object.getPrototypeOf(entry.value) !== Object.prototype)
      )
        return false;
      ancestors.add(entry.value);
      pending.push({ ...entry, leave: true });
      for (const child of Object.values(entry.value))
        pending.push({ value: child, depth: entry.depth + 1 });
    } else if (!(
      entry.value === null ||
      ['string', 'boolean'].includes(typeof entry.value) ||
      (typeof entry.value === 'number' && Number.isFinite(entry.value))
    ))
      return false;
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4194304;
}
/** Exact structural/read-scope validation only. A hash or validated JSON does not
 * authenticate its producer, grant source permission or authorize an approval.
 * Existing collector remains complete:false. Freshness/authority are separate ports. */
export function validateRaceImpactConsumedManifest(
  unknownCapture: unknown,
  unknownScope: unknown,
): RaceImpactConsumedManifestResult {
  const blockers: RaceImpactManifestBlocker[] = [];
  const block = (path: string, reason: RaceImpactManifestBlocker['reason']) => {
    blockers.push({ path, reason });
  };
  if (!bounded(unknownCapture) || !bounded(unknownScope))
    return { status: 'blocked', blockers: [{ path: 'capture', reason: 'bounds_exceeded' }] };
  const decoded = raceImpactConsumedCaptureSchema.safeParse(unknownCapture),
    scoped = raceImpactConsumedScopeSchema.safeParse(unknownScope);
  if (!decoded.success || !scoped.success)
    return {
      status: 'blocked',
      blockers: [{ path: !decoded.success ? 'capture' : 'scope', reason: 'invalid_capture' }],
    };
  const c = decoded.data,
    s = scoped.data;
  if (
    c.athleteId !== s.athleteId ||
    !sameId(c.restoreGeneration, s.restoreGeneration) ||
    !sameId(c.event.id, s.expectedEvent.id) ||
    c.event.revision !== s.expectedEvent.revision ||
    !equal(c.manualBasis.policy, s.expectedPolicy) ||
    c.manualBasis.app.state !== 'present' ||
    c.manualBasis.app.revision !== s.expectedAppRevision ||
    c.readSetDigest !== s.expectedReadSetDigest
  )
    block('scope', 'scope_mismatch');
  if (c.manualBasis.app.state !== 'present' || !c.manualBasis.app.granted)
    block('manualBasis.app', 'manual_admission_unavailable');
  const {
    status: _status,
    coverage: _coverage,
    readSetDigest: _digest,
    affected: _affected,
    ...readSet
  } = c;
  void _status;
  void _coverage;
  void _digest;
  void _affected;
  if (
    impactDependencyDigest({
      ...readSet,
      coreDependencies: { ...c.coreDependencies, capturedAt: null },
    }) !== c.readSetDigest
  )
    block('readSetDigest', 'digest_mismatch');
  if (
    new Set(c.sourcePermissionManifest.missing).size !== 5 ||
    new Set(c.coverage.captured).size !== 6 ||
    new Set(c.coverage.missing).size !== 5 ||
    new Set(c.collections.map((r) => r.kind)).size !== c.collections.length
  )
    block('coverage', 'source_identity_mismatch');
  try {
    decodeIntegratedDependencyInventory(c.dependencyInventory);
  } catch {
    block('dependencyInventory', 'invalid_capture');
  }
  if (
    !equal(
      c.coreDependencies.aiConsent,
      c.sourcePermissionManifest.aiConsent.state === 'absent'
        ? { kind: 'absent' }
        : {
            kind: 'exists',
            granted: c.sourcePermissionManifest.aiConsent.granted,
            revision: c.sourcePermissionManifest.aiConsent.revision,
          },
    )
  )
    block('aiConsent', 'source_identity_mismatch');
  if (
    !equal(
      c.coreDependencies.trainingPlan,
      c.currentTraining
        ? { kind: 'exists', versionId: c.currentTraining.snapshot.id }
        : { kind: 'absent' },
    )
  )
    block('coreDependencies.trainingPlan', 'source_identity_mismatch');
  if (c.coreDependencies.athleteId !== c.athleteId)
    block('coreDependencies.athleteId', 'source_identity_mismatch');
  const plans = new Map(c.consumedSources.plans.map((p) => [p.id.toLowerCase(), p]));
  if (plans.size !== c.consumedSources.plans.length)
    block('consumedSources.plans', 'source_identity_mismatch');
  if (
    c.currentTraining &&
    !equal(plans.get(c.currentTraining.snapshot.id.toLowerCase()), c.currentTraining.snapshot)
  )
    block('currentTraining', 'missing_source');
  if (c.linkedPlan && !equal(plans.get(c.linkedPlan.id.toLowerCase()), c.linkedPlan))
    block('linkedPlan', 'missing_source');
  // Current self-reports reference an owned immutable version, not an
  // aggregate identifier or exercise performance. The collector supplies the
  // exact owned snapshot; aggregate/history authority remains a separate port.
  const completionHead = c.coreDependencies.sessionCompletions;
  if (
    (completionHead.kind === 'exists' && completionHead.revision > 2147483646) ||
    (c.completions.length > 0 && completionHead.kind === 'absent') ||
    c.completions.some(
      (report) => completionHead.kind === 'exists' && report.revision > completionHead.revision,
    )
  )
    block('coreDependencies.sessionCompletions', 'completion_revision_mismatch');
  if (new Set(c.completions.map((report) => report.sessionId)).size !== c.completions.length)
    block('completions', 'source_identity_mismatch');
  for (const report of c.completions) {
    const path = `completions.${report.sessionId}`;
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 16384) block(path, 'bounds_exceeded');
    const sourcePlan = plans.get(report.planVersionId.toLowerCase());
    if (!sourcePlan) {
      block(path, 'completion_plan_source_missing');
      continue;
    }
    const session = sourcePlan.draft.sessions.find((row) => row.id === report.sessionId);
    if (
      !session ||
      !equal(report.schedule, {
        blockId: session.blockId,
        date: session.date,
        localStartTime: session.localStartTime,
        timezone: sourcePlan.draft.timezone,
      })
    )
      block(path, 'source_membership_mismatch');
  }
  if (
    c.completions.some((report) => report.status === 'completed') &&
    (!c.currentTraining ||
      !preservesSessionCompletions(c.currentTraining.snapshot.draft, c.completions))
  )
    block('completions.currentTraining', 'source_membership_mismatch');
  const races = new Map(c.consumedSources.races.map((r) => [r.id.toLowerCase(), r]));
  if (!equal(races.get(c.event.id.toLowerCase()), c.event))
    block('consumedSources.races.event', 'missing_source');

  if (races.size !== c.consumedSources.races.length)
    block('consumedSources.races', 'source_identity_mismatch');
  if (
    c.event.planVersionId !== null &&
    (!c.linkedPlan || !sameId(c.event.planVersionId, c.linkedPlan.id))
  )
    block('event.planVersionId', 'missing_source');
  const refs = c.routineActualManifest.occurrences.flatMap((o) =>
    o.record.stepBindings.map((b) => b.plannedRef),
  );
  if (refs.length > 5000) block('plannedRefs', 'bounds_exceeded');
  // These immutable bodies are recovery read sources only; they do not enter
  // current rosters, relative impact targets, or approval write candidates.
  const historicalNutrition = c.recoveryNutritionSources?.records ?? [];
  const allNutrition = [
    ...c.nutrition.map((n) => ({ ...n, operational: true })),
    ...historicalNutrition
      .filter((record) => !c.nutrition.some((n) => sameId(n.versionId, record.versionId)))
      .map((record) => ({
        aggregateId: record.planId,
        versionId: record.versionId,
        record,
        sourceRelation:
          record.linkedTrainingPlanVersionId === null
            ? ('absent' as const)
            : c.currentTraining &&
                sameId(c.currentTraining.snapshot.id, record.linkedTrainingPlanVersionId)
              ? ('current' as const)
              : ('historical' as const),
        relativeItems: [],
        operational: false,
      })),
  ];
  const rn = c.recoveryNutritionSources;
  if (rn) {
    const requested = new Set(
      c.recovery.flatMap((row) =>
        row.record.draft.planRefs
          .filter((ref) => ref.kind === 'nutrition')
          .map((ref) => tupleKey({ aggregateId: ref.aggregateId, versionId: ref.headVersionId })),
      ),
    );
    const facts = new Map(rn.facts.map((f) => [tupleKey(f.requested), f]));
    const bodies = new Map(
      rn.records.map((record) => [
        tupleKey({ aggregateId: record.planId, versionId: record.versionId }),
        record,
      ]),
    );
    if (
      facts.size !== rn.facts.length ||
      bodies.size !== rn.records.length ||
      facts.size !== requested.size ||
      [...facts.keys()].some((k) => !requested.has(k)) ||
      [...bodies.keys()].some((k) => !requested.has(k))
    )
      block('recoveryNutritionSources', 'source_identity_mismatch');
    for (const k of requested) {
      const fact = facts.get(k),
        record = bodies.get(k);
      if (
        !fact ||
        fact.state === 'unavailable' ||
        fact.reason !== null ||
        !record ||
        fact.content?.digest !== impactDependencyDigest(record)
      ) {
        block('recoveryNutritionSources', 'missing_source');
        continue;
      }
      const current = c.nutrition.find((n) => sameId(n.aggregateId, record.planId));
      if (
        (fact.state === 'current') !==
          (fact.currentHead !== null && sameId(fact.currentHead.versionId, record.versionId)) ||
        (fact.currentHead !== null && !sameId(fact.currentHead.aggregateId, record.planId)) ||
        (current
          ? fact.currentHead === null ||
            !sameId(fact.currentHead.versionId, current.versionId) ||
            (sameId(current.versionId, record.versionId) && !equal(current.record, record))
          : fact.currentHead !== null)
      )
        block('recoveryNutritionSources.head', 'source_identity_mismatch');
    }
    const linkedIds = new Set(
      rn.records.flatMap((record) =>
        record.linkedTrainingPlanVersionId === null
          ? []
          : [record.linkedTrainingPlanVersionId.toLowerCase()],
      ),
    );
    const loaded = new Map(
      rn.nestedSources.loadedPlans.map((plan) => [plan.id.toLowerCase(), plan]),
    );
    if (
      loaded.size !== rn.nestedSources.loadedPlans.length ||
      [...loaded.keys()].some((k) => !linkedIds.has(k)) ||
      [...linkedIds].some((k) => !equal(loaded.get(k), plans.get(k)) || !loaded.has(k))
    )
      block('recoveryNutritionSources.loadedPlans', 'source_membership_mismatch');
  }
  const usedPlans = new Set(
    [
      c.currentTraining?.snapshot.id,
      c.linkedPlan?.id,
      ...c.completions.map((report) => report.planVersionId),
      ...allNutrition.flatMap((n) =>
        n.record.linkedTrainingPlanVersionId === null ? [] : [n.record.linkedTrainingPlanVersionId],
      ),
      ...refs.filter((ref) => ref.domain === 'training').map((ref) => ref.versionId),
      ...c.recovery.flatMap((row) =>
        row.record.draft.planRefs
          .filter((ref) => ref.kind === 'training')
          .map((ref) => ref.headVersionId),
      ),
    ]
      .filter((value) => value !== undefined)
      .map((value) => value.toLowerCase()),
  );
  if ([...plans.keys()].some((key) => !usedPlans.has(key)))
    block('consumedSources.plans', 'unsupported_consumed_channel');
  const recoveryResult = validateRecoveryReadSources({
    roster: c.rosters.recovery,
    recovery: c.recovery,
    plans: c.consumedSources.plans,
    nutrition: allNutrition.map(({ aggregateId, versionId, record }) => ({
      aggregateId,
      versionId,
      record,
    })),
    methodCatalog: c.sourcePermissionManifest.catalog
      .filter((row) => row.requested.kind === 'recovery_method')
      .map(({ requested, state, reason, content, currentHead, provenance }) => ({
        requested,
        state,
        reason,
        content,
        currentHead,
        provenance,
      })),
    ...(c.recoverySources
      ? {
          methodSources: c.recoverySources.methods,
          trainingAssociations: c.recoverySources.trainingAssociations,
        }
      : {}),
  });
  for (const finding of recoveryResult.blockers)
    block(
      `recovery:${finding.strategyVersionId ?? 'inventory'}:${finding.sourceVersionId ?? 'source'}`,
      finding.reason,
    );
  if (c.recoverySources) {
    const rs = c.recoverySources;
    const methodVersions = new Set(
      c.recovery.flatMap((row) =>
        row.record.draft.options.flatMap((option) =>
          option.methodVersionId === null ? [] : [option.methodVersionId.toLowerCase()],
        ),
      ),
    );
    const trainingTuples = new Set(
      c.recovery.flatMap((row) =>
        row.record.draft.planRefs
          .filter((ref) => ref.kind === 'training')
          .map((ref) => tupleKey({ aggregateId: ref.aggregateId, versionId: ref.headVersionId })),
      ),
    );
    const nutritionTuples = new Set(
      c.recovery.flatMap((row) =>
        row.record.draft.planRefs
          .filter((ref) => ref.kind === 'nutrition')
          .map((ref) => tupleKey({ aggregateId: ref.aggregateId, versionId: ref.headVersionId })),
      ),
    );
    const missingMethods = rs.unavailable.filter((row) => row.kind === 'method');
    const missingTraining = rs.unavailable.filter((row) => row.kind === 'training');
    const actualMethodVersions = [
      ...rs.methods.map((row) => row.versionId.toLowerCase()),
      ...missingMethods.map((row) => row.requestedVersionId.toLowerCase()),
    ];
    const actualTrainingTuples = [
      ...rs.trainingAssociations.map(tupleKey),
      ...missingTraining.map((row) => tupleKey(row.requested)),
    ];
    if (
      new Set(actualMethodVersions).size !== actualMethodVersions.length ||
      actualMethodVersions.length !== methodVersions.size ||
      actualMethodVersions.some((v) => !methodVersions.has(v)) ||
      new Set(actualTrainingTuples).size !== actualTrainingTuples.length ||
      actualTrainingTuples.length !== trainingTuples.size ||
      actualTrainingTuples.some((v) => !trainingTuples.has(v)) ||
      rs.nutritionReferences.length !== nutritionTuples.size ||
      new Set(rs.nutritionReferences.map(tupleKey)).size !== rs.nutritionReferences.length ||
      rs.nutritionReferences.some((v) => !nutritionTuples.has(tupleKey(v)))
    )
      block('recoverySources', 'source_identity_mismatch');
    const requests = rs.methods.map((row) => ({
      kind: 'recovery_method',
      ref: { id: row.methodId, versionId: row.versionId },
    }));
    const identities = (rows: readonly unknown[]) => rows.map(impactDependencyDigest).sort();
    if (
      !equal(identities(requests), identities(rs.methodCatalogRequests)) ||
      !equal(
        identities(rs.methodFacts.map((row) => row.requested)),
        identities(rs.methodCatalogRequests),
      )
    )
      block('recoverySources.methodCatalogRequests', 'source_identity_mismatch');
    for (const fact of rs.methodFacts) {
      const actual = c.sourcePermissionManifest.catalog.find((row) =>
        equal(row.requested, fact.requested),
      );
      if (!equal(actual, fact)) block('recoverySources.methodFacts', 'source_identity_mismatch');
    }
    for (const unavailable of rs.unavailable)
      block(
        unavailable.kind === 'method'
          ? `recoverySources.method:${unavailable.requestedVersionId}`
          : `recoverySources.training:${unavailable.requested.versionId}`,
        unavailable.kind === 'method' ? 'method_unavailable' : 'training_association_missing',
      );
  }
  if (c.manualIntakeReadFacts !== undefined && c.manualIntakeReadFacts.athleteId !== c.athleteId)
    block('manualIntakeReadFacts', 'scope_mismatch');
  if (
    c.manualActivityReadFacts !== undefined &&
    c.manualActivityReadFacts.athleteId !== c.athleteId
  )
    block('manualActivityReadFacts', 'scope_mismatch');
  if (
    c.localImportedActivityReadFacts !== undefined &&
    c.localImportedActivityReadFacts.athleteId !== c.athleteId
  )
    block('localImportedActivityReadFacts', 'scope_mismatch');
  if (c.calendarIntent !== undefined && c.calendarIntent !== null) {
    const intent = c.calendarIntent;
    if (
      !sameId(intent.expectedEvent.id, c.event.id) ||
      intent.expectedEvent.revision !== c.event.revision
    )
      block('calendarIntent', 'source_identity_mismatch');
    const calendar = projectRacePlanImpact({
      event: { localDate: c.event.localDate, planVersionId: c.event.planVersionId },
      newLocalDate: intent.newLocalDate,
      currentPlan: c.currentTraining?.snapshot ?? null,
      completionReports: c.completions,
      selection: intent.selection,
    });
    if (
      calendar.status !== 'projected' ||
      c.collectorSelection === undefined ||
      !equal(
        c.collectorSelection,
        deriveRacePlanImpactCollectorSelection(calendar, intent.selection),
      )
    )
      block('collectorSelection', 'source_identity_mismatch');
  }
  const routineResult = validateRoutineReadSources({
    manifest: c.routineActualManifest,
    activityMetadata: c.sourcePermissionManifest.activityMediaPermissions.activities,
    ...(c.localImportedActivityReadFacts === undefined
      ? {}
      : { localImportedActivityReadFacts: c.localImportedActivityReadFacts }),
    ...(c.manualActivityReadFacts === undefined
      ? {}
      : {
          activityReadFacts: c.manualActivityReadFacts,
        }),
    ...(c.manualIntakeReadFacts === undefined ? {} : { intakeReadFacts: c.manualIntakeReadFacts }),
    ...(c.routineTimerReads === undefined ? {} : { timerReads: c.routineTimerReads }),
  });
  for (const finding of routineResult.blockers) {
    // Existing exact planned-reference and source-plan guards below implement
    // this companion's missing port; keep their actual membership validation.
    if (finding.reason === 'planned_reference_port_missing') continue;
    block(`routineActualManifest.${finding.path}`, finding.reason);
  }
  const courseResult = validateCourseReadManifest(
    { athleteId: c.athleteId, eventCourse: c.event.course },
    c.course,
  );
  for (const reason of courseResult.blockers) block('course', reason);
  const versions = new Map(c.nutrition.map((n) => [n.versionId.toLowerCase(), n]));
  if (
    versions.size !== c.nutrition.length ||
    new Set(c.nutrition.map((n) => n.aggregateId.toLowerCase())).size !== c.nutrition.length ||
    !equal(
      c.rosters.nutrition,
      c.nutrition.map((n) => ({ aggregateId: n.aggregateId, versionId: n.versionId })),
    ) ||
    !equal(
      c.rosters.routine,
      c.routines.map((r) => ({ aggregateId: r.aggregateId, versionId: r.versionId })),
    )
  )
    block('rosters', 'source_identity_mismatch');
  const nested = new Map(
    c.sourcePermissionManifest.nestedNutritionSources.map((n) => [n.versionId.toLowerCase(), n]),
  );
  if (
    nested.size !== c.sourcePermissionManifest.nestedNutritionSources.length ||
    nested.size !== versions.size
  )
    block('nestedNutritionSources', 'missing_source');
  if (rn) {
    const extras = new Map(rn.nestedSources.nutrition.map((n) => [n.versionId.toLowerCase(), n]));
    if (
      extras.size !== rn.nestedSources.nutrition.length ||
      extras.size !== rn.records.length ||
      rn.records.some((record) => !extras.has(record.versionId.toLowerCase()))
    )
      block('recoveryNutritionSources.nested', 'source_membership_mismatch');
    for (const [key, value] of extras) {
      if (nested.has(key) && !equal(nested.get(key), value))
        block('recoveryNutritionSources.nested', 'source_identity_mismatch');
      else nested.set(key, value);
    }
  }
  for (const [index, n] of allNutrition.entries()) {
    const path = n.operational
      ? `nutrition[${index}]`
      : `recoveryNutritionSources.records[${index}]`;
    if (
      !sameId(n.aggregateId, n.record.planId) ||
      !sameId(n.versionId, n.record.versionId) ||
      Buffer.byteLength(JSON.stringify(n.record)) > 524288
    )
      block(path, 'source_identity_mismatch');
    const source = nested.get(n.versionId.toLowerCase());
    if (
      !source ||
      (('schemaVersion' in n.record || source.recordDigest !== undefined) &&
        source.recordDigest !== impactDependencyDigest(n.record))
    )
      block(path + '.nested', 'digest_mismatch');
    if (!source) continue;
    const linkedId = n.record.linkedTrainingPlanVersionId;
    const linked = linkedId === null ? undefined : plans.get(linkedId.toLowerCase());
    const linkedFacts = source.linkedPlan;
    if (linkedId === null) {
      if (n.sourceRelation !== 'absent' || linkedFacts.state !== 'absent')
        block(path + '.linkedPlan', 'source_identity_mismatch');
    } else {
      const current = c.currentTraining;
      const relation = current && sameId(current.snapshot.id, linkedId) ? 'current' : 'historical';
      if (
        !linked ||
        linkedFacts.state === 'absent' ||
        linkedFacts.state === 'unavailable' ||
        !sameId(linkedFacts.requestedVersionId, linkedId) ||
        linkedFacts.content?.digest !== impactDependencyDigest(linked) ||
        n.sourceRelation !== relation ||
        linkedFacts.state !== relation ||
        (current
          ? linkedFacts.currentHead === null ||
            !sameId(linkedFacts.currentHead.aggregate_id, current.aggregateId) ||
            !sameId(linkedFacts.currentHead.version_id, current.snapshot.id)
          : linkedFacts.currentHead !== null)
      )
        block(path + '.linkedPlan', 'source_membership_mismatch');
    }
    const expectedFoods = new Set(
      n.record.items.flatMap((item) =>
        item.foods.flatMap((food) =>
          food.foodVersionId === null ? [] : [food.foodVersionId.toLowerCase()],
        ),
      ),
    );
    const foods = new Map(
      source.foods.map((food) => [food.requestedVersionId.toLowerCase(), food]),
    );
    if (
      foods.size !== source.foods.length ||
      foods.size !== expectedFoods.size ||
      [...foods.keys()].some((key) => !expectedFoods.has(key))
    )
      block(path + '.foods', 'source_membership_mismatch');
    for (const key of expectedFoods) {
      const food = foods.get(key);
      if (
        !food ||
        food.state === 'unavailable' ||
        food.content === null ||
        food.currentHead === null ||
        !sameId(food.content.versionId, key) ||
        !sameId(food.content.record.versionId, key) ||
        food.content.foodId !== food.content.record.foodId ||
        food.content.digest !== impactDependencyDigest(food.content.record) ||
        !equal(food.content.provenance, {
          kind: food.content.record.provenance.kind,
          reviewState: food.content.record.provenance.reviewState,
          capturedAt: food.content.record.provenance.capturedAt,
          reference:
            food.content.record.provenance.reference === null
              ? { state: 'absent' }
              : {
                  state: 'present',
                  digest: impactDependencyDigest(food.content.record.provenance.reference),
                },
        }) ||
        (food.currentHead && 'versionId' in food.currentHead
          ? food.currentHead.provenance === null ||
            (food.state === 'current'
              ? !sameId(food.currentHead.versionId, key) ||
                !equal(food.currentHead.provenance, food.content.provenance)
              : sameId(food.currentHead.versionId, key))
          : food.state !== 'historical')
      )
        block(path + '.foods', 'source_membership_mismatch');
    }
    const active = n.record.items.filter((item) => item.anchor.kind === 'relative');
    const anchors = new Map(source.anchors.map((anchor) => [anchor.itemId, anchor]));
    const relatives = new Map(n.relativeItems.map((item) => [item.itemId, item]));
    if (
      anchors.size !== source.anchors.length ||
      (n.operational && relatives.size !== n.relativeItems.length) ||
      anchors.size !== active.length ||
      (n.operational && relatives.size !== active.length)
    )
      block(path + '.anchors', 'source_membership_mismatch');
    for (const item of active) {
      const anchor = item.anchor;
      if (anchor.kind !== 'relative') continue;
      const captured = anchors.get(item.id),
        relative = relatives.get(item.id);
      if (
        !captured ||
        (n.operational && !relative) ||
        !equal(captured.anchor, anchor) ||
        (relative &&
          (relative.entity !== anchor.entity ||
            (anchor.entity === 'race'
              ? !sameId(relative.entityId, anchor.entityId)
              : relative.entityId !== anchor.entityId) ||
            relative.point !== anchor.point))
      ) {
        block(path + '.anchors', 'source_membership_mismatch');
        continue;
      }
      if (anchor.entity === 'session') {
        if (
          !linked ||
          !linked.draft.sessions.some((session) => session.id === anchor.entityId) ||
          captured.source.state !== 'owned' ||
          !sameId(captured.source.planVersionId, linked.id) ||
          (relative &&
            (relative.sourceVersionId === null ||
              !sameId(relative.sourceVersionId, linked.id) ||
              relative.sourceRaceRevision !== undefined ||
              relative.sourceRaceDigest !== undefined ||
              (relative.affected && n.sourceRelation !== 'current')))
        )
          block(path + '.anchors', 'source_membership_mismatch');
      } else {
        const live = races.get(anchor.entityId.toLowerCase());
        // These are current source-permission facts, never the saved before pin.
        if (
          !live ||
          captured.source.state !== 'current' ||
          !sameId(captured.source.requestedId, live.id) ||
          captured.source.revision !== live.revision ||
          captured.source.content?.digest !== impactDependencyDigest(live) ||
          (relative &&
            (relative.sourceVersionId !== null ||
              relative.sourceRaceRevision !== live.revision ||
              relative.sourceRaceDigest !== impactDependencyDigest(live) ||
              relative.affected !== sameId(live.id, c.event.id)))
        )
          block(path + '.anchors', 'source_membership_mismatch');
      }
    }
  }
  const usedRaces = new Set([
    c.event.id.toLowerCase(),
    ...allNutrition.flatMap((n) =>
      n.record.items.flatMap((item) =>
        item.anchor.kind === 'relative' && item.anchor.entity === 'race'
          ? [item.anchor.entityId.toLowerCase()]
          : [],
      ),
    ),
  ]);
  if ([...races.keys()].some((key) => !usedRaces.has(key)))
    block('consumedSources.races', 'unsupported_consumed_channel');
  const plannedByKey = new Map(
    c.sourcePermissionManifest.planned.map((p) => [impactDependencyDigest(p.requested), p]),
  );
  if (
    plannedByKey.size !== c.sourcePermissionManifest.planned.length ||
    plannedByKey.size !== new Set(refs.map(impactDependencyDigest)).size
  )
    block('sourcePermissionManifest.planned', 'missing_source');
  for (const ref of refs) {
    const path = `plannedRef:${ref.domain}:${ref.planId}:${ref.versionId}:${ref.itemId}`;
    const entry = plannedByKey.get(impactDependencyDigest(ref));
    if (!entry || entry.state === 'unavailable' || entry.reason !== null || !entry.content) {
      block(path, 'missing_source');
      continue;
    }
    if (ref.domain === 'nutrition') {
      const source = versions.get(ref.versionId.toLowerCase());
      if (
        !source ||
        !sameId(source.aggregateId, ref.planId) ||
        !source.record.items.some((i) => i.id === ref.itemId) ||
        entry.aggregateIdentity !== 'immutable_version' ||
        !entry.currentHead ||
        !sameId(entry.currentHead.aggregate_id, ref.planId) ||
        (entry.state === 'current'
          ? !sameId(entry.currentHead.version_id, ref.versionId)
          : sameId(entry.currentHead.version_id, ref.versionId)) ||
        entry.content.digest !== impactDependencyDigest(source.record)
      )
        block(path, 'source_membership_mismatch');
    } else if (ref.domain === 'training') {
      const source = plans.get(ref.versionId.toLowerCase());
      const head = c.currentTraining;
      const headMatches = head
        ? entry.currentHead !== null &&
          sameId(entry.currentHead.aggregate_id, head.aggregateId) &&
          sameId(entry.currentHead.version_id, head.snapshot.id)
        : entry.currentHead === null;
      const stateMatches =
        entry.state === 'current'
          ? entry.currentHead !== null && sameId(entry.currentHead.version_id, ref.versionId)
          : entry.currentHead === null || !sameId(entry.currentHead.version_id, ref.versionId);
      const associationMatches =
        entry.aggregateIdentity === 'immutable_version'
          ? entry.exactOwnedVersion !== undefined &&
            entry.exactOwnedVersion !== null &&
            sameId(entry.exactOwnedVersion.aggregateId, ref.planId) &&
            sameId(entry.exactOwnedVersion.versionId, ref.versionId)
          : entry.aggregateIdentity === 'current_head_association_only' &&
            entry.state === 'current' &&
            head !== null &&
            sameId(head.aggregateId, ref.planId) &&
            sameId(head.snapshot.id, ref.versionId) &&
            entry.exactOwnedVersion == null;
      if (
        !source ||
        !source.draft.sessions.some((i) => i.id === ref.itemId) ||
        !headMatches ||
        !stateMatches ||
        !associationMatches ||
        entry.content.digest !== impactDependencyDigest(source.draft)
      )
        block(path, 'source_membership_mismatch');
    } else block(path, 'unsupported_consumed_channel');
  }
  const blueprints = new Map(
    c.routineActualManifest.blueprints.map((b) => [b.record.versionId.toLowerCase(), b]),
  );
  if (blueprints.size !== c.routineActualManifest.blueprints.length)
    block('routineActualManifest.blueprints', 'source_identity_mismatch');
  for (const b of blueprints.values())
    if (
      b.unsupportedContent.length ||
      b.record.steps.some(
        (step) =>
          !['checklist', 'nutrition_template', 'workout_template'].includes(step.content.kind),
      )
    )
      block(`blueprint:${b.record.versionId}`, 'unsupported_consumed_channel');
  const catalogRequests = new Map([
    ...[...blueprints.values()].flatMap((b) =>
      b.record.steps
        .filter((step) => step.content.kind !== 'checklist')
        .map((step) => [impactDependencyDigest(step.content), step.content] as const),
    ),
    ...(c.recoverySources?.methodCatalogRequests ?? []).map(
      (request) => [impactDependencyDigest(request), request] as const,
    ),
  ]);
  const catalogRows = new Map(
    c.sourcePermissionManifest.catalog.map((row) => [impactDependencyDigest(row.requested), row]),
  );
  if (
    catalogRows.size !== c.sourcePermissionManifest.catalog.length ||
    catalogRows.size !== catalogRequests.size
  )
    block('sourcePermissionManifest.catalog', 'missing_source');
  const workoutResult = validateWorkoutTemplateReadSources({
    athleteId: c.athleteId,
    requests: [...catalogRequests.values()].filter(
      (request) => request.kind === 'workout_template',
    ),
    catalogRows: c.sourcePermissionManifest.catalog.filter(
      (row) => row.requested.kind === 'workout_template',
    ),
    ...(c.workoutTemplateSources === undefined ? {} : { sourceFacts: c.workoutTemplateSources }),
    ...(c.resourceReadFacts === undefined ? {} : { resourceReadFacts: c.resourceReadFacts }),
    ...(c.mediaReadFacts === undefined ? {} : { mediaReadFacts: c.mediaReadFacts }),
  });
  for (const finding of workoutResult.blockers)
    block(`workoutTemplateSources.${finding.path}`, finding.reason);
  for (const [key, requested] of catalogRequests) {
    const row = catalogRows.get(key);
    if (
      requested.kind === 'recovery_method' &&
      c.recoverySources?.methodCatalogRequests.some((ref) => equal(ref, requested))
    )
      continue;
    if (requested.kind === 'workout_template') continue;
    if (requested.kind !== 'nutrition_template') {
      block('sourcePermissionManifest.catalog', 'unsupported_consumed_channel');
      continue;
    }
    const exact = versions.get(requested.ref.versionId.toLowerCase());
    if (
      !row ||
      !exact ||
      !sameId(exact.aggregateId, requested.ref.id) ||
      row.state === 'unavailable' ||
      row.reason !== null ||
      row.content?.digest !== impactDependencyDigest(exact.record) ||
      !row.currentHead ||
      !sameId(row.currentHead.aggregate_id, requested.ref.id) ||
      (row.state === 'current'
        ? !sameId(row.currentHead.version_id, requested.ref.versionId)
        : sameId(row.currentHead.version_id, requested.ref.versionId)) ||
      !row.exercises ||
      row.exercises.length
    )
      block('sourcePermissionManifest.catalog', 'source_membership_mismatch');
  }
  for (const row of catalogRows.values())
    if (!catalogRequests.has(impactDependencyDigest(row.requested)))
      block('sourcePermissionManifest.catalog', 'unsupported_consumed_channel');
  const routineSourceIds = new Set([
    ...(c.currentTraining ? [c.currentTraining.snapshot.id.toLowerCase()] : []),
    ...c.routineActualManifest.schedules.flatMap((row) =>
      row.sourcePlanVersionId === null ? [] : [row.sourcePlanVersionId.toLowerCase()],
    ),
  ]);
  const routineBlueprintKeys = new Set(
    c.routineActualManifest.schedules.map((row) =>
      JSON.stringify([
        row.record.blueprint.id.toLowerCase(),
        row.record.blueprint.versionId.toLowerCase(),
      ]),
    ),
  );
  const routineScheduleResult = validateRoutineScheduleReadManifest({
    athleteId: c.athleteId,
    currentTraining: c.currentTraining,
    sourcePlans: c.consumedSources.plans.filter((plan) =>
      routineSourceIds.has(plan.id.toLowerCase()),
    ),
    blueprints: c.routineActualManifest.blueprints
      .map((row) => row.record)
      .filter((record) =>
        routineBlueprintKeys.has(
          JSON.stringify([record.routineId.toLowerCase(), record.versionId.toLowerCase()]),
        ),
      ),
    schedules: c.routineActualManifest.schedules,
    routines: c.routines,
    affectedRoutineIds: c.affected.routine,
    ...(c.calendarIntent === undefined || c.calendarIntent === null
      ? {}
      : {
          calendarIntent: {
            athleteId: c.athleteId,
            event: c.event,
            newLocalDate: c.calendarIntent.newLocalDate,
            selection: c.calendarIntent.selection,
            completionReports: c.completions,
          },
        }),
  });
  for (const finding of routineScheduleResult.blockers)
    block(`routineScheduleSources.${finding.path}`, finding.reason);
  const schedules = new Map(
    c.routineActualManifest.schedules.map((row) => [row.versionId.toLowerCase(), row]),
  );
  if (
    schedules.size !== c.routineActualManifest.schedules.length ||
    new Set(c.routines.map((r) => r.aggregateId.toLowerCase())).size !== c.routines.length
  )
    block('routineActualManifest', 'source_identity_mismatch');
  for (const b of blueprints.values())
    if (
      ![...schedules.values()].some(
        (row) =>
          sameId(row.record.blueprint.versionId, b.record.versionId) &&
          sameId(row.record.blueprint.id, b.record.routineId),
      ) &&
      !c.routineActualManifest.runs.some(
        (row) =>
          sameId(row.record.blueprint.versionId, b.record.versionId) &&
          sameId(row.record.blueprint.id, b.record.routineId),
      )
    )
      block('routineActualManifest.blueprints', 'source_membership_mismatch');
  for (const row of schedules.values()) {
    if (
      !sameId(row.scheduleId, row.record.id) ||
      !sameId(row.versionId, row.record.versionId) ||
      !blueprints.has(row.record.blueprint.versionId.toLowerCase()) ||
      !sameId(
        blueprints.get(row.record.blueprint.versionId.toLowerCase())?.record.routineId ?? '',
        row.record.blueprint.id,
      )
    )
      block('routineActualManifest.schedules', 'source_membership_mismatch');
  }
  for (const row of c.routines) {
    const exact = schedules.get(row.versionId.toLowerCase());
    if (
      !exact ||
      !sameId(row.aggregateId, exact.scheduleId) ||
      !equal(row.record, exact.record) ||
      exact.currentHead.state !== 'present' ||
      !sameId(exact.currentHead.versionId, row.versionId)
    )
      block('routines', 'source_membership_mismatch');
  }
  if (
    new Set(c.routineActualManifest.occurrences.map((o) => o.record.id)).size !==
    c.routineActualManifest.occurrences.length
  )
    block('routineActualManifest.occurrences', 'source_identity_mismatch');
  for (const o of c.routineActualManifest.occurrences) {
    const b = blueprints.get(o.record.blueprint.versionId.toLowerCase());
    const scheduled = schedules.get(o.record.schedule.versionId.toLowerCase());
    if (
      !scheduled ||
      !sameId(scheduled.scheduleId, o.record.schedule.id) ||
      !equal(scheduled.record.blueprint, o.record.blueprint) ||
      (o.currentSchedule.state === 'present' &&
        (scheduled.currentHead.state !== 'present' ||
          !sameId(o.currentSchedule.versionId, scheduled.currentHead.versionId))) ||
      (o.currentSchedule.state === 'absent' && scheduled.currentHead.state !== 'absent')
    )
      block(`occurrence:${o.record.id}.schedule`, 'source_membership_mismatch');
    if (
      !b ||
      !sameId(b.record.routineId, o.record.blueprint.id) ||
      o.record.stepBindings.some(
        (binding) => !b.record.steps.some((step) => step.id === binding.stepId),
      )
    )
      block(`occurrence:${o.record.id}`, 'source_membership_mismatch');
    if (
      o.record.selectedChoices &&
      b &&
      Object.entries(o.record.selectedChoices).some(
        ([groupId, stepId]) =>
          !b.record.choiceGroups.some(
            (group) => group.id === groupId && group.stepIds.includes(stepId),
          ),
      )
    )
      block(`occurrence:${o.record.id}.selectedChoices`, 'source_membership_mismatch');
  }
  const supp = c.supplementaryManifest,
    exerciseIds = new Set(supp.exercises.map((e) => e.versionId.toLowerCase()));
  if (exerciseIds.size !== supp.exercises.length)
    block('supplementaryManifest.exercises', 'source_identity_mismatch');
  const sessions = c.consumedSources.plans.flatMap((p) =>
    p.draft.sessions
      .filter((s) => s.sport === 'strength')
      .map((session) => ({ plan: p.id, session: session.id })),
  );
  if (
    supp.sessions.length !== sessions.length ||
    new Set(
      supp.sessions.map((row) =>
        JSON.stringify([row.planVersionId.toLowerCase(), row.plannedSessionId]),
      ),
    ).size !== supp.sessions.length ||
    supp.sessions.some(
      (s) =>
        !sessions.some((x) => sameId(x.plan, s.planVersionId) && x.session === s.plannedSessionId),
    )
  )
    block('supplementaryManifest.sessions', 'source_membership_mismatch');
  for (const srow of supp.sessions) {
    const copies = supp.copies.filter(
      (copy) =>
        sameId(copy.link.planVersionId, srow.planVersionId) &&
        copy.link.plannedSessionId === srow.plannedSessionId,
    );
    if (copies.length !== (srow.state === 'present' ? 1 : 0))
      block('supplementaryManifest.copies', 'missing_source');
  }
  for (const copy of supp.copies) {
    if (
      !supp.sessions.some(
        (s) =>
          sameId(s.planVersionId, copy.link.planVersionId) &&
          s.plannedSessionId === copy.link.plannedSessionId &&
          s.state === 'present',
      ) ||
      copy.targets.some((t) => !exerciseIds.has(t.exercise_version_id.toLowerCase())) ||
      new Set(copy.targets.map((t) => t.target_set_id)).size !== copy.targets.length
    )
      block('supplementaryManifest.copies', 'source_membership_mismatch');
    if (copy.link.content.kind === 'embedded') {
      const targets = copy.link.content.spec.blocks.flatMap((b) =>
        b.sets.map((set) => ({
          block_id: b.id,
          target_set_id: set.id,
          exercise_version_id: set.exerciseVersionId,
        })),
      );
      if (
        copy.targetSource !== 'session_copy' ||
        copy.contentDigest !== impactDependencyDigest(copy.link.content.spec) ||
        !equal(copy.targets, targets)
      )
        block('supplementaryManifest.copies', 'digest_mismatch');
    } else block('supplementaryManifest.routines', 'unsupported_consumed_channel');
  }
  const usedExercises = new Set(
    supp.copies.flatMap((copy) => copy.targets.map((t) => t.exercise_version_id.toLowerCase())),
  );
  if (usedExercises.size !== exerciseIds.size || supp.routines.length)
    block('supplementaryManifest.roster', 'source_membership_mismatch');
  const resourceResult = validateResourceReadManifest({
    requestedVersionIds: [
      ...supp.exercises.flatMap((e) => e.resourceVersionIds),
      ...(c.workoutTemplateSources?.exercises.flatMap((e) => e.record.resourceVersionIds) ?? []),
    ],
    metadata: c.sourcePermissionManifest.resources,
    ...(c.resourceReadFacts === undefined ? {} : { sourceFacts: c.resourceReadFacts }),
  });
  for (const finding of resourceResult.blockers)
    block(`resourceReadFacts.${finding.path}`, finding.reason);
  const am = c.sourcePermissionManifest.activityMediaPermissions;
  // Tenant-wide head/provider/consent inventories are metadata, not consumed
  // actual bodies or source permission. Keep their bytes in the read digest.
  // Completion/unsupported actual channels remain blocked at their specific rows above. A media row is
  // different: captureActivityAndMediaPermissions emits it only for requested
  // media IDs from the consumed catalog/copy inventory.
  if (
    new Set(am.activities.map((row) => row.id.toLowerCase())).size !== am.activities.length ||
    new Set(am.healthkit.map((row) => row.id.toLowerCase())).size !== am.healthkit.length
  )
    block('activityMediaPermissions.metadata', 'source_identity_mismatch');
  const mediaResult = validateMediaReadManifest({
    requestedIds: [
      ...supp.exercises.flatMap((e) => e.mediaAssetIds),
      ...(c.workoutTemplateSources?.exercises.flatMap((e) => e.record.mediaAssetIds) ?? []),
    ],
    metadata: am.media,
    ...(c.mediaReadFacts === undefined ? {} : { sourceFacts: c.mediaReadFacts }),
  });
  for (const finding of mediaResult.blockers)
    block(`mediaReadFacts.${finding.path}`, finding.reason);
  const affectedNutrition = c.nutrition
    .filter((row) => row.relativeItems.some((item) => item.affected))
    .map((row) => row.aggregateId.toLowerCase());
  if (
    new Set(c.affected.nutrition.map((value) => value.toLowerCase())).size !==
      c.affected.nutrition.length ||
    !equal(
      c.affected.nutrition.map((value) => value.toLowerCase()).sort(),
      affectedNutrition.sort(),
    )
  )
    block('affected.nutrition', 'source_identity_mismatch');
  const visits =
    refs.length +
    c.completions.length +
    (c.manualIntakeReadFacts?.facts.length ?? 0) +
    (c.manualActivityReadFacts?.facts.length ?? 0) +
    (c.localImportedActivityReadFacts?.facts.length ?? 0) +
    (c.workoutTemplateSources?.templates.length ?? 0) +
    (c.workoutTemplateSources?.exercises.length ?? 0) +
    (c.workoutTemplateSources?.targets.length ?? 0) +
    (c.resourceReadFacts?.facts.length ?? 0) +
    (c.mediaReadFacts?.facts.length ?? 0) +
    c.consumedSources.plans.length +
    c.consumedSources.races.length +
    allNutrition.reduce((sum, n) => sum + n.record.items.length, 0) +
    (rn
      ? rn.facts.length +
        rn.records.length +
        rn.nestedSources.loadedPlans.length +
        rn.nestedSources.nutrition.reduce((sum, n) => sum + n.foods.length + n.anchors.length, 0)
      : 0) +
    supp.sessions.length +
    supp.copies.length +
    supp.exercises.length +
    c.routineActualManifest.uniqueSourceCount;
  if (visits > 5000) block('consumedSourceVisits', 'bounds_exceeded');
  if (blockers.length) return { status: 'blocked', blockers };
  return {
    status: 'validated_read_scope',
    purpose: s.purpose,
    semanticDigest: impactDependencyDigest({
      scope: s,
      readSetDigest: c.readSetDigest,
      nutrition: c.rosters.nutrition,
      plannedRefs: refs,
    }),
    capturedReadSetDigest: c.readSetDigest,
    nutritionVersions: c.nutrition.map((n) => ({ planId: n.aggregateId, versionId: n.versionId })),
    plannedRefs: refs,
    approvalAuthority: 'none',
    freshness: 'not_checked',
    remaining: [
      'context_orchestration',
      'semantic_freshness',
      'unsupported_producer_channels',
      'private_cleanup_permission_port',
      'stored_proposal_and_atomic_approval_authority',
    ],
  };
}
