import type { Pool } from 'pg';

/**
 * Drops a database an upgrade test created, after every connection to it has gone.
 *
 * `pg` resolves `Pool.end()` as soon as it has *asked* each client to close, not when the
 * server backends have exited. A `DROP DATABASE … WITH (FORCE)` issued straight after can
 * therefore terminate a backend that has not yet read the client's goodbye; that backend
 * answers with FATAL 57P01, the client emits it as an `error` event, the ended pool re-emits
 * it with no listener, and the test process exits non-zero after every test passed (M2-01v).
 * Waiting until `pg_stat_activity` no longer lists the database closes that window; FORCE
 * stays only as the last resort for a backend that never leaves.
 */
export async function dropIsolatedDatabase(admin: Pool, database: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error('INVALID_DATABASE_NAME');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const open = await admin.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = $1',
      [database],
    );
    if (Number(open.rows[0]?.total) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}
