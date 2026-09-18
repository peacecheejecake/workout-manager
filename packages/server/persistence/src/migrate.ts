import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

/** Run with deployment credentials; runtime credentials receive only table DML grants. */
export async function migrate(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(872194, 1)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
    );
    for (const [index, file] of [
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
    ].entries()) {
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
