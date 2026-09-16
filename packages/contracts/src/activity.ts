import { z } from 'zod';
import { timeZoneSchema } from './primitives.js';

const boundedMetric = z.number().finite().nonnegative().max(1_000_000_000).nullable();
export const activityValuesSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).nullable(),
  kind: z.enum(['running', 'cycling', 'walking', 'strength', 'other', 'unknown']),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  durationSeconds: boundedMetric,
  durationKind: z.enum(['timer', 'elapsed', 'moving', 'unknown']),
  timezone: timeZoneSchema.nullable(),
  distanceMeters: boundedMetric,
});
export const activitySourceSchema = z.strictObject({
  kind: z.enum(['fit', 'fixture']),
  sourceId: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim() === value),
  revision: z.number().int().min(1).max(2147483646),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const importActivitySchema = z.strictObject({
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  source: activitySourceSchema,
  activity: activityValuesSchema,
});
export const activityOverlaySchema = z
  .strictObject({
    title: activityValuesSchema.shape.title.optional(),
    distanceMeters: boundedMetric.optional(),
    durationSeconds: boundedMetric.optional(),
    durationKind: activityValuesSchema.shape.durationKind.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((value) => (value.durationSeconds !== undefined) === (value.durationKind !== undefined), {
    message: 'Duration correction requires its measurement definition',
  });
export const activityOverlayWriteSchema = activityOverlaySchema
  .safeExtend({
    expectedRevision: z.number().int().min(1).max(2147483646),
    idempotencyKey: importActivitySchema.shape.idempotencyKey,
    reason: z.string().trim().min(1).max(500),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.distanceMeters !== undefined ||
      value.durationSeconds !== undefined,
  );
export const activityDeleteSchema = z.strictObject({
  expectedRevision: z.number().int().min(1).max(2147483646),
});
export const activitySchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  source: activitySourceSchema,
  original: activityValuesSchema,
  overlay: activityOverlaySchema,
  effective: activityValuesSchema,
});
export const activityListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export const activityListSchema = z.strictObject({
  items: z.array(activitySchema).max(100),
  total: z.number().int().nonnegative(),
});
export const activityImportResultSchema = z.strictObject({
  outcome: z.enum(['imported', 'unchanged', 'stale', 'suppressed']),
  activityId: z.uuid(),
  revision: z.number().int().positive(),
});
const aggregateSchema = z.strictObject({
  value: z.number().nonnegative().nullable(),
  knownCount: z.number().int().nonnegative(),
});
export const activitySummarySchema = z.strictObject({
  count: z.number().int().nonnegative(),
  distanceMeters: aggregateSchema,
  durationSeconds: aggregateSchema.extend({
    byKind: z.strictObject({
      timer: aggregateSchema,
      elapsed: aggregateSchema,
      moving: aggregateSchema,
      unknown: aggregateSchema,
    }),
  }),
});
export type Activity = z.infer<typeof activitySchema>;
export type ActivityImport = z.infer<typeof importActivitySchema>;
export type ActivityImportResult = z.infer<typeof activityImportResultSchema>;
export type ActivityList = z.infer<typeof activityListSchema>;
export type ActivitySummary = z.infer<typeof activitySummarySchema>;
export type ActivityOverlayWrite = z.infer<typeof activityOverlayWriteSchema>;
