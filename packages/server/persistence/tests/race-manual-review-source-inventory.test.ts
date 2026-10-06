import { assembleRaceManualReviewCandidate } from '@workout/server-coaching/race-manual-review-candidate';
import { createRaceRelativeScheduleCalculationPorts } from '../src/race-relative-schedule-calculation.js';
import { expect, it } from 'vitest';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { mapRaceManualReviewSourceInventory } from '../src/race-manual-review-source-inventory.js';
const athlete = 'synthetic-athlete';
const one = '10000000-0000-4000-8000-000000000001';
const two = '10000000-0000-4000-8000-000000000002';
const three = '10000000-0000-4000-8000-000000000003';
const at = '2026-10-01T00:00:00Z';
const event = () =>
  raceEventSchema.parse({
    id: one,
    revision: 1,
    title: 'Synthetic',
    localDate: '2026-10-06',
    localStartTime: null,
    timezone: 'UTC',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: null,
  });
const plan = (key = one, ordinal = 1) =>
  planSnapshotSchema.parse({
    id: key,
    version: ordinal,
    createdAt: at,
    draft: {
      timezone: 'UTC',
      title: 'Synthetic',
      periods: [
        {
          id: 'season',
          parentId: null,
          level: 'season',
          title: 'Synthetic',
          startDate: '2026-10-01',
          endDateExclusive: '2026-11-01',
          timezone: 'UTC',
          intent: '',
          isPartial: false,
        },
      ],
      sessions: [],
    },
  });
