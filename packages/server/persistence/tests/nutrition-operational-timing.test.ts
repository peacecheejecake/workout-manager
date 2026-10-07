import { expect, it } from 'vitest';
import {
  projectOperationalNutritionTiming,
  createOperationalNutritionProjector,
  NutritionOperationalTimingError,
} from '../src/nutrition-operational-timing.js';
import {
  createIntegratedPlannerRepository,
  IntegratedPlannerLimitError,
} from '../src/integrated-planner.js';
import type { Database } from '../src/database.js';

// Pure/adapter boundary fixtures, not authenticated source capture, SQL execution or RLS evidence.
const event = '11111111-1111-4111-8111-111111111111';
const version = '33333333-3333-4333-8333-333333333333';
const item = {
  id: 'meal-1',
  planVersionId: version,
  category: 'before',
  title: 'Synthetic',
  anchor: { kind: 'relative', entity: 'race', entityId: event, point: 'start', offsetMinutes: 0 },
  foods: [],
  targets: [],
  instructions: 'Synthetic action',
  evidenceIds: [],
  source: 'user_confirmed',
};
const legacy = {
  planId: '22222222-2222-4222-8222-222222222222',
  versionId: version,
  version: 1,
  previousVersionId: null,
  approvalId: '44444444-4444-4444-8444-444444444444',
  approvedAt: '2026-10-07T00:00:00Z',
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'Asia/Seoul',
  purpose: 'Synthetic',
  linkedTrainingPlanVersionId: null,
  items: [item],
};
const pin = {
  pinVersion: 1,
  namespace: 'race-event-revision',
  eventId: event,
  eventRevision: 1,
  sourceDigestVersion: 'race-event-values-canonical-v1',
  sourceDigest: 'a'.repeat(64),
  localDate: '2026-10-07',
  localStartTime: '09:00:17',
  timezone: 'Asia/Seoul',
  start: { state: 'known', instant: '2026-10-07T00:00:17Z' },
  end: { state: 'unknown', reason: 'race_end_not_recorded' },
};
const record = {
  ...legacy,
  schemaVersion: 2,
  raceTimingPins: [pin],
  itemRaceTimingBindings: [
    { itemId: item.id, binding: { state: 'captured', eventId: event, eventRevision: 1 } },
  ],
};
const input = {
  record,
  itemId: item.id,
  targetTimezone: 'Asia/Seoul',
  linkedTraining: null,
  sourceHead: { id: event, revision: 1, deleted: false, body_present: true },
};

