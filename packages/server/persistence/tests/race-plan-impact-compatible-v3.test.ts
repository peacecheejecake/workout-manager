import { expect, it, vi } from 'vitest';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionV2Schema } from '@workout/contracts/nutrition-race-plan-v2';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import {
  projectRaceRelativeScheduleImpact,
  projectRaceRelativeScheduleImpactCompatibleV3,
} from '@workout/server-coaching/race-relative-schedule-impact';
import {
  buildRacePlanImpactProjectionInput,
  type RaceProjectionCapture,
} from '../src/race-plan-impact-projection-input.js';
import {
  createRaceRelativeScheduleCalculationPorts,
  createRaceRelativeScheduleCalculationPortsCompatibleV3,
} from '../src/race-relative-schedule-calculation.js';
import { captureNestedNutritionSources } from '../src/race-plan-impact-nested-sources.js';
import type { Transaction } from '../src/database.js';
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
function capturedV2(capture = fixture()) {
  const original = capture.nutrition[0]?.record;
  if (!original) throw new Error('MISSING_FIXTURE');
  const record = nutritionPlanVersionV2Schema.parse({
    ...original,
    schemaVersion: 2,
    raceTimingPins: [
      {
        pinVersion: 1,
        namespace: 'race-event-revision',
        eventId,
        eventRevision: 1,
        sourceDigestVersion: 'race-event-values-canonical-v1',
        sourceDigest: 'b'.repeat(64),
        localDate: '2026-03-07',
        localStartTime: '07:00:00',
        timezone: 'America/New_York',
        start: { state: 'known', instant: '2026-03-07T12:00:00Z' },
        end: { state: 'unknown', reason: 'race_end_not_recorded' },
      },
    ],
    itemRaceTimingBindings: [
      { itemId: 'race', binding: { state: 'captured', eventId, eventRevision: 1 } },
    ],
  });
  capture.nutrition = [
    {
      ...capture.nutrition[0],
      aggregateId: record.planId,
      versionId: record.versionId,
      record,
      sourceRelation: 'current',
      relativeItems: [],
    },
  ];
  return capture;
}
function disconnected(capture = fixture()) {
  const original = capture.nutrition[0]?.record;
  if (!original) throw new Error('MISSING_FIXTURE');
  const record = nutritionPlanVersionV3Schema.parse({
    ...original,
    schemaVersion: 3,
    items: original.items.map((item) =>
      item.id === 'race'
        ? {
            ...item,
            anchor: { kind: 'disconnected', entity: 'race' },
            foods: [
              {
                foodVersionId: null,
                description: 'Retained',
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
          }
        : item,
    ),
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
  capture.nutrition = [
    {
      aggregateId: record.planId,
      versionId: record.versionId,
      record,
      sourceRelation: 'current',
      relativeItems: [],
    },
  ];
  return capture;
}
it('preserves full disconnected V3 record and food0/null with stopped timing and no invented race pin', () => {
  const capture = disconnected();
  const before = structuredClone(capture);
  const result = projected(capture);
  expect(result.input.nutrition[0]?.record).toEqual(capture.nutrition[0]?.record);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race'),
  ).toMatchObject({
    state: 'unchanged',
    item: { anchor: { kind: 'disconnected', entity: 'race' } },
    before: { state: 'unresolved', reason: 'missing_anchor' },
    after: { state: 'unresolved', reason: 'missing_anchor' },
    notice: 'existing_unresolved_preserved',
  });
  expect(result.sourceFacts.nutritionRacePins).toEqual([]);
  expect(result.missingFacts.filter((fact) => fact.kind === 'immutable_race_pin')).toEqual([]);
  expect(result.approvalAllowed).toBe(false);
  expect(result.coverageComplete).toBe(false);
  expect(result.coverage.missing).toHaveLength(5);
  expect(capture).toEqual(before);
});
it('separates matched saved V2 before from hypothetical current-event after without re-pinning or approval', () => {
  const capture = capturedV2();
  capture.event = { ...capture.event, localStartTime: '10:00:00', revision: 2 };
  const result = projected(capture);
  const item = result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race');
  expect(item).toMatchObject({
    state: 'affected',
    before: { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
    after: { state: 'resolved', date: '2026-03-09', localTime: '10:00:00' },
    notice: null,
  });
  expect(result.sourceFacts.nutritionRacePins[0]?.binding).toEqual({
    state: 'captured',
    eventId,
    eventRevision: 1,
  });
  expect(result.missingFacts.filter((fact) => fact.kind === 'immutable_race_pin')).toEqual([]);
  expect(result.input.nutrition[0]?.record).toEqual(capture.nutrition[0]?.record);
});
it('preserves an unrelated saved V2 race timing when only another event changes', () => {
  const capture = capturedV2();
  const originalEvent = capture.event;
  capture.event = { ...originalEvent, id: '20000000-0000-4000-8000-000000000099' };
  capture.consumedSources = {
    plans: [capture.linkedPlan].flatMap((plan) => (plan ? [plan] : [])),
    races: [originalEvent],
  };
  const result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race'),
  ).toMatchObject({
    state: 'unchanged',
    before: { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
    after: { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
    notice: null,
  });
});
it('keeps explicit legacy-unpinned V2 unresolved and its immutable-pin missing fact', () => {
  const capture = capturedV2();
  const original = capture.nutrition[0]?.record;
  if (!original) throw new Error('MISSING_FIXTURE');
  capture.nutrition[0] = {
    aggregateId: original.planId,
    versionId: original.versionId,
    sourceRelation: 'current',
    relativeItems: [],
    record: nutritionPlanVersionV2Schema.parse({
      ...original,
      raceTimingPins: [],
      itemRaceTimingBindings: [
        {
          itemId: 'race',
          binding: {
            state: 'legacy_unpinned',
            priorNutritionVersionId: nutritionId,
            priorItemId: 'race',
            priorAnchorDigest: 'a'.repeat(64),
          },
        },
      ],
    }),
  };
  const result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race')?.before,
  ).toEqual({ state: 'unresolved', reason: 'missing_anchor' });
  expect(result.missingFacts.filter((fact) => fact.kind === 'immutable_race_pin')).toHaveLength(1);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race')?.after,
  ).toEqual({ state: 'unresolved', reason: 'unsupported_anchor_mapping' });
  expect(result.approvalAllowed).toBe(false);
});
it('rejects attempted disconnected reconnection in this read-only projection rather than fabricating approval', () => {
  const capture = disconnected();
  const record = capture.nutrition[0]?.record;
  const result = buildRacePlanImpactProjectionInput(capture, {
    ...intent(capture),
    resolutions: {
      nutrition: [
        {
          planVersionId: record?.versionId,
          itemId: 'race',
          action: 'replace_anchor',
          anchor: {
            kind: 'absolute',
            date: '2026-03-09',
            localTime: null,
            timezone: 'America/New_York',
          },
        },
      ],
      routines: [],
    },
  });
  expect(result).toMatchObject({
    status: 'blocked',
    reason: 'unsupported_resolution',
    approvalAllowed: false,
  });
});
it('preserves exact historical linked training body instead of replacing it with the current head', () => {
  const capture = disconnected();
  const linked = capture.linkedPlan;
  if (!linked || !capture.currentTraining) throw new Error('MISSING_FIXTURE');
  const historical = {
    ...linked,
    id: '10000000-0000-4000-8000-000000000099',
    draft: {
      ...linked.draft,
      sessions: linked.draft.sessions.map((session) => ({
        ...session,
        localStartTime: '05:00:00',
      })),
    },
  };
  const row = capture.nutrition[0];
  if (!row) throw new Error('MISSING_FIXTURE');
  row.record = nutritionPlanVersionV3Schema.parse({
    ...row.record,
    linkedTrainingPlanVersionId: historical.id,
  });
  row.sourceRelation = 'historical';
  capture.consumedSources = { plans: [historical], races: [] };
  const result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'session')?.before,
  ).toEqual({ state: 'resolved', date: '2026-03-07', localTime: '05:00:00' });
  expect(result.input.sourcePlans).toContainEqual(historical);
});
it('requires an explicit internal compatible seam while the old V1 pure and adapter decoders stay strict', () => {
  const capture = disconnected();
  const result = projected(capture);
  const { retainedUnplannedRuns, retainedHistoricalRoutines, ...compatibleV3Input } = result.input;
  // The current builder emits V4. This fixture has no V4-only retained content.
  expect(retainedUnplannedRuns).toEqual([]);
  expect(retainedHistoricalRoutines).toEqual([]);
  expect(
    projectRaceRelativeScheduleImpact(
      compatibleV3Input,
      createRaceRelativeScheduleCalculationPorts(),
    ),
  ).toMatchObject({ status: 'rejected', reason: 'invalid_input' });
  expect(
    projectRaceRelativeScheduleImpactCompatibleV3(
      compatibleV3Input,
      createRaceRelativeScheduleCalculationPortsCompatibleV3([capture.event]),
    ),
  ).toMatchObject({ status: 'projected' });
  expect(
    projectRaceRelativeScheduleImpactCompatibleV3(
      result.input,
      createRaceRelativeScheduleCalculationPortsCompatibleV3([capture.event]),
    ),
  ).toMatchObject({ status: 'rejected', reason: 'invalid_input' });
});
it('does not fetch disconnected race sources and includes original V3 body digest while retaining historical Plan reads', async () => {
  const capture = disconnected();
  const record = capture.nutrition[0]?.record;
  const linked = capture.linkedPlan;
  if (!record || !linked) throw new Error('MISSING_FIXTURE');
  const query = vi.fn<Transaction['query']>().mockImplementation(async (sql) => {
    const rows = sql.includes(' AS bytes')
      ? [{ bytes: '1024' }]
      : sql.includes('SELECT 1 FROM plan_snapshot')
        ? [{ exists: 1 }]
        : sql.includes('SELECT aggregate_id,version_id FROM plan_head')
          ? [{ aggregate_id: linked.id, version_id: linked.id }]
          : [];
    return { rows, rowCount: rows.length };
  });
  const race = vi.fn(async () => {
    throw new Error('DISCONNECTED_RACE_FETCH');
  });
  const plan = vi.fn(async () => linked);
  const value = await captureNestedNutritionSources(
    { athleteId: capture.athleteId, query },
    [record],
    { bytes: 0n, sources: 0 },
    { plan, race },
  );
  expect(race).not.toHaveBeenCalled();
  expect(plan).toHaveBeenCalledWith(linked.id);
  expect(value.nutrition[0]?.recordDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(value.nutrition[0]?.anchors).toHaveLength(1);
  const changed = nutritionPlanVersionV3Schema.parse({ ...record, purpose: `${record.purpose}!` });
  const other = await captureNestedNutritionSources(
    { athleteId: capture.athleteId, query },
    [changed],
    { bytes: 0n, sources: 0 },
    { plan, race },
  );
  expect(other.nutrition[0]?.recordDigest).not.toBe(value.nutrition[0]?.recordDigest);
});
it('rejects tampered V3 bindings/pins and duplicate nutrition identities at the actual preview seam', () => {
  const capture = disconnected();
  const row = capture.nutrition[0];
  if (!row) throw new Error('MISSING_FIXTURE');
  const extra = structuredClone(row.record);
  const tampered = { ...extra, sourceLeak: 'deleted' };
  expect(
    buildRacePlanImpactProjectionInput(
      { ...capture, nutrition: [{ ...row, record: tampered }] },
      intent(capture),
    ),
  ).toMatchObject({ status: 'blocked', reason: 'invalid_input_or_capture' });
  expect(
    buildRacePlanImpactProjectionInput({ ...capture, nutrition: [row, row] }, intent(capture)),
  ).toMatchObject({ status: 'blocked', reason: 'invalid_input_or_capture' });
});

it('calculates hypothetical offset across midnight without altering saved offset or pin', () => {
  const capture = capturedV2();
  const original = capture.nutrition[0]?.record;
  if (!original) throw new Error('MISSING_FIXTURE');
  const record = nutritionPlanVersionV2Schema.parse({
    ...original,
    items: original.items.map((item) =>
      item.id === 'race' && item.anchor.kind === 'relative'
        ? { ...item, anchor: { ...item.anchor, offsetMinutes: -60 } }
        : item,
    ),
  });
  capture.nutrition[0] = {
    ...capture.nutrition[0],
    aggregateId: record.planId,
    versionId: record.versionId,
    sourceRelation: 'current',
    relativeItems: [],
    record,
  };
  capture.event = { ...capture.event, localStartTime: '00:15:00', revision: 2 };
  const before = structuredClone(capture);
  const result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race'),
  ).toMatchObject({
    before: { state: 'resolved', date: '2026-03-07', localTime: '06:00:00' },
    after: { state: 'resolved', date: '2026-03-08', localTime: '23:15:00' },
  });
  expect(result.approvalAllowed).toBe(false);
  expect(result.coverageComplete).toBe(false);
  expect(capture).toEqual(before);
});
it('rejects hypothetical source identity, revision and facts mismatches and changed saved offsets', () => {
  const capture = capturedV2();
  const record = nutritionPlanVersionV2Schema.parse(capture.nutrition[0]?.record);
  const item = record.items.find((item) => item.id === 'race');
  if (!item || item.anchor.kind !== 'relative') throw new Error('MISSING_FIXTURE');
  const ports = createRaceRelativeScheduleCalculationPortsCompatibleV3([capture.event]);
  const context = {
    item,
    record,
    sourcePlan: null,
    proposedFromEvent: capture.event,
    event: { ...capture.event, localDate: '2026-03-09' },
  };
  for (const event of [
    { ...context.event, id: '20000000-0000-4000-8000-000000000099' },
    { ...context.event, revision: 2 },
    { ...context.event, localStartTime: '11:00:00' },
    { ...context.event, timezone: 'Asia/Seoul' },
  ])
    expect(() => ports.resolveNutrition({ ...context, event })).toThrow(
      'INVALID_CALCULATION_INPUT',
    );
  expect(() =>
    ports.resolveNutrition({
      ...context,
      proposedFromEvent: { ...capture.event, title: 'not captured' },
      event: { ...context.event, title: 'not captured' },
    }),
  ).toThrow('INVALID_CALCULATION_INPUT');
  expect(
    ports.resolveNutrition({
      ...context,
      item: { ...item, anchor: { ...item.anchor, offsetMinutes: 1 } },
    }),
  ).toEqual({ state: 'unresolved', reason: 'unsupported_anchor_mapping' });
  const laterPinRecord = nutritionPlanVersionV2Schema.parse({
    ...record,
    raceTimingPins: record.raceTimingPins.map((pin) => ({ ...pin, eventRevision: 2 })),
    itemRaceTimingBindings: [
      { itemId: 'race', binding: { state: 'captured', eventId, eventRevision: 2 } },
    ],
  });
  expect(() => ports.resolveNutrition({ ...context, record: laterPinRecord })).toThrow(
    'INVALID_CALCULATION_INPUT',
  );
});
it('keeps unknown race start and end unresolved in hypothetical preview with approval blocked', () => {
  const capture = capturedV2();
  capture.event = { ...capture.event, localStartTime: null, revision: 2 };
  let result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race'),
  ).toMatchObject({
    after: { state: 'unresolved', reason: 'missing_race_time' },
    notice: 'affected_unresolved_requires_resolution',
  });
  const original = capture.nutrition[0]?.record;
  if (!original) throw new Error('MISSING_FIXTURE');
  const record = nutritionPlanVersionV2Schema.parse({
    ...original,
    items: original.items.map((item) =>
      item.id === 'race' && item.anchor.kind === 'relative'
        ? { ...item, anchor: { ...item.anchor, point: 'end' } }
        : item,
    ),
  });
  capture.nutrition[0] = {
    ...capture.nutrition[0],
    aggregateId: record.planId,
    versionId: record.versionId,
    sourceRelation: 'current',
    relativeItems: [],
    record,
  };
  result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race')?.after,
  ).toEqual({ state: 'unresolved', reason: 'missing_race_end' });
  expect(result.approvalAllowed).toBe(false);
});
it('keeps nonexistent proposed DST wall time unresolved instead of inferring an instant', () => {
  const capture = capturedV2();
  capture.event = { ...capture.event, localStartTime: '02:30:00', revision: 2 };
  const result = buildRacePlanImpactProjectionInput(capture, {
    ...intent(capture),
    newLocalDate: '2026-03-08',
  });
  if (result.status !== 'projected') throw new Error(result.reason);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race'),
  ).toMatchObject({
    before: { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
    after: { state: 'unresolved', reason: 'ambiguous_local_time' },
    notice: 'affected_unresolved_requires_resolution',
  });
  expect(result.approvalAllowed).toBe(false);
});
it('projects hypothetical event timezone into nutrition timezone while preserving historical pin timezone', () => {
  const capture = capturedV2();
  capture.event = { ...capture.event, revision: 2, timezone: 'UTC', localStartTime: '10:00:00' };
  const original = structuredClone(capture);
  const result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race'),
  ).toMatchObject({
    before: { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
    after: { state: 'resolved', date: '2026-03-09', localTime: '06:00:00' },
  });
  expect(capture).toEqual(original);
  expect(result.approvalAllowed).toBe(false);
});
it('V4 owned capture preserves same-event revision-specific before facts and computes only explicit proposed date after', async () => {
  const { nutritionPlanVersionV4Schema } =
    await import('@workout/contracts/nutrition-race-plan-v4');
  const { createRaceRelativeScheduleCalculationPortsCompatibleV4 } =
    await import('../src/race-relative-schedule-calculation.js');
  const capture = capturedV2(),
    prior = nutritionPlanVersionV2Schema.parse(capture.nutrition[0]?.record),
    raceItem = prior.items.find((item) => item.id === 'race');
  const oldPin = prior.raceTimingPins[0];
  if (!raceItem || !oldPin) throw Error('fixture');
  const newer = {
    ...oldPin,
    eventRevision: 2,
    sourceDigest: 'c'.repeat(64),
    localStartTime: '09:00:00',
    start: { state: 'known', instant: '2026-03-07T14:00:00Z' },
  };
  const record = nutritionPlanVersionV4Schema.parse({
    ...prior,
    schemaVersion: 4,
    items: [...prior.items, { ...raceItem, id: 'race-new' }],
    raceTimingPins: [oldPin, newer],
    itemRaceTimingBindings: [
      { itemId: 'race', binding: { state: 'captured', eventId, eventRevision: 1 } },
      { itemId: 'race-new', binding: { state: 'captured', eventId, eventRevision: 2 } },
    ],
  });
  capture.nutrition[0] = {
    ...capture.nutrition[0],
    aggregateId: record.planId,
    versionId: record.versionId,
    sourceRelation: 'current',
    relativeItems: [],
    record,
  };
  capture.event = { ...capture.event, revision: 2, localStartTime: '09:00:00' };
  const before = structuredClone(capture),
    result = projected(capture);
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race'),
  ).toMatchObject({
    before: { state: 'resolved', localTime: '07:00:00' },
    after: { state: 'resolved', date: '2026-03-09', localTime: '09:00:00' },
  });
  expect(
    result.projection.nutrition[0]?.items.find((item) => item.itemId === 'race-new'),
  ).toMatchObject({
    before: { state: 'resolved', localTime: '09:00:00' },
    after: { state: 'resolved', date: '2026-03-09', localTime: '09:00:00' },
  });
  expect(
    projectRaceRelativeScheduleImpactCompatibleV3(
      result.input,
      createRaceRelativeScheduleCalculationPortsCompatibleV3([capture.event]),
    ),
  ).toMatchObject({ status: 'rejected', reason: 'invalid_input' });
  expect(result.approvalAllowed).toBe(false);
  expect(result.coverageComplete).toBe(false);
  expect(capture).toEqual(before);
  const item = record.items.find((item) => item.id === 'race-new');
  if (!item) throw Error('fixture');
  expect(() =>
    createRaceRelativeScheduleCalculationPortsCompatibleV3([capture.event]).resolveNutrition({
      record,
      item,
      sourcePlan: null,
      event: capture.event,
    }),
  ).toThrow();
  const v4 = createRaceRelativeScheduleCalculationPortsCompatibleV4([capture.event]);
  expect(
    v4.resolveNutrition({ record, item, sourcePlan: null, event: capture.event }),
  ).toMatchObject({ state: 'resolved', localTime: '09:00:00' });
  expect(
    buildRacePlanImpactProjectionInput(
      {
        ...capture,
        nutrition: [{ ...capture.nutrition[0], record: { ...record, raceTimingPins: [oldPin] } }],
      },
      intent(capture),
    ),
  ).toMatchObject({ status: 'blocked', reason: 'invalid_input_or_capture' });
});
