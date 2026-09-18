import { z } from 'zod';

import {
  foodPortionSchema,
  intakeCoverageSchema,
  intakeEntryRevisionSchema,
  nutrientSnapshotSchema,
  nutritionPlanItemSchema,
} from './nutrition.js';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  timeZoneSchema,
  uniqueIdsSchema,
} from './primitives.js';

const shortTextSchema = nonEmptyStringSchema.max(160);
const noteSchema = z.string().max(2_000);
const boundedIdSchema = idSchema.max(128);
const uuidSchema = z.uuid().transform((id) => id.toLowerCase());
const uniqueUuidArraySchema = z
  .array(uuidSchema)
  .max(40)
  .refine((ids) => new Set(ids).size === ids.length);
const idempotencyKeySchema = boundedIdSchema.min(8).regex(/^[a-zA-Z0-9_-]+$/);
const nutrientMetricSchema = z.enum([
  'energy',
  'carbohydrate',
  'protein',
  'fat',
  'fluid',
  'sodium',
]);
const nutrientMetrics = nutrientMetricSchema.options;

/** A quantity's conversion basis is frozen with the portion, not looked up from a mutable food row. */
export const recordedFoodPortionSchema = foodPortionSchema
  .safeExtend({
    description: shortTextSchema,
    foodVersionId: uuidSchema.nullable(),
  })
  .superRefine((portion, context) => {
    const requiredUnit =
      portion.sourceBasis === 'per_100g'
        ? 'g'
        : portion.sourceBasis === 'per_100mL'
          ? 'mL'
          : portion.sourceBasis === 'per_serving'
            ? 'serving'
            : null;
    if (requiredUnit !== null) {
      if (portion.unit !== requiredUnit || portion.quantity === null) {
        context.addIssue({
          code: 'custom',
          message: 'Quantity and unit must match the frozen nutrient basis',
          path: ['quantity'],
        });
      }
      if (portion.foodVersionId === null) {
        context.addIssue({
          code: 'custom',
          message: 'Calculated portions require a food definition version',
          path: ['foodVersionId'],
        });
      }
    }
    if (portion.quantity !== null && portion.unit === 'unspecified') {
      context.addIssue({
        code: 'custom',
        message: 'A known quantity requires a unit',
        path: ['unit'],
      });
    }
  });
export type RecordedFoodPortion = z.infer<typeof recordedFoodPortionSchema>;

const planItemFields = {
  ...nutritionPlanItemSchema.shape,
  planVersionId: uuidSchema,
  title: shortTextSchema,
  instructions: noteSchema,
  foods: z.array(recordedFoodPortionSchema).max(40),
  targets: nutritionPlanItemSchema.shape.targets.max(6),
  evidenceIds: uniqueIdsSchema.max(40),
  source: z.enum(['user_confirmed', 'reviewed_rule', 'draft_suggestion']),
};
function validatePlanItem(
  item: { targets: { metric: string }[]; foods: RecordedFoodPortion[]; instructions: string },
  context: z.RefinementCtx,
) {
  if (new Set(item.targets.map((target) => target.metric)).size !== item.targets.length) {
    context.addIssue({
      code: 'custom',
      message: 'A nutrient target may occur only once per item',
      path: ['targets'],
    });
  }
  if (item.foods.length === 0 && item.targets.length === 0 && item.instructions.trim() === '') {
    context.addIssue({
      code: 'custom',
      message: 'A plan item needs food, a target, or an explicit action',
      path: ['instructions'],
    });
  }
}
export const nutritionPlanItemCoreSchema = z
  .strictObject(planItemFields)
  .superRefine(validatePlanItem);
export type NutritionPlanItemCore = z.infer<typeof nutritionPlanItemCoreSchema>;

const { planVersionId: omittedPlanVersionId, ...planItemDraftFields } = planItemFields;
void omittedPlanVersionId;
export const nutritionPlanItemDraftSchema = z
  .strictObject({ ...planItemDraftFields, source: z.literal('user_confirmed') })
  .superRefine((item, context) => {
    validatePlanItem(item, context);
    for (const [index, target] of item.targets.entries()) {
      if (target.amount.basis !== 'user_confirmed') {
        context.addIssue({
          code: 'custom',
          message: 'Manual plan targets must have user-confirmed provenance',
          path: ['targets', index, 'amount', 'basis'],
        });
      }
    }
  });
