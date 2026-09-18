import {
  coreEvidenceDependencyManifestSchema,
  type CoreEvidenceDependencyManifest,
} from '@workout/contracts/evidence-dependencies';
import type { Database } from './database.js';

export interface EvidenceDependenciesRepository {
  capture(athleteId: string): Promise<CoreEvidenceDependencyManifest>;
}

/** One statement snapshot of core ledger dependencies, including absent heads and tombstones. */
export function createEvidenceDependenciesRepository(
  database: Database,
): EvidenceDependenciesRepository {
  return {
    capture(athleteId) {
      return database.tenant(athleteId, async (transaction) => {
        const result = await transaction.query(
          `SELECT jsonb_build_object(
            'schemaVersion', 2, 'scope', 'core-ledgers-v2', 'athleteId', $1::text,
            'capturedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'trainingPlan', COALESCE((SELECT jsonb_build_object('kind','exists','versionId',version_id) FROM plan_head WHERE athlete_id=$1), '{"kind":"absent"}'::jsonb),
            'activities', (SELECT jsonb_build_object('count',count(*)::text,'revisionSum',COALESCE(sum(revision),0)::text) FROM activity_canonical WHERE athlete_id=$1),
            'checkIns', COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM check_in_collection_head WHERE athlete_id=$1), '{"kind":"absent"}'::jsonb),
            'sessionCompletions', COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM session_completion_collection_head WHERE athlete_id=$1), '{"kind":"absent"}'::jsonb),
            'userConstraints', COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM coaching_constraint_head WHERE athlete_id=$1), '{"kind":"absent"}'::jsonb),
            'aiConsent', COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision,'granted',granted) FROM consent WHERE athlete_id=$1 AND kind='ai'), '{"kind":"absent"}'::jsonb)
          ) AS manifest`,
          [athleteId],
        );
        return coreEvidenceDependencyManifestSchema.parse(result.rows[0]?.['manifest']);
      });
    },
  };
}
