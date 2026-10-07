import { expect, it } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineScheduleVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import {
  projectRaceRelativeScheduleImpactCompatibleV4,
  projectRaceRelativeScheduleImpact,
  raceRelativeScheduleImpactInputCompatibleV4Schema,
  type RaceRelativeScheduleImpactInputCompatibleV4,
  type RaceScheduleCalculationPortsCompatibleV4,
} from '../src/race-relative-schedule-impact.js';
import {
  raceRelativeScheduleImpactResultCompatibleV4Schema,
  raceRelativeScheduleImpactResultCompatibleV4BodySchema,
} from '../src/race-relative-schedule-impact-codecs.js';
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
function output(input = fixture(), calculations = ports()) {
  const result = projectRaceRelativeScheduleImpactCompatibleV4(input, calculations);
  if (result.status !== 'projected') throw Error(`Producer rejected ${result.reason}`);
  const parsed = raceRelativeScheduleImpactResultCompatibleV4Schema.parse(result);
  if (parsed.status !== 'projected') throw Error('Projected fixture missing');
  return parsed;
}
function context(value: ReturnType<typeof output>) {
  const nutrition = value.nutrition[0],
    entry = nutrition?.items[0];
  if (!nutrition || !entry) throw Error('Missing nutrition');
  return { nutrition, entry };
}
for (const version of [1, 2, 3, 4] as const)
  it(`roundtrips actual CompatibleV4 producer output with nutrition V${version}`, () => {
    const input = fixture(version),
      copy = structuredClone(input);
    const result = projectRaceRelativeScheduleImpactCompatibleV4(input, ports());
    expect(raceRelativeScheduleImpactResultCompatibleV4Schema.parse(result)).toEqual(result);
    expect(input).toEqual(copy);
    expect(result.approval.status).toBe('blocked');
  });
