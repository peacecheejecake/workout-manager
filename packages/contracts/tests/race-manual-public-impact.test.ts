import { describe, expect, it } from 'vitest';
import { raceManualPublicImpactSchema } from '../src/race-manual-public-impact.js';
function first<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (value === undefined) throw Error('fixture');
  return value;
}
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
function linkedOnlyFixture() {
  const p = fixture(),
    n = p.nutrition.members[0];
  if (!n) throw Error('fixture');
  const before = {
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
  };
  const after = {
    ...before,
    periods: [{ ...before.periods[0], startDate: '2026-10-08', endDateExclusive: '2026-10-12' }],
  };
  return {
    ...p,
    intent: {
      ...p.intent,
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: id(10),
        periodId: 'season',
        newStartDate: '2026-10-08',
        scope: 'period_only',
      },
    },
    training: {
      state: 'present',
      members: [
        {
          aggregateId: id(11),
          before: { ref: { versionId: id(10), version: 1 }, plan: before },
          after: { kind: 'new_version_on_approval', plan: after },
        },
      ],
    },
    nutrition: {
      state: 'present',
      members: [
        {
          ...n,
          before: { ...n.before, linkedTraining: { kind: 'retained', versionId: id(10) } },
          after: {
            ...n.after,
            linkedTraining: { kind: 'follows_training_approval', aggregateId: id(11) },
          },
        },
      ],
    },
    affected: [
      { domain: 'training', aggregateId: id(11) },
      { domain: 'nutrition', aggregateId: n.aggregateId },
    ],
  };
}
function member(p: ReturnType<typeof fixture>) {
  const m = p.nutrition.members[0];
  if (!m) throw Error('fixture');
  return m;
}
function timing(p: ReturnType<typeof fixture>) {
  const t = member(p).timings[0];
  if (!t) throw Error('fixture');
  return t;
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
describe('transient public impact', () => {
  it('preserves long opaque item, zero/null and unchanged unresolved', () => {
    const p = fixture();
    expect(raceManualPublicImpactSchema.parse(p)).toMatchObject(p);
  });
  it('requires exact unresolved affected tuple without pretending ready', () => {
    const p = raceManualPublicImpactSchema.parse(fixture());
    if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
    const m = p.nutrition.members[0];
    if (!m) throw Error('fixture');
    const t = m.timings[0];
    if (!t) throw Error('fixture');
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
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
    p.resolutionRequirements = [];
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
  });
  it('rejects changed food on a date-only diagnostic', () => {
    const p = fixture();
    const food = member(p).after.plan.items[0]?.foods[0];
    if (!food) throw Error('fixture');
    food.quantity = 1;
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
  });
  it('rejects dirty version/identity and extra authority', () => {
    const p = fixture();
    p.expectedEvent.revision = 3;
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse({ ...fixture(), candidateId: id(8) }).success,
    ).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse({ ...fixture(), approvalAllowed: true }).success,
    ).toBe(false);
  });
  it('rejects duplicate and foreign requirements', () => {
    const p = fixture();
    p.notices.push({ ...first(p.notices), aggregateId: id(9) });
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
    member(p).timings.push({ ...timing(p) });
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
  });
  it('preserves disconnected suspension and refuses auto resume', () => {
    const p = raceManualPublicImpactSchema.parse(fixture());
    if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
    const m = p.nutrition.members[0];
    if (!m) throw Error('fixture');
    const a = m.before.plan.items[0],
      b = m.after.plan.items[0],
      t = m.timings[0];
    if (!a || !b || !t) throw Error('fixture');
    a.anchor = { kind: 'disconnected', entity: 'race' };
    b.anchor = { kind: 'disconnected', entity: 'race' };
    t.before = {
      state: 'suspended',
      reason: 'race_disconnected',
      resume: 'explicit_reconnect_and_reapproval_required',
    };
    t.after = t.before;
    first(p.notices).code = 'DISCONNECTED_RETAINED';
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
    t.after = { state: 'resolved', date: '2026-10-10', localTime: null, timezone: 'UTC' };
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
  });
  it('rejects unknown fields inside planned item', () => {
    const p = fixture();
    const item = member(p).before.plan.items[0];
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        nutrition: {
          state: 'present',
          members: [
            {
              ...member(p),
              before: {
                ...member(p).before,
                plan: {
                  ...member(p).before.plan,
                  items: [{ ...item, source: { kind: 'official' } }],
                },
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it('rejects aggregate bytes, deep, getter, sparse and excessive nodes before parse', () => {
    const p = fixture();
    first(member(p).before.plan.items).instructions = '식'.repeat(1500000);
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
    const deep: Record<string, unknown> = {};
    let at = deep;
    for (let i = 0; i < 70; i++) {
      const next = {};
      at.next = next;
      at = next;
    }
    expect(raceManualPublicImpactSchema.safeParse(deep).success).toBe(false);
    let calls = 0;
    const getter = {
      get status() {
        calls++;
        return 'projected';
      },
    };
    expect(raceManualPublicImpactSchema.safeParse(getter).success).toBe(false);
    expect(calls).toBe(0);
    expect(raceManualPublicImpactSchema.safeParse(new Array(2)).success).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse(Array.from({ length: 5000 }, () => null)).success,
    ).toBe(false);
  });
  it('keeps blocked contentless and rejects domain duplication', () => {
    const b = {
      schemaVersion: 1,
      status: 'blocked',
      approvalAllowed: false,
      persistence: 'not_stored',
      freshness: 'not_checked',
      reason: 'source_unavailable',
      domains: ['nutrition'],
    };
    expect(raceManualPublicImpactSchema.safeParse(b).success).toBe(true);
    expect(raceManualPublicImpactSchema.safeParse({ ...b, context: {} }).success).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse({ ...b, domains: ['nutrition', 'nutrition'] }).success,
    ).toBe(false);
  });
  it('keeps ended unresolved frozen with notice only and no approval authority', () => {
    const p = routineFixture();
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
    const m = p.routines.members[0];
    if (!m) throw Error('fixture');
    m.requirement = 'retained_ended_unresolved';
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
  });
  it('rejects dirty routine parent and preserved run aliases', () => {
    const p = routineFixture();
    const m = p.routines.members[0];
    if (!m) throw Error('fixture');
    m.after.schedule.blueprint.versionId = 'different';
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
    const q = fixture();
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...q,
        retainedUnplanned: [
          { runId: 'same', blueprintVersionId: 'a', preservation: 'unplanned_run_unchanged' },
          { runId: 'same', blueprintVersionId: 'b', preservation: 'unplanned_run_unchanged' },
        ],
      }).success,
    ).toBe(false);
  });
  it('requires actual current training for move and refuses private resolution inputs', () => {
    const p = fixture();
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        intent: {
          ...p.intent,
          selection: {
            kind: 'move_period',
            expectedCurrentPlanVersionId: id(5),
            periodId: 'p',
            newStartDate: '2026-10-10',
            scope: 'period_only',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        intent: {
          ...p.intent,
          resolutions: {
            nutrition: [
              {
                planVersionId: id(3),
                itemId: 'other',
                action: 'replace_anchor',
                anchor: { kind: 'absolute', date: '2026-10-10', localTime: null, timezone: 'UTC' },
              },
            ],
            routines: [],
          },
        },
      }).success,
    ).toBe(false);
  });
  it('preserves exact started tuple and detects collision with unplanned runs', () => {
    const p = routineFixture();
    const m = first(p.routines.members);
    const started = {
      runId: 'run',
      occurrenceId: 'occ',
      scheduleVersionId: 'schedule-old',
      blueprintVersionId: 'bp-v1',
      anchorKey: 'period:p:0',
      preservation: 'started_run_frozen',
    };
    const q = {
      ...p,
      routines: { state: 'present', members: [{ ...m, retainedStarted: [started] }] },
      notices: [
        ...p.notices,
        {
          domain: 'routine_schedule',
          aggregateId: id(4),
          itemId: null,
          code: 'STARTED_RUN_PRESERVED',
        },
      ],
    };
    expect(raceManualPublicImpactSchema.safeParse(q).success).toBe(true);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...q,
        retainedUnplanned: [
          { runId: 'run', blueprintVersionId: 'bp-v1', preservation: 'unplanned_run_unchanged' },
        ],
      }).success,
    ).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...q,
        routines: {
          state: 'present',
          members: [{ ...m, retainedStarted: [{ ...started, scheduleVersionId: '' }] }],
        },
      }).success,
    ).toBe(false);
  });
  it('preserves historical started version instead of requiring the current head', () => {
    const p = routineFixture();
    const m = first(p.routines.members);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        routines: {
          state: 'present',
          members: [
            {
              ...m,
              storedOccurrences: [
                ...m.storedOccurrences,
                {
                  occurrenceId: 'old-occ',
                  schedule: { id: id(4), versionId: 'historical' },
                  blueprint: { id: 'bp', versionId: 'old-blueprint' },
                  sourcePlanVersionId: null,
                  anchorKey: 'old-anchor',
                  scheduledAt: null,
                  timingStatus: 'unresolved',
                  unresolvedReason: null,
                },
              ],
              retainedStarted: [
                {
                  runId: 'old-run',
                  occurrenceId: 'old-occ',
                  scheduleVersionId: 'historical',
                  blueprintVersionId: 'old-blueprint',
                  anchorKey: 'old-anchor',
                  preservation: 'started_run_frozen',
                },
              ],
            },
          ],
        },
        notices: [
          ...p.notices,
          {
            domain: 'routine_schedule',
            aggregateId: id(4),
            itemId: null,
            code: 'STARTED_RUN_PRESERVED',
          },
        ],
      }).success,
    ).toBe(true);
  });
  it('accepts exact linked-only affected nutrition while keeping old unresolved timing notice', () => {
    const p = raceManualPublicImpactSchema.parse(linkedOnlyFixture());
    if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
    expect(p.affected.map((t) => t.domain)).toEqual(['training', 'nutrition']);
    expect(p.nutrition.members[0]?.timings[0]?.state).toBe('unchanged');
    expect(p.nutrition.members[0]?.timings[0]?.requirement).toBe('none');
    expect(p.notices.map((n) => n.code)).toEqual(['UNCHANGED_UNRESOLVED']);
    expect(p.resolutionRequirements).toEqual([]);
  });
  it.each([
    'wrong_before_version',
    'absent_before',
    'foreign_training',
    'no_training_change',
    'missing_nutrition_target',
  ] as const)('rejects forged linked-only claim %s', (control) => {
    const p = linkedOnlyFixture(),
      n = p.nutrition.members[0],
      t = p.training.members[0];
    if (!n || !t) throw Error('fixture');
    const input = {
      ...p,
      nutrition:
        control === 'wrong_before_version'
          ? {
              ...p.nutrition,
              members: [
                {
                  ...n,
                  before: { ...n.before, linkedTraining: { kind: 'retained', versionId: id(99) } },
                },
              ],
            }
          : control === 'absent_before'
            ? {
                ...p.nutrition,
                members: [{ ...n, before: { ...n.before, linkedTraining: { kind: 'absent' } } }],
              }
            : control === 'foreign_training'
              ? {
                  ...p.nutrition,
                  members: [
                    {
                      ...n,
                      after: {
                        ...n.after,
                        linkedTraining: { kind: 'follows_training_approval', aggregateId: id(99) },
                      },
                    },
                  ],
                }
              : p.nutrition,
      training:
        control === 'no_training_change'
          ? { ...p.training, members: [{ ...t, after: { kind: 'retained', plan: t.before.plan } }] }
          : p.training,
      affected:
        control === 'missing_nutrition_target'
          ? p.affected.filter((t) => t.domain !== 'nutrition')
          : p.affected,
    };
    expect(raceManualPublicImpactSchema.safeParse(input).success).toBe(false);
  });
  it('shows affected unconfirmed recovery without fabricating confirmation', () => {
    const plan = {
      title: 'Rest',
      goal: 'Recover',
      startDate: '2026-10-08',
      endDateExclusive: '2026-10-12',
      timezone: 'UTC',
      priority: 'normal',
      options: [
        { id: id(8), title: 'Rest', kind: 'full_rest', methodVersionId: null, explanation: 'Rest' },
      ],
      reassessment: [
        {
          id: id(11),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Reassess',
          policyVersion: null,
        },
      ],
    };
    const before = {
      ref: { versionId: id(10), version: 1 },
      plan,
      status: 'draft',
      selectedOptionId: null,
      planLinks: [],
    };
    const member = {
      aggregateId: id(9),
      state: 'affected',
      before,
      after: { plan, status: 'draft', selectedOptionId: null, planLinks: [] },
      requirement: 'resolve_before_review',
    };
    const p = {
      ...fixture(),
      recovery: { state: 'present', members: [member] },
      affected: [{ domain: 'recovery', aggregateId: id(9) }],
      resolutionRequirements: [
        {
          domain: 'recovery',
          aggregateId: id(9),
          strategyVersionId: id(10),
          reason: 'recovery_confirmation_required',
          editor: 'confirm_recovery_and_review',
        },
      ],
    };
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        recovery: {
          state: 'present',
          members: [
            {
              ...member,
              after: { ...member.after, status: 'user_confirmed', selectedOptionId: id(8) },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it('accepts diagnostic goal definition without evidence IDs and rejects provenance injection', () => {
    const p = fixture();
    const m = member(p);
    const goal = {
      metric: 'energy',
      amount: { min: 0, max: 100, unit: 'kcal', basis: 'user_confirmed' },
    };
    const before = {
      ...m.before,
      plan: {
        ...m.before.plan,
        items: m.before.plan.items.map((i) => ({ ...i, targets: [goal] })),
      },
    };
    const after = {
      ...m.after,
      plan: { ...m.after.plan, items: m.after.plan.items.map((i) => ({ ...i, targets: [goal] })) },
    };
    const q = { ...p, nutrition: { state: 'present', members: [{ ...m, before, after }] } };
    expect(raceManualPublicImpactSchema.safeParse(q).success).toBe(true);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...q,
        nutrition: {
          state: 'present',
          members: [
            {
              ...m,
              before: {
                ...before,
                plan: {
                  ...before.plan,
                  items: before.plan.items.map((i) => ({
                    ...i,
                    targets: [
                      {
                        metric: 'energy',
                        amount: { ...goal.amount, evidenceIds: ['PRIVATE_EVIDENCE_SENTINEL'] },
                      },
                    ],
                  })),
                },
              },
              after,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

it('accepts unchanged ended frozen diagnostic and rejects an affected ended target', () => {
  const p = routineFixture(),
    member = first(p.routines.members);
  member.state = 'unchanged';
  expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
  member.state = 'affected';
  expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
});
it('requires exact ended and unresolved notices without fabricating a frozen editor', () => {
  const p = routineFixture();
  expect(
    raceManualPublicImpactSchema.safeParse({
      ...p,
      notices: p.notices.filter((n) => n.code !== 'UNCHANGED_UNRESOLVED'),
    }).success,
  ).toBe(false);
  expect(
    raceManualPublicImpactSchema.safeParse({
      ...p,
      resolutionRequirements: [
        {
          domain: 'routine_schedule',
          aggregateId: id(4),
          scheduleVersionId: 'schedule-old',
          reason: 'retained_ended_unresolved',
          editor: 'unavailable_frozen_ended',
        },
      ],
    }).success,
  ).toBe(false);
  const m = first(p.routines.members);
  m.after.schedule.window.endDateExclusive = '2026-10-13';
  expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(false);
});

it('accepts400 unchanged unresolved planned items without deleting zero/null foods', () => {
  const p = fixture(),
    n = first(p.nutrition.members),
    item = first(n.before.plan.items),
    t = first(n.timings);
  n.before.plan.items = Array.from({ length: 400 }, (_, i) => ({
    ...structuredClone(item),
    id: `食-"\\-${i}`,
  }));
  n.after.plan.items = structuredClone(n.before.plan.items);
  n.timings = n.before.plan.items.map((x) => ({ ...structuredClone(t), itemId: x.id }));
  p.notices = n.before.plan.items.map((x) => ({
    domain: 'nutrition',
    aggregateId: n.aggregateId,
    itemId: x.id,
    code: 'UNCHANGED_UNRESOLVED',
  }));
  const out = raceManualPublicImpactSchema.parse(p);
  expect(out).toEqual(p);
  expect(first(n.before.plan.items).foods.map((f) => f.quantity)).toEqual([0, null]);
});

it('still rejects5001 planned items by the semantic roster limit below4MiB', () => {
  const p = fixture(),
    n = first(p.nutrition.members),
    item = first(n.before.plan.items),
    timing = first(n.timings);
  n.before.plan.items = Array.from({ length: 5001 }, (_, i) => ({
    ...structuredClone(item),
    id: String(i),
    foods: [],
    instructions: 'Action',
  }));
  n.after.plan.items = structuredClone(n.before.plan.items);
  n.timings = n.before.plan.items.map((x) => ({ ...structuredClone(timing), itemId: x.id }));
  p.notices = n.before.plan.items.map((x) => ({
    domain: 'nutrition',
    aggregateId: n.aggregateId,
    itemId: x.id,
    code: 'UNCHANGED_UNRESOLVED',
  }));
  expect(new TextEncoder().encode(JSON.stringify(p)).byteLength).toBeLessThan(4194304);
  const result = raceManualPublicImpactSchema.safeParse(p);
  if (result.success) throw Error('Expected semantic roster rejection');
  expect(
    result.error.issues.some((issue) => issue.code === 'too_big' && issue.path.includes('items')),
  ).toBe(true);
  expect(
    result.error.issues.some((issue) => issue.message === 'Bounded plain impact required'),
  ).toBe(false);
});

function indexedNoticeFixture(count: number) {
  const p = fixture(),
    n = member(p),
    item = first(n.before.plan.items),
    t = first(n.timings);
  n.before.plan.items = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(item),
    id: `食|"\\:${i}`,
    foods: [],
  }));
  n.after.plan.items = structuredClone(n.before.plan.items);
  n.timings = n.before.plan.items.map((x) => ({ ...structuredClone(t), itemId: x.id }));
  p.notices = n.before.plan.items.map((x) => ({
    domain: 'nutrition',
    aggregateId: n.aggregateId,
    itemId: x.id,
    code: 'UNCHANGED_UNRESOLVED',
  }));
  return p;
}
function indexedRequirementFixture() {
  const p = raceManualPublicImpactSchema.parse(indexedNoticeFixture(2));
  if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
  const m = first(p.nutrition.members);
  for (const t of m.timings) {
    t.state = 'affected';
    t.requirement = 'resolve_before_review';
  }
  p.notices = [];
  p.affected = [{ domain: 'nutrition', aggregateId: m.aggregateId }];
  p.resolutionRequirements = m.timings.map((t) => ({
    domain: 'nutrition',
    aggregateId: m.aggregateId,
    planVersionId: m.before.ref.versionId,
    itemId: t.itemId,
    reason: 'affected_timing_unresolved',
    editor: 'replace_anchor',
  }));
  return p;
}
describe('exact typed derived roster correspondence', () => {
  it('accepts reversed notice order and reordered object keys with Unicode quotes and separators', () => {
    const p = indexedNoticeFixture(8);
    p.notices = [...p.notices].reverse().map((row) => ({
      code: row.code,
      itemId: row.itemId,
      aggregateId: row.aggregateId,
      domain: row.domain,
    }));
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
  });
  it('rejects duplicate, missing, extraneous and foreign notice tuples', () => {
    const p = indexedNoticeFixture(2),
      a = first(p.notices);
    for (const notices of [
      [a, a],
      p.notices.slice(1),
      [...p.notices, a],
      [{ ...a, aggregateId: id(999) }, ...p.notices.slice(1)],
      [{ ...a, itemId: a.itemId + 'extra' }, ...p.notices.slice(1)],
    ])
      expect(raceManualPublicImpactSchema.safeParse({ ...p, notices }).success).toBe(false);
  });
  it('preserves null distinct from string null and empty string in routine notices', () => {
    const p = routineFixture();
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
    for (const value of ['null', '']) {
      const notices = p.notices.map((row) =>
        row.itemId === null ? { ...row, itemId: value } : row,
      );
      expect(raceManualPublicImpactSchema.safeParse({ ...p, notices }).success).toBe(false);
    }
  });
  it('rejects unknown non-finite or undefined notice fields before tuple indexing', () => {
    const p = indexedNoticeFixture(1),
      a = first(p.notices);
    for (const bad of [
      { ...a, itemId: undefined },
      { ...a, itemId: NaN },
      { ...a, aggregateId: null },
      { ...a, code: 'foreign' },
      { ...a, privateProof: true },
    ])
      expect(raceManualPublicImpactSchema.safeParse({ ...p, notices: [bad] }).success).toBe(false);
  });
  it('keeps affected tuple order independent and rejects duplicate or foreign target', () => {
    const p = linkedOnlyFixture();
    expect(
      raceManualPublicImpactSchema.safeParse({ ...p, affected: [...p.affected].reverse() }).success,
    ).toBe(true);
    const a = first(p.affected);
    expect(raceManualPublicImpactSchema.safeParse({ ...p, affected: [a, a] }).success).toBe(false);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        affected: [{ ...a, aggregateId: id(999) }, ...p.affected.slice(1)],
      }).success,
    ).toBe(false);
  });
  it('keeps requirement order independent and checks every exact item and version field', () => {
    const p = indexedRequirementFixture(),
      a = first(p.resolutionRequirements);
    expect(
      raceManualPublicImpactSchema.safeParse({
        ...p,
        resolutionRequirements: [...p.resolutionRequirements].reverse(),
      }).success,
    ).toBe(true);
    for (const requirements of [
      [a, a],
      p.resolutionRequirements.slice(1),
      [...p.resolutionRequirements, a],
      [{ ...a, planVersionId: id(999) }, ...p.resolutionRequirements.slice(1)],
      [{ ...a, itemId: 'foreign' }, ...p.resolutionRequirements.slice(1)],
      [{ ...a, editor: 'replace_rule' }, ...p.resolutionRequirements.slice(1)],
    ])
      expect(
        raceManualPublicImpactSchema.safeParse({ ...p, resolutionRequirements: requirements })
          .success,
      ).toBe(false);
  });
  it('accepts the existing semantic maximum5000 without enlarging transport or deadline', () => {
    const p = indexedNoticeFixture(5000);
    expect(new TextEncoder().encode(JSON.stringify(p)).byteLength).toBeLessThan(4194304);
    expect(raceManualPublicImpactSchema.safeParse(p).success).toBe(true);
  });
});
// Keep the existing 400/null0 positive and exact 5001 too_big negative untouched.
