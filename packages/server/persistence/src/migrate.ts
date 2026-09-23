import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const migrationFiles = [
  '001_foundation.sql',
  '002_identity.sql',
  '003_plan.sql',
  '004_activities.sql',
  '005_operations.sql',
  '006_garmin.sql',
  '007_check_ins.sql',
  '008_manual_activities.sql',
  '009_activity_details.sql',
  '010_session_completion.sql',
  '011_plan_scenarios.sql',
  '012_coaching_threads.sql',
  '013_evidence_snapshots.sql',
  '014_coaching_constraints.sql',
  '015_evidence_constraints.sql',
  '016_plan_scenario_labels.sql',
  '017_coaching_runs.sql',
  '018_coaching_candidates.sql',
  '019_coaching_candidate_approval.sql',
  '020_nutrition_core.sql',
  '021_supplementary_core.sql',
  '022_integrated_dependency_heads.sql',
  '023_routine_core.sql',
  '024_stretching.sql',
  '025_recovery_core.sql',
  '026_integrated_approval_v4.sql',
  '027_resource_lifecycle.sql',
  '028_resource_file_upload.sql',
  '029_resource_url_ingestion.sql',
  '030_resource_access_sharing.sql',
  '031_gallery_media.sql',
  '032_resource_retrieval.sql',
  '033_activity_track_storage.sql',
  '034_course_ledger.sql',
  '035_course_route_proposal.sql',
  '036_course_target_distance_candidates.sql',
  '037_course_preferences_and_privacy_zones.sql',
  '038_course_thumbnails.sql',
  '039_course_thumbnail_reconciliation.sql',
] as const;

async function grantSafeResourceUrlReadColumns(pool: Pool, runtimeRole: string) {
  await pool.query(
    `REVOKE SELECT ON resource_url_ingestion,resource_url_ingestion_attempt,resource_url_fetch_hop,
     resource_url_artifact,resource_url_provenance,resource_url_locator FROM "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT SELECT(athlete_id,request_id,idempotency_key,request_digest,operation,resource_id,version_id,
       expected_current_version_id,display_url,title,category,metadata,tags,favorite,state,failure_code,
       failure_phase,failure_retryable,failed_at,retry_at,attempt_count,parser_name,parser_version,
       created_at,updated_at,expires_at,finalized_at) ON resource_url_ingestion TO "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT SELECT(athlete_id,request_id,attempt_no,phase,status,failure_code,started_at,completed_at)
       ON resource_url_ingestion_attempt TO "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT SELECT(athlete_id,request_id,attempt_no,hop_index,display_url,response_status,policy_version,observed_at)
       ON resource_url_fetch_hop TO "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT SELECT(athlete_id,artifact_id,resource_id,version_id,request_id,kind,content_hash,size_bytes,
       media_type,derived_from_artifact_id,created_at) ON resource_url_artifact TO "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT SELECT(athlete_id,resource_id,version_id,request_id,successful_attempt_no,display_url,
       final_display_url,fetch_policy_version,fetched_at) ON resource_url_provenance TO "${runtimeRole}"`,
  );
  await pool.query(`GRANT SELECT ON resource_url_locator TO "${runtimeRole}"`);
}

/** Run with deployment credentials; runtime credentials receive only table DML grants. */
export async function migrate(
  connectionString: string,
  throughVersion: number = migrationFiles.length,
): Promise<void> {
  if (
    !Number.isInteger(throughVersion) ||
    throughVersion < 1 ||
    throughVersion > migrationFiles.length
  )
    throw new Error('INVALID_MIGRATION_VERSION');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(872194, 1)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
    );
    for (const [index, file] of migrationFiles.slice(0, throughVersion).entries()) {
      const version = index + 1;
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (existing.rows.length === 0) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [
          version,
          checksum,
        ]);
      } else if (existing.rows[0]?.checksum !== checksum) {
        throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/** Tenant API access excludes global credential cleanup reads. */
export async function grantGarmin(connectionString: string, runtimeRole: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON garmin_connection,garmin_attempt TO "${runtimeRole}"`,
    );
    for (const signature of [
      'garmin_session_active(text,text,timestamptz)',
      'garmin_pending(timestamptz)',
      'garmin_claim_user(text,timestamptz)',
      'garmin_queue_revoke(jsonb,text,timestamptz,timestamptz,timestamptz)',
      'garmin_disconnect(timestamptz)',
    ]) {
      await pool.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`);
    }
  } finally {
    await pool.end();
  }
}

