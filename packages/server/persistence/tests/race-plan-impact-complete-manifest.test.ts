import { expect, it } from 'vitest';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { coreEvidenceDependencyManifestSchema } from '@workout/contracts/evidence-dependencies';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
  domainPlanRefSchema,
} from '@workout/contracts/routines';
import { supplementarySessionLinkSchema } from '@workout/contracts/supplementary-core';
import {
  integratedDependencyKinds,
  impactDependencyDigest,
} from '../src/race-plan-impact-dependencies.js';
import {
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
  return {
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
    completions: jsonRows(),
    course: null,
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
            startedRun: z.strictObject({ state: z.literal('absent') }),
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
  blocked(c, 'unsupported_consumed_channel', 'sourcePermissionManifest.catalog');
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
  blocked(c, 'unsupported_consumed_channel', 'recovery');
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
  blocked(c, 'permission_port_missing', 'activityMediaPermissions.media');
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
  blocked(c, 'permission_port_missing', 'supplementaryManifest.exercises.permissions');
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
  blocked(c, 'unsupported_consumed_channel', 'routineActualManifest.runs');
});
it('consumed media still requires its missing cleanup port when unused consent is granted or withdrawn', () => {
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
    blocked(c, 'permission_port_missing', 'activityMediaPermissions.media');
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
