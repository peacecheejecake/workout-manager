import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
  migrationFileNames,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The tenant-object-purge migration (M2-01x, 044) against a populated database, one step at a
 * time. It adds a table and two worker functions and renames the outermost `erase_account`
 * link once more, so the same things are checked as for the earlier rename links — no earlier
 * migration changed, the renamed body is the previous one byte for byte, no grant travels —
 * plus the new objects' privileges and the backfill for tenants erased before it.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `tenant_purge_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const runtimeRole = `tenant_purge_rt_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const workerRole = `tenant_purge_wk_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
// Found by name, never by number or position: a migration merged in before it renumbers it.
const purgeIndex = migrationFileNames.findIndex((name) =>
  /^\d+_tenant_object_purge\.sql$/.test(name),
);
if (purgeIndex < 0) throw new Error('tenant object purge migration is not in the list');
const versionsBefore = purgeIndex;
const erasedBefore = randomUUID();
const nonCanonicalErased = 'legacy-tenant-id';
const live = randomUUID();

async function eraseAs(pool: Pool, tenant: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    await client.query('SELECT public.erase_account($1)', [tenant]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  for (const role of [runtimeRole, workerRole])
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  await migrate(upgradeUrl(), versionsBefore);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}"`);
  // The grant `grantOperations` gave the runtime role before this migration, written out.
  await upgraded.query(`GRANT EXECUTE ON FUNCTION public.erase_account(text) TO "${runtimeRole}"`);
  // Populated: two tenants erased before the upgrade (one canonical, one not) and a live one.
  await eraseAs(upgraded, erasedBefore);
  await eraseAs(upgraded, nonCanonicalErased);
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

async function bodyOf(name: string): Promise<string | undefined> {
  const rows = await upgraded.query<{ body: string }>(
    'SELECT prosrc AS body FROM pg_proc WHERE proname=$1',
    [name],
  );
  expect(rows.rows.length).toBeLessThanOrEqual(1);
  return rows.rows[0]?.body;
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

describe('tenant object purge migration upgrade of a populated database', () => {
  it('leaves earlier migrations and the renamed link intact, and carries no grant onto it', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const previousBody = await bodyOf('erase_account');
    expect(previousBody).toContain('erase_account_before_watched_ref_queue');
    expect(await granteesOf('erase_account')).toEqual([runtimeRole]);

    await expect(migrate(upgradeUrl(), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    expect(await bodyOf('erase_account_before_tenant_object_purge')).toBe(previousBody);
    expect(await granteesOf('erase_account_before_tenant_object_purge')).toEqual([]);
    // Until the grant helper runs again, the runtime cannot erase (the deployment note).
    expect(await granteesOf('erase_account')).toEqual([]);
    await grantOperations(upgradeUrl(), runtimeRole);
    expect(await granteesOf('erase_account')).toEqual([runtimeRole]);
    expect(await granteesOf('erase_account_before_tenant_object_purge')).toEqual([]);
  });

  it('keeps the purge table and its functions closed to everyone but the worker’s two calls', async () => {
    const table = await upgraded.query<{
      rls: boolean;
      forced: boolean;
      acl: string[] | null;
    }>(
      `SELECT relrowsecurity AS rls,relforcerowsecurity AS forced,relacl::text[] AS acl
       FROM pg_class WHERE oid='public.tenant_object_purge'::regclass`,
    );
    expect(table.rows[0]).toMatchObject({ rls: true, forced: true });
    // No privilege for anyone but the owner.
    const tableGrantees = await upgraded.query<{ grantee: string }>(
      `SELECT DISTINCT pg_get_userbyid(a.grantee) AS grantee FROM pg_class c,
         LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
       WHERE c.oid='public.tenant_object_purge'::regclass AND a.grantee<>c.relowner`,
    );
    expect(tableGrantees.rows).toEqual([]);
    const functions = await upgraded.query<{ name: string; definer: boolean; config: string[] }>(
      `SELECT proname AS name,prosecdef AS definer,proconfig AS config FROM pg_proc
       WHERE proname IN ('lease_tenant_object_purge','finish_tenant_object_purge','erase_account',
         'erase_account_before_tenant_object_purge') ORDER BY proname`,
    );
    expect(functions.rows).toHaveLength(4);
    for (const row of functions.rows)
      expect(row, row.name).toMatchObject({ definer: true, config: ['search_path=pg_catalog'] });
    for (const name of ['lease_tenant_object_purge', 'finish_tenant_object_purge'])
      expect(await granteesOf(name), name).toEqual([]);
    await grantResourceObjectCleanupWorker(upgradeUrl(), workerRole);
    for (const name of ['lease_tenant_object_purge', 'finish_tenant_object_purge'])
      expect(await granteesOf(name), name).toEqual([workerRole]);
    // The worker still cannot erase, and the runtime cannot purge.
    expect(await granteesOf('erase_account')).toEqual([runtimeRole]);
    const workerPool = new Pool({
      connectionString: (() => {
        const url = new URL(upgradeUrl());
        url.username = workerRole;
        return url.toString();
      })(),
    });
    try {
      await expect(workerPool.query('SELECT * FROM tenant_object_purge')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(workerPool.query('SELECT * FROM tenant_erasure')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await workerPool.end();
    }
  });

  it('arms a purge for every canonical tenant erased before it, and nothing else', async () => {
    const rows = await upgraded.query<{ athlete_id: string; due: boolean; open: boolean }>(
      `SELECT athlete_id,available_at<=clock_timestamp() AS due,completed_at IS NULL AS open
       FROM tenant_object_purge ORDER BY athlete_id`,
    );
    expect(rows.rows).toEqual([{ athlete_id: erasedBefore, due: true, open: true }]);
    // And an erasure after the upgrade arms its own.
    await eraseAs(upgraded, live);
    const armed = await upgraded.query(
      'SELECT 1 FROM tenant_object_purge WHERE athlete_id=$1 AND completed_at IS NULL',
      [live],
    );
    expect(armed.rowCount).toBe(1);
  });
});
