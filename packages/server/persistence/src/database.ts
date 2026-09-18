import { Pool } from 'pg';
import { z } from 'zod';

const athleteIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
export interface Transaction {
  readonly athleteId: string;
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface Database {
  tenant<T>(athleteId: string, operation: (transaction: Transaction) => Promise<T>): Promise<T>;
  exclusiveTenant<T>(
    athleteId: string,
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
export class TenantErasedError extends Error {
  constructor() {
    super('ACCOUNT_ERASED');
  }
}
/** Runtime credentials must be a non-owner, non-superuser, non-BYPASSRLS role. */
export function createDatabase(options: { connectionString: string; max?: number }): Database {
  const pool = new Pool({ ...options, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  async function transact<T>(
    athleteId: string,
    operation: (transaction: Transaction) => Promise<T>,
    exclusive: boolean,
  ): Promise<T> {
    athleteIdSchema.parse(athleteId);
    const client = await pool.connect();
    let discard = false;
    let active = true;
    try {
      await client.query('BEGIN');
      const role = await client.query(
        "SELECT rolsuper, rolbypassrls, EXISTS (SELECT 1 FROM pg_class WHERE relname IN ('consent', 'outbox', 'command_receipt', 'plan_snapshot', 'plan_head', 'plan_history', 'plan_scenario', 'plan_scenario_revision', 'plan_scenario_application', 'coaching_constraint', 'coaching_constraint_head', 'coaching_thread', 'coaching_message', 'core_evidence_snapshot', 'coaching_run', 'coaching_analysis_output', 'coaching_decision', 'coaching_proposal', 'coaching_candidate', 'nutrition_plan_version', 'nutrition_plan_head', 'nutrition_plan_history', 'food_definition_version', 'food_definition_head', 'intake_entry', 'intake_entry_revision', 'integrated_dependency_head', 'supplementary_exercise_version', 'supplementary_exercise_head', 'supplementary_routine_version', 'supplementary_routine_head', 'supplementary_routine_target_ref', 'supplementary_session_link', 'supplementary_session_target_ref', 'supplementary_execution', 'supplementary_set_log', 'supplementary_set_log_revision', 'supplementary_rest_timer', 'activity_canonical', 'activity_source_head', 'activity_source_revision', 'activity_overlay', 'activity_overlay_revision', 'activity_suppression', 'activity_import_receipt', 'tenant_erasure', 'operations_audit', 'garmin_connection', 'garmin_attempt', 'check_in', 'check_in_revision', 'check_in_receipt', 'check_in_collection_head', 'session_completion', 'session_completion_revision', 'session_completion_receipt', 'session_completion_collection_head') AND relowner = pg_roles.oid) AS owns_tables FROM pg_roles WHERE rolname = current_user",
      );
      const privileges = z.object({
        rolsuper: z.literal(false),
        rolbypassrls: z.literal(false),
        owns_tables: z.literal(false),
      });
      privileges.parse(role.rows[0]);
      await client.query(
        "SELECT set_config('app.athlete_id', $1, true), set_config('statement_timeout', '5000', true), set_config('lock_timeout', '3000', true), set_config('search_path', 'pg_catalog,public', true)",
        [athleteId],
      );
      // Separate namespace from per-command locks: never upgrade a shared command lock.
      await client.query(
        exclusive
          ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,77206))'
          : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))',
        [athleteId],
      );
      if (!exclusive) {
        const erased = await client.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [
          athleteId,
        ]);
        if (erased.rowCount) throw new TenantErasedError();
      }
      const result = await operation({
        athleteId,
        query: async (sql, values) => {
          if (!active) throw new Error('TRANSACTION_CLOSED');
          return client.query<Record<string, unknown>>(sql, values);
        },
      });
      active = false;
      const commit = await client.query('COMMIT');
      // PostgreSQL reports ROLLBACK, without throwing, for an aborted transaction.
      if (commit.command !== 'COMMIT') throw new Error('TRANSACTION_NOT_COMMITTED');
      return result;
    } catch (error) {
      active = false;
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  return {
    tenant: (athleteId, operation) => transact(athleteId, operation, false),
    exclusiveTenant: (athleteId, operation) => transact(athleteId, operation, true),
    close: () => pool.end(),
  };
}
