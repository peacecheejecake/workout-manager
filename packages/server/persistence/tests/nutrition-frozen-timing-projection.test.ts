import { expect, it } from 'vitest';
import { projectFrozenNutritionTiming } from '../src/nutrition-frozen-timing-projection.js';
import { raceTimingPinV1Schema } from '@workout/contracts/nutrition-race-timing';
import { localDateSchema } from '@workout/contracts/primitives';
import { projectNutritionItem, localInstant } from '../src/integrated-planner.js';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
const event = '11111111-1111-4111-8111-111111111111';
const plan = '22222222-2222-4222-8222-222222222222';
const version = '33333333-3333-4333-8333-333333333333';
const approval = '44444444-4444-4444-8444-444444444444';
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
  planId: plan,
  versionId: version,
  version: 1,
  previousVersionId: null,
  approvalId: approval,
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
  raceSourceVisibility: 'available',
};
it('pure frozen pin projection preserves seconds and offers no storage/approval', () => {
  const result = projectFrozenNutritionTiming(input);
  expect(result).toMatchObject({
    status: 'projected',
    storage: 'not_persisted',
    approvalAllowed: false,
    projection: { date: '2026-10-07', value: { localTime: '09:00:17' } },
  });
  expect(Object.isFrozen(result)).toBe(true);
  if (result.status === 'projected') expect(Object.isFrozen(result.projection.value)).toBe(true);
});
it('mutable race/map/provider injections and missing visibility reject', () => {
  for (const key of ['race', 'ownedRaces', 'query', 'provider'])
    expect(() => projectFrozenNutritionTiming({ ...input, [key]: {} })).toThrow(
      'NUTRITION_FROZEN_TIMING_INVALID_INPUT',
    );
  const { raceSourceVisibility, ...absent } = input;
  void raceSourceVisibility;
  expect(() => projectFrozenNutritionTiming(absent)).toThrow(
    'NUTRITION_FROZEN_TIMING_INVALID_INPUT',
  );
});
it.each(['unknown', 'unavailable'])(
  'caller visibility %s leaves source unresolved',
  (visibility) => {
    expect(
      projectFrozenNutritionTiming({ ...input, raceSourceVisibility: visibility }),
    ).toMatchObject({
      status: 'unresolved',
      item: { reason: 'missing_anchor' },
      detail: visibility === 'unknown' ? 'source_visibility_unknown' : 'source_unavailable',
    });
  },
);
it('legacy no-pin and V2 legacy binding remain unknown without re-pin', () => {
  expect(projectFrozenNutritionTiming({ ...input, record: legacy })).toMatchObject({
    status: 'unresolved',
    detail: 'legacy_unpinned',
  });
  const unpinned = {
    ...record,
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
  expect(projectFrozenNutritionTiming({ ...input, record: unpinned })).toMatchObject({
    status: 'unresolved',
    detail: 'legacy_unpinned',
  });
});
it('end timing is never inferred from target/duration/PB', () => {
  const end = { ...record, items: [{ ...item, anchor: { ...item.anchor, point: 'end' } }] };
  expect(projectFrozenNutritionTiming({ ...input, record: end })).toMatchObject({
    status: 'unresolved',
    detail: 'race_end_unknown',
  });
  expect(() =>
    projectFrozenNutritionTiming({ ...input, record: { ...end, targetSeconds: 3600 } }),
  ).toThrow();
});
it.each([
  {
    localDate: '2026-10-07',
    localStartTime: null,
    timezone: 'Asia/Seoul',
    start: { state: 'unknown', reason: 'start_time_not_recorded' },
  },
  {
    localDate: '2026-03-08',
    localStartTime: '02:30',
    timezone: 'America/New_York',
    start: { state: 'unknown', reason: 'ambiguous_local_time' },
  },
  {
    localDate: '2026-11-01',
    localStartTime: '01:30',
    timezone: 'America/New_York',
    start: { state: 'unknown', reason: 'ambiguous_local_time' },
  },
])('null/gap/overlap stays unresolved %j', (patch) => {
  expect(
    projectFrozenNutritionTiming({
      ...input,
      record: { ...record, raceTimingPins: [{ ...pin, ...patch }] },
    }),
  ).toMatchObject({ status: 'unresolved', detail: 'start_unknown' });
});
it('schema-compatible known DST overlap is still not a unique source instant', () => {
  const ambiguous = {
    ...pin,
    localDate: '2026-11-01',
    localStartTime: '01:30',
    timezone: 'America/New_York',
    start: { state: 'known', instant: '2026-11-01T05:30:00Z' },
  };
  expect(
    projectFrozenNutritionTiming({ ...input, record: { ...record, raceTimingPins: [ambiguous] } }),
  ).toMatchObject({ status: 'unresolved', detail: 'ambiguous_local_time' });
});
it('elapsed offset crosses local dates without losing seconds; zero remains known', () => {
  const offset = {
    ...record,
    items: [{ ...item, anchor: { ...item.anchor, offsetMinutes: -600 } }],
  };
  expect(projectFrozenNutritionTiming({ ...input, record: offset })).toMatchObject({
    status: 'projected',
    projection: { date: '2026-10-06', value: { localTime: '23:00:17' } },
  });
  expect(
    projectFrozenNutritionTiming({ ...input, targetTimezone: 'America/Los_Angeles' }),
  ).toMatchObject({
    status: 'projected',
    projection: { date: '2026-10-06', value: { localTime: '17:00:17' } },
  });
});
it('duplicate/orphan pins, mismatched item and invalid roster reject', () => {
  for (const bad of [
    { ...record, raceTimingPins: [pin, pin] },
    { ...record, raceTimingPins: [{ ...pin, eventId: approval }] },
    { ...record, itemRaceTimingBindings: [] },
  ])
    expect(() => projectFrozenNutritionTiming({ ...input, record: bad })).toThrow();
  expect(() => projectFrozenNutritionTiming({ ...input, itemId: 'foreign-item' })).toThrow();
});
it('session/absolute legacy projections preserve the existing helper behavior', () => {
  const absolute = {
    ...legacy,
    items: [
      {
        ...item,
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' },
      },
    ],
  };
  const parsed = nutritionPlanVersionSchema.parse(absolute);
  const entry = parsed.items[0];
  if (!entry) throw Error('fixture');
  const expected = projectNutritionItem(entry, parsed, new Map(), 'Asia/Seoul');
  expect(projectFrozenNutritionTiming({ ...input, record: absolute })).toMatchObject({
    status: 'projected',
    projection: expected,
  });
  expect(
    projectFrozenNutritionTiming({ ...input, record: absolute, targetTimezone: 'UTC' }),
  ).toMatchObject({ status: 'unresolved', item: { reason: 'timezone_mismatch' } });
});
it('same UUID session uses exact historical plan membership, duration zero is known', () => {
  const training = {
    title: 'Synthetic',
    timezone: 'Asia/Seoul',
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
    sessions: [
      {
        id: event,
        blockId: 'block',
        date: '2026-10-07',
        localStartTime: '09:00',
        title: 'Synthetic',
        sport: 'running',
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const session = {
    ...legacy,
    linkedTrainingPlanVersionId: approval,
    items: [{ ...item, anchor: { ...item.anchor, entity: 'session', point: 'end' } }],
  };
  const provided = {
    ...input,
    record: session,
    linkedTraining: { versionId: approval, draft: training },
    raceSourceVisibility: 'unknown',
  };
  expect(projectFrozenNutritionTiming(provided)).toMatchObject({
    status: 'projected',
    projection: { value: { localTime: '09:00:00' } },
  });
  expect(() =>
    projectFrozenNutritionTiming({
      ...provided,
      linkedTraining: { versionId: version, draft: training },
    }),
  ).toThrow();
  expect(
    projectFrozenNutritionTiming({
      ...provided,
      linkedTraining: { versionId: approval, draft: { ...training, sessions: [] } },
    }),
  ).toMatchObject({ status: 'unresolved', item: { reason: 'missing_anchor' } });
  expect(
    projectFrozenNutritionTiming({
      ...provided,
      linkedTraining: {
        versionId: approval,
        draft: {
          ...training,
          sessions: training.sessions.map((s) => ({ ...s, durationSeconds: null })),
        },
      },
    }),
  ).toMatchObject({ status: 'unresolved', item: { reason: 'missing_session_duration' } });
});
it('full record size and 5000 item cap stay strict before projection', () => {
  const big = {
    ...record,
    items: Array.from({ length: 5001 }, (_, i) => ({ ...item, id: `meal-${i}` })),
  };
  expect(() => projectFrozenNutritionTiming({ ...input, record: big })).toThrow();
  const bytes = {
    ...record,
    items: Array.from({ length: 1000 }, (_, i) => ({
      ...item,
      id: `meal-${i}`,
      instructions: 'x'.repeat(300),
    })),
    itemRaceTimingBindings: Array.from({ length: 1000 }, (_, i) => ({
      itemId: `meal-${i}`,
      binding: { state: 'captured', eventId: event, eventRevision: 1 },
    })),
  };
  expect(() =>
    projectFrozenNutritionTiming({ ...input, record: bytes, itemId: 'meal-0' }),
  ).toThrow();
});

it('valid year1000 pin offset crosses to0999 preserving four-digit civil year', () => {
  const ancient = {
    ...pin,
    localDate: '1000-01-01',
    localStartTime: '00:00:17',
    timezone: 'UTC',
    start: { state: 'known', instant: '1000-01-01T00:00:17Z' },
  };
  expect(raceTimingPinV1Schema.safeParse(ancient).success).toBe(true);
  const value = {
    ...record,
    raceTimingPins: [ancient],
    items: [{ ...item, anchor: { ...item.anchor, offsetMinutes: -1 } }],
  };
  expect(
    projectFrozenNutritionTiming({ ...input, record: value, targetTimezone: 'UTC' }),
  ).toMatchObject({
    status: 'projected',
    projection: { date: '0999-12-31', value: { localTime: '23:59:17' } },
  });
});
it('low-year valid pins follow corrected public correspondence while null stays unknown', () => {
  for (const date of ['0001-01-01', '0999-12-31']) {
    expect(localDateSchema.safeParse(date).success).toBe(true);
    expect(localInstant(date, '23:59:17', 'UTC')).toBe(Date.parse(`${date}T23:59:17Z`));
    const known = {
      ...pin,
      localDate: date,
      localStartTime: '23:59:17',
      timezone: 'UTC',
      start: { state: 'known', instant: `${date}T23:59:17Z` },
    };
    expect(raceTimingPinV1Schema.safeParse(known).success).toBe(true);
    expect(
      projectFrozenNutritionTiming({
        ...input,
        targetTimezone: 'UTC',
        record: { ...record, raceTimingPins: [known] },
      }),
    ).toMatchObject({
      status: 'projected',
      projection: { date, value: { localTime: '23:59:17' } },
    });
    const unknown = {
      ...known,
      localStartTime: null,
      start: { state: 'unknown', reason: 'start_time_not_recorded' },
    };
    expect(
      projectFrozenNutritionTiming({ ...input, record: { ...record, raceTimingPins: [unknown] } }),
    ).toMatchObject({ status: 'unresolved', detail: 'start_unknown' });
  }
});
