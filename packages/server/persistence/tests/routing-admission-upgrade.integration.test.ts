import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantCourses, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The routing-admission migration (M2-01ah, filed as 047) on a database every earlier
 * migration already built. It adds one table and three functions, wraps `erase_account` once
 * more, and must leave everything else alone: no earlier checksum, no earlier function body
 * other than `erase_account`'s (whose previous body moves, unchanged, to
 * `erase_account_before_routing_admission`), and no table grant.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `admit_up_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const runtimeRole = `admit_rt_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const upgradeUrl = (user?: string) => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user;
    url.password = '';
  }
  return url.toString();
};
let upgraded: Pool;
let versionsBefore = 0;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  // Found by name, not by number: renumbering at merge time must not move the starting point.
  const index = migrationFileNames.findIndex((file) => /^\d+_routing_admission\.sql$/.test(file));
  expect(index).toBeGreaterThan(0);
  versionsBefore = index;
  await migrate(upgradeUrl(), versionsBefore);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await admin.end();
});

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

async function functionBodies(): Promise<Map<string, string>> {
  const rows = await upgraded.query<{ signature: string; body: string }>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace`,
  );
  return new Map(rows.rows.map((row) => [row.signature, row.body]));
}

async function tableGrants(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT c.relname||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')||':'||a.privilege_type
       AS entry
     FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.grantee<>c.relowner
     ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

describe('routing-admission migration upgrade of a database built by every earlier one', () => {
  it('adds its table and functions, re-wraps erase_account, and changes nothing else', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const bodiesBefore = await functionBodies();
    const eraseBefore = bodiesBefore.get('erase_account(text)');
    expect(eraseBefore).toBeDefined();
    const grantsBefore = await tableGrants();

    await expect(migrate(upgradeUrl(), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    const bodiesAfter = await functionBodies();
    for (const [signature, body] of bodiesBefore) {
      if (signature === 'erase_account(text)') continue;
      expect(bodiesAfter.get(signature), `${signature} changed`).toBe(body);
    }
    // The previous erasure chain is kept byte for byte under its new name.
    expect(bodiesAfter.get('erase_account_before_routing_admission(text)')).toBe(eraseBefore);
    expect(
      [...bodiesAfter.keys()].filter((signature) => !bodiesBefore.has(signature)).sort(),
    ).toEqual([
      'acquire_routing_permit(uuid,integer,integer,integer,integer,integer)',
      'erase_account_before_routing_admission(text)',
      'release_routing_permit(uuid)',
      'routing_admission_writer_is_owner()',
    ]);
    // Lock order: the account lock, then the per-tenant command lock, then rows.
    const erase = bodiesAfter.get('erase_account(text)') ?? '';
    const account = erase.indexOf('hashtextextended($1,77206)');
    const command = erase.indexOf('hashtextextended($1,0)');
    const rows = erase.indexOf('DELETE FROM public.routing_admission');
    expect(account).toBeGreaterThan(0);
    expect(command).toBeGreaterThan(account);
    expect(rows).toBeGreaterThan(command);
    // It grants nothing on any table, its own included.
    expect(await tableGrants()).toEqual(grantsBefore);

    const table = await upgraded.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid='public.routing_admission'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await upgraded.query<{ policyname: string; roles: string[] }>(
      `SELECT policyname,roles::text[] AS roles FROM pg_policies
       WHERE tablename='routing_admission' ORDER BY policyname`,
    );
    const owner = await upgraded.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE oid='public.routing_admission'::regclass`,
    );
    expect(policies.rows).toEqual([
      // The functions' own view: every tenant's permits, for the engine cap.
      { policyname: 'routing_admission_definer', roles: [owner.rows[0]?.owner] },
      { policyname: 'routing_admission_tenant', roles: ['public'] },
    ]);
    // Every new function searches pg_catalog first and pg_temp LAST (review N1): unlisted,
    // pg_temp would be searched first and a temporary object could shadow a catalog name.
    const paths = await upgraded.query<{ signature: string; config: string[] }>(
      `SELECT p.oid::regprocedure::text AS signature,p.proconfig AS config FROM pg_proc p
       WHERE p.pronamespace='public'::regnamespace
         AND p.proname IN ('acquire_routing_permit','release_routing_permit',
                           'routing_admission_writer_is_owner','erase_account')
       ORDER BY 1`,
    );
    expect(paths.rows).toEqual(
      [
        'acquire_routing_permit(uuid,integer,integer,integer,integer,integer)',
        'erase_account(text)',
        'release_routing_permit(uuid)',
        'routing_admission_writer_is_owner()',
      ].map((signature) => ({ signature, config: ['search_path=pg_catalog, pg_temp'] })),
    );
  });

  it('is reachable by the runtime role only through the functions, and erasure still works', async () => {
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    await grantCourses(upgradeUrl(), runtimeRole);
    expect((await tableGrants()).filter((entry) => entry.startsWith('routing_admission:'))).toEqual(
      [],
    );
    const privileges = await upgraded.query(
      `SELECT
         has_function_privilege($1,
           'public.acquire_routing_permit(uuid,integer,integer,integer,integer,integer)',
           'EXECUTE') AS acquire,
         has_function_privilege($1,'public.release_routing_permit(uuid)','EXECUTE') AS release,
         has_function_privilege($1,'public.erase_account(text)','EXECUTE') AS erase,
         has_function_privilege($1,'public.erase_account_before_routing_admission(text)',
           'EXECUTE') AS inner_erase`,
      [runtimeRole],
    );
    expect(privileges.rows[0]).toEqual({
      acquire: true,
      release: true,
      erase: true,
      inner_erase: false,
    });

    const tenant = randomUUID();
    const runtime = new Pool({ connectionString: upgradeUrl(runtimeRole) });
    try {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        const acquired = await client.query(
          'SELECT * FROM acquire_routing_permit($1,2,20,60000,8,12000)',
          [randomUUID()],
        );
        expect(acquired.rows[0]).toMatchObject({ permit_granted: true, engine_in_flight: 1 });
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        const erased = await client.query('SELECT public.erase_account($1) AS erased_at', [tenant]);
        expect(erased.rows[0]?.['erased_at']).toBeInstanceOf(Date);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
    const left = await upgraded.query(
      'SELECT count(*)::int AS total FROM routing_admission WHERE athlete_id=$1',
      [tenant],
    );
    expect(left.rows[0]).toEqual({ total: 0 });
    const ledger = await upgraded.query(
      'SELECT count(*)::int AS total FROM tenant_erasure WHERE athlete_id=$1',
      [tenant],
    );
    expect(ledger.rows[0]).toEqual({ total: 1 });
  });
});
