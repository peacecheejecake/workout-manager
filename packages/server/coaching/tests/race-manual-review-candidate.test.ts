import { expect, it, vi } from 'vitest';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import type {
  RaceRelativeScheduleImpactInput,
  RaceScheduleCalculationPorts,
} from '../src/race-relative-schedule-impact.js';
import { assembleRaceManualReviewCandidate } from '../src/race-manual-review-candidate.js';
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing synthetic fixture');
  return value;
}
const planId = '10000000-0000-4000-8000-000000000001',
  eventId = '20000000-0000-4000-8000-000000000001';
function fixture(): RaceRelativeScheduleImpactInput {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const plan = planSnapshotSchema.parse({
    id: planId,
    version: 1,
    createdAt: '2026-03-01T00:00:00Z',
    draft: {
      title: 'Synthetic',
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
          title: 'Synthetic planned',
          sport: 'running',
          durationSeconds: null,
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
    title: 'Synthetic race',
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
  const versionId = '30000000-0000-4000-8000-000000000001';
  const record = nutritionPlanVersionSchema.parse({
    planId: '30000000-0000-4000-8000-000000000002',
    versionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-03-01', toInclusive: '2026-03-31' },
    timezone: 'America/New_York',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: planId,
    approvedAt: '2026-03-01T00:00:00Z',
    approvalId: '30000000-0000-4000-8000-000000000003',
    items: [
      ['race-start', 'race', 'start', eventId],
      ['session', 'session', 'start', eventId],
      ['race-end', 'race', 'end', eventId],
      ['unrelated', 'race', 'start', '20000000-0000-4000-8000-000000000002'],
    ].map(([id, entity, point, entityId]) => ({
      id,
      planVersionId: versionId,
      category: 'before',
      title: 'Synthetic timing',
      anchor: { kind: 'relative', entity, entityId, point, offsetMinutes: 0 },
      foods: [],
      targets: [],
      instructions: 'Review timing',
      evidenceIds: [],
      source: 'user_confirmed',
    })),
  });
  return {
    event,
    newLocalDate: '2026-03-09',
    currentPlan: plan,
    sourcePlans: [],
    completionReports: [],
    selection: { kind: 'keep_plan' },
    nutrition: [
      {
        record,
        timings: record.items.map((item) => ({
          itemId: item.id,
          timing:
            item.id === 'unrelated' || item.id === 'race-end'
              ? { state: 'unresolved', reason: 'missing_anchor' }
              : { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
        })),
      },
    ],
    routines: [],
    resolutions: { nutrition: [], routines: [] },
  };
}
function moved() {
  const input = fixture();
  input.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: planId,
    periodId: 'season',
    newStartDate: '2026-03-03',
    scope: 'descendants_and_sessions',
  };
  return input;
}
function routine() {
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: 'blueprint',
    versionId: 'blueprint-v1',
    title: 'Frozen',
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
  return { record, sourcePlanVersionId: planId, blueprint, occurrences: [occurrence], runs: [] };
}
/** Deliberate unit calculation fixtures. They do not establish real runtime DST/DB/recurrence acceptance. */
function ports(): RaceScheduleCalculationPorts {
  return {
    resolveNutrition: vi.fn(
      (context: Parameters<RaceScheduleCalculationPorts['resolveNutrition']>[0]) => {
        const { item, event, sourcePlan } = context;
        const anchor = item.anchor;
        if (anchor.kind === 'absolute')
          return { state: 'resolved', date: anchor.date, localTime: anchor.localTime };
        return {
          state: 'resolved',
          date:
            anchor.entity === 'race'
              ? event.localDate
              : (sourcePlan?.sessions.find((session) => session.id === anchor.entityId)?.date ??
                '2026-03-09'),
          localTime: '07:00:00',
        };
      },
    ),
    expandRoutine: vi.fn(() => ({ state: 'unresolved', reason: 'UNSUPPORTED_MAPPING' })),
  };
}

function candidate(projectionInput = fixture()) {
  return {
    athleteId: 'synthetic-athlete',
    projectionInput,
    sourceFacts: {
      ownerAthleteId: 'synthetic-athlete',
      nutritionRacePins: projectionInput.nutrition.flatMap((context) =>
        context.record.items.flatMap((item) =>
          item.anchor.kind === 'relative' && item.anchor.entity === 'race'
            ? [
                {
                  nutritionVersionId: context.record.versionId,
                  itemId: item.id,
                  binding: {
                    state: 'pinned' as const,
                    ref: { eventId: item.anchor.entityId, revision: 1 },
                  },
                },
              ]
            : [],
        ),
      ),
    },
  };
}
function assembled(raw: unknown, calculations = ports()) {
  const result = assembleRaceManualReviewCandidate(raw, calculations);
  if (result.status !== 'assembled') throw new Error(`Rejected: ${result.reason}`);
  return result;
}
it('assembles immutable draft and logical race/nutrition pin intents without allocating or approving', () => {
  const input = candidate(),
    before = structuredClone(input);
  const result = assembled(input);
  expect(result).toMatchObject({
    kind: 'manual-race-review-draft',
    storage: 'not_persisted',
    approval: { status: 'blocked' },
  });
  expect(result.body.writeIntents.event).toEqual({
    kind: 'race-event',
    expected: { eventId, revision: 1 },
    expectedNextRevision: 2,
    proposedLocalDate: '2026-03-09',
  });
  expect(result.body.writeIntents.training).toBeNull();
  expect(result.body.pinIntents).toContainEqual(
    expect.objectContaining({
      itemId: 'race-start',
      prior: { state: 'pinned', ref: { eventId, revision: 1 } },
      target: { eventId, revision: 2 },
      state: 'requires_explicit_review',
      allocation: 'not_allocated',
    }),
  );
  expect(Object.isFrozen(result.body)).toBe(true);
  expect(Object.isFrozen(result.body.approval.reasons)).toBe(true);
  expect(input).toEqual(before);
  expect(Object.isFrozen(input.projectionInput.selection)).toBe(false);
  // Freezing candidate data must not freeze a caller's editable draft.
  input.projectionInput.selection = { kind: 'keep_plan' };
  expect(Object.isFrozen(input.projectionInput.selection)).toBe(false);
});
it('produces order-independent digest for set rosters and object keys without losing semantic step order', () => {
  const input = candidate(moved()),
    other = structuredClone(input);
  required(other.projectionInput.nutrition[0]).record.items.reverse();
  required(other.projectionInput.nutrition[0]).timings.reverse();
  required(other.projectionInput.currentPlan).draft.periods.reverse();
  other.sourceFacts.nutritionRacePins.reverse();
  expect(assembled(input).digest).toBe(assembled(other).digest);
  expect(assembled(input).digest).toMatch(/^[a-f0-9]{64}$/);
});
it('keeps legacy unpinned and absent binding facts unavailable instead of silently upgrading them', () => {
  const input = candidate();
  const raw = {
    ...input,
    sourceFacts: {
      ...input.sourceFacts,
      nutritionRacePins: input.sourceFacts.nutritionRacePins.map((pin) =>
        pin.itemId === 'race-start' ? { ...pin, binding: { state: 'legacy_unpinned' } } : pin,
      ),
    },
  };
  const result = assembled(raw);
  expect(result.body.pinIntents).toContainEqual(
    expect.objectContaining({
      itemId: 'race-start',
      prior: { state: 'legacy_unpinned' },
      state: 'requires_explicit_review',
    }),
  );
  expect(result.body.resolution.blocking).toContainEqual(
    expect.objectContaining({ itemId: 'race-start', reason: 'race_binding_unavailable' }),
  );
  const absent = assembled({
    ...input,
    sourceFacts: { ...input.sourceFacts, nutritionRacePins: [] },
  });
  expect(absent.body.pinIntents).toContainEqual(
    expect.objectContaining({ itemId: 'race-start', prior: { state: 'absent' } }),
  );
});
it('preserves exact historical pin and marks re-targeting unresolved even with resolved calculation', () => {
  const input = candidate();
  input.projectionInput.event.revision = 2;
  const result = assembled(input);
  expect(result.body.pinIntents).toContainEqual(
    expect.objectContaining({
      itemId: 'race-start',
      prior: { state: 'pinned', ref: { eventId, revision: 1 } },
      target: { eventId, revision: 3 },
    }),
  );
  expect(result.body.resolution.blocking).toContainEqual(
    expect.objectContaining({ itemId: 'race-start', reason: 'historical_pin_not_retargeted' }),
  );
  expect(result.approval.status).toBe('blocked');
});
it('keeps same UUID session namespace unchanged on keep_plan and preserves unrelated unresolved notice', () => {
  const result = assembled(candidate());
  expect(result.body.nutrition[0]?.items.find((item) => item.itemId === 'session')?.state).toBe(
    'unchanged',
  );
  expect(result.body.pinIntents.some((pin) => pin.itemId === 'session')).toBe(false);
  expect(result.body.resolution.preservedNotices).toContainEqual(
    expect.objectContaining({ itemId: 'unrelated', reason: 'existing_unresolved_preserved' }),
  );
  expect(result.body.resolution.blocking.some((notice) => notice.itemId === 'unrelated')).toBe(
    false,
  );
});
it('affected existing unresolved needs explicit resolution even if a calculation returns resolved', () => {
  const input = candidate(moved());
  required(input.projectionInput.nutrition[0]).timings = required(
    input.projectionInput.nutrition[0],
  ).timings.map((entry) =>
    entry.itemId === 'session'
      ? { ...entry, timing: { state: 'unresolved', reason: 'ambiguous_local_time' } }
      : entry,
  );
  expect(assembled(input).body.resolution.blocking).toContainEqual(
    expect.objectContaining({
      itemId: 'session',
      reason: 'affected_unresolved_requires_resolution',
    }),
  );
  input.projectionInput.resolutions.nutrition = [
    {
      planVersionId: required(input.projectionInput.nutrition[0]).record.versionId,
      itemId: 'session',
      action: 'replace_anchor',
      anchor: {
        kind: 'absolute',
        date: '2026-03-09',
        localTime: '07:00:00',
        timezone: 'America/New_York',
      },
    },
  ];
  const result = assembled(input);
  expect(result.body.resolution.blocking.some((notice) => notice.itemId === 'session')).toBe(false);
  expect(result.approval.status).toBe('blocked');
});
it('retains actual references, frozen blueprint and started occurrence without producing actual intents', () => {
  const input = candidate(moved()),
    context = routine();
  const run = routineRunSchema.parse({
    id: 'run',
    revision: 1,
    blueprint: context.record.blueprint,
    origin: { kind: 'planned', occurrenceId: 'occurrence' },
    state: 'stopped',
    progress: [
      {
        stepId: 'step',
        revision: 1,
        state: 'stopped',
        actualRefs: [
          { kind: 'checklist_confirmation', id: 'confirmation', revisionId: 'confirmation-r1' },
        ],
        occurredAt: '2026-03-07T12:00:00Z',
        recordedAt: '2026-03-07T12:00:00Z',
        reason: 'Synthetic stop',
      },
    ],
    selectedChoices: {},
    startedAt: '2026-03-07T12:00:00Z',
    endedAt: '2026-03-07T12:00:00Z',
  });
  input.projectionInput.routines = [{ ...context, runs: [run] }];
  const calculations = ports();
  calculations.expandRoutine = () => ({
    state: 'expanded',
    occurrences: [{ ...context.occurrences[0], scheduledAt: '2026-03-09T11:00:00Z' }],
  });
  const result = assembled(input, calculations),
    retained = result.body.retainedActualManifest.routines[0];
  expect(retained?.runs).toEqual([run]);
  expect(retained?.blueprint).toEqual(context.blueprint);
  expect(retained?.retainedStartedOccurrences).toEqual(context.occurrences);
  expect(result.body.writeIntents.routines[0]?.projection?.plannedOccurrences).toEqual([]);
  expect(Object.keys(result.body.writeIntents)).toEqual([
    'event',
    'training',
    'nutrition',
    'routines',
  ]);
});
it('does not label unstarted unchanged occurrences as started actuals', () => {
  const input = candidate();
  input.projectionInput.routines = [routine()];
  const retained = assembled(input).body.retainedActualManifest.routines[0];
  expect(retained?.occurrences).toHaveLength(1);
  expect(retained?.retainedStartedOccurrences).toEqual([]);
});
it('rejects revision overflow only for a new event transition and preserves terminal retained review', () => {
  const input = candidate();
  input.projectionInput.event.revision = 2147483647;
  expect(assembleRaceManualReviewCandidate(input, ports())).toMatchObject({
    status: 'rejected',
    reason: 'race_revision_overflow',
  });
  input.projectionInput.newLocalDate = input.projectionInput.event.localDate;
  expect(assembled(input).body.writeIntents.event).toBeNull();
  input.projectionInput.event.revision = 2147483648;
  expect(assembleRaceManualReviewCandidate(input, ports())).toMatchObject({
    status: 'rejected',
    reason: 'race_revision_overflow',
  });
});
it('rejects foreign scope, unknown approval claims and malformed projection before trusting the draft', () => {
  const input = candidate(),
    calculations = ports();
  expect(
    assembleRaceManualReviewCandidate(
      { ...input, sourceFacts: { ...input.sourceFacts, ownerAthleteId: 'other' } },
      calculations,
    ),
  ).toMatchObject({ status: 'rejected', reason: 'foreign_source_scope' });
  expect(calculations.resolveNutrition).not.toHaveBeenCalled();
  expect(
    assembleRaceManualReviewCandidate({ ...input, approval: true }, calculations),
  ).toMatchObject({ status: 'rejected', reason: 'invalid_input' });
  expect(
    assembleRaceManualReviewCandidate(
      { ...input, projectionInput: { ...input.projectionInput, approve: true } },
      calculations,
    ),
  ).toMatchObject({ status: 'rejected', reason: 'invalid_input' });
});
it('rejects duplicate, unmatched and mismatched pin facts without changing inputs', () => {
  const input = candidate(),
    pin = required(input.sourceFacts.nutritionRacePins[0]);
  expect(
    assembleRaceManualReviewCandidate(
      { ...input, sourceFacts: { ...input.sourceFacts, nutritionRacePins: [pin, pin] } },
      ports(),
    ),
  ).toMatchObject({ status: 'rejected', reason: 'duplicate_pin_fact' });
  expect(
    assembleRaceManualReviewCandidate(
      {
        ...input,
        sourceFacts: { ...input.sourceFacts, nutritionRacePins: [{ ...pin, itemId: 'unknown' }] },
      },
      ports(),
    ),
  ).toMatchObject({ status: 'rejected', reason: 'unmatched_pin_fact' });
  expect(
    assembleRaceManualReviewCandidate(
      {
        ...input,
        sourceFacts: {
          ...input.sourceFacts,
          nutritionRacePins: [
            {
              ...pin,
              binding: {
                state: 'pinned',
                ref: { eventId: '90000000-0000-4000-8000-000000000001', revision: 1 },
              },
            },
          ],
        },
      },
      ports(),
    ),
  ).toMatchObject({ status: 'rejected', reason: 'pin_source_mismatch' });
});
it('bounds candidate bytes and combined logical/source references without accepting partial drafts', () => {
  expect(assembleRaceManualReviewCandidate({ body: 'x'.repeat(4194304) }, ports())).toMatchObject({
    status: 'rejected',
    reason: 'projection_bound',
    storage: 'not_persisted',
    approval: { status: 'blocked' },
  });
  const input = fixture(),
    context = required(input.nutrition[0]);
  input.nutrition = Array.from({ length: 1000 }, (_, index) => {
    const versionId = `30000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
    return {
      record: {
        ...context.record,
        versionId,
        items: context.record.items.map((item) => ({ ...item, planVersionId: versionId })),
      },
      timings: structuredClone(context.timings),
    };
  });
  expect(assembleRaceManualReviewCandidate(candidate(input), ports())).toMatchObject({
    status: 'rejected',
    reason: 'projection_bound',
  });
});
it('keeps frozen blueprint step sequence semantic while normalizing roster order', () => {
  const input = candidate(),
    context = routine();
  context.blueprint.steps.push({
    ...required(context.blueprint.steps[0]),
    id: 'step-two',
    title: 'Second frozen step',
  });
  input.projectionInput.routines = [context];
  const first = assembled(input);
  const changed = structuredClone(input);
  required(changed.projectionInput.routines[0]).blueprint.steps.reverse();
  expect(assembled(changed).digest).not.toBe(first.digest);
  expect(
    first.body.retainedActualManifest.routines[0]?.blueprint.steps.map((step) => step.id),
  ).toEqual(['step', 'step-two']);
});
it('rejects a claimed immutable pin newer than the explicitly reviewed event head', () => {
  const input = candidate(),
    pin = required(input.sourceFacts.nutritionRacePins.find((pin) => pin.itemId === 'race-start'));
  pin.binding.ref.revision = 2;
  expect(assembleRaceManualReviewCandidate(input, ports())).toMatchObject({
    status: 'rejected',
    reason: 'pin_source_mismatch',
  });
});
it('normalizes multiple nutrition and routine contexts for body, digest, write intents and retained manifests', () => {
  const projection = moved(),
    nutrition = required(projection.nutrition[0]),
    firstRoutine = routine();
  const secondVersion = '30000000-0000-4000-8000-000000000010';
  projection.nutrition = [
    {
      record: {
        ...nutrition.record,
        planId: '30000000-0000-4000-8000-000000000011',
        versionId: secondVersion,
        items: nutrition.record.items.map((item) => ({ ...item, planVersionId: secondVersion })),
      },
      timings: structuredClone(nutrition.timings),
    },
    nutrition,
  ];
  const secondRoutine = structuredClone(firstRoutine);
  secondRoutine.record.id = 'schedule-two';
  secondRoutine.record.versionId = 'schedule-v2';
  secondRoutine.occurrences = secondRoutine.occurrences.map((occurrence) => ({
    ...occurrence,
    id: 'occurrence-two',
    schedule: { id: 'schedule-two', versionId: 'schedule-v2' },
  }));
  projection.routines = [secondRoutine, firstRoutine];
  const input = candidate(projection),
    other = structuredClone(input),
    before = structuredClone(input);
  other.projectionInput.nutrition.reverse();
  other.projectionInput.routines.reverse();
  other.sourceFacts.nutritionRacePins.reverse();
  const first = assembled(input),
    reordered = assembled(other);
  expect(first.body.nutrition.map((context) => context.planVersionId)).toEqual([
    nutrition.record.versionId,
    secondVersion,
  ]);
  expect(first.body.routines.map((context) => context.scheduleVersionId)).toEqual([
    'schedule-v1',
    'schedule-v2',
  ]);
  expect(reordered.body).toEqual(first.body);
  expect(reordered.digest).toBe(first.digest);
  expect(reordered.body.writeIntents).toEqual(first.body.writeIntents);
  expect(reordered.body.retainedActualManifest).toEqual(first.body.retainedActualManifest);
  expect(input).toEqual(before);
});
