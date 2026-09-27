import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrate, migrationFileNames } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run isolated real PostgreSQL integration harness');

it('backfills existing active and deleted raw UUIDs without making activities', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `workout_hk_projection_${suffix}`;
  const ownerRole = `workout_hk_owner_${suffix}`;
  const admin = new Pool({ connectionString: adminUrl });
  let owner: Pool | undefined;
  let databaseCreated = false;
  let roleCreated = false;
  try {
    await admin.query(
      `CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roleCreated = true;
    await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
    databaseCreated = true;
    const target = new URL(adminUrl);
    target.pathname = `/${databaseName}`;
    target.username = ownerRole;
    target.password = '';
    const versionBefore = migrationFileNames.findIndex(
      (file) => file === '060_healthkit_review_lineage.sql',
    );
    expect(versionBefore).toBe(59);
    await migrate(target.href, versionBefore);
    owner = new Pool({ connectionString: target.href });
    const athlete = randomUUID();
    const activeId = randomUUID();
    const deletedId = randomUUID();
    const installationId = randomUUID();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await client.query(
        "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
        [athlete],
      );
      await client.query(
        `INSERT INTO healthkit_workout_sample
          (athlete_id,sample_id,installation_id,state,source_bundle_id,activity_type,
           observed_from,observed_to,duration_seconds,payload_digest)
         VALUES($1,$2,$3,'active','com.apple.health',37,
           '2026-09-20T00:00:00Z','2026-09-20T00:30:00Z',1800,$4)`,
        [athlete, activeId, installationId, 'a'.repeat(64)],
      );
      await client.query(
        `INSERT INTO healthkit_workout_sample
          (athlete_id,sample_id,installation_id,state,deleted_at)
         VALUES($1,$2,$3,'deleted',clock_timestamp())`,
        [athlete, deletedId, installationId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await migrate(target.href);
    const verified = await owner.connect();
    try {
      await verified.query('BEGIN');
      await verified.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      const upgraded = await verified.query(
        `SELECT sample_id,state FROM healthkit_workout_lineage ORDER BY sample_id`,
      );
      expect(upgraded.rows).toEqual(
        [
          { sample_id: activeId, state: 'pending_review' },
          { sample_id: deletedId, state: 'deleted' },
        ].sort((left, right) => left.sample_id.localeCompare(right.sample_id)),
      );
      expect(
        (await verified.query('SELECT count(*)::int AS n FROM activity_canonical')).rows[0],
      ).toEqual({ n: 0 });
      await verified.query('COMMIT');
    } finally {
      await verified.query('ROLLBACK');
      verified.release();
    }
  } finally {
    await owner?.end();
    if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    if (roleCreated) await admin.query(`DROP ROLE "${ownerRole}"`);
    await admin.end();
  }
});