export type NutritionPlanItemDraft = z.infer<typeof nutritionPlanItemDraftSchema>;

const planPeriodSchema = z
  .strictObject({ from: localDateSchema, toInclusive: localDateSchema })
  .refine((period) => period.from <= period.toInclusive, {
    message: 'Plan period must be ordered',
    path: ['toInclusive'],
  })
  .refine(
    (period) =>
      (Date.parse(`${period.toInclusive}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) /
        86_400_000 <=
      3_660,
    {
      message: 'Plan period exceeds ten years',
      path: ['toInclusive'],
    },
  );
const planSharedFields = {
  period: planPeriodSchema,
  timezone: timeZoneSchema,
  purpose: shortTextSchema,
  linkedTrainingPlanVersionId: uuidSchema.nullable(),
};
function validateUniqueItems(items: { id: string }[], context: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate item ID',
        path: ['items', index, 'id'],
      });
    }
    seen.add(item.id);
  }
}
function validatePlanSize(plan: unknown, context: z.RefinementCtx) {
  if (new TextEncoder().encode(JSON.stringify(plan)).length > 512 * 1024) {
    context.addIssue({ code: 'custom', message: 'Plan exceeds 512 KiB' });
  }
}

export const nutritionPlanDraftSchema = z
  .strictObject({
    ...planSharedFields,
    items: z.array(nutritionPlanItemDraftSchema).max(5_000),
  })
  .superRefine((draft, context) => {
    validateUniqueItems(draft.items, context);
    validatePlanSize(draft, context);
  });
export type NutritionPlanDraft = z.infer<typeof nutritionPlanDraftSchema>;

/** The approved schedule is immutable. Absence from targets means unknown, never a target of zero. */
export const nutritionPlanVersionSchema = z
  .strictObject({
    ...planSharedFields,
    planId: uuidSchema,
    versionId: uuidSchema,
    items: z.array(nutritionPlanItemCoreSchema).max(5_000),
    version: positiveIntegerSchema,
    previousVersionId: uuidSchema.nullable(),
    approvedAt: instantSchema,
    approvalId: uuidSchema,
  })
  .superRefine((plan, context) => {
    validateUniqueItems(plan.items, context);
    validatePlanSize(plan, context);
    if (plan.planId === plan.versionId || plan.previousVersionId === plan.versionId) {
      context.addIssue({
        code: 'custom',
        message: 'Aggregate and predecessor IDs must differ from the version ID',
        path: ['versionId'],
      });
    }
    if ((plan.version === 1) !== (plan.previousVersionId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only the first version may lack a predecessor',
        path: ['previousVersionId'],
      });
    }
    for (const [index, item] of plan.items.entries()) {
      if (item.planVersionId !== plan.versionId) {
        context.addIssue({
          code: 'custom',
          message: 'Item must refer to its containing plan version',
          path: ['items', index, 'planVersionId'],
        });
      }
    }
  });
export type NutritionPlanVersion = z.infer<typeof nutritionPlanVersionSchema>;

/** The server assigns plan/version IDs and approval metadata after checking the expected head. */
export const saveNutritionPlanVersionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    idempotencyKey: idempotencyKeySchema,
    confirmed: z.literal(true),
    draft: nutritionPlanDraftSchema,
  }),
  z.strictObject({
    kind: z.literal('update'),
    planId: uuidSchema,
    expectedHeadVersionId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
    confirmed: z.literal(true),
    draft: nutritionPlanDraftSchema,
  }),
]);
export type SaveNutritionPlanVersionRequest = z.infer<typeof saveNutritionPlanVersionRequestSchema>;

export const nutritionPlanReadSchema = z
  .strictObject({
    planId: uuidSchema,
    head: nutritionPlanVersionSchema.nullable(),
    history: z
      .array(
        z.strictObject({
          versionId: uuidSchema,
          version: positiveIntegerSchema,
          approvedAt: instantSchema,
        }),
      )
      .max(100),
  })
  .refine((read) => read.head === null || read.head.planId === read.planId, {
    message: 'Head must belong to the requested plan',
    path: ['head', 'planId'],
  });
export type NutritionPlanRead = z.infer<typeof nutritionPlanReadSchema>;

export const nutritionPlansQuerySchema = z
  .strictObject({
    from: localDateSchema,
    toInclusive: localDateSchema,
    limit: positiveIntegerSchema.max(100),
    cursor: z.string().max(512).nullable(),
  })
  .refine((query) => query.from <= query.toInclusive, {
    message: 'Plan window must be ordered',
    path: ['toInclusive'],
  });
export type NutritionPlansQuery = z.infer<typeof nutritionPlansQuerySchema>;
export const nutritionPlansResponseSchema = z.strictObject({
  plans: z.array(nutritionPlanVersionSchema).max(100),
  nextCursor: z.string().max(512).nullable(),
});
export type NutritionPlansResponse = z.infer<typeof nutritionPlansResponseSchema>;

const foodBasisSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('per_100g') }),
  z.strictObject({ kind: z.literal('per_100mL') }),
  z.strictObject({
    kind: z.literal('per_serving'),
    serving: z.strictObject({
      quantity: z.number().finite().positive(),
      unit: z.enum(['g', 'mL', 'piece']),
      label: shortTextSchema,
    }),
  }),
]);
export type FoodBasis = z.infer<typeof foodBasisSchema>;
const foodContentFields = {
  foodId: boundedIdSchema,
  name: shortTextSchema,
  basis: foodBasisSchema,
  nutrients: nutrientSnapshotSchema,
  provenance: z
    .strictObject({
      kind: z.enum(['user_entered', 'package_label', 'reviewed_catalog']),
      reference: shortTextSchema.nullable(),
      capturedAt: instantSchema,
      reviewState: z.enum(['unreviewed', 'reviewed', 'withdrawn']),
    })
    .refine((provenance) => provenance.kind === 'user_entered' || provenance.reference !== null, {
      message: 'External food values require a frozen source reference',
      path: ['reference'],
    }),
};

/** Values and basis are frozen per version; later catalog edits cannot recalculate old intakes. */
export const foodDefinitionVersionSchema = z
  .strictObject({
    ...foodContentFields,
    versionId: uuidSchema,
    version: positiveIntegerSchema,
    previousVersionId: uuidSchema.nullable(),
    createdAt: instantSchema,
  })
  .superRefine((food, context) => {
    if (food.foodId === food.versionId || food.previousVersionId === food.versionId) {
      context.addIssue({
        code: 'custom',
        message: 'Food and predecessor IDs must differ from the version ID',
        path: ['versionId'],
      });
    }
    if ((food.version === 1) !== (food.previousVersionId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only the first version may lack a predecessor',
        path: ['previousVersionId'],
      });
    }
  });
export type FoodDefinitionVersion = z.infer<typeof foodDefinitionVersionSchema>;
export const saveFoodDefinitionVersionRequestSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  expectedVersionId: uuidSchema.nullable(),
  confirmed: z.literal(true),
  definition: z.strictObject({
    ...foodContentFields,
    provenance: z.strictObject({
      kind: z.literal('user_entered'),
      reference: z.null(),
      capturedAt: instantSchema,
      reviewState: z.literal('unreviewed'),
    }),
  }),
});
export type SaveFoodDefinitionVersionRequest = z.infer<
  typeof saveFoodDefinitionVersionRequestSchema
>;

const intakeFields = {
  occurredAt: instantSchema,
  timezone: timeZoneSchema,
  foods: z.array(recordedFoodPortionSchema).min(1).max(40),
  nutrientTotal: nutrientSnapshotSchema,
  plannedItemId: idSchema.nullable(),
  relatedSessionIds: uniqueIdsSchema.max(40),
  relatedActivityIds: uniqueUuidArraySchema,
  source: z.enum(['user', 'user_confirmed_extraction']),
  sourceRecordId: shortTextSchema.nullable(),
  notes: noteSchema.nullable(),
};
function validateManualSource(
  input: { source: 'user' | 'user_confirmed_extraction'; sourceRecordId: string | null },
  context: z.RefinementCtx,
) {
  if ((input.source === 'user') !== (input.sourceRecordId === null)) {
    context.addIssue({
      code: 'custom',
      message: 'Extraction needs a source record; manual entry has none',
      path: ['sourceRecordId'],
    });
  }
}

/** Only an explicit user action creates an actual. A plan or UI draft cannot use this DTO. */
export const createIntakeEntryRequestSchema = z
  .strictObject({
    idempotencyKey: idempotencyKeySchema,
    intakeId: boundedIdSchema,
    confirmed: z.literal(true),
    ...intakeFields,
  })
  .superRefine(validateManualSource);
export type CreateIntakeEntryRequest = z.infer<typeof createIntakeEntryRequestSchema>;

export const correctIntakeEntryRequestSchema = z
  .strictObject({
    idempotencyKey: idempotencyKeySchema,
    intakeId: boundedIdSchema,
    expectedRevision: positiveIntegerSchema,
    confirmed: z.literal(true),
    ...intakeFields,
  })
  .superRefine(validateManualSource);
export type CorrectIntakeEntryRequest = z.infer<typeof correctIntakeEntryRequestSchema>;

export const deleteIntakeEntryRequestSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  intakeId: boundedIdSchema,
  expectedRevision: positiveIntegerSchema,
  confirmed: z.literal(true),
  reason: z.literal('user_requested'),
});
export type DeleteIntakeEntryRequest = z.infer<typeof deleteIntakeEntryRequestSchema>;

/** Coverage describes known nutrient values, not whether the person ate every meal. */
export const nutrientValueCoverageSchema = z.enum(['unknown', 'partial', 'all_values_present']);
export type NutrientValueCoverage = z.infer<typeof nutrientValueCoverageSchema>;
export function nutrientValueCoverage(
  snapshot: z.infer<typeof nutrientSnapshotSchema>,
): NutrientValueCoverage {
  const known = nutrientMetrics.filter((metric) => snapshot[metric].value !== null).length;
  return known === 0
    ? 'unknown'
    : known === nutrientMetrics.length
      ? 'all_values_present'
      : 'partial';
}

export const activeIntakeEntrySchema = intakeEntryRevisionSchema
  .safeExtend({
    status: z.literal('active'),
    intakeId: boundedIdSchema,
    revisionId: uuidSchema,
    revision: positiveIntegerSchema,
    foods: z.array(recordedFoodPortionSchema).min(1).max(40),
    relatedSessionIds: uniqueIdsSchema.max(40),
    relatedActivityIds: uniqueUuidArraySchema,
    nutrientValueCoverage: nutrientValueCoverageSchema,
  })
  .refine((entry) => entry.nutrientValueCoverage === nutrientValueCoverage(entry.nutrientTotal), {
    message: 'Nutrient value coverage must match the frozen snapshot',
    path: ['nutrientValueCoverage'],
  });
export type ActiveIntakeEntry = z.infer<typeof activeIntakeEntrySchema>;

/** The read tombstone deliberately excludes health payload after deletion. */
export const deletedIntakeEntrySchema = z.strictObject({
  status: z.literal('deleted'),
  intakeId: boundedIdSchema,
  revisionId: uuidSchema,
  revision: positiveIntegerSchema,
  deletedAt: instantSchema,
  reason: z.literal('user_requested'),
});
export type DeletedIntakeEntry = z.infer<typeof deletedIntakeEntrySchema>;
export const intakeEntryRecordSchema = z.discriminatedUnion('status', [
  activeIntakeEntrySchema,
  deletedIntakeEntrySchema,
]);
export type IntakeEntryRecord = z.infer<typeof intakeEntryRecordSchema>;

export const intakeEntriesQuerySchema = z
  .strictObject({
    from: instantSchema,
    toExclusive: instantSchema,
    limit: positiveIntegerSchema.max(100),
    cursor: z.string().max(512).nullable(),
  })
  .refine((query) => Date.parse(query.from) < Date.parse(query.toExclusive), {
    message: 'Intake window must be ordered',
    path: ['toExclusive'],
  });
export type IntakeEntriesQuery = z.infer<typeof intakeEntriesQuerySchema>;
export const intakeEntriesResponseSchema = z.strictObject({
  entries: z.array(intakeEntryRecordSchema).max(100),
  coverage: intakeCoverageSchema,
  nextCursor: z.string().max(512).nullable(),
});
export type IntakeEntriesResponse = z.infer<typeof intakeEntriesResponseSchema>;
