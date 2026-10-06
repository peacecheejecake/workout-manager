import { expect, it } from 'vitest';
import {
  nutritionPlanDraftSchema,
  nutritionPlanVersionSchema,
  saveNutritionPlanVersionRequestSchema,
} from '../src/nutrition-core.js';
import {
  saveNutritionPlanV2IntentSchema,
  nutritionPlanVersionV2Schema,
  nutritionPlanVersionCompatibleSchema,
  nutritionPlanReadCompatibleSchema,
} from '../src/nutrition-race-plan-v2.js';
const event = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const plan = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const approval = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const item = {
  id: 'meal-1',
  category: 'before',
  title: 'Synthetic meal',
  anchor: {
    kind: 'relative',
    entity: 'race',
    entityId: event,
    point: 'start',
    offsetMinutes: 0,
  },
  foods: [],
  targets: [],
  instructions: 'Drink if desired',
  evidenceIds: [],
  source: 'user_confirmed',
};
const draft = {
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'Asia/Seoul',
  purpose: 'Synthetic',
  linkedTrainingPlanVersionId: null,
  items: [item],
};
const command = {
  kind: 'create',
  idempotencyKey: 'synthetic-key',
  confirmed: true,
  draft,
};
const intent = {
  schemaVersion: 2,
  command,
  expectedRaceHeads: [{ namespace: 'race-event', eventId: event, revision: 1 }],
};
const record = {
  ...draft,
  planId: plan,
  versionId: version,
  version: 1,
  previousVersionId: null,
  approvedAt: '2026-10-07T00:00:00Z',
  approvalId: approval,
  items: [{ ...item, planVersionId: version }],
};
const pin = {
  pinVersion: 1,
  namespace: 'race-event-revision',
  eventId: event,
  eventRevision: 1,
  sourceDigestVersion: 'race-event-values-canonical-v1',
  sourceDigest: 'a'.repeat(64),
  localDate: '2026-10-07',
  localStartTime: null,
  timezone: 'Asia/Seoul',
  start: { state: 'unknown', reason: 'start_time_not_recorded' },
  end: { state: 'unknown', reason: 'race_end_not_recorded' },
};
const saved = {
  schemaVersion: 2,
  ...record,
  raceTimingPins: [pin],
  itemRaceTimingBindings: [
    {
      itemId: item.id,
      binding: { state: 'captured', eventId: event, eventRevision: 1 },
    },
  ],
};
it('legacy bytes remain strict and compatible without auto-pin', () => {
  expect(nutritionPlanVersionCompatibleSchema.parse(record)).toEqual(record);
  expect(saveNutritionPlanVersionRequestSchema.parse(command)).toEqual(command);
  expect(nutritionPlanDraftSchema.safeParse({ ...draft, raceTimingPins: [pin] }).success).toBe(
    false,
  );
  expect(nutritionPlanVersionSchema.safeParse(saved).success).toBe(false);
});
it('explicit intent contains expectations and no server facts', () =>
  expect(saveNutritionPlanV2IntentSchema.parse(intent)).toEqual(intent));
it.each(['raceTimingPins', 'sourceDigest', 'itemRaceTimingBindings'])(
  'client rejects server field %s',
  (field) => {
    expect(saveNutritionPlanV2IntentSchema.safeParse({ ...intent, [field]: [] }).success).toBe(
      false,
    );
    expect(
      saveNutritionPlanV2IntentSchema.safeParse({
        ...intent,
        command: { ...command, draft: { ...draft, [field]: [] } },
      }).success,
    ).toBe(false);
  },
);
it('missing/orphan expectation fails exact race set', () => {
  expect(
    saveNutritionPlanV2IntentSchema.safeParse({
      ...intent,
      expectedRaceHeads: [],
    }).success,
  ).toBe(false);
  expect(
    saveNutritionPlanV2IntentSchema.safeParse({
      ...intent,
      command: { ...command, draft: { ...draft, items: [] } },
    }).success,
  ).toBe(false);
});
it('same-ID session branch requires no race expectations', () => {
  const session = { ...item, anchor: { ...item.anchor, entity: 'session' } };
  const input = {
    ...intent,
    command: { ...command, draft: { ...draft, items: [session] } },
    expectedRaceHeads: [],
  };
  expect(saveNutritionPlanV2IntentSchema.safeParse(input).success).toBe(true);
  expect(
    saveNutritionPlanV2IntentSchema.safeParse({
      ...input,
      expectedRaceHeads: intent.expectedRaceHeads,
    }).success,
  ).toBe(false);
});
it('server V2 preserves null and unknown without end inference', () =>
  expect(nutritionPlanVersionV2Schema.parse(saved)).toEqual(saved));
