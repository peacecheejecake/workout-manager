import { expandRoutineSchedule } from '../src/routine-expansion.js';
import { raceManualPublicImpactSchema } from '@workout/contracts/race-manual-public-impact';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import { describe, expect, it } from 'vitest';
import { raceImpactConsumedCaptureSchema } from '../src/race-plan-impact-complete-manifest.js';
import {
  integratedDependencyKinds,
  impactDependencyDigest,
} from '../src/race-plan-impact-dependencies.js';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  projectRaceManualPublicImpact,
  RaceManualPublicImpactError,
} from '../src/race-manual-public-impact.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64),
  athlete = 'synthetic-impact',
  now = '2026-10-08T00:00:00.123456Z';
function fixture() {
  const absent = { state: 'absent' };
  const c = raceImpactConsumedCaptureSchema.parse({
    status: 'blocked',
    coverage: {
      complete: false,
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
    restoreGeneration: id(1),
    manualBasis: {
      purpose: 'manual_race_date_change',
      policy: { id: 'manual-race-date-impact', version: 1, digest: hash },
      app: { state: 'present', granted: true, revision: 1 },
    },
    event: {
      id: id(2),
      revision: 1,
      title: 'Race',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'UTC',
      locationName: 'Private location',
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
    collections: [
      { kind: 'race-event', revision: 1, privacy_generation: '0' },
      { kind: 'race-result', revision: 1, privacy_generation: '0' },
      { kind: 'training-best', revision: 1, privacy_generation: '0' },
    ],
    linkedPlan: null,
    currentTraining: null,
    completions: [],
    course: null,
    rosters: { nutrition: [], recovery: [], routine: [] },
    nutrition: [],
    recovery: [],
    routines: [],
    coreDependencies: {
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
    },
    dependencyInventory: integratedDependencyKinds.map((kind) => ({ kind, state: 'absent' })),
    supplementaryManifest: { sessions: [], copies: [], routines: [], exercises: [] },
    routineActualManifest: {
      uniqueSourceCount: 0,
      occurrences: [],
      runs: [],
      blueprints: [],
      schedules: [],
      actualRosters: { activities: [], intake: [], recovery: [] },
    },
    sourcePermissionManifest: {
      complete: false,
      planned: [],
      resources: [],
      catalog: [],
      nestedNutritionSources: [],
      activityMediaPermissions: {
        activities: [],
        garminLineage: [],
        healthkit: [],
        media: [],
        healthkitRegistry: absent,
        garmin: absent,
        garminUnofficial: absent,
        consents: ['provider', 'healthkit', 'media'].map((kind) => ({ kind, ...absent })),
      },
      aiConsent: absent,
      missing: [
        'unsupported_domain_item_membership',
        'immutable_training_aggregate_history',
        'media_cleanup_status_port',
        'media_and_provider_source_permissions',
        'manual_purpose_app_and_policy_binding',
      ],
    },
    consumedSources: { plans: [], races: [] },
    readSetDigest: hash,
    affected: { nutrition: [], routine: [] },
  });
  c.consumedSources.races = [structuredClone(c.event)];
  c.calendarIntent = {
    expectedEvent: { id: c.event.id, revision: c.event.revision },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' },
    resolutions: { nutrition: [], routines: [] },
  };
  return pin(c);
}
function pin(c: ReturnType<typeof raceImpactConsumedCaptureSchema.parse>) {
  const { status, coverage, readSetDigest, affected, ...set } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  c.readSetDigest = impactDependencyDigest({
    ...set,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  return { context: c, intent: c.calendarIntent };
}
function withNutrition(relative = true, disconnected = false) {
  const f = fixture();
  const c = f.context;
  const record = nutritionPlanVersionCompatibleV4Schema.parse({
    ...(disconnected ? { schemaVersion: 3, raceTimingPins: [], itemRaceTimingBindings: [] } : {}),
    planId: id(3),
    versionId: id(4),
    version: 1,
    previousVersionId: null,
    approvedAt: now,
    approvalId: id(5),
    period: { from: '2026-10-07', toInclusive: '2026-10-10' },
    purpose: 'Fuel',
    timezone: 'UTC',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: '식사-' + 'a'.repeat(201),
        planVersionId: id(4),
        category: 'before',
        title: 'Meal',
        anchor: disconnected
          ? { kind: 'disconnected', entity: 'race' }
          : relative
            ? {
                kind: 'relative',
                entity: 'race',
                entityId: c.event.id,
                point: 'start',
                offsetMinutes: -30,
              }
            : { kind: 'absolute', date: '2026-10-08', localTime: null, timezone: 'UTC' },
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
            sourceBasis: 'manual_total',
          },
        ],
        targets: [
          {
            metric: 'energy',
            amount: {
              min: 0,
              max: 100,
              unit: 'kcal',
              basis: 'user_confirmed',
              evidenceIds: ['PRIVATE_EVIDENCE_SENTINEL'],
            },
          },
        ],
        instructions: 'Fuel',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
  c.nutrition = [
    {
      aggregateId: record.planId,
      versionId: record.versionId,
      record,
      sourceRelation: 'absent',
      relativeItems: [],
    },
  ];
  c.rosters.nutrition = [{ aggregateId: record.planId, versionId: record.versionId }];
  return pin(c);
}

function allDomains() {
  const f = withNutrition();
  const c = f.context;
  const snapshot = planSnapshotSchema.parse({
    id: id(10),
    version: 1,
    createdAt: now,
    draft: {
      title: 'Train',
      timezone: 'UTC',
      periods: [
        {
          id: 'season',
          parentId: null,
          level: 'season',
          title: 'Season',
          startDate: '2026-10-07',
          endDateExclusive: '2026-10-11',
          timezone: 'UTC',
          intent: 'Build',
          isPartial: false,
        },
      ],
      sessions: [],
    },
  });
  c.currentTraining = { aggregateId: id(11), snapshot };
  c.consumedSources.plans = [snapshot];
  if (!c.calendarIntent) throw Error('fixture');
  c.calendarIntent.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: snapshot.id,
    periodId: 'season',
    newStartDate: '2026-10-08',
    scope: 'period_only',
  };
  const strategy = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: id(12),
    versionId: id(13),
    version: 1,
    previousVersionId: null,
    status: 'draft',
    selectedOptionId: null,
    createdAt: now,
    draft: {
      title: 'Recover',
      goal: 'Rest',
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-11',
      timezone: 'UTC',
      priority: 'normal',
      knownFacts: ['PRIVATE_ACTUAL_REPORT'],
      missingInformation: [],
      observations: [],
      planRefs: [{ kind: 'training', aggregateId: id(11), headVersionId: snapshot.id }],
      options: [
        {
          id: id(14),
          title: 'Rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: 'Rest',
        },
      ],
      reassessment: [
        {
          id: id(15),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Reassess',
          policyVersion: null,
        },
      ],
    },
  });
  c.recovery = [
    { aggregateId: strategy.strategyId, versionId: strategy.versionId, record: strategy },
  ];
  c.rosters.recovery = [{ aggregateId: strategy.strategyId, versionId: strategy.versionId }];
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: id(16),
    versionId: id(17),
    title: 'Checklist',
    intent: 'Review',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Ready',
        content: { kind: 'checklist', prompt: 'Ready?' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: 0,
    createdAt: now,
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: id(18),
    versionId: id(19),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-11',
      timezone: 'UTC',
      maxOccurrences: 10,
    },
    rule: { kind: 'period_days', periodId: 'season', offsetsDays: [0], localTime: null },
    state: 'active',
  });
  c.routines = [
    {
      aggregateId: schedule.id,
      versionId: schedule.versionId,
      record: schedule,
      sourceVersionId: snapshot.id,
      sourceRelation: 'current',
      affected: true,
    },
  ];
  c.rosters.routine = [{ aggregateId: schedule.id, versionId: schedule.versionId }];
  c.routineActualManifest.schedules = [
    {
      scheduleId: schedule.id,
      versionId: schedule.versionId,
      sourcePlanVersionId: snapshot.id,
      record: schedule,
      currentHead: { state: 'present', versionId: schedule.versionId, notificationMuted: false },
    },
  ];
  c.routineActualManifest.blueprints = [
    {
      record: blueprint,
      version: 1,
      currentHead: {
        state: 'present',
        versionId: blueprint.versionId,
        version: 1,
        visibility: 'active',
        favorite: false,
      },
      unsupportedContent: [],
    },
  ];
  return pin(c);
}
describe('actual pure projection to public impact', () => {
  it('maps actual empty builder output without private location/context', () => {
    const p = projectRaceManualPublicImpact(fixture());
    expect(p.status).toBe('projected');
    expect(JSON.stringify(p)).not.toContain('Private location');
    expect(p).not.toHaveProperty('context');
    expect(p).not.toHaveProperty('readSetDigest');
    expect(p).not.toHaveProperty('candidate');
  });
  it('keeps actual affected missing-start timing and exact requirement with long ID', () => {
    const p = projectRaceManualPublicImpact(withNutrition());
    if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
    expect(p.resolutionRequirements).toMatchObject([
      {
        domain: 'nutrition',
        aggregateId: id(3),
        planVersionId: id(4),
        reason: 'affected_timing_unresolved',
      },
    ]);
    expect(p.nutrition.members[0]?.timings[0]?.after).toEqual({
      state: 'unresolved',
      reason: 'missing_race_time',
    });
    expect(p.nutrition.members[0]?.before.plan.items[0]?.foods.map((f) => f.quantity)).toEqual([
      0,
      null,
    ]);
    expect(p.approvalAllowed).toBe(false);
    expect(JSON.stringify(p)).not.toContain('PRIVATE_EVIDENCE_SENTINEL');
    expect(p.nutrition.members[0]?.before.plan.items[0]?.targets).toEqual([
      { metric: 'energy', amount: { min: 0, max: 100, unit: 'kcal', basis: 'user_confirmed' } },
    ]);
  });
  it('exact explicit anchor resolves actual projector and still confers no approval', () => {
    const f = withNutrition();
    const item = f.context.nutrition[0]?.record.items[0];
    if (!item || !f.context.calendarIntent) throw Error('fixture');
    f.context.calendarIntent.resolutions.nutrition = [
      {
        planVersionId: id(4),
        itemId: item.id,
        action: 'replace_anchor',
        anchor: { kind: 'absolute', date: '2026-10-08', localTime: null, timezone: 'UTC' },
      },
    ];
    const p = projectRaceManualPublicImpact(pin(f.context));
    expect(p.status).toBe('projected');
    if (p.status !== 'projected') throw Error('fixture');
    expect(p.resolutionRequirements).toEqual([]);
    expect(p.approvalAllowed).toBe(false);
  });
  it('retains disconnected suspension and unchanged quantities', () => {
    const p = projectRaceManualPublicImpact(withNutrition(false, true));
    expect(p.status).toBe('projected');
    if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
    expect(p.notices[0]?.code).toBe('DISCONNECTED_RETAINED');
    expect(p.nutrition.members[0]?.timings[0]?.after.state).toBe('suspended');
  });
  it('rejects stale digest/original intent/event and supplied projection', () => {
    const f = fixture();
    f.context.readSetDigest = 'b'.repeat(64);
    expect(() => projectRaceManualPublicImpact(f)).toThrow(RaceManualPublicImpactError);
    const g = fixture();
    expect(() =>
      projectRaceManualPublicImpact({ ...g, intent: { ...g.intent, newLocalDate: '2026-10-10' } }),
    ).toThrow();
    expect(() =>
      projectRaceManualPublicImpact({ ...fixture(), projection: { status: 'projected' } }),
    ).toThrow();
  });
  it('rejects body/roster mismatch rather than exposing private foreign rows', () => {
    const f = withNutrition();
    f.context.rosters.nutrition = [];
    expect(() => projectRaceManualPublicImpact(pin(f.context))).toThrow();
    const g = fixture();
    g.context.consumedSources.races = [];
    expect(() => projectRaceManualPublicImpact(pin(g.context))).toThrow();
  });
  it('bounds unknown/getter/cycle before calculation', () => {
    let calls = 0;
    expect(() =>
      projectRaceManualPublicImpact({
        get context() {
          calls++;
          return {};
        },
        intent: {},
      }),
    ).toThrow();
    expect(calls).toBe(0);
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => projectRaceManualPublicImpact(c)).toThrow();
    expect(() => projectRaceManualPublicImpact({ text: '식'.repeat(1500000) })).toThrow();
  });
  it('maps real projector five domains and recovery reported state without actual reports', () => {
    const p = projectRaceManualPublicImpact(allDomains());
    expect(p.status).toBe('projected');
    if (p.status !== 'projected') throw Error('fixture');
    expect(p.training.state).toBe('present');
    expect(p.routines.state).toBe('present');
    expect(p.recovery.state).toBe('present');
    expect(p.nutrition.state).toBe('present');
    expect(p.affected).toContainEqual({ domain: 'training', aggregateId: id(11) });
    expect(p.affected).toContainEqual({ domain: 'recovery', aggregateId: id(12) });
    expect(p.resolutionRequirements).toContainEqual({
      domain: 'recovery',
      aggregateId: id(12),
      strategyVersionId: id(13),
      reason: 'recovery_confirmation_required',
      editor: 'confirm_recovery_and_review',
    });
    expect(JSON.stringify(p)).not.toContain('PRIVATE_ACTUAL_REPORT');
    if (p.recovery.state === 'present') expect(p.recovery.members[0]?.after.status).toBe('draft');
  });
  it('keeps stored unresolved occurrence distinct from resolved recomputation', () => {
    const f = allDomains(),
      c = f.context;
    const row = c.routines[0];
    if (!row || !c.currentTraining) throw Error('fixture');
    row.record.rule = {
      kind: 'period_days',
      periodId: 'season',
      offsetsDays: [0],
      localTime: '06:00',
    };
    const source = c.routineActualManifest.schedules[0];
    if (!source) throw Error('fixture');
    source.record = row.record;
    const computed = expandRoutineSchedule(row.record, c.currentTraining.snapshot.draft)[0];
    if (!computed) throw Error('fixture');
    c.routineActualManifest.occurrences = [
      {
        record: { ...computed, scheduledAt: null, timingStatus: 'unresolved' },
        currentSchedule: { state: 'present', versionId: row.versionId },
        startedRun: { state: 'absent' },
      },
    ];
    const p = projectRaceManualPublicImpact(pin(c));
    if (p.status !== 'projected' || p.routines.state !== 'present') throw Error('fixture');
    const r = p.routines.members[0];
    if (!r) throw Error('fixture');
    expect(r.before.expansion.state).toBe('expanded');
    expect(r.after.expansion.state).toBe('expanded');
    if (r.before.expansion.state === 'expanded')
      expect(r.before.expansion.occurrences[0]?.timingStatus).toBe('resolved');
    expect(r.storedOccurrences[0]).toMatchObject({
      occurrenceId: computed.id,
      timingStatus: 'unresolved',
      scheduledAt: null,
      unresolvedReason: null,
      sourcePlanVersionId: c.currentTraining.snapshot.id,
    });
    expect(r.requirement).toBe('resolve_before_review');
    expect(p.resolutionRequirements).toContainEqual({
      domain: 'routine_schedule',
      aggregateId: row.aggregateId,
      scheduleVersionId: row.versionId,
      reason: 'affected_timing_unresolved',
      editor: 'replace_rule',
    });
    if (!c.calendarIntent) throw Error('fixture');
    c.calendarIntent.selection = { kind: 'keep_plan' };
    const unchanged = projectRaceManualPublicImpact(pin(c));
    if (unchanged.status !== 'projected' || unchanged.routines.state !== 'present')
      throw Error('fixture');
    expect(unchanged.routines.members[0]?.requirement).toBe('none');
    expect(unchanged.notices).toContainEqual({
      domain: 'routine_schedule',
      aggregateId: row.aggregateId,
      itemId: null,
      code: 'UNCHANGED_UNRESOLVED',
    });
    const stored = r.storedOccurrences[0];
    if (!stored) throw Error('fixture');
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        routines: {
          state: 'present',
          members: [
            { ...r, storedOccurrences: [{ ...stored, actuals: [{ raw: 'PRIVATE_ACTUAL' }] }] },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        routines: {
          state: 'present',
          members: [
            {
              ...r,
              storedOccurrences: [{ ...stored, schedule: { ...stored.schedule, id: id(88) } }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
