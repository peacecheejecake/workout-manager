import { expect, it } from 'vitest';
import { nutritionPlanVersionSchema } from '../src/nutrition-core.js';
import {
  nutritionPlanVersionV2Schema,
  nutritionPlanReadV2Schema,
} from '../src/nutrition-race-plan-v2.js';
import {
  disconnectedNutritionRaceAnchorSchema,
  nutritionPlanVersionV3Schema,
  nutritionPlanVersionCompatibleV3Schema,
  nutritionPlanReadV3Schema,
  nutritionPlanReadCompatibleV3Schema,
  nutritionPlansResponseV3Schema,
} from '../src/nutrition-race-plan-v3.js';
const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const food = {
  foodVersionId: null,
  description: '보존 음식',
  quantity: 0,
  unit: 'g',
  sourceBasis: 'manual_total',
};
const item = {
  id: 'Meal',
  planVersionId: versionId,
  category: 'before',
  title: '보존 식사',
  anchor: { kind: 'disconnected', entity: 'race' },
  foods: [food, { ...food, quantity: null, unit: 'unspecified', sourceBasis: 'unknown' }],
  targets: [],
  instructions: '',
  evidenceIds: [],
  source: 'user_confirmed',
};
const record = {
  schemaVersion: 3,
  planId,
  versionId,
  version: 1,
  previousVersionId: null,
  approvalId,
  approvedAt: '2026-10-07T00:00:00Z',
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'Asia/Seoul',
  purpose: '보존 승인',
  linkedTrainingPlanVersionId: null,
  items: [item],
  raceTimingPins: [],
  itemRaceTimingBindings: [],
};
const pin = {
  pinVersion: 1,
  namespace: 'race-event-revision',
  eventId,
  eventRevision: 1,
  sourceDigestVersion: 'race-event-values-canonical-v1',
  sourceDigest: 'a'.repeat(64),
  localDate: '2026-10-07',
  localStartTime: null,
  timezone: 'Asia/Seoul',
  start: { state: 'unknown', reason: 'start_time_not_recorded' },
  end: { state: 'unknown', reason: 'race_end_not_recorded' },
};
const active = {
  ...item,
  id: 'active',
  anchor: { kind: 'relative', entity: 'race', entityId: eventId, point: 'start', offsetMinutes: 0 },
};
const captured = { itemId: active.id, binding: { state: 'captured', eventId, eventRevision: 1 } };
function listedRecord(index: number, itemId = 'Meal') {
  const uuid = (value: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, '0')}`;
  const version = uuid(index * 3 + 2);
  return {
    ...record,
    planId: uuid(index * 3 + 1),
    versionId: version,
    approvalId: uuid(index * 3 + 3),
    items: [{ ...item, id: itemId, planVersionId: version }],
  };
}
it('reads an explicit current-head list without silently widening the legacy transport', () => {
  const response = { schemaVersion: 3, plans: [record], nextCursor: null };
  expect(nutritionPlansResponseV3Schema.parse(response)).toEqual(response);
  expect(nutritionPlansResponseV3Schema.safeParse({ ...response, schemaVersion: 2 }).success).toBe(
    false,
  );
});
it('rejects duplicate current heads including normalized UUID case variants', () => {
  expect(
    nutritionPlansResponseV3Schema.safeParse({
      schemaVersion: 3,
      plans: [record, { ...record, planId: planId.toUpperCase() }],
      nextCursor: null,
    }).success,
  ).toBe(false);
});
it('bounds current-head count and whole UTF8 envelope with individually valid records', () => {
  expect(
    nutritionPlansResponseV3Schema.safeParse({
      schemaVersion: 3,
      plans: Array.from({ length: 101 }, (_, index) => listedRecord(index)),
      nextCursor: null,
    }).success,
  ).toBe(false);
  const plans = Array.from({ length: 13 }, (_, index) => listedRecord(index, 'x'.repeat(350000)));
  for (const plan of plans) expect(nutritionPlanVersionV3Schema.safeParse(plan).success).toBe(true);
  expect(
    nutritionPlansResponseV3Schema.safeParse({ schemaVersion: 3, plans, nextCursor: null }).success,
  ).toBe(false);
});
it('roundtrips V3 without inventing deleted source fields and preserves zero/null foods', () => {
  const parsed = nutritionPlanVersionV3Schema.parse(record);
  expect(parsed).toEqual(record);
  expect(nutritionPlanVersionV3Schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  expect(parsed.items[0]?.foods).toEqual(item.foods);
  expect(disconnectedNutritionRaceAnchorSchema.parse(item.anchor)).toEqual({
    kind: 'disconnected',
    entity: 'race',
  });
});
it.each([
  'entityId',
  'eventId',
  'eventRevision',
  'sourceDigest',
  'offsetMinutes',
  'point',
  'localDate',
  'localStartTime',
  'timezone',
  'start',
  'end',
  'reason',
])('rejects copied source or unknown anchor field %s', (field) => {
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...record,
      items: [{ ...item, anchor: { ...item.anchor, [field]: 'deleted source' } }],
    }).success,
  ).toBe(false);
});
it('keeps active race pins exact while disconnected and non-race items have no bindings', () => {
  const mixed = {
    ...record,
    items: [
      item,
      active,
      {
        ...item,
        id: 'absolute',
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' },
      },
    ],
    raceTimingPins: [pin],
    itemRaceTimingBindings: [captured],
  };
  expect(nutritionPlanVersionV3Schema.parse(mixed)).toEqual(mixed);
  expect(
    nutritionPlanVersionV3Schema.safeParse({ ...mixed, itemRaceTimingBindings: [] }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...mixed,
      itemRaceTimingBindings: [{ ...captured, itemId: 'absolute' }],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...mixed,
      raceTimingPins: [{ ...pin, eventRevision: 2 }],
    }).success,
  ).toBe(false);
});
it('rejects orphan pins and all disconnected bindings including legacy claims', () => {
  expect(nutritionPlanVersionV3Schema.safeParse({ ...record, raceTimingPins: [pin] }).success).toBe(
    false,
  );
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...record,
      itemRaceTimingBindings: [{ ...captured, itemId: item.id }],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...record,
      itemRaceTimingBindings: [
        {
          itemId: item.id,
          binding: {
            state: 'legacy_unpinned',
            priorNutritionVersionId: versionId,
            priorItemId: item.id,
            priorAnchorDigest: 'b'.repeat(64),
          },
        },
      ],
    }).success,
  ).toBe(false);
});
it('normalizes approval UUID aliases but preserves opaque item case and unbounded existing IDs', () => {
  const parsed = nutritionPlanVersionV3Schema.parse({
    ...record,
    planId: planId.toUpperCase(),
    versionId: versionId.toUpperCase(),
    items: [
      { ...item, planVersionId: versionId.toUpperCase(), id: 'x'.repeat(300) },
      { ...item, id: 'meal' },
    ],
  });
  expect(parsed.planId).toBe(planId);
  expect(parsed.versionId).toBe(versionId);
  expect(parsed.items.map((value) => value.id)).toEqual(['x'.repeat(300), 'meal']);
  expect(
    nutritionPlanVersionV3Schema.safeParse({ ...record, planId: versionId.toUpperCase() }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...record,
      items: [{ ...item, planVersionId: approvalId }],
    }).success,
  ).toBe(false);
});
it('retains unique IDs, predecessor, period and item membership validation', () => {
  for (const changed of [
    { ...record, items: [item, item] },
    { ...record, version: 2 },
    { ...record, previousVersionId: versionId },
    { ...record, period: { from: '2026-10-08', toInclusive: '2026-10-07' } },
    { ...record, period: { from: '2026-10-07', toInclusive: '2040-10-07' } },
  ])
    expect(nutritionPlanVersionV3Schema.safeParse(changed).success).toBe(false);
});
it('retains food basis, target, instruction and item refinements with disconnected anchors', () => {
  const target = {
    metric: 'energy',
    amount: { min: 0, max: 0, unit: 'kcal', basis: 'user_confirmed', evidenceIds: [] },
  };
  expect(
    nutritionPlanVersionV3Schema.safeParse({ ...record, items: [{ ...item, targets: [target] }] })
      .success,
  ).toBe(true);
  for (const changedItem of [
    { ...item, foods: [], instructions: ' ' },
    { ...item, targets: [target, target] },
    { ...item, targets: [{ ...target, amount: { ...target.amount, min: 1 } }] },
    { ...item, instructions: 'x'.repeat(2001) },
    { ...item, foods: [{ ...food, sourceBasis: 'per_100g' }] },
    { ...item, foods: [{ ...food, unit: 'unspecified' }] },
  ])
    expect(
      nutritionPlanVersionV3Schema.safeParse({ ...record, items: [changedItem] }).success,
    ).toBe(false);
});
it('keeps whole-envelope limits and the original item count limit', () => {
  const oversized = {
    ...record,
    items: Array.from({ length: 260 }, (_, i) => ({
      ...item,
      id: `item-${i}`,
      instructions: 'x'.repeat(2000),
    })),
  };
  expect(new TextEncoder().encode(JSON.stringify(oversized)).length).toBeGreaterThan(512 * 1024);
  const parsed = nutritionPlanVersionV3Schema.safeParse(oversized);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('Expected size failure');
  expect(
    parsed.error.issues.some(
      (issue) => issue.message === 'Complete nutrition V3 envelope exceeds 512 KiB',
    ),
  ).toBe(true);
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...record,
      items: Array.from({ length: 5001 }, (_, i) => ({ ...item, id: `item-${i}` })),
    }).success,
  ).toBe(false);
});
it('never loosens legacy V1/V2 or their read decoders', () => {
  expect(nutritionPlanVersionSchema.safeParse(record).success).toBe(false);
  expect(nutritionPlanVersionV2Schema.safeParse({ ...record, schemaVersion: 2 }).success).toBe(
    false,
  );
  expect(
    nutritionPlanReadV2Schema.safeParse({ schemaVersion: 2, planId, head: record, history: [] })
      .success,
  ).toBe(false);
  const legacy = { ...record, items: [active] };
  const {
    schemaVersion: _version,
    raceTimingPins: _pins,
    itemRaceTimingBindings: _bindings,
    ...v1
  } = legacy;
  const v2 = {
    ...legacy,
    schemaVersion: 2,
    raceTimingPins: [pin],
    itemRaceTimingBindings: [captured],
  };
  expect(nutritionPlanVersionCompatibleV3Schema.parse(v1)).toEqual(v1);
  expect(nutritionPlanVersionCompatibleV3Schema.parse(v2)).toEqual(v2);
  expect(nutritionPlanVersionCompatibleV3Schema.parse(record)).toEqual(record);
});
it('reads explicit V3 current and retained metadata with canonical own-plan identity', () => {
  const read = {
    schemaVersion: 3,
    planId,
    head: record,
    history: [{ versionId, version: 1, approvedAt: record.approvedAt }],
  };
  expect(nutritionPlanReadV3Schema.parse(read)).toEqual(read);
  expect(nutritionPlanReadCompatibleV3Schema.parse(read)).toEqual(read);
  expect(nutritionPlanReadV3Schema.parse({ ...read, planId: planId.toUpperCase() })).toEqual(read);
  expect(nutritionPlanReadV3Schema.parse({ ...read, head: null })).toEqual({ ...read, head: null });
  expect(nutritionPlanReadV3Schema.safeParse({ ...read, planId: approvalId }).success).toBe(false);
  expect(
    nutritionPlanReadV3Schema.safeParse({
      ...read,
      history: [{ ...read.history[0], raceTimingPins: [pin] }],
    }).success,
  ).toBe(false);
});
it.each(['admissionAllowed', 'deletedEventId', 'sourceDigest', 'receipt'])(
  'rejects extraneous approved/read field %s',
  (field) => {
    expect(nutritionPlanVersionV3Schema.safeParse({ ...record, [field]: true }).success).toBe(
      false,
    );
    expect(
      nutritionPlanReadV3Schema.safeParse({
        schemaVersion: 3,
        planId,
        head: record,
        history: [],
        [field]: true,
      }).success,
    ).toBe(false);
  },
);
it('keeps canonical lowercase source UUIDs strict without normalizing race pin claims', () => {
  const mixed = {
    ...record,
    items: [active],
    raceTimingPins: [pin],
    itemRaceTimingBindings: [captured],
  };
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...mixed,
      raceTimingPins: [{ ...pin, eventId: eventId.toUpperCase() }],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...mixed,
      itemRaceTimingBindings: [
        { ...captured, binding: { ...captured.binding, eventId: eventId.toUpperCase() } },
      ],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV3Schema.safeParse({
      ...mixed,
      items: [{ ...active, anchor: { ...active.anchor, entityId: eventId.toUpperCase() } }],
    }).success,
  ).toBe(false);
});
it('preserves historical legacy and explicit V2 read bytes in the new compatible read union', () => {
  const {
    schemaVersion: _schema,
    raceTimingPins: _pins,
    itemRaceTimingBindings: _bindings,
    ...legacy
  } = { ...record, items: [active] };
  const v1 = { planId, head: legacy, history: [] };
  const v2 = {
    schemaVersion: 2,
    planId,
    head: {
      ...legacy,
      schemaVersion: 2,
      raceTimingPins: [pin],
      itemRaceTimingBindings: [captured],
    },
    history: [],
  };
  expect(nutritionPlanReadCompatibleV3Schema.parse(v1)).toEqual(v1);
  expect(nutritionPlanReadCompatibleV3Schema.parse(v2)).toEqual(v2);
  expect(nutritionPlanReadV3Schema.safeParse(v1).success).toBe(false);
  expect(nutritionPlanReadV3Schema.safeParse(v2).success).toBe(false);
});
