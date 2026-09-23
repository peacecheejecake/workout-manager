import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantResourceObjectCleanupWorker, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * Migration 039 has to run against a populated 038 database and leave every earlier migration
 * alone. This suite builds a real 038 schema in a database of its own, grants the worker role
 * exactly what M2-01l gave it, upgrades to the current head, and then checks three things the
 * repository has got wrong before: that no earlier migration file was edited (its recorded
 * checksum is unchanged), that the function 039 renamed carries no grant forward under its old
 * name, and that the role still has only the surface it is supposed to have.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `thumb_reconcile_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const workerRole = `thumb_sweep_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;

/**
 * The 038-era grants, written out rather than taken from `grantResourceObjectCleanupWorker`:
 * that helper now names functions 039 creates, so it cannot be run against a 038 database at
 * all. `erase_account` is here because it is the function 039 renames, and the whole point of
 * the check below is that the grant does not travel to the old name.
 */
const grantsAt038 = [
  'public.erase_account(text)',
  'public.reap_course_thumbnail_renders(integer)',
  'public.prune_course_thumbnail_history(integer)',
  'public.authorize_resource_object_cleanup(uuid,uuid,timestamptz)',
];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  await migrate(upgradeUrl(), versionsThrough038);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  for (const signature of grantsAt038)
    await upgraded.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${workerRole}"`);
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  await admin.query(`DROP ROLE IF EXISTS "${workerRole}"`);
  await admin.end();
});

const versionsThrough038 = 38;

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

/** EXECUTE grants this role holds, by function signature. */
async function granted(): Promise<readonly string[]> {
  const rows = await upgraded.query<{ signature: string }>(
    `SELECT p.oid::regprocedure::text AS signature
     FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE a.privilege_type='EXECUTE' AND pg_get_userbyid(a.grantee)=$1
     ORDER BY 1`,
    [workerRole],
  );
  return rows.rows.map((row) => row.signature);
}