it('roundtrips unchanged legacy producer output without widening its wire or max200 resolutions', () => {
  const input = fixture(1);
  const result = projectRaceRelativeScheduleImpact(input, ports());
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.parse(result)).toEqual(result);
});
it('preserves long opaque item IDs, two immutable revisions, frozen before and hypothetical after separately', () => {
  const input = fixture(4, true),
    r = output(input),
    { nutrition, entry } = context(r);
  expect(entry.itemId).toHaveLength(1000);
  expect(entry.before).toEqual({ state: 'resolved', date: '2026-03-07', localTime: '06:00:00' });
  expect(entry.after).toEqual({ state: 'resolved', date: '2026-03-09', localTime: '07:00:00' });
  expect(nutrition.record).toEqual(input.nutrition[0]?.record);
  if (!('schemaVersion' in nutrition.record)) throw Error('No pin record');
  expect(nutrition.record.raceTimingPins.map((pin) => pin.eventRevision)).toEqual([1, 2]);
});
it('preserves disconnected body, null timing and unchanged notice without source reconstruction', () => {
  const r = output(),
    item = r.nutrition[0]?.items.find((i) => i.itemId === 'unlinked');
  expect(item).toMatchObject({
    state: 'unchanged',
    item: { anchor: { kind: 'disconnected', entity: 'race' } },
    before: { state: 'unresolved', reason: 'unsupported_anchor_mapping' },
    after: { state: 'unresolved', reason: 'unsupported_anchor_mapping' },
    notice: 'existing_unresolved_preserved',
  });
});
it('accepts actual affected missing race-end unresolved result', () => {
  const input = fixture();
  const record = input.nutrition[0]?.record;
  if (!record) throw Error('Missing record');
  for (const item of record.items) if (item.anchor.kind === 'relative') item.anchor.point = 'end';
  const r = output(input);
  expect(r.requiresResolution).toBe(true);
  expect(context(r).entry.after).toEqual({ state: 'unresolved', reason: 'missing_race_end' });
});
it('roundtrips declared anchor replacement and explicit resolved outcome', () => {
  const input = fixture();
  input.resolutions.nutrition = [
    {
      planVersionId: nutritionId,
      itemId: 'one',
      action: 'replace_anchor',
      anchor: { kind: 'absolute', date: '2026-03-09', localTime: null, timezone: 'UTC' },
    },
  ];
  const r = output(input);
  expect(context(r).nutrition.items.find((i) => i.itemId === 'one')).toMatchObject({
    resolution: { state: 'explicit', action: 'replace_anchor', outcome: 'resolved' },
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
it('roundtrips affected expansion while retaining original started occurrence/run and blueprint', () => {
  const { input, occurrence } = routineInput(),
    calc = ports();
  calc.expandRoutine = () => ({
    state: 'expanded',
    occurrences: [{ ...occurrence, scheduledAt: '2026-03-09T07:00:00Z' }],
  });
  const r = output(input, calc);
  expect(r.routines[0]).toMatchObject({
    state: 'affected',
    occurrences: [occurrence],
    projection: { retainedOccurrences: [occurrence], plannedOccurrences: [] },
  });
});
for (const state of ['unchanged', 'retained_ended', 'affected'] as const)
  it(`roundtrips ${state} routine finite branch`, () => {
    const { input } = routineInput(state === 'retained_ended' ? 'ended' : 'active');
    if (state === 'unchanged') input.selection = { kind: 'keep_plan' };
    expect(output(input).routines[0]?.state).toBe(state);
  });
for (const reason of [
  'invalid_input',
  'projection_bound',
  'invalid_port_result',
  'unsupported_resolution',
  'source_identity_mismatch',
  'missing_current_plan',
  'current_plan_mismatch',
  'completed',
  'locked',
  'invalid_result',
] as const)
  it(`accepts finite rejected ${reason}`, () => {
    const approval = output().approval;
    expect(
      raceRelativeScheduleImpactResultCompatibleV4Schema.parse({
        status: 'rejected',
        reason,
        approval,
      }),
    ).toEqual({ status: 'rejected', reason, approval });
  });
it('roundtrips actual producer rejection', () => {
  const r = projectRaceRelativeScheduleImpactCompatibleV4({ approve: true }, ports());
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.parse(r)).toEqual(r);
});
for (const [name, mutate] of [
  ['extra top field', (r: ReturnType<typeof output>) => ({ ...r, approved: true })],
  [
    'unknown notice',
    (r: ReturnType<typeof output>) => {
      const { entry } = context(r);
      return {
        ...r,
        nutrition: [{ ...r.nutrition[0], items: [{ ...entry, notice: 'verified' }] }],
      };
    },
  ],
  [
    'unknown timing reason',
    (r: ReturnType<typeof output>) => {
      const { entry } = context(r);
      return {
        ...r,
        nutrition: [
          {
            ...r.nutrition[0],
            items: [{ ...entry, after: { state: 'unresolved', reason: 'invented' } }],
          },
        ],
      };
    },
  ],
  [
    'unknown timing key',
    (r: ReturnType<typeof output>) => {
      const { entry } = context(r);
      return {
        ...r,
        nutrition: [
          {
            ...r.nutrition[0],
            items: [{ ...entry, before: { ...entry.before, sourceVerified: true } }],
          },
        ],
      };
    },
  ],
  [
    'wrong item ID',
    (r: ReturnType<typeof output>) => {
      context(r).entry.itemId = 'foreign';
      return r;
    },
  ],
  [
    'wrong version UUID',
    (r: ReturnType<typeof output>) => {
      context(r).nutrition.planVersionId = eventId;
      return r;
    },
  ],
  [
    'invalid UUID',
    (r: ReturnType<typeof output>) => {
      context(r).nutrition.planVersionId = 'not-a-uuid';
      return r;
    },
  ],
  [
    'duplicate item',
    (r: ReturnType<typeof output>) => {
      const { nutrition, entry } = context(r);
      nutrition.items.push(structuredClone(entry));
      return r;
    },
  ],
  [
    'missing item',
    (r: ReturnType<typeof output>) => {
      context(r).nutrition.items.pop();
      return r;
    },
  ],
  [
    'forged resolution summary',
    (r: ReturnType<typeof output>) => {
      r.requiresResolution = !r.requiresResolution;
      return r;
    },
  ],
  [
    'undeclared body change',
    (r: ReturnType<typeof output>) => {
      context(r).entry.item.instructions = 'Changed copied instruction';
      return r;
    },
  ],
  [
    'wrong approval reasons',
    (r: ReturnType<typeof output>) => ({
      ...r,
      approval: { status: 'blocked', reasons: ['only_one'] },
    }),
  ],
  [
    'rejected calendar nested in projected',
    (r: ReturnType<typeof output>) => ({
      ...r,
      calendar: { status: 'rejected', reason: 'invalid_input' },
    }),
  ],
] as const)
  it(`rejects ${name}`, () => {
    expect(
      raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(mutate(output())).success,
    ).toBe(false);
  });
it('rejects duplicated exact multipin tuple without live repinning', () => {
  const r = output(),
    { nutrition } = context(r);
  if (!('schemaVersion' in nutrition.record)) throw Error('No pin');
  const pin = nutrition.record.raceTimingPins[0];
  if (!pin) throw Error('No pin');
  nutrition.record.raceTimingPins.push(structuredClone(pin));
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(r).success).toBe(false);
});
it('rejects a noncanonical uppercase UUID in an otherwise exact immutable pin', () => {
  const r = output(),
    { nutrition } = context(r);
  if (!('schemaVersion' in nutrition.record)) throw Error('No pin');
  const pin = nutrition.record.raceTimingPins[0];
  if (!pin) throw Error('No pin');
  pin.eventId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(r).success).toBe(false);
});
it('rejects mutated retained started occurrence and wrong expansion/planned correspondence', () => {
  const { input, occurrence } = routineInput(),
    calc = ports();
  calc.expandRoutine = () => ({ state: 'expanded', occurrences: [occurrence] });
  const r = output(input, calc),
    routine = r.routines[0];
  if (!routine || routine.state !== 'affected') throw Error('No affected');
  const retained = routine.projection.retainedOccurrences[0];
  if (!retained) throw Error('No retained');
  retained.scheduledAt = '2026-03-08T07:00:00Z';
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(r).success).toBe(false);
});
it('rejects an unknown result branch and finite reason escape', () => {
  expect(
    raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse({ status: 'approved' }).success,
  ).toBe(false);
  expect(
    raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse({
      status: 'rejected',
      reason: 'all_ready',
      approval: output().approval,
    }).success,
  ).toBe(false);
});
it('bounds this successor envelope without redefining the legacy output allowance', () => {
  expect(
    raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse({
      ...output(),
      extra: '원'.repeat(1400000),
    }).success,
  ).toBe(false);
});
it('leaves the existing explicit resolution max200 input unchanged', () => {
  const input = fixture(4, true);
  input.resolutions.nutrition = [
    {
      planVersionId: nutritionId,
      itemId: 'a'.repeat(1000),
      action: 'replace_anchor',
      anchor: { kind: 'absolute', date: '2026-03-09', localTime: null, timezone: 'UTC' },
    },
  ];
  expect(projectRaceRelativeScheduleImpactCompatibleV4(input, ports())).toMatchObject({
    status: 'rejected',
    reason: 'invalid_input',
  });
});
it('rejects unknown nested routine fields and invalid expansion unions', () => {
  const { input } = routineInput();
  const r = output(input),
    routine = r.routines[0];
  if (!routine || routine.state !== 'affected') throw Error('No affected');
  expect(
    raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse({
      ...r,
      routines: [{ ...routine, sourceAuthorized: true }],
    }).success,
  ).toBe(false);
  expect(
    raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse({
      ...r,
      routines: [
        {
          ...routine,
          projection: {
            ...routine.projection,
            expansion: { state: 'expanded', reason: 'UNSUPPORTED_MAPPING' },
          },
        },
      ],
    }).success,
  ).toBe(false);
});
it('rejects changed after timing on unchanged disconnected body', () => {
  const r = output(),
    nutrition = context(r).nutrition;
  const entry = nutrition.items.find((item) => item.itemId === 'unlinked');
  if (!entry) throw Error('No disconnected');
  entry.after = { state: 'resolved', date: '2026-03-09', localTime: null };
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(r).success).toBe(false);
});
it('bounds undefined, circular and non-JSON envelopes before nested decoding', () => {
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(undefined).success).toBe(
    false,
  );
  const cycle: { child?: unknown } = {};
  cycle.child = cycle;
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(cycle).success).toBe(false);
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse({ value: 1n }).success).toBe(
    false,
  );
});
it('keeps legitimate finite internal output above4MiB distinct from the successor envelope cap', () => {
  const input = fixture(1);
  const template = input.nutrition[0]?.record.items[0];
  if (!template) throw Error('No item');
  input.nutrition = Array.from({ length: 5 }, (_, index) => {
    const versionId = `30000000-0000-4000-8000-${String(index + 11).padStart(12, '0')}`;
    const record = nutritionPlanVersionCompatibleV4Schema.parse({
      planId: '30000000-0000-4000-8000-000000000002',
      versionId,
      version: 1,
      previousVersionId: null,
      period: { from: '2026-03-01', toInclusive: '2026-03-31' },
      timezone: 'UTC',
      purpose: 'Synthetic bounded source',
      linkedTrainingPlanVersionId: null,
      approvedAt: '2026-03-01T00:00:00Z',
      approvalId: nutritionId,
      items: Array.from({ length: 200 }, (_, i) => ({
        ...template,
        id: `bounded-${i}`,
        planVersionId: versionId,
        anchor: { kind: 'absolute', date: '2026-03-07', localTime: null, timezone: 'UTC' },
        instructions: 'x'.repeat(2000),
      })),
    });
    return {
      record,
      timings: record.items.map((item) => ({
        itemId: item.id,
        timing: { state: 'resolved', date: '2026-03-07', localTime: null },
      })),
    };
  });
  expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThan(4194304);
  const result = projectRaceRelativeScheduleImpactCompatibleV4(input, ports());
  expect(result.status).toBe('projected');
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeGreaterThan(4194304);
  expect(raceRelativeScheduleImpactResultCompatibleV4BodySchema.safeParse(result).success).toBe(
    true,
  );
  expect(raceRelativeScheduleImpactResultCompatibleV4Schema.safeParse(result).success).toBe(false);
  expect(
    raceRelativeScheduleImpactResultCompatibleV4BodySchema.safeParse({ ...result, approved: true })
      .success,
  ).toBe(false);
});
it('keeps the internal body union strict even without the successor envelope wrapper', () => {
  expect(
    raceRelativeScheduleImpactResultCompatibleV4BodySchema.safeParse({
      ...output(),
      authority: 'approved',
    }).success,
  ).toBe(false);
  expect(
    raceRelativeScheduleImpactResultCompatibleV4BodySchema.safeParse({
      status: 'rejected',
      reason: 'invented',
      approval: output().approval,
    }).success,
  ).toBe(false);
});
