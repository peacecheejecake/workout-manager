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
  close(): Promise<void>;
}
/** Runtime credentials must be a non-owner, non-superuser, non-BYPASSRLS role. */
export function createDatabase(options: { connectionString: string; max?: number }): Database {
  const pool = new Pool({ ...options, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  return {
    async tenant(athleteId, operation) {
      athleteIdSchema.parse(athleteId);
      const client = await pool.connect();
      let discard = false;
      let active = true;
      try {
        await client.query('BEGIN');
        const role = await client.query(
          "SELECT rolsuper, rolbypassrls, EXISTS (SELECT 1 FROM pg_class WHERE relname IN ('consent', 'outbox', 'command_receipt', 'plan_snapshot', 'plan_head', 'plan_history', 'activity_canonical', 'activity_source_head', 'activity_source_revision', 'activity_overlay', 'activity_overlay_revision', 'activity_suppression', 'activity_import_receipt') AND relowner = pg_roles.oid) AS owns_tables FROM pg_roles WHERE rolname = current_user",
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
    },
    close: () => pool.end(),
  };
}
