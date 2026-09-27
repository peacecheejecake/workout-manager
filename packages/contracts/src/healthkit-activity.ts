import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());

/** Explicitly promote one verified HealthKit workout to its own canonical Activity. */
export const healthKitCreateActivitySchema = z.strictObject({
  sampleId: uuid,
  expectedSampleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const healthKitCreateActivityResultSchema = z.strictObject({
  sampleId: uuid,
  activityId: uuid,
  activityRevision: z.number().int().positive(),
  state: z.literal('created_activity'),
});

export type HealthKitCreateActivity = z.infer<typeof healthKitCreateActivitySchema>;
export type HealthKitCreateActivityResult = z.infer<typeof healthKitCreateActivityResultSchema>;