it('uses only frozen timing when current live revision advances, preserving caller input', () => {
  const before = JSON.stringify(input);
  const first = projectOperationalNutritionTiming(input);
  expect(first).toEqual(
    projectOperationalNutritionTiming({
      ...input,
      sourceHead: { ...input.sourceHead, revision: 9 },
    }),
  );
  expect(first.projection).toMatchObject({ date: '2026-10-07', value: { localTime: '09:00:17' } });
  expect(first.operationalState).toBeNull();
  expect(JSON.stringify(input)).toBe(before);
});
it.each([
  ['deleted', { ...input.sourceHead, deleted: true, body_present: false }, 'race_disconnected'],
  ['absent', null, 'source_unavailable'],
  ['bodyless', { ...input.sourceHead, body_present: false }, 'source_unavailable'],
])(
  'suspends %s source without exposing operational date or source identity',
  (_label, sourceHead, reason) => {
    const result = projectOperationalNutritionTiming({ ...input, sourceHead });
    expect(result.projection).toMatchObject({ reason: 'missing_anchor' });
    expect(result.projection).not.toHaveProperty('date');
    expect(result.operationalState).toEqual({
      planVersionId: version,
      itemId: item.id,
      state: 'suspended',
      reason,
    });
    expect(JSON.stringify(result)).not.toContain(event);
    expect(JSON.stringify(result)).not.toContain(pin.start.instant);
  },
);
it('legacy live race remains unpinned, while deleted legacy race is disconnected', () => {
  expect(
    projectOperationalNutritionTiming({ ...input, record: legacy }).operationalState,
  ).toMatchObject({ state: 'unresolved', reason: 'legacy_unpinned' });
  expect(
    projectOperationalNutritionTiming({
      ...input,
      record: legacy,
      sourceHead: { ...input.sourceHead, deleted: true, body_present: false },
    }).operationalState,
  ).toMatchObject({ state: 'suspended', reason: 'race_disconnected' });
});
it('does not resume from a new event, matching names or unsupported replacement body', () => {
  expect(() =>
    projectOperationalNutritionTiming({
      ...input,
      sourceHead: { ...input.sourceHead, id: legacy.planId },
    }),
  ).toThrow(NutritionOperationalTimingError);
  expect(() =>
    projectOperationalNutritionTiming({
      ...input,
      sourceHead: { ...input.sourceHead, body: { title: 'Synthetic' } },
    }),
  ).toThrow(NutritionOperationalTimingError);
});
it.each([0, 2147483648, '1', null])('rejects malformed source revision %s', (revision) => {
  expect(() =>
    projectOperationalNutritionTiming({ ...input, sourceHead: { ...input.sourceHead, revision } }),
  ).toThrow(NutritionOperationalTimingError);
});
it('does not invent a race end and preserves non-race absolute calculation', () => {
  const endRecord = { ...record, items: [{ ...item, anchor: { ...item.anchor, point: 'end' } }] };
  expect(
    projectOperationalNutritionTiming({ ...input, record: endRecord }).operationalState,
  ).toMatchObject({ state: 'unresolved', reason: 'timing_unresolved' });
  const absolute = {
    ...legacy,
    items: [
      {
        ...item,
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' },
      },
    ],
  };
  expect(
    projectOperationalNutritionTiming({ ...input, record: absolute, sourceHead: null }).projection,
  ).toMatchObject({ date: '2026-10-07', value: { localTime: null } });
});
it('rejects global oversized or unknown caller input before calculation', () => {
  expect(() =>
    projectOperationalNutritionTiming({ ...input, extra: 'x'.repeat(4 * 1024 * 1024) }),
  ).toThrow(NutritionOperationalTimingError);
  expect(() => projectOperationalNutritionTiming({ ...input, approvalAllowed: true })).toThrow(
    NutritionOperationalTimingError,
  );
});

function fakeSnapshot(payload: unknown, ok = true) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tenant: Database['tenant'] = async (athleteId, operation) =>
    operation({
      athleteId,
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [{ ok, payload }], rowCount: 1 };
      },
    });
  const database: Database = { tenant, exclusiveTenant: tenant, close: async () => undefined };
  return { repository: createIntegratedPlannerRepository(database), calls };
}
function snapshot() {
  return {
    plan: null,
    timezone: 'Asia/Seoul',
    nutrition: [record],
    activities: [],
    intakes: [],
    linked_plans: [],
    unplaced_count: 0,
    recovery_strategies: [],
    recovery_actions: [],
    routine_schedules: [],
    routine_occurrences: [],
    routine_runs: [],
    stretching_activities: [],
    race_source_heads: [input.sourceHead],
  };
}
const query = { from: '2026-10-07', toExclusive: '2026-10-08', timezone: 'Asia/Seoul' };
it('V5 repository consumes one supplied snapshot and gives suspended item exactly one unplaced state', async () => {
  const row = snapshot();
  row.race_source_heads = [{ ...input.sourceHead, deleted: true, body_present: false }];
  const fake = fakeSnapshot(row);
  const result = await fake.repository.readV5('synthetic-tenant', query);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]?.values?.[0]).toBe('synthetic-tenant');
  expect(result.schemaVersion).toBe(5);
  expect(result.days[0]?.nutritionItems).toEqual([]);
  expect(result.unresolvedNutritionItems).toHaveLength(1);
  expect(result.nutritionOperationalStates).toEqual([
    { planVersionId: version, itemId: item.id, state: 'suspended', reason: 'race_disconnected' },
  ]);
});
it('preflight denial and oversized returned payload fail closed rather than empty success', async () => {
  await expect(fakeSnapshot(null, false).repository.readV5('synthetic', query)).rejects.toThrow(
    IntegratedPlannerLimitError,
  );
  await expect(
    fakeSnapshot({ ...snapshot(), extra: 'x'.repeat(4 * 1024 * 1024) }).repository.readV5(
      'synthetic',
      query,
    ),
  ).rejects.toThrow(IntegratedPlannerLimitError);
});
it('duplicate source metadata rejects instead of choosing a convenient live head', async () => {
  const row = snapshot();
  row.race_source_heads.push({ ...input.sourceHead, deleted: true, body_present: false });
  await expect(fakeSnapshot(row).repository.readV5('synthetic', query)).rejects.toThrow(
    'INVALID_PLANNER_SOURCE_HEADS',
  );
});

