import { z } from 'zod';
import {
  nutritionPlanPublicPreviewV4RequestSchema,
  nutritionPlanPublicPreviewV4Schema,
  nutritionPlanPublicSafeV4Schema,
  type NutritionPlanPublicPreviewV4,
} from '@workout/contracts/nutrition-race-plan-public-v4';
import { planDraftSchema } from '@workout/contracts/planning';
import type { Database, Transaction } from './database.js';
import { requireAppAdmission } from './app-admission.js';
import { NutritionReferenceError } from './nutrition-core.js';
import { PersistenceConflict } from './outbox.js';
import { RaceTimingBindingError } from './race-timing-bindings.js';
import {
  assertNutritionV4PlainInput,
  captureNutritionV4CalculationIn,
  NutritionRacePlanV4WriterError,
} from './nutrition-race-plan-v4-writer.js';
import {
  createApprovedNutritionTimingProjectorV4,
  createTransientNutritionTimingProjectorV4,
} from './nutrition-frozen-timing-projection.js';

export class NutritionRacePlanV4PreviewError extends Error {
  constructor(
    readonly code: 'NUTRITION_V4_PREVIEW_INVALID_INPUT' | 'NUTRITION_V4_PREVIEW_SNAPSHOT_REQUIRED',
  ) {
    super(code);
  }
}
const boundary = {
  schemaVersion: 4 as const,
  persistence: 'not_stored' as const,
  freshness: 'not_checked' as const,
  approvalAllowed: false as const,
};
type Block = NutritionPlanPublicPreviewV4['blocks'][number]['code'];
function unavailable(code: Block): NutritionPlanPublicPreviewV4 {
  return nutritionPlanPublicPreviewV4Schema.parse({
    ...boundary,
    status: 'unavailable',
    blocks: [{ itemId: null, code }],
  });
}
/** These are ordinary source/CAS diagnostics. Admission/tenant failures and
 * unexpected SQL/codec failures propagate; no source is invented to project. */
function sourceBlock(error: unknown): Block | null {
  if (error instanceof PersistenceConflict) return 'PRIOR_HEAD_STALE';
  if (error instanceof NutritionReferenceError) {
    if (error.code === 'PLAN_NOT_FOUND') return 'PRIOR_UNAVAILABLE';
    if (error.code === 'FOOD_LINK_INVALID') return 'FOOD_REFERENCE_INVALID';
    if (error.code === 'PLAN_LINK_INVALID' || error.code === 'SESSION_LINK_INVALID')
      return 'TRAINING_REFERENCE_INVALID';
  }
  if (error instanceof RaceTimingBindingError) {
    if (error.code === 'RACE_TIMING_UNAVAILABLE') return 'RACE_UNAVAILABLE';
    if (error.code === 'RACE_TIMING_STALE') return 'RACE_STALE';
    if (error.code === 'RACE_TIMING_LIMIT') return 'LIMIT';
  }
  if (error instanceof NutritionRacePlanV4WriterError) {
    const codes = {
      NUTRITION_V4_ORIGIN_REQUIRED: 'ORIGIN_REQUIRED',
      NUTRITION_V4_RECONNECT_REQUIRED: 'RECONNECT_REQUIRED',
      NUTRITION_V4_RECONNECT_INVALID: 'RECONNECT_INVALID',
      NUTRITION_V4_TIMING_UNRESOLVED: 'TIMING_UNRESOLVED',
      NUTRITION_V4_LIMIT: 'LIMIT',
    } as const;
    if (error.code !== 'NUTRITION_V4_SOURCE_INVALID') return codes[error.code];
  }
  return null;
}
function safePlan(
  plan:
    | Awaited<ReturnType<typeof captureNutritionV4CalculationIn>>['prior']
    | Awaited<ReturnType<typeof captureNutritionV4CalculationIn>>['input']['draft'],
) {
  return nutritionPlanPublicSafeV4Schema.parse({
    period: plan.period,
    timezone: plan.timezone,
    purpose: plan.purpose,
    linkedTrainingPlanVersionId: plan.linkedTrainingPlanVersionId,
    items: plan.items.map(({ id, category, title, anchor, foods, targets, instructions }) => ({
      id,
      category,
      title,
      anchor,
      foods,
      targets: targets.map(({ metric, amount }) => ({
        metric,
        amount: { min: amount.min, max: amount.max, unit: amount.unit, basis: amount.basis },
      })),
      instructions,
    })),
  });
}
async function beforeTraining(
  tx: Transaction,
  capture: Awaited<ReturnType<typeof captureNutritionV4CalculationIn>>,
) {
  const id = capture.prior.linkedTrainingPlanVersionId;
  if (id === null) return null;
  if (id === capture.input.draft.linkedTrainingPlanVersionId && capture.sources.training !== null)
    return { versionId: id, draft: capture.sources.training };
  const totals = await tx.query(
    'SELECT octet_length(draft::text)::text AS bytes FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
    [tx.athleteId, id],
  );
  if (totals.rows.length !== 1) throw new NutritionReferenceError('PLAN_LINK_INVALID');
  const count = z.strictObject({ bytes: z.string().regex(/^\d+$/) }).parse(totals.rows[0]);
  if (BigInt(count.bytes) + BigInt(capture.sources.size) > 4194304n)
    throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  const found = await tx.query('SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
    tx.athleteId,
    id,
  ]);
  if (found.rows.length !== 1) throw new NutritionReferenceError('PLAN_LINK_INVALID');
  return { versionId: id, draft: planDraftSchema.parse(found.rows[0]?.['draft']) };
}
/** Internal same-transaction port: caller owns authenticated snapshot fences.
 * This function captures and calculates; it invokes no save/receipt/ID/clock. */
