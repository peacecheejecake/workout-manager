import pg from 'pg';

export const SYNTHETIC_CAPTURE_DATABASE = 'workout_pg17_proof';
export const SYNTHETIC_CAPTURE_MARKER = 'WM_DISPOSABLE_PG17_PROOF';

function fail() {
  throw new Error('BACKUP_PERSISTENT_SYNTHETIC_TARGET_REQUIRED');
}

/** Only the explicitly marked loopback PostgreSQL 17.6 drill is supported. */
export async function assertSyntheticPersistentTarget(connectionString, expectedSystemIdentifier) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    fail();
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== `/${SYNTHETIC_CAPTURE_DATABASE}` ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash
  )
    fail();
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(`SELECT current_database() AS database,
      current_setting('server_version_num')::integer AS version,
      current_setting('wal_level') AS wal_level,
      system_identifier::text AS system_id,
      (SELECT shobj_description(oid, 'pg_database') FROM pg_database
        WHERE datname = current_database()) AS marker FROM pg_control_system()`);
    if (
      rows.length !== 1 ||
      rows[0].database !== SYNTHETIC_CAPTURE_DATABASE ||
      rows[0].version !== 170006 ||
      rows[0].wal_level !== 'logical' ||
      rows[0].system_id !== expectedSystemIdentifier ||
      rows[0].marker !== SYNTHETIC_CAPTURE_MARKER
    )
      fail();
  } catch {
    fail();
  } finally {
    await client.end();
  }
}
