import { z } from 'zod';
import { nutritionPlanItemCoreSchema, nutritionPlanDraftSchema } from './nutrition-core.js';
import { nutritionPlanDraftV3Schema } from './nutrition-race-plan-v3.js';
import { nutritionPlanVersionCompatibleV4Schema } from './nutrition-race-plan-v4.js';
import {
  expectedRaceHeadsSchema,
  raceHeadExpectationRosterSchema,
} from './nutrition-race-timing.js';
import { raceManualPublicImpactNutritionItemSchema } from './race-manual-public-impact.js';
import { instantSchema, localDateSchema, localTimeSchema, timeZoneSchema } from './primitives.js';

const uuid = z.uuid().refine((id) => id === id.toLowerCase());
const itemId = nutritionPlanItemCoreSchema.shape.id;
/** Unknown ingress is checked before schema parsing/stringification. These limits
 * constrain transport only, never source ownership or approval authority. */
function plain(maximumBytes: number) {
  return z.unknown().superRefine((raw, context) => {
    let visits = 0,
      bytes = 0;
    const ancestors = new Set<object>();
    function charge(value: string) {
      if (value.length > maximumBytes - bytes) throw Error('limit');
      bytes += new TextEncoder().encode(value).byteLength;
      if (bytes > maximumBytes) throw Error('limit');
    }
    function visit(value: unknown, depth: number): void {
      if (++visits > 5000 || depth > 64) throw Error('limit');
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'string') return charge(value);
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (typeof value !== 'object' || ancestors.has(value)) throw Error('plain');
      const array = Array.isArray(value);
      if (
        array
          ? Object.getPrototypeOf(value) !== Array.prototype
          : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      )
        throw Error('plain');
      const keys = Reflect.ownKeys(value);
      if (keys.length > 5001) throw Error('limit');
      ancestors.add(value);
      let count = 0;
      for (const key of keys) {
        if (typeof key !== 'string') throw Error('plain');
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) throw Error('plain');
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
          throw Error('dense');
        charge(key);
        count++;
        visit(descriptor.value, depth + 1);
      }
      if (array && count !== value.length) throw Error('dense');
      ancestors.delete(value);
    }
    try {
      visit(raw, 0);
      if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > maximumBytes)
        throw Error('limit');
    } catch {
      context.addIssue({ code: 'custom', message: 'Bounded plain nutrition transport required' });
    }
  });
}
const fields = {
  expectedHeadVersionId: uuid,
  draft: nutritionPlanDraftV3Schema,
  expectedRaceHeads: expectedRaceHeadsSchema,
  reconnectItemIds: z.array(itemId).max(5000),
};
function roster(value: z.infer<typeof previewBody>, context: z.RefinementCtx) {
  const items = new Map(value.draft.items.map((item) => [item.id, item]));
  for (const [index, id] of value.reconnectItemIds.entries()) {
    const item = items.get(id),
      previous = value.reconnectItemIds[index - 1];
    if (
      (previous !== undefined && previous >= id) ||
      !item ||
      item.anchor.kind !== 'relative' ||
      item.anchor.entity !== 'race'
    )
      context.addIssue({
        code: 'custom',
        path: ['reconnectItemIds', index],
        message: 'Exact sorted reconnect race item roster required',
      });
  }
  const match = raceHeadExpectationRosterSchema.safeParse({
    items: value.draft.items.flatMap((item) =>
      item.anchor.kind === 'disconnected' ? [] : [{ itemId: item.id, anchor: item.anchor }],
    ),
    expectedRaceHeads: value.expectedRaceHeads,
  });
  if (!match.success)
    for (const issue of match.error.issues)
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
}
const previewBody = z.strictObject({ schemaVersion: z.literal(4), ...fields });
export const nutritionPlanPublicPreviewV4RequestSchema = plain(524288).pipe(
  previewBody.superRefine(roster),
);
export type NutritionPlanPublicPreviewV4Request = z.infer<
  typeof nutritionPlanPublicPreviewV4RequestSchema
>;
const approvalBody = z
  .strictObject({
    schemaVersion: z.literal(4),
    intent: z.strictObject({
      schemaVersion: z.literal(3),
      command: z.strictObject({
        kind: z.literal('update'),
        expectedHeadVersionId: uuid,
        confirmed: z.literal(true),
        draft: nutritionPlanDraftV3Schema,
      }),
      expectedRaceHeads: expectedRaceHeadsSchema,
      reconnectItemIds: z.array(itemId).max(5000),
    }),
  })
  .superRefine((value, context) =>
    roster(
      {
        schemaVersion: 4,
        ...value.intent.command,
        expectedRaceHeads: value.intent.expectedRaceHeads,
        reconnectItemIds: value.intent.reconnectItemIds,
      },
      context,
    ),
  );
