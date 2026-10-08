import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { coreEvidenceDependencyManifestSchema } from '@workout/contracts/evidence-dependencies';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import type { RaceManualApprovalWrite } from '@workout/contracts/race-manual-approval';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import { expandRoutineSchedule } from '../src/routine-expansion.js';
import { routineRunSchema } from '@workout/contracts/routines';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
  domainPlanRefSchema,
} from '@workout/contracts/routines';
import { supplementarySessionLinkSchema } from '@workout/contracts/supplementary-core';
import { courseReadManifestSchema } from '../src/race-plan-impact-course-manifest.js';
import {
  integratedDependencyKinds,
  impactDependencyDigest,
} from '../src/race-plan-impact-dependencies.js';
import { raceImpactConsumedCaptureSchema } from '../src/race-plan-impact-complete-manifest.js';
import {
  buildRacePlanImpactProjectionInput,
  createRacePlanImpactCapturedCalculationPorts,
  type RaceProjectionCapture,
} from '../src/race-plan-impact-projection-input.js';
import { assembleRaceManualReviewCandidateCompatibleV4 } from '@workout/server-coaching/race-manual-review-candidate-v2';
import {
  projectRaceManualPublicPreview,
  RaceManualPublicPreviewError,
} from '../src/race-manual-public-preview.js';
const athlete = 'synthetic-manual',
  generation = '00000000-0000-4000-8000-000000000001',
  race = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const hash = '1'.repeat(64),
  now = '2026-10-08T00:00:00.123456Z';
const absent = () => ({ state: 'absent' as const });
const jsonRows = () => z.array(z.json()).parse([]);
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

