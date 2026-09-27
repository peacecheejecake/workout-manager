import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  healthKitBindExistingResultSchema,
  healthKitBindExistingSchema,
  type HealthKitBindExisting,
  type HealthKitBindExistingResult,
} from '@workout/contracts/healthkit-binding';
import type { Database } from './database.js';

export class HealthKitBindingError extends Error {
  constructor(
    readonly code:
      | 'CONSENT_REQUIRED'
      | 'SAMPLE_NOT_FOUND'
      | 'SAMPLE_UNAVAILABLE'
      | 'DIGEST_CONFLICT'
      | 'TARGET_NOT_FOUND'
      | 'TARGET_UNAVAILABLE'
      | 'REVISION_CONFLICT'
      | 'ALREADY_LINKED'
      | 'IDEMPOTENCY_CONFLICT',
  ) {
    super(code);
  }
}

export interface HealthKitBindingRepository {
  bindExisting(
    athleteId: string,
    input: HealthKitBindExisting,
  ): Promise<HealthKitBindExistingResult>;
}

const receiptSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) });
const sampleSchema = z.object({
  state: z.enum(['active', 'deleted']),
  payload_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  lineage_state: z.enum([
    'pending_review',
    'linked_existing',
    'created_activity',
    'suppressed',
    'deleted',
  ]),
});
const targetSchema = z.object({
  revision: z.number().int().positive(),
  deleted: z.boolean(),
  kind: z.enum(['fit', 'fixture', 'manual']),
  suppressed: z.boolean(),
});

/**
 * Associates one reviewed HealthKit workout with a live existing Activity.
 * This is supplementary lineage: the Activity primary source, values, overlay,
 * source revision, and summary cardinality never change.
 */
export function createHealthKitBindingRepository(database: Database): HealthKitBindingRepository {
  return {
    bindExisting(athleteId, input) {
      const command = healthKitBindExistingSchema.parse(input);
      const receiptKey = `healthkit-bind-existing:${command.idempotencyKey}`;
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      return database.tenant(athleteId, async (tx) => {
        // Consent writes and Activity edits take the same tenant command lock.
        // The consent row lock then serializes this decision with raw delivery and withdrawal.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const consent = await tx.query(
          'SELECT public.healthkit_ingestion_consent_locked() AS granted',
        );
        if (consent.rows[0]?.['granted'] !== true)
          throw new HealthKitBindingError('CONSENT_REQUIRED');

        const prior = await tx.query(
          'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, receiptKey],
        );
        if (prior.rows[0]) {
          const request = receiptSchema.safeParse(prior.rows[0]['request']);
          if (!request.success || request.data.hash !== hash)
            throw new HealthKitBindingError('IDEMPOTENCY_CONFLICT');
          return healthKitBindExistingResultSchema.parse(prior.rows[0]['result']);
        }

        const sampleResult = await tx.query(
          `SELECT s.state,s.payload_digest,l.state AS lineage_state
           FROM healthkit_workout_sample s
           JOIN healthkit_workout_lineage l
             ON l.athlete_id=s.athlete_id AND l.sample_id=s.sample_id
           WHERE s.athlete_id=$1 AND s.sample_id=$2`,
          [athleteId, command.sampleId],
        );
        if (!sampleResult.rows[0]) throw new HealthKitBindingError('SAMPLE_NOT_FOUND');
        const sample = sampleSchema.parse(sampleResult.rows[0]);
        if (sample.state !== 'active' || sample.lineage_state === 'deleted')
          throw new HealthKitBindingError('SAMPLE_UNAVAILABLE');
        if (sample.payload_digest !== command.expectedSampleDigest)
          throw new HealthKitBindingError('DIGEST_CONFLICT');
        if (
          sample.lineage_state === 'linked_existing' ||
          sample.lineage_state === 'created_activity'
        )
          throw new HealthKitBindingError('ALREADY_LINKED');
        if (sample.lineage_state !== 'pending_review')
          throw new HealthKitBindingError('SAMPLE_UNAVAILABLE');

        const targetResult = await tx.query(
          `SELECT c.revision,c.deleted,h.kind,
             EXISTS(SELECT 1 FROM activity_suppression d
               WHERE d.athlete_id=h.athlete_id AND d.kind=h.kind AND d.source_id=h.source_id)
               AS suppressed
           FROM activity_canonical c
           JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id
           WHERE c.athlete_id=$1 AND c.id=$2`,
          [athleteId, command.targetActivityId],
        );
        if (!targetResult.rows[0]) throw new HealthKitBindingError('TARGET_NOT_FOUND');
        const target = targetSchema.parse(targetResult.rows[0]);
        if (target.deleted || target.suppressed || target.kind === 'fixture')
          throw new HealthKitBindingError('TARGET_UNAVAILABLE');
        if (target.revision !== command.expectedActivityRevision)
          throw new HealthKitBindingError('REVISION_CONFLICT');

        await tx.query(
          `INSERT INTO healthkit_existing_binding
             (athlete_id,sample_id,activity_id,sample_digest,target_revision)
           VALUES($1,$2,$3,$4,$5)`,
          [
            athleteId,
            command.sampleId,
            command.targetActivityId,
            command.expectedSampleDigest,
            target.revision,
          ],
        );
        const result = healthKitBindExistingResultSchema.parse({
          sampleId: command.sampleId,
          activityId: command.targetActivityId,
          activityRevision: target.revision,
          state: 'linked_existing',
        });
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, receiptKey, JSON.stringify({ hash }), JSON.stringify(result)],
        );
        return result;
      });
    },
  };
}
