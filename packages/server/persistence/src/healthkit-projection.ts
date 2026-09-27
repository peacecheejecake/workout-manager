import { z } from 'zod';
import type { Database } from './database.js';

const lineageRowSchema = z.object({
  sample_id: z.uuid(),
  state: z.enum(['pending_review', 'suppressed', 'deleted']),
});

export type HealthKitWorkoutLineage = {
  sampleId: string;
  state: 'pending_review' | 'suppressed' | 'deleted';
};

/** Owner-scoped review queue facts; this is never a canonical Activity query. */
export function createHealthKitProjectionRepository(database: Database) {
  return {
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
