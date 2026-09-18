import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  accountExportSchema,
  operationsStatusSchema,
  type AccountExport,
  type OperationsStatus,
} from '@workout/contracts/operations';
import type { Database } from './database.js';

export class OperationsError extends Error {
  constructor(readonly code: 'EXPORT_TOO_LARGE' | 'ACCOUNT_ERASED') {
    super(code);
  }
}
export interface OperationsRepository {
  exportAccount(athleteId: string): Promise<AccountExport>;
  eraseAccount(athleteId: string): Promise<{ erased: true }>;
  status(athleteId: string): Promise<OperationsStatus>;
}
/** Export projection must also guard legacy/partially restored rows whose purge trigger did not run. */
function guardedCoachingBody(table: string, evidenceAvailable: string): string {
  const available = `(${evidenceAvailable} AND EXISTS(SELECT 1 FROM consent c
    WHERE c.athlete_id=${table}.athlete_id AND c.kind='ai' AND c.granted))`;
  return `CASE WHEN body IS NOT NULL AND ${available} THEN body ELSE NULL END AS body,
    CASE WHEN body IS NOT NULL AND NOT ${available}
      THEN 'consent_or_evidence_unavailable' ELSE purged_reason END AS purged_reason`;
}
const decisionEvidenceAvailable = `EXISTS(SELECT 1 FROM coaching_run r
  JOIN core_evidence_snapshot e ON e.athlete_id=r.athlete_id AND e.id=r.evidence_snapshot_id
  WHERE r.athlete_id=coaching_decision.athlete_id AND r.id=coaching_decision.run_id
   AND e.body IS NOT NULL)`;
const proposalEvidenceAvailable = `EXISTS(SELECT 1 FROM coaching_decision d
  JOIN coaching_run r ON r.athlete_id=d.athlete_id AND r.id=d.run_id
  JOIN core_evidence_snapshot e ON e.athlete_id=r.athlete_id AND e.id=r.evidence_snapshot_id
  WHERE d.athlete_id=coaching_proposal.athlete_id AND d.id=coaching_proposal.decision_id
   AND e.body IS NOT NULL)`;
const candidateEvidenceAvailable = `EXISTS(SELECT 1 FROM coaching_decision d
  JOIN coaching_run r ON r.athlete_id=d.athlete_id AND r.id=d.run_id
  JOIN core_evidence_snapshot e ON e.athlete_id=r.athlete_id AND e.id=r.evidence_snapshot_id
  WHERE d.athlete_id=coaching_candidate.athlete_id AND d.id=coaching_candidate.decision_id
   AND e.body IS NOT NULL)`;
const candidateAvailable = `(${candidateEvidenceAvailable} AND EXISTS(SELECT 1 FROM consent c
  WHERE c.athlete_id=coaching_candidate.athlete_id AND c.kind='ai' AND c.granted))`;
