import { describe, expect, it } from 'vitest';
import {
  dayInTimezone,
  dayIntakes,
  frozenFoodNutrients,
  intakeUtcWindow,
  knownSubtotal,
  nutrientInputs,
  parseNutrientInputs,
  unknownNutrients,
} from '../src/nutrition-model';
import type { ActiveIntakeEntry, FoodDefinitionVersion } from '@workout/contracts/nutrition-core';

const food: FoodDefinitionVersion = {
  foodId: 'food-1',
  versionId: '8f7e3f5e-5334-432b-9a6b-d0567ea23fc9',
  version: 1,
  previousVersionId: null,
  createdAt: '2026-09-17T00:00:00Z',
  name: 'Sample',
  basis: { kind: 'per_100g' },
  nutrients: {
    ...unknownNutrients(),
    energy: { value: 240, unit: 'kcal', status: 'reported', evidenceIds: [] },
    carbohydrate: { value: 0, unit: 'g', status: 'reported', evidenceIds: [] },
  },
  provenance: {
    kind: 'user_entered',
    reference: null,
    capturedAt: '2026-09-17T00:00:00Z',
    reviewState: 'unreviewed',
  },
};

function entry(id: string, occurredAt: string, energy: number | null): ActiveIntakeEntry {
  return {
    status: 'active',
    intakeId: id,
    revisionId: `revision-${id}`,
    revision: 1,
    occurredAt,
    recordedAt: '2026-09-19T00:00:00Z',
    timezone: 'Asia/Seoul',
    foods: [
      {
        description: 'Snack',
        foodVersionId: null,
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'unknown',
      },
    ],
    nutrientTotal: {
      ...unknownNutrients(),
      energy:
        energy === null
          ? { value: null, unit: 'kcal', status: 'unknown', evidenceIds: [] }
          : { value: energy, unit: 'kcal', status: 'reported', evidenceIds: [] },
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
    nutrientValueCoverage: energy === null ? 'unknown' : 'partial',
  };
}

describe('nutrition values and local day', () => {
  it('preserves unknown and explicit zero and applies a frozen per-100 basis only once', () => {
    const calculated = frozenFoodNutrients(food, 50, 'g');
    expect(calculated?.energy.value).toBe(120);
    expect(calculated?.carbohydrate.value).toBe(0);
    expect(calculated?.protein.value).toBeNull();
    expect(frozenFoodNutrients(food, 50, 'mL')).toBeNull();
    expect(
      parseNutrientInputs({ ...nutrientInputs(unknownNutrients()), energy: '0' })?.energy,
    ).toMatchObject({ value: 0, status: 'reported' });
    expect(
      parseNutrientInputs({ ...nutrientInputs(unknownNutrients()), energy: '' })?.energy,
    ).toMatchObject({ value: null, status: 'unknown' });
  });

  it('includes midnight through end of local day across positive and negative UTC offsets', () => {
    const window = intakeUtcWindow('2026-09-18');
    const positiveStart = '2026-09-17T15:00:00.000Z';
    const positiveEnd = '2026-09-18T14:59:59.000Z';
    const negativeStart = '2026-09-18T12:00:00.000Z';
    const negativeEnd = '2026-09-19T11:59:59.000Z';
    for (const instant of [positiveStart, positiveEnd, negativeStart, negativeEnd]) {
      expect(Date.parse(instant)).toBeGreaterThanOrEqual(Date.parse(window.from));
      expect(Date.parse(instant)).toBeLessThan(Date.parse(window.toExclusive));
    }
    expect(dayInTimezone(positiveStart, 'Asia/Seoul')).toBe('2026-09-18');
    expect(dayInTimezone(positiveEnd, 'Asia/Seoul')).toBe('2026-09-18');
    expect(dayInTimezone(negativeStart, 'Etc/GMT+12')).toBe('2026-09-18');
    expect(dayInTimezone(negativeEnd, 'Etc/GMT+12')).toBe('2026-09-18');
  });

  it('counts one IntakeEntry once even when referenced by several sessions, and never presents unknown as zero', () => {
    const one = {
      ...entry('intake-one', '2026-09-17T15:00:00Z', 0),
      relatedSessionIds: ['session-a', 'session-b'],
    };
    const two = entry('intake-two', '2026-09-18T02:00:00Z', null);
    const outside = entry('intake-three', '2026-09-18T15:00:00Z', 400);
    const selected = dayIntakes([one, one, two, outside], '2026-09-18', 'Asia/Seoul');
    expect(selected.map((item) => item.intakeId)).toEqual(['intake-one', 'intake-two']);
    expect(knownSubtotal(selected, 'energy')).toEqual({ known: 0, knownCount: 1, missing: 1 });
    expect(knownSubtotal([two], 'energy')).toEqual({ known: 0, knownCount: 0, missing: 1 });
  });
});