/** planId and idempotencyKey are composed exclusively from path/header. */
export const nutritionPlanPublicApproveV4RequestSchema = plain(524288).pipe(approvalBody);
export type NutritionPlanPublicApproveV4Request = z.infer<
  typeof nutritionPlanPublicApproveV4RequestSchema
>;
export const nutritionPlanPublicCapabilitiesV4Schema = z.strictObject({
  schemaVersion: z.literal(1),
  readV4: z.boolean(),
  previewV4: z.boolean(),
  standaloneApprovalV4: z.boolean(),
});
export type NutritionPlanPublicCapabilitiesV4 = z.infer<
  typeof nutritionPlanPublicCapabilitiesV4Schema
>;
const notice = z.strictObject({
  itemId,
  code: z.enum(['LEGACY_UNPINNED_PRESERVED', 'UNRESOLVED_PRESERVED']),
});
/** Retained public data; support and confirmation are not permission evidence. */
export const nutritionPlanPublicApprovalV4ResultSchema = plain(4194304).pipe(
  z
    .strictObject({
      schemaVersion: z.literal(4),
      plan: nutritionPlanVersionCompatibleV4Schema,
      notices: z.array(notice).max(5000),
    })
    .superRefine((value, context) => {
      const ids = new Set(value.plan.items.map((item) => item.id)),
        seen = new Set<string>();
      for (const n of value.notices) {
        const key = JSON.stringify([n.itemId, n.code]);
        if (!ids.has(n.itemId) || seen.has(key))
          context.addIssue({ code: 'custom', message: 'Exact unique notice membership required' });
        seen.add(key);
      }
    }),
);
export type NutritionPlanPublicApprovalV4Result = z.infer<
  typeof nutritionPlanPublicApprovalV4ResultSchema
>;
/** Safe planned data excludes stored versions, pins, source evidence and approvals. */
export const nutritionPlanPublicSafeV4Schema = z
  .strictObject({
    period: nutritionPlanDraftSchema.shape.period,
    timezone: nutritionPlanDraftSchema.shape.timezone,
    purpose: nutritionPlanDraftSchema.shape.purpose,
    linkedTrainingPlanVersionId: uuid.nullable(),
    items: z.array(raceManualPublicImpactNutritionItemSchema).max(5000),
  })
  .superRefine((plan, context) => {
    if (new Set(plan.items.map((item) => item.id)).size !== plan.items.length)
      context.addIssue({ code: 'custom', message: 'Duplicate planned item' });
  });
