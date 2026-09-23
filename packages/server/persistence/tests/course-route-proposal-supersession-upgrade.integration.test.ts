import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantCourses, migrate, migrationFileNames } from '../src/migrate.js';

/**
 * Migration 042 (M2-01p) has to run on a database every earlier migration already built,
 * leave all of them alone, and add two functions nobody can run until the runtime grant
 * names them. It edits no existing function: the reapers, both consume functions, course
 * deletion and erasure keep their bodies, and the grants the runtime role already held on
 * them are neither widened nor taken.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `supersede_up_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const runtimeRole = `supersede_rt_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
/** Every migration before 042, whatever number the merge gives it. */
let versionsBefore042 = 0;

/** The proposal surface the runtime role held before 042, as `grantCourses` wrote it. */
const proposalFunctionsBefore042 = [
  'consume_course_route_proposal(uuid,uuid,integer,text,integer)',
  'reap_course_route_proposals()',
  'consume_course_route_candidate(uuid,uuid,uuid,integer,text,integer)',
  'reap_course_route_candidate_sets()',
];
const unchangedFunctions = [
  'consume_course_route_proposal',
  'reap_course_route_proposals',
  'consume_course_route_candidate',
  'reap_course_route_candidate_sets',
  'delete_course',
  'erase_account',
];
const added = [
  'supersede_course_route_proposals(uuid,integer,boolean)',
  'course_route_proposal_room(uuid,integer,boolean)',
];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  // Found by name, not by number or position: renumbering at merge time, or migrations
  // added after this one, must not make this test upgrade from the wrong place.
  const index = migrationFileNames.findIndex((file) =>
    /^\d+_course_route_proposal_supersession\.sql$/.test(file),
  );
  expect(index).toBeGreaterThan(0);
  versionsBefore042 = index;
  await migrate(upgradeUrl(), versionsBefore042);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  for (const signature of proposalFunctionsBefore042)
    await upgraded.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`);
});

afterAll(async () => {
  await upgraded?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await admin.end();
});

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

async function granted(): Promise<readonly string[]> {
  const rows = await upgraded.query<{ signature: string }>(
    `SELECT p.oid::regprocedure::text AS signature
     FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE a.privilege_type='EXECUTE' AND pg_get_userbyid(a.grantee)=$1
     ORDER BY 1`,
    [runtimeRole],
  );
  return rows.rows.map((row) => row.signature);
}

async function bodies(): Promise<Map<string, string>> {
  const rows = await upgraded.query<{ signature: string; body: string }>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[])`,
    [unchangedFunctions],
  );
  return new Map(rows.rows.map((row) => [row.signature, row.body]));
}

describe('migration 042 upgrade of a database built by every earlier migration', () => {
  it('leaves earlier migrations and existing functions alone and grants nothing by itself', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore042);
    const bodiesBefore = await bodies();
    expect(bodiesBefore.size).toBeGreaterThanOrEqual(unchangedFunctions.length);
    const grantedBefore = await granted();
    for (const signature of proposalFunctionsBefore042) expect(grantedBefore).toContain(signature);

    // Exactly this migration, whatever comes after it.
    await expect(migrate(upgradeUrl(), versionsBefore042 + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore042 + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    expect(await bodies()).toEqual(bodiesBefore);

    // The migration grants nothing: PUBLIC is revoked and no role was named.
    expect(await granted()).toEqual(grantedBefore);
    const anyone = await upgraded.query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.pronamespace='public'::regnamespace
         AND p.proname IN ('supersede_course_route_proposals','course_route_proposal_room')
         AND a.grantee<>p.proowner`,
    );
    expect(Number(anyone.rows[0]?.total)).toBe(0);

    // The runtime grant names the two new functions and takes nothing the role held. It is
    // run on a fully migrated database, because the grant helper may name functions that
    // later migrations create.
    await expect(migrate(upgradeUrl())).resolves.toBeUndefined();
    await grantCourses(upgradeUrl(), runtimeRole);
    const grantedNow = await granted();
    for (const signature of added) expect(grantedNow).toContain(signature);
    expect(grantedBefore.filter((entry) => !grantedNow.includes(entry))).toEqual([]);
  });

  it('refuses the supersession without a tenant, even to a role that may run it', async () => {
    const client = await upgraded.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
      await expect(
        client.query('SELECT public.supersede_course_route_proposals($1,1,false)', [randomUUID()]),
      ).rejects.toThrow(/INVALID_ROUTE_PROPOSAL/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
