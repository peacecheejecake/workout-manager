import { z } from 'zod';
import {
  healthKitWorkoutDeleteSchema,
  healthKitWorkoutUpsertSchema,
} from './healthkit-ingestion.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const expectedRegistryRevision = z.number().int().min(0).max(2_147_483_647);
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const cursor = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const sampleIds = z
  .array(uuid)
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate sampleId');

/** The signed-in athlete is derived from native bearer authentication, never a client field. */
export const healthKitRegisterWorkoutsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sampleIds,
  accountAttributionDeclared: z.literal(true),
  expectedConsentRevision: revision,
  expectedRegistryRevision,
  idempotencyKey,
});

/** A fresh opaque claim epoch is required for each registration, including re-registration. */
export const healthKitWorkoutClaimSchema = z.strictObject({
  sampleId: uuid,
  claimEpoch: uuid,
});

export const healthKitRegisterWorkoutsResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    claims: z.array(healthKitWorkoutClaimSchema).min(1).max(50),
    registryRevision: revision,
  })
  .refine(
    (result) => new Set(result.claims.map((claim) => claim.sampleId)).size === result.claims.length,
    {
      message: 'Duplicate sampleId',
      path: ['claims'],
    },
  );

/** The cursor is opaque and must be bound to the authenticated account and revision. */
export const healthKitListRegisteredWorkoutsQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
    .transform(Number)
    .optional(),
  cursor: cursor.optional(),
});

export const healthKitListRegisteredWorkoutsResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    claims: z.array(healthKitWorkoutClaimSchema).max(100),
    registryRevision: expectedRegistryRevision,
    nextCursor: cursor.nullable(),
  })
  .refine(
    (result) => new Set(result.claims.map((claim) => claim.sampleId)).size === result.claims.length,
    {
      message: 'Duplicate sampleId',
      path: ['claims'],
    },
  );

/** Matches the product API error envelope without revealing another account or workout. */
export const healthKitRegistrationErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'BEARER_REQUIRED',
  'UNAUTHENTICATED',
  'CONSENT_REQUIRED',
  'CONSENT_EPOCH_EXPIRED',
  'REGISTRATION_REQUIRED',
  'CLAIM_CONFLICT',
  'CLAIM_EPOCH_EXPIRED',
  'REGISTRY_REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'LEGACY_BATCH_UNSUPPORTED',
]);

export const healthKitRegistrationErrorSchema = z.strictObject({
  error: z.strictObject({
    code: healthKitRegistrationErrorCodeSchema,
  }),
  requestId: z.string().min(1).max(128),
});

/** Unregistered v1 batches have no claim epoch and are not valid v2 ingestion input. */
export const healthKitRegisteredWorkoutEventSchema = z.discriminatedUnion('kind', [
  healthKitWorkoutUpsertSchema.safeExtend({ claimEpoch: uuid }),
  healthKitWorkoutDeleteSchema.safeExtend({ claimEpoch: uuid }),
]);

export const healthKitRegisteredIngestionBatchSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    installationId: uuid,
    batchId: uuid,
    events: z.array(healthKitRegisteredWorkoutEventSchema).min(1).max(100),
  })
  .refine(
    (batch) => new Set(batch.events.map((event) => event.sampleId)).size === batch.events.length,
    {
      message: 'Duplicate sampleId',
      path: ['events'],
    },
  );

export const healthKitRegisteredIngestionAckSchema = z.strictObject({
  schemaVersion: z.literal(2),
  installationId: uuid,
  batchId: uuid,
  acceptedCount: z.number().int().min(1).max(100),
});

export type HealthKitRegisterWorkouts = z.infer<typeof healthKitRegisterWorkoutsSchema>;
export type HealthKitRegisterWorkoutsResult = z.infer<typeof healthKitRegisterWorkoutsResultSchema>;
export type HealthKitWorkoutClaim = z.infer<typeof healthKitWorkoutClaimSchema>;
export type HealthKitListRegisteredWorkoutsQuery = z.infer<
  typeof healthKitListRegisteredWorkoutsQuerySchema
>;
export type HealthKitListRegisteredWorkoutsResult = z.infer<
  typeof healthKitListRegisteredWorkoutsResultSchema
>;
export type HealthKitRegistrationError = z.infer<typeof healthKitRegistrationErrorSchema>;
export type HealthKitRegistrationErrorCode = z.infer<typeof healthKitRegistrationErrorCodeSchema>;
export type HealthKitRegisteredIngestionBatch = z.infer<
  typeof healthKitRegisteredIngestionBatchSchema
>;
export type HealthKitRegisteredIngestionAck = z.infer<typeof healthKitRegisteredIngestionAckSchema>;