export const nutritionPlanPublicTimingV4Schema = z.discriminatedUnion('state', [
  z
    .strictObject({
      state: z.literal('resolved'),
      date: localDateSchema,
      localTime: localTimeSchema.nullable(),
      timezone: timeZoneSchema,
      instant: instantSchema.nullable(),
    })
    .superRefine((time, context) => {
      if ((time.localTime === null) !== (time.instant === null))
        context.addIssue({
          code: 'custom',
          message: 'Date-only timing must preserve unknown instant',
        });
    }),
  z.strictObject({
    state: z.literal('unresolved'),
    reason: z.enum([
      'missing_anchor',
      'missing_session_time',
      'missing_session_duration',
      'ambiguous_local_time',
      'timezone_mismatch',
      'offset_out_of_range',
    ]),
    detail: z
      .enum([
        'race_end_unknown',
        'start_unknown',
        'legacy_unpinned',
        'source_unavailable',
        'source_visibility_unknown',
        'existing_projection_unresolved',
      ])
      .nullable(),
  }),
  z.strictObject({ state: z.literal('suspended'), reason: z.literal('race_disconnected') }),
]);
export type NutritionPlanPublicTimingV4 = z.infer<typeof nutritionPlanPublicTimingV4Schema>;
const block = z.strictObject({
  itemId: itemId.nullable(),
  code: z.enum([
    'PRIOR_UNAVAILABLE',
    'PRIOR_HEAD_STALE',
    'ORIGIN_REQUIRED',
    'RECONNECT_REQUIRED',
    'RECONNECT_INVALID',
    'FOOD_REFERENCE_INVALID',
    'TRAINING_REFERENCE_INVALID',
    'RACE_UNAVAILABLE',
    'RACE_STALE',
    'TIMING_UNRESOLVED',
    'LIMIT',
  ]),
});
const boundary = {
  schemaVersion: z.literal(4),
  persistence: z.literal('not_stored'),
  freshness: z.literal('not_checked'),
  approvalAllowed: z.literal(false),
};
const comparison = z
  .strictObject({
    ...boundary,
    status: z.enum(['projected', 'blocked']),
    expectedPlan: z.strictObject({
      planId: uuid,
      versionId: uuid,
      version: z.number().int().min(1).max(2147483646),
    }),
    expectedRaceHeads: expectedRaceHeadsSchema,
    before: nutritionPlanPublicSafeV4Schema,
    after: nutritionPlanPublicSafeV4Schema,
    items: z
      .array(
        z.strictObject({
          itemId,
          change: z.enum(['affected', 'preserved', 'new', 'removed']),
          before: nutritionPlanPublicTimingV4Schema.nullable(),
          after: nutritionPlanPublicTimingV4Schema.nullable(),
        }),
      )
      .max(5000),
    notices: z.array(notice).max(5000),
    blocks: z.array(block).max(5000),
  })
  .superRefine((value, context) => {
    const old = new Map(value.before.items.map((item) => [item.id, item])),
      next = new Map(value.after.items.map((item) => [item.id, item]));
    const union = new Set([...old.keys(), ...next.keys()]),
      seen = new Set<string>();
    for (const row of value.items) {
      const before = old.get(row.itemId),
        after = next.get(row.itemId);
      if (
        seen.has(row.itemId) ||
        !union.has(row.itemId) ||
        (before === undefined) !== (row.before === null) ||
        (after === undefined) !== (row.after === null) ||
        (row.change === 'new') !== (before === undefined) ||
        (row.change === 'removed') !== (after === undefined)
      )
        context.addIssue({ code: 'custom', message: 'Exact before/after timing roster required' });
      if (
        row.change === 'preserved' &&
        (JSON.stringify(before) !== JSON.stringify(after) ||
          JSON.stringify(row.before) !== JSON.stringify(row.after))
      )
        context.addIssue({
          code: 'custom',
          message: 'Preserved item and frozen timing must remain exact',
        });
      if (
        (before?.anchor.kind === 'disconnected') !== (row.before?.state === 'suspended') ||
        (after?.anchor.kind === 'disconnected') !== (row.after?.state === 'suspended')
      )
        context.addIssue({ code: 'custom', message: 'Disconnected timing must remain suspended' });
      const unresolvedChange =
        (row.change === 'affected' || row.change === 'new') && row.after?.state === 'unresolved';
      if (
        unresolvedChange &&
        !value.blocks.some(
          (block) => block.itemId === row.itemId && block.code === 'TIMING_UNRESOLVED',
        )
      )
        context.addIssue({
          code: 'custom',
          message: 'Changed unresolved timing requires an exact block',
        });
      seen.add(row.itemId);
    }
    if (seen.size !== union.size || (value.status === 'projected') !== (value.blocks.length === 0))
      context.addIssue({ code: 'custom', message: 'Exact comparison and blocked status required' });
    for (const b of value.blocks)
      if (b.itemId !== null && !union.has(b.itemId))
        context.addIssue({ code: 'custom', message: 'Block item must be consumed' });
    const expectations = raceHeadExpectationRosterSchema.safeParse({
      items: value.after.items.flatMap((item) =>
        item.anchor.kind === 'disconnected' ? [] : [{ itemId: item.id, anchor: item.anchor }],
      ),
      expectedRaceHeads: value.expectedRaceHeads,
    });
    if (!expectations.success)
      context.addIssue({ code: 'custom', message: 'Exact proposed race head roster required' });
    const notices = new Set<string>();
    for (const n of value.notices) {
      const key = JSON.stringify([n.itemId, n.code]);
      if (!union.has(n.itemId) || notices.has(key))
        context.addIssue({ code: 'custom', message: 'Exact notice roster required' });
      notices.add(key);
    }
  });
const unavailable = z
  .strictObject({
    ...boundary,
    status: z.literal('unavailable'),
    blocks: z.array(block).min(1).max(5000),
  })
  .superRefine((value, context) => {
    if (value.blocks.some((b) => b.itemId !== null))
      context.addIssue({
        code: 'custom',
        message: 'Unavailable source has no invented item identity',
      });
  });
export const nutritionPlanPublicPreviewV4Schema = plain(4194304).pipe(
  z.union([comparison, unavailable]),
);
export type NutritionPlanPublicPreviewV4 = z.infer<typeof nutritionPlanPublicPreviewV4Schema>;