function envelope<T extends Record<string, unknown>>(context: T, sourceInput?: unknown) {
  return {
    status: 'blocked',
    storage: 'not_persisted',
    sourceCompleteness: 'unverified',
    approvalAllowed: false,
    context: { athleteId: athlete, ...context },
    ...(sourceInput === undefined ? {} : { sourceInput }),
  };
}
function completion(versionId: string) {
  return sessionCompletionSchema.parse({
    sessionId: 'same-opaque-session',
    revision: 1,
    planVersionId: versionId,
    schedule: { blockId: 'block', date: '2026-10-06', localStartTime: null, timezone: 'UTC' },
    status: 'completed',
    reportedAt: at,
    reason: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  });
}
it('indexes exact race and immutable historical/current Plan bodies with deterministic dedup across copies and namespaces', () => {
  const older = plan(one),
    current = plan(two, 2);
  const input = envelope(
    {
      event: event(),
      linkedPlan: older,
      currentTraining: { aggregateId: three, snapshot: current },
      consumedSources: { plans: [current, older], races: [event()] },
    },
    { athleteId: athlete, currentPlan: current, sourcePlans: [older], event: event() },
  );
  const before = structuredClone(input),
    result = mapRaceManualReviewSourceInventory(input);
  expect(result.inventoryState).toBe('mapped');
  expect(result.allCopiedBodiesIndexed).toBe(true);
  expect(result).toMatchObject({
    complete: false,
    storageAllowed: false,
    sourceCompleteness: 'unverified',
  });
  expect(
    result.refs.map(({ kind, sourceId, versionKey }) => ({ kind, sourceId, versionKey })),
  ).toEqual([
    { kind: 'plan-snapshot', sourceId: one, versionKey: '1' },
    { kind: 'plan-snapshot', sourceId: two, versionKey: '2' },
    { kind: 'race-event', sourceId: one, versionKey: '1' },
  ]);
  expect(
    result.refs.find((ref) => ref.kind === 'plan-snapshot' && ref.sourceId === one)?.locations,
  ).toHaveLength(3);
  input.context.consumedSources = { plans: [older, current], races: [event()] };
  const reordered = mapRaceManualReviewSourceInventory(input);
  expect(
    reordered.refs.map(({ kind, sourceId, versionKey }) => ({ kind, sourceId, versionKey })),
  ).toEqual(result.refs.map(({ kind, sourceId, versionKey }) => ({ kind, sourceId, versionKey })));
  expect(before.context.event).toEqual(input.context.event);
});
it('same source key conflicting bodies and same immutable Plan UUID conflicting ordinals reject rather than select a head', () => {
  for (const second of [
    { ...plan(), draft: { ...plan().draft, title: 'Changed synthetic body' } },
    plan(one, 2),
  ]) {
    const result = mapRaceManualReviewSourceInventory(
      envelope({ consumedSources: { plans: [plan(), second] } }),
    );
    expect(result.inventoryState).toBe('blocked');
    expect(result.refs).toEqual([]);
    expect(result.unindexable).toContainEqual({ path: '$', reason: 'SOURCE_CONFLICT' });
  }
});
it('copied sourceInput body must already exist with exact bytes in the context; no foreign or proposed source is manufactured', () => {
  for (const copied of [
    plan(two),
    { ...plan(), draft: { ...plan().draft, title: 'Changed copy' } },
  ]) {
    const result = mapRaceManualReviewSourceInventory(
      envelope({ linkedPlan: plan() }, { athleteId: athlete, sourcePlans: [copied] }),
    );
    expect(result.inventoryState).toBe('blocked');
    expect(result.allCopiedBodiesIndexed).toBe(false);
    expect(result.unindexable[0]?.path).toBe('sourceInput.sourcePlans[0]');
  }
  expect(
    mapRaceManualReviewSourceInventory(envelope({ event: event() }, { athleteId: 'foreign' }))
      .unindexable,
  ).toContainEqual({ path: '$', reason: 'FOREIGN_SCOPE' });
});
it('session completion deletion key stays opaque session ID while exact identity preserves its Plan namespace', () => {
  const result = mapRaceManualReviewSourceInventory(
    envelope({ completions: [completion(two), completion(one)] }),
  );
  expect(result.inventoryState).toBe('mapped');
  expect(result.refs.map((ref) => [ref.sourceId, ref.versionKey])).toEqual([
    ['same-opaque-session', JSON.stringify([one, 1])],
    ['same-opaque-session', JSON.stringify([two, 1])],
  ]);
});
it('nutrition versions retain exact version UUIDs independently of current or historical aggregate head', () => {
  const record = (versionId: string) =>
    nutritionPlanVersionSchema.parse({
      planId: one,
      versionId,
      version: 1,
      previousVersionId: null,
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'UTC',
      purpose: 'Synthetic',
      linkedTrainingPlanVersionId: null,
      approvedAt: at,
      approvalId: three,
      items: [],
    });
  const result = mapRaceManualReviewSourceInventory(
    envelope({ nutrition: [{ record: record(two) }, { record: record(three) }] }),
  );
  expect(result.inventoryState).toBe('mapped');
  expect(result.refs.map((ref) => ref.versionKey)).toEqual([two, three]);
});
it('frozen routine blueprint/schedule/occurrence and stopped revision0 Run stay separate exact deletion families', () => {
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: one,
    versionId: two,
    title: 'Synthetic',
    intent: '',
    status: 'draft',
    tags: [],
    steps: [],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: at,
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: one,
    versionId: three,
    blueprint: { id: one, versionId: two },
    window: {
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'UTC',
      maxOccurrences: 100,
    },
    rule: { kind: 'dates', dates: ['2026-10-06'], localTime: null },
    state: 'ended',
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: two,
    schedule: { id: one, versionId: three },
    blueprint: { id: one, versionId: two },
    anchorKey: 'Synthetic',
    scheduledAt: null,
    timingStatus: 'unresolved',
    stepBindings: [],
    selectedChoices: {},
  });
  const run = routineRunSchema.parse({
    id: three,
    revision: 0,
    blueprint: { id: one, versionId: two },
    origin: { kind: 'unplanned' },
    state: 'stopped',
    progress: [],
    selectedChoices: {},
    startedAt: at,
    endedAt: at,
  });
  const result = mapRaceManualReviewSourceInventory(
    envelope({
      routineActualManifest: {
        blueprints: [{ record: blueprint }],
        schedules: [{ record: schedule }],
        occurrences: [{ record: occurrence }],
        runs: [{ record: run }],
      },
    }),
  );
  expect(result.inventoryState).toBe('mapped');
  expect(result.refs.map((ref) => [ref.kind, ref.sourceId, ref.versionKey])).toEqual([
    ['routine-blueprint-version', one, two],
    ['routine-occurrence', two, 'immutable'],
    ['routine-run', three, '0'],
    ['routine-schedule-version', one, three],
  ]);
});
it('bodyless unavailable/historical requested refs do not borrow current-head identity or create an actual body index', () => {
  const fact = {
    requested: { kind: 'activity', id: one, revisionId: '1' },
    state: 'unavailable',
    reason: 'requested_revision_unavailable',
    current: { id: one, revision: 2, deleted: false },
    content: null,
  };
  const result = mapRaceManualReviewSourceInventory(
    envelope({ routineActualManifest: { runs: [{ actuals: [{ fact }] }] } }),
  );
  expect(result.inventoryState).toBe('mapped');
  expect(result.refs).toEqual([]);
  expect(result.bodyless).toEqual([
    { path: 'context.routineActualManifest.runs[0].actuals[0].fact', state: 'unavailable' },
  ]);
});
it('unsupported copied actual and supplementary/food provenance bodies explicitly block indexing', () => {
  const input = envelope({
    routineActualManifest: {
      runs: [
        {
          actuals: [
            {
              fact: {
                state: 'current',
                content: {
                  original: { title: 'Synthetic private actual' },
                  overlay: { note: 'Synthetic' },
                  detail: { notes: 'Synthetic' },
                },
              },
            },
          ],
        },
      ],
    },
    supplementaryManifest: {
      copies: [{ link: { content: { kind: 'embedded', spec: { title: 'Synthetic' } } } }],
    },
    sourcePermissionManifest: {
      nestedNutritionSources: [{ foods: [{ content: { provenance: { kind: 'user_entered' } } }] }],
    },
  });
  const result = mapRaceManualReviewSourceInventory(input);
  expect(result.inventoryState).toBe('blocked');
  expect(result.allCopiedBodiesIndexed).toBe(false);
  expect(result.unindexable.some((row) => row.path.endsWith('.fact.content'))).toBe(true);
  expect(result.unindexable.some((row) => row.path.includes('.link.content'))).toBe(true);
  expect(result.unindexable.some((row) => row.path.includes('.foods[0].content'))).toBe(true);
});
it('strict plain JSON rejects unknown body scopes, getters, cycles, invalid IDs/revisions and candidate forgery', () => {
  expect(
    mapRaceManualReviewSourceInventory(envelope({ extraPrivateBody: { notes: 'Synthetic' } }))
      .inventoryState,
  ).toBe('blocked');
  expect(
    mapRaceManualReviewSourceInventory(envelope({ event: { ...event(), id: 'wrong' } }))
      .inventoryState,
  ).toBe('blocked');
  expect(
    mapRaceManualReviewSourceInventory(envelope({ event: { ...event(), revision: 0 } }))
      .inventoryState,
  ).toBe('blocked');
  expect(
    mapRaceManualReviewSourceInventory({
      ...envelope({ event: event() }),
      candidate: { body: event() },
    }).inventoryState,
  ).toBe('blocked');
  let reads = 0;
  const getter = Object.defineProperty({}, 'context', {
    enumerable: true,
    get: () => {
      reads++;
      return {};
    },
  });
  expect(mapRaceManualReviewSourceInventory(getter).inventoryState).toBe('blocked');
  expect(reads).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle['context'] = cycle;
  expect(mapRaceManualReviewSourceInventory(cycle).inventoryState).toBe('blocked');
});
it('decoded traversal is capped before duplicates collapse and UTF8 bytes include all physical copies', () => {
  const duplicated = envelope({ consumedSources: { races: Array.from({ length: 2501 }, event) } });
  expect(mapRaceManualReviewSourceInventory(duplicated).unindexable).toContainEqual({
    path: '$',
    reason: 'INPUT_BOUND',
  });
  const oversized = envelope({ unknownBody: '한'.repeat(1500000) });
  expect(mapRaceManualReviewSourceInventory(oversized).unindexable).toContainEqual({
    path: '$',
    reason: 'INPUT_BOUND',
  });
});

