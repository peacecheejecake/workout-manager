import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantCourses, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * M2-01as (054) on a database whose migration owner is neither superuser nor BYPASSRLS — 051's
 * and 052's plain-owner story (M2-01at, M2-01au). The table has no `*_definer` policy, so
 * `retarget_definer_policies()` (052) has nothing of it to retarget after an ownership change. The table is FORCE RLS with only a tenant policy; everything
 * that touches it runs with a tenant named: the claim (a definer function called in the
 * caller's tenant transaction), erasure (the same), and the backfill (one tenant at a time).
 * So none of it may depend on the owner seeing through FORCE, and this checks that it does not.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `plain_budget_${suffix}`;
const ownerRole = `plain_budget_owner_${suffix}`;
const runtimeRole = `plain_budget_rt_${suffix}`;

function urlFor(role: string | null): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  if (role !== null) {
    url.username = role;
    url.password = 'plain';
  }
  return url.toString();
}

let inspect: Pool;
let runtime: Database;
const tenant = randomUUID();
const zoneBefore = randomUUID();

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${ownerRole}"`);
  inspect = new Pool({ connectionString: urlFor(null) });
  const owner = urlFor(ownerRole);
  // Everything before 054, by the plain owner; then a link made before 054 exists.
  const index = migrationFileNames.findIndex((file) =>
    /^\d+_course_share_area_budget\.sql$/.test(file),
  );
  expect(index).toBeGreaterThan(0);
  await migrate(owner, index);
  await inspect.query(
    `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
       radius_meters,created_at,updated_at) VALUES($1,$2,'집',127.02,37.5,200,now(),now())`,
    [tenant, zoneBefore],
  );
  const client = await inspect.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
         token_digest,epoch,state,include_names,zone_ids,snapshot,created_at,expires_at)
       VALUES($1,$2,$3,1,$4,$5,1,'active',false,ARRAY[$6::uuid],'{"coordinates":[]}'::jsonb,
         now(),now()+interval '1 day')`,
      [tenant, randomUUID(), randomUUID(), randomUUID(), 'c'.repeat(64), zoneBefore],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  // 054 by the same plain owner, then the grant helpers as a deployment runs them.
  await migrate(owner);
  const ownerPool = new Pool({ connectionString: owner, max: 1 });
  try {
    await ownerPool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await ownerPool.query(`GRANT USAGE ON SCHEMA identity_private TO "${runtimeRole}"`);
  } finally {
    await ownerPool.end();
  }
  await grantOperations(owner, runtimeRole);
  await grantCourses(owner, runtimeRole);
  runtime = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
});

afterAll(async () => {
  await runtime?.close();
  await inspect?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [ownerRole, runtimeRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

const budget = async () =>
  (
    await inspect.query<{ zone_id: string; links_cut: number }>(
      `SELECT zone_id::text,links_cut FROM course_share_area_budget WHERE athlete_id=$1
       ORDER BY links_cut,zone_id`,
      [tenant],
    )
  ).rows;

describe('the lifetime link budget under a plain migration owner (M2-01as on 051)', () => {
  it('is really such an owner, and owns the table and the claim', async () => {
    const owner = await inspect.query<{ super: boolean; bypass: boolean; table: string }>(
      `SELECT r.rolsuper AS super,r.rolbypassrls AS bypass,pg_get_userbyid(c.relowner) AS table
       FROM pg_roles r,pg_class c WHERE r.rolname=$1 AND c.relname='course_share_area_budget'`,
      [ownerRole],
    );
    expect(owner.rows).toEqual([{ super: false, bypass: false, table: ownerRole }]);
    const claim = await inspect.query<{ owner: string; definer: boolean }>(
      `SELECT pg_get_userbyid(proowner) AS owner,prosecdef AS definer FROM pg_proc
       WHERE proname='claim_course_share_budget'`,
    );
    expect(claim.rows).toEqual([{ owner: ownerRole, definer: true }]);
  });

  it('backfills the link made before 054, one tenant at a time', async () => {
    expect(await budget()).toEqual([{ zone_id: zoneBefore, links_cut: 1 }]);
  });

  it('claims, inherits over a deleted area, refuses at the bound, and erases', async () => {
    const claim = (zones: string[]) =>
      runtime.tenant(tenant, async (tx) => {
        const result = await tx.query(
          'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
          [zones],
        );
        return result.rows[0]?.['claimed'];
      });
    expect(await claim([zoneBefore])).toBe(true);
    expect(await budget()).toEqual([{ zone_id: zoneBefore, links_cut: 2 }]);
    // The area goes; a new one ~100 m away starts from its tombstone.
    await runtime.tenant(tenant, (tx) =>
      tx.query('DELETE FROM course_privacy_zone WHERE athlete_id=$1 AND zone_id=$2', [
        tenant,
        zoneBefore,
      ]),
    );
    const again = randomUUID();
    await runtime.tenant(tenant, (tx) =>
      tx.query(
        `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
           radius_meters,created_at,updated_at) VALUES($1,$2,'다시',127.0211,37.5,150,now(),now())`,
        [tenant, again],
      ),
    );
    expect(await claim([again])).toBe(true);
    expect((await budget()).find((row) => row.zone_id === again)?.links_cut).toBe(3);
    // The bound holds for this owner too.
    await inspect.query(
      'UPDATE course_share_area_budget SET links_cut=10 WHERE athlete_id=$1 AND zone_id=$2',
      [tenant, again],
    );
    expect(await claim([again])).toBe(false);
    // The restore replay (an invoker function, no grant) run by this plain owner as the restore
    // role: it sees the tenant's rows through the tenant policy and raises the count.
    await inspect.query(
      'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
      [tenant, 'https://synthetic.invalid', `plain-budget-${suffix}`],
    );
    const [row] = (
      await inspect.query<{ cell_latitude: number; cell_longitude: number; reach_meters: number }>(
        `SELECT cell_latitude,cell_longitude,reach_meters FROM course_share_area_budget
         WHERE athlete_id=$1 AND zone_id=$2`,
        [tenant, again],
      )
    ).rows;
    if (!row) throw new Error('no budget row');
    const ownerPool = new Pool({ connectionString: urlFor(ownerRole), max: 1 });
    try {
      const client = await ownerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        const replayed = await client.query<{ outcome: string }>(
          'SELECT public.replay_course_share_budget($1,$2,$3,$4,$5,$6) AS outcome',
          [tenant, again, row.cell_latitude, row.cell_longitude, row.reach_meters, 12],
        );
        await client.query('COMMIT');
        expect(replayed.rows[0]?.outcome).toBe('raised');
      } finally {
        client.release();
      }
    } finally {
      await ownerPool.end();
    }
    expect((await budget()).find((each) => each.zone_id === again)?.links_cut).toBe(12);
    // Erasure, through the runtime's repository, removes every budget row of the account.
    await createOperationsRepository(runtime).eraseAccount(tenant);
    expect(await budget()).toEqual([]);
  });
});
