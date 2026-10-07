import { expect, it } from 'vitest';
import { nutritionPlanVersionSchema } from '../src/nutrition-core.js';
import { nutritionPlanVersionV2Schema } from '../src/nutrition-race-plan-v2.js';
import { nutritionPlanVersionV3Schema } from '../src/nutrition-race-plan-v3.js';
import {
  nutritionPlanVersionV4Schema,
  nutritionPlanVersionCompatibleV4Schema,
  nutritionPlanReadV4Schema,
  nutritionPlanReadCompatibleV4Schema,
  nutritionPlansResponseV4Schema,
  saveNutritionPlanV4IntentSchema,
} from '../src/nutrition-race-plan-v4.js';
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const planId = uuid(1),
  versionId = uuid(2),
  eventId = uuid(3);
const pin = (revision: number) => ({
  pinVersion: 1,
  namespace: 'race-event-revision',
  eventId,
  eventRevision: revision,
  sourceDigestVersion: 'race-event-values-canonical-v1',
  sourceDigest: String(revision % 10).repeat(64),
  localDate: '2026-10-07',
  localStartTime: null,
  timezone: 'UTC',
  start: { state: 'unknown', reason: 'start_time_not_recorded' },
  end: { state: 'unknown', reason: 'race_end_not_recorded' },
});
const item = (id: string) => ({
  id,
  planVersionId: versionId,
  category: 'before',
  title: 'Meal',
  anchor: { kind: 'relative', entity: 'race', entityId: eventId, point: 'start', offsetMinutes: 0 },
  foods: [
    {
      foodVersionId: null,
      description: 'Retained food',
      quantity: 0,
      unit: 'g',
      sourceBasis: 'manual_total',
    },
    {
      foodVersionId: null,
      description: 'Unknown portion',
      quantity: null,
      unit: 'unspecified',
      sourceBasis: 'unknown',
    },
  ],
  targets: [],
  instructions: 'User action',
  evidenceIds: [],
  source: 'user_confirmed',
});
const binding = (itemId: string, revision: number) => ({
  itemId,
  binding: { state: 'captured', eventId, eventRevision: revision },
});
const record = {
  schemaVersion: 4,
  planId,
  versionId,
  version: 1,
  previousVersionId: null,
  approvalId: uuid(4),
  approvedAt: '2026-10-07T00:00:00Z',
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'UTC',
  purpose: 'Retained approved timing',
  linkedTrainingPlanVersionId: null,
  items: [item('a'), item('b')],
  raceTimingPins: [pin(1), pin(2)],
  itemRaceTimingBindings: [binding('a', 1), binding('b', 2)],
};
it('represents old unaffected and newly affected pins for one event without rewriting any source fact', () => {
  const bytes = JSON.stringify(record);
  expect(nutritionPlanVersionV4Schema.parse(record)).toEqual(record);
  expect(JSON.stringify(record)).toBe(bytes);
  expect(nutritionPlanVersionV3Schema.safeParse({ ...record, schemaVersion: 3 }).success).toBe(
    false,
  );
  expect(nutritionPlanVersionV2Schema.safeParse({ ...record, schemaVersion: 2 }).success).toBe(
    false,
  );
});
it('sorts revision tuples numerically rather than lexically and preserves exact binding selection', () => {
  const value = {
    ...record,
    items: [item('a'), item('b'), item('c')],
    raceTimingPins: [pin(1), pin(2), pin(10)],
    itemRaceTimingBindings: [binding('a', 1), binding('b', 2), binding('c', 10)],
  };
  expect(nutritionPlanVersionV4Schema.safeParse(value).success).toBe(true);
  expect(
    nutritionPlanVersionV4Schema.safeParse({ ...value, raceTimingPins: [pin(1), pin(10), pin(2)] })
      .success,
  ).toBe(false);
});
it.each([
  'duplicate',
  'conflicting body',
  'uppercase',
  'unused',
  'missing exact revision',
  'duplicate item',
  'binding order',
  'unknown pin',
])('rejects %s', (kind) => {
  const value =
    kind === 'duplicate'
      ? { ...record, raceTimingPins: [pin(1), pin(1), pin(2)] }
      : kind === 'conflicting body'
        ? {
            ...record,
            raceTimingPins: [pin(1), { ...pin(1), sourceDigest: 'b'.repeat(64) }, pin(2)],
          }
        : kind === 'uppercase'
          ? { ...record, raceTimingPins: [{ ...pin(1), eventId: eventId.toUpperCase() }, pin(2)] }
          : kind === 'unused'
            ? { ...record, raceTimingPins: [pin(1), pin(2), pin(3)] }
            : kind === 'missing exact revision'
              ? { ...record, itemRaceTimingBindings: [binding('a', 1), binding('b', 3)] }
              : kind === 'duplicate item'
                ? {
                    ...record,
                    itemRaceTimingBindings: [binding('a', 1), binding('a', 2), binding('b', 2)],
                  }
                : kind === 'binding order'
                  ? { ...record, itemRaceTimingBindings: [binding('b', 2), binding('a', 1)] }
                  : { ...record, raceTimingPins: [{ ...pin(1), verified: true }, pin(2)] };
  expect(nutritionPlanVersionV4Schema.safeParse(value).success).toBe(false);
});
it('allows several bindings to use one exact pin but rejects mismatched anchor namespace/case aliases', () => {
  const value = {
    ...record,
    raceTimingPins: [pin(1)],
    itemRaceTimingBindings: [binding('a', 1), binding('b', 1)],
  };
  expect(nutritionPlanVersionV4Schema.safeParse(value).success).toBe(true);
  expect(
    nutritionPlanVersionV4Schema.safeParse({
      ...value,
      items: [
        { ...item('a'), anchor: { ...item('a').anchor, entityId: eventId.toUpperCase() } },
        item('b'),
      ],
    }).success,
  ).toBe(false);
});
it('preserves legacy unpinned/disconnected food null and zero without admitting orphan timing facts', () => {
  const value = {
    ...record,
    items: [item('a'), { ...item('b'), anchor: { kind: 'disconnected', entity: 'race' } }],
    raceTimingPins: [],
    itemRaceTimingBindings: [
      {
        itemId: 'a',
        binding: {
          state: 'legacy_unpinned',
          priorNutritionVersionId: uuid(5),
          priorItemId: 'a',
          priorAnchorDigest: 'a'.repeat(64),
        },
      },
    ],
  };
  expect(nutritionPlanVersionV4Schema.parse(value)).toEqual(value);
  expect(
    nutritionPlanVersionV4Schema.safeParse({
      ...value,
      itemRaceTimingBindings: [...value.itemRaceTimingBindings, binding('b', 1)],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV4Schema.safeParse({
      ...value,
      items: [
        item('a'),
        { ...item('b'), anchor: { kind: 'disconnected', entity: 'race', eventId } },
      ],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV4Schema.safeParse({
      ...value,
      itemRaceTimingBindings: [
        {
          ...value.itemRaceTimingBindings[0],
          binding: { ...value.itemRaceTimingBindings[0]?.binding, priorItemId: 'b' },
        },
      ],
    }).success,
  ).toBe(false);
});
it('retains actual item-ID validator and whole512KiB envelope bounds', () => {
  const long = '食事:"\\'.repeat(80),
    huge = '食'.repeat(180000);
  const value = {
    ...record,
    items: [item(long)],
    raceTimingPins: [pin(1)],
    itemRaceTimingBindings: [binding(long, 1)],
  };
  expect(nutritionPlanVersionV4Schema.parse(value).items[0]?.id).toBe(long);
  expect(
    nutritionPlanVersionV4Schema.safeParse({
      ...value,
      items: [item(huge)],
      itemRaceTimingBindings: [binding(huge, 1)],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV4Schema.safeParse({
      ...record,
      raceTimingPins: Array.from({ length: 5001 }, (_, i) => pin(i + 1)),
    }).success,
  ).toBe(false);
});
it('reuses approved identity/predecessor refinements and rejects duplicate item bodies', () => {
  for (const value of [
    { ...record, planId: versionId },
    { ...record, version: 2 },
    { ...record, items: [item('a'), item('a')] },
    { ...record, items: [{ ...item('a'), planVersionId: uuid(7) }, item('b')] },
  ])
    expect(nutritionPlanVersionV4Schema.safeParse(value).success).toBe(false);
});
it('compatible decoder preserves legacy V1/V2/V3 bytes rather than assigning new pins or schema', () => {
  const { schemaVersion, raceTimingPins, itemRaceTimingBindings, ...legacy } = record;
  void schemaVersion;
  void raceTimingPins;
  void itemRaceTimingBindings;
  const v1 = {
    ...legacy,
    items: [
      {
        ...item('a'),
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'UTC' },
      },
    ],
  };
  const v2 = {
    ...record,
    schemaVersion: 2,
    items: [item('a')],
    raceTimingPins: [pin(1)],
    itemRaceTimingBindings: [binding('a', 1)],
  };
  const v3 = {
    ...record,
    schemaVersion: 3,
    items: [{ ...item('a'), anchor: { kind: 'disconnected', entity: 'race' } }],
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  };
  expect(nutritionPlanVersionSchema.safeParse(v1).success).toBe(true);
  for (const value of [v1, v2, v3, record])
    expect(nutritionPlanVersionCompatibleV4Schema.parse(value)).toEqual(value);
});
it('readV4 enforces own head identity, absent state and unknownfield boundary', () => {
  const read = {
    schemaVersion: 4,
    planId,
    head: record,
    history: [{ versionId, version: 1, approvedAt: record.approvedAt }],
  };
  expect(nutritionPlanReadV4Schema.parse(read)).toEqual(read);
  expect(nutritionPlanReadCompatibleV4Schema.parse(read)).toEqual(read);
  expect(nutritionPlanReadV4Schema.safeParse({ ...read, head: null }).success).toBe(true);
  expect(nutritionPlanReadV4Schema.safeParse({ ...read, planId: uuid(7) }).success).toBe(false);
  expect(nutritionPlanReadV4Schema.safeParse({ ...read, approvalAllowed: true }).success).toBe(
    false,
  );
});
it('listV4 enforces duplicates/pagination count and whole4MiB independently of record512KiB', () => {
  expect(
    nutritionPlansResponseV4Schema.parse({ schemaVersion: 4, plans: [record], nextCursor: null })
      .plans,
  ).toHaveLength(1);
  expect(
    nutritionPlansResponseV4Schema.safeParse({
      schemaVersion: 4,
      plans: [record, { ...record, planId: planId.toUpperCase() }],
      nextCursor: null,
    }).success,
  ).toBe(false);
  expect(
    nutritionPlansResponseV4Schema.safeParse({
      schemaVersion: 4,
      plans: Array.from({ length: 101 }, () => record),
      nextCursor: null,
    }).success,
  ).toBe(false);
  const large = Array.from({ length: 30 }, (_, i) => ({
    ...record,
    planId: uuid(i + 20),
    items: [item('x'.repeat(145000))],
    raceTimingPins: [pin(1)],
    itemRaceTimingBindings: [binding('x'.repeat(145000), 1)],
  }));
  expect(nutritionPlanVersionV4Schema.safeParse(large[0]).success).toBe(true);
  expect(
    nutritionPlansResponseV4Schema.safeParse({ schemaVersion: 4, plans: large, nextCursor: null })
      .success,
  ).toBe(false);
});
it('strict nested update intent reuses V3 validation without client pin/authority inputs', () => {
  const { planVersionId, ...draftItem } = item('a');
  void planVersionId;
  const intent = {
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        confirmed: true,
        idempotencyKey: 'synthetic-key',
        planId,
        expectedHeadVersionId: versionId,
        draft: {
          period: record.period,
          timezone: 'UTC',
          purpose: 'Reconnect',
          linkedTrainingPlanVersionId: null,
          items: [draftItem],
        },
      },
      expectedRaceHeads: [{ namespace: 'race-event', eventId, revision: 2 }],
      reconnectItemIds: ['a'],
    },
  };
  expect(saveNutritionPlanV4IntentSchema.parse(intent)).toEqual(intent);
  for (const altered of [
    { ...intent, pins: [pin(2)] },
    { ...intent, intent: { ...intent.intent, reconnectItemIds: ['missing'] } },
    {
      ...intent,
      intent: { ...intent.intent, command: { ...intent.intent.command, kind: 'create' } },
    },
  ])
    expect(saveNutritionPlanV4IntentSchema.safeParse(altered).success).toBe(false);
});
