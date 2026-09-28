import { createHash } from 'node:crypto';
import {
  healthKitIngestionAckSchema,
  healthKitIngestionBatchSchema,
  type HealthKitIngestionAck,
  type HealthKitIngestionBatch,
} from '@workout/contracts/healthkit-ingestion';
import type { Database } from './database.js';

export class HealthKitIngestionError extends Error {
  constructor(
    readonly code: 'CONSENT_REQUIRED' | 'CONSENT_EPOCH_EXPIRED' | 'IDEMPOTENCY_CONFLICT',
  ) {
    super(code);
  }
}

export interface HealthKitIngestionRepository {
  ingestBatch(
    athleteId: string,
    input: HealthKitIngestionBatch,
    consentRevision: number,
  ): Promise<HealthKitIngestionAck>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Acknowledges durable raw source storage only. No canonical Activity is created here:
 * source identity, deletion suppression, and cross-provider matching remain separate.
 */
export function createHealthKitIngestionRepository(
  database: Database,
): HealthKitIngestionRepository {
  return {
    ingestBatch(athleteId, input, consentRevision) {
      const batch = healthKitIngestionBatchSchema.parse(input);
      if (
        !Number.isSafeInteger(consentRevision) ||
        consentRevision < 1 ||
        consentRevision > 2_147_483_647
      )
        throw new HealthKitIngestionError('CONSENT_EPOCH_EXPIRED');
      const requestDigest = digest(batch);
      return database.tenant(athleteId, async (tx) => {
        // Canonical deletion and evidence cleanup take the tenant command lock.
        // Keep that lock before consent so a HealthKit delete cannot invert the
        // binding/create/withdrawal lock order.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        // The row lock serializes with consent withdrawal's UPDATE/DELETE trigger. A
        // committed ACK can never leave raw data behind after a committed withdrawal.
        const consent = await tx.query(
          'SELECT public.healthkit_ingestion_consent_revision_locked() AS revision',
        );
        if (consent.rows[0]?.['revision'] == null)
          throw new HealthKitIngestionError('CONSENT_REQUIRED');
        if (consent.rows[0]?.['revision'] !== consentRevision)
          throw new HealthKitIngestionError('CONSENT_EPOCH_EXPIRED');

        const inserted = await tx.query(
          `INSERT INTO healthkit_workout_batch_receipt
             (athlete_id,installation_id,batch_id,request_digest,accepted_count)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING RETURNING batch_id`,
          [athleteId, batch.installationId, batch.batchId, requestDigest, batch.events.length],
        );
        if (!inserted.rowCount) {
          const existing = await tx.query(
            `SELECT request_digest,accepted_count,purged_at
             FROM healthkit_workout_batch_receipt
             WHERE athlete_id=$1 AND installation_id=$2 AND batch_id=$3`,
            [athleteId, batch.installationId, batch.batchId],
          );
          const receipt = existing.rows[0];
          // A purged receipt is a replay barrier: re-consent requires a new native batch.
          if (receipt && receipt['purged_at'] !== null)
            throw new HealthKitIngestionError('CONSENT_EPOCH_EXPIRED');
          if (!receipt || receipt['request_digest'] !== requestDigest)
            throw new HealthKitIngestionError('IDEMPOTENCY_CONFLICT');
          return healthKitIngestionAckSchema.parse({
            schemaVersion: 1,
            installationId: batch.installationId,
            batchId: batch.batchId,
            acceptedCount: receipt['accepted_count'],
          });
        }

        for (const event of batch.events) {
          if (event.kind === 'delete') {
            await tx.query(
              `INSERT INTO healthkit_workout_sample
                (athlete_id,sample_id,installation_id,state,deleted_at)
               VALUES($1,$2,$3,'deleted',clock_timestamp())
               ON CONFLICT (athlete_id,sample_id) DO UPDATE SET
                 state='deleted',source_bundle_id=NULL,source_version=NULL,
                 activity_type=NULL,observed_from=NULL,observed_to=NULL,
                 duration_seconds=NULL,distance_meters=NULL,energy_kilocalories=NULL,
                 payload_digest=NULL,deleted_at=coalesce(healthkit_workout_sample.deleted_at,clock_timestamp())`,
              [athleteId, event.sampleId, batch.installationId],
            );
            continue;
          }

          const sampleDigest = digest(event);
          const created = await tx.query(
            `INSERT INTO healthkit_workout_sample
              (athlete_id,sample_id,installation_id,state,source_bundle_id,source_version,
               activity_type,observed_from,observed_to,duration_seconds,distance_meters,
               energy_kilocalories,payload_digest)
             VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT DO NOTHING RETURNING sample_id`,
            [
              athleteId,
              event.sampleId,
              batch.installationId,
              event.sourceBundleId,
              event.sourceVersion,
              event.activityType,
              event.observedFrom,
              event.observedTo,
              event.durationSeconds,
              event.distanceMeters,
              event.energyKilocalories,
              sampleDigest,
            ],
          );
          if (created.rowCount) continue;
          const existing = await tx.query(
            `SELECT state,payload_digest FROM healthkit_workout_sample
             WHERE athlete_id=$1 AND sample_id=$2`,
            [athleteId, event.sampleId],
          );
          const sample = existing.rows[0];
          if (
            !sample ||
            (sample['state'] === 'active' && sample['payload_digest'] !== sampleDigest)
          )
            throw new HealthKitIngestionError('IDEMPOTENCY_CONFLICT');
          // A previously deleted HealthKit UUID never resurrects from a delayed add.
        }

        return healthKitIngestionAckSchema.parse({
          schemaVersion: 1,
          installationId: batch.installationId,
          batchId: batch.batchId,
          acceptedCount: batch.events.length,
        });
      });
    },
  };
}
