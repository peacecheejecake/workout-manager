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
  [
    'nutritionPlanVersions',
    'nutrition_plan_version',
    'plan_id,version_id,version,previous_version_id,period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json',
    'plan_id,version',
  ],
  ['nutritionPlanHeads', 'nutrition_plan_head', 'plan_id,version,version_id', 'plan_id'],
  [
    'nutritionPlanHistory',
    'nutrition_plan_history',
    'plan_id,version_id,approval_id,action,created_at',
    'plan_id,created_at',
  ],
  [
    'foodDefinitionVersions',
    'food_definition_version',
    'food_id,version_id,version,previous_version_id,created_at,record_json',
    'food_id,version',
  ],
  ['foodDefinitionHeads', 'food_definition_head', 'food_id,version,version_id', 'food_id'],
  ['intakeEntries', 'intake_entry', 'id,current_revision,current_revision_id,status', 'id'],
  [
    'intakeEntryRevisions',
    'intake_entry_revision',
    'intake_id,revision,revision_id,status,occurred_at,recorded_at,deleted_at,deletion_reason,record_json',
    'intake_id,revision',
  ],
  [
    'supplementaryExerciseVersions',
    'supplementary_exercise_version',
    'exercise_id,version_id,version,previous_version_id,previous_version,created_at,record_json',
    'exercise_id,version',
  ],
  [
    'supplementaryExerciseHeads',
    'supplementary_exercise_head',
    'exercise_id,version,version_id',
    'exercise_id',
  ],
  [
    'supplementaryRoutineVersions',
    'supplementary_routine_version',
    'routine_id,version_id,version,previous_version_id,previous_version,created_at,record_json',
    'routine_id,version',
  ],
  [
    'supplementaryRoutineHeads',
    'supplementary_routine_head',
    'routine_id,version,version_id',
    'routine_id',
  ],
  [
    'supplementaryRoutineTargetRefs',
    'supplementary_routine_target_ref',
    'routine_version_id,block_id,target_set_id,exercise_version_id',
    'routine_version_id,target_set_id',
  ],
  [
    'supplementarySessionLinks',
    'supplementary_session_link',
    'plan_version_id,planned_session_id,content_kind,routine_version_id,embedded_spec_json',
    'plan_version_id,planned_session_id',
  ],
  [
    'supplementarySessionTargetRefs',
    'supplementary_session_target_ref',
    'plan_version_id,planned_session_id,block_id,target_set_id,exercise_version_id',
    'plan_version_id,planned_session_id,target_set_id',
  ],
  [
    'supplementaryExecutions',
    'supplementary_execution',
    'id,activity_id,plan_version_id,planned_session_id,revision,status,started_at,ended_at',
    'id',
  ],
  [
    'supplementarySetLogs',
    'supplementary_set_log',
    'id,execution_id,activity_id,current_revision,current_revision_id,status',
    'id',
  ],
  [
    'supplementarySetLogRevisions',
    'supplementary_set_log_revision',
    'log_id,execution_id,activity_id,revision,revision_id,status,state,occurred_at,recorded_at,deleted_at,deletion_reason,record_json',
    'log_id,revision',
  ],
  [
    'supplementaryRestTimers',
    'supplementary_rest_timer',
    'id,execution_id,revision,duration_seconds,status,started_at,deadline_at,paused_at,remaining_when_paused_seconds',
    'id',
  ],
  [
    'resources',
    '(SELECT * FROM resource WHERE deleted_at IS NULL) resource',
    'id,source_kind,title,category,metadata,tags,favorite,include_for_coach,reviewed_state,reviewed_at,reviewed_version_id,coach_use_enabled_at,access_revision,current_version,current_version_id,created_at,updated_at,deleted_at',
    'created_at,id',
  ],
  [
    'resourceShares',
    `(SELECT s.* FROM resource_share s JOIN resource active
      ON active.athlete_id=s.athlete_id AND active.id=s.resource_id
      WHERE active.deleted_at IS NULL) resource_share`,
    'share_id,resource_id,grantee_kind,grantee_principal_id,state,granted_access_revision,revoked_access_revision,granted_at,revoked_at,updated_at',
    'granted_at,share_id',
  ],
  [
    'resourceAccessAudit',
    `(SELECT a.* FROM resource_access_audit a JOIN resource active
      ON active.athlete_id=a.athlete_id AND active.id=a.resource_id
      WHERE active.deleted_at IS NULL) resource_access_audit`,
    'event_id,resource_id,action,access_revision,share_id,grantee_kind,grantee_principal_id,occurred_at',
    'occurred_at,event_id',
  ],
  [
    'resourceVersions',
    `(SELECT v.* FROM resource_version v JOIN resource active
      ON active.athlete_id=v.athlete_id AND active.id=v.resource_id
      WHERE active.deleted_at IS NULL) resource_version`,
    'resource_id,version_id,version,previous_version,previous_version_id,content,content_hash,paragraphs,content_status,index_status,original_filename,media_type,size_bytes,created_at',
    'resource_id,version',
  ],
  [
    'resourceUrlIngestions',
    `(SELECT i.athlete_id,i.request_id,i.operation,i.resource_id,i.version_id,
      i.expected_current_version_id,i.display_url,i.title,i.category,i.metadata,i.tags,i.favorite,
      i.state,i.failure_phase,i.failure_code,i.failure_retryable,i.attempt_count,i.retry_at,
      i.created_at,i.updated_at,i.finalized_at
      FROM resource_url_ingestion i LEFT JOIN resource active
      ON active.athlete_id=i.athlete_id AND active.id=i.resource_id
      WHERE active.deleted_at IS NULL AND (active.id IS NOT NULL OR i.operation='create')) resource_url_ingestion`,
    'request_id,operation,resource_id,version_id,expected_current_version_id,display_url,title,category,metadata,tags,favorite,state,failure_phase,failure_code,failure_retryable,attempt_count,retry_at,created_at,updated_at,finalized_at',
    'created_at,request_id',
  ],
  [
    'resourceUrlAttempts',
    `(SELECT a.athlete_id,a.request_id,a.attempt_no,a.phase,a.status,a.failure_code,a.started_at,
      a.completed_at
      FROM resource_url_ingestion_attempt a JOIN resource_url_ingestion i
      ON i.athlete_id=a.athlete_id AND i.request_id=a.request_id LEFT JOIN resource active
      ON active.athlete_id=i.athlete_id AND active.id=i.resource_id
      WHERE active.deleted_at IS NULL AND (active.id IS NOT NULL OR i.operation='create')) resource_url_ingestion_attempt`,
    'request_id,attempt_no,phase,status,failure_code,started_at,completed_at',
    'request_id,attempt_no',
  ],
  [
    'resourceUrlFetchHops',
    `(SELECT h.athlete_id,h.request_id,h.attempt_no,h.hop_index,h.display_url,h.response_status,
      h.policy_version,h.observed_at
      FROM resource_url_fetch_hop h JOIN resource_url_ingestion i
      ON i.athlete_id=h.athlete_id AND i.request_id=h.request_id LEFT JOIN resource active
      ON active.athlete_id=i.athlete_id AND active.id=i.resource_id
      WHERE active.deleted_at IS NULL AND (active.id IS NOT NULL OR i.operation='create')) resource_url_fetch_hop`,
    'request_id,attempt_no,hop_index,display_url,response_status,policy_version,observed_at',
    'request_id,attempt_no,hop_index',
  ],
  [
    'resourceUrlArtifacts',
    `(SELECT a.athlete_id,a.artifact_id,a.resource_id,a.version_id,a.request_id,a.kind,
      a.size_bytes,a.media_type,a.derived_from_artifact_id,a.created_at
      FROM resource_url_artifact a JOIN resource active
      ON active.athlete_id=a.athlete_id AND active.id=a.resource_id
      WHERE active.deleted_at IS NULL) resource_url_artifact`,
    'artifact_id,resource_id,version_id,request_id,kind,size_bytes,media_type,derived_from_artifact_id,created_at',
    'resource_id,version_id,kind',
  ],
  [
    'resourceUrlProvenance',
    `(SELECT p.athlete_id,p.resource_id,p.version_id,p.request_id,p.successful_attempt_no,
      p.display_url,p.final_display_url,p.fetch_policy_version,p.fetched_at
      FROM resource_url_provenance p JOIN resource active
      ON active.athlete_id=p.athlete_id AND active.id=p.resource_id
      WHERE active.deleted_at IS NULL) resource_url_provenance`,
    'resource_id,version_id,request_id,successful_attempt_no,display_url,final_display_url,fetch_policy_version,fetched_at',
    'resource_id,version_id',
  ],
  [
    'resourceUrlLocators',
    `(SELECT l.athlete_id,l.version_id,l.ordinal,l.kind,l.heading_path,l.paragraph_index,
      l.page_number,l.start_offset,l.end_offset,l.text
      FROM resource_url_locator l JOIN resource_version v
      ON v.athlete_id=l.athlete_id AND v.version_id=l.version_id JOIN resource active
      ON active.athlete_id=v.athlete_id AND active.id=v.resource_id
      WHERE active.deleted_at IS NULL) resource_url_locator`,
    'version_id,ordinal,kind,heading_path,paragraph_index,page_number,start_offset,end_offset,text',
    'version_id,ordinal',
  ],
  [
    'resourcePassages',
    `(SELECT p.* FROM resource_passage p JOIN resource active
      ON active.athlete_id=p.athlete_id AND active.id=p.resource_id
      WHERE active.deleted_at IS NULL) resource_passage`,
    `passage_id,resource_id,version_id,ordinal,first_paragraph_index,last_paragraph_index,
     start_offset,end_offset,heading_path,content_hash,indexed_access_revision,created_at`,
    'resource_id,version_id,ordinal',
  ],
  [
    'resourceGroundings',
    'resource_grounding',
    `grounding_id,run_id,query_text,excerpt_count,manifest->>'entriesDigest' AS entries_digest,
     captured_at`,
    'captured_at,grounding_id',
  ],
  [
    'resourceGroundingExcerpts',
    'resource_grounding_excerpt',
    'grounding_id,ordinal,passage_id,resource_id,version_id,access_revision',
    'grounding_id,ordinal',
  ],
  [
    'resourceCitations',
    'resource_citation',
    `citation_id,grounding_id,passage_id,resource_id,version_id,claim_index,quote_start,
     quote_end,quote_hash,created_at`,
    'created_at,citation_id',
  ],
  [
    'galleryMediaItems',
    `(SELECT m.athlete_id,m.id,m.media_kind,m.visibility,m.include_for_coach,m.album,m.caption,
      m.activity_id,m.captured_at,m.captured_local_date,m.original_filename,m.media_type,
      m.size_bytes,m.content_hash,m.access_revision,m.created_at,m.updated_at
      FROM gallery_media_item m WHERE m.deleted_at IS NULL) gallery_media_item`,
    `id,media_kind,visibility,include_for_coach,album,caption,activity_id,captured_at,
     captured_local_date,original_filename,media_type,size_bytes,content_hash,access_revision,
     created_at,updated_at`,
    'created_at,id',
  ],
  [
    'galleryMediaDerivatives',
    `(SELECT d.athlete_id,d.media_item_id,d.kind,d.media_type,d.size_bytes,d.content_hash,d.created_at
      FROM gallery_media_derivative d JOIN gallery_media_item m
        ON m.athlete_id=d.athlete_id AND m.id=d.media_item_id
      WHERE m.deleted_at IS NULL) gallery_media_derivative`,
    'media_item_id,kind,media_type,size_bytes,content_hash,created_at',
    'media_item_id,kind',
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
          schemaVersion: 17,
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
