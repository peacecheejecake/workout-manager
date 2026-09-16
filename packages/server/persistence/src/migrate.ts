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
    const sql = await readFile(
      new URL('../migrations/001_foundation.sql', import.meta.url),
      'utf8',
    );
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version = 1',
    );
    if (existing.rows.length === 0) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES (1, $1)', [
        checksum,
      ]);
    } else if (existing.rows[0]?.checksum !== checksum) {
      throw new Error('MIGRATION_CHECKSUM_MISMATCH');
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