describe('migration 039 upgrade of a populated 038 database', () => {
  it('leaves every earlier migration untouched and carries no grant onto a renamed function', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsThrough038);
    const grantedAt038 = await granted();
    // M2-01l's worker surface, as it stood before this node.
    expect(grantedAt038).toContain('reap_course_thumbnail_renders(integer)');
    expect(grantedAt038).toContain('erase_account(text)');
    expect(grantedAt038).not.toContain('reclaim_unreferenced_course_thumbnail_object(text)');

    // Up to 039 exactly, so this suite keeps testing 039 whatever later migrations add.
    await expect(migrate(upgradeUrl(), 39)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsThrough038 + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);

    // The renamed link keeps no grant under its old name: the only `erase_account` anyone can
    // execute is the new outermost one.
    const eraseGrants = await upgraded.query<{ signature: string; grantee: string }>(
      `SELECT p.oid::regprocedure::text AS signature,pg_get_userbyid(a.grantee) AS grantee
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.proname='erase_account_before_thumbnail_object_refs'
         AND a.grantee<>0 AND a.grantee<>p.proowner`,
    );
    expect(eraseGrants.rows).toEqual([]);

    // The grant does not survive the rename under EITHER name. The role held
    // `erase_account(text)` at 038; after the upgrade that name is a brand new function with
    // no grant, and the old body, now `erase_account_before_thumbnail_object_refs`, had its
    // grants explicitly revoked. So erasure has to be re-granted deliberately, which is what
    // keeps a renamed link from quietly handing its privileges on.
    const afterUpgrade = await granted();
    expect(afterUpgrade).not.toContain('erase_account(text)');
    expect(afterUpgrade).not.toContain('erase_account_before_thumbnail_object_refs(text)');
    const outermost = await upgraded.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname='erase_account'",
    );
    expect(outermost.rows).toHaveLength(1);
    expect(outermost.rows[0]?.body).toContain('course_thumbnail_object_ref');

    // Re-granting needs the head schema: the grant helper names what later migrations add
    // (040 replaced the two candidate functions with fault-carrying windows, M2-01n). So the
    // surface below is the current worker surface, reached from a 038 database.
    await expect(migrate(upgradeUrl())).resolves.toBeUndefined();
    await grantResourceObjectCleanupWorker(upgradeUrl(), workerRole);
    const grantedNow = await granted();
    expect(new Set(grantedNow.filter((entry) => !grantedAt038.includes(entry)))).toEqual(
      new Set([
        'course_thumbnail_reconcile_cursor()',
        'advance_course_thumbnail_reconcile_cursor(text)',
        'course_thumbnail_reconcile_window(text,integer)',
        'record_course_thumbnail_sweep_fault(text,text)',
        'clear_course_thumbnail_sweep_fault(text)',
        'settle_course_thumbnail_object_ref(text)',
        'reclaim_unreferenced_course_thumbnail_object(text)',
        'lease_resource_object_cleanup(uuid,timestamp with time zone,timestamp with time zone)',
        'finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamp with time zone)',
        'reap_expired_resource_uploads(timestamp with time zone,integer)',
        'prune_resource_upload_history(integer)',
        'prune_resource_cleanup_history(integer)',
        'lease_resource_derived_cleanup(uuid,timestamp with time zone,timestamp with time zone)',
        'finish_resource_derived_cleanup(uuid,uuid,boolean,text)',
        'release_resource_derived_cleanup(uuid,uuid,text)',
        'prune_resource_derived_cleanup_history(integer)',
        'activity_track_reconcile_cursor()',
        'activity_track_reconcile_window(text,integer)',
        'record_activity_track_sweep_fault(text,text)',
        'clear_activity_track_sweep_fault(text)',
        'settle_activity_track_object_ref(text)',
        'advance_activity_track_reconcile_cursor(text)',
        'reclaim_unreferenced_activity_track_object(text)',
        'purge_resource_derived_store(uuid,uuid,text)',
        'prune_resource_retrieval_cache(integer)',
        // M2-01x: the erased-tenant prefix purge's two calls.
        'lease_tenant_object_purge(uuid,timestamp with time zone,timestamp with time zone)',
        'finish_tenant_object_purge(text,uuid,boolean,text,integer,integer,boolean)',
        // M2-01y: the deleted-activity and reclaimed-course prefix purge's two calls.
        'lease_object_scope_purge(uuid,timestamp with time zone,timestamp with time zone)',
        'finish_object_scope_purge(text,text,uuid,uuid,boolean,text,integer,integer,boolean)',
      ]),
    );
  });

  it('gives the sweep role no table access and keeps the new tables behind row-level security', async () => {
    const tableGrants = await upgraded.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM information_schema.role_table_grants
       WHERE table_name IN ('course_thumbnail_object_ref','course_thumbnail_reconcile_state')
         AND grantee<>CURRENT_USER`,
    );
    expect(tableGrants.rows[0]?.total).toBe(0);
    const security = await upgraded.query<{
      relname: string;
      rowsecurity: boolean;
      forced: boolean;
    }>(
      `SELECT relname,relrowsecurity AS rowsecurity,relforcerowsecurity AS forced
       FROM pg_class WHERE relname IN ('course_thumbnail_object_ref','course_thumbnail_reconcile_state')
       ORDER BY relname`,
    );
    expect(security.rows).toEqual([
      { relname: 'course_thumbnail_object_ref', rowsecurity: true, forced: true },
      { relname: 'course_thumbnail_reconcile_state', rowsecurity: true, forced: true },
    ]);
    // Every SECURITY DEFINER function this node adds pins its search_path.
    const definers = await upgraded.query<{ proname: string; config: string[] | null }>(
      `SELECT proname,proconfig AS config FROM pg_proc
       WHERE prosecdef AND proname IN ('course_thumbnail_reconcile_cursor',
         'advance_course_thumbnail_reconcile_cursor','course_thumbnail_reconcile_candidates',
         'settle_course_thumbnail_object_ref','reclaim_unreferenced_course_thumbnail_object',
         'erase_account')
       ORDER BY proname`,
    );
    expect(definers.rows).toHaveLength(6);
    for (const row of definers.rows)
      expect(row.config, row.proname).toEqual(['search_path=pg_catalog']);
  });

  it('backfills the index for references recorded before this table existed', async () => {
    // A 038 database with a real queued render in it — put there by M2-01l's own enqueue
    // trigger, not by hand — and then upgraded. The reference the trigger recorded predates
    // this index, so only the backfill can put it in the window.
    const seeded = `backfill_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const seededUrl = () => {
      const url = new URL(adminUrl as string);
      url.pathname = `/${seeded}`;
      return url.toString();
    };
    await admin.query(`CREATE DATABASE ${seeded}`);
    const pool = new Pool({ connectionString: seededUrl() });
    try {
      await migrate(seededUrl(), versionsThrough038);
      const athlete = randomUUID();
      const courseId = randomUUID();
      const revisionId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('SELECT set_config($1,$2,false)', ['app.athlete_id', athlete]);
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query(
          `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,
             revision_id,created_at,updated_at)
           VALUES($1,$2,'Backfilled','private','available',1,$3,clock_timestamp(),clock_timestamp())`,
          [athlete, courseId, randomUUID()],
        );
        await client.query(
          `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,
             geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,
             created_at)
           VALUES($1,$2,1,$3,'Backfilled','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,2,10,
             $4,clock_timestamp())`,
          [athlete, courseId, revisionId, 'a'.repeat(64)],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const queued = await pool.query<{ temporary_ref: string }>(
        'SELECT temporary_ref FROM course_thumbnail WHERE athlete_id=$1',
        [athlete],
      );
      expect(queued.rows).toHaveLength(1);

      await migrate(seededUrl());

      const indexed = await pool.query<{ storage_ref: string; settled_at: string | null }>(
        'SELECT storage_ref,settled_at FROM course_thumbnail_object_ref WHERE athlete_id=$1',
        [athlete],
      );
      expect(indexed.rows).toEqual([
        { storage_ref: queued.rows[0]?.temporary_ref, settled_at: null },
      ]);
    } finally {
      await pool.end();
      await dropIsolatedDatabase(admin, seeded);
    }
  });
});
