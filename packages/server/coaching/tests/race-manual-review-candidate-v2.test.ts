import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { expect, it } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  raceRelativeScheduleImpactInputCompatibleV4Schema,
  type RaceRelativeScheduleImpactInputCompatibleV4,
  type RaceScheduleCalculationPortsCompatibleV4,
} from '../src/race-relative-schedule-impact.js';
import {
  assembleRaceManualReviewCandidateCompatibleV4,
  raceManualReviewCandidateV2InputSchema,
  raceManualReviewCandidateV2ResultSchema,
  raceManualReviewCandidateV2BodySchema,
} from '../src/race-manual-review-candidate-v2.js';
const eventId = '20000000-0000-4000-8000-000000000001',
  planId = '10000000-0000-4000-8000-000000000001',
  nutritionId = '30000000-0000-4000-8000-000000000001';
function fixture(
  version: 1 | 2 | 3 | 4 = 4,
  long = false,
): RaceRelativeScheduleImpactInputCompatibleV4 {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const plan = planSnapshotSchema.parse({
    id: planId,
    version: 1,
    createdAt: '2026-03-01T00:00:00Z',
    draft: {
      title: 'Synthetic',
      timezone: 'UTC',
      periods: levels.map((level, i) => ({
        id: level,
        parentId: i ? levels[i - 1] : null,
        level,
        title: level,
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'Session',
          blockId: 'block',
          date: '2026-03-07',
          localStartTime: '07:00:00',
          title: 'Synthetic',
          sport: 'running',
          durationSeconds: 0,
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
  const makeItem = (id: string, disconnected = false) => ({
    id,
    planVersionId: nutritionId,
    category: 'before',
    title: 'Synthetic',
    anchor: disconnected
      ? { kind: 'disconnected', entity: 'race' }
      : { kind: 'relative', entity: 'race', entityId: eventId, point: 'start', offsetMinutes: 0 },
    foods: [],
    targets: [],
    instructions: 'Explicit synthetic action',
    evidenceIds: [],
    source: 'user_confirmed',
  });
  const ids = [long ? 'a'.repeat(1000) : 'one', 'two'];
  const pin = (revision: number) => ({
    pinVersion: 1,
    namespace: 'race-event-revision',
    eventId,
    eventRevision: revision,
    sourceDigestVersion: 'race-event-values-canonical-v1',
    sourceDigest: 'a'.repeat(64),
    localDate: '2026-03-07',
    localStartTime: '06:00:00',
    timezone: 'UTC',
    start: { state: 'known', instant: '2026-03-07T06:00:00Z' },
    end: { state: 'unknown', reason: 'race_end_not_recorded' },
  });
  const record = nutritionPlanVersionCompatibleV4Schema.parse({
    planId: '30000000-0000-4000-8000-000000000002',
    versionId: nutritionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-03-01', toInclusive: '2026-03-31' },
    timezone: 'UTC',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: planId,
    approvedAt: '2026-03-01T00:00:00Z',
    approvalId: nutritionId,
    items: [
      ...ids.map((id) => makeItem(id)),
      ...(version >= 3 ? [makeItem('unlinked', true)] : []),
    ],
    ...(version === 1
      ? {}
      : {
          schemaVersion: version,
          raceTimingPins: version === 4 ? [pin(1), pin(2)] : [pin(1)],
          itemRaceTimingBindings: ids.map((itemId, i) => ({
            itemId,
            binding: { state: 'captured', eventId, eventRevision: version === 4 ? i + 1 : 1 },
          })),
        }),
  });
  return raceRelativeScheduleImpactInputCompatibleV4Schema.parse({
    event: {
      id: eventId,
      revision: 3,
      title: 'Synthetic race',
      localDate: '2026-03-07',
      localStartTime: '07:00:00',
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: planId,
    },
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
            item.anchor.kind === 'disconnected'
              ? { state: 'unresolved', reason: 'unsupported_anchor_mapping' }
              : { state: 'resolved', date: '2026-03-07', localTime: '06:00:00' },
        })),
      },
    ],
    routines: [],
    resolutions: { nutrition: [], routines: [] },
  });
}
/** Pure calculation fixtures, not ownership/real timing/PG evidence. */
function ports(): RaceScheduleCalculationPortsCompatibleV4 {
  return {
    resolveNutrition: ({ event, item }) =>
      item.anchor.kind === 'absolute'
        ? { state: 'resolved', date: item.anchor.date, localTime: item.anchor.localTime }
        : { state: 'resolved', date: event.localDate, localTime: '07:00:00' },
    expandRoutine: () => ({ state: 'unresolved', reason: 'UNSUPPORTED_MAPPING' }),
  };
}

function input(version: 1 | 2 | 3 | 4 = 4, long = false) {
  const projectionInput = fixture(version, long);
  return raceManualReviewCandidateV2InputSchema.parse({
    athleteId: 'synthetic-athlete',
    binding: {
      purpose: 'manual_race_date_change',
      event: { id: eventId, revision: 3 },
      appRevision: 1,
      policy: { id: 'manual-race-date-impact', version: 1, digest: 'b'.repeat(64) },
      restoreGeneration: '40000000-0000-4000-8000-000000000001',
      readSetDigest: 'c'.repeat(64),
    },
    projectionInput,
    sourceFacts: {
      ownerAthleteId: 'synthetic-athlete',
      nutritionRacePins: projectionInput.nutrition.flatMap(({ record }) =>
        record.items
          .filter((item) => item.anchor.kind === 'relative' && item.anchor.entity === 'race')
          .map((item) => ({
            nutritionVersionId: record.versionId,
            itemId: item.id,
            binding:
              'schemaVersion' in record
                ? record.itemRaceTimingBindings.find((row) => row.itemId === item.id)?.binding
                : { state: 'legacy_unpinned' },
          })),
      ),
    },
  });
}
function assembled(value = input()) {
  const result = assembleRaceManualReviewCandidateCompatibleV4(value, ports());
  if (result.status !== 'assembled_readonly') throw Error(result.reason);
  return result;
}
for (const version of [1, 2, 3, 4] as const)
  it(`assembles V${version} immutable sources with no persisted approval authority`, () => {
    const value = input(version),
      copy = structuredClone(value),
      result = assembled(value);
    expect(value).toEqual(copy);
    expect(raceManualReviewCandidateV2ResultSchema.parse(result)).toEqual(result);
    expect(result.body.projection.nutrition[0]?.record).toEqual(
      value.projectionInput.nutrition[0]?.record,
    );
    expect(result.body.coverage.complete).toBe(false);
    expect(result.body.coverage.missing).toHaveLength(5);
    expect(result).toMatchObject({
      authority: 'none',
      freshness: 'not_checked',
      approvalAllowed: false,
      storage: 'not_persisted',
    });
    expect(Object.isFrozen(result.body.projection.nutrition)).toBe(true);
    expect(result.body.unresolvedBindingItems).toHaveLength(version === 1 ? 2 : 0);
  });
it('keeps historical multipins separate from current prospective revision', () => {
  const result = assembled();
  expect(result.body.pinTransitions.map((row) => row.savedPin?.eventRevision)).toEqual([1, 2]);
  for (const row of result.body.pinTransitions) {
    expect(row.proposedCurrentSource).toEqual({ eventId, eventRevision: 3 });
    expect(row.proposedTarget).toEqual({ eventId, eventRevision: 4 });
    expect(row.allocation).toBe('not_allocated');
  }
});
it('retains disconnected state and zero/null source facts without new timing', () => {
  const result = assembled(),
    row = result.body.projection.nutrition[0]?.items.find((row) => row.itemId === 'unlinked');
  expect(row).toMatchObject({
    state: 'unchanged',
    before: { state: 'unresolved', reason: 'unsupported_anchor_mapping' },
    after: { state: 'unresolved', reason: 'unsupported_anchor_mapping' },
  });
  expect(result.body.pinTransitions.some((row) => row.itemId === 'unlinked')).toBe(false);
  expect(result.body.projectionInput.event.targetSeconds).toBe(0);
  expect(result.body.projectionInput.event.locationName).toBeNull();
});
it('accepts long saved IDs while keeping explicit resolution max200', () => {
  const value = input(4, true);
  expect(assembled(value).body.pinTransitions[0]?.itemId).toHaveLength(1000);
  value.projectionInput.resolutions.nutrition = [
    {
      planVersionId: nutritionId,
      itemId: 'a'.repeat(1000),
      action: 'replace_anchor',
      anchor: { kind: 'absolute', date: '2026-03-09', localTime: null, timezone: 'UTC' },
    },
  ];
  expect(assembleRaceManualReviewCandidateCompatibleV4(value, ports())).toMatchObject({
    status: 'rejected',
    reason: 'invalid_input',
  });
});
it('normalizes declared set rosters without sorting original item arrays', () => {
  const a = input(),
    b = structuredClone(a);
  b.sourceFacts.nutritionRacePins.reverse();
  b.projectionInput.nutrition[0]?.timings.reverse();
  expect(assembled(a).digest).toBe(assembled(b).digest);
  const c = input();
  c.projectionInput.nutrition[0]?.record.items.reverse();
  expect(assembled(c).body.projection.nutrition[0]?.record.items).toEqual(
    c.projectionInput.nutrition[0]?.record.items,
  );
  expect(assembled(c).digest).not.toBe(assembled(a).digest);
});
for (const [name, mutate, reason] of [
  [
    'foreign owner',
    (v: ReturnType<typeof input>) => {
      v.sourceFacts.ownerAthleteId = 'foreign';
    },
    'foreign_source_scope',
  ],
  [
    'stale binding',
    (v: ReturnType<typeof input>) => {
      v.binding.event.revision = 2;
    },
    'binding_mismatch',
  ],
  [
    'missing pin',
    (v: ReturnType<typeof input>) => {
      v.sourceFacts.nutritionRacePins.pop();
    },
    'unmatched_pin_fact',
  ],
  [
    'duplicate pin',
    (v: ReturnType<typeof input>) => {
      const r = v.sourceFacts.nutritionRacePins[0];
      if (r) v.sourceFacts.nutritionRacePins.push(r);
    },
    'duplicate_pin_fact',
  ],
  [
    'extra pin',
    (v: ReturnType<typeof input>) => {
      const r = v.sourceFacts.nutritionRacePins[0];
      if (r) v.sourceFacts.nutritionRacePins.push({ ...r, itemId: 'extra' });
    },
    'unmatched_pin_fact',
  ],
  [
    'wrong captured binding',
    (v: ReturnType<typeof input>) => {
      const r = v.sourceFacts.nutritionRacePins[0];
      if (r) r.binding = { state: 'captured', eventId, eventRevision: 2 };
    },
    'pin_source_mismatch',
  ],
  [
    'revision overflow',
    (v: ReturnType<typeof input>) => {
      v.binding.event.revision = 2147483647;
      v.projectionInput.event.revision = 2147483647;
    },
    'race_revision_overflow',
  ],
] as const)
  it(`rejects ${name}`, () => {
    const v = input();
    mutate(v);
    expect(assembleRaceManualReviewCandidateCompatibleV4(v, ports())).toMatchObject({
      status: 'rejected',
      reason,
    });
  });
it('rejects malformed calculation output and unavailable calculation ports', () => {
  expect(
    assembleRaceManualReviewCandidateCompatibleV4(input(), {
      ...ports(),
      resolveNutrition: () => ({ state: 'resolved', date: 'invalid', localTime: null }),
    }).status,
  ).toBe('rejected');
  expect(
    assembleRaceManualReviewCandidateCompatibleV4(input(), {
      ...ports(),
      resolveNutrition: () => {
        throw Error('synthetic failure');
      },
    }),
  ).toMatchObject({ status: 'rejected', reason: 'invalid_port_result' });
});
it('rejects body checksum tampering, unknown fields and authority escalation', () => {
  const result = assembled();
  expect(
    raceManualReviewCandidateV2ResultSchema.safeParse({ ...result, digest: 'd'.repeat(64) })
      .success,
  ).toBe(false);
  expect(
    raceManualReviewCandidateV2ResultSchema.safeParse({ ...result, approvalAllowed: true }).success,
  ).toBe(false);
  expect(
    raceManualReviewCandidateV2ResultSchema.safeParse({ ...result, receiptId: nutritionId })
      .success,
  ).toBe(false);
});
it('does not execute getters or accept non-JSON structures', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'athleteId', {
    enumerable: true,
    get() {
      calls++;
      return 'synthetic-athlete';
    },
  });
  for (const value of [
    getter,
    new Date(),
    { ...input(), unexpected: 1 },
    { ...input(), binding: { ...input().binding, restoreGeneration: '0' } },
  ])
    expect(assembleRaceManualReviewCandidateCompatibleV4(value, ports()).status).toBe('rejected');
  expect(calls).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(assembleRaceManualReviewCandidateCompatibleV4(cycle, ports()).status).toBe('rejected');
});
it('rejects input above the explicit4MiB successor boundary', () => {
  const v = input();
  if (!v.projectionInput.currentPlan) throw Error('Missing current plan');
  v.projectionInput.currentPlan.draft.title = 'x'.repeat(4194304);
  expect(assembleRaceManualReviewCandidateCompatibleV4(v, ports())).toMatchObject({
    status: 'rejected',
    reason: 'invalid_input',
  });
});

