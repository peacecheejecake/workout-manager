import { describe, expect, it } from 'vitest';

import {
  integratedPlannerDaySchema,
  integratedPlannerDayV4Schema,
  integratedPlannerReadSchema,
  integratedPlannerReadV4Schema,
  integratedPlannerReadV5Schema,
  integratedPlannerSummarySchema,
  integratedPlannerSummaryV4Schema,
  nutritionOperationalStateSchema,
  unresolvedNutritionItemSchema,
} from '../src/integrated-planner.js';

const planVersionId = 'a1111111-1111-4111-8111-111111111111';
const otherPlanVersionId = 'b2222222-2222-4222-8222-222222222222';
const unknownMetric = { value: null, knownCount: 0, missingCount: 0 };
const summary = integratedPlannerSummarySchema.parse({
  training: {
    plannedSessionCount: 0,
    actualActivityCount: 0,
    supplementaryActivityCount: 0,
    distanceMeters: unknownMetric,
    durationSeconds: {
      timer: unknownMetric,
      elapsed: unknownMetric,
      moving: unknownMetric,
      unknown: unknownMetric,
    },
  },
  nutrition: {
    plannedItemCount: 0,
    intakeCount: 0,
    nutrients: {
      energyKcal: unknownMetric,
      carbohydrateGrams: unknownMetric,
      proteinGrams: unknownMetric,
      fatGrams: unknownMetric,
      fluidMl: unknownMetric,
      sodiumMg: unknownMetric,
    },
    intakeCoverage: 'unknown',
  },
});
const day = integratedPlannerDaySchema.parse({
  date: '2026-10-07',
  plannedSessions: [],
  nutritionItems: [],
  activities: [],
  intakes: [],
  summary,
});
const summaryV4 = integratedPlannerSummaryV4Schema.parse({
  ...summary,
  recovery: { plannedStrategyCount: 0, actualActionCount: 0 },
  routines: { occurrenceCount: 0, runCount: 0 },
  stretchingActivityCount: 0,
});
const dayV4 = integratedPlannerDayV4Schema.parse({
  ...day,
  recoveryPlans: [],
  recoveryActions: [],
  routineOccurrences: [],
  routineRuns: [],
  stretchingActivityIds: [],
});
const readV1 = integratedPlannerReadSchema.parse({
  schemaVersion: 1,
  from: '2026-10-07',
  toExclusive: '2026-10-08',
  timezone: 'Asia/Seoul',
  trainingPlanVersionId: null,
  nutritionPlanVersionIds: [planVersionId],
  days: [day],
  unresolvedNutritionItems: [],
  unplacedActivityCount: 0,
  summary,
});
const readV4 = integratedPlannerReadV4Schema.parse({
  ...readV1,
  schemaVersion: 4,
  recoveryStrategyVersionIds: [],
  routineScheduleVersionIds: [],
  days: [dayV4],
  summary: summaryV4,
});
function unresolvedItem(id = 'item-1', versionId = planVersionId) {
  return unresolvedNutritionItemSchema.parse({
    id,
    planVersionId: versionId,
    title: 'User meal',
    category: 'meal',
    source: 'user_confirmed',
    reason: 'missing_anchor',
  });
}
function operationalState(itemId = 'item-1', versionId = planVersionId) {
  return nutritionOperationalStateSchema.parse({
    planVersionId: versionId,
    itemId,
    state: 'suspended',
    reason: 'race_disconnected',
  });
}
function readV5() {
  return integratedPlannerReadV5Schema.parse({
    ...readV4,
    schemaVersion: 5,
    unresolvedNutritionItems: [unresolvedItem()],
    nutritionOperationalStates: [operationalState()],
  });
}

