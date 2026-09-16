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
    await pool.query(`GRANT SELECT,INSERT ON operations_audit TO "${runtimeRole}"`);
    await pool.query(`GRANT SELECT ON garmin_connection TO "${runtimeRole}"`);
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