// Synthetic strict stored input: these pure units do not prove SQL source ownership.
function inputFixture(
  allDomains = false,
  disconnected = false,
  move = false,
  large = false,
  unordered = false,
) {
  const c = raceImpactConsumedCaptureSchema.parse(fixture());
  c.calendarIntent = {
    expectedEvent: { id: race, revision: 1 },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' },
    resolutions: { nutrition: [], routines: [] },
  };
  c.consumedSources.races = [structuredClone(c.event)];
  const record = nutritionPlanVersionCompatibleV4Schema.parse({
    ...(disconnected ? { schemaVersion: 3, raceTimingPins: [], itemRaceTimingBindings: [] } : {}),
    planId: id(1),
    versionId: id(2),
    version: 1,
    previousVersionId: null,
    approvedAt: now,
    approvalId: id(3),
    period: { from: '2026-10-07', toInclusive: '2026-10-10' },
    timezone: 'Asia/Seoul',
    purpose: 'Fuel',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'Meal-食-' + 'x'.repeat(201),
        planVersionId: id(2),
        category: 'meal',
        title: 'Meal',
        anchor: disconnected
          ? { kind: 'disconnected', entity: 'race' }
          : { kind: 'absolute', date: '2026-10-08', localTime: null, timezone: 'Asia/Seoul' },
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
        targets: [],
        instructions: 'Eat',
        evidenceIds: ['private-evidence'],
        source: 'user_confirmed',
      },
    ],
  });
  if (unordered) {
    const first = record.items[0];
    if (!first) throw Error('Item required');
    record.items = [
      { ...first, id: 'Z-meal' },
      { ...first, id: 'A-meal' },
    ];
  }
  if (large) {
    const base = record.items[0];
    if (!base) throw Error('Item required');
    record.items = Array.from({ length: 160 }, (_, index) => ({ ...base, id: `item-${index}` }));
  }
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
  if (allDomains) {
    const snapshot = planSnapshotSchema.parse({
      id: id(10),
      version: 1,
      createdAt: now,
      draft: {
        title: 'Train',
        timezone: 'Asia/Seoul',
        periods: [
          {
            id: 'season',
            parentId: null,
            level: 'season',
            title: 'Season',
            startDate: '2026-10-07',
            endDateExclusive: '2026-10-11',
            timezone: 'Asia/Seoul',
            intent: 'Build',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    });
    c.currentTraining = { aggregateId: id(11), snapshot };
    if (move)
      c.calendarIntent.selection = {
        kind: 'move_period',
        expectedCurrentPlanVersionId: snapshot.id,
        periodId: 'season',
        newStartDate: '2026-10-08',
        scope: 'period_only',
      };
    c.consumedSources.plans = [snapshot];
    const strategy = recoveryStrategyVersionSchema.parse({
      schemaVersion: 1,
      strategyId: id(12),
      versionId: id(13),
      version: 1,
      previousVersionId: null,
      status: 'user_confirmed',
      selectedOptionId: id(14),
      createdAt: now,
      draft: {
        title: 'Recover',
        goal: 'Rest',
        startDate: '2026-10-07',
        endDateExclusive: '2026-10-11',
        timezone: 'Asia/Seoul',
        priority: 'normal',
        knownFacts: ['PRIVATE_ACTUAL_REPORT'],
        missingInformation: [],
        observations: [],
        planRefs: [],
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
        timezone: 'Asia/Seoul',
        maxOccurrences: 10,
      },
      rule: { kind: 'dates', dates: ['2026-10-08'], localTime: null },
      state: 'active',
    });
    c.routines = [
      {
        aggregateId: schedule.id,
        versionId: schedule.versionId,
        record: schedule,
        sourceVersionId: null,
        sourceRelation: 'absent',
        affected: false,
      },
    ];
    c.rosters.routine = [{ aggregateId: schedule.id, versionId: schedule.versionId }];
    c.routineActualManifest.schedules = [
      {
        scheduleId: schedule.id,
        versionId: schedule.versionId,
        sourcePlanVersionId: null,
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
    const occurrence = expandRoutineSchedule(schedule, null)[0];
    if (!occurrence) throw Error('Occurrence required');
    c.routineActualManifest.occurrences = [
      {
        record: occurrence,
        currentSchedule: { state: 'present', versionId: schedule.versionId },
        startedRun: { state: 'present', runId: id(20), revision: 0 },
      },
    ];
    const run = routineRunSchema.parse({
      id: id(20),
      revision: 0,
      blueprint: schedule.blueprint,
      origin: { kind: 'planned', occurrenceId: occurrence.id },
      state: 'in_progress',
      progress: [],
      selectedChoices: {},
      startedAt: now,
      endedAt: null,
    });
    const unplanned = routineRunSchema.parse({ ...run, id: id(21), origin: { kind: 'unplanned' } });
    c.routineActualManifest.runs = [
      { record: run, actuals: [], historyDigest: hash },
      { record: unplanned, actuals: [], historyDigest: hash },
    ];
  }
  const { status, coverage, readSetDigest, affected, ...readSet } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  c.readSetDigest = impactDependencyDigest({
    ...readSet,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  const projectionCapture: RaceProjectionCapture = {
    ...c,
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
    nutrition: c.nutrition.map((row) => ({ ...row, relativeItems: [] })),
    routineActualManifest: {
      ...c.routineActualManifest,
      blueprints: c.routineActualManifest.blueprints.map((row) => ({
        ...row,
        unsupportedContent: [],
      })),
    },
  };
  const built = buildRacePlanImpactProjectionInput(projectionCapture, c.calendarIntent);
  if (built.status !== 'projected') throw Error('Fixture projection required');
  const sourceInput = {
    athleteId: athlete,
    binding: {
      purpose: 'manual_race_date_change',
      event: { id: race, revision: 1 },
      appRevision: 1,
      policy: c.manualBasis.policy,
      restoreGeneration: generation,
      readSetDigest: c.readSetDigest,
    },
    projectionInput: built.input,
    sourceFacts: { ownerAthleteId: athlete, nutritionRacePins: [] },
  };
  const candidate = assembleRaceManualReviewCandidateCompatibleV4(
    sourceInput,
    createRacePlanImpactCapturedCalculationPorts(projectionCapture),
  );
  if (candidate.status !== 'assembled_readonly')
    throw Error('Fixture assembly required:' + candidate.reason);
  const chain = {
    evidenceId: id(31),
    decisionId: id(32),
    proposalId: id(33),
    readonlyCandidateDigest: candidate.digest,
  };
  const reference = {
    schemaVersion: 1,
    candidateId: id(30),
    applicationDigest: hash,
    chain,
    createdAt: now,
  };
  const writes: RaceManualApprovalWrite[] =
    move && c.currentTraining && candidate.body.projection.calendar.plan
      ? [
          {
            domain: 'training',
            aggregateId: c.currentTraining.aggregateId,
            expectedHead: {
              kind: 'exists',
              versionId: c.currentTraining.snapshot.id,
              version: c.currentTraining.snapshot.version,
            },
            proposed: candidate.body.projection.calendar.plan,
          },
        ]
      : [];
  const application = {
    schemaVersion: 1,
    candidateId: id(30),
    chain,
    applicationDigest: hash,
    createdAt: now,
    raceChange: { eventId: race, expectedRevision: 1, newLocalDate: '2026-10-09' },
    expectation: {
      restoreGeneration: generation,
      appRevision: 1,
      manualPolicy: c.manualBasis.policy,
      semanticDigest: hash,
      heads: {
        training: c.currentTraining
          ? {
              state: 'present',
              members: [
                {
                  aggregateId: c.currentTraining.aggregateId,
                  head: {
                    kind: 'exists',
                    versionId: c.currentTraining.snapshot.id,
                    version: c.currentTraining.snapshot.version,
                  },
                },
              ],
            }
          : absent(),
        nutrition: {
          state: 'present',
          members: [
            {
              aggregateId: record.planId,
              head: { kind: 'exists', versionId: record.versionId, version: 1 },
            },
          ],
        },
        recovery: c.recovery.length
          ? {
              state: 'present',
              members: c.recovery.map((r) => ({
                aggregateId: r.aggregateId,
                head: { kind: 'exists', versionId: r.versionId, version: r.record.version },
              })),
            }
          : absent(),
        routine_schedule: c.routines.length
          ? {
              state: 'present',
              members: c.routines.map((r) => ({
                aggregateId: r.aggregateId,
                head: { kind: 'exists', versionId: r.versionId },
              })),
            }
          : absent(),
      },
    },
    authority: 'server_revalidation_required',
    applicationState: 'ready_for_explicit_approval',
    scope: 'whole_affected',
    affected: writes.map(({ domain, aggregateId }) => ({ domain, aggregateId })),
    writes,
    notices: [],
  };
  return {
    reference,
    bodyState: 'present',
    candidate: application,
    preparation: {
      context: c,
      sourceInput,
      candidate,
    },
  };
}
describe('public preview pure stored projection', () => {
  it('projects frozen nutrition actual-null/zero and long IDs while omitting private source/evidence', () => {
    const raw = inputFixture(),
      out = projectRaceManualPublicPreview(raw);
    expect(out.status).toBe('present');
    if (out.status !== 'present' || out.nutrition.state !== 'present')
      throw Error('Present nutrition required');
    const member = out.nutrition.members[0];
    if (!member) throw Error('Member required');
    expect(member.before.plan.items[0]?.foods.map((f) => f.quantity)).toEqual([0, null]);
    expect(member.before.plan.items[0]?.id.length).toBeGreaterThan(201);
    expect(member.after.kind).toBe('retained');
    expect(out.race.before.localDate).toBe('2026-10-07');
    expect(out.race.after.localDate).toBe('2026-10-09');
    expect(out.freshness).toBe('not_checked_on_read');
    expect(JSON.stringify(out)).not.toContain('private-evidence');
    expect(JSON.stringify(out)).not.toContain('sourcePermissionManifest');
    expect(JSON.stringify(out)).not.toContain('semanticDigest');
    expect(raw.preparation.context.event.localDate).toBe('2026-10-07');
  });
  it('maps all five public domains and historical started plus parentless unplanned runs without actual report leakage', () => {
    const raw = inputFixture(true),
      out = projectRaceManualPublicPreview(raw);
    if (out.status !== 'present') throw Error('Present required');
    expect(out.training.state).toBe('present');
    expect(out.recovery.state).toBe('present');
    expect(out.routines.state).toBe('present');
    expect(out.retainedUnplanned).toEqual([
      { runId: id(21), blueprintVersionId: id(17), preservation: 'unplanned_run_unchanged' },
    ]);
    if (out.routines.state === 'present')
      expect(out.routines.members[0]?.retainedStarted[0]?.runId).toBe(id(20));
    expect(JSON.stringify(out)).not.toContain('PRIVATE_ACTUAL_REPORT');
    expect(JSON.stringify(out)).not.toContain('progress');
    expect(out.notices).toContainEqual({
      domain: 'routine_schedule',
      aggregateId: id(18),
      itemId: null,
      code: 'STARTED_RUN_PRESERVED',
    });
  });
  it('shows exact frozen training before and hypothetical date move without applying it', () => {
    const raw = inputFixture(true, false, true),
      out = projectRaceManualPublicPreview(raw);
    if (out.status !== 'present' || out.training.state !== 'present')
      throw Error('Training required');
    expect(out.training.members[0]?.before.plan.periods[0]?.startDate).toBe('2026-10-07');
    expect(out.training.members[0]?.after.plan.periods[0]?.startDate).toBe('2026-10-08');
    expect(out.affected).toEqual([{ domain: 'training', aggregateId: id(11) }]);
    expect(raw.preparation.context.currentTraining?.snapshot.draft.periods[0]?.startDate).toBe(
      '2026-10-07',
    );
  });
  it('preserves disconnected food and operational suspension without time fallback or repinning', () => {
    const out = projectRaceManualPublicPreview(inputFixture(false, true));
    if (out.status !== 'present' || out.nutrition.state !== 'present')
      throw Error('Nutrition required');
    const row = out.nutrition.members[0];
    if (!row) throw Error('Member required');
    expect(row.before.plan.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
    expect(row.timings[0]?.before).toEqual({
      state: 'suspended',
      reason: 'race_disconnected',
      resume: 'explicit_reconnect_and_reapproval_required',
    });
    expect(row.timings[0]?.after).toEqual(row.timings[0]?.before);
    expect(out.notices).toEqual([
      {
        domain: 'nutrition',
        aggregateId: id(1),
        itemId: row.before.plan.items[0]?.id,
        code: 'DISCONNECTED_RETAINED',
      },
    ]);
  });
  it('rejects forged expected heads and altered private current dependency digest', () => {
    const raw = inputFixture(true);
    expect(() =>
      projectRaceManualPublicPreview({
        ...raw,
        candidate: {
          ...raw.candidate,
          expectation: {
            ...raw.candidate.expectation,
            heads: { ...raw.candidate.expectation.heads, training: absent() },
          },
        },
      }),
    ).toThrow();
    raw.preparation.context.coreDependencies.activities.count = '1';
    expect(() => projectRaceManualPublicPreview(raw)).toThrow();
  });
  it('renders the exact160-item frozen plan below4MiB without truncating or exposing private evidence', () => {
    // The existing strict version and actual builder/assembler fixture supply
    // the frozen retained source. JSON value count is not a source-ref count.
    const raw = inputFixture(false, false, false, true);
    const out = projectRaceManualPublicPreview(raw);
    if (out.status !== 'present' || out.nutrition.state !== 'present')
      throw Error('Exact nutrition preview required');
    const row = out.nutrition.members[0];
    if (!row) throw Error('Exact nutrition member required');
    const expected = Array.from({ length: 160 }, (_, i) => `item-${i}`);
    expect(row.before.plan.items.map((item) => item.id)).toEqual(expected);
    expect(row.after.plan.items).toEqual(row.before.plan.items);
    // Timing rows are an indexed roster normalized by the existing assembler;
    // ordered planned items above remain in their original source order.
    expect(row.timings.map((item) => item.itemId)).toEqual([...expected].sort());
    for (const item of row.before.plan.items)
      expect(item.foods.map((food) => food.quantity)).toEqual([0, null]);
    expect(out.reference).toEqual(raw.reference);
    for (const field of ['context', 'basis', 'lifecycle', 'sourceInput', 'sqlObservations'])
      expect(out).not.toHaveProperty(field);
    expect(JSON.stringify(out)).not.toContain('private-evidence');
    expect(raw.preparation.context.nutrition[0]?.record.items).toHaveLength(160);
  });
  it('accepts assembler set normalization while preserving ordered unchanged nutrition items', () => {
    const raw = inputFixture(false, false, false, false, true),
      out = projectRaceManualPublicPreview(raw);
    if (out.status !== 'present' || out.nutrition.state !== 'present')
      throw Error('Nutrition required');
    expect(out.nutrition.members[0]?.before.plan.items.map((item) => item.id)).toEqual([
      'Z-meal',
      'A-meal',
    ]);
    expect(out.nutrition.members[0]?.after.plan.items.map((item) => item.id)).toEqual([
      'Z-meal',
      'A-meal',
    ]);
  });
  it('purged input contains only durable original reference, with all body fields null', () => {
    const raw = inputFixture();
    expect(
      projectRaceManualPublicPreview({
        reference: raw.reference,
        bodyState: 'purged',
        candidate: null,
        preparation: null,
      }),
    ).toEqual({
      schemaVersion: 1,
      status: 'unavailable',
      reference: raw.reference,
      reason: 'review_body_purged',
      preview: null,
    });
  });
  it.each(['candidate', 'preparation'])('present missing %s is invalid, not purged', (field) => {
    const raw = inputFixture();
    expect(() => projectRaceManualPublicPreview({ ...raw, [field]: null })).toThrow(
      RaceManualPublicPreviewError,
    );
  });
  it.each(['applicationDigest', 'createdAt'])('denies mismatched durable %s', (field) => {
    const raw = inputFixture();
    expect(() =>
      projectRaceManualPublicPreview({
        ...raw,
        reference: {
          ...raw.reference,
          [field]: field === 'createdAt' ? '2026-10-09T00:00:00Z' : '2'.repeat(64),
        },
      }),
    ).toThrow(RaceManualPublicPreviewError);
  });
  it('rejects changed frozen before instead of consulting a live head', () => {
    const raw = inputFixture();
    raw.preparation.context.event.title = 'Changed';
    expect(() => projectRaceManualPublicPreview(raw)).toThrow(RaceManualPublicPreviewError);
  });
  it('rejects reference chain mix-up and unknown private envelope fields', () => {
    const raw = inputFixture();
    expect(() =>
      projectRaceManualPublicPreview({
        ...raw,
        reference: { ...raw.reference, chain: { ...raw.reference.chain, evidenceId: id(99) } },
      }),
    ).toThrow();
    expect(() => projectRaceManualPublicPreview({ ...raw, liveHeads: [] })).toThrow();
  });
  it('purge cannot retain copied body', () => {
    const raw = inputFixture();
    expect(() => projectRaceManualPublicPreview({ ...raw, bodyState: 'purged' })).toThrow();
  });
  it('rejects accessors before evaluation and oversized inputs without truncation', () => {
    let calls = 0;
    const raw = Object.defineProperty({}, 'reference', {
      enumerable: true,
      get() {
        calls++;
        return null;
      },
    });
    expect(() => projectRaceManualPublicPreview(raw)).toThrow();
    expect(calls).toBe(0);
    expect(() => projectRaceManualPublicPreview('x'.repeat(4194305))).toThrow();
  });
});