/** Dedicated cleanup role receives function-only, bounded queue access. */
export async function grantGarminWorker(
  connectionString: string,
  workerRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(workerRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, max: 1 });
  try {
    for (const signature of [
      'garmin_lease_revocation(uuid,timestamptz,timestamptz)',
      'garmin_prepare_revocation(uuid,uuid,text,timestamptz)',
      'garmin_update_revocation(uuid,uuid,jsonb,timestamptz,timestamptz,timestamptz)',
      'garmin_finish_revocation(uuid,uuid,boolean,timestamptz)',
    ]) {
      await pool.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${workerRole}"`);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Reads the coaching path needs once retrieval exists. The gate function stays
 * the only authorization source, so it is granted alongside the derived stores
 * rather than replaced by direct table predicates.
 */
async function grantResourceRetrievalReads(pool: Pool, role: string) {
  await pool.query(
    `GRANT SELECT ON resource_passage,resource_retrieval_cache,resource_grounding,
     resource_grounding_excerpt,resource_citation TO "${role}"`,
  );
  // The resource RLS policy itself reads resource_share, so reading a resource
  // row requires SELECT on the share ledger as well.
  await pool.query(`GRANT SELECT ON resource,resource_version,resource_share,consent TO "${role}"`);
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.resource_coach_use_authorized(uuid),
     public.resource_derived_cleanup_pending(uuid) TO "${role}"`,
  );
}

/** Narrow runtime grants for the lifecycle gate and audited account operations. */
export async function grantOperations(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(`GRANT SELECT ON tenant_erasure TO "${runtimeRole}"`);
    await pool.query(
      `GRANT SELECT ON consent,plan_snapshot,plan_head,plan_history,
       activity_canonical,activity_source_head,activity_source_revision,
       activity_overlay,activity_overlay_revision,activity_suppression TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT ON plan_scenario,plan_scenario_revision,plan_scenario_application,coaching_thread,coaching_message,core_evidence_snapshot,coaching_constraint,coaching_constraint_head,coaching_run,coaching_analysis_output,coaching_decision,coaching_proposal,coaching_candidate TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT,INSERT ON operations_audit TO "${runtimeRole}"`);
    await pool.query(
      `GRANT SELECT ON garmin_connection,check_in,check_in_revision,session_completion,session_completion_revision,session_completion_collection_head TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT ON nutrition_plan_version,nutrition_plan_head,nutrition_plan_history,food_definition_version,food_definition_head,intake_entry,intake_entry_revision TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT ON supplementary_exercise_version,supplementary_exercise_head,supplementary_routine_version,supplementary_routine_head,supplementary_routine_target_ref,supplementary_session_link,supplementary_session_target_ref,supplementary_execution,supplementary_set_log,supplementary_set_log_revision,supplementary_rest_timer TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT ON integrated_dependency_head TO "${runtimeRole}"`);
    await pool.query(
      `GRANT SELECT ON resource,resource_version,resource_object,resource_share,
       resource_access_audit TO "${runtimeRole}"`,
    );
    await grantSafeResourceUrlReadColumns(pool, runtimeRole);
    await pool.query(
      `GRANT SELECT ON gallery_media_item,gallery_media_derivative TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT ON resource_passage,resource_grounding,resource_grounding_excerpt,
       resource_citation TO "${runtimeRole}"`,
    );
    // Track metadata only. Storage references are never part of the export projection.
    await pool.query(`GRANT SELECT ON activity_track,activity_track_revision TO "${runtimeRole}"`);
    // Course identity, conditions and lineage. Geometry is not part of the projection.
    await pool.query(
      `GRANT SELECT ON course,course_revision,course_revision_source TO "${runtimeRole}"`,
    );
    // The account export reads the owner's own preferences and protected areas (M2-01j,
    // export v20). Read only: the export never writes either of them.
    await pool.query(`GRANT SELECT ON course_preference,course_privacy_zone TO "${runtimeRole}"`);
    // Stored thumbnail facts (M2-01l, export v21). Read only, and the projection carries no
    // storage reference and no bytes.
    await pool.query(`GRANT SELECT ON course_thumbnail TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.garmin_session_active(text,text,timestamptz) TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.garmin_pending(timestamptz) TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT EXECUTE ON FUNCTION public.erase_account(text) TO "${runtimeRole}"`);
  } finally {
    await pool.end();
  }
}

/** Manual nutrition ledgers are tenant-scoped; historical versions remain append-only. */
export async function grantNutritionCore(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON nutrition_plan_version,nutrition_plan_history,food_definition_version,intake_entry_revision TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE ON nutrition_plan_head,food_definition_head,intake_entry TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Frozen prescriptions are append-only; current pointers and actuals advance by CAS. */
export async function grantSupplementaryCore(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON supplementary_exercise_version,supplementary_routine_version,supplementary_set_log_revision,supplementary_session_link TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE ON supplementary_exercise_head,supplementary_routine_head,supplementary_execution,supplementary_set_log,supplementary_rest_timer TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Routine versions and receipts are append-only; current heads, runs and timers use CAS. */
export async function grantRoutineCore(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON routine_blueprint_version,routine_schedule_version,routine_occurrence,routine_run_revision,routine_checklist_confirmation,routine_command_receipt TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE ON routine_blueprint_head,routine_schedule_head,routine_run,routine_step_timer TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Stretching profiles and revisions are immutable; only the current log advances. */
export async function grantStretchingCore(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON stretch_profile,stretching_log_revision TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT,INSERT,UPDATE ON stretching_log TO "${runtimeRole}"`);
  } finally {
    await pool.end();
  }
}