describe('integrated planner V5 operational nutrition state', () => {
  it.each([
    { state: 'suspended', reason: 'race_disconnected' },
    { state: 'suspended', reason: 'source_unavailable' },
    { state: 'unresolved', reason: 'legacy_unpinned' },
    { state: 'unresolved', reason: 'timing_unresolved' },
  ])('preserves valid $state / $reason without an operational date', (status) => {
    const input = {
      ...readV5(),
      nutritionOperationalStates: [{ ...operationalState(), ...status }],
    };
    expect(integratedPlannerReadV5Schema.parse(input)).toEqual(input);
    expect(input.days.every((entry) => entry.nutritionItems.length === 0)).toBe(true);
    expect(Object.keys(input.nutritionOperationalStates[0] ?? {})).toEqual([
      'planVersionId',
      'itemId',
      'state',
      'reason',
    ]);
    expect(input.unresolvedNutritionItems).toEqual([unresolvedItem()]);
  });

  it.each([
    { state: 'suspended', reason: 'legacy_unpinned' },
    { state: 'suspended', reason: 'timing_unresolved' },
    { state: 'unresolved', reason: 'race_disconnected' },
    { state: 'unresolved', reason: 'source_unavailable' },
    { state: 'active', reason: 'timing_unresolved' },
    { state: 'suspended', reason: 'unknown' },
  ])('rejects invalid $state / $reason', (status) => {
    expect(
      integratedPlannerReadV5Schema.safeParse({
        ...readV5(),
        nutritionOperationalStates: [{ ...operationalState(), ...status }],
      }).success,
    ).toBe(false);
  });

  it.each(['date', 'localTime', 'scheduledAt', 'sourceRaceId', 'approvalAllowed'])(
    'rejects operational field %s rather than stripping or interpreting it',
    (field) => {
      expect(
        integratedPlannerReadV5Schema.safeParse({
          ...readV5(),
          nutritionOperationalStates: [{ ...operationalState(), [field]: '2026-10-07' }],
        }).success,
      ).toBe(false);
    },
  );

  it('requires both state and reason and rejects an unknown envelope field', () => {
    const { state, ...missingState } = operationalState();
    const { reason, ...missingReason } = operationalState();
    void state;
    void reason;
    for (const row of [missingState, missingReason]) {
      expect(
        integratedPlannerReadV5Schema.safeParse({ ...readV5(), nutritionOperationalStates: [row] })
          .success,
      ).toBe(false);
    }
    expect(integratedPlannerReadV5Schema.safeParse({ ...readV5(), approved: true }).success).toBe(
      false,
    );
    const { nutritionOperationalStates, ...missingStates } = readV5();
    void nutritionOperationalStates;
    expect(integratedPlannerReadV5Schema.safeParse(missingStates).success).toBe(false);
  });

  it.each([operationalState('missing-item'), operationalState('item-1', otherPlanVersionId)])(
    'requires the exact unresolved plan/item tuple',
    (status) => {
      const result = integratedPlannerReadV5Schema.safeParse({
        ...readV5(),
        nutritionOperationalStates: [status],
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(
          result.error.issues.some(
            (issue) => issue.path.join('.') === 'nutritionOperationalStates.0',
          ),
        ).toBe(true);
    },
  );

  it.each([{ nutritionPlanVersionIds: [] }, { nutritionPlanVersionIds: [otherPlanVersionId] }])(
    'rejects an operational state outside the selected nutrition plan roster %j',
    ({ nutritionPlanVersionIds }) => {
      expect(
        integratedPlannerReadV5Schema.safeParse({
          ...readV5(),
          nutritionPlanVersionIds,
        }).success,
      ).toBe(false);
    },
  );

  it('accepts selected plan roster UUID case variants as the same logical identity', () => {
    const input = { ...readV5(), nutritionPlanVersionIds: [planVersionId.toUpperCase()] };
    expect(integratedPlannerReadV5Schema.parse(input)).toEqual(input);
  });

  it('accepts logical UUID case variants for membership without rewriting the wire value', () => {
    const input = {
      ...readV5(),
      nutritionOperationalStates: [operationalState('item-1', planVersionId.toUpperCase())],
    };
    expect(integratedPlannerReadV5Schema.parse(input)).toEqual(input);
  });

  it.each([operationalState(), operationalState('item-1', planVersionId.toUpperCase())])(
    'rejects duplicate logical plan/item state identities including UUID case variants',
    (duplicate) => {
      expect(
        integratedPlannerReadV5Schema.safeParse({
          ...readV5(),
          nutritionOperationalStates: [operationalState(), duplicate],
        }).success,
      ).toBe(false);
    },
  );

  it('keeps item ID case distinct and supports different plans with the same item ID', () => {
    const input = {
      ...readV5(),
      nutritionPlanVersionIds: [planVersionId, otherPlanVersionId],
      unresolvedNutritionItems: [
        unresolvedItem(),
        unresolvedItem('ITEM-1'),
        unresolvedItem('item-1', otherPlanVersionId),
      ],
      nutritionOperationalStates: [
        operationalState(),
        operationalState('ITEM-1'),
        operationalState('item-1', otherPlanVersionId),
      ],
    };
    expect(integratedPlannerReadV5Schema.parse(input)).toEqual(input);
  });

  it.each([planVersionId, planVersionId.toUpperCase()])(
    'rejects suspended items placed in any day, including UUID case variant %s',
    (versionId) => {
      const placed = {
        id: 'item-1',
        planVersionId: versionId,
        title: 'User meal',
        category: 'meal',
        source: 'user_confirmed',
        localTime: null,
      };
      expect(
        integratedPlannerReadV5Schema.safeParse({
          ...readV5(),
          days: [dayV4, { ...dayV4, date: '2026-10-08', nutritionItems: [placed] }],
        }).success,
      ).toBe(false);
    },
  );

  it('allows unrelated placed items and legacy unresolved items without operational states', () => {
    const input = {
      ...readV5(),
      days: [
        {
          ...dayV4,
          nutritionItems: [
            {
              id: 'other-item',
              planVersionId,
              title: 'Other meal',
              category: 'meal',
              source: 'user_confirmed',
              localTime: '12:00',
            },
          ],
        },
      ],
      unresolvedNutritionItems: [unresolvedItem(), unresolvedItem('legacy-item')],
    };
    expect(integratedPlannerReadV5Schema.parse(input)).toEqual(input);
    expect(
      integratedPlannerReadV5Schema.safeParse({ ...readV5(), nutritionOperationalStates: [] })
        .success,
    ).toBe(true);
  });

  it('accepts exactly 3000 states and rejects 3001 without inventing an item ID max200', () => {
    const ids = Array.from({ length: 3001 }, (_, index) => `item-${index}`);
    const input = {
      ...readV5(),
      unresolvedNutritionItems: ids.map((id) => unresolvedItem(id)),
      nutritionOperationalStates: ids.map((id) => operationalState(id)),
    };
    expect(integratedPlannerReadV5Schema.safeParse(input).success).toBe(false);
    expect(
      integratedPlannerReadV5Schema.safeParse({
        ...input,
        nutritionOperationalStates: input.nutritionOperationalStates.slice(0, 3000),
      }).success,
    ).toBe(true);
    const longId = 'item-'.repeat(50);
    expect(
      integratedPlannerReadV5Schema.safeParse({
        ...readV5(),
        unresolvedNutritionItems: [unresolvedItem(longId)],
        nutritionOperationalStates: [operationalState(longId)],
      }).success,
    ).toBe(true);
  });

  it('keeps original V1/V4 DTOs valid and rejects V5 fields in the old schemas', () => {
    expect(integratedPlannerReadSchema.parse(readV1)).toEqual(readV1);
    expect(integratedPlannerReadV4Schema.parse(readV4)).toEqual(readV4);
    expect(
      integratedPlannerReadSchema.safeParse({ ...readV1, nutritionOperationalStates: [] }).success,
    ).toBe(false);
    expect(
      integratedPlannerReadV4Schema.safeParse({ ...readV4, nutritionOperationalStates: [] })
        .success,
    ).toBe(false);
    expect(integratedPlannerReadV4Schema.safeParse(readV5()).success).toBe(false);
    expect(integratedPlannerReadV5Schema.safeParse(readV4).success).toBe(false);
  });
});