function routineInput(state: 'active' | 'ended' = 'active') {
  const input = fixture();
  input.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: planId,
    periodId: 'season',
    newStartDate: '2026-03-03',
    scope: 'descendants_and_sessions',
  };
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: 'blueprint',
    versionId: 'blueprint-v1',
    title: 'Synthetic',
    intent: '',
    status: 'published',
    tags: [],
    steps: [],
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
      timezone: 'UTC',
      maxOccurrences: 2,
    },
    rule: { kind: 'session_links', sessionIds: ['Session'], point: 'start', offsetMinutes: 0 },
    state,
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: 'occurrence',
    schedule: { id: record.id, versionId: record.versionId },
    blueprint: record.blueprint,
    anchorKey: 'Session:start',
    scheduledAt: '2026-03-07T07:00:00Z',
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  const run = routineRunSchema.parse({
    id: 'run',
    revision: 1,
    blueprint: record.blueprint,
    origin: { kind: 'planned', occurrenceId: occurrence.id },
    state: 'stopped',
    progress: [],
    selectedChoices: {},
    startedAt: '2026-03-07T07:00:00Z',
    endedAt: '2026-03-07T07:00:00Z',
  });
  input.routines = [
    { record, blueprint, sourcePlanVersionId: planId, occurrences: [occurrence], runs: [run] },
  ];
  return { input, occurrence };
}

