import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const metric = z.number().finite().nonnegative().max(1_000_000_000);

/** Query strings are deliberately not coerced: arrays, fractions and signs are invalid. */
export const healthKitWorkoutReviewQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
    .transform(Number)
    .optional(),
});

/** Only facts needed to make an explicit decision leave the raw HealthKit store. */
export const healthKitWorkoutReviewItemSchema = z
  .strictObject({
    sampleId: uuid,
    expectedSampleDigest: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['running', 'cycling', 'walking', 'strength', 'other']),
    observedFrom: z.iso.datetime({ offset: true }),
    observedTo: z.iso.datetime({ offset: true }),
    durationSeconds: metric,
    distanceMeters: metric.nullable(),
  })
  .refine((item) => Date.parse(item.observedTo) >= Date.parse(item.observedFrom), {
    path: ['observedTo'],
    message: 'observedTo must not precede observedFrom',
  });

export const healthKitWorkoutReviewResponseSchema = z.strictObject({
  items: z.array(healthKitWorkoutReviewItemSchema).max(100),
});

export type HealthKitWorkoutReviewItem = z.infer<typeof healthKitWorkoutReviewItemSchema>;
export type HealthKitWorkoutReviewResponse = z.infer<typeof healthKitWorkoutReviewResponseSchema>;