it('end known and fabricated target fact reject', () => {
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [{ ...pin, end: { state: 'known', instant: '2026-10-07T01:00:00Z' } }],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [{ ...pin, targetSeconds: 3600 }],
    }).success,
  ).toBe(false);
});
it('duplicate/excess pins and mismatched revisions reject', () => {
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [pin, pin],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [{ ...pin, eventRevision: 2 }],
    }).success,
  ).toBe(false);
});
it('legacy binding is structure only and never synthesizes a pin', () => {
  const legacy = {
    ...saved,
    raceTimingPins: [],
    itemRaceTimingBindings: [
      {
        itemId: item.id,
        binding: {
          state: 'legacy_unpinned',
          priorNutritionVersionId: version,
          priorItemId: item.id,
          priorAnchorDigest: 'b'.repeat(64),
        },
      },
    ],
  };
  expect(nutritionPlanVersionV2Schema.parse(legacy)).toEqual(legacy);
});
it('read compatible union preserves legacy empty and V2 own heads, rejects foreign head', () => {
  expect(
    nutritionPlanReadCompatibleSchema.parse({
      planId: plan,
      head: null,
      history: [],
    }),
  ).toEqual({ planId: plan, head: null, history: [] });
  expect(
    nutritionPlanReadCompatibleSchema.safeParse({
      schemaVersion: 2,
      planId: plan,
      head: saved,
      history: [],
    }).success,
  ).toBe(true);
  expect(
    nutritionPlanReadCompatibleSchema.safeParse({
      schemaVersion: 2,
      planId: approval,
      head: saved,
      history: [],
    }).success,
  ).toBe(false);
});
it('bounded item roster rejects limit+1 and unknown envelope fields', () => {
  expect(
    saveNutritionPlanV2IntentSchema.safeParse({
      ...intent,
      command: {
        ...command,
        draft: {
          ...draft,
          items: Array.from({ length: 5001 }, (_, i) => ({
            ...item,
            id: `meal-${i}`,
          })),
        },
      },
    }).success,
  ).toBe(false);
  expect(nutritionPlanVersionV2Schema.safeParse({ ...saved, admissionAllowed: true }).success).toBe(
    false,
  );
});
it('all-record bound includes timing fields beyond valid legacy body', () => {
  // Find a valid legacy record just below its exact byte cap, then add V2 pins.
  const items = Array.from({ length: 1000 }, (_, i) => ({
    ...item,
    id: `meal-${i}`,
    planVersionId: version,
  }));
  let near = { ...record, items };
  const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
  const remaining = 512 * 1024 - bytes(near) - 1;
  // Spread text below per-item instructions cap; no giant invalid field masks bound.
  for (let i = 0, left = remaining; i < items.length && left > 0; i++) {
    const count = Math.min(200, left);
    const current = items[i];
    if (!current) throw Error('fixture');
    current.instructions += 'x'.repeat(count);
    left -= count;
  }
  near = { ...record, items };
  expect(nutritionPlanVersionSchema.safeParse(near).success).toBe(true);
  expect(bytes(near)).toBeLessThanOrEqual(512 * 1024);
  const v2 = {
    ...saved,
    ...near,
    itemRaceTimingBindings: items.map((x) => ({
      itemId: x.id,
      binding: { state: 'captured', eventId: event, eventRevision: 1 },
    })),
  };
  const parsed = nutritionPlanVersionV2Schema.safeParse(v2);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('Expected complete envelope bound');
  expect(
    parsed.error.issues.some(
      (issue) => issue.message === 'Complete nutrition V2 envelope exceeds 512 KiB',
    ),
  ).toBe(true);
});
it('V2 reuses all legacy predecessor and item identity refinements', () => {
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      version: 2,
      previousVersionId: null,
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      items: [{ ...saved.items[0], planVersionId: approval }],
    }).success,
  ).toBe(false);
  expect(nutritionPlanVersionV2Schema.safeParse({ ...saved, planId: version }).success).toBe(false);
});
it('civil correspondence remains strict and ambiguity is not resolved by schema', () => {
  const ambiguous = {
    ...pin,
    localDate: '2026-11-01',
    localStartTime: '01:30',
    timezone: 'America/New_York',
    start: { state: 'unknown', reason: 'ambiguous_local_time' },
  };
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [ambiguous],
    }).success,
  ).toBe(true);
  const fractional = {
    ...pin,
    localStartTime: '09:00',
    start: { state: 'known', instant: '2026-10-07T00:00:00.001Z' },
  };
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [fractional],
    }).success,
  ).toBe(false);
});
it('wrong namespace, foreign event and injected zero-start reject', () => {
  expect(
    saveNutritionPlanV2IntentSchema.safeParse({
      ...intent,
      expectedRaceHeads: [{ ...intent.expectedRaceHeads[0], namespace: 'session' }],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [{ ...pin, eventId: approval }],
    }).success,
  ).toBe(false);
  expect(
    nutritionPlanVersionV2Schema.safeParse({
      ...saved,
      raceTimingPins: [{ ...pin, start: 0 }],
    }).success,
  ).toBe(false);
});
