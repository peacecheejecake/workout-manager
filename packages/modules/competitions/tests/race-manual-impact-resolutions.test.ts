import { expect, it } from 'vitest';
import { raceManualPublicImpactSchema } from '@workout/contracts/race-manual-public-impact';
import { prepareRaceManualImpactResolutions } from '../src/race-manual-impact-resolutions';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
function fixture() {
  const race = {
    title: 'Race',
    localDate: '2026-10-09',
    localStartTime: null,
    timezone: 'UTC',
    distance: { kind: 'standard', class: '5k' },
    priority: null,
    participation: 'registered',
    targetSeconds: 0,
  };
  const item = {
    id: 'meal-식-' + 'x'.repeat(201),
    category: 'before',
    title: 'Meal',
    anchor: { kind: 'absolute', date: '2026-10-09', localTime: null, timezone: 'UTC' },
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
  };
  const plan = {
    period: { from: '2026-10-08', toInclusive: '2026-10-11' },
    purpose: 'Fuel',
    timezone: 'UTC',
    items: [item],
  };
  const unresolved = { state: 'unresolved', reason: 'missing_session_time' };
  return {
    schemaVersion: 1,
    status: 'projected',
    approvalAllowed: false,
    persistence: 'not_stored',
    freshness: 'not_checked',
    expectedEvent: { id: id(1), revision: 2 },
    intent: {
      expectedEvent: { id: id(1), revision: 2 },
      newLocalDate: '2026-10-10',
      selection: { kind: 'keep_plan' },
      resolutions: { nutrition: [], routines: [] },
    },
    beforeBasis: 'captured_snapshot',
    afterBasis: 'hypothetical',
    race: {
      eventId: id(1),
      expectedRevision: 2,
      before: race,
      after: { ...race, localDate: '2026-10-10' },
    },
    training: { state: 'absent' },
    recovery: { state: 'absent' },
    routines: { state: 'absent' },
    nutrition: {
      state: 'present',
      members: [
        {
          aggregateId: id(2),
          before: {
            ref: { versionId: id(3), version: 1 },
            plan,
            linkedTraining: { kind: 'absent' },
          },
          after: { plan: structuredClone(plan), linkedTraining: { kind: 'absent' } },
          timings: [
            {
              itemId: item.id,
              state: 'unchanged',
              before: unresolved,
              after: unresolved,
              resolution: 'absent',
              requirement: 'none',
            },
          ],
        },
      ],
    },
    retainedUnplanned: [],
    affected: [],
    resolutionRequirements: [],
    notices: [
      { domain: 'nutrition', aggregateId: id(2), itemId: item.id, code: 'UNCHANGED_UNRESOLVED' },
    ],
  };
}
function routineFixture() {
  const blueprint = {
    schemaVersion: 4,
    routineId: 'bp',
    versionId: 'bp-v1',
    title: 'Routine',
    intent: 'Check',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Check',
        content: { kind: 'checklist', prompt: 'Ready?' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: 0,
    createdAt: '2026-10-08T00:00:00.123456Z',
  };
  const schedule = {
    schemaVersion: 4,
    id: id(4),
    versionId: 'schedule-old',
    blueprint: { id: 'bp', versionId: 'bp-v1' },
    window: {
      startDate: '2026-10-08',
      endDateExclusive: '2026-10-12',
      timezone: 'UTC',
      maxOccurrences: 10,
    },
    rule: { kind: 'period_days', periodId: 'p', offsetsDays: [0, 1], localTime: null },
    state: 'ended',
  };
  const side = {
    schedule,
    sourcePlanVersionId: null,
    expansion: { state: 'unresolved', reason: 'SOURCE_PLAN_REQUIRED' },
  };
  return {
    ...fixture(),
    routines: {
      state: 'present',
      members: [
        {
          aggregateId: id(4),
          state: 'retained_ended',
          blueprint,
          before: side,
          after: structuredClone(side),
          retainedStarted: [],
          storedOccurrences: [
            {
              occurrenceId: 'occ',
              schedule: { id: id(4), versionId: 'schedule-old' },
              blueprint: { id: 'bp', versionId: 'bp-v1' },
              sourcePlanVersionId: null,
              anchorKey: 'period:p:0',
              scheduledAt: null,
              timingStatus: 'unresolved',
              unresolvedReason: null,
            },
          ],
          resolution: 'absent',
          requirement: 'none',
        },
      ],
    },
    resolutionRequirements: [],
    notices: [
      ...fixture().notices,
      {
        domain: 'routine_schedule',
        aggregateId: id(4),
        itemId: null,
        code: 'ENDED_SCHEDULE_RETAINED',
      },
      {
        domain: 'routine_schedule',
        aggregateId: id(4),
        itemId: null,
        code: 'UNCHANGED_UNRESOLVED',
      },
    ],
  };
}
function affectedNutrition() {
  const p = raceManualPublicImpactSchema.parse(fixture());
  if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
  const m = p.nutrition.members[0];
  const t = m?.timings[0];
  if (!m || !t) throw Error('fixture');
  t.state = 'affected';
  t.requirement = 'resolve_before_review';
  p.notices = [];
  p.affected = [{ domain: 'nutrition', aggregateId: m.aggregateId }];
  p.resolutionRequirements = [
    {
      domain: 'nutrition',
      aggregateId: m.aggregateId,
      planVersionId: m.before.ref.versionId,
      itemId: t.itemId,
      reason: 'affected_timing_unresolved',
      editor: 'replace_anchor',
    },
  ];
  return raceManualPublicImpactSchema.parse(p);
}
function command(p: ReturnType<typeof affectedNutrition>) {
  if (p.status !== 'projected') throw Error('fixture');
  return { schemaVersion: 1, intent: p.intent };
}
function replacement() {
  const p = affectedNutrition();
  if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
  const member = p.nutrition.members[0],
    item = member?.before.plan.items[0];
  if (!member || !item) throw Error('fixture');
  return {
    planVersionId: member.before.ref.versionId,
    itemId: item.id,
    action: 'replace_anchor',
    anchor: { kind: 'absolute', date: '2026-10-10', localTime: null, timezone: 'UTC' },
  };
}
it('prepares an exact long opaque item replacement without changing food facts or claiming timing/approval', () => {
  const p = affectedNutrition();
  const original = structuredClone(p);
  const r = replacement();
  const result = prepareRaceManualImpactResolutions(command(p), p, {
    nutrition: [r],
    routines: [],
  });
  expect(result.prepare.intent.resolutions.nutrition).toEqual([r]);
  expect(result.outstandingRequirements).toEqual([]);
  expect(result).toMatchObject({
    status: 'input_prepared',
    timingResolution: 'not_checked',
    approvalAllowed: false,
    persistence: 'not_stored',
  });
  expect(p).toEqual(original);
  expect(r.itemId.length).toBeGreaterThan(200);
});
it('retains unresolved requirements when the user provides no replacement', () => {
  const p = affectedNutrition();
  if (p.status !== 'projected') throw Error('fixture');
  expect(
    prepareRaceManualImpactResolutions(command(p), p, { nutrition: [], routines: [] })
      .outstandingRequirements,
  ).toEqual(p.resolutionRequirements);
});
it.each([
  'foreign_version',
  'case_sensitive_item',
  'duplicate',
  'unknown_field',
  'partial_anchor',
  'fake_recovery',
])('rejects %s replacement instead of accepting authority or partial content', (kind) => {
  const p = affectedNutrition();
  const r = replacement();
  const resolutions =
    kind === 'foreign_version'
      ? { nutrition: [{ ...r, planVersionId: id(99) }], routines: [] }
      : kind === 'case_sensitive_item'
        ? { nutrition: [{ ...r, itemId: r.itemId.toUpperCase() }], routines: [] }
        : kind === 'duplicate'
          ? { nutrition: [r, { ...r, planVersionId: r.planVersionId.toUpperCase() }], routines: [] }
          : kind === 'unknown_field'
            ? { nutrition: [{ ...r, confirmed: true }], routines: [] }
            : kind === 'partial_anchor'
              ? {
                  nutrition: [{ ...r, anchor: { kind: 'absolute', date: '2026-10-10' } }],
                  routines: [],
                }
              : { nutrition: [], routines: [], recovery: [{ confirmed: true }] };
  expect(() => prepareRaceManualImpactResolutions(command(p), p, resolutions)).toThrow();
});
it('validates exact routine frozen version and full bounded replacement without resuming ended schedules', () => {
  const p = raceManualPublicImpactSchema.parse(routineFixture());
  if (p.status !== 'projected' || p.routines.state !== 'present') throw Error('fixture');
  const m = p.routines.members[0];
  if (!m) throw Error('fixture');
  m.state = 'affected';
  m.before.schedule.state = 'active';
  m.after.schedule.state = 'active';
  m.requirement = 'resolve_before_review';
  p.affected = [{ domain: 'routine_schedule', aggregateId: m.aggregateId }];
  p.notices = p.notices.filter((n) => n.domain !== 'routine_schedule');
  p.resolutionRequirements = [
    {
      domain: 'routine_schedule',
      aggregateId: m.aggregateId,
      scheduleVersionId: m.before.schedule.versionId,
      reason: 'affected_timing_unresolved',
      editor: 'replace_rule',
    },
  ];
  const valid = raceManualPublicImpactSchema.parse(p);
  const r = {
    scheduleVersionId: m.before.schedule.versionId,
    action: 'replace_rule',
    rule: { kind: 'dates', dates: ['2026-10-10'], localTime: null },
    window: m.before.schedule.window,
    sourcePlanVersionId: null,
  };
  expect(
    prepareRaceManualImpactResolutions(command(valid), valid, { nutrition: [], routines: [r] })
      .prepare.intent.resolutions.routines,
  ).toEqual([r]);
  for (const wrong of [
    { ...r, scheduleVersionId: 'SCHEDULE-OLD' },
    { ...r, rule: { kind: 'dates' } },
    { ...r, window: { ...r.window, maxOccurrences: 0 } },
  ])
    expect(() =>
      prepareRaceManualImpactResolutions(command(valid), valid, {
        nutrition: [],
        routines: [wrong],
      }),
    ).toThrow();
  const ended = raceManualPublicImpactSchema.parse(routineFixture());
  expect(() =>
    prepareRaceManualImpactResolutions(command(ended), ended, { nutrition: [], routines: [r] }),
  ).toThrow();
});
it('rejects stale diagnostic bindings and bounded/accessor inputs without executing getters', () => {
  const p = affectedNutrition();
  const c = command(p);
  for (const altered of [
    { ...c, intent: { ...c.intent, expectedEvent: { id: id(9), revision: 2 } } },
    { ...c, intent: { ...c.intent, newLocalDate: '2026-10-11' } },
  ])
    expect(() =>
      prepareRaceManualImpactResolutions(altered, p, { nutrition: [], routines: [] }),
    ).toThrow();
  let calls = 0;
  expect(() =>
    prepareRaceManualImpactResolutions(c, p, {
      get nutrition() {
        calls++;
        return [];
      },
      routines: [],
    }),
  ).toThrow();
  expect(calls).toBe(0);
  expect(() =>
    prepareRaceManualImpactResolutions(c, p, {
      nutrition: [],
      routines: [],
      unknown: 'x'.repeat(4194305),
    }),
  ).toThrow();
  expect(() =>
    prepareRaceManualImpactResolutions(
      c,
      {
        schemaVersion: 1,
        status: 'blocked',
        approvalAllowed: false,
        persistence: 'not_stored',
        freshness: 'not_checked',
        reason: 'source_unavailable',
        domains: [],
      },
      { nutrition: [], routines: [] },
    ),
  ).toThrow();
});
