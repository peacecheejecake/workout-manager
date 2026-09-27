import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_646);

/** A user's explicit choice to associate one raw workout with an existing Activity. */
export const healthKitBindExistingSchema = z.strictObject({
  sampleId: uuid,
  targetActivityId: uuid,
  expectedActivityRevision: revision,
  expectedSampleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const healthKitBindExistingResultSchema = z.strictObject({
  sampleId: uuid,
  activityId: uuid,
  activityRevision: revision,
  state: z.literal('linked_existing'),
});

export type HealthKitBindExisting = z.infer<typeof healthKitBindExistingSchema>;
export type HealthKitBindExistingResult = z.infer<typeof healthKitBindExistingResultSchema>;
