import { z } from 'zod';
import {
  healthKitWorkoutReviewResponseSchema,
  type HealthKitWorkoutReviewResponse,
} from '@workout/contracts/healthkit-review';
import type { Database } from './database.js';

const lineageRowSchema = z.object({
  sample_id: z.uuid(),
  state: z.enum(['pending_review', 'linked_existing', 'created_activity', 'suppressed', 'deleted']),
});

export type HealthKitWorkoutLineage = {
  sampleId: string;
  state: 'pending_review' | 'linked_existing' | 'created_activity' | 'suppressed' | 'deleted';
};

const reviewRowSchema = z.object({
  sample_id: z.uuid(),
  payload_digest: z.string().regex(/^[a-f0-9]{64}$/),
  activity_type: z.number().int().nonnegative(),
  observed_from: z.date(),
  observed_to: z.date(),
  duration_seconds: z.number().finite().nonnegative(),
  distance_meters: z.number().finite().nonnegative().nullable(),
});

function activityKind(activityType: number) {
  switch (activityType) {
    case 13:
      return 'cycling';
    case 20:
    case 50:
      return 'strength';
    case 37:
      return 'running';
    case 52:
      return 'walking';
    default:
      return 'other';
  }
}

export class HealthKitReviewError extends Error {
  constructor(readonly code: 'CONSENT_REQUIRED') {
    super(code);
  }
}

export interface HealthKitReviewRepository {
  listPendingWorkouts(athleteId: string, limit: number): Promise<HealthKitWorkoutReviewResponse>;
}

/** Owner-scoped review queue facts; this is never a canonical Activity query. */
export function createHealthKitProjectionRepository(database: Database) {
  return {
    async listPendingWorkouts(
      athleteId: string,
      limit: number,
    ): Promise<HealthKitWorkoutReviewResponse> {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      return database.tenant(athleteId, async (tx) => {
        // Serialize the read with consent withdrawal; a completed withdrawal
        // cannot expose stale sample data through this endpoint.
        const consent = await tx.query(
          'SELECT public.healthkit_ingestion_consent_locked() AS granted',
        );
        if (consent.rows[0]?.['granted'] !== true) {
          throw new HealthKitReviewError('CONSENT_REQUIRED');
        }
        const result = await tx.query(
          `SELECT s.sample_id,s.payload_digest,s.activity_type,s.observed_from,
                  s.observed_to,s.duration_seconds,s.distance_meters
           FROM healthkit_workout_sample s
           JOIN healthkit_workout_lineage l
             ON l.athlete_id=s.athlete_id AND l.sample_id=s.sample_id
           WHERE s.athlete_id=$1 AND s.state='active' AND l.state='pending_review'
           ORDER BY s.observed_from DESC,s.sample_id ASC LIMIT $2`,
          [athleteId, boundedLimit],
        );
        return healthKitWorkoutReviewResponseSchema.parse({
          items: result.rows.map((value) => {
            const row = reviewRowSchema.parse(value);
            return {
              sampleId: row.sample_id,
              expectedSampleDigest: row.payload_digest,
              kind: activityKind(row.activity_type),
              observedFrom: row.observed_from.toISOString(),
              observedTo: row.observed_to.toISOString(),
              durationSeconds: row.duration_seconds,
              distanceMeters: row.distance_meters,
            };
          }),
        });
      });
    },
    async listLineage(athleteId: string, limit: number): Promise<HealthKitWorkoutLineage[]> {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      const result = await database.tenant(athleteId, (tx) =>
        tx.query(
          `SELECT sample_id,state FROM healthkit_workout_lineage
           WHERE athlete_id=$1 ORDER BY sample_id LIMIT $2`,
          [athleteId, boundedLimit],
        ),
      );
      return result.rows.map((value) => {
        const row = lineageRowSchema.parse(value);
        return { sampleId: row.sample_id, state: row.state };
      });
    },
  };
}
