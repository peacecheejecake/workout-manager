import { z } from 'zod';
import { localDateSchema } from './primitives.js';
import { nutritionPlanItemCoreSchema } from './nutrition-core.js';
import { routineScheduleVersionSchema } from './routines.js';
import { raceManualPublicPreviewReferenceSchema } from './race-manual-public-preview.js';

const id = z.string().min(1).max(200);
/** User intent only; this DTO never grants source or approval authority. */
export const raceManualProjectionIntentSchema = z.strictObject({
  expectedEvent: z.strictObject({
    id: z.uuid(),
    revision: z.number().int().min(1).max(2147483647),
  }),
  newLocalDate: localDateSchema,
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keep_plan') }),
    z.strictObject({
      kind: z.literal('move_period'),
      expectedCurrentPlanVersionId: z.uuid(),
      periodId: id,
      newStartDate: localDateSchema,
      scope: z.enum(['period_only', 'descendants_and_sessions']),
    }),
  ]),
  resolutions: z
    .strictObject({
      nutrition: z
        .array(
          z.strictObject({
            planVersionId: z.uuid(),
            itemId: id,
            action: z.literal('replace_anchor'),
            anchor: nutritionPlanItemCoreSchema.shape.anchor,
          }),
        )
        .max(5000),
      routines: z
        .array(
          z.strictObject({
            scheduleVersionId: id,
            action: z.literal('replace_rule'),
            rule: routineScheduleVersionSchema.shape.rule,
            window: routineScheduleVersionSchema.shape.window,
            sourcePlanVersionId: z.uuid().nullable(),
          }),
        )
        .max(1000),
    })
    .default({ nutrition: [], routines: [] }),
});

export const raceManualPublicPrepareSchema = z.strictObject({
  schemaVersion: z.literal(1),
  intent: raceManualProjectionIntentSchema,
});
export const raceManualPublicApproveSchema = z.strictObject({
  schemaVersion: z.literal(1),
  confirmed: z.literal(true),
  applicationDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RaceManualProjectionIntent = z.infer<typeof raceManualProjectionIntentSchema>;
export type RaceManualPublicPrepare = z.infer<typeof raceManualPublicPrepareSchema>;
export type RaceManualPublicApprove = z.infer<typeof raceManualPublicApproveSchema>;

/** Durable review identity; a stored reviewed body is not current approval permission. */
export const raceManualPublicReviewResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('reviewed'),
    reference: raceManualPublicPreviewReferenceSchema,
    bodyState: z.enum(['present', 'purged']),
  }),
  z.strictObject({
    status: z.literal('blocked'),
    stage: z.enum(['semantic', 'chain', 'application']),
  }),
]);
export type RaceManualPublicReviewResult = z.infer<typeof raceManualPublicReviewResultSchema>;

/** Injected protocol support only; not installed storage, consent or approval authority. */
export const raceManualPublicCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dateChangeReviews: z.boolean(),
});
export type RaceManualPublicCapabilities = z.infer<typeof raceManualPublicCapabilitiesSchema>;