it('actual pure assembler candidate copies are indexed only against its exact captured context and retain false authority', () => {
  const race = event();
  const sourceInput = {
    athleteId: athlete,
    sourceFacts: { ownerAthleteId: athlete, nutritionRacePins: [] },
    projectionInput: {
      event: race,
      newLocalDate: '2026-10-08',
      currentPlan: null,
      sourcePlans: [],
      completionReports: [],
      selection: { kind: 'keep_plan' },
      nutrition: [],
      routines: [],
      resolutions: { nutrition: [], routines: [] },
    },
  };
  const candidate = assembleRaceManualReviewCandidate(
    sourceInput,
    createRaceRelativeScheduleCalculationPorts([race]),
  );
  if (candidate.status !== 'assembled') throw new Error('Expected actual pure assembler candidate');
  const binding = {
    athleteId: athlete,
    event: { id: race.id, revision: race.revision },
    readSetDigest: 'a'.repeat(64),
  };
  const input = {
    ...envelope({ event: race, consumedSources: { plans: [], races: [race] } }),
    status: 'prepared_blocked',
    sourceInput,
    candidate,
    binding,
  };
  const result = mapRaceManualReviewSourceInventory(input);
  expect(result.unindexable).toEqual([]);
  expect(result.inventoryState).toBe('mapped');
  expect(result.allCopiedBodiesIndexed).toBe(true);
  expect(result.refs[0]?.locations).toEqual([
    'candidate.body.event',
    'context.consumedSources.races[0]',
    'context.event',
    'sourceInput.projectionInput.event',
  ]);
  expect(result.storageAllowed).toBe(false);
  const forged = structuredClone(input);
  forged.candidate.body.event.title = 'Changed private draft';
  expect(mapRaceManualReviewSourceInventory(forged).inventoryState).toBe('blocked');
});

