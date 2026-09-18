import { describe, expect, it } from 'vitest';

import {
  activeIntakeEntrySchema,
  correctIntakeEntryRequestSchema,
  createIntakeEntryRequestSchema,
  deleteIntakeEntryRequestSchema,
  deletedIntakeEntrySchema,
  foodDefinitionVersionSchema,
  intakeEntriesQuerySchema,
  nutrientValueCoverage,
  nutritionPlanReadSchema,
  nutritionPlanVersionSchema,
  nutritionPlansQuerySchema,
  recordedFoodPortionSchema,
  saveFoodDefinitionVersionRequestSchema,
  saveNutritionPlanVersionRequestSchema,
} from '../src/nutrition-core.js';

const start = '2026-09-18T09:00:00+09:00';
const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const planVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const otherPlanVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const foodVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
const trainingVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
const activityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7';
const intakeRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8';
const deletedRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
const later = '2026-09-18T09:15:00+09:00';
const datum = <U extends string>(unit: U, value: number | null) => ({
  value,
  unit,
  status: value === null ? ('unknown' as const) : ('reported' as const),
  evidenceIds: [],
});
const unknownNutrients = {
  energy: datum('kcal', null),
  carbohydrate: datum('g', null),
  protein: datum('g', null),
  fat: datum('g', null),
  fluid: datum('mL', null),
  sodium: datum('mg', null),
};
const planItem = {
  id: 'item-1',
  category: 'before',
  title: 'Before the session',
  anchor: {
    kind: 'relative',
    entity: 'session',
    entityId: 'session-1',
    point: 'end',
    offsetMinutes: 30,
  },
  foods: [],
  targets: [
    {
      metric: 'fluid',
      amount: { min: 0, max: 500, unit: 'mL', basis: 'user_confirmed', evidenceIds: [] },
    },
  ],
  instructions: '',
  evidenceIds: [],
  source: 'user_confirmed',
};
const planContent = {
  period: { from: '2026-09-18', toInclusive: '2026-09-25' },
  timezone: 'Asia/Seoul',
  purpose: 'Training day meals',
  linkedTrainingPlanVersionId: trainingVersionId,
  items: [planItem],
};
const foodContent = {
  foodId: 'food-1',
  name: 'Example snack',
  basis: { kind: 'per_serving', serving: { quantity: 40, unit: 'g', label: 'one package' } },
  nutrients: { ...unknownNutrients, energy: datum('kcal', 0) },
  provenance: {
    kind: 'package_label',
    reference: 'label-photo-1',
    capturedAt: start,
    reviewState: 'unreviewed',
  },
};
const namedFood = {
  foodVersionId: null,
  description: 'A snack I ate',
  quantity: null,
  unit: 'unspecified',
  sourceBasis: 'unknown',
};
const intakeContent = {
  occurredAt: start,
  timezone: 'Asia/Seoul',
  foods: [namedFood],
  nutrientTotal: unknownNutrients,
  plannedItemId: null,
  relatedSessionIds: ['session-1'],
  relatedActivityIds: [activityId],
  source: 'user',
  sourceRecordId: null,
  notes: null,
};

