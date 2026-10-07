import {
  projectGarminActivityReadFacts,
  type GarminActivityReadFacts,
} from '../src/race-plan-impact-garmin-activity-read-facts.js';
import {
  projectHealthKitActivityReadFacts,
  type HealthKitActivityReadFacts,
} from '../src/race-plan-impact-healthkit-activity-read-facts.js';
import { routineReadManifestSchema } from '../src/race-plan-impact-routine-manifest.js';
import { manualActivityReadProjectionInputSchema } from '../src/race-plan-impact-manual-activity-read-facts.js';
import {
  type localImportedActivityReadFactsSchema,
  projectLocalImportedActivityReadFacts,
} from '../src/race-plan-impact-local-imported-activity-read-facts.js';
import { createHash } from 'node:crypto';
import { manualActivityCreateSchema } from '@workout/contracts/activity';
import {
  type manualActivityReadFactsSchema,
  projectManualActivityReadFacts,
} from '../src/race-plan-impact-manual-activity-read-facts.js';
import { activeIntakeEntrySchema } from '@workout/contracts/nutrition-core';
import { manualIntakeReadFactsSchema } from '../src/race-plan-impact-intake-read-facts.js';
import { courseRevisionSchema } from '@workout/contracts/courses';
import { courseContentDigest } from '@workout/server-courses/digest';
import { courseReadManifestSchema } from '../src/race-plan-impact-course-manifest.js';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import { routineRunReadSchema } from '@workout/contracts/routine-commands';
import { recoverySourceFactsSchema } from '../src/race-plan-impact-recovery-sources.js';
import {
  recoveryMethodVersionSchema,
  recoveryStrategyVersionSchema,
} from '@workout/contracts/recovery-core';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { coreEvidenceDependencyManifestSchema } from '@workout/contracts/evidence-dependencies';
import { foodDefinitionVersionSchema } from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
  routineRunSchema,
  domainPlanRefSchema,
} from '@workout/contracts/routines';
import { supplementarySessionLinkSchema } from '@workout/contracts/supplementary-core';
import {
  integratedDependencyKinds,
  impactDependencyDigest,
} from '../src/race-plan-impact-dependencies.js';
import {
  raceImpactConsumedCaptureSchema,
  validateRaceImpactConsumedManifest,
  type RaceImpactConsumedScope,
} from '../src/race-plan-impact-complete-manifest.js';

const athlete = 'synthetic-manual',
  generation = '00000000-0000-4000-8000-000000000001',
  race = '00000000-0000-4000-8000-000000000002',
  plan = '00000000-0000-4000-8000-000000000003',
  version = '00000000-0000-4000-8000-00000000000a',
  scheduleId = '00000000-0000-4000-8000-000000000005',
  scheduleVersion = '00000000-0000-4000-8000-000000000006',
  blueprintId = '00000000-0000-4000-8000-000000000007',
  blueprintVersion = '00000000-0000-4000-8000-000000000008';
const hash = '1'.repeat(64),
  now = '2026-10-07T00:00:00.000Z';