it('preserves ended schedule frozen blueprint and stopped run without new actuals', () => {
  const v = input(),
    r = routineInput('ended');
  v.projectionInput = r.input;
  const result = assembled(v),
    row = result.body.projection.routines[0];
  expect(row).toMatchObject({
    state: 'retained_ended',
    occurrences: [r.occurrence],
    runs: [{ state: 'stopped' }],
  });
  expect(row?.runs).toEqual(r.input.routines[0]?.runs);
  expect(result.body.projectionInput.routines[0]?.blueprint).toEqual(
    r.input.routines[0]?.blueprint,
  );
});
it('keeps race end unresolved rather than fabricating a proposed finish', () => {
  const v = input(),
    record = v.projectionInput.nutrition[0]?.record;
  if (!record) throw Error('Missing nutrition');
  for (const item of record.items) if (item.anchor.kind === 'relative') item.anchor.point = 'end';
  const result = assembled(v);
  expect(result.body.projection.nutrition[0]?.items[0]?.after).toEqual({
    state: 'unresolved',
    reason: 'missing_race_end',
  });
});
it('accepts a large legitimate opaque item ID within the assembled4MiB envelope', () => {
  const v = input(),
    row = v.projectionInput.nutrition[0];
  if (!row || !('schemaVersion' in row.record)) throw Error('Missing source');
  const id = 'a'.repeat(250000),
    first = row.record.items[0],
    timing = row.timings[0],
    binding = row.record.itemRaceTimingBindings[0],
    fact = v.sourceFacts.nutritionRacePins[0];
  if (!first || !timing || !binding || !fact) throw Error('Missing tuple');
  first.id = id;
  timing.itemId = id;
  binding.itemId = id;
  fact.itemId = id;
  const result = assembled(v);
  expect(result.body.pinTransitions[0]?.itemId).toBe(id);
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeGreaterThan(2000000);
});
it('uses UTF16 order for opaque ID sets and preserves the saved semantic record array', () => {
  const v = input(),
    row = v.projectionInput.nutrition[0];
  if (!row || !('schemaVersion' in row.record)) throw Error('Missing source');
  for (const [index, id] of ['\u{10000}', '\uE000'].entries()) {
    const item = row.record.items[index],
      timing = row.timings[index],
      binding = row.record.itemRaceTimingBindings[index],
      fact = v.sourceFacts.nutritionRacePins[index];
    if (!item || !timing || !binding || !fact) throw Error('Missing tuple');
    item.id = id;
    timing.itemId = id;
    binding.itemId = id;
    fact.itemId = id;
  }
  const result = assembled(v);
  expect(result.body.pinTransitions.map((row) => row.itemId)).toEqual(['\u{10000}', '\uE000']);
  expect(result.body.projection.nutrition[0]?.record.items.map((row) => row.id)).toEqual([
    '\u{10000}',
    '\uE000',
    'unlinked',
  ]);
});

it('retains canonical unplanned roster and rejects omitted output without inventing schedule', () => {
  const value = input();
  const { input: p } = routineInput();
  const scheduled = p.routines[0];
  if (!scheduled) throw Error('fixture');
  value.projectionInput = {
    ...p,
    routines: [],
    retainedUnplannedRuns: [
      {
        blueprint: scheduled.blueprint,
        run: routineRunSchema.parse({
          ...scheduled.runs[0],
          origin: { kind: 'unplanned' },
          id: 'Run-B',
        }),
      },
      {
        blueprint: scheduled.blueprint,
        run: routineRunSchema.parse({
          ...scheduled.runs[0],
          origin: { kind: 'unplanned' },
          id: 'Run-A',
        }),
      },
    ],
  };
  const result = assembled(value);
  expect(result.body.projection.retainedUnplannedRuns?.map((r) => r.run.id)).toEqual([
    'Run-A',
    'Run-B',
  ]);
  expect(result.body.projection.routines).toEqual([]);
  expect(result.approvalAllowed).toBe(false);
  expect(
    raceManualReviewCandidateV2BodySchema.safeParse({
      ...result.body,
      projection: { ...result.body.projection, retainedUnplannedRuns: [] },
    }).success,
  ).toBe(false);
});
