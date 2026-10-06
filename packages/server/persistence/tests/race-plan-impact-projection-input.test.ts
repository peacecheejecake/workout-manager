import { expect, it } from 'vitest';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import {
  buildRacePlanImpactProjectionInput,
  type RaceProjectionCapture,
} from '../src/race-plan-impact-projection-input.js';

const planId = '10000000-0000-4000-8000-000000000001';
const eventId = '20000000-0000-4000-8000-000000000001';
const nutritionId = '30000000-0000-4000-8000-000000000001';
function fixture(): RaceProjectionCapture {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const plan = planSnapshotSchema.parse({
    id: planId,
    version: 1,
    createdAt: '2026-03-01T00:00:00Z',
    draft: {
      title: 'Synthetic plan',
      timezone: 'America/New_York',
      periods: levels.map((level, index) => ({
        id: level,
        parentId: index === 0 ? null : levels[index - 1],
        level,
        title: level,
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: eventId,
          blockId: 'block',
          date: '2026-03-07',
          localStartTime: '07:00:00',
          title: 'Synthetic',
          sport: 'running',
          durationSeconds: 3600,
          distanceMeters: 0,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
  const event = raceEventSchema.parse({
    id: eventId,
    revision: 1,
    title: 'Synthetic event',
    localDate: '2026-03-07',
    localStartTime: '07:00:00',
    timezone: 'America/New_York',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: planId,
  });
  const record = nutritionPlanVersionSchema.parse({
    planId: '30000000-0000-4000-8000-000000000002',
    versionId: nutritionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-03-01', toInclusive: '2026-03-31' },
    timezone: 'America/New_York',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: planId,
    approvedAt: '2026-03-01T00:00:00Z',
    approvalId: nutritionId,
    items: ['race', 'session'].map((entity) => ({
      id: entity,
      planVersionId: nutritionId,
      category: 'before',
      title: 'Synthetic',
      anchor: { kind: 'relative', entity, entityId: eventId, point: 'start', offsetMinutes: 0 },
      foods: [],
      targets: [],
      instructions: 'Synthetic',
      evidenceIds: [],
      source: 'user_confirmed',
    })),
  });
  return {
    athleteId: 'synthetic-athlete',
    event,
    currentTraining: { aggregateId: planId, snapshot: plan },
    linkedPlan: plan,
    completions: [],
    nutrition: [
      {
        aggregateId: '30000000-0000-4000-8000-000000000002',
        versionId: nutritionId,
        record,
        sourceRelation: 'current',
        relativeItems: [],
      },
    ],
    routineActualManifest: { schedules: [], blueprints: [], occurrences: [], runs: [] },
    readSetDigest: 'a'.repeat(64),
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
  };
}
function intent(capture: RaceProjectionCapture, move = false) {
  return {
    expectedEvent: { id: capture.event.id, revision: capture.event.revision },
    newLocalDate: '2026-03-09',
    selection: move
      ? {
          kind: 'move_period',
          expectedCurrentPlanVersionId: planId,
          periodId: 'season',
          newStartDate: '2026-03-03',
          scope: 'descendants_and_sessions',
        }
      : { kind: 'keep_plan' },
  };
}
function projected(capture = fixture(), move = false) {
  const result = buildRacePlanImpactProjectionInput(capture, intent(capture, move));
  if (result.status !== 'projected') throw new Error(result.reason);
  return result;
}
it('uses real resolver before/after and preserves same UUID race/session namespaces', () => {
  const result = projected();
  expect(result.projection.nutrition[0]?.items).toMatchObject([
    {
      itemId: 'race',
      state: 'affected',
      before: { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
      after: { state: 'resolved', date: '2026-03-09', localTime: '07:00:00' },
    },
    {
      itemId: 'session',
      state: 'unchanged',
      before: { date: '2026-03-07' },
      after: { date: '2026-03-07' },
    },
  ]);
  expect(result.collectorSelection).toEqual({ kind: 'keep_plan' });
  expect(result.sourceFacts.nutritionRacePins).toEqual([
    { nutritionVersionId: nutritionId, itemId: 'race', binding: { state: 'legacy_unpinned' } },
  ]);
  expect(result).toMatchObject({
    approvalAllowed: false,
    coverageComplete: false,
    coverage: { complete: false },
  });
});
it('derives only moved sessions/periods from actual calendar, never from caller IDs', () => {
  const result = projected(fixture(), true);
  expect(result.collectorSelection).toEqual({
    kind: 'move_period',
    expectedCurrentPlanVersionId: planId,
    changedSessionIds: [eventId],
    movedPeriodIds: ['block', 'phase', 'season', 'wave'],
  });
  expect(result.projection.nutrition[0]?.items).toMatchObject([
    { state: 'affected' },
    { state: 'affected', after: { date: '2026-03-09' } },
  ]);
  const capture = fixture();
  expect(
    buildRacePlanImpactProjectionInput(capture, {
      ...intent(capture, true),
      changedSessionIds: ['forged'],
    }),
  ).toMatchObject({ status: 'blocked', reason: 'invalid_input_or_capture' });
});
it('preserves unaffected existing unresolved and blocks affected existing unresolved', () => {
  const capture = fixture();
  const plan = capture.currentTraining?.snapshot;
  if (!plan) throw new Error('Missing plan');
  plan.draft.sessions = plan.draft.sessions.map((session) => ({
    ...session,
    localStartTime: null,
  }));
  capture.linkedPlan = structuredClone(plan);
  const kept = projected(capture);
  expect(kept.projection.nutrition[0]?.items[1]).toMatchObject({
    state: 'unchanged',
    notice: 'existing_unresolved_preserved',
    before: { state: 'unresolved' },
  });
  expect(kept.projection.requiresResolution).toBe(false);
  const moved = projected(capture, true);
  expect(moved.projection.nutrition[0]?.items[1]).toMatchObject({
    notice: 'affected_unresolved_requires_resolution',
  });
  expect(moved.projection.requiresResolution).toBe(true);
});
it('keeps race end unknown even with zero target and allows explicit resolution without approval', () => {
  const capture = fixture();
  const row = capture.nutrition[0];
  if (!row) throw new Error('Missing nutrition');
  row.record.items = row.record.items.map((item) =>
    item.id === 'race' && item.anchor.kind === 'relative'
      ? { ...item, anchor: { ...item.anchor, point: 'end' } }
      : item,
  );
  expect(projected(capture).projection.requiresResolution).toBe(true);
  const result = buildRacePlanImpactProjectionInput(capture, {
    ...intent(capture),
    resolutions: {
      nutrition: [
        {
          planVersionId: nutritionId,
          itemId: 'race',
          action: 'replace_anchor',
          anchor: {
            kind: 'absolute',
            date: '2026-03-09',
            localTime: '08:00:00',
            timezone: 'America/New_York',
          },
        },
      ],
      routines: [],
    },
  });
  expect(result).toMatchObject({
    status: 'projected',
    approvalAllowed: false,
    projection: { requiresResolution: false },
  });
});
it('never substitutes current Plan for a missing exact historical body', () => {
  const capture = fixture();
  const row = capture.nutrition[0];
  if (!row) throw new Error('Missing row');
  const historical = '10000000-0000-4000-8000-000000000002';
  row.record.linkedTrainingPlanVersionId = historical;
  row.sourceRelation = 'historical';
  expect(buildRacePlanImpactProjectionInput(capture, intent(capture))).toMatchObject({
    status: 'blocked',
    reason: 'missing_facts',
    missingFacts: expect.arrayContaining([{ kind: 'source_plan_body', id: historical }]),
  });
});
it('does not fabricate another race body from its ID/digest', () => {
  const capture = fixture();
  const row = capture.nutrition[0];
  if (!row) throw new Error('Missing row');
  const other = '20000000-0000-4000-8000-000000000002';
  row.record.items = row.record.items.map((item) =>
    item.id === 'race' && item.anchor.kind === 'relative'
      ? { ...item, anchor: { ...item.anchor, entityId: other } }
      : item,
  );
  expect(buildRacePlanImpactProjectionInput(capture, intent(capture))).toMatchObject({
    status: 'blocked',
    reason: 'missing_facts',
    missingFacts: expect.arrayContaining([{ kind: 'race_anchor_body', id: other }]),
  });
});
it('checks expected event/current Plan and conflicting exact body identity', () => {
  const capture = fixture();
  expect(
    buildRacePlanImpactProjectionInput(capture, {
      ...intent(capture),
      expectedEvent: { id: eventId, revision: 2 },
    }),
  ).toMatchObject({ reason: 'event_revision_conflict' });
  const value = intent(capture, true);
  expect(
    buildRacePlanImpactProjectionInput(capture, {
      ...value,
      selection: {
        ...value.selection,
        expectedCurrentPlanVersionId: '10000000-0000-4000-8000-000000000002',
      },
    }),
  ).toMatchObject({ status: 'blocked' });
  if (!capture.linkedPlan) throw new Error('Missing linked');
  capture.linkedPlan = structuredClone(capture.linkedPlan);
  capture.linkedPlan.draft.title = 'Conflicting body';
  expect(buildRacePlanImpactProjectionInput(capture, intent(capture))).toMatchObject({
    reason: 'source_identity_mismatch',
  });
});
it('preserves input and deterministic projection for reordered outer capture contexts', () => {
  const capture = fixture();
  const row = capture.nutrition[0];
  if (!row) throw new Error('Missing row');
  const second = structuredClone(row);
  second.aggregateId = '30000000-0000-4000-8000-000000000004';
  second.versionId = '30000000-0000-4000-8000-000000000003';
  second.record.planId = second.aggregateId;
  second.record.versionId = second.versionId;
  second.record.items = second.record.items.map((item) => ({
    ...item,
    planVersionId: second.versionId,
  }));
  capture.nutrition.push(second);
  const before = structuredClone(capture);
  const first = projected(capture);
  expect(capture).toEqual(before);
  const reversed = structuredClone(capture);
  reversed.nutrition.reverse();
  const other = projected(reversed);
  expect(other.projection).toEqual(first.projection);
  expect(other.sourceFacts).toEqual(first.sourceFacts);
});
it('bounds captured bytes and total references before projection', () => {
  const capture = fixture();
  capture.athleteId = 'x'.repeat(4194304);
  expect(buildRacePlanImpactProjectionInput(capture, intent(capture))).toMatchObject({
    reason: 'projection_bound',
  });
  const large = fixture();
  const row = large.nutrition[0];
  const item = row?.record.items[0];
  if (!row || !item) throw new Error('Missing row');
  row.record.items = Array.from({ length: 5001 }, (_, index) => ({ ...item, id: String(index) }));
  expect(buildRacePlanImpactProjectionInput(large, intent(large))).toMatchObject({
    reason: 'projection_bound',
  });
});

it('preserves completed self-report and derives no moved ID for its locked actual schedule', () => {
  const capture = fixture();
  capture.completions = [
    sessionCompletionSchema.parse({
      sessionId: eventId,
      revision: 1,
      planVersionId: planId,
      schedule: {
        blockId: 'block',
        date: '2026-03-07',
        localStartTime: '07:00:00',
        timezone: 'America/New_York',
      },
      status: 'completed',
      reportedAt: '2026-03-07T13:00:00Z',
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    }),
  ];
  const result = projected(capture, true);
  expect(result.input.completionReports).toEqual(capture.completions);
  expect(result.collectorSelection).toMatchObject({ changedSessionIds: [] });
  expect(result.projection.calendar.fixedSessionIds).toContain(eventId);
  expect(result.projection.nutrition[0]?.items[1]).toMatchObject({
    state: 'unchanged',
    after: { date: '2026-03-07' },
  });
});
it('uses linked historical body when actually captured, separately from current Plan', () => {
  const capture = fixture();
  if (!capture.currentTraining) throw new Error('Missing current');
  capture.currentTraining = structuredClone(capture.currentTraining);
  capture.currentTraining.snapshot.id = '10000000-0000-4000-8000-000000000002';
  capture.currentTraining.snapshot.draft.sessions =
    capture.currentTraining.snapshot.draft.sessions.map((session) => ({
      ...session,
      date: '2026-03-12',
    }));
  const row = capture.nutrition[0];
  if (!row) throw new Error('Missing row');
  row.sourceRelation = 'historical';
  const result = projected(capture);
  expect(result.input.sourcePlans).toHaveLength(2);
  expect(result.projection.nutrition[0]?.items[1]).toMatchObject({
    before: { date: '2026-03-07' },
    after: { date: '2026-03-07' },
  });
});
function withRoutine() {
  const capture = fixture();
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: 'blueprint',
    versionId: 'blueprint-v1',
    title: 'Frozen synthetic',
    intent: '',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Checklist',
        content: { kind: 'checklist', prompt: 'Synthetic' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-03-01T00:00:00Z',
  });
  const record = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: 'schedule',
    versionId: 'schedule-v1',
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-03-01',
      endDateExclusive: '2026-04-01',
      timezone: 'America/New_York',
      maxOccurrences: 2,
    },
    rule: { kind: 'session_links', sessionIds: [eventId], point: 'start', offsetMinutes: 0 },
    state: 'active',
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: 'occurrence',
    schedule: { id: record.id, versionId: record.versionId },
    blueprint: record.blueprint,
    anchorKey: `${eventId}:start`,
    scheduledAt: '2026-03-07T12:00:00Z',
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  const actualRef = {
    kind: 'checklist_confirmation',
    id: 'confirmation',
    revisionId: 'confirmation-v1',
  } as const;
  const run = routineRunSchema.parse({
    id: 'run',
    revision: 1,
    blueprint: record.blueprint,
    origin: { kind: 'planned', occurrenceId: occurrence.id },
    state: 'stopped',
    progress: [
      {
        stepId: 'step',
        revision: 1,
        recordedAt: '2026-03-07T12:00:00Z',
        state: 'stopped',
        actualRefs: [actualRef],
        occurredAt: '2026-03-07T12:00:00Z',
        reason: 'Synthetic stop',
      },
    ],
    selectedChoices: {},
    startedAt: '2026-03-07T12:00:00Z',
    endedAt: '2026-03-07T12:00:00Z',
  });
  capture.routineActualManifest = {
    schedules: [
      {
        scheduleId: record.id,
        versionId: record.versionId,
        sourcePlanVersionId: planId,
        record,
        currentHead: { state: 'absent' },
      },
    ],
    blueprints: [
      { record: blueprint, version: 1, currentHead: { state: 'absent' }, unsupportedContent: [] },
    ],
    occurrences: [
      {
        record: occurrence,
        currentSchedule: { state: 'absent' },
        startedRun: { state: 'present', runId: run.id, revision: run.revision },
      },
    ],
    runs: [
      {
        record: run,
        historyDigest: 'b'.repeat(64),
        actuals: [
          {
            stepId: 'step',
            fact: {
              requested: actualRef,
              state: 'unavailable',
              reason: 'synthetic_missing_fact',
              current: null,
              content: null,
            },
          },
        ],
      },
    ],
  };
  return capture;
}
it('connects frozen routine records and real expansion while retaining stopped runs/actual references', () => {
  const capture = withRoutine();
  const before = structuredClone(capture);
  const result = projected(capture, true);
  expect(result.input.routines[0]?.runs).toEqual(
    capture.routineActualManifest.runs.map((row) => row.record),
  );
  expect(result.input.routines[0]?.blueprint).toEqual(
    capture.routineActualManifest.blueprints[0]?.record,
  );
  expect(result.projection.routines[0]?.runs).toEqual(result.input.routines[0]?.runs);
  expect(result.missingFacts).toContainEqual({
    kind: 'actual_reference_unavailable',
    id: JSON.stringify(capture.routineActualManifest.runs[0]?.actuals[0]?.fact.requested),
  });
  expect(capture).toEqual(before);
});
it('blocks missing frozen blueprint and unassignable historical occurrences without fabricating runs', () => {
  const capture = withRoutine();
  capture.routineActualManifest.blueprints = [];
  expect(buildRacePlanImpactProjectionInput(capture, intent(capture, true))).toMatchObject({
    status: 'blocked',
    reason: 'missing_facts',
    missingFacts: expect.arrayContaining([{ kind: 'frozen_blueprint', id: 'blueprint-v1' }]),
  });
});