it('recovery exact version body is indexed independently of an unavailable historical aggregate association', () => {
  const record = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: one,
    versionId: two,
    version: 1,
    previousVersionId: null,
    status: 'draft',
    selectedOptionId: null,
    createdAt: at,
    draft: {
      title: 'Synthetic recovery',
      goal: '',
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        {
          id: three,
          title: 'Synthetic',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: '',
        },
      ],
      reassessment: [
        {
          id: three,
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Synthetic',
          policyVersion: null,
        },
      ],
    },
  });
  const result = mapRaceManualReviewSourceInventory(
    envelope({ recovery: [{ aggregateId: one, versionId: two, record }] }),
  );
  expect(result.inventoryState).toBe('mapped');
  expect(result.refs.map((ref) => [ref.kind, ref.sourceId, ref.versionKey])).toEqual([
    ['recovery-strategy-version', one, two],
  ]);
});

it('untyped scalar protected content cannot evade unsupported body diagnostics', () => {
  const result = mapRaceManualReviewSourceInventory(
    envelope({ actuals: { original: 'synthetic private text', content: 'synthetic excerpt' } }),
  );
  expect(result.inventoryState).toBe('blocked');
  expect(result.allCopiedBodiesIndexed).toBe(false);
  expect(result.unindexable).toEqual([
    { path: 'context.actuals.content', reason: 'unsupported_copied_body' },
    { path: 'context.actuals.original', reason: 'unsupported_copied_body' },
  ]);
});

it('accepts only exact bodyless producer metadata shapes at their captured context paths', () => {
  const input = envelope({
    restoreGeneration: one,
    affected: { routine: [one] },
    rosters: { routine: [{ aggregateId: one, versionId: two }] },
    manualBasis: {
      purpose: 'manual_race_date_change',
      app: { state: 'present', granted: true, revision: 1 },
      policy: { id: 'manual-race-date-impact', version: 1, digest: 'a'.repeat(64) },
    },
    sourcePermissionManifest: {
      activityMediaPermissions: {
        consents: [
          { kind: 'healthkit', state: 'absent' },
          { kind: 'media', state: 'present', granted: false, revision: 2 },
        ],
        garminLineage: [
          {
            kind: 'fit',
            source_id: 'synthetic-source',
            provider: 'garmin-connect-unofficial',
            official: false,
            outcome: 'suppressed',
          },
        ],
        healthkitRegistry: { state: 'present', revision: 2 },
        garminUnofficial: {
          state: 'present',
          connection: {
            session_generation: 0,
            state: 'not_connected',
            schedule_enabled: false,
            schedule_paused: true,
          },
        },
      },
    },
  });
  const result = mapRaceManualReviewSourceInventory(input);
  expect(result.inventoryState).toBe('mapped');
  expect(result.refs).toEqual([]);
  expect(result.storageAllowed).toBe(false);
  expect(
    mapRaceManualReviewSourceInventory(envelope({ restoreGeneration: 'invalid' })).inventoryState,
  ).toBe('blocked');
  expect(
    mapRaceManualReviewSourceInventory(envelope({ restoreGeneration: null })).inventoryState,
  ).toBe('blocked');
  expect(
    mapRaceManualReviewSourceInventory(envelope({ actuals: { restoreGeneration: one } }))
      .inventoryState,
  ).toBe('blocked');
  const injected = {
    ...input,
    context: { ...input.context, manualBasis: { ...input.context.manualBasis, record: event() } },
  };
  expect(mapRaceManualReviewSourceInventory(injected).inventoryState).toBe('blocked');
  const wrongPath = envelope({ manualBasis: null });
  expect(mapRaceManualReviewSourceInventory(wrongPath).inventoryState).toBe('blocked');
  expect(
    mapRaceManualReviewSourceInventory(
      envelope({ actuals: { manualBasis: input.context.manualBasis } }),
    ).inventoryState,
  ).toBe('blocked');
});
