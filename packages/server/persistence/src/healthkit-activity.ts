import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  healthKitCreateActivityResultSchema,
  healthKitCreateActivitySchema,
  type HealthKitCreateActivity,
  type HealthKitCreateActivityResult,
} from '@workout/contracts/healthkit-activity';
import type { Database } from './database.js';
import { enqueue } from './outbox.js';

export class HealthKitActivityError extends Error {
  constructor(
    readonly code:
      | 'CONSENT_REQUIRED'
      | 'SAMPLE_NOT_FOUND'
      | 'SAMPLE_UNAVAILABLE'
      | 'DIGEST_CONFLICT'
      | 'ALREADY_LINKED'
      | 'IDEMPOTENCY_CONFLICT',
  ) {
    super(code);
  }
}

export interface HealthKitActivityRepository {
  createActivity(
    athleteId: string,
    input: HealthKitCreateActivity,
  ): Promise<HealthKitCreateActivityResult>;
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

/** Promotes exactly one explicitly selected live raw workout to a primary Activity. */
export function createHealthKitActivityRepository(database: Database): HealthKitActivityRepository {
  return {
    createActivity(athleteId, input) {
      const command = healthKitCreateActivitySchema.parse(input);
      const receiptKey = `healthkit-create:${command.idempotencyKey}`;
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      return database.tenant(athleteId, async (tx) => {
        // All Activity commands, raw delivery and consent changes use this order.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const consent = await tx.query(
          'SELECT public.healthkit_ingestion_consent_locked() AS granted',
        );
        if (consent.rows[0]?.['granted'] !== true)
          throw new HealthKitActivityError('CONSENT_REQUIRED');

        const previous = await tx.query(
          'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, receiptKey],
        );
        if (previous.rows[0]) {
          const request = receiptSchema.safeParse(previous.rows[0]['request']);
          if (!request.success || request.data.hash !== hash)
            throw new HealthKitActivityError('IDEMPOTENCY_CONFLICT');
          const result = healthKitCreateActivityResultSchema.safeParse(previous.rows[0]['result']);
          if (!result.success) throw new HealthKitActivityError('IDEMPOTENCY_CONFLICT');
          return result.data;
        }

        const sampleResult = await tx.query(
          `SELECT s.state,s.payload_digest,l.state AS lineage_state
           FROM healthkit_workout_sample s
           JOIN healthkit_workout_lineage l
             ON l.athlete_id=s.athlete_id AND l.sample_id=s.sample_id
           WHERE s.athlete_id=$1 AND s.sample_id=$2`,
          [athleteId, command.sampleId],
        );
        if (!sampleResult.rows[0]) throw new HealthKitActivityError('SAMPLE_NOT_FOUND');
        const sample = sampleSchema.parse(sampleResult.rows[0]);
        if (sample.state !== 'active' || sample.lineage_state === 'deleted')
          throw new HealthKitActivityError('SAMPLE_UNAVAILABLE');
        if (sample.payload_digest !== command.expectedSampleDigest)
          throw new HealthKitActivityError('DIGEST_CONFLICT');
        if (
          sample.lineage_state === 'linked_existing' ||
          sample.lineage_state === 'created_activity'
        )
          throw new HealthKitActivityError('ALREADY_LINKED');
        if (sample.lineage_state !== 'pending_review')
          throw new HealthKitActivityError('SAMPLE_UNAVAILABLE');

        const created = await tx.query(
          'SELECT public.create_healthkit_canonical($1,$2) AS activity_id',
          [command.sampleId, command.expectedSampleDigest],
        );
        const activityId = z.uuid().parse(created.rows[0]?.['activity_id']);
        const result = healthKitCreateActivityResultSchema.parse({
          sampleId: command.sampleId,
          activityId,
          activityRevision: 1,
          state: 'created_activity',
        });
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: `activity:${activityId}:1`,
          topic: 'activity.changed',
          payload: { activityId, revision: 1, action: 'healthkit' },
        });
        await tx.query(
          `INSERT INTO command_receipt(athlete_id,idempotency_key,request,result)
           VALUES($1,$2,$3::jsonb,$4::jsonb)`,
          [athleteId, receiptKey, JSON.stringify({ hash }), JSON.stringify(result)],
        );
        return result;
      });
    },
  };
}