const absent = () => ({ state: 'absent' as const });
const jsonRows = () => z.array(z.json()).parse([]);
const presentVersion = () => ({ state: 'present' as const, versionId: scheduleVersion });
function fixture() {
  const manualIntakeFields: {
    manualIntakeReadFacts?: z.infer<typeof manualIntakeReadFactsSchema>;
    manualActivityReadFacts?: z.infer<typeof manualActivityReadFactsSchema>;
    localImportedActivityReadFacts?: z.infer<typeof localImportedActivityReadFactsSchema>;
  } = {};
  return {
    ...manualIntakeFields,
    status: 'blocked' as const,
    coverage: {
      complete: false as const,
      missing: [
        'complete_catalog_and_actual_manifest',
        'supplementary_reference_manifest',
        'routine_occurrences_and_started_runs',
        'complete_source_permission_manifest',
        'manual_purpose_app_and_policy_binding',
      ],
      captured: [
        'integrated_dependency_inventory',
        'immutable_supplementary_copy_references',
        'routine_occurrence_run_and_actual_reference_facts',
        'partial_owned_planned_reference_and_resource_permission_facts',
        'nested_nutrition_plan_food_anchor_and_activity_media_provider_facts',
        'manual_purpose_app_and_policy_facts',
      ],
    },
    athleteId: athlete,
    restoreGeneration: generation,
    manualBasis: {
      purpose: 'manual_race_date_change' as const,
      policy: { id: 'manual-race-date-impact' as const, version: 1 as const, digest: hash },
      app: { state: 'present' as const, granted: true, revision: 1 },
    },
    event: raceEventSchema.parse({
      id: race,
      revision: 1,
      title: 'Synthetic',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: null,
    }),
    collections: [
      { kind: 'race-event', revision: 1, privacy_generation: '0' },
      { kind: 'race-result', revision: 1, privacy_generation: '0' },
      { kind: 'training-best', revision: 1, privacy_generation: '0' },
    ],
    linkedPlan: z.nullable(planSnapshotSchema).parse(null),
    currentTraining: z
      .nullable(z.strictObject({ aggregateId: z.uuid(), snapshot: planSnapshotSchema }))
      .parse(null),
    completions: z.array(sessionCompletionSchema).parse([]),
    course: courseReadManifestSchema.nullable().parse(null),
    rosters: {
      nutrition: z.array(z.strictObject({ aggregateId: z.uuid(), versionId: z.uuid() })).parse([]),
      recovery: jsonRows(),
      routine: z.array(z.strictObject({ aggregateId: z.uuid(), versionId: z.uuid() })).parse([]),
    },
    nutrition: z
      .array(
        z.strictObject({
          aggregateId: z.uuid(),
          versionId: z.uuid(),
          record: nutritionPlanVersionCompatibleV4Schema,
          sourceRelation: z.enum(['absent', 'current', 'historical']),
          relativeItems: z.array(z.json()),
        }),
      )
      .parse([]),
    recovery: jsonRows(),
    routines: z
      .array(
        z.strictObject({
          aggregateId: z.uuid(),
          versionId: z.uuid(),
          record: routineScheduleVersionSchema,
          sourceVersionId: z.uuid().nullable(),
          sourceRelation: z.enum(['absent', 'current', 'historical']),
          affected: z.boolean(),
        }),
      )
      .parse([]),
    coreDependencies: coreEvidenceDependencyManifestSchema.parse({
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: athlete,
      capturedAt: now,
      trainingPlan: { kind: 'absent' },
      activities: { count: '0', revisionSum: '0' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      aiConsent: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
    }),
    dependencyInventory: integratedDependencyKinds.map((kind) => ({
      kind,
      state: 'absent' as const,
    })),
    supplementaryManifest: {
      sessions: z
        .array(
          z.strictObject({
            planVersionId: z.uuid(),
            plannedSessionId: z.string(),
            state: z.enum(['absent', 'present']),
          }),
        )
        .parse([]),
      copies: z
        .array(
          z.strictObject({
            link: supplementarySessionLinkSchema,
            targetSource: z.enum(['session_copy', 'routine_version']),
            contentDigest: z.string(),
            targets: z.array(
              z.strictObject({
                block_id: z.string(),
                target_set_id: z.string(),
                exercise_version_id: z.uuid(),
              }),
            ),
          }),
        )
        .parse([]),
      routines: jsonRows(),
      exercises: z
        .array(
          z.strictObject({
            exerciseId: z.uuid(),
            versionId: z.uuid(),
            version: z.number(),
            contentDigest: z.string(),
            resourceVersionIds: z.array(z.string()),
            mediaAssetIds: z.array(z.string()),
          }),
        )
        .parse([]),
    },
    routineActualManifest: {
      uniqueSourceCount: 0,
      occurrences: z
        .array(
          z.strictObject({
            record: routineOccurrenceSchema,
            currentSchedule: z.union([
              z.strictObject({ state: z.literal('absent') }),
              z.strictObject({ state: z.literal('present'), versionId: z.uuid() }),
            ]),
            startedRun: z.union([
              z.strictObject({ state: z.literal('absent') }),
              z.strictObject({
                state: z.literal('present'),
                runId: z.uuid(),
                revision: z.number().int().min(0).max(2147483646),
              }),
            ]),
          }),
        )
        .parse([]),
      runs: jsonRows(),
      blueprints: z
        .array(
          z.strictObject({
            record: routineBlueprintVersionSchema,
            version: z.number(),
            currentHead: z.strictObject({
              state: z.literal('present'),
              versionId: z.uuid(),
              version: z.number(),
              visibility: z.literal('active'),
              favorite: z.boolean(),
            }),
            unsupportedContent: z.array(z.json()),
          }),
        )
        .parse([]),
      schedules: z
        .array(
          z.strictObject({
            scheduleId: z.uuid(),
            versionId: z.uuid(),
            sourcePlanVersionId: z.uuid().nullable(),
            record: routineScheduleVersionSchema,
            currentHead: z.strictObject({
              state: z.literal('present'),
              versionId: z.uuid(),
              notificationMuted: z.boolean(),
            }),
          }),
        )
        .parse([]),
      actualRosters: { activities: jsonRows(), intake: jsonRows(), recovery: jsonRows() },
    },
    sourcePermissionManifest: {
      complete: false as const,
      planned: z
        .array(
          z.strictObject({
            requested: domainPlanRefSchema,
            state: z.enum(['current', 'historical', 'unavailable']),
            reason: z.string().nullable(),
            currentHead: z
              .strictObject({ aggregate_id: z.uuid(), version_id: z.uuid() })
              .nullable(),
            content: z.strictObject({ digest: z.string() }).nullable(),
            aggregateIdentity: z.enum(['immutable_version', 'current_head_association_only']),
            exactOwnedVersion: z
              .strictObject({ aggregateId: z.uuid(), versionId: z.uuid() })
              .nullable()
              .optional(),
          }),
        )
        .parse([]),
      resources: jsonRows(),
      catalog: jsonRows(),
      nestedNutritionSources: z
        .array(
          z.strictObject({
            versionId: z.uuid(),
            recordDigest: z.string().optional(),
            foods: z.array(z.json()),
            anchors: z.array(z.json()),
            linkedPlan: z.json(),
          }),
        )
        .parse([]),
      activityMediaPermissions: {
        activities: jsonRows(),
        garminLineage: jsonRows(),
        healthkit: jsonRows(),
        media: jsonRows(),
        healthkitRegistry: z.json().parse(absent()),
        garmin: z.json().parse(absent()),
        garminUnofficial: z.json().parse(absent()),
        consents: z
          .array(z.json())
          .parse(['provider', 'healthkit', 'media'].map((kind) => ({ kind, ...absent() }))),
      },
      aiConsent: absent(),
      missing: [
        'unsupported_domain_item_membership',
        'immutable_training_aggregate_history',
        'media_cleanup_status_port',
        'media_and_provider_source_permissions',
        'manual_purpose_app_and_policy_binding',
      ],
    },
    consumedSources: {
      plans: z.array(planSnapshotSchema).parse([]),
      races: z.array(raceEventSchema).parse([]),
    },
    readSetDigest: hash,
    affected: { nutrition: [] as string[], routine: [] as string[] },
  };
}
type Capture = ReturnType<typeof fixture>;
function sign(c: Capture): RaceImpactConsumedScope {
  const { status, coverage, readSetDigest, affected, ...readSet } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  if (!c.consumedSources.races.length) c.consumedSources.races.push(structuredClone(c.event));
  c.readSetDigest = impactDependencyDigest({
    ...readSet,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  return {
    purpose: 'manual_race_date_change',
    athleteId: athlete,
    restoreGeneration: generation,
    expectedEvent: { id: race, revision: 1 },
    expectedPolicy: c.manualBasis.policy,
    expectedAppRevision: 1,
    expectedReadSetDigest: c.readSetDigest,
  };
}
function inspect(c: Capture) {
  return validateRaceImpactConsumedManifest(c, sign(c));
}
function blocked(c: Capture, reason: string, path?: string) {
  const result = inspect(c);
  expect(result.status).toBe('blocked');
  if (result.status === 'blocked')
    expect(result.blockers.some((b) => b.reason === reason && (!path || b.path === path))).toBe(
      true,
    );
}
function withNutritionRef() {
  const c = fixture();
  const record = nutritionPlanVersionCompatibleV4Schema.parse({
    planId: plan,
    versionId: version,
    version: 1,
    previousVersionId: null,
    approvedAt: now,
    approvalId: blueprintId,
    period: { from: '2026-10-07', toInclusive: '2026-10-08' },
    timezone: 'Asia/Seoul',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'item-영양',
        planVersionId: version,
        category: 'meal',
        title: 'Meal',
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' },
        foods: [],
        targets: [],
        instructions: 'Eat user-selected meal',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
  c.nutrition.push({
    aggregateId: plan,
    versionId: version,
    record,
    sourceRelation: 'absent',
    relativeItems: [],
  });
  c.rosters.nutrition.push({ aggregateId: plan, versionId: version });
  c.sourcePermissionManifest.nestedNutritionSources.push({
    versionId: version,
    foods: [],
    anchors: [],
    linkedPlan: absent(),
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: blueprintId,
    versionId: blueprintVersion,
    title: 'Checklist',
    intent: 'Retained planned reference',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Review meal',
        content: { kind: 'nutrition_template', ref: { id: plan, versionId: version } },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: now,
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: scheduleId,
    versionId: scheduleVersion,
    blueprint: { id: blueprintId, versionId: blueprintVersion },
    window: {
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'Asia/Seoul',
      maxOccurrences: 1,
    },
    rule: { kind: 'dates', dates: ['2026-10-07'], localTime: null },
    state: 'active',
  });
  const ref = domainPlanRefSchema.parse({
    domain: 'nutrition',
    planId: plan,
    versionId: version,
    itemId: 'item-영양',
  });
  c.routineActualManifest.blueprints.push({
    record: blueprint,
    version: 1,
    currentHead: {
      state: 'present',
      versionId: blueprintVersion,
      version: 1,
      visibility: 'active',
      favorite: false,
    },
    unsupportedContent: [],
  });
  c.routineActualManifest.schedules.push({
    scheduleId,
    versionId: scheduleVersion,
    record: schedule,
    sourcePlanVersionId: null,
    currentHead: { state: 'present', versionId: scheduleVersion, notificationMuted: false },
  });
  c.routines.push({
    aggregateId: scheduleId,
    versionId: scheduleVersion,
    record: schedule,
    sourceVersionId: null,
    sourceRelation: 'absent',
    affected: false,
  });
  c.rosters.routine.push({ aggregateId: scheduleId, versionId: scheduleVersion });
  c.routineActualManifest.occurrences.push({
    record: routineOccurrenceSchema.parse({
      id: 'occurrence',
      schedule: { id: scheduleId, versionId: scheduleVersion },
      blueprint: schedule.blueprint,
      anchorKey: 'date:2026-10-07',
      scheduledAt: null,
      timingStatus: 'unresolved',
      stepBindings: [{ stepId: 'step', plannedRef: ref }],
      selectedChoices: {},
    }),
    currentSchedule: presentVersion(),
    startedRun: absent(),
  });
  c.routineActualManifest.uniqueSourceCount = 2;
  c.sourcePermissionManifest.planned.push({
    requested: ref,
    state: 'current',
    reason: null,
    currentHead: { aggregate_id: plan, version_id: version },
    content: { digest: impactDependencyDigest(record) },
    aggregateIdentity: 'immutable_version',
  });
  c.sourcePermissionManifest.catalog.push({
    requested: { kind: 'nutrition_template', ref: { id: plan, versionId: version } },
    state: 'current',
    reason: null,
    content: { digest: impactDependencyDigest(record) },
    currentHead: { aggregate_id: plan, version_id: version },
    exercises: [],
  });
  return c;
}
it('admits a closed empty read scope without complete/approval/freshness claims', () => {
  const c = fixture(),
    before = structuredClone(c);
  const result = inspect(c);
  expect(result.status).toBe('validated_read_scope');
  if (result.status === 'validated_read_scope') {
    expect(result.approvalAuthority).toBe('none');
    expect(result.freshness).toBe('not_checked');
    expect(result.remaining).toContain('stored_proposal_and_atomic_approval_authority');
  }
  expect(c.coverage).toEqual(before.coverage);
});
it('validates exact nutrition item membership in a retained unresolved routine occurrence', () => {
  const c = withNutritionRef();
  expect(inspect(c).status).toBe('validated_read_scope');
  expect(c.routineActualManifest.occurrences[0]?.record.scheduledAt).toBeNull();
});
it('rejects missing nutrition version instead of throwing on absent sources', () => {
  const c = withNutritionRef();
  c.nutrition = [];
  c.rosters.nutrition = [];
  c.sourcePermissionManifest.nestedNutritionSources = [];
  blocked(c, 'source_membership_mismatch');
});
it.each(['plan', 'version', 'item', 'digest', 'head'] as const)(
  'rejects wrong nutrition %s membership',
  (kind) => {
    const c = withNutritionRef(),
      entry = c.sourcePermissionManifest.planned[0];
    if (!entry) throw Error('fixture');
    if (kind === 'plan') entry.requested.planId = race;
    if (kind === 'version') entry.requested.versionId = race;
    if (kind === 'item') entry.requested.itemId = 'missing';
    if (kind === 'digest') entry.content = { digest: hash };
    if (kind === 'head') entry.currentHead = { aggregate_id: race, version_id: version };
    blocked(
      c,
      kind === 'digest' || kind === 'head' ? 'source_membership_mismatch' : 'missing_source',
    );
  },
);
it('blocks unsupported recovery planned references with an exact consumed path', () => {
  const c = withNutritionRef(),
    o = c.routineActualManifest.occurrences[0],
    p = c.sourcePermissionManifest.planned[0];
  if (!o || !p) throw Error('fixture');
  p.requested = { ...p.requested, domain: 'recovery' };
  const binding = o.record.stepBindings[0];
  if (!binding) throw Error('fixture');
  binding.plannedRef = p.requested;
  blocked(c, 'unsupported_consumed_channel');
});
it('blocks recovery catalog refs and runs rather than dropping them', () => {
  const c = withNutritionRef();
  c.sourcePermissionManifest.catalog.push({
    requested: { kind: 'recovery_method', ref: { id: plan, versionId: version } },
    state: 'unavailable',
    reason: 'producer_content_unsupported',
    content: null,
    currentHead: null,
  });
  c.routineActualManifest.runs.push({ unresolved: true });
  blocked(c, 'invalid_capture', 'capture');
});
it('requires exact schedule and blueprint membership', () => {
  const c = withNutritionRef();
  const o = c.routineActualManifest.occurrences[0];
  if (!o) throw Error('fixture');
  o.record.schedule.versionId = race;
  blocked(c, 'source_membership_mismatch');
});
it('rejects duplicate occurrence IDs', () => {
  const c = withNutritionRef(),
    o = c.routineActualManifest.occurrences[0];
  if (!o) throw Error('fixture');
  c.routineActualManifest.occurrences.push(structuredClone(o));
  blocked(c, 'source_identity_mismatch');
});
it('requires all absence facts, not an empty unproven coverage list', () => {
  const c = fixture();
  c.coverage.captured = [];
  blocked(c, 'invalid_capture');
});
it('rejects unknown top-level fields and unsupported producer payloads', () => {
  const c = fixture();
  expect(validateRaceImpactConsumedManifest({ ...c, complete: true }, sign(c)).status).toBe(
    'blocked',
  );
  c.recovery.push({ planId: plan });
  blocked(c, 'invalid_capture', 'capture');
});
it.each(['athlete', 'generation', 'revision', 'policy'] as const)(
  'binds expected %s independently',
  (kind) => {
    const c = fixture(),
      scope = sign(c);
    if (kind === 'athlete') scope.athleteId = 'foreign';
    if (kind === 'generation') scope.restoreGeneration = race;
    if (kind === 'revision') scope.expectedEvent.revision = 2;
    if (kind === 'policy')
      scope.expectedPolicy = { ...scope.expectedPolicy, digest: '2'.repeat(64) };
    const result = validateRaceImpactConsumedManifest(c, scope);
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(result.blockers).toContainEqual({ path: 'scope', reason: 'scope_mismatch' });
  },
);
it('rejects a mutated body under an old read digest', () => {
  const c = fixture(),
    scope = sign(c);
  c.event.title = 'Changed';
  const result = validateRaceImpactConsumedManifest(c, scope);
  expect(result.status).toBe('blocked');
  if (result.status === 'blocked')
    expect(result.blockers).toContainEqual({ path: 'readSetDigest', reason: 'digest_mismatch' });
});
it('retains digest stability for capture timestamp only', () => {
  const c = fixture(),
    scope = sign(c);
  c.coreDependencies.capturedAt = '2026-10-07T01:00:00.000Z';
  expect(validateRaceImpactConsumedManifest(c, scope).status).toBe('validated_read_scope');
});
it('withdrawn manual admission cannot grant authority through AI consent', () => {
  const c = fixture();
  c.manualBasis.app.granted = false;
  blocked(c, 'manual_admission_unavailable');
});
it('rejects missing and duplicate dependency kinds', () => {
  const c = fixture(),
    f = c.dependencyInventory[0];
  if (!f) throw Error('fixture');
  c.dependencyInventory[1] = f;
  blocked(c, 'invalid_capture', 'dependencyInventory');
});
it('fails closed for resource cleanup and provider facts', () => {
  const c = fixture();
  c.sourcePermissionManifest.activityMediaPermissions.media.push({
    assetId: 'owned',
    cleanup: { state: 'unavailable' },
  });
  blocked(c, 'invalid_projection', 'mediaReadFacts.projection');
});
it('bounds cyclic/deep/oversized unknown input before runtime parsers', () => {
  const c = fixture(),
    scope = sign(c);
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  expect(validateRaceImpactConsumedManifest(cycle, scope).status).toBe('blocked');
  let deep: unknown = null;
  for (let n = 0; n < 70; n++) deep = { child: deep };
  expect(validateRaceImpactConsumedManifest(deep, scope).status).toBe('blocked');
  expect(
    validateRaceImpactConsumedManifest({ ...c, recovery: ['x'.repeat(4194305)] }, scope).status,
  ).toBe('blocked');
});

function withSupplementary() {
  const c = fixture(),
    exerciseVersion = blueprintVersion;
  const snapshot = planSnapshotSchema.parse({
    id: version,
    version: 1,
    createdAt: now,
    draft: {
      timezone: 'Asia/Seoul',
      title: 'Strength',
      periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
        id: level,
        parentId: index === 0 ? null : levels[index - 1],
        level,
        title: level,
        startDate: '2026-10-07',
        endDateExclusive: '2026-10-08',
        timezone: 'Asia/Seoul',
        intent: 'Synthetic',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'strength',
          blockId: 'block',
          date: '2026-10-07',
          localStartTime: null,
          title: 'Strength',
          sport: 'strength',
          durationSeconds: null,
          distanceMeters: null,
          targetRpe: null,
          purpose: 'Synthetic',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
  const link = supplementarySessionLinkSchema.parse({
    schemaVersion: 2,
    planVersionId: version,
    plannedSessionId: 'strength',
    content: {
      kind: 'embedded',
      spec: {
        schemaVersion: 2,
        kind: 'supplementary',
        routineVersionId: null,
        blocks: [
          {
            id: 'block',
            mode: 'single',
            rounds: 1,
            restBetweenRoundsSeconds: null,
            sets: [
              {
                id: 'set',
                exerciseVersionId: exerciseVersion,
                side: 'bilateral',
                count: null,
                durationSeconds: {
                  min: 30,
                  max: 30,
                  unit: 's',
                  basis: 'user_confirmed',
                  evidenceIds: [],
                },
                externalResistance: { kind: 'unknown' },
                restAfterSeconds: null,
                tempo: null,
                effort: null,
              },
            ],
          },
        ],
      },
    },
  });
  if (link.content.kind !== 'embedded') throw Error('fixture');
  c.currentTraining = { aggregateId: plan, snapshot };
  c.consumedSources.plans.push(snapshot);
  c.coreDependencies.trainingPlan = { kind: 'exists', versionId: version };
  c.supplementaryManifest.sessions.push({
    planVersionId: version,
    plannedSessionId: 'strength',
    state: 'present',
  });
  c.supplementaryManifest.copies.push({
    link,
    targetSource: 'session_copy',
    contentDigest: impactDependencyDigest(link.content.spec),
    targets: [{ block_id: 'block', target_set_id: 'set', exercise_version_id: exerciseVersion }],
  });
  c.supplementaryManifest.exercises.push({
    exerciseId: blueprintId,
    versionId: exerciseVersion,
    version: 1,
    contentDigest: hash,
    resourceVersionIds: [],
    mediaAssetIds: [],
  });
  return c;
}
it('admits an exact frozen embedded supplementary copy with explicit exercise roster', () => {
  expect(inspect(withSupplementary()).status).toBe('validated_read_scope');
});
it.each([
  'missing_exercise',
  'wrong_target',
  'wrong_digest',
  'missing_session',
  'duplicate_copy',
] as const)('rejects supplementary %s', (kind) => {
  const c = withSupplementary(),
    copy = c.supplementaryManifest.copies[0];
  if (!copy) throw Error('fixture');
  if (kind === 'missing_exercise') c.supplementaryManifest.exercises = [];
  if (kind === 'wrong_target') copy.targets = [];
  if (kind === 'wrong_digest') copy.contentDigest = '2'.repeat(64);
  if (kind === 'missing_session') c.supplementaryManifest.sessions = [];
  if (kind === 'duplicate_copy') c.supplementaryManifest.copies.push(structuredClone(copy));
  expect(inspect(c).status).toBe('blocked');
});
it('blocks exact exercise media refs until private permission/cleanup port exists', () => {
  const c = withSupplementary(),
    exercise = c.supplementaryManifest.exercises[0];
  if (!exercise) throw Error('fixture');
  exercise.mediaAssetIds = ['asset'];
  blocked(c, 'source_port_missing', 'mediaReadFacts.sourceFacts');
});
it('rejects a missing nutrition template catalog source even with a valid planned item', () => {
  const c = withNutritionRef();
  c.sourcePermissionManifest.catalog = [];
  blocked(c, 'source_membership_mismatch', 'sourcePermissionManifest.catalog');
});

it('requires the captured event to be present in the consumed race source roster', () => {
  const c = fixture(),
    scope = sign(c);
  c.consumedSources.races = [];
  const { status, coverage, readSetDigest, affected, ...readSet } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  c.readSetDigest = impactDependencyDigest({
    ...readSet,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  scope.expectedReadSetDigest = c.readSetDigest;
  const result = validateRaceImpactConsumedManifest(c, scope);
  expect(result.status).toBe('blocked');
  if (result.status === 'blocked')
    expect(result.blockers).toContainEqual({
      path: 'consumedSources.races.event',
      reason: 'missing_source',
    });
});
it('binds the actual captured manual app revision rather than a standalone granted flag', () => {
  const c = fixture(),
    scope = sign(c);
  scope.expectedAppRevision = 2;
  expect(validateRaceImpactConsumedManifest(c, scope).status).toBe('blocked');
});
it('retains unrelated canonical ledger counts without claiming actual body membership', () => {
  const c = fixture();
  c.coreDependencies.activities = { count: '1', revisionSum: '1' };
  expect(inspect(c).status).toBe('validated_read_scope');
});

it.each([2, 3, 4])(
  'preserves compatible nutrition V%s absolute bodies in the exact catalog/item scope',
  (schemaVersion) => {
    const c = withNutritionRef(),
      row = c.nutrition[0],
      nested = c.sourcePermissionManifest.nestedNutritionSources[0],
      planned = c.sourcePermissionManifest.planned[0];
    if (!row || !nested || !planned) throw Error('fixture');
    row.record = nutritionPlanVersionCompatibleV4Schema.parse({
      ...row.record,
      schemaVersion,
      raceTimingPins: [],
      itemRaceTimingBindings: [],
    });
    nested.recordDigest = impactDependencyDigest(row.record);
    planned.content = { digest: impactDependencyDigest(row.record) };
    c.sourcePermissionManifest.catalog = [
      {
        requested: { kind: 'nutrition_template', ref: { id: plan, versionId: version } },
        state: 'current',
        reason: null,
        content: { digest: impactDependencyDigest(row.record) },
        currentHead: { aggregate_id: plan, version_id: version },
        exercises: [],
      },
    ];
    expect(inspect(c).status).toBe('validated_read_scope');
    expect(row.record).toHaveProperty('schemaVersion', schemaVersion);
  },
);
it('rejects an added same-UUID-case nutrition head rather than hiding duplicate sources', () => {
  const c = withNutritionRef(),
    row = c.nutrition[0];
  if (!row) throw Error('fixture');
  c.nutrition.push({ ...row, versionId: row.versionId.toUpperCase() });
  blocked(c, 'source_identity_mismatch', 'rosters');
});
it('rejects duplicate supplementary session absence facts even when the total count matches', () => {
  const c = withSupplementary(),
    p = c.consumedSources.plans[0],
    first = c.supplementaryManifest.sessions[0];
  if (!p || !first) throw Error('fixture');
  const session = p.draft.sessions[0];
  if (!session) throw Error('fixture');
  p.draft.sessions.push({ ...session, id: 'second' });
  c.supplementaryManifest.sessions.push({ ...first });
  blocked(c, 'source_membership_mismatch', 'supplementaryManifest.sessions');
});
it('rejects visits beyond occurrence bounds without pretending duplicated references are empty', () => {
  const c = withNutritionRef(),
    o = c.routineActualManifest.occurrences[0];
  if (!o) throw Error('fixture');
  c.routineActualManifest.occurrences = Array.from({ length: 1001 }, (_, index) => ({
    ...o,
    record: { ...o.record, id: `occurrence-${index}` },
  }));
  expect(inspect(c).status).toBe('blocked');
});
it('rejects unknown fields on finite manual basis and supplementary copy DTOs', () => {
  const c = fixture(),
    scope = sign(c);
  expect(
    validateRaceImpactConsumedManifest(
      { ...c, manualBasis: { ...c.manualBasis, approvalAuthority: true } },
      scope,
    ).status,
  ).toBe('blocked');
  const s = withSupplementary(),
    copy = s.supplementaryManifest.copies[0];
  if (!copy) throw Error('fixture');
  expect(
    validateRaceImpactConsumedManifest(
      {
        ...s,
        supplementaryManifest: { ...s.supplementaryManifest, copies: [{ ...copy, owned: true }] },
      },
      sign(s),
    ).status,
  ).toBe('blocked');
});

it.each([true, false])(
  'retains unused finite provider/HK/media consent metadata granted=%s without granting source permission',
  (granted) => {
    const c = fixture();
    c.sourcePermissionManifest.activityMediaPermissions.consents = [
      'provider',
      'healthkit',
      'media',
    ].map((kind) => ({ kind, state: 'present', granted, revision: 2 }));
    const result = inspect(c);
    expect(result.status).toBe('validated_read_scope');
    if (result.status === 'validated_read_scope') {
      expect(result.approvalAuthority).toBe('none');
      expect(result.freshness).toBe('not_checked');
    }
    expect(c.sourcePermissionManifest.activityMediaPermissions.consents).toHaveLength(3);
  },
);
it('retains unused registry and official/unofficial connection metadata in the captured digest', () => {
  const c = fixture(),
    scope = sign(c),
    am = c.sourcePermissionManifest.activityMediaPermissions;
  am.healthkitRegistry = { state: 'present', revision: 3 };
  am.garmin = {
    state: 'present',
    connection: {
      generation: 0,
      state: 'reconnect_required',
      permissions: ['activities'],
      access_expires_at: null,
      refresh_expires_at: now,
    },
  };
  am.garminUnofficial = {
    state: 'present',
    connection: {
      session_generation: 2,
      state: 'connected',
      schedule_enabled: true,
      schedule_paused: false,
    },
  };
  expect(validateRaceImpactConsumedManifest(c, scope).status).toBe('blocked');
  const result = inspect(c);
  expect(result.status).toBe('validated_read_scope');
  expect(c.readSetDigest).not.toBe(scope.expectedReadSetDigest);
});
it('retains unrelated Activity head/ledger/provider lineage metadata without treating it as consumed body', () => {
  const c = fixture(),
    am = c.sourcePermissionManifest.activityMediaPermissions;
  c.coreDependencies.activities = { count: '1', revisionSum: '1' };
  am.activities.push({
    id: plan,
    revision: 1,
    deleted: false,
    overlay: { state: 'absent', revision: null },
    source: {
      state: 'present',
      kind: 'healthkit',
      sourceId: version,
      revision: 1,
      contentHash: hash,
      suppressed: false,
      revisionRecord: { state: 'present' },
    },
  });
  am.healthkit.push({
    id: version,
    sample: { state: 'present', status: 'active', payloadDigest: hash },
    lineage: { state: 'present', status: 'created_activity' },
    claim: { state: 'absent' },
    binding: { state: 'present', activityId: plan, targetRevision: 1, sampleDigest: hash },
  });
  am.garminLineage.push({
    kind: 'fit',
    source_id: 'unrelated-fit',
    provider: 'garmin-connect-unofficial',
    official: false,
    outcome: 'imported',
  });
  c.routineActualManifest.actualRosters.activities.push({
    id: plan,
    revision: 1,
    deleted: false,
    originalDigest: hash,
    overlayDigest: hash,
    source: {
      state: 'present',
      kind: 'healthkit',
      sourceId: version,
      sourceRevision: 1,
      contentHash: hash,
    },
  });
  expect(inspect(c).status).toBe('validated_read_scope');
  expect(am.activities).toHaveLength(1);
});
it('blocks a specific unsupported actual-consuming run even with unrelated metadata and granted consent', () => {
  const c = fixture();
  c.sourcePermissionManifest.activityMediaPermissions.consents = [
    'provider',
    'healthkit',
    'media',
  ].map((kind) => ({ kind, state: 'present', granted: true, revision: 1 }));
  c.routineActualManifest.runs.push({
    record: { actualRefs: [{ kind: 'activity', id: plan, revisionId: version }] },
  });
  blocked(c, 'invalid_capture', 'capture');
});
it('unused media cannot become consumed or gain authority from a provider consent', () => {
  for (const granted of [true, false]) {
    const c = fixture();
    c.sourcePermissionManifest.activityMediaPermissions.consents = [
      'provider',
      'healthkit',
      'media',
    ].map((kind) => ({ kind, state: 'present', granted, revision: 1 }));
    c.sourcePermissionManifest.activityMediaPermissions.media.push({
      requestedId: version,
      state: 'unavailable',
      content: null,
    });
    blocked(c, 'unused_source', 'mediaReadFacts.metadata');
  }
});
it.each([
  { state: 'present', revision: 0 },
  { state: 'present', revision: 1, permissionGranted: true },
])('rejects malformed/unknown registry metadata %j', (metadata) => {
  const c = fixture();
  c.sourcePermissionManifest.activityMediaPermissions.healthkitRegistry = metadata;
  blocked(c, 'invalid_capture');
});
it('rejects duplicate finite consent kinds without fabricating the omitted absence fact', () => {
  const c = fixture();
  c.sourcePermissionManifest.activityMediaPermissions.consents = [
    { kind: 'provider', state: 'absent' },
    { kind: 'provider', state: 'present', granted: false, revision: 1 },
    { kind: 'media', state: 'absent' },
  ];
  blocked(c, 'invalid_capture');
});

function withTrainingRef(historical = false, immutable = true) {
  const c = withNutritionRef(),
    snapshot = withSupplementary().currentTraining?.snapshot;
  if (!snapshot) throw Error('fixture training');
  const latest = historical
    ? planSnapshotSchema.parse({ ...snapshot, id: generation, version: 2 })
    : snapshot;
  c.currentTraining = { aggregateId: plan, snapshot: latest };
  c.coreDependencies.trainingPlan = { kind: 'exists', versionId: latest.id };
  c.consumedSources.plans = historical ? [snapshot, latest] : [snapshot];
  c.supplementaryManifest.sessions = c.consumedSources.plans.flatMap((p) =>
    p.draft.sessions
      .filter((s) => s.sport === 'strength')
      .map((s) => ({ planVersionId: p.id, plannedSessionId: s.id, state: 'absent' as const })),
  );
  const occurrence = c.routineActualManifest.occurrences[0];
  if (!occurrence) throw Error('fixture occurrence');
  const ref = domainPlanRefSchema.parse({
    domain: 'training',
    planId: plan,
    versionId: snapshot.id,
    itemId: 'strength',
  });
  occurrence.record.stepBindings = [{ stepId: 'step', plannedRef: ref }];
  c.sourcePermissionManifest.planned = [
    {
      requested: ref,
      state: historical ? 'historical' : 'current',
      reason: null,
      currentHead: { aggregate_id: plan, version_id: latest.id },
      content: { digest: impactDependencyDigest(snapshot.draft) },
      aggregateIdentity: immutable ? 'immutable_version' : 'current_head_association_only',
      ...(immutable ? { exactOwnedVersion: { aggregateId: plan, versionId: snapshot.id } } : {}),
    },
  ];
  return c;
}
it.each([
  { historical: false, immutable: true },
  { historical: true, immutable: true },
  { historical: false, immutable: false },
])(
  'validates exact training membership %j as readonly scope without approval or freshness claims',
  (options) => {
    const c = withTrainingRef(options.historical, options.immutable),
      before = structuredClone(c),
      result = inspect(c);
    if (result.status === 'blocked') expect(result.blockers).toEqual([]);
    expect(result.status).toBe('validated_read_scope');
    if (result.status === 'validated_read_scope') {
      expect(result.approvalAuthority).toBe('none');
      expect(result.freshness).toBe('not_checked');
      expect(result.remaining).toHaveLength(5);
    }
    expect(c.coverage).toEqual(before.coverage);
    expect(c.coverage.complete).toBe(false);
    expect(c.consumedSources.plans).toEqual(before.consumedSources.plans);
  },
);
it('rejects historical training fallback even when current aggregate matches', () => {
  blocked(withTrainingRef(true, false), 'source_membership_mismatch');
});
it.each([
  'head_aggregate',
  'head_version',
  'wrong_state',
  'digest',
  'session',
  'missing_body',
  'missing_tuple',
  'tuple_aggregate',
  'tuple_version',
  'extra_ref',
  'extra_body',
])('rejects immutable historical training %s mismatch', (kind) => {
  const c = withTrainingRef(true),
    entry = c.sourcePermissionManifest.planned[0];
  if (!entry) throw Error('fixture planned');
  if (kind === 'head_aggregate' && entry.currentHead) entry.currentHead.aggregate_id = race;
  if (kind === 'head_version' && entry.currentHead) entry.currentHead.version_id = version;
  if (kind === 'wrong_state') entry.state = 'current';
  if (kind === 'digest' && entry.content) entry.content.digest = '2'.repeat(64);
  if (kind === 'session') {
    entry.requested.itemId = 'wrong-session';
    const o = c.routineActualManifest.occurrences[0];
    if (!o) throw Error('fixture');
    o.record.stepBindings = [{ stepId: 'step', plannedRef: entry.requested }];
  }
  if (kind === 'missing_body')
    c.consumedSources.plans = c.consumedSources.plans.filter((p) => p.id !== version);
  if (kind === 'missing_tuple') delete entry.exactOwnedVersion;
  if (kind === 'tuple_aggregate' && entry.exactOwnedVersion)
    entry.exactOwnedVersion.aggregateId = race;
  if (kind === 'tuple_version' && entry.exactOwnedVersion)
    entry.exactOwnedVersion.versionId = generation;
  if (kind === 'extra_ref')
    c.sourcePermissionManifest.planned.push({
      ...entry,
      requested: { ...entry.requested, itemId: 'extra-session' },
    });
  if (kind === 'extra_body') {
    const source = c.consumedSources.plans[0];
    if (!source) throw Error('fixture');
    c.consumedSources.plans.push(planSnapshotSchema.parse({ ...source, id: race }));
  }
  blocked(
    c,
    kind === 'extra_ref'
      ? 'missing_source'
      : kind === 'extra_body'
        ? 'unsupported_consumed_channel'
        : 'source_membership_mismatch',
  );
});

// Actual internal producer shapes. No fixture is evidence of storage approval.
function nutritionSourcesFixture() {
  const c = fixture(),
    base = withNutritionRef();
  c.nutrition = structuredClone(base.nutrition);
  c.rosters.nutrition = structuredClone(base.rosters.nutrition);
  c.sourcePermissionManifest.nestedNutritionSources = structuredClone(
    base.sourcePermissionManifest.nestedNutritionSources,
  );
  const row = c.nutrition[0],
    nested = c.sourcePermissionManifest.nestedNutritionSources[0];
  if (!row || !nested) throw Error('nutrition fixture');
  return { c, row, nested };
}
function updateNutritionDigest(f: ReturnType<typeof nutritionSourcesFixture>) {
  if ('schemaVersion' in f.row.record) f.nested.recordDigest = impactDependencyDigest(f.row.record);
}
function foodSourceFixture(historical = false, absentHead = false) {
  const f = nutritionSourcesFixture();
  const datum = (unit: string, value: number | null) => ({
    value,
    unit,
    status: value === null ? 'unknown' : 'reported',
    evidenceIds: [],
  });
  const record = foodDefinitionVersionSchema.parse({
    foodId: '식품-ID',
    name: 'Saved food',
    basis: { kind: 'per_100g' },
    versionId: blueprintVersion,
    version: 1,
    previousVersionId: null,
    createdAt: now,
    nutrients: {
      energy: datum('kcal', 0),
      carbohydrate: datum('g', null),
      protein: datum('g', null),
      fat: datum('g', null),
      fluid: datum('mL', null),
      sodium: datum('mg', null),
    },
    provenance: {
      kind: 'package_label',
      reference: 'Synthetic label',
      capturedAt: now,
      reviewState: 'unreviewed',
    },
  });
  const provenance = {
    kind: record.provenance.kind,
    reviewState: record.provenance.reviewState,
    capturedAt: record.provenance.capturedAt,
    reference: {
      state: 'present' as const,
      digest: impactDependencyDigest(record.provenance.reference),
    },
  };
  const food = {
    requestedVersionId: record.versionId,
    state: historical ? 'historical' : 'current',
    content: {
      foodId: record.foodId,
      versionId: record.versionId,
      record,
      digest: impactDependencyDigest(record),
      provenance,
    },
    currentHead: absentHead
      ? { state: 'absent' as const }
      : { versionId: historical ? generation : record.versionId, provenance },
  };
  const item = f.row.record.items[0];
  if (!item) throw Error('item');
  f.row.record = nutritionPlanVersionCompatibleV4Schema.parse({
    ...f.row.record,
    items: [
      {
        ...item,
        foods: [
          {
            foodVersionId: record.versionId,
            description: 'Zero',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'per_100g',
          },
          {
            foodVersionId: null,
            description: 'Unknown',
            quantity: null,
            unit: 'unspecified',
            sourceBasis: 'unknown',
          },
        ],
      },
    ],
  });
  f.nested.foods = [food];
  return { ...f, food };
}
it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'validates exact food body/digest and distinct current head historical=%s absent=%s',
  (historical, absentHead) => {
    const f = foodSourceFixture(historical, absentHead),
      before = structuredClone(f.row.record);
    expect(inspect(f.c).status).toBe('validated_read_scope');
    expect(f.row.record).toEqual(before);
    expect(f.row.record.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
  },
);
it.each([
  'version',
  'food_id',
  'body',
  'digest',
  'provenance',
  'current_state',
  'missing',
  'duplicate',
  'extra',
  'descriptor_only',
  'unknown_key',
])('rejects food source %s forgery without recalculating saved portions', (kind) => {
  const f = foodSourceFixture();
  if (kind === 'version') f.food.content.versionId = generation;
  if (kind === 'food_id') f.food.content.foodId = 'wrong';
  if (kind === 'body') f.food.content.record.name = 'mutated';
  if (kind === 'digest') f.food.content.digest = '2'.repeat(64);
  if (kind === 'provenance') f.food.content.provenance.reviewState = 'reviewed';
  if (kind === 'current_state') f.food.state = 'historical';
  if (kind === 'missing') f.nested.foods = [];
  else if (kind === 'duplicate') f.nested.foods = [f.food, f.food];
  else if (kind === 'extra')
    f.nested.foods = [f.food, { ...f.food, requestedVersionId: generation }];
  else if (kind === 'descriptor_only') {
    const { record: omitted, ...content } = f.food.content;
    void omitted;
    f.nested.foods = [{ ...f.food, content }];
  } else if (kind === 'unknown_key') f.nested.foods = [{ ...f.food, inventedAuthority: true }];
  else f.nested.foods = [f.food];
  expect(inspect(f.c).status).toBe('blocked');
});
function linkedNutritionFixture(historical = false, session = false) {
  const f = nutritionSourcesFixture(),
    snapshot = withSupplementary().currentTraining?.snapshot;
  if (!snapshot) throw Error('training snapshot');
  const linked = planSnapshotSchema.parse({ ...snapshot, id: scheduleVersion });
  const current = historical
    ? planSnapshotSchema.parse({ ...linked, id: generation, version: 2 })
    : linked;
  f.c.currentTraining = { aggregateId: blueprintId, snapshot: current };
  f.c.coreDependencies.trainingPlan = { kind: 'exists', versionId: current.id };
  f.c.consumedSources.plans = historical ? [linked, current] : [linked];
  f.c.supplementaryManifest.sessions = f.c.consumedSources.plans.flatMap((p) =>
    p.draft.sessions
      .filter((s) => s.sport === 'strength')
      .map((s) => ({ planVersionId: p.id, plannedSessionId: s.id, state: 'absent' as const })),
  );
  f.row.record = nutritionPlanVersionCompatibleV4Schema.parse({
    ...f.row.record,
    linkedTrainingPlanVersionId: linked.id,
    items: f.row.record.items.map((item) => ({
      ...item,
      ...(session
        ? {
            anchor: {
              kind: 'relative',
              entity: 'session',
              entityId: 'strength',
              point: 'end',
              offsetMinutes: 20,
            },
          }
        : {}),
    })),
  });
  f.row.sourceRelation = historical ? 'historical' : 'current';
  f.nested.linkedPlan = {
    state: f.row.sourceRelation,
    requestedVersionId: linked.id,
    content: { digest: impactDependencyDigest(linked) },
    currentHead: { aggregate_id: blueprintId, version_id: current.id },
  };
  if (session) {
    const item = f.row.record.items[0];
    if (!item) throw Error('item');
    f.nested.anchors = [
      {
        itemId: item.id,
        anchor: item.anchor,
        source: { state: 'owned', planVersionId: linked.id },
      },
    ];
    f.row.relativeItems = [
      {
        itemId: item.id,
        entity: 'session',
        entityId: 'strength',
        sourceVersionId: linked.id,
        affected: false,
        point: 'end',
        timing: 'not_resolved',
      },
    ];
  }
  return { ...f, linked };
}
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('validates exact consumed linked plan historical=%s session=%s', (historical, session) => {
  const f = linkedNutritionFixture(historical, session),
    before = structuredClone(f.row.record),
    result = inspect(f.c);
  expect(result.status).toBe('validated_read_scope');
  expect(f.row.record).toEqual(before);
  if (result.status === 'validated_read_scope') {
    expect(result.approvalAuthority).toBe('none');
    expect(result.freshness).toBe('not_checked');
    expect(result.remaining).toHaveLength(5);
  }
});
it.each([
  'missing_body',
  'body_digest',
  'wrong_head',
  'wrong_relation',
  'session_id',
  'anchor_offset',
  'source_plan',
  'extra_anchor',
  'extra_relative',
])('rejects linked/session source %s mismatch', (kind) => {
  const f = linkedNutritionFixture(true, true),
    item = f.row.record.items[0];
  if (!item) throw Error('item');
  if (kind === 'missing_body')
    f.c.consumedSources.plans = f.c.consumedSources.plans.filter((p) => p.id !== f.linked.id);
  if (kind === 'body_digest')
    f.nested.linkedPlan = {
      state: 'historical',
      requestedVersionId: f.linked.id,
      content: { digest: hash },
      currentHead: { aggregate_id: blueprintId, version_id: generation },
    };
  if (kind === 'wrong_head')
    f.nested.linkedPlan = {
      state: 'historical',
      requestedVersionId: f.linked.id,
      content: { digest: impactDependencyDigest(f.linked) },
      currentHead: { aggregate_id: plan, version_id: generation },
    };
  if (kind === 'wrong_relation') f.row.sourceRelation = 'current';
  if (kind === 'session_id')
    f.row.relativeItems = [
      {
        itemId: item.id,
        entity: 'session',
        entityId: 'wrong',
        sourceVersionId: f.linked.id,
        affected: false,
        point: 'end',
        timing: 'not_resolved',
      },
    ];
  if (kind === 'anchor_offset' && item.anchor.kind === 'relative')
    f.nested.anchors = [
      {
        itemId: item.id,
        anchor: { ...item.anchor, offsetMinutes: 21 },
        source: { state: 'owned', planVersionId: f.linked.id },
      },
    ];
  if (kind === 'source_plan')
    f.nested.anchors = [
      {
        itemId: item.id,
        anchor: item.anchor,
        source: { state: 'owned', planVersionId: generation },
      },
    ];
  if (kind === 'extra_anchor') f.nested.anchors.push(...structuredClone(f.nested.anchors));
  if (kind === 'extra_relative') f.row.relativeItems.push(...structuredClone(f.row.relativeItems));
  expect(inspect(f.c).status).toBe('blocked');
});
function raceNutritionFixture(
  schemaVersion: 1 | 2 | 3 | 4,
  otherRace = false,
  disconnected = false,
) {
  const f = nutritionSourcesFixture(),
    item = f.row.record.items[0];
  if (!item) throw Error('item');
  const live = otherRace
    ? raceEventSchema.parse({ ...f.c.event, id: scheduleId, revision: 7 })
    : f.c.event;
  f.c.consumedSources.races = otherRace ? [f.c.event, live] : [live];
  const pin = {
    pinVersion: 1,
    namespace: 'race-event-revision',
    eventId: live.id,
    eventRevision: 3,
    sourceDigestVersion: 'race-event-values-canonical-v1',
    sourceDigest: hash,
    localDate: '2026-10-07',
    localStartTime: null,
    timezone: 'Asia/Seoul',
    start: { state: 'unknown', reason: 'start_time_not_recorded' },
    end: { state: 'unknown', reason: 'race_end_not_recorded' },
  };
  f.row.record = nutritionPlanVersionCompatibleV4Schema.parse({
    ...f.row.record,
    ...(schemaVersion === 1
      ? {}
      : {
          schemaVersion,
          raceTimingPins: disconnected ? [] : [pin],
          itemRaceTimingBindings: disconnected
            ? []
            : [
                {
                  itemId: item.id,
                  binding: { state: 'captured', eventId: live.id, eventRevision: 3 },
                },
              ],
        }),
    items: [
      {
        ...item,
        anchor: disconnected
          ? { kind: 'disconnected', entity: 'race' }
          : {
              kind: 'relative',
              entity: 'race',
              entityId: live.id,
              point: 'start',
              offsetMinutes: -30,
            },
        foods: [
          {
            foodVersionId: null,
            description: 'Zero',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
          {
            foodVersionId: null,
            description: 'Unknown',
            quantity: null,
            unit: 'unspecified',
            sourceBasis: 'unknown',
          },
        ],
      },
    ],
  });
  updateNutritionDigest(f);
  if (disconnected) f.c.consumedSources.races = [f.c.event];
  else {
    const active = f.row.record.items[0];
    if (!active) throw Error('item');
    f.nested.anchors = [
      {
        itemId: active.id,
        anchor: active.anchor,
        source: {
          requestedId: live.id,
          state: 'current',
          revision: live.revision,
          content: { digest: impactDependencyDigest(live) },
        },
      },
    ];
    f.row.relativeItems = [
      {
        itemId: active.id,
        entity: 'race',
        entityId: live.id,
        sourceVersionId: null,
        affected: !otherRace,
        point: 'start',
        timing: 'not_resolved',
        sourceRaceRevision: live.revision,
        sourceRaceDigest: impactDependencyDigest(live),
      },
    ];
    f.c.affected.nutrition = otherRace ? [] : [plan];
  }
  return f;
}
it.each([1, 2, 3, 4] as const)(
  'validates V%s affected unresolved race source without blending historical pin/current facts',
  (v) => {
    const f = raceNutritionFixture(v),
      body = structuredClone(f.row.record),
      result = inspect(f.c);
    expect(result.status).toBe('validated_read_scope');
    expect(f.row.record).toEqual(body);
    expect(f.row.relativeItems[0]).toMatchObject({
      timing: 'not_resolved',
      affected: true,
      sourceRaceRevision: 1,
    });
    if ('raceTimingPins' in f.row.record)
      expect(f.row.record.raceTimingPins[0]?.eventRevision).toBe(3);
    if (result.status === 'validated_read_scope') {
      expect(result.approvalAuthority).toBe('none');
      expect(result.freshness).toBe('not_checked');
    }
  },
);
it('validates unrelated owned live race source and preserves frozen source revision', () => {
  expect(inspect(raceNutritionFixture(4, true).c).status).toBe('validated_read_scope');
});
it.each([3, 4] as const)(
  'validates disconnected V%s with no consumed deleted source/timing restore and retains zero/null',
  (v) => {
    const f = raceNutritionFixture(v, false, true),
      body = structuredClone(f.row.record);
    expect(inspect(f.c).status).toBe('validated_read_scope');
    expect(f.row.record).toEqual(body);
    expect(f.nested.anchors).toEqual([]);
    expect(f.row.relativeItems).toEqual([]);
    expect(f.row.record.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
  },
);
it.each([
  'live_digest',
  'saved_as_current',
  'affected_roster',
  'missing_anchor',
  'deleted',
  'extra_source',
  'disconnected_source',
])('rejects race source %s mismatch', (kind) => {
  const f = raceNutritionFixture(4, false, kind === 'disconnected_source');
  const item = f.row.record.items[0];
  if (!item) throw Error('item');
  if (kind === 'live_digest')
    f.row.relativeItems = [
      {
        itemId: item.id,
        entity: 'race',
        entityId: race,
        sourceVersionId: null,
        affected: true,
        point: 'start',
        timing: 'not_resolved',
        sourceRaceRevision: 1,
        sourceRaceDigest: hash,
      },
    ];
  if (kind === 'saved_as_current')
    f.nested.anchors = [
      {
        itemId: item.id,
        anchor: item.anchor,
        source: { requestedId: race, state: 'current', revision: 3, content: { digest: hash } },
      },
    ];
  if (kind === 'affected_roster') f.c.affected.nutrition = [];
  if (kind === 'missing_anchor') f.nested.anchors = [];
  if (kind === 'deleted')
    f.nested.anchors = [
      {
        itemId: item.id,
        anchor: item.anchor,
        source: { requestedId: race, state: 'deleted', revision: 2, content: null },
      },
    ];
  if (kind === 'extra_source')
    f.c.consumedSources.races.push(raceEventSchema.parse({ ...f.c.event, id: generation }));
  if (kind === 'disconnected_source')
    f.nested.anchors = [
      {
        itemId: item.id,
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: race,
          point: 'start',
          offsetMinutes: -30,
        },
        source: {
          requestedId: race,
          state: 'current',
          revision: 1,
          content: { digest: impactDependencyDigest(f.c.event) },
        },
      },
    ];
  expect(inspect(f.c).status).toBe('blocked');
});

it.each([2, 4] as const)(
  'retains explicit V%s legacy-unpinned source without fabricating a before pin',
  (schemaVersion) => {
    const f = raceNutritionFixture(schemaVersion),
      item = f.row.record.items[0];
    if (!item || item.anchor.kind !== 'relative') throw Error('relative item');
    f.row.record = nutritionPlanVersionCompatibleV4Schema.parse({
      ...f.row.record,
      raceTimingPins: [],
      itemRaceTimingBindings: [
        {
          itemId: item.id,
          binding: {
            state: 'legacy_unpinned',
            priorNutritionVersionId: generation,
            priorItemId: item.id,
            priorAnchorDigest: impactDependencyDigest(item.anchor),
          },
        },
      ],
    });
    updateNutritionDigest(f);
    const body = structuredClone(f.row.record),
      result = inspect(f.c);
    expect(result.status).toBe('validated_read_scope');
    expect(f.row.record).toEqual(body);
    expect(f.row.relativeItems[0]).toMatchObject({ timing: 'not_resolved', affected: true });
    if (result.status === 'validated_read_scope') expect(result.approvalAuthority).toBe('none');
  },
);
it.each(['extra_nested', 'nested_digest', 'unknown_anchor_key', 'disconnected_unknown_source'])(
  'rejects nested source %s while keeping the original food/timing body',
  (kind) => {
    const f = raceNutritionFixture(4, false, kind === 'disconnected_unknown_source');
    const body = structuredClone(f.row.record);
    if (kind === 'extra_nested')
      f.c.sourcePermissionManifest.nestedNutritionSources.push({
        ...f.nested,
        versionId: generation,
      });
    if (kind === 'nested_digest') f.nested.recordDigest = '2'.repeat(64);
    if (kind === 'unknown_anchor_key') {
      const item = f.row.record.items[0];
      if (!item) throw Error('item');
      f.nested.anchors = [
        {
          itemId: item.id,
          anchor: item.anchor,
          source: {
            requestedId: race,
            state: 'current',
            revision: 1,
            content: { digest: impactDependencyDigest(f.c.event) },
            approved: true,
          },
        },
      ];
    }
    if (kind === 'disconnected_unknown_source')
      f.row.relativeItems = [
        {
          itemId: 'item-영양',
          entity: 'race',
          entityId: race,
          sourceVersionId: null,
          affected: false,
          point: 'start',
          timing: 'not_resolved',
          sourceRaceRevision: 1,
          sourceRaceDigest: impactDependencyDigest(f.c.event),
        },
      ];
    expect(inspect(f.c).status).toBe('blocked');
    expect(f.row.record).toEqual(body);
  },
);

it('rejects an explicitly supplied wrong legacy V1 record digest without requiring a fabricated V1 digest', () => {
  const f = nutritionSourcesFixture();
  expect(inspect(f.c).status).toBe('validated_read_scope');
  f.nested.recordDigest = '2'.repeat(64);
  blocked(f.c, 'digest_mismatch');
});

function withRecovery(methodUsed = true) {
  const c = fixture();
  const method = recoveryMethodVersionSchema.parse({
    schemaVersion: 1,
    methodId: plan,
    versionId: version,
    version: 1,
    title: 'Synthetic method',
    category: 'relaxation',
    intendedUse: 'User action',
    applicability: [],
    cautions: [],
    sourceDescription: '',
    evidenceLimitations: 'Unreviewed',
    reviewState: 'unreviewed',
    reviewedAt: null,
    source: 'user_recorded',
    createdAt: now,
  });
  const record = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: scheduleId,
    versionId: scheduleVersion,
    version: 1,
    previousVersionId: null,
    status: 'user_confirmed',
    selectedOptionId: race,
    createdAt: now,
    draft: {
      title: 'Recovery',
      goal: '',
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        {
          id: race,
          title: 'Rest',
          kind: methodUsed ? 'nonexercise_action' : 'full_rest',
          methodVersionId: methodUsed ? version : null,
          explanation: '',
        },
      ],
      reassessment: [
        {
          id: blueprintId,
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Review change',
          policyVersion: null,
        },
      ],
    },
  });
  c.rosters.recovery.push({ aggregateId: record.strategyId, versionId: record.versionId });
  c.recovery.push({ aggregateId: record.strategyId, versionId: record.versionId, record });
  const request = {
    kind: 'recovery_method',
    ref: { id: method.methodId, versionId: method.versionId },
  };
  const facts = recoverySourceFactsSchema.parse({
    methodCatalogRequests: methodUsed ? [request] : [],
    methods: methodUsed ? [method] : [],
    methodFacts: methodUsed
      ? [
          {
            requested: request,
            state: 'current',
            reason: null,
            content: { digest: impactDependencyDigest(method) },
            currentHead: { aggregate_id: method.methodId, version_id: method.versionId },
            provenance: {
              source: method.source,
              reviewState: method.reviewState,
              reviewedAt: null,
            },
          },
        ]
      : [],
    trainingAssociations: [],
    nutritionReferences: [],
    unavailable: [],
    authority: 'none',
    freshness: 'not_checked',
  });
  c.sourcePermissionManifest.catalog.push(...structuredClone(facts.methodFacts));
  return { ...c, recoverySources: facts };
}
it('admits actual closed recovery read scope with exact method body/catalog and retains complete:false', () => {
  const c = withRecovery();
  const result = inspect(c);
  expect(result.status).toBe('validated_read_scope');
  expect(c.coverage.complete).toBe(false);
  if (result.status === 'validated_read_scope') {
    expect(result.approvalAuthority).toBe('none');
    expect(result.freshness).toBe('not_checked');
    expect(result.remaining.length).toBeGreaterThan(0);
  }
});
it('admits old capture with full-rest recovery and no consumed method port', () => {
  const c = withRecovery(false);
  const { recoverySources, ...legacy } = c;
  void recoverySources;
  expect(inspect(legacy).status).toBe('validated_read_scope');
});
it('blocks legacy capture with consumed method rather than blanket rejecting recovery', () => {
  const c = withRecovery();
  const { recoverySources, ...legacy } = c;
  void recoverySources;
  blocked(legacy, 'method_source_missing');
});
it('preserves explicit missing owned method diagnostic without invented method id', () => {
  const c = withRecovery();
  c.recoverySources.methods = [];
  c.recoverySources.methodFacts = [];
  c.recoverySources.methodCatalogRequests = [];
  c.sourcePermissionManifest.catalog = [];
  c.recoverySources.unavailable = [
    { kind: 'method', requestedVersionId: version, reason: 'owned_method_unavailable' },
  ];
  blocked(c, 'method_unavailable', `recoverySources.method:${version}`);
});
it('rejects actual method DTO digest mismatch even with matching catalog request roster', () => {
  const c = withRecovery();
  const method = c.recoverySources.methods[0];
  if (!method) throw Error('fixture');
  method.title = 'Changed';
  blocked(c, 'method_source_mismatch');
});
it('preserves historical exact method despite absent current head', () => {
  const c = withRecovery();
  const fact = c.recoverySources.methodFacts[0];
  if (!fact) throw Error('fixture');
  fact.state = 'historical';
  fact.currentHead = null;
  c.sourcePermissionManifest.catalog = [structuredClone(fact)];
  expect(inspect(c).status).toBe('validated_read_scope');
});
it('rejects methodFacts copy divergence from main permission manifest', () => {
  const c = withRecovery();
  const fact = c.recoverySources.methodFacts[0];
  if (!fact) throw Error('fixture');
  fact.content.digest = '0'.repeat(64);
  blocked(c, 'source_identity_mismatch', 'recoverySources.methodFacts');
});
it('rejects duplicated method catalog requests rather than silently deduplicating source evidence', () => {
  const c = withRecovery();
  const request = c.recoverySources.methodCatalogRequests[0];
  if (!request) throw Error('fixture');
  c.recoverySources.methodCatalogRequests.push(structuredClone(request));
  blocked(c, 'source_identity_mismatch', 'recoverySources.methodCatalogRequests');
});
it('rejects fabricated extra method source provenance in empty consumed recovery', () => {
  const c = withRecovery(false),
    extra = withRecovery();
  c.recoverySources.methods = extra.recoverySources.methods;
  blocked(c, 'source_identity_mismatch', 'recoverySources');
});
it('does not close actual recovery observations with method evidence alone', () => {
  const c = withRecovery();
  const row = c.recovery[0];
  const decoded = z
    .strictObject({
      aggregateId: z.uuid(),
      versionId: z.uuid(),
      record: recoveryStrategyVersionSchema,
    })
    .parse(row);
  decoded.record.draft.observations = [{ kind: 'activity', id: 'actual-source', revision: 1 }];
  c.recovery = [decoded];
  blocked(c, 'observation_source_port_missing');
});
it('rejects unknown recoverySources authority claims', () => {
  const c = withRecovery();
  expect(
    validateRaceImpactConsumedManifest(
      { ...c, recoverySources: { ...c.recoverySources, approved: true } },
      sign(c),
    ).status,
  ).toBe('blocked');
});
it('requires exact recovery roster membership instead of rejecting every roster', () => {
  const c = withRecovery();
  c.rosters.recovery = [{ aggregateId: race, versionId: scheduleVersion }];
  blocked(c, 'inventory_mismatch');
});

function recoveryPlanRef(kind: 'training' | 'nutrition') {
  const r = withRecovery(false),
    base = kind === 'training' ? withSupplementary() : withNutritionRef();
  const c = { ...base, recoverySources: r.recoverySources };
  c.recovery = r.recovery;
  c.rosters.recovery = r.rosters.recovery;
  const row = z
    .strictObject({
      aggregateId: z.uuid(),
      versionId: z.uuid(),
      record: recoveryStrategyVersionSchema,
    })
    .parse(c.recovery[0]);
  const versionId = kind === 'training' ? c.currentTraining?.snapshot.id : version;
  if (!versionId) throw Error('fixture');
  row.record.draft.planRefs = [{ kind, aggregateId: plan, headVersionId: versionId }];
  c.recovery = [row];
  if (kind === 'training')
    c.recoverySources.trainingAssociations = [{ aggregateId: plan, versionId }];
  else c.recoverySources.nutritionReferences = [{ aggregateId: plan, versionId }];
  return c;
}
it('admits recovery-linked training only with actual immutable association and consumed body', () => {
  expect(inspect(recoveryPlanRef('training')).status).toBe('validated_read_scope');
});
it('blocks explicit unavailable training source diagnostics without current-head inference', () => {
  const c = recoveryPlanRef('training');
  const assoc = c.recoverySources.trainingAssociations[0];
  if (!assoc) throw Error('fixture');
  c.recoverySources.trainingAssociations = [];
  c.recoverySources.unavailable = [
    { kind: 'training', requested: assoc, reason: 'aggregate_identity_unavailable' },
  ];
  blocked(c, 'training_association_missing');
});
it('admits current recovery nutrition tuple and blocks a missing historical nutrition body specifically', () => {
  const c = recoveryPlanRef('nutrition');
  expect(inspect(c).status).toBe('validated_read_scope');
  const row = z
    .strictObject({
      aggregateId: z.uuid(),
      versionId: z.uuid(),
      record: recoveryStrategyVersionSchema,
    })
    .parse(c.recovery[0]);
  row.record.draft.planRefs = [{ kind: 'nutrition', aggregateId: plan, headVersionId: race }];
  c.recovery = [row];
  c.recoverySources.nutritionReferences = [{ aggregateId: plan, versionId: race }];
  blocked(c, 'nutrition_source_missing');
});
it('rejects copied nutrition ref metadata unrelated to actual consumed recovery tuples', () => {
  const c = withRecovery(false);
  c.recoverySources.nutritionReferences = [{ aggregateId: plan, versionId: race }];
  blocked(c, 'source_identity_mismatch', 'recoverySources');
});

function recoveryHistoricalNutritionFixture(racePins = false, linked = false) {
  const f = linked
    ? linkedNutritionFixture(true, true)
    : racePins
      ? raceNutritionFixture(4, true)
      : foodSourceFixture(true);
  const r = withRecovery(false);
  const historicalId = 'abcdefab-1234-4234-8234-123456789abc';
  const historical = nutritionPlanVersionCompatibleV4Schema.parse({
    ...f.row.record,
    versionId: historicalId,
    items: f.row.record.items.map((item) => ({ ...item, planVersionId: historicalId })),
  });
  f.row.record = nutritionPlanVersionCompatibleV4Schema.parse({
    ...f.row.record,
    version: 2,
    previousVersionId: historicalId,
  });
  updateNutritionDigest(f);
  const historicalNested = structuredClone({ ...f.nested, versionId: historicalId });
  if ('schemaVersion' in historical)
    historicalNested.recordDigest = impactDependencyDigest(historical);
  const recovery = z
    .strictObject({
      aggregateId: z.uuid(),
      versionId: z.uuid(),
      record: recoveryStrategyVersionSchema,
    })
    .parse(r.recovery[0]);
  recovery.record.draft.planRefs = [
    { kind: 'nutrition', aggregateId: plan, headVersionId: historicalId },
  ];
  const fact = {
    requested: { aggregateId: plan, versionId: historicalId },
    state: 'historical',
    reason: null,
    content: { digest: impactDependencyDigest(historical) },
    currentHead: { aggregateId: plan, versionId: version },
  };
  const c = {
    ...f.c,
    recovery: [recovery],
    rosters: { ...f.c.rosters, recovery: r.rosters.recovery },
    recoverySources: { ...r.recoverySources, nutritionReferences: [fact.requested] },
    recoveryNutritionSources: {
      records: [historical],
      facts: [fact],
      nestedSources: {
        nutrition: [historicalNested],
        loadedPlans: z
          .array(planSnapshotSchema)
          .parse(
            linked
              ? f.c.consumedSources.plans.filter(
                  (p) => p.id === historical.linkedTrainingPlanVersionId,
                )
              : [],
          ),
      },
      authority: 'none',
      freshness: 'not_checked',
    },
  };
  return { c, historical, historicalNested, fact };
}
it.each([false, true])(
  'validates historical recovery nutrition exact food/pin sources without adding impact targets pins=%s',
  (pins) => {
    const f = recoveryHistoricalNutritionFixture(pins),
      before = structuredClone(f.c.nutrition),
      oldAffected = structuredClone(f.c.affected);
    expect(inspect(f.c).status).toBe('validated_read_scope');
    expect(f.c.nutrition).toEqual(before);
    expect(f.c.affected).toEqual(oldAffected);
    expect(f.c.recoveryNutritionSources.records).toEqual([f.historical]);
  },
);
it.each([
  'foreign_tuple',
  'digest',
  'missing_extra',
  'unused_extra',
  'head',
  'nested_digest',
  'missing_food',
  'duplicate_fact',
  'unknown_metadata',
  'missing_race_source',
])('rejects recovery historical nutrition mismatch %s', (kind) => {
  const f = recoveryHistoricalNutritionFixture(kind === 'missing_race_source');
  if (kind === 'foreign_tuple') f.fact.requested.aggregateId = generation;
  if (kind === 'digest') f.fact.content.digest = '2'.repeat(64);
  if (kind === 'missing_extra') f.c.recoveryNutritionSources.records = [];
  if (kind === 'unused_extra')
    f.c.recoveryNutritionSources.records.push(
      nutritionPlanVersionCompatibleV4Schema.parse({
        ...f.historical,
        versionId: generation,
        items: f.historical.items.map((item) => ({ ...item, planVersionId: generation })),
      }),
    );
  if (kind === 'head') f.fact.currentHead.versionId = generation;
  if (kind === 'nested_digest') f.historicalNested.recordDigest = '2'.repeat(64);
  if (kind === 'missing_food') f.historicalNested.foods = [];
  if (kind === 'duplicate_fact') f.c.recoveryNutritionSources.facts.push(structuredClone(f.fact));
  if (kind === 'unknown_metadata')
    return expect(
      validateRaceImpactConsumedManifest(
        { ...f.c, recoveryNutritionSources: { ...f.c.recoveryNutritionSources, verified: true } },
        sign(f.c),
      ).status,
    ).toBe('blocked');
  if (kind === 'missing_race_source') f.c.consumedSources.races = [f.c.event];
  expect(inspect(f.c).status).toBe('blocked');
});
it('requires current duplicate tuple body, nested facts and head to agree with current captured nutrition', () => {
  const r = recoveryPlanRef('nutrition'),
    record = r.nutrition[0]?.record,
    nested = r.sourcePermissionManifest.nestedNutritionSources[0];
  if (!record || !nested) throw Error('fixture');
  const c = {
    ...r,
    recoveryNutritionSources: {
      records: [structuredClone(record)],
      facts: [
        {
          requested: { aggregateId: plan, versionId: version },
          state: 'current',
          reason: null,
          content: { digest: impactDependencyDigest(record) },
          currentHead: { aggregateId: plan, versionId: version },
        },
      ],
      nestedSources: { nutrition: [structuredClone(nested)], loadedPlans: [] },
      authority: 'none',
      freshness: 'not_checked',
    },
  };
  expect(inspect(c).status).toBe('validated_read_scope');
  c.recoveryNutritionSources.records[0] = nutritionPlanVersionCompatibleV4Schema.parse({
    ...record,
    purpose: 'Contradicting copy',
  });
  const fact = c.recoveryNutritionSources.facts[0];
  if (!fact) throw Error('fixture');
  fact.content.digest = impactDependencyDigest(c.recoveryNutritionSources.records[0]);
  expect(inspect(c).status).toBe('blocked');
});

it('validates exact historical linked snapshot/session membership and rejects altered or missing loaded copy', () => {
  const f = recoveryHistoricalNutritionFixture(false, true);
  expect(inspect(f.c).status).toBe('validated_read_scope');
  const loaded = f.c.recoveryNutritionSources.nestedSources.loadedPlans[0];
  if (!loaded) throw Error('linked fixture');
  loaded.draft.title = 'Changed source copy';
  expect(inspect(f.c).status).toBe('blocked');
  f.c.recoveryNutritionSources.nestedSources.loadedPlans = [];
  expect(inspect(f.c).status).toBe('blocked');
});
it('rejects unavailable fact with injected protected body and malformed saved race pin identity', () => {
  const f = recoveryHistoricalNutritionFixture(true);
  const unavailable = {
    ...f.c,
    recoveryNutritionSources: {
      ...f.c.recoveryNutritionSources,
      facts: [
        {
          ...f.fact,
          state: 'unavailable',
          reason: 'owned_version_unavailable',
          content: null,
          currentHead: null,
        },
      ],
    },
  };
  expect(inspect(unavailable).status).toBe('blocked');
  const malformed = {
    ...f.c,
    recoveryNutritionSources: {
      ...f.c.recoveryNutritionSources,
      records: [{ ...f.historical, raceTimingPins: [{ eventId: 'foreign' }] }],
    },
  };
  expect(inspect(malformed).status).toBe('blocked');
});

function withReadRun(performed = false, planned = false) {
  const c = planned ? withNutritionRef() : fixture();
  if (!planned) {
    const record = routineBlueprintVersionSchema.parse({
      schemaVersion: 4,
      routineId: blueprintId,
      versionId: blueprintVersion,
      title: 'Read checklist',
      intent: 'User facts',
      status: 'published',
      tags: [],
      steps: [
        {
          id: 'step',
          title: 'Review',
          content: { kind: 'checklist', prompt: 'Review' },
          timing: { kind: 'user_scheduled' },
          required: true,
          choiceGroupId: null,
        },
      ],
      choiceGroups: [],
      estimatedDurationSeconds: null,
      createdAt: now,
    });
    c.routineActualManifest.blueprints = [
      {
        record,
        version: 1,
        currentHead: {
          state: 'present',
          versionId: blueprintVersion,
          version: 1,
          visibility: 'active',
          favorite: false,
        },
        unsupportedContent: [],
      },
    ];
    c.routineActualManifest.uniqueSourceCount = 1;
  }
  const ref = { kind: 'checklist_confirmation', id: race, revisionId: generation };
  const run = routineRunSchema.parse({
    id: plan,
    revision: performed ? 1 : 0,
    blueprint: { id: blueprintId, versionId: blueprintVersion },
    origin: planned ? { kind: 'planned', occurrenceId: 'occurrence' } : { kind: 'unplanned' },
    state: 'in_progress',
    progress: performed
      ? [
          {
            stepId: 'step',
            revision: 1,
            state: 'performed',
            actualRefs: [ref],
            occurredAt: now,
            recordedAt: now,
            reason: null,
          },
        ]
      : [],
    selectedChoices: {},
    startedAt: now,
    endedAt: null,
  });
  c.routineActualManifest.runs = [
    {
      record: run,
      historyDigest: impactDependencyDigest(run),
      actuals: performed
        ? [
            {
              stepId: 'step',
              fact: {
                requested: ref,
                state: 'current',
                reason: null,
                current: { id: race, revisionId: generation },
                content: {
                  id: race,
                  run_id: plan,
                  step_id: 'step',
                  revision_id: generation,
                  occurred_at: now,
                  state: 'performed',
                },
              },
            },
          ]
        : [],
    },
  ];
  if (performed) c.routineActualManifest.uniqueSourceCount++;
  if (planned) {
    const occurrence = c.routineActualManifest.occurrences[0];
    if (!occurrence) throw Error('fixture');
    occurrence.startedRun = { state: 'present', runId: plan, revision: run.revision };
  }
  return {
    ...c,
    routineTimerReads: [{ run, timers: [] }].map((row) => routineRunReadSchema.parse(row)),
  };
}
it('admits genuine initial publicrun revision0 readonly facts and exact empty timer inventory', () => {
  const c = withReadRun();
  expect(inspect(c).status).toBe('validated_read_scope');
  expect(c.coverage.complete).toBe(false);
});
it('admits current checklist confirmation exactrun step/revision without performance authority', () => {
  const c = withReadRun(true);
  const result = inspect(c);
  expect(result.status).toBe('validated_read_scope');
  if (result.status === 'validated_read_scope') {
    expect(result.approvalAuthority).toBe('none');
    expect(result.freshness).toBe('not_checked');
    expect(result.remaining).toHaveLength(5);
  }
});
it('admits planned startedrun revision0 only after exactoccurrence andfrozenrefs checks', () => {
  const c = withReadRun(false, true);
  expect(inspect(c).status).toBe('validated_read_scope');
});
it('blocks missing actualtimer inventory specifically rather than inferringempty', () => {
  const c = withReadRun();
  const { routineTimerReads, ...old } = c;
  void routineTimerReads;
  blocked(old, 'timer_inventory_missing');
});
it('blocks checklist fact missing from actual run withoutsynthetic actualsubstitution', () => {
  const c = withReadRun(true);
  const run = c.routineActualManifest.runs[0];
  const parsed = z
    .strictObject({
      record: routineRunSchema,
      historyDigest: z.string(),
      actuals: z.array(z.json()),
    })
    .parse(run);
  parsed.actuals = [];
  c.routineActualManifest.runs = [parsed];
  blocked(c, 'actual_membership_mismatch');
});
it('blocks current revision history mismatch specifically', () => {
  const c = withReadRun();
  const row = c.routineActualManifest.runs[0];
  const parsed = z
    .strictObject({
      record: routineRunSchema,
      historyDigest: z.string(),
      actuals: z.array(z.json()),
    })
    .parse(row);
  parsed.historyDigest = '0'.repeat(64);
  c.routineActualManifest.runs = [parsed];
  blocked(c, 'history_mismatch');
});
it('rejects canonicaluniqueSourceCount missing cached checklist actual', () => {
  const c = withReadRun(true);
  c.routineActualManifest.uniqueSourceCount = 1;
  blocked(c, 'source_identity_mismatch');
});
it('rejects planned startedrun association substitution evenwith correctrun body', () => {
  const c = withReadRun(false, true);
  const occurrence = c.routineActualManifest.occurrences[0];
  if (!occurrence) throw Error('fixture');
  occurrence.startedRun = { state: 'present', runId: race, revision: 0 };
  blocked(c, 'source_identity_mismatch');
});
it('keeps actualrunningtimer a readfact and creates no additional activity', () => {
  const c = withReadRun();
  const read = c.routineTimerReads[0];
  if (!read) throw Error('fixture');
  read.timers = [
    {
      runId: plan,
      stepId: 'step',
      revision: 1,
      state: 'running',
      durationSeconds: 30,
      startedAt: now,
      pausedAt: null,
      pausedMilliseconds: 0,
    },
  ];
  expect(inspect(c).status).toBe('validated_read_scope');
  expect(c.routineActualManifest.actualRosters.activities).toEqual([]);
});
it('rejects stale timer DTO instead of repinning it to latestrun', () => {
  const c = withReadRun();
  const read = c.routineTimerReads[0];
  if (!read) throw Error('fixture');
  read.run = { ...read.run, revision: 1 };
  blocked(c, 'timer_source_mismatch');
});
it('enforces combined typedtimer visits before admitting a5001row inventory', () => {
  const c = withReadRun();
  const read = c.routineTimerReads[0];
  if (!read) throw Error('fixture');
  read.timers = Array.from({ length: 5001 }, () => ({
    runId: plan,
    stepId: 'step',
    revision: 1,
    state: 'running' as const,
    durationSeconds: 30,
    startedAt: now,
    pausedAt: null,
    pausedMilliseconds: 0,
  }));
  blocked(c, 'bounds_exceeded');
});

function withCompletion(historical = false) {
  const c = historical ? withTrainingRef(true) : withSupplementary();
  const source = c.consumedSources.plans.find((row) => row.id === version);
  const session = source?.draft.sessions[0];
  if (!source || !session) throw Error('completion source fixture');
  c.completions.push(
    sessionCompletionSchema.parse({
      sessionId: session.id,
      revision: 1,
      planVersionId: source.id,
      schedule: {
        blockId: session.blockId,
        date: session.date,
        localStartTime: session.localStartTime,
        timezone: source.draft.timezone,
      },
      status: 'completed',
      reportedAt: now,
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    }),
  );
  c.coreDependencies.sessionCompletions = { kind: 'exists', revision: 1 };
  return c;
}
it.each([false, true])(
  'validates current self-report against exact owned version, historical=%s',
  (historical) => {
    const c = withCompletion(historical);
    expect(inspect(c)).toMatchObject({
      status: 'validated_read_scope',
      approvalAuthority: 'none',
      freshness: 'not_checked',
    });
    expect(c.coreDependencies.activities).toEqual({ count: '0', revisionSum: '0' });
    expect(c.completions[0]?.schedule.localStartTime).toBeNull();
  },
);
it('preserves retracted historical reports without requiring a current session', () => {
  const c = withCompletion();
  const report = c.completions[0];
  if (!report) throw Error('report fixture');
  c.completions[0] = sessionCompletionSchema.parse({
    ...report,
    status: 'retracted',
    revision: 2,
    reason: 'User correction',
  });
  c.coreDependencies.sessionCompletions = { kind: 'exists', revision: 2 };
  c.currentTraining = null;
  c.coreDependencies.trainingPlan = { kind: 'absent' };
  expect(inspect(c).status).toBe('validated_read_scope');
});
it('blocks missing owned completion source, without guessing aggregate identity', () => {
  const c = withCompletion();
  c.completions[0] = sessionCompletionSchema.parse({ ...c.completions[0], planVersionId: race });
  blocked(c, 'completion_plan_source_missing');
});
it.each(['sessionId', 'blockId', 'date', 'localStartTime', 'timezone'] as const)(
  'rejects mismatched completion %s membership',
  (field) => {
    const c = withCompletion(),
      report = c.completions[0];
    if (!report) throw Error('report fixture');
    c.completions[0] = sessionCompletionSchema.parse(
      field === 'sessionId'
        ? { ...report, sessionId: 'foreign-session' }
        : {
            ...report,
            schedule: {
              ...report.schedule,
              [field]:
                field === 'date'
                  ? '2026-10-08'
                  : field === 'localStartTime'
                    ? '01:00'
                    : field === 'timezone'
                      ? 'UTC'
                      : 'foreign-block',
            },
          },
    );
    blocked(c, 'source_membership_mismatch');
  },
);
it('rejects duplicate opaque session identities', () => {
  const c = withCompletion(),
    report = c.completions[0];
  if (!report) throw Error('report fixture');
  c.completions.push(report);
  blocked(c, 'source_identity_mismatch');
});
it.each(['absent', 'stale', 'overflow'] as const)('rejects completion collection %s', (state) => {
  const c = withCompletion();
  c.completions[0] = sessionCompletionSchema.parse({
    ...c.completions[0],
    revision: 2,
    reason: 'Correction',
  });
  c.coreDependencies.sessionCompletions =
    state === 'absent'
      ? { kind: 'absent' }
      : { kind: 'exists', revision: state === 'overflow' ? 2147483647 : 1 };
  blocked(c, 'completion_revision_mismatch');
});
it('allows valid report and collection maximum without treating it as a performance count', () => {
  const c = withCompletion();
  c.completions[0] = sessionCompletionSchema.parse({
    ...c.completions[0],
    revision: 2147483646,
    reason: 'Correction',
  });
  c.coreDependencies.sessionCompletions = { kind: 'exists', revision: 2147483646 };
  expect(inspect(c).status).toBe('validated_read_scope');
});
it.each(['partial', 'skipped', 'stopped'])('does not invent completion status %s', (status) => {
  const c = withCompletion();
  const malformed = { ...c, completions: [{ ...c.completions[0], status }] };
  expect(validateRaceImpactConsumedManifest(malformed, sign(c))).toMatchObject({
    status: 'blocked',
    blockers: [{ reason: 'invalid_capture' }],
  });
});
it.each([
  { revision: 0 },
  { revision: null },
  { actualDurationSeconds: 0 },
  { deleted: true },
  { source: 'provider' },
  { reason: '' },
])('rejects unknown or invalid completion facts %j', (patch) => {
  const c = withCompletion();
  expect(
    validateRaceImpactConsumedManifest(
      { ...c, completions: [{ ...c.completions[0], ...patch }] },
      sign(c),
    ),
  ).toMatchObject({ status: 'blocked', blockers: [{ reason: 'invalid_capture' }] });
});
it('requires completed reports to remain in the current schedule', () => {
  const c = withCompletion(true),
    current = c.currentTraining;
  if (!current) throw Error('current fixture');
  const session = current.snapshot.draft.sessions[0];
  if (!session) throw Error('current session fixture');
  current.snapshot.draft.sessions[0] = {
    ...session,
    localStartTime: '01:00',
  };
  blocked(c, 'source_membership_mismatch');
});
it('detects completion mutation after read-set digest binding', () => {
  const c = withCompletion(),
    scope = sign(c);
  c.completions[0] = sessionCompletionSchema.parse({
    ...c.completions[0],
    reportedAt: '2026-10-07T01:00:00.000Z',
  });
  expect(validateRaceImpactConsumedManifest(c, scope)).toMatchObject({
    status: 'blocked',
    blockers: expect.arrayContaining([{ path: 'readSetDigest', reason: 'digest_mismatch' }]),
  });
});
it('rejects completion transport beyond actual producer 1000-row bound', () => {
  const c = withCompletion(),
    report = c.completions[0];
  if (!report) throw Error('report fixture');
  const malformed = { ...c, completions: Array.from({ length: 1001 }, () => report) };
  expect(validateRaceImpactConsumedManifest(malformed, sign(c))).toMatchObject({
    status: 'blocked',
    blockers: [{ reason: 'invalid_capture' }],
  });
});

it('matches UUID case variants but retains opaque session identity case', () => {
  const c = withCompletion();
  const report = c.completions[0];
  if (!report) throw Error('report fixture');
  c.completions[0] = sessionCompletionSchema.parse({
    ...report,
    planVersionId: report.planVersionId.toUpperCase(),
  });
  expect(inspect(c).status).toBe('validated_read_scope');
  c.completions[0] = { ...report, sessionId: report.sessionId.toUpperCase() };
  blocked(c, 'source_membership_mismatch');
});
it('does not manufacture actuals or collapse zero/null planned metrics', () => {
  const c = withCompletion(),
    current = c.currentTraining;
  const session = current?.snapshot.draft.sessions[0];
  if (!session) throw Error('session fixture');
  session.durationSeconds = 0;
  session.distanceMeters = null;
  expect(inspect(c).status).toBe('validated_read_scope');
  expect(session.durationSeconds).toBe(0);
  expect(session.distanceMeters).toBeNull();
  expect(c.coreDependencies.activities.count).toBe('0');
});
it('preserves an existing empty completion collection revision without fabricating reports', () => {
  const c = fixture();
  c.coreDependencies.sessionCompletions = { kind: 'exists', revision: 9 };
  expect(inspect(c).status).toBe('validated_read_scope');
  expect(c.completions).toEqual([]);
});

function withCourseRead() {
  const c = fixture();
  const courseId = 'aaaaaaaa-0000-4000-8000-000000000031';
  const revisionId = 'bbbbbbbb-0000-4000-8000-000000000032';
  const ref = { courseId, courseRevision: 1, revisionId };
  const record = courseRevisionSchema.parse({
    ...ref,
    name: 'Synthetic imported course',
    geometry: {
      type: 'LineString',
      coordinates: [
        [127, 37],
        [127.01, 37.01],
      ],
    },
    waypoints: [
      { role: 'start', position: [127, 37], name: null, sourceSampleId: null, locked: false },
      {
        role: 'finish',
        position: [127.01, 37.01],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ],
    generation: {
      kind: 'imported-file',
      format: 'gpx',
      sourceKind: 'gpx-rte',
      itemIndex: 0,
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      fileSha256: hash,
      fileByteLength: 320,
      originalFilename: null,
      fileCreator: null,
      vertexCount: 2,
      importedWaypointCount: 0,
      ignoredFileWaypointCount: 0,
    },
    edit: { kind: 'imported' },
    lineage: [],
    distanceMeters: 0,
    contentDigest: hash,
    createdAt: now,
  });
  record.contentDigest = courseContentDigest({
    ...record,
    coordinates: record.geometry.coordinates,
  });
  c.event.course = ref;
  c.course = courseReadManifestSchema.parse({
    ref,
    digest: record.contentDigest,
    owned: {
      athleteId: athlete,
      head: {
        status: 'available',
        courseId,
        name: record.name,
        visibility: 'private',
        headRevision: 1,
        revisionId,
        createdAt: now,
        updatedAt: now,
      },
      revision: record,
      deletion: absent(),
    },
    lineageSources: [],
  });
  return c;
}
function courseOwned(c: Capture) {
  const owned = c.course?.owned;
  if (!owned?.revision) throw Error('course fixture');
  return { owned, record: owned.revision };
}
it('consumes nonempty full course projection as readonly scope while retaining geometry and provenance', () => {
  const c = withCourseRead(),
    body = structuredClone(c.course),
    coverage = structuredClone(c.coverage);
  const result = inspect(c);
  expect(result.status).toBe('validated_read_scope');
  if (result.status === 'validated_read_scope') {
    expect(result.approvalAuthority).toBe('none');
    expect(result.freshness).toBe('not_checked');
    expect(result.remaining).toHaveLength(5);
  }
  expect(c.course).toEqual(body);
  expect(c.coverage).toEqual(coverage);
  expect(c.coverage.complete).toBe(false);
  expect(c.course?.owned?.revision).toMatchObject({
    distanceMeters: 0,
    generation: { originalFilename: null, fileCreator: null },
  });
});
it('retains legacy course metadata as explicitly blocked rather than routing acceptance', () => {
  const c = withCourseRead();
  if (!c.course) throw Error('course fixture');
  c.course = { ref: c.course.ref, digest: c.course.digest };
  blocked(c, 'course_owned_projection_port_missing', 'course');
});
it.each(['version', 'revisionId', 'digest', 'foreign', 'deleted', 'lineage_missing'] as const)(
  'propagates course companion blocker into complete consumer: %s',
  (kind) => {
    const c = withCourseRead(),
      { owned, record } = courseOwned(c);
    let reason = 'course_version_mismatch';
    if (kind === 'version') record.courseRevision = 2;
    if (kind === 'revisionId') record.revisionId = generation;
    if (kind === 'digest') {
      if (!c.course) throw Error('fixture');
      c.course.digest = hash;
      reason = 'course_digest_mismatch';
    }
    if (kind === 'foreign') {
      owned.athleteId = 'foreign';
      reason = 'foreign_source';
    }
    if (kind === 'deleted') {
      owned.deletion = { state: 'present', courseId: record.courseId };
      reason = 'course_deleted';
    }
    if (kind === 'lineage_missing') {
      record.lineage = [{ activityId: race, trackId: plan, trackRevision: 1 }];
      if (!c.course) throw Error('fixture');
      delete c.course.lineageSources;
      record.contentDigest = courseContentDigest({
        ...record,
        coordinates: record.geometry.coordinates,
      });
      c.course.digest = record.contentDigest;
      reason = 'lineage_source_port_missing';
    }
    blocked(c, reason, 'course');
  },
);
it('uses requested historical course revision under a newer head without replacing it', () => {
  const c = withCourseRead(),
    { owned, record } = courseOwned(c),
    original = structuredClone(record);
  if (owned.head.status !== 'available') throw Error('fixture');
  owned.head = { ...owned.head, headRevision: 2, revisionId: generation, name: 'Later course' };
  expect(inspect(c).status).toBe('validated_read_scope');
  expect(record).toEqual(original);
});
it('binds original course body into complete readset rather than trusting a copied digest', () => {
  const c = withCourseRead(),
    scope = sign(c),
    { record } = courseOwned(c);
  record.geometry.coordinates[1] = [128, 38];
  expect(validateRaceImpactConsumedManifest(c, scope)).toMatchObject({
    status: 'blocked',
    blockers: expect.arrayContaining([
      { path: 'readSetDigest', reason: 'digest_mismatch' },
      { path: 'course', reason: 'course_digest_mismatch' },
    ]),
  });
});

function withRetainedIntake(state: 'current' | 'historical' | 'deleted' = 'current') {
  const c = withReadRun(),
    run = c.routineTimerReads[0]?.run,
    template = withNutritionRef();
  c.nutrition = structuredClone(template.nutrition);
  c.rosters.nutrition = structuredClone(template.rosters.nutrition);
  c.sourcePermissionManifest.nestedNutritionSources = structuredClone(
    template.sourcePermissionManifest.nestedNutritionSources,
  );
  c.sourcePermissionManifest.catalog = structuredClone(template.sourcePermissionManifest.catalog);
  if (!run) throw Error('run fixture');
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: blueprintId,
    versionId: blueprintVersion,
    title: 'Manual intake read',
    intent: 'User record',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Intake',
        content: {
          kind: 'nutrition_template',
          ref: { id: plan, versionId: version },
        },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: now,
  });
  c.routineActualManifest.blueprints = [
    {
      record: blueprint,
      version: 1,
      currentHead: {
        state: 'present',
        versionId: blueprintVersion,
        version: 1,
        visibility: 'active',
        favorite: false,
      },
      unsupportedContent: [],
    },
  ];
  const ref = { kind: 'intake' as const, id: 'manual-retained-intake', revisionId: version };
  const datum = (unit: string, value: number | null) => ({
    unit,
    value,
    status: value === null ? 'unknown' : 'reported',
    evidenceIds: [],
  });
  const body = activeIntakeEntrySchema.parse({
    intakeId: ref.id,
    revisionId: version,
    revision: 1,
    status: 'active',
    occurredAt: now,
    recordedAt: now,
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: null,
        description: 'Zero portion',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
    ],
    nutrientTotal: {
      energy: datum('kcal', 0),
      carbohydrate: datum('g', null),
      protein: datum('g', null),
      fat: datum('g', null),
      fluid: datum('mL', null),
      sodium: datum('mg', null),
    },
    nutrientValueCoverage: 'partial',
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  const head = {
    id: ref.id,
    revision: state === 'current' ? 1 : 2,
    revisionId: state === 'current' ? version : generation,
    status: state === 'deleted' ? ('deleted' as const) : ('active' as const),
    contentDigest: impactDependencyDigest(
      state === 'deleted'
        ? null
        : state === 'historical'
          ? { ...body, revision: 2, revisionId: generation }
          : body,
    ),
  };
  const content = state === 'deleted' ? null : body;
  const updated = routineRunSchema.parse({
    ...run,
    revision: 1,
    progress: [
      {
        stepId: 'step',
        revision: 1,
        state: 'performed',
        actualRefs: [ref],
        occurredAt: now,
        recordedAt: now,
        reason: null,
      },
    ],
  });
  const fact = {
    requested: ref,
    state,
    reason: null,
    current: {
      id: head.id,
      revision: head.revision,
      revisionId: head.revisionId,
      status: head.status,
    },
    content,
  };
  c.routineActualManifest.runs = [
    {
      record: updated,
      historyDigest: impactDependencyDigest(updated),
      actuals: [{ stepId: 'step', fact }],
    },
  ];
  c.routineActualManifest.actualRosters.intake = [head];
  c.routineActualManifest.uniqueSourceCount = 2;
  c.routineTimerReads = [routineRunReadSchema.parse({ run: updated, timers: [] })];
  c.manualIntakeReadFacts = manualIntakeReadFactsSchema.parse({
    purpose: 'retained_manual_intake_read',
    athleteId: athlete,
    authority: 'none',
    freshness: 'not_checked',
    facts: [
      {
        ...fact,
        current: head,
        contentDigest: content === null ? null : impactDependencyDigest(content),
      },
    ],
  });
  return c;
}
it.each(['current', 'historical', 'deleted'] as const)(
  'consumes retained manual intake %s through full readonly scope without copied deleted body',
  (state) => {
    const c = withRetainedIntake(state),
      before = structuredClone(c.manualIntakeReadFacts),
      result = inspect(c);
    if (result.status === 'blocked') expect(result.blockers).toEqual([]);
    expect(result.status).toBe('validated_read_scope');
    if (result.status === 'validated_read_scope') {
      expect(result.approvalAuthority).toBe('none');
      expect(result.freshness).toBe('not_checked');
      expect(result.remaining).toHaveLength(5);
    }
    expect(c.coverage.complete).toBe(false);
    expect(c.manualIntakeReadFacts).toEqual(before);
    const body = c.manualIntakeReadFacts?.facts[0]?.content;
    if (state === 'deleted') expect(body).toBeNull();
    else
      expect(body).toMatchObject({
        foods: [{ quantity: 0, foodVersionId: null }],
        nutrientTotal: { energy: { value: 0 }, carbohydrate: { value: null } },
      });
  },
);
it('keeps manual intake actual permission unresolved when retained read port is absent', () => {
  const c = withRetainedIntake();
  delete c.manualIntakeReadFacts;
  blocked(c, 'actual_permission_port_missing');
});
it('rejects foreign manual intake read scope before any approval authority', () => {
  const c = withRetainedIntake();
  if (!c.manualIntakeReadFacts) throw Error('fixture');
  c.manualIntakeReadFacts.athleteId = 'foreign';
  blocked(c, 'scope_mismatch', 'manualIntakeReadFacts');
});
it('rejects forged intake head even with an otherwise exact manual body', () => {
  const c = withRetainedIntake(),
    f = c.manualIntakeReadFacts?.facts[0];
  if (!f?.current) throw Error('fixture');
  f.current.revision = 2;
  blocked(c, 'actual_permission_port_missing');
});
it.each(['extraction', 'user_with_source_record'] as const)(
  'excludes %s intake source despite internally recomputed digests',
  (kind) => {
    const c = withRetainedIntake(),
      f = c.manualIntakeReadFacts?.facts[0];
    if (!f?.content || !f.current) throw Error('fixture');
    f.content.source = kind === 'extraction' ? 'user_confirmed_extraction' : 'user';
    f.content.sourceRecordId = plan;
    f.contentDigest = impactDependencyDigest(f.content);
    f.current.contentDigest = f.contentDigest;
    const row = c.routineActualManifest.runs[0];
    if (!row || typeof row !== 'object' || Array.isArray(row) || !('actuals' in row))
      throw Error('fixture');
    const facts = z
      .array(
        z.strictObject({
          stepId: z.string(),
          fact: z.strictObject({
            requested: z.json(),
            state: z.string(),
            reason: z.null(),
            current: z.json(),
            content: z.json(),
          }),
        }),
      )
      .parse(row.actuals);
    const actual = facts[0];
    if (!actual) throw Error('fixture');
    actual.fact.content = z.json().parse(f.content);
    row.actuals = facts;
    c.routineActualManifest.actualRosters.intake = [f.current];
    blocked(c, 'actual_permission_port_missing');
  },
);
it('rejects deleted intake body copied into routine facts instead of restoring it from history', () => {
  const c = withRetainedIntake('deleted'),
    row = c.routineActualManifest.runs[0];
  if (!row || typeof row !== 'object' || Array.isArray(row) || !('actuals' in row))
    throw Error('fixture');
  const facts = z
    .array(
      z.strictObject({
        stepId: z.string(),
        fact: z.strictObject({
          requested: z.json(),
          state: z.string(),
          reason: z.null(),
          current: z.json(),
          content: z.json(),
        }),
      }),
    )
    .parse(row.actuals);
  const actual = facts[0];
  if (!actual) throw Error('fixture');
  actual.fact.content = z
    .json()
    .parse(withRetainedIntake().manualIntakeReadFacts?.facts[0]?.content);
  row.actuals = facts;
  blocked(c, 'actual_permission_port_missing');
  blocked(c, 'actual_membership_mismatch');
  expect(c.manualIntakeReadFacts?.facts[0]?.content).toBeNull();
});

function withManualActivityRead(deleted = false) {
  const c = withReadRun(),
    run = c.routineTimerReads[0]?.run;
  if (!run) throw Error('run fixture');
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: blueprintId,
    versionId: blueprintVersion,
    title: 'Manual Activity read',
    intent: 'User record',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Workout',
        content: { kind: 'workout_template', ref: { id: scheduleId, versionId: scheduleVersion } },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: now,
  });
  c.routineActualManifest.blueprints = [
    {
      record: blueprint,
      version: 1,
      currentHead: {
        state: 'present',
        versionId: blueprintVersion,
        version: 1,
        visibility: 'active',
        favorite: false,
      },
      unsupportedContent: [],
    },
  ];
  const original = manualActivityCreateSchema.shape.activity.parse({
    title: 'Synthetic manual Activity',
    kind: 'unknown',
    startedAt: now,
    durationSeconds: 0,
    durationKind: 'unknown',
    timezone: 'UTC',
    distanceMeters: null,
  });
  const ref = {
    kind: 'activity' as const,
    id: race,
    revisionId: '1',
    detailId: null,
    allocationId: null,
  };
  const current = { id: race, revision: deleted ? 2 : 1, deleted };
  const content = deleted ? null : { original, overlay: null, detail: null };
  const roster = {
    ...current,
    originalDigest: impactDependencyDigest(original),
    overlayDigest: impactDependencyDigest(null),
    source: {
      state: 'present' as const,
      kind: 'manual' as const,
      sourceId: 'manual-source',
      sourceRevision: 1,
      contentHash: createHash('sha256').update(JSON.stringify(original)).digest('hex'),
    },
  };
  const metadata = {
    ...current,
    overlay: { state: 'absent' as const, revision: null },
    source: {
      state: 'present' as const,
      kind: 'manual' as const,
      sourceId: 'manual-source',
      revision: 1,
      contentHash: roster.source.contentHash,
      suppressed: deleted,
      revisionRecord: { state: 'present' as const },
    },
  };
  const updated = routineRunSchema.parse({
    ...run,
    revision: 1,
    progress: [
      {
        stepId: 'step',
        revision: 1,
        state: 'performed',
        actualRefs: [ref],
        occurredAt: now,
        recordedAt: now,
        reason: null,
      },
    ],
  });
  const fact = {
    requested: ref,
    state: deleted ? ('deleted' as const) : ('current' as const),
    reason: null,
    current,
    content,
  };
  c.routineActualManifest.runs = [
    {
      record: updated,
      historyDigest: impactDependencyDigest(updated),
      actuals: [{ stepId: 'step', fact }],
    },
  ];
  c.routineActualManifest.actualRosters.activities = [roster];
  c.routineActualManifest.uniqueSourceCount = 2;
  c.routineTimerReads = [routineRunReadSchema.parse({ run: updated, timers: [] })];
  c.sourcePermissionManifest.activityMediaPermissions.activities = [metadata];
  const projected = projectManualActivityReadFacts({
    athleteId: athlete,
    refs: [ref],
    actualFacts: [fact],
    activityRosters: [roster],
    activityMetadata: [metadata],
  });
  if (projected.status !== 'projected_retained_read_facts') throw Error(projected.reason);
  c.manualActivityReadFacts = projected.facts;
  return c;
}
function fullManualActivityReasons(c: Capture) {
  const result = inspect(c);
  expect(result.status).toBe('blocked');
  if (result.status !== 'blocked') throw Error('expected incomplete catalog');
  return result.blockers;
}
it.each([false, true])(
  'manual Activity port resolves its exact actual permission only, missing workout codec remains blocked deleted=%s',
  (deleted) => {
    const c = withManualActivityRead(deleted),
      before = structuredClone(c.manualActivityReadFacts),
      reasons = fullManualActivityReasons(c);
    expect(reasons.some((r) => r.reason === 'actual_permission_port_missing')).toBe(false);
    expect(reasons).toContainEqual({
      path: 'workoutTemplateSources.sourceFacts',
      reason: 'source_port_missing',
    });
    expect(reasons).toContainEqual({
      path: 'sourcePermissionManifest.catalog',
      reason: 'missing_source',
    });
    expect(reasons).toContainEqual({
      path: 'workoutTemplateSources.catalogRows',
      reason: 'source_unavailable',
    });
    expect(c.coverage.complete).toBe(false);
    expect(c.manualActivityReadFacts).toEqual(before);
    if (deleted) expect(c.manualActivityReadFacts?.facts[0]?.content).toBeNull();
    else
      expect(c.manualActivityReadFacts?.facts[0]?.content?.original).toMatchObject({
        durationSeconds: 0,
        distanceMeters: null,
      });
  },
);
it('manual Activity port omission retains exact actual permission blocker', () => {
  const c = withManualActivityRead();
  delete c.manualActivityReadFacts;
  blocked(c, 'actual_permission_port_missing');
});
it('manual Activity foreign port scope is rejected at the full capture boundary', () => {
  const c = withManualActivityRead();
  if (!c.manualActivityReadFacts) throw Error('fixture');
  c.manualActivityReadFacts.athleteId = 'foreign';
  blocked(c, 'scope_mismatch', 'manualActivityReadFacts');
});
it('manual Activity metadata absence is not replaced by the forged retained port', () => {
  const c = withManualActivityRead();
  c.sourcePermissionManifest.activityMediaPermissions.activities = [];
  blocked(c, 'actual_permission_port_missing');
});
it('manual Activity source hash mismatch does not become canonical read digest authority', () => {
  const c = withManualActivityRead(),
    f = c.manualActivityReadFacts?.facts[0];
  if (
    !f?.sourceEvidence ||
    f.sourceEvidence.roster.source.state !== 'present' ||
    f.sourceEvidence.metadata.source.state !== 'present'
  )
    throw Error('fixture');
  f.sourceEvidence.roster.source.contentHash = hash;
  f.sourceEvidence.metadata.source.contentHash = hash;
  c.routineActualManifest.actualRosters.activities = [f.sourceEvidence.roster];
  c.sourcePermissionManifest.activityMediaPermissions.activities = [f.sourceEvidence.metadata];
  blocked(c, 'actual_permission_port_missing');
});
it('HealthKit source cannot fall back through an internally matching manual Activity port', () => {
  const c = withManualActivityRead(),
    f = c.manualActivityReadFacts?.facts[0];
  if (
    !f?.sourceEvidence ||
    f.sourceEvidence.roster.source.state !== 'present' ||
    f.sourceEvidence.metadata.source.state !== 'present'
  )
    throw Error('fixture');
  f.sourceEvidence.roster.source.kind = 'healthkit';
  f.sourceEvidence.metadata.source.kind = 'healthkit';
  f.sourceEvidence.roster.source.sourceId = plan;
  f.sourceEvidence.metadata.source.sourceId = plan;
  c.routineActualManifest.actualRosters.activities = [f.sourceEvidence.roster];
  c.sourcePermissionManifest.activityMediaPermissions.activities = [f.sourceEvidence.metadata];
  blocked(c, 'actual_permission_port_missing');
});
it('deleted manual Activity body cannot be resurrected in copied routine facts', () => {
  const c = withManualActivityRead(true),
    row = c.routineActualManifest.runs[0];
  if (!row || typeof row !== 'object' || Array.isArray(row) || !('actuals' in row))
    throw Error('fixture');
  const actuals = z
    .array(
      z.strictObject({
        stepId: z.string(),
        fact: z.strictObject({
          requested: z.json(),
          state: z.string(),
          reason: z.null(),
          current: z.json(),
          content: z.json(),
        }),
      }),
    )
    .parse(row.actuals);
  const actual = actuals[0];
  if (!actual) throw Error('fixture');
  actual.fact.content = z
    .json()
    .parse(withManualActivityRead().manualActivityReadFacts?.facts[0]?.content);
  row.actuals = actuals;
  blocked(c, 'actual_permission_port_missing');
  blocked(c, 'actual_membership_mismatch');
  expect(c.manualActivityReadFacts?.facts[0]?.content).toBeNull();
});

function withCalendarIntent() {
  return {
    ...fixture(),
    calendarIntent: {
      expectedEvent: { id: race, revision: 1 },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' as const },
      resolutions: { nutrition: [], routines: [] },
    },
    collectorSelection: { kind: 'keep_plan' as const },
  };
}
it('validates rich original calendar intent without granting freshness or approval', () => {
  const c = withCalendarIntent();
  expect(inspect(c)).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
});
it('rejects original intent event revision mismatch even after re-signing', () => {
  const c = withCalendarIntent();
  c.calendarIntent.expectedEvent.revision = 2;
  blocked(c, 'source_identity_mismatch', 'calendarIntent');
});
it('rejects forged derived calendar selection even with a matching read digest', () => {
  const c = {
    ...withCalendarIntent(),
    collectorSelection: {
      kind: 'move_period',
      expectedCurrentPlanVersionId: race,
      changedSessionIds: [],
      movedPeriodIds: [],
    },
  };
  blocked(c, 'source_identity_mismatch', 'collectorSelection');
});
it('binds original calendar intent to the captured read digest', () => {
  const c = withCalendarIntent(),
    scope = sign(c);
  c.calendarIntent.newLocalDate = '2026-10-09';
  expect(validateRaceImpactConsumedManifest(c, scope).status).toBe('blocked');
});

function withLocalActivityRead() {
  const c = withManualActivityRead();
  const manifest = routineReadManifestSchema.parse(c.routineActualManifest);
  const activityMetadata = manualActivityReadProjectionInputSchema.shape.activityMetadata.parse(
    c.sourcePermissionManifest.activityMediaPermissions.activities,
  );
  const roster = manifest.actualRosters.activities[0],
    metadata = activityMetadata[0];
  if (
    !roster ||
    roster.source.state !== 'present' ||
    !metadata ||
    metadata.source.state !== 'present'
  )
    throw Error('fixture');
  roster.source.kind = 'fit';
  metadata.source.kind = 'fit';
  c.routineActualManifest.actualRosters.activities = z
    .array(z.json())
    .parse(manifest.actualRosters.activities);
  c.sourcePermissionManifest.activityMediaPermissions.activities = activityMetadata;
  const actualFacts = manifest.runs.flatMap((r) => r.actuals.map((a) => a.fact));
  const port = projectLocalImportedActivityReadFacts({
    athleteId: athlete,
    refs: actualFacts.map((f) => f.requested),
    actualFacts,
    activityRosters: [roster],
    activityMetadata: [metadata],
  });
  if (port.status !== 'projected_retained_local_import_read_facts') throw Error(port.reason);
  delete c.manualActivityReadFacts;
  c.localImportedActivityReadFacts = port.facts;
  return c;
}
it('full consumer removes local read blocker while preserving other missing sources and authority', () => {
  const c = withLocalActivityRead(),
    reasons = fullManualActivityReasons(c),
    before = structuredClone(c);
  expect(reasons.some((r) => r.reason === 'actual_permission_port_missing')).toBe(false);
  const scope = sign(c);
  validateRaceImpactConsumedManifest(c, scope);
  expect(c).toEqual(before);
});
it('full consumer rejects foreign local read port', () => {
  const c = withLocalActivityRead();
  if (!c.localImportedActivityReadFacts) throw Error('fixture');
  c.localImportedActivityReadFacts.athleteId = 'foreign';
  blocked(c, 'scope_mismatch', 'localImportedActivityReadFacts');
});
it('full consumer blocks missing local read port without manual fallback', () => {
  const c = withLocalActivityRead();
  delete c.localImportedActivityReadFacts;
  expect(
    fullManualActivityReasons(c).some((r) => r.reason === 'actual_permission_port_missing'),
  ).toBe(true);
});

function withHealthKitActivityRead() {
  const c: ReturnType<typeof withManualActivityRead> & {
    healthKitActivityReadFacts?: HealthKitActivityReadFacts;
  } = withManualActivityRead();
  const m = routineReadManifestSchema.parse(c.routineActualManifest);
  const metadata = manualActivityReadProjectionInputSchema.shape.activityMetadata.parse(
    c.sourcePermissionManifest.activityMediaPermissions.activities,
  );
  const roster = m.actualRosters.activities[0],
    head = metadata[0];
  if (!roster || roster.source.state !== 'present' || !head || head.source.state !== 'present')
    throw Error('fixture');
  const sample = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  roster.source.kind = 'healthkit';
  roster.source.sourceId = sample;
  head.source.kind = 'healthkit';
  head.source.sourceId = sample;
  c.routineActualManifest.actualRosters.activities = z
    .array(z.json())
    .parse(m.actualRosters.activities);
  c.sourcePermissionManifest.activityMediaPermissions.activities = metadata;
  const facts = m.runs.flatMap((r) => r.actuals.map((a) => a.fact));
  const observation = {
    adapterVersion: 2,
    kind: 'own_healthkit_activity',
    activityId: roster.id,
    canonicalRevision: roster.revision,
    source: {
      kind: 'healthkit',
      sourceId: sample,
      revision: roster.source.sourceRevision,
      contentHash: roster.source.contentHash,
    },
    originalDigest: roster.originalDigest,
    overlayDigest: head.overlay.state === 'absent' ? null : roster.overlayDigest,
    overlayRevision: head.overlay.revision,
    healthkitConsent: { kind: 'healthkit', granted: true, revision: 1 },
    sample: { id: sample, state: 'active', payloadDigest: roster.source.contentHash },
    claim: { epoch: sample, consentRevision: 1 },
    lineage: 'created_activity',
    deregistration: { state: 'absent' },
  };
  c.sourcePermissionManifest.activityMediaPermissions.healthkit = [
    {
      id: sample,
      sample: { state: 'present', status: 'active', payloadDigest: roster.source.contentHash },
      lineage: { state: 'present', status: 'created_activity' },
      claim: { state: 'present', epoch: sample, consentRevision: 1 },
      binding: { state: 'absent' },
    },
  ];
  c.sourcePermissionManifest.activityMediaPermissions.consents =
    raceImpactConsumedCaptureSchema.shape.sourcePermissionManifest.shape.activityMediaPermissions.shape.consents
      .parse(c.sourcePermissionManifest.activityMediaPermissions.consents)
      .map((row) =>
        row.kind === 'healthkit'
          ? { kind: 'healthkit', state: 'present', granted: true, revision: 1 }
          : row,
      );
  const port = projectHealthKitActivityReadFacts({
    athleteId: athlete,
    refs: facts.map((f) => f.requested),
    actualFacts: facts,
    activityRosters: [roster],
    activityMetadata: metadata,
    healthkitSources: [{ activityId: roster.id, observation, reason: null }],
  });
  if (port.status === 'blocked') throw Error(port.reason);
  delete c.manualActivityReadFacts;
  c.healthKitActivityReadFacts = port.facts;
  return c;
}
it('HK exact metadata companion removes only its read blocker, without authority or manual fallback', () => {
  const c = withHealthKitActivityRead();
  expect(
    fullManualActivityReasons(c).some((r) => r.reason === 'actual_permission_port_missing'),
  ).toBe(false);
  const before = structuredClone(c);
  validateRaceImpactConsumedManifest(c, sign(c));
  expect(c).toEqual(before);
});
it('HK missing/foreign/wrong source tuple companion is blocked', () => {
  const c = withHealthKitActivityRead();
  delete c.healthKitActivityReadFacts;
  expect(
    fullManualActivityReasons(c).some((r) => r.reason === 'actual_permission_port_missing'),
  ).toBe(true);
  const f = withHealthKitActivityRead();
  if (!f.healthKitActivityReadFacts) throw Error('fixture');
  f.healthKitActivityReadFacts.athleteId = 'foreign';
  blocked(f, 'scope_mismatch', 'healthKitActivityReadFacts');
  const g = withHealthKitActivityRead();
  const source = g.healthKitActivityReadFacts?.facts[0]?.source;
  if (!source) throw Error('fixture');
  source.originalDigest = 'f'.repeat(64);
  expect(fullManualActivityReasons(g).some((r) => r.reason === 'actual_membership_mismatch')).toBe(
    true,
  );
});

it('HK primary witness must match captured claim/consent/sample, unrelated binding does not deny primary', () => {
  const c = withHealthKitActivityRead();
  const am =
    raceImpactConsumedCaptureSchema.shape.sourcePermissionManifest.shape.activityMediaPermissions.parse(
      c.sourcePermissionManifest.activityMediaPermissions,
    );
  const hk = am.healthkit[0];
  if (!hk) throw Error('fixture');
  hk.binding = {
    state: 'present',
    activityId: race,
    targetRevision: 1,
    sampleDigest: 'f'.repeat(64),
  };
  c.sourcePermissionManifest.activityMediaPermissions = am;
  expect(
    fullManualActivityReasons(c).some((r) => r.path === 'healthKitActivityReadFacts.source'),
  ).toBe(false);
  hk.claim = { state: 'present', epoch: race, consentRevision: 2 };
  blocked(c, 'source_identity_mismatch', 'healthKitActivityReadFacts.source');
});

function withGarminActivityRead() {
  const c: ReturnType<typeof withLocalActivityRead> & {
    garminActivityReadFacts?: GarminActivityReadFacts;
  } = withLocalActivityRead();
  const m = routineReadManifestSchema.parse(c.routineActualManifest),
    metadata = manualActivityReadProjectionInputSchema.shape.activityMetadata.parse(
      c.sourcePermissionManifest.activityMediaPermissions.activities,
    ),
    r = m.actualRosters.activities[0],
    a = metadata[0];
  if (!r || r.source.state !== 'present' || !a || a.source.state !== 'present')
    throw Error('fixture');
  c.sourcePermissionManifest.activityMediaPermissions.garminLineage = [
    {
      kind: 'fit',
      source_id: r.source.sourceId,
      provider: 'garmin-connect-unofficial',
      official: false,
      outcome: 'imported',
    },
  ];
  const actualFacts = m.runs.flatMap((run) => run.actuals.map((a) => a.fact));
  const p = projectGarminActivityReadFacts({
    athleteId: athlete,
    refs: actualFacts.map((f) => f.requested),
    actualFacts,
    activityRosters: [r],
    activityMetadata: metadata,
    garminSources: [
      {
        activityId: r.id,
        reason: null,
        observation: {
          adapterVersion: 2,
          kind: 'owned_garmin_current_source',
          activityId: r.id,
          canonicalRevision: r.revision,
          source: {
            kind: 'fit',
            sourceId: r.source.sourceId,
            revision: r.source.sourceRevision,
            contentHash: r.source.contentHash,
          },
          originalDigest: r.originalDigest,
          overlayDigest: null,
          overlayRevision: null,
          collectionPermission: 'not_captured',
          collection: {
            garminActivityId: '12345',
            provider: 'garmin-connect-unofficial',
            official: false,
            outcome: 'imported',
            collectedAt: now,
          },
        },
      },
    ],
  });
  if (p.status === 'blocked') throw Error(p.reason);
  delete c.localImportedActivityReadFacts;
  c.garminActivityReadFacts = p.facts;
  return c;
}
it('full consumer validates current Garmin metadata read partition without granting source purpose/approval', () => {
  const c = withGarminActivityRead(),
    scope = sign(c),
    before = structuredClone(c);
  expect(
    fullManualActivityReasons(c).some((r) => r.reason === 'actual_permission_port_missing'),
  ).toBe(false);
  validateRaceImpactConsumedManifest(c, scope);
  expect(c).toEqual(before);
  expect(c.coverage).toMatchObject({ complete: false });
});
it.each(['missing', 'foreign', 'lineage', 'extra', 'duplicate', 'body', 'tuple'] as const)(
  'full Garmin %s read witness blocks exact membership',
  (part) => {
    const c = withGarminActivityRead(),
      f = c.garminActivityReadFacts?.facts[0];
    const port = c.garminActivityReadFacts;
    if (!f?.source || !port) throw Error('fixture');
    if (part === 'missing') delete c.garminActivityReadFacts;
    if (part === 'foreign') port.athleteId = 'foreign';
    if (part === 'lineage') c.sourcePermissionManifest.activityMediaPermissions.garminLineage = [];
    if (part === 'extra') port.facts.push({ ...f, requested: { ...f.requested, id: race } });
    if (part === 'duplicate') port.facts.push(structuredClone(f));
    if (part === 'body') f.source.originalDigest = 'd'.repeat(64);
    if (part === 'tuple') f.source.collection.provider = 'garmin-official';
    const reasons = fullManualActivityReasons(c);
    expect(
      reasons.some(
        (r) =>
          r.path.includes('garminActivityReadFacts') ||
          r.reason === 'actual_permission_port_missing' ||
          (part === 'tuple' && r.reason === 'invalid_capture'),
      ),
    ).toBe(true);
    if (part === 'foreign') blocked(c, 'scope_mismatch', 'garminActivityReadFacts');
  },
);
it('full ledger correspondence rejects forged local fallback for a consumed Garmin source', () => {
  const c = withLocalActivityRead(),
    m = routineReadManifestSchema.parse(c.routineActualManifest),
    r = m.actualRosters.activities[0];
  if (r?.source.state !== 'present') throw Error('fixture');
  c.sourcePermissionManifest.activityMediaPermissions.garminLineage = [
    {
      kind: 'fit',
      source_id: r.source.sourceId,
      provider: 'garmin-connect-unofficial',
      official: false,
      outcome: 'imported',
    },
  ];
  expect(
    fullManualActivityReasons(c).some((r) => r.reason === 'actual_permission_port_missing'),
  ).toBe(true);
});
