import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  grantActivityTracks,
  grantCourses,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
  migrationFileNames,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The object-scope-purge migration (M2-01y, 046) against a populated database, one step at a
 * time. It adds a table, two triggers on existing tables, a terminal-tombstone guard and two
 * worker functions; it renames nothing. Checked: no earlier migration changed and the triggers
 * it sits beside are still there, nothing it adds is reachable by anyone until the worker's
 * grant helper runs, and the backfill arms exactly what was already deleted.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `scope_purge_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const runtimeRole = `scope_purge_rt_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const workerRole = `scope_purge_wk_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const upgradeUrl = (role?: string) => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (role) url.username = role;
  return url.toString();
};
let upgraded: Pool;
// Found by name, never by number or position: a migration merged in before it renumbers it.
const purgeIndex = migrationFileNames.findIndex((name) =>
  /^\d+_object_scope_purge\.sql$/.test(name),
);
if (purgeIndex < 0) throw new Error('object scope purge migration is not in the list');
const versionsBefore = purgeIndex;
const tenant = randomUUID();
const deletedBefore = randomUUID();
const liveBefore = randomUUID();
const reclaimedBefore = randomUUID();
const legacyTenant = 'legacy-tenant-id';
const legacyDeleted = randomUUID();

async function insertActivity(athlete: string, id: string, deleted: boolean): Promise<void> {
  await upgraded.query(
    `INSERT INTO activity_canonical(athlete_id,id,revision,original,deleted)
     VALUES($1,$2,1,'{}'::jsonb,$3)`,
    [athlete, id, deleted],
  );
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  for (const role of [runtimeRole, workerRole])
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  await migrate(upgradeUrl(), versionsBefore);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}"`);
  // Populated: a deleted and a live activity of a canonical tenant, a course that deletion
  // already reclaimed, and a deleted activity of a tenant whose id names no key prefix.
  await insertActivity(tenant, deletedBefore, true);
  await insertActivity(tenant, liveBefore, false);
  await insertActivity(legacyTenant, legacyDeleted, true);
  await upgraded.query(
    `INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
       reclaimed_at,created_at,updated_at)
     VALUES($1,$2,'Reclaimed before','private','unavailable','source_activity_deleted',
       clock_timestamp(),clock_timestamp(),clock_timestamp())`,
    [tenant, reclaimedBefore],
  );
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [runtimeRole, workerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

async function triggersOn(table: string): Promise<readonly string[]> {
  const rows = await upgraded.query<{ name: string }>(
    `SELECT tgname AS name FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal
     ORDER BY tgname`,
    [table],
  );
  return rows.rows.map((row) => row.name);
}

async function granteesOf(name: string): Promise<readonly string[]> {
  const rows = await upgraded.query<{ grantee: string }>(
    `SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
     FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.proname=$1 AND a.grantee<>p.proowner ORDER BY 1`,
    [name],
  );
  return rows.rows.map((row) => row.grantee);
}

const added = [
  'arm_object_scope_purge',
  'replay_absent_activity_deletion',
  'lease_object_scope_purge',
  'finish_object_scope_purge',
  'object_scope_purge_on_activity_delete',
  'object_scope_purge_on_course_reclaim',
  'activity_tombstone_terminal',
];

describe('object scope purge migration upgrade of a populated database', () => {
  it('leaves earlier migrations and the triggers it joins intact', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const activityTriggers = await triggersOn('activity_canonical');
    const courseTriggers = await triggersOn('course');

    await expect(migrate(upgradeUrl(), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    expect(await triggersOn('activity_canonical')).toEqual(
      [
        ...activityTriggers,
        'activity_tombstone_terminal',
        'object_scope_purge_on_activity_delete',
      ].sort(),
    );
    expect(await triggersOn('course')).toEqual(
      [...courseTriggers, 'object_scope_purge_on_course_reclaim'].sort(),
    );
    // The arming trigger fires after the two deletion triggers it depends on (same event,
    // fired in name order), so the purge row is the last row a deletion writes.
    const ordered = (await triggersOn('activity_canonical')).filter((name) =>
      [
        'activity_track_cleanup_on_delete',
        'course_reclaim_on_activity_delete',
        'object_scope_purge_on_activity_delete',
      ].includes(name),
    );
    expect(ordered).toEqual([
      'activity_track_cleanup_on_delete',
      'course_reclaim_on_activity_delete',
      'object_scope_purge_on_activity_delete',
    ]);
  });

  it('keeps the purge table and every new function closed to all but the worker’s two calls', async () => {
    const table = await upgraded.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS rls,relforcerowsecurity AS forced
       FROM pg_class WHERE oid='public.object_scope_purge'::regclass`,
    );
    expect(table.rows[0]).toEqual({ rls: true, forced: true });
    const functions = await upgraded.query<{ name: string; definer: boolean; config: string[] }>(
      `SELECT proname AS name,prosecdef AS definer,proconfig AS config FROM pg_proc
       WHERE proname=ANY($1::text[]) ORDER BY proname`,
      [added],
    );
    expect(functions.rows.map((row) => row.name).sort()).toEqual([...added].sort());
    for (const row of functions.rows)
      expect(row.config, row.name).toEqual(['search_path=pg_catalog']);
    // Definer only where the caller is not the owner: the worker's two calls and the two
    // triggers a runtime deletion fires. The arming functions are reached only from those
    // triggers (as the owner) or by the restore's administrator.
    expect(Object.fromEntries(functions.rows.map((row) => [row.name, row.definer]))).toEqual({
      activity_tombstone_terminal: false,
      arm_object_scope_purge: false,
      finish_object_scope_purge: true,
      lease_object_scope_purge: true,
      object_scope_purge_on_activity_delete: true,
      object_scope_purge_on_course_reclaim: true,
      replay_absent_activity_deletion: false,
    });
    for (const name of added) expect(await granteesOf(name), name).toEqual([]);

    // Grant helpers name every migration's objects: a fully migrated database only.
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    await grantActivityTracks(upgradeUrl(), runtimeRole);
    await grantCourses(upgradeUrl(), runtimeRole);
    await grantResourceObjectCleanupWorker(upgradeUrl(), workerRole);
    for (const name of added)
      expect(await granteesOf(name), name).toEqual(
        name === 'lease_object_scope_purge' || name === 'finish_object_scope_purge'
          ? [workerRole]
          : [],
      );
    const tableGrantees = await upgraded.query<{ grantee: string }>(
      `SELECT DISTINCT pg_get_userbyid(a.grantee) AS grantee FROM pg_class c,
         LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
       WHERE c.oid='public.object_scope_purge'::regclass AND a.grantee<>c.relowner`,
    );
    expect(tableGrantees.rows).toEqual([]);
    for (const role of [workerRole, runtimeRole]) {
      const pool = new Pool({ connectionString: upgradeUrl(role) });
      try {
        await expect(pool.query('SELECT * FROM object_scope_purge')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(
          pool.query('SELECT public.replay_absent_activity_deletion($1,$2,$3,$4,$5,$6,$7)', [
            tenant,
            randomUUID(),
            'fit',
            randomUUID(),
            1,
            2,
            'a'.repeat(64),
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    }
  });

  it('arms a purge for every canonical deletion made before it, and nothing else', async () => {
    const rows = await upgraded.query<{
      athlete_id: string;
      scope_kind: string;
      scope_id: string;
      due: boolean;
      open: boolean;
    }>(
      `SELECT athlete_id,scope_kind,scope_id::text,available_at<=clock_timestamp() AS due,
         completed_at IS NULL AS open FROM object_scope_purge ORDER BY scope_kind,scope_id`,
    );
    expect(rows.rows).toEqual([
      {
        athlete_id: tenant,
        scope_kind: 'activity',
        scope_id: deletedBefore,
        due: true,
        open: true,
      },
      {
        athlete_id: tenant,
        scope_kind: 'course',
        scope_id: reclaimedBefore,
        due: true,
        open: true,
      },
    ]);
    // After the upgrade, a tombstone arms its own, and a tombstone cannot be lifted.
    // As the restore replays it: the tenant's session, straight SQL.
    const client = await upgraded.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
      await client.query(
        'UPDATE activity_canonical SET deleted=true,revision=2 WHERE athlete_id=$1 AND id=$2',
        [tenant, liveBefore],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const armed = await upgraded.query(
      `SELECT 1 FROM object_scope_purge WHERE athlete_id=$1 AND scope_kind='activity'
       AND scope_id=$2 AND completed_at IS NULL`,
      [tenant, liveBefore],
    );
    expect(armed.rowCount).toBe(1);
    await expect(
      upgraded.query('UPDATE activity_canonical SET deleted=false WHERE athlete_id=$1 AND id=$2', [
        tenant,
        deletedBefore,
      ]),
    ).rejects.toThrow(/ACTIVITY_TOMBSTONE_TERMINAL/);
  });
});