/** Recovery method, strategy and action revisions stay append-only. */
export async function grantRecoveryCore(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON recovery_method_version,recovery_strategy_version,recovery_action_revision TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE ON recovery_method_head,recovery_strategy_head,recovery_action_log TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Private resource metadata is mutable by CAS; text versions are append-only. */
export async function grantResources(connectionString: string, runtimeRole: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON resource,resource_version,resource_object,resource_upload_intent TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT INSERT ON resource_url_ingestion TO "${runtimeRole}"`);
    await grantSafeResourceUrlReadColumns(pool, runtimeRole);
    await pool.query(
      `GRANT SELECT,INSERT ON resource_share,resource_access_audit TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT ON consent TO "${runtimeRole}"`);
    await pool.query(
      `GRANT UPDATE(current_version,current_version_id,access_revision,updated_at,deleted_at,
       include_for_coach,reviewed_state,reviewed_at,reviewed_version_id,coach_use_enabled_at)
       ON resource TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT UPDATE(state,revoked_at,revoked_access_revision,updated_at)
       ON resource_share TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT,INSERT ON command_receipt,outbox TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.tombstone_resource_receipts(uuid)
       TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT UPDATE(idempotency_key) ON outbox TO "${runtimeRole}"`);
    await pool.query(
      `GRANT UPDATE(storage_ref,original_filename,media_type,size_bytes,content_hash,state,
       failure_code,updated_at,prepared_at,staged_at,finalized_at) ON resource_upload_intent TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.enqueue_resource_object_cleanup(uuid,text),
       public.fail_resource_upload(uuid,text),public.expire_resource_uploads(timestamptz),
       public.cancel_resource_uploads(uuid,text),public.protect_resource_upload_object(uuid),
       public.compact_resource_upload_history(integer)
       TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.cancel_resource_url_ingestion(uuid,text),
       public.resource_url_request_by_key(text),public.current_resource_url_request(uuid)
       TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.enqueue_resource_derived_cleanup(uuid,text),
       public.resource_coach_use_authorized(uuid),public.resource_derived_cleanup_pending(uuid),
       public.revoke_resource_shares(uuid,text)
       TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Retrieval reads and writes only derived stores; the gate stays a function call. */
export async function grantResourceRetrieval(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT INSERT,DELETE ON resource_passage,resource_retrieval_cache,
       resource_grounding,resource_grounding_excerpt,resource_citation TO "${runtimeRole}"`,
    );
    // A cache entry is replaced in place when the same key is retrieved again.
    await pool.query(
      `GRANT UPDATE(corpus_version,authorization_digest,passage_ids,created_at,expires_at)
       ON resource_retrieval_cache TO "${runtimeRole}"`,
    );
    await grantResourceRetrievalReads(pool, runtimeRole);
  } finally {
    await pool.end();
  }
}

/** URL ingestion workers receive only bounded, token-fenced function access. */
export async function grantResourceUrlIngestionWorker(
  connectionString: string,
  workerRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(workerRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.lease_resource_url_ingestion(uuid,interval),
       public.record_resource_url_hop(uuid,uuid,integer,text,text,integer,inet[],text),
       public.prepare_resource_url_raw(uuid,uuid,text,text,bigint,text),
       public.mark_resource_url_raw_published(uuid,uuid),
       public.prepare_resource_url_parsed(uuid,uuid,text,text,bigint,text,jsonb,text,text),
       public.mark_resource_url_parsed_published(uuid,uuid),
       public.enqueue_abandoned_resource_url_object(text,uuid,uuid,text),
       public.finalize_resource_url_ingestion(uuid,uuid),
       public.mark_resource_url_bookmark_only(uuid,uuid,text,text),
       public.fail_resource_url_ingestion(uuid,uuid,text,boolean,interval),
       public.reap_resource_url_ingestions(integer)
       TO "${workerRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * The course-thumbnail render worker (M2-01l).
 *
 * It gets EXECUTE on eight bounded functions and **no table access at all**, so the only
 * thing it can see of a tenant is the line it has been handed to draw, and the only things
 * it can do with it are prepare, publish, refuse or fail. It cannot read a course name, a
 * protected area, another tenant's row or an object key it was not given.
 */
export async function grantCourseThumbnailWorker(
  connectionString: string,
  workerRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(workerRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.lease_course_thumbnail_render(uuid,interval),
       public.prepare_course_thumbnail(uuid,uuid,text,text,bigint,integer),
       public.course_thumbnail_publication_fence_open(uuid,uuid),
       public.finalize_course_thumbnail(uuid,uuid),
       public.release_course_thumbnail_render(uuid,uuid),
       public.mark_course_thumbnail_unavailable(uuid,uuid,text),
       public.fail_course_thumbnail(uuid,uuid,text,boolean,interval),
       public.requeue_course_thumbnail_refs(uuid)
       TO "${workerRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Cleanup workers see only leased opaque refs through bounded functions. */
export async function grantResourceObjectCleanupWorker(
  connectionString: string,
  workerRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(workerRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.lease_resource_object_cleanup(uuid,timestamptz,timestamptz),
       public.authorize_resource_object_cleanup(uuid,uuid,timestamptz),
       public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz),
       public.reap_expired_resource_uploads(timestamptz,integer),
       public.prune_resource_upload_history(integer),public.prune_resource_cleanup_history(integer),
       public.lease_resource_derived_cleanup(uuid,timestamptz,timestamptz),
       public.finish_resource_derived_cleanup(uuid,uuid,boolean,text),
       public.release_resource_derived_cleanup(uuid,uuid,text),
       public.prune_resource_derived_cleanup_history(integer),
       public.activity_track_reconcile_cursor(),
       public.activity_track_reconcile_candidates(text,integer),
       public.settle_activity_track_object_ref(text),
       public.advance_activity_track_reconcile_cursor(text),
       public.reclaim_unreferenced_activity_track_object(text),
       public.purge_resource_derived_store(uuid,uuid,text),
       public.prune_resource_retrieval_cache(integer),
       public.reap_course_thumbnail_renders(integer),
       public.prune_course_thumbnail_history(integer),
       public.course_thumbnail_reconcile_cursor(),
       public.advance_course_thumbnail_reconcile_cursor(text),
       public.course_thumbnail_reconcile_candidates(text,integer),
       public.settle_course_thumbnail_object_ref(text),
       public.reclaim_unreferenced_course_thumbnail_object(text)
       TO "${workerRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Alternatives have independent heads; immutable revisions and applications are append-only. */
export async function grantPlanScenarios(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(`GRANT SELECT,INSERT,UPDATE ON plan_scenario TO "${runtimeRole}"`);
    await pool.query(
      `GRANT SELECT,INSERT ON plan_scenario_revision,plan_scenario_application TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Grant only the pre-tenant authentication function surface, using deployment credentials. */
export async function grantIdentityFunctions(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    for (const signature of [
      'auth_create_attempt(text, text, text, text, timestamptz)',
      'auth_consume_attempt(text, text, timestamptz)',
      'auth_create_session(text, text, text, text, timestamptz, timestamptz, text)',
      'auth_find_session(text, timestamptz)',
      'auth_revoke_session(text)',
    ]) {
      await pool.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`);
    }
  } finally {
    await pool.end();
  }
}

/** Self-report storage: no private identity access or table ownership. */
export async function grantCheckIns(connectionString: string, runtimeRole: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE ON check_in,check_in_collection_head TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT,INSERT,DELETE ON check_in_revision TO "${runtimeRole}"`);
    await pool.query(`GRANT SELECT,INSERT ON check_in_receipt TO "${runtimeRole}"`);
  } finally {
    await pool.end();
  }
}

/** Separate user confirmations share planning serialization but never write activity tables. */
export async function grantSessionCompletions(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE ON session_completion,session_completion_collection_head TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT,INSERT ON session_completion_revision,session_completion_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** User conversations: immutable scope/messages, only the conversation head advances. */
export async function grantCoachingThreads(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(`GRANT SELECT,INSERT ON coaching_thread,coaching_message TO "${runtimeRole}"`);
    await pool.query(`GRANT UPDATE(revision,updated_at) ON coaching_thread TO "${runtimeRole}"`);
  } finally {
    await pool.end();
  }
}

/** Stored core evidence is append-only; lifecycle triggers alone scrub withdrawn content. */
export async function grantCoreEvidenceSnapshots(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(`GRANT SELECT,INSERT ON core_evidence_snapshot TO "${runtimeRole}"`);
    await pool.query(
      `GRANT SELECT ON coaching_constraint,coaching_constraint_head TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Run endpoints need only metadata; account export grants tenant-scoped output reads separately. */
export async function grantCoachingRuns(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(`GRANT SELECT,INSERT ON coaching_run TO "${runtimeRole}"`);
    await pool.query(`GRANT UPDATE(status,updated_at) ON coaching_run TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.coaching_run_status_valid(jsonb) TO "${runtimeRole}"`,
    );
    // A run may be grounded on reviewed resources, so the run path reads and
    // pins the derived stores as well.
    await pool.query(
      `GRANT INSERT,DELETE ON resource_passage,resource_retrieval_cache,resource_grounding,
       resource_grounding_excerpt,resource_citation TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT UPDATE(corpus_version,authorization_digest,passage_ids,created_at,expires_at)
       ON resource_retrieval_cache TO "${runtimeRole}"`,
    );
    await grantResourceRetrievalReads(pool, runtimeRole);
  } finally {
    await pool.end();
  }
}

/** Validated coaching records are immutable; runtime can only append and read them. */
export async function grantCoachingCandidates(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON coaching_decision,coaching_proposal,coaching_candidate TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT ON coaching_analysis_output TO "${runtimeRole}"`);
    // Approval revalidates the resource-access half of the dependency manifest.
    await grantResourceRetrievalReads(pool, runtimeRole);
  } finally {
    await pool.end();
  }
}

/** Schema v4 approval audit rows are append-only and tenant scoped. */
export async function grantIntegratedApprovalV4(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON integrated_candidate_v4,integrated_approval_v4,recovery_strategy_history,routine_schedule_history TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Worker-only write grants; API composition must not call this with its general route role. */
export async function grantCoachingRunWorker(
  connectionString: string,
  workerRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(workerRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(`GRANT SELECT ON outbox,coaching_run TO "${workerRole}"`);
    await pool.query(
      `GRANT UPDATE(lease_token,lease_until,attempts,completed_at,available_at) ON outbox TO "${workerRole}"`,
    );
    await pool.query(`GRANT UPDATE(status,updated_at) ON coaching_run TO "${workerRole}"`);
    await pool.query(`GRANT INSERT ON coaching_analysis_output TO "${workerRole}"`);
    // The worker re-authorizes pinned excerpts and writes validated citations.
    await pool.query(`GRANT INSERT ON resource_citation TO "${workerRole}"`);
    await grantResourceRetrievalReads(pool, workerRole);
    await pool.query(
      `GRANT SELECT ON coaching_thread,core_evidence_snapshot,plan_head,activity_canonical,
       check_in_collection_head,session_completion_collection_head,coaching_constraint_head,consent,tenant_erasure
       TO "${workerRole}"`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.coaching_run_status_valid(jsonb) TO "${workerRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** User-confirmed statements allow correction and scrubbing, never runtime hard deletion. */
export async function grantCoachingConstraints(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE ON coaching_constraint,coaching_constraint_head TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * Stored recorded tracks are tenant scoped and their objects stay behind opaque refs.
 * The runtime role may append revisions and advance the head; it may never update or
 * delete a revision, and it has no DELETE on any track table — reclaiming bytes is the
 * cleanup worker's job through the shared manifest.
 */
export async function grantActivityTracks(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON activity_track,activity_track_revision,activity_track_object,
       activity_track_upload_intent,activity_track_object_ref TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT UPDATE(track_revision,revision_id,updated_at) ON activity_track TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT UPDATE(raw_storage_ref,normalized_storage_ref,map_path_storage_ref,format,
       recorded_source_kind,parser_id,parser_version,correspondence_digest,original_filename,
       raw_size_bytes,raw_content_hash,normalized_size_bytes,normalized_content_hash,
       map_path_size_bytes,map_path_content_hash,sample_count,positioned_sample_count,
       segment_count,segment_policy,distances,state,failure_code,publication_lease_until,
       updated_at,prepared_at,staged_at,finalized_at) ON activity_track_upload_intent TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT ON activity_canonical,activity_source_head,activity_suppression TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT,INSERT ON command_receipt,outbox TO "${runtimeRole}"`);
    await pool.query(`GRANT UPDATE(idempotency_key) ON outbox TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.expire_activity_track_uploads(timestamptz),
       public.fail_activity_track_upload(uuid,text),
       public.cancel_activity_track_uploads(text,uuid,text),
       public.protect_activity_track_upload_objects(uuid),
       public.supersede_activity_track_upload_objects(uuid),
       public.requeue_activity_track_upload_refs(uuid),
       public.activity_track_publication_fence_open(uuid),
       public.activity_track_pending_cleanup_bytes(),
       public.compact_activity_track_upload_history(integer)
       TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/** Gallery media metadata is tenant scoped; objects stay behind opaque refs. */
export async function grantGalleryMedia(
  connectionString: string,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON gallery_media_item,gallery_media_derivative,gallery_media_object,
       gallery_upload_intent TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT UPDATE(album,caption,activity_id,access_revision,updated_at,deleted_at)
       ON gallery_media_item TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT UPDATE(storage_ref,original_filename,media_type,size_bytes,content_hash,state,
       failure_code,updated_at,prepared_at,staged_at,finalized_at)
       ON gallery_upload_intent TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT ON activity_canonical TO "${runtimeRole}"`);
    await pool.query(`GRANT SELECT,INSERT ON command_receipt,outbox TO "${runtimeRole}"`);
    await pool.query(`GRANT UPDATE(idempotency_key) ON outbox TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.expire_gallery_uploads(timestamptz),
       public.fail_gallery_upload(uuid,text),public.cancel_gallery_uploads(uuid,text),
       public.protect_gallery_upload_object(uuid),
       public.enqueue_gallery_media_cleanup(uuid,text),
       public.compact_gallery_upload_history(integer),
       public.tombstone_gallery_media_receipts(uuid)
       TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * Private course ledger. The runtime role may read, append revisions and advance a head;
 * it has no DELETE anywhere and no UPDATE on the status columns, so reclaiming a course
 * and removing one are only possible through the bounded functions below.
 */
export async function grantCourses(connectionString: string, runtimeRole: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_ROLE_NAME');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query(
      `GRANT SELECT,INSERT ON course,course_revision,course_revision_source TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT UPDATE(name,head_revision,revision_id,updated_at) ON course TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT SELECT ON activity_canonical,activity_source_head,activity_suppression,
       activity_track,activity_track_revision TO "${runtimeRole}"`,
    );
    await pool.query(`GRANT SELECT,INSERT ON command_receipt,outbox TO "${runtimeRole}"`);
    await pool.query(`GRANT UPDATE(idempotency_key) ON outbox TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.delete_course(uuid,integer),
       public.courses_affected_by_activity_deletion(uuid),
       public.activity_course_impact(uuid),
       public.activity_course_impact_digest(uuid) TO "${runtimeRole}"`,
    );
    // Route proposals: the runtime role may write one and read its own. It has neither
    // UPDATE nor DELETE, so consuming one and reaping expired ones happen only through the
    // bounded functions, and a saved proposal cannot be quietly rewritten or re-used.
    await pool.query(`GRANT SELECT,INSERT ON course_route_proposal TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION
       public.consume_course_route_proposal(uuid,uuid,integer,text,integer),
       public.reap_course_route_proposals() TO "${runtimeRole}"`,
    );
    // Target-distance searches (M2-01i) follow the same rule: write one, read your own, and
    // nothing else. Picking a candidate and reaping expired searches are the two bounded
    // functions, so a generated candidate cannot be rewritten, re-used or deleted directly.
    await pool.query(`GRANT SELECT,INSERT ON course_route_candidate_set TO "${runtimeRole}"`);
    await pool.query(
      `GRANT EXECUTE ON FUNCTION
       public.consume_course_route_candidate(uuid,uuid,uuid,integer,text,integer),
       public.reap_course_route_candidate_sets() TO "${runtimeRole}"`,
    );
    // Per-owner preferences (M2-01j). Two columns may be written and nothing else: the
    // allowlist is a grant, not a convention. There is no DELETE — a preference row leaves
    // only with the course it belongs to, through the foreign key.
    await pool.query(`GRANT SELECT,INSERT ON course_preference TO "${runtimeRole}"`);
    await pool.query(
      `GRANT UPDATE(favourite,last_used_at,updated_at) ON course_preference TO "${runtimeRole}"`,
    );
    // Protected areas are the owner's own list: they may add one and remove one, and
    // nothing else in the product writes here. There is deliberately no UPDATE — the
    // product has no path that moves, renames or resizes an area, and a grant for a path
    // that does not exist is a privilege nobody is watching. Adding such a path means
    // granting the columns it writes AND revisiting `privacyZoneSetDigest`, which covers
    // ids and radii but NOT centres: a moved centre would leave the digest unchanged and
    // an acknowledged-set guard would pass over it.
    await pool.query(`GRANT SELECT,INSERT,DELETE ON course_privacy_zone TO "${runtimeRole}"`);
    // Stored thumbnails (M2-01l). The runtime role READS this ledger and nothing more: it
    // has no INSERT, no UPDATE and no DELETE, and a trigger on the table refuses a write
    // from anyone but the owner, so a future grant mistake cannot open a second path. The
    // render is enqueued by a trigger inside the revision's own transaction and advanced
    // only by the bounded functions the worker executes, which is also why no object key
    // can be chosen, published or reclaimed from an API request.
    await pool.query(`GRANT SELECT ON course_thumbnail TO "${runtimeRole}"`);
  } finally {
    await pool.end();
  }
}