it.each(['a'.repeat(201), '한글"\\'.repeat(101)])(
  'preserves public valid long item IDs inside the envelope',
  (itemId) => {
    const next = {
      ...record,
      items: [{ ...item, id: itemId }],
      itemRaceTimingBindings: [
        { itemId, binding: { state: 'captured', eventId: event, eventRevision: 1 } },
      ],
    };
    const result = projectOperationalNutritionTiming({ ...input, record: next, itemId });
    expect(result.projection).toMatchObject({ value: { id: itemId, localTime: '09:00:17' } });
  },
);
it('uppercase legacy UUID identity finds the same captured head without pinning', () => {
  const alphabetic = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  expect(alphabetic.toUpperCase()).not.toBe(alphabetic);
  const next = {
    ...legacy,
    items: [{ ...item, anchor: { ...item.anchor, entityId: alphabetic.toUpperCase() } }],
  };
  expect(
    projectOperationalNutritionTiming({
      ...input,
      record: next,
      sourceHead: { ...input.sourceHead, id: alphabetic },
    }).operationalState,
  ).toMatchObject({ reason: 'legacy_unpinned' });
});
it('V5 rejects unknown row metadata and unconsumed heads', async () => {
  await expect(
    fakeSnapshot({ ...snapshot(), unknown: true }).repository.readV5('synthetic', query),
  ).rejects.toThrow();
  const next = snapshot();
  next.race_source_heads = [{ ...input.sourceHead, id: legacy.planId }];
  await expect(fakeSnapshot(next).repository.readV5('synthetic', query)).rejects.toThrow(
    'INVALID_PLANNER_SOURCE_HEADS',
  );
});

it('reuses an immutable captured context with public-entry-equivalent item projections', () => {
  const captured = structuredClone(record);
  const context = { record: captured, targetTimezone: input.targetTimezone, linkedTraining: null };
  const project = createOperationalNutritionProjector(context);
  const selectors = [
    { itemId: item.id, sourceHead: input.sourceHead },
    { itemId: item.id, sourceHead: { ...input.sourceHead, revision: 9 } },
    { itemId: item.id, sourceHead: { ...input.sourceHead, deleted: true, body_present: false } },
    { itemId: item.id, sourceHead: null },
  ];
  for (const selector of selectors) {
    expect(project(selector)).toEqual(
      projectOperationalNutritionTiming({ ...context, ...selector }),
    );
  }
  const callerItem = captured.items[0];
  const callerPin = captured.raceTimingPins[0];
  if (callerItem === undefined || callerPin === undefined) throw new Error('Missing test context');
  callerItem.title = 'Caller changed its draft';
  callerPin.localStartTime = '10:00:17';
  expect(project(selectors[0])).toEqual(projectOperationalNutritionTiming(input));
});

