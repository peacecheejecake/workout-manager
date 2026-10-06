import { describe, expect, it } from 'vitest';
import {
  capturedRaceTimingBindingSchema,
  expectedRaceHeadsSchema,
  legacyUnpinnedRaceTimingBindingSchema,
  nutritionRaceTimingRosterSchema,
  raceHeadExpectationRosterSchema,
  raceTimingPinV1Schema,
} from '../src/nutrition-race-timing.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const digest = 'a'.repeat(64);
const pin = {
  pinVersion: 1,
  namespace: 'race-event-revision',
  eventId,
  eventRevision: 1,
  sourceDigestVersion: 'race-event-values-canonical-v1',
  sourceDigest: digest,
  localDate: '2026-10-07',
  localStartTime: '09:00',
  timezone: 'Asia/Seoul',
  start: { state: 'known', instant: '2026-10-07T00:00:00Z' },
  end: { state: 'unknown', reason: 'race_end_not_recorded' },
} as const;
const anchor = {
  kind: 'relative',
  entity: 'race',
  entityId: eventId,
  point: 'start',
  offsetMinutes: 0,
} as const;
const item = { itemId: 'meal-1', anchor };
const captured = { state: 'captured', eventId, eventRevision: 1 } as const;
const legacy = {
  state: 'legacy_unpinned',
  priorNutritionVersionId: otherId,
  priorItemId: item.itemId,
  priorAnchorDigest: digest,
} as const;
const roster = {
  items: [item],
  raceTimingPins: [pin],
  itemRaceTimingBindings: [{ itemId: item.itemId, binding: captured }],
};
function uuid(index: number) {
  return `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
}

describe('race timing pin structural foundation (not server authority)', () => {
  it.each(['0001', '0999'])('preserves ISO year %s and rejects mismatched years', (year) => {
    const early = {
      ...pin,
      localDate: `${year}-01-01`,
      localStartTime: '00:00:17',
      timezone: 'UTC',
      start: { state: 'known', instant: `${year}-01-01T00:00:17Z` },
    };
    expect(raceTimingPinV1Schema.parse(early)).toEqual(early);
    expect(raceTimingPinV1Schema.safeParse({ ...early, localDate: '1000-01-01' }).success).toBe(
      false,
    );
  });
  it('preserves known civil time, offset-qualified instant and terminal revision', () => {
    expect(raceTimingPinV1Schema.parse(pin)).toEqual(pin);
    const offset = {
      ...pin,
      eventRevision: 2147483647,
      start: {
        state: 'known',
        instant: '2026-10-07T09:00:00+09:00',
      },
    };
    expect(raceTimingPinV1Schema.parse(offset)).toEqual(offset);
  });
  it('preserves HH:mm:ss and nonzero seconds with timezone day crossing', () => {
    const seconds = {
      ...pin,
      localStartTime: '00:00:17',
      start: { state: 'known', instant: '2026-10-06T15:00:17Z' },
    };
    expect(raceTimingPinV1Schema.parse(seconds)).toEqual(seconds);
    expect(
      raceTimingPinV1Schema.parse({
        ...pin,
        localStartTime: '09:00:00',
      }),
    ).toEqual({ ...pin, localStartTime: '09:00:00' });
    expect(
      raceTimingPinV1Schema.safeParse({
        ...seconds,
        start: { state: 'known', instant: '2026-10-06T15:00:00Z' },
      }).success,
    ).toBe(false);
  });
  it('rejects fractional instants without changing an explicit zero fraction', () => {
    expect(
      raceTimingPinV1Schema.safeParse({
        ...pin,
        start: {
          state: 'known',
          instant: '2026-10-07T09:00:00.001+09:00',
        },
      }).success,
    ).toBe(false);
    const zero = {
      ...pin,
      start: {
        state: 'known',
        instant: '2026-10-07T09:00:00.000+09:00',
      },
    };
    expect(raceTimingPinV1Schema.parse(zero)).toEqual(zero);
  });
  it('rejects uppercase UUIDs instead of changing source wire identities', () => {
    const uppercase = 'ABCDEFAB-1111-4111-8111-111111111111';
    expect(raceTimingPinV1Schema.safeParse({ ...pin, eventId: uppercase }).success).toBe(false);
    expect(
      expectedRaceHeadsSchema.safeParse([
        {
          namespace: 'race-event',
          eventId: uppercase,
          revision: 1,
        },
      ]).success,
    ).toBe(false);
    expect(
      capturedRaceTimingBindingSchema.safeParse({ ...captured, eventId: uppercase }).success,
    ).toBe(false);
    expect(
      legacyUnpinnedRaceTimingBindingSchema.safeParse({
        ...legacy,
        priorNutritionVersionId: uppercase,
      }).success,
    ).toBe(false);
    const lower = { ...pin, eventId: uppercase.toLowerCase() };
    expect(raceTimingPinV1Schema.parse(lower)).toEqual(lower);
  });
  it('preserves null unknown separately from a recorded ambiguous local time', () => {
    const missing = {
      ...pin,
      localStartTime: null,
      start: {
        state: 'unknown',
        reason: 'start_time_not_recorded',
      },
    };
    expect(raceTimingPinV1Schema.parse(missing)).toEqual(missing);
    const ambiguous = {
      ...pin,
      localDate: '2026-11-01',
      localStartTime: '01:30',
      timezone: 'America/New_York',
      start: { state: 'unknown', reason: 'ambiguous_local_time' },
    };
    expect(raceTimingPinV1Schema.parse(ambiguous)).toEqual(ambiguous);
    expect(raceTimingPinV1Schema.safeParse({ ...missing, start: ambiguous.start }).success).toBe(
      false,
    );
    expect(raceTimingPinV1Schema.safeParse({ ...ambiguous, start: missing.start }).success).toBe(
      false,
    );
    expect(raceTimingPinV1Schema.safeParse({ ...pin, localStartTime: null }).success).toBe(false);
  });
  it.each([
    { namespace: 'session-revision' },
    { pinVersion: 2 },
    { eventRevision: 0 },
    { eventRevision: 2147483648 },
    { eventRevision: '1' },
    { sourceDigest: 'A'.repeat(64) },
    { sourceDigestVersion: 'sql-to-jsonb' },
    { localDate: '2026-02-30' },
    { localStartTime: '24:00' },
    { timezone: 'Unknown/Timezone' },
    { start: { state: 'known', instant: 'invalid' } },
    { end: { state: 'known', instant: '2026-10-07T01:00:00Z' } },
    { targetSeconds: 3600 },
    { approved: true },
  ])('rejects malformed or authority-widening pin fields %j', (patch) => {
    expect(raceTimingPinV1Schema.safeParse({ ...pin, ...patch }).success).toBe(false);
  });
  it('rejects an instant that does not correspond to the pinned civil date/time/zone', () => {
    for (const patch of [
      { localDate: '2026-10-08' },
      { localStartTime: '09:01' },
      { timezone: 'UTC' },
    ])
      expect(raceTimingPinV1Schema.safeParse({ ...pin, ...patch }).success).toBe(false);
    const gap = {
      ...pin,
      localDate: '2026-03-08',
      localStartTime: '02:30',
      timezone: 'America/New_York',
      start: { state: 'known', instant: '2026-03-08T07:30:00Z' },
    };
    expect(raceTimingPinV1Schema.safeParse(gap).success).toBe(false);
  });
  it('keeps captured and legacy shapes mutually strict with no inferred permission', () => {
    expect(capturedRaceTimingBindingSchema.parse(captured)).toEqual(captured);
    expect(legacyUnpinnedRaceTimingBindingSchema.parse(legacy)).toEqual(legacy);
    expect(capturedRaceTimingBindingSchema.safeParse({ ...captured, ...legacy }).success).toBe(
      false,
    );
    expect(
      legacyUnpinnedRaceTimingBindingSchema.safeParse({ ...legacy, eventRevision: 1 }).success,
    ).toBe(false);
  });
});

describe('expected race heads are exact client CAS intent', () => {
  const head = { namespace: 'race-event', eventId, revision: 1 } as const;
  it('accepts sorted unique heads and literal absence', () => {
    expect(expectedRaceHeadsSchema.parse([])).toEqual([]);
    expect(expectedRaceHeadsSchema.parse([head, { ...head, eventId: otherId }])).toHaveLength(2);
  });
  it('rejects duplicate event IDs even with distinct revisions and rejects unsorted heads', () => {
    expect(expectedRaceHeadsSchema.safeParse([head, { ...head, revision: 2 }]).success).toBe(false);
    expect(expectedRaceHeadsSchema.safeParse([{ ...head, eventId: otherId }, head]).success).toBe(
      false,
    );
    expect(expectedRaceHeadsSchema.safeParse([{ ...head, namespace: 'session' }]).success).toBe(
      false,
    );
    expect(expectedRaceHeadsSchema.safeParse([{ ...head, sourceDigest: digest }]).success).toBe(
      false,
    );
  });
  it('allows 5000 heads but rejects 5001 without truncation', () => {
    const heads = Array.from({ length: 5000 }, (_, index) => ({ ...head, eventId: uuid(index) }));
    expect(expectedRaceHeadsSchema.parse(heads)).toHaveLength(5000);
    expect(
      expectedRaceHeadsSchema.safeParse([...heads, { ...head, eventId: uuid(5000) }]).success,
    ).toBe(false);
  });
  it('matches race namespace only when session and race share an ID', () => {
    const session = { itemId: 'session-meal', anchor: { ...anchor, entity: 'session' } };
    expect(
      raceHeadExpectationRosterSchema.parse({ items: [session], expectedRaceHeads: [] }),
    ).toBeDefined();
    expect(
      raceHeadExpectationRosterSchema.safeParse({ items: [session], expectedRaceHeads: [head] })
        .success,
    ).toBe(false);
    expect(
      raceHeadExpectationRosterSchema.parse({ items: [item, session], expectedRaceHeads: [head] }),
    ).toBeDefined();
    expect(
      raceHeadExpectationRosterSchema.safeParse({ items: [item], expectedRaceHeads: [] }).success,
    ).toBe(false);
    expect(
      raceHeadExpectationRosterSchema.safeParse({
        items: [item],
        expectedRaceHeads: [{ ...head, eventId: otherId }],
      }).success,
    ).toBe(false);
  });
});

describe('stored timing rosters match pins without upgrading legacy items', () => {
  it('deduplicates a shared captured pin structurally while retaining explicit legacy bindings', () => {
    const input = {
      ...roster,
      items: [item, { ...item, itemId: 'meal-2' }, { ...item, itemId: 'meal-3' }],
      itemRaceTimingBindings: [
        roster.itemRaceTimingBindings[0],
        { itemId: 'meal-2', binding: captured },
        { itemId: 'meal-3', binding: { ...legacy, priorItemId: 'meal-3' } },
      ],
    };
    const saved = nutritionRaceTimingRosterSchema.parse(input);
    expect(saved.raceTimingPins).toHaveLength(1);
    expect(saved.itemRaceTimingBindings[2]?.binding.state).toBe('legacy_unpinned');
    expect(input).toEqual(saved);
  });
  it('accepts a literal empty roster and legacy-only preservation with no manufactured pin', () => {
    expect(
      nutritionRaceTimingRosterSchema.parse({
        items: [],
        raceTimingPins: [],
        itemRaceTimingBindings: [],
      }),
    ).toBeDefined();
    const input = {
      items: [item],
      raceTimingPins: [],
      itemRaceTimingBindings: [{ itemId: item.itemId, binding: legacy }],
    };
    expect(nutritionRaceTimingRosterSchema.parse(input)).toEqual(input);
  });
  it.each([
    { raceTimingPins: [] },
    { raceTimingPins: [{ ...pin, eventId: otherId }] },
    { raceTimingPins: [{ ...pin, eventRevision: 2 }] },
    { raceTimingPins: [pin, { ...pin, eventRevision: 2 }] },
    { raceTimingPins: [pin, { ...pin, eventId: otherId }] },
    { itemRaceTimingBindings: [] },
    { itemRaceTimingBindings: [{ itemId: 'unknown', binding: captured }] },
    {
      itemRaceTimingBindings: [
        { itemId: item.itemId, binding: { ...legacy, priorItemId: 'renamed' } },
      ],
    },
    { items: [item, item] },
    {
      itemRaceTimingBindings: [roster.itemRaceTimingBindings[0], roster.itemRaceTimingBindings[0]],
    },
    { items: [{ ...item, anchor: { ...anchor, entity: 'session' } }] },
    { approvalAllowed: true },
  ])('rejects missing/excess/orphan or mismatched rosters %j', (patch) => {
    expect(nutritionRaceTimingRosterSchema.safeParse({ ...roster, ...patch }).success).toBe(false);
  });
  it('keeps unknown end and unknown start as valid captured data, never resolution authority', () => {
    const input = {
      ...roster,
      items: [{ ...item, anchor: { ...anchor, point: 'end' } }],
      raceTimingPins: [
        {
          ...pin,
          localStartTime: null,
          start: { state: 'unknown', reason: 'start_time_not_recorded' },
        },
      ],
    };
    expect(nutritionRaceTimingRosterSchema.parse(input)).toEqual(input);
  });
  it('rejects unsorted binding rosters without sorting callers data', () => {
    const input = {
      ...roster,
      items: [item, { ...item, itemId: 'meal-2' }],
      itemRaceTimingBindings: [
        { itemId: 'meal-2', binding: captured },
        roster.itemRaceTimingBindings[0],
      ],
    };
    expect(nutritionRaceTimingRosterSchema.safeParse(input).success).toBe(false);
    expect(input.itemRaceTimingBindings[0]?.itemId).toBe('meal-2');
  });
  it('enforces the aggregate byte budget even below the 5000 item count cap', () => {
    const items = Array.from({ length: 2500 }, (_, index) => ({
      itemId: `meal-${index.toString().padStart(4, '0')}`,
      anchor,
    }));
    const input = {
      items,
      raceTimingPins: [],
      itemRaceTimingBindings: items.map((entry) => ({
        itemId: entry.itemId,
        binding: { ...legacy, priorItemId: entry.itemId },
      })),
    };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(512 * 1024);
    expect(nutritionRaceTimingRosterSchema.safeParse(input).success).toBe(false);
  });
  it('rejects 5001 items independently of the binding byte cap', () => {
    const items = Array.from({ length: 5001 }, (_, index) => ({
      itemId: `i${index}`,
      anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'UTC' },
    }));
    expect(
      nutritionRaceTimingRosterSchema.safeParse({
        items,
        raceTimingPins: [],
        itemRaceTimingBindings: [],
      }).success,
    ).toBe(false);
  });
});