describe('nutrition plan and food versions', () => {
  it('preserves an unresolved relative anchor and only the explicitly provided target', () => {
    const plan = {
      ...planContent,
      planId: planId,
      versionId: planVersionId,
      items: [{ ...planItem, planVersionId: planVersionId }],
      version: 1,
      previousVersionId: null,
      approvedAt: later,
      approvalId: approvalId,
    };
    expect(nutritionPlanVersionSchema.parse(plan)).toEqual(plan);
    expect(plan.items[0]?.targets).toHaveLength(1);
    expect(
      saveNutritionPlanVersionRequestSchema.safeParse({
        kind: 'create',
        idempotencyKey: 'plan-write-1',
        confirmed: true,
        draft: planContent,
      }).success,
    ).toBe(true);
    expect(
      saveNutritionPlanVersionRequestSchema.safeParse({
        kind: 'update',
        planId: planId,
        idempotencyKey: 'plan-write-2',
        confirmed: true,
        draft: planContent,
      }).success,
    ).toBe(false);
    expect(
      nutritionPlanReadSchema.safeParse({
        planId: planId,
        head: plan,
        history: [{ versionId: planVersionId, version: 1, approvedAt: later }],
      }).success,
    ).toBe(true);
    for (const source of ['reviewed_rule', 'draft_suggestion']) {
      expect(
        saveNutritionPlanVersionRequestSchema.safeParse({
          kind: 'create',
          idempotencyKey: 'plan-write-3',
          confirmed: true,
          draft: { ...planContent, items: [{ ...planItem, source }] },
        }).success,
      ).toBe(false);
    }
    expect(
      saveNutritionPlanVersionRequestSchema.safeParse({
        kind: 'create',
        idempotencyKey: 'plan-write-4',
        confirmed: true,
        draft: {
          ...planContent,
          items: [
            {
              ...planItem,
              targets: [
                {
                  metric: 'fluid',
                  amount: {
                    min: 0,
                    max: 500,
                    unit: 'mL',
                    basis: 'reviewed_rule',
                    evidenceIds: [],
                  },
                },
              ],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      nutritionPlanReadSchema.safeParse({
        planId: otherPlanVersionId,
        head: plan,
        history: [],
      }).success,
    ).toBe(false);
    expect(
      nutritionPlansQuerySchema.safeParse({
        from: '2026-09-25',
        toInclusive: '2026-09-18',
        limit: 10,
        cursor: null,
      }).success,
    ).toBe(false);
    expect(
      saveNutritionPlanVersionRequestSchema.safeParse({
        kind: 'create',
        idempotencyKey: 'plan-write-1',
        confirmed: false,
        draft: planContent,
      }).success,
    ).toBe(false);
    expect(
      saveNutritionPlanVersionRequestSchema.safeParse({
        kind: 'update',
        planId: planId,
        expectedHeadVersionId: planVersionId,
        idempotencyKey: 'plan-write-2',
        confirmed: true,
        draft: planContent,
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate IDs, incorrect version links, duplicate nutrients and invalid units', () => {
    const approved = {
      ...planContent,
      planId: planId,
      versionId: planVersionId,
      items: [{ ...planItem, planVersionId: planVersionId }],
      version: 1,
      previousVersionId: null,
      approvedAt: later,
      approvalId: approvalId,
    };
    for (const items of [
      [approved.items[0], approved.items[0]],
      [{ ...planItem, planVersionId: otherPlanVersionId }],
      [
        {
          ...planItem,
          planVersionId: planVersionId,
          targets: [planItem.targets[0], planItem.targets[0]],
        },
      ],
      [
        {
          ...planItem,
          planVersionId: planVersionId,
          targets: [
            {
              metric: 'fluid',
              amount: { min: 0, max: 500, unit: 'g', basis: 'user_confirmed', evidenceIds: [] },
            },
          ],
        },
      ],
    ]) {
      expect(nutritionPlanVersionSchema.safeParse({ ...approved, items }).success).toBe(false);
    }
    expect(
      nutritionPlanVersionSchema.safeParse({
        ...approved,
        period: { from: '2026-09-25', toInclusive: '2026-09-18' },
      }).success,
    ).toBe(false);
    expect(
      nutritionPlanVersionSchema.safeParse({ ...approved, version: 2, previousVersionId: null })
        .success,
    ).toBe(false);
  });

  it('freezes serving basis, ingredient values and label provenance with a version', () => {
    const food = {
      ...foodContent,
      versionId: foodVersionId,
      version: 1,
      previousVersionId: null,
      createdAt: later,
    };
    expect(foodDefinitionVersionSchema.parse(food)).toEqual(food);
    const manualFoodContent = {
      ...foodContent,
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: start,
        reviewState: 'unreviewed',
      },
    };
    expect(
      saveFoodDefinitionVersionRequestSchema.safeParse({
        idempotencyKey: 'food-write-1',
        expectedVersionId: null,
        confirmed: true,
        definition: manualFoodContent,
      }).success,
    ).toBe(true);
    for (const provenance of [
      foodContent.provenance,
      { ...manualFoodContent.provenance, kind: 'reviewed_catalog' },
      { ...manualFoodContent.provenance, reviewState: 'reviewed' },
    ]) {
      expect(
        saveFoodDefinitionVersionRequestSchema.safeParse({
          idempotencyKey: 'food-write-2',
          expectedVersionId: null,
          confirmed: true,
          definition: { ...foodContent, provenance },
        }).success,
      ).toBe(false);
    }
    expect(
      foodDefinitionVersionSchema.safeParse({ ...food, basis: { kind: 'per_serving' } }).success,
    ).toBe(false);
    expect(
      foodDefinitionVersionSchema.safeParse({
        ...food,
        nutrients: { ...food.nutrients, sodium: datum('g', 0) },
      }).success,
    ).toBe(false);
    expect(
      foodDefinitionVersionSchema.safeParse({
        ...food,
        provenance: { ...food.provenance, reference: null },
      }).success,
    ).toBe(false);
    expect(foodDefinitionVersionSchema.safeParse({ ...food, version: 2 }).success).toBe(false);
    expect(
      saveFoodDefinitionVersionRequestSchema.safeParse({
        idempotencyKey: 'food-write-1',
        expectedVersionId: null,
        confirmed: false,
        definition: manualFoodContent,
      }).success,
    ).toBe(false);
  });
});

describe('actual intake commands and reads', () => {
  it('rejects caller-provided food and intake IDs longer than the SQL text limit', () => {
    const overlongId = 'x'.repeat(129);
    const manualFoodContent = {
      ...foodContent,
      foodId: overlongId,
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: start,
        reviewState: 'unreviewed',
      },
    };
    expect(
      saveFoodDefinitionVersionRequestSchema.safeParse({
        idempotencyKey: 'food-write-3',
        expectedVersionId: null,
        confirmed: true,
        definition: manualFoodContent,
      }).success,
    ).toBe(false);
    expect(
      foodDefinitionVersionSchema.safeParse({
        ...manualFoodContent,
        versionId: foodVersionId,
        version: 1,
        previousVersionId: null,
        createdAt: later,
      }).success,
    ).toBe(false);
    expect(
      createIntakeEntryRequestSchema.safeParse({
        idempotencyKey: 'intake-create-2',
        intakeId: overlongId,
        confirmed: true,
        ...intakeContent,
      }).success,
    ).toBe(false);
    expect(
      correctIntakeEntryRequestSchema.safeParse({
        idempotencyKey: 'intake-correct-2',
        intakeId: overlongId,
        expectedRevision: 1,
        confirmed: true,
        ...intakeContent,
      }).success,
    ).toBe(false);
    expect(
      deleteIntakeEntryRequestSchema.safeParse({
        idempotencyKey: 'intake-delete-2',
        intakeId: overlongId,
        expectedRevision: 1,
        confirmed: true,
        reason: 'user_requested',
      }).success,
    ).toBe(false);
    expect(
      activeIntakeEntrySchema.safeParse({
        status: 'active',
        intakeId: overlongId,
        revisionId: 'revision-1',
        revision: 1,
        recordedAt: later,
        ...intakeContent,
        nutrientValueCoverage: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      deletedIntakeEntrySchema.safeParse({
        status: 'deleted',
        intakeId: overlongId,
        revisionId: 'revision-2',
        revision: 2,
        deletedAt: later,
        reason: 'user_requested',
      }).success,
    ).toBe(false);
  });

  it('accepts a confirmed name-only actual without inventing nutrients or a consumed amount', () => {
    const request = {
      idempotencyKey: 'intake-create-1',
      intakeId: 'intake-1',
      confirmed: true,
      ...intakeContent,
    };
    expect(createIntakeEntryRequestSchema.parse(request)).toEqual(request);
    expect(nutrientValueCoverage(unknownNutrients)).toBe('unknown');
    expect(nutrientValueCoverage({ ...unknownNutrients, energy: datum('kcal', 0) })).toBe(
      'partial',
    );
    expect(
      nutrientValueCoverage({
        energy: datum('kcal', 0),
        carbohydrate: datum('g', 0),
        protein: datum('g', 0),
        fat: datum('g', 0),
        fluid: datum('mL', 0),
        sodium: datum('mg', 0),
      }),
    ).toBe('all_values_present');
    expect(createIntakeEntryRequestSchema.safeParse({ ...request, confirmed: false }).success).toBe(
      false,
    );
    expect(
      createIntakeEntryRequestSchema.safeParse({ ...request, source: 'provider' }).success,
    ).toBe(false);
    expect(
      createIntakeEntryRequestSchema.safeParse({ ...request, sourceRecordId: 'unexpected' })
        .success,
    ).toBe(false);
  });

  it('allows frozen food conversion only with a matching quantity, unit and version', () => {
    const portion = {
      foodVersionId: foodVersionId,
      description: 'Example snack',
      quantity: 1,
      unit: 'serving',
      sourceBasis: 'per_serving',
    };
    expect(recordedFoodPortionSchema.safeParse(portion).success).toBe(true);
    for (const invalid of [
      { ...portion, unit: 'g' },
      { ...portion, quantity: null },
      { ...portion, foodVersionId: null },
      { ...portion, quantity: -1 },
      { ...portion, quantity: Infinity },
    ]) {
      expect(recordedFoodPortionSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('requires a current revision and explicit action for correction and deletion', () => {
    const correction = {
      idempotencyKey: 'intake-correct-1',
      intakeId: 'intake-1',
      expectedRevision: 1,
      confirmed: true,
      ...intakeContent,
      nutrientTotal: { ...unknownNutrients, energy: datum('kcal', 0) },
    };
    expect(correctIntakeEntryRequestSchema.safeParse(correction).success).toBe(true);
    expect(
      correctIntakeEntryRequestSchema.safeParse({ ...correction, expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      correctIntakeEntryRequestSchema.safeParse({
        ...correction,
        relatedActivityIds: [activityId, activityId],
      }).success,
    ).toBe(false);
    const deletion = {
      idempotencyKey: 'intake-delete-1',
      intakeId: 'intake-1',
      expectedRevision: 2,
      confirmed: true,
      reason: 'user_requested',
    };
    expect(deleteIntakeEntryRequestSchema.safeParse(deletion).success).toBe(true);
    expect(
      deleteIntakeEntryRequestSchema.safeParse({ ...deletion, reason: 'plan_changed' }).success,
    ).toBe(false);
  });

  it('validates read coverage against the snapshot and redacts deleted records', () => {
    const active = {
      status: 'active',
      intakeId: 'intake-1',
      revisionId: intakeRevisionId,
      revision: 1,
      recordedAt: later,
      ...intakeContent,
      nutrientValueCoverage: 'unknown',
    };
    expect(activeIntakeEntrySchema.safeParse(active).success).toBe(true);
    expect(
      activeIntakeEntrySchema.safeParse({ ...active, nutrientValueCoverage: 'all_values_present' })
        .success,
    ).toBe(false);
    const deleted = {
      status: 'deleted',
      intakeId: 'intake-1',
      revisionId: deletedRevisionId,
      revision: 2,
      deletedAt: later,
      reason: 'user_requested',
    };
    expect(deletedIntakeEntrySchema.safeParse(deleted).success).toBe(true);
    expect(deletedIntakeEntrySchema.safeParse({ ...deleted, foods: [namedFood] }).success).toBe(
      false,
    );
    expect(
      intakeEntriesQuerySchema.safeParse({
        from: start,
        toExclusive: later,
        limit: 20,
        cursor: null,
      }).success,
    ).toBe(true);
    expect(
      intakeEntriesQuerySchema.safeParse({
        from: later,
        toExclusive: start,
        limit: 20,
        cursor: null,
      }).success,
    ).toBe(false);
  });
});