export async function previewNutritionPlanV4In(
  tx: Transaction,
  unknownInput: unknown,
): Promise<NutritionPlanPublicPreviewV4> {
  assertNutritionV4PlainInput(unknownInput);
  const object = z
    .strictObject({
      planId: z.uuid(),
      schemaVersion: z.literal(4),
      expectedHeadVersionId: z.uuid(),
      draft: z.unknown(),
      expectedRaceHeads: z.unknown(),
      reconnectItemIds: z.unknown(),
    })
    .safeParse(unknownInput);
  if (!object.success)
    throw new NutritionRacePlanV4PreviewError('NUTRITION_V4_PREVIEW_INVALID_INPUT');
  const { planId, ...body } = object.data;
  const request = nutritionPlanPublicPreviewV4RequestSchema.safeParse(body);
  if (!request.success)
    throw new NutritionRacePlanV4PreviewError('NUTRITION_V4_PREVIEW_INVALID_INPUT');
  await requireAppAdmission(tx);
  try {
    const { schemaVersion: _version, ...input } = request.data;
    void _version;
    const capture = await captureNutritionV4CalculationIn(
      tx,
      { planId, ...input },
      'diagnostic_only',
    );
    const before = createApprovedNutritionTimingProjectorV4({
      record: capture.prior,
      targetTimezone: capture.prior.timezone,
      linkedTraining: await beforeTraining(tx, capture),
    });
    const after = createTransientNutritionTimingProjectorV4({
      draft: capture.input.draft,
      ...capture.timing,
      targetTimezone: capture.input.draft.timezone,
      linkedTraining:
        capture.sources.training === null
          ? null
          : {
              versionId: capture.input.draft.linkedTrainingPlanVersionId,
              draft: capture.sources.training,
            },
    });
    const oldIds = new Set(capture.prior.items.map((item) => item.id)),
      newIds = new Set(capture.input.draft.items.map((item) => item.id)),
      affected = new Set(capture.affected);
    const ids = [...oldIds, ...[...newIds].filter((id) => !oldIds.has(id))];
    if (ids.length > 5000) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
    const items = ids.map((itemId) => ({
      itemId,
      change: !oldIds.has(itemId)
        ? ('new' as const)
        : !newIds.has(itemId)
          ? ('removed' as const)
          : affected.has(itemId)
            ? ('affected' as const)
            : ('preserved' as const),
      before: oldIds.has(itemId)
        ? before.project({ itemId, raceSourceVisibility: 'available' })
        : null,
      after: newIds.has(itemId)
        ? after.project({ itemId, raceSourceVisibility: 'available' })
        : null,
    }));
    const blocks = items.flatMap((item) =>
      (item.change === 'affected' || item.change === 'new') && item.after?.state === 'unresolved'
        ? [{ itemId: item.itemId, code: 'TIMING_UNRESOLVED' as const }]
        : [],
    );
    const notices = items.flatMap((item) =>
      item.change === 'preserved' && item.after?.state === 'unresolved'
        ? [
            {
              itemId: item.itemId,
              code:
                item.after.detail === 'legacy_unpinned'
                  ? ('LEGACY_UNPINNED_PRESERVED' as const)
                  : ('UNRESOLVED_PRESERVED' as const),
            },
          ]
        : [],
    );
    const result = {
      ...boundary,
      status: blocks.length ? 'blocked' : 'projected',
      expectedPlan: {
        planId: capture.prior.planId,
        versionId: capture.prior.versionId,
        version: capture.prior.version,
      },
      expectedRaceHeads: request.data.expectedRaceHeads,
      before: safePlan(capture.prior),
      after: safePlan(capture.input.draft),
      items,
      notices,
      blocks,
    };
    assertNutritionV4PlainInput(result, 4194304);
    return nutritionPlanPublicPreviewV4Schema.parse(result);
  } catch (error) {
    const code = sourceBlock(error);
    if (code !== null) return unavailable(code);
    throw error;
  }
}
export function createNutritionRacePlanV4PreviewRepository(database: Database) {
  return {
    previewPlanV4(athleteId: string, unknownInput: unknown): Promise<NutritionPlanPublicPreviewV4> {
      if (!database.snapshotTenant)
        throw new NutritionRacePlanV4PreviewError('NUTRITION_V4_PREVIEW_SNAPSHOT_REQUIRED');
      return database.snapshotTenant(athleteId, (tx) => previewNutritionPlanV4In(tx, unknownInput));
    },
  };
}