const collections = [
  [
    'coachingDecisions',
    'coaching_decision',
    `id,run_id,${guardedCoachingBody('coaching_decision', decisionEvidenceAvailable)},created_at`,
    'created_at,id',
  ],
  [
    'coachingProposals',
    'coaching_proposal',
    `id,decision_id,${guardedCoachingBody('coaching_proposal', proposalEvidenceAvailable)},created_at`,
    'created_at,id',
  ],
  [
    'coachingCandidates',
    'coaching_candidate',
    `id,decision_id,proposal_id,parent_candidate_id,
     CASE WHEN body IS NOT NULL AND ${candidateAvailable} THEN digest ELSE NULL END AS digest,
     ${guardedCoachingBody('coaching_candidate', candidateEvidenceAvailable)},created_at`,
    'created_at,id',
  ],
  [
    'coachingRuns',
    'coaching_run',
    'id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis,status,created_at,updated_at',
    'created_at,id',
  ],
  [
    'coachingAnalysisOutputs',
    'coaching_analysis_output',
    `id,run_id,CASE WHEN body IS NOT NULL
       AND EXISTS(SELECT 1 FROM core_evidence_snapshot e JOIN coaching_run run
        ON run.athlete_id=e.athlete_id AND run.evidence_snapshot_id=e.id
        WHERE run.athlete_id=coaching_analysis_output.athlete_id
         AND run.id=coaching_analysis_output.run_id AND e.body IS NOT NULL)
       AND EXISTS(SELECT 1 FROM consent c WHERE c.athlete_id=coaching_analysis_output.athlete_id
        AND c.kind='ai' AND c.granted) THEN body ELSE NULL END AS body,
     CASE WHEN body IS NOT NULL AND (
       NOT EXISTS(SELECT 1 FROM core_evidence_snapshot e JOIN coaching_run run
        ON run.athlete_id=e.athlete_id AND run.evidence_snapshot_id=e.id
        WHERE run.athlete_id=coaching_analysis_output.athlete_id
         AND run.id=coaching_analysis_output.run_id AND e.body IS NOT NULL)
       OR NOT EXISTS(SELECT 1 FROM consent c WHERE c.athlete_id=coaching_analysis_output.athlete_id
        AND c.kind='ai' AND c.granted)) THEN 'consent_or_evidence_unavailable'
      ELSE purged_reason END AS purged_reason,created_at`,
    'created_at,id',
  ],
  [
    'coachingConstraints',
    'coaching_constraint',
    'id,revision,text,confirmed_at,updated_at,deleted',
    'id',
  ],
  ['coachingConstraintHeads', 'coaching_constraint_head', 'revision,updated_at', 'revision'],
  [
    'evidenceSnapshots',
    'core_evidence_snapshot',
    'id,thread_id,created_at,body,purged_reason',
    'created_at,id',
  ],
  [
    'coachingThreads',
    'coaching_thread',
    'id,plan_version_id,title,scope,revision,created_at,updated_at',
    'id',
  ],
  [
    'coachingMessages',
    'coaching_message',
    'id,thread_id,revision,content,created_at',
    'thread_id,revision',
  ],
  [
    'planScenarios',
    'plan_scenario',
    'id,base_plan_version_id,label,revision,created_at,updated_at,draft',
    'id',
  ],
  [
    'planScenarioRevisions',
    'plan_scenario_revision',
    'scenario_id,revision,record_json',
    'scenario_id,revision',
  ],
  [
    'planScenarioApplications',
    'plan_scenario_application',
    'version_id,scenario_id,scenario_revision,previous_version_id,completion_revision,created_at',
    'version_id',
  ],
  ['sessionCompletions', 'session_completion', 'session_id,revision,record_json', 'session_id'],
  [
    'sessionCompletionRevisions',
    'session_completion_revision',
    'session_id,revision,record_json',
    'session_id,revision',
  ],
  ['consents', 'consent', 'kind,granted,revision', 'kind'],
  ['planSnapshots', 'plan_snapshot', 'id,version,created_at,draft', 'version'],
  ['planHead', 'plan_head', 'version_id', 'version_id'],
  ['planHistory', 'plan_history', 'version_id,action', 'version_id'],
  ['activities', 'activity_canonical', 'id,revision,original,deleted', 'id'],
  [
    'activitySources',
    'activity_source_head',
    'kind,source_id,source_revision,content_hash,activity_id',
    'kind,source_id',
  ],
  [
    'sourceRevisions',
    'activity_source_revision',
    'kind,source_id,source_revision,content_hash,normalized_raw,details_json',
    'kind,source_id,source_revision',
  ],
  ['overlays', 'activity_overlay', 'activity_id,values_json', 'activity_id'],
  [
    'overlayRevisions',
    'activity_overlay_revision',
    'activity_id,revision,values_json',
    'activity_id,revision',
  ],
  ['suppressions', 'activity_suppression', 'kind,source_id', 'kind,source_id'],
  [
    'checkIns',
    'check_in',
    'id,revision,values_json,local_date,recorded_at,updated_at,deleted',
    'id',
  ],
  [
    'checkInRevisions',
    'check_in_revision',
    'check_in_id,revision,values_json,reason,created_at',
    'check_in_id,revision',
  ],
] as const;
const maxBytes = 8 * 1024 * 1024;
// Identifiers are a static allowlist; no caller-controlled SQL or authentication tables.
const exportSql = `WITH rows AS MATERIALIZED (${collections.map(([name, table, fields, order]) => `SELECT '${name}' AS collection,to_jsonb(r) AS payload,row_number() OVER () AS ordinal FROM (SELECT ${fields} FROM ${table} WHERE athlete_id=$1 ORDER BY ${order} LIMIT 1001) r`).join(' UNION ALL ')}), sizes AS (SELECT collection,count(*) AS count,sum(octet_length(payload::text)) AS bytes FROM rows GROUP BY collection), valid AS (SELECT coalesce(max(count),0)<=1000 AND coalesce(sum(bytes),0)<=${maxBytes - 65536} AS ok FROM sizes), groups AS (SELECT collection,jsonb_agg(payload ORDER BY ordinal) AS payload FROM rows WHERE (SELECT ok FROM valid) GROUP BY collection) SELECT (SELECT ok FROM valid) AS ok,coalesce(jsonb_object_agg(collection,payload),'{}'::jsonb) AS data FROM groups`;