it('V5 rejects duplicate nutrition versions and linked Plan identities before Map construction', async () => {
  const row = snapshot();
  await expect(
    fakeSnapshot({ ...row, nutrition: [record, structuredClone(record)] }).repository.readV5(
      'synthetic',
      query,
    ),
  ).rejects.toThrow('INVALID_PLANNER_SOURCE_HEADS');
  // Schema-valid synthetic Plan DTO; this remains an unknown-row boundary test, not RLS evidence.
  const { planDraftSchema } = await import('@workout/contracts/planning');
  const draft = planDraftSchema.parse({
    title: 'Synthetic',
    timezone: 'Asia/Seoul',
    sessions: [],
    periods: ['season', 'wave', 'phase', 'block'].map((level, i, all) => ({
      id: level,
      parentId: i === 0 ? null : all[i - 1],
      level,
      title: level,
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
  });
  const plan = { id: version, draft };
  await expect(
    fakeSnapshot({ ...row, linked_plans: [plan, structuredClone(plan)] }).repository.readV5(
      'synthetic',
      query,
    ),
  ).rejects.toThrow('INVALID_PLANNER_SOURCE_HEADS');
});

const disconnectedRecord = {
  ...record,
  schemaVersion: 3,
  items: [{ ...item, anchor: { kind: 'disconnected', entity: 'race' } }],
  raceTimingPins: [],
  itemRaceTimingBindings: [],
};
it('V3 disconnected is always operationally suspended and never accepts a source head', () => {
  const result = projectOperationalNutritionTiming({
    ...input,
    record: disconnectedRecord,
    sourceHead: null,
  });
  expect(result).toEqual({
    projection: {
      id: item.id,
      planVersionId: version,
      title: item.title,
      category: item.category,
      source: item.source,
      reason: 'missing_anchor',
    },
    operationalState: {
      planVersionId: version,
      itemId: item.id,
      state: 'suspended',
      reason: 'race_disconnected',
    },
  });
  expect(JSON.stringify(result)).not.toContain(event);
  for (const head of [
    input.sourceHead,
    { ...input.sourceHead, revision: 9 },
    { ...input.sourceHead, deleted: true, body_present: false },
  ])
    expect(() =>
      projectOperationalNutritionTiming({ ...input, record: disconnectedRecord, sourceHead: head }),
    ).toThrow('INVALID_NUTRITION_OPERATIONAL_TIMING');
});
it('V3 scoped factory preserves disconnected context and active pin behavior independently', () => {
  const active = { ...record, schemaVersion: 3 };
  const first = createOperationalNutritionProjector({
    record: active,
    targetTimezone: input.targetTimezone,
    linkedTraining: null,
  });
  const removed = createOperationalNutritionProjector({
    record: disconnectedRecord,
    targetTimezone: input.targetTimezone,
    linkedTraining: null,
  });
  expect(first({ itemId: item.id, sourceHead: input.sourceHead })).toEqual(
    projectOperationalNutritionTiming(input),
  );
  expect(removed({ itemId: item.id, sourceHead: null }).operationalState).toMatchObject({
    state: 'suspended',
    reason: 'race_disconnected',
  });
  expect(disconnectedRecord.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
});

it('consumes V4 same-event multipins by exact item binding rather than the newest pin', () => {
  const secondId = 'meal-2';
  const v4 = {
    ...record,
    schemaVersion: 4,
    items: [item, { ...item, id: secondId }],
    raceTimingPins: [
      pin,
      {
        ...pin,
        eventRevision: 2,
        localStartTime: '10:00:17',
        start: { state: 'known', instant: '2026-10-07T01:00:17Z' },
      },
    ],
    itemRaceTimingBindings: [
      ...record.itemRaceTimingBindings,
      { itemId: secondId, binding: { state: 'captured', eventId: event, eventRevision: 2 } },
    ],
  };
  const context = { ...input, record: v4, sourceHead: { ...input.sourceHead, revision: 2 } };
  expect(projectOperationalNutritionTiming(context).projection).toMatchObject({
    date: '2026-10-07',
    value: { localTime: '09:00:17' },
  });
  expect(
    projectOperationalNutritionTiming({ ...context, itemId: secondId }).projection,
  ).toMatchObject({ date: '2026-10-07', value: { localTime: '10:00:17' } });
  for (const id of [item.id, secondId]) {
    const suspended = projectOperationalNutritionTiming({
      ...context,
      itemId: id,
      sourceHead: { ...context.sourceHead, deleted: true, body_present: false },
    });
    expect(suspended.projection).not.toHaveProperty('date');
    expect(suspended.operationalState).toMatchObject({
      state: 'suspended',
      reason: 'race_disconnected',
    });
  }
});
it('V4 disconnected read cannot use replacement race time or reveal deleted identity', () => {
  const v4 = {
    ...record,
    schemaVersion: 4,
    items: [{ ...item, anchor: { kind: 'disconnected', entity: 'race' } }],
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  };
  const value = projectOperationalNutritionTiming({ ...input, record: v4, sourceHead: null });
  expect(value.operationalState).toMatchObject({ state: 'suspended', reason: 'race_disconnected' });
  expect(value.projection).not.toHaveProperty('date');
  expect(JSON.stringify(value)).not.toContain(event);
  expect(() => projectOperationalNutritionTiming({ ...input, record: v4 })).toThrow();
});
