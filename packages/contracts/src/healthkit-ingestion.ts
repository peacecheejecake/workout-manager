import { z } from 'zod';

/** Raw HealthKit workout changes, before any canonical Activity matching. */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const instant = z.iso.datetime({ offset: true });
const metric = z.number().finite().nonnegative().max(1_000_000_000).nullable();

export const healthKitWorkoutUpsertSchema = z
  .strictObject({
    kind: z.literal('upsert'),
    sampleId: uuid,
    sourceBundleId: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => value.trim().length > 0),
    sourceVersion: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0)
      .nullable(),
    activityType: z.number().int().nonnegative().max(1_000_000),
    observedFrom: instant,
    observedTo: instant,
    durationSeconds: z.number().finite().nonnegative().max(2_678_400),
    distanceMeters: metric,
    energyKilocalories: metric,
  })
  .refine((event) => Date.parse(event.observedTo) >= Date.parse(event.observedFrom), {
    message: 'observedTo must not precede observedFrom',
    path: ['observedTo'],
  });

export const healthKitWorkoutDeleteSchema = z.strictObject({
  kind: z.literal('delete'),
  sampleId: uuid,
});

export const healthKitWorkoutEventSchema = z.discriminatedUnion('kind', [
  healthKitWorkoutUpsertSchema,
  healthKitWorkoutDeleteSchema,
]);

export const healthKitIngestionBatchSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    installationId: uuid,
    batchId: uuid,
    events: z.array(healthKitWorkoutEventSchema).min(1).max(100),
  })
  .superRefine((batch, context) => {
    const sampleIds = new Set<string>();
    batch.events.forEach((event, index) => {
      if (sampleIds.has(event.sampleId)) {
        context.addIssue({
          code: 'custom',
          message: 'sampleId must be unique within a batch',
          path: ['events', index, 'sampleId'],
        });
      }
      sampleIds.add(event.sampleId);
    });
  });

export const healthKitIngestionAckSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installationId: uuid,
  batchId: uuid,
  acceptedCount: z.number().int().nonnegative().max(100),
});

export type HealthKitIngestionBatch = z.infer<typeof healthKitIngestionBatchSchema>;
export type HealthKitIngestionAck = z.infer<typeof healthKitIngestionAckSchema>;
