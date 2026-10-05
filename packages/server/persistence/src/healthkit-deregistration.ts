import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  healthKitDeregisterWorkoutSchema,
  healthKitDeregistrationResultSchema,
  type HealthKitDeregisterWorkout,
  type HealthKitDeregistrationResult,
} from '@workout/contracts/healthkit-registration';
import type { Database } from './database.js';

const errorCodes = z.enum([
  'CONSENT_REQUIRED',
  'CONSENT_EPOCH_EXPIRED',
  'CLAIM_EPOCH_EXPIRED',
  'REGISTRY_REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'DEREGISTRATION_PENDING',
  'DEREGISTRATION_NOT_FOUND',
  'RECEIPT_MEMBERSHIP_REQUIRED',
  'INVALID_REQUEST',
]);
export class HealthKitDeregistrationError extends Error {
  constructor(readonly code: z.infer<typeof errorCodes>) {
    super(code);
  }
}
export interface HealthKitDeregistrationRepository {
  deregisterWorkout(
    athleteId: string,
    input: HealthKitDeregisterWorkout,
  ): Promise<HealthKitDeregistrationResult>;
  getStatus(athleteId: string, operationId: string): Promise<HealthKitDeregistrationResult>;
  /** Worker port: checks database cleanup facts; callers cannot assert completion. */
  finalize(athleteId: string, operationId: string): Promise<HealthKitDeregistrationResult>;
}
function translate(error: unknown): never {
  if (error instanceof Error) {
    const parsed = errorCodes.safeParse(error.message);
    if (parsed.success) throw new HealthKitDeregistrationError(parsed.data);
  }
  throw error;
}
export function createHealthKitDeregistrationRepository(
  database: Database,
): HealthKitDeregistrationRepository {
  return {
    async deregisterWorkout(athleteId, input) {
      const command = healthKitDeregisterWorkoutSchema.parse(input);
      const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      try {
        return await database.tenant(athleteId, async (tx) => {
          const result = await tx.query(
            'SELECT public.deregister_healthkit_workout($1,$2,$3,$4,$5,$6) AS result',
            [
              command.sampleId,
              command.claimEpoch,
              command.expectedConsentRevision,
              command.expectedRegistryRevision,
              command.idempotencyKey,
              digest,
            ],
          );
          return healthKitDeregistrationResultSchema.parse(result.rows[0]?.['result']);
        });
      } catch (error) {
        return translate(error);
      }
    },
    async getStatus(athleteId, operationId) {
      z.uuid().parse(operationId);
      return database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const consent = await tx.query(
          'SELECT public.healthkit_ingestion_consent_revision_locked() AS revision',
        );
        if (consent.rows[0]?.['revision'] == null)
          throw new HealthKitDeregistrationError('CONSENT_REQUIRED');
        const result = await tx.query(
          `SELECT operation_id,state,registry_revision FROM healthkit_workout_deregistration
          WHERE athlete_id=$1 AND operation_id=$2`,
          [athleteId, operationId],
        );
        const row = result.rows[0];
        if (!row) throw new HealthKitDeregistrationError('DEREGISTRATION_NOT_FOUND');
        return healthKitDeregistrationResultSchema.parse({
          schemaVersion: 1,
          operationId: row['operation_id'],
          status: row['state'],
          registryRevision: row['registry_revision'],
        });
      });
    },
    async finalize(athleteId, operationId) {
      z.uuid().parse(operationId);
      try {
        return await database.tenant(athleteId, async (tx) => {
          const result = await tx.query(
            'SELECT public.finalize_healthkit_deregistration($1) AS result',
            [operationId],
          );
          return healthKitDeregistrationResultSchema.parse(result.rows[0]?.['result']);
        });
      } catch (error) {
        return translate(error);
      }
    },
  };
}