export function createOperationsRepository(database: Database): OperationsRepository {
  return {
    exportAccount(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        // Serialize export with AI-consent withdrawal and source redaction before reading bodies.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [athleteId]);
        const result = await tx.query(exportSql, [athleteId]);
        const row = z
          .object({
            ok: z.boolean(),
            data: z.record(z.string(), z.array(z.record(z.string(), z.json()))),
          })
          .parse(result.rows[0]);
        if (!row.ok) throw new OperationsError('EXPORT_TOO_LARGE');
        const data = Object.fromEntries(collections.map(([name]) => [name, row.data[name] ?? []]));
        const artifact = accountExportSchema.parse({
          schemaVersion: 9,
          athleteId,
          exportedAt: new Date().toISOString(),
          data,
        });
        if (Buffer.byteLength(JSON.stringify(artifact)) > maxBytes)
          throw new OperationsError('EXPORT_TOO_LARGE');
        await tx.query(
          "INSERT INTO operations_audit(athlete_id,id,action) VALUES($1,$2,'export_requested')",
          [athleteId, randomUUID()],
        );
        return artifact;
      });
    },
    eraseAccount(athleteId) {
      return database.exclusiveTenant(athleteId, async (tx) => {
        await tx.query('SELECT public.erase_account($1)', [athleteId]);
        return { erased: true };
      });
    },
    status(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT clock_timestamp() AS checked_at,
        CASE WHEN public.garmin_pending(clock_timestamp()) THEN 'disconnecting' ELSE coalesce((SELECT CASE WHEN state='disconnected' OR (state='connecting' AND (attempt_expires_at<=clock_timestamp() OR NOT public.garmin_session_active($1,attempt_session_id,clock_timestamp()))) THEN 'not_connected' WHEN state='connected' AND refresh_expires_at<=clock_timestamp() THEN 'reconnect_required' ELSE state END FROM garmin_connection WHERE athlete_id=$1),'not_connected') END AS garmin_state,
        (SELECT jsonb_build_object('pending',count(*) FILTER(WHERE completed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp())),'leased',count(*) FILTER(WHERE completed_at IS NULL AND lease_until>clock_timestamp()),'retrying',count(*) FILTER(WHERE completed_at IS NULL AND attempts>0 AND (lease_until IS NULL OR lease_until<=clock_timestamp())),'completed',count(*) FILTER(WHERE completed_at IS NOT NULL)) FROM outbox WHERE athlete_id=$1) AS outbox,
        (SELECT coalesce(jsonb_agg(a ORDER BY created_at DESC,id),'[]'::jsonb) FROM(SELECT id,action,created_at FROM operations_audit WHERE athlete_id=$1 ORDER BY created_at DESC,id LIMIT 10) a) AS audit`,
          [athleteId],
        );
        const row = z
          .object({
            checked_at: z.date(),
            garmin_state: z.string(),
            outbox: z.unknown(),
            audit: z.array(
              z.object({
                id: z.uuid(),
                action: z.enum(['export_requested', 'account_erased']),
                created_at: z.string(),
              }),
            ),
          })
          .parse(result.rows[0]);
        return operationsStatusSchema.parse({
          checkedAt: row.checked_at.toISOString(),
          outbox: row.outbox,
          providers: { garmin: row.garmin_state, healthkit: 'not_connected' },
          audit: row.audit.map((item) => ({
            id: item.id,
            action: item.action,
            createdAt: item.created_at,
          })),
        });
      });
    },
  };
}
