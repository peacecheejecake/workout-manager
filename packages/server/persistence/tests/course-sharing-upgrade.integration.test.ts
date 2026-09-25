import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCourseSharingRepository } from '../src/course-sharing.js';
import { createDatabase } from '../src/database.js';
import { grantCourses, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The course-sharing migration (M2-01k-o, 050) on a database every earlier migration already
 * built — with protected areas made before share offsets existed and an account already
 * erased. It adds five tables, four triggers and four functions, wraps `erase_account` once
 * more, and must leave everything else alone: no earlier checksum, no other function body,
 * no policy on any earlier table, and no table grant of its own.
 *
 * The owner-visibility case (peer review item 2) is checked with a role that is neither
 * superuser nor BYPASSRLS, because the test cluster's migration role is a superuser and
 * would see through every policy.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `share_up_${suffix}`;
const runtimeRole = `share_rt_${suffix}`;
const plainOwner = `share_owner_${suffix}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
const runtimeUrl = () => {
  const url = new URL(upgradeUrl());
  url.username = runtimeRole;
  url.password = 'runtime';
  return url.toString();
};
let upgraded: Pool;
let versionsBefore = 0;

const liveTenant = randomUUID();
const erasedTenant = randomUUID();
const zoneBefore = randomUUID();

const newFunctions = [
  'course_disclosure_receipt_immutable()',
  'course_share_audit_append_only()',
  'course_share_offset_write_once()',
  'course_share_transition_valid()',
  'erase_account_before_course_sharing(text)',
  'export_course_deletions()',
  'read_course_share(text,integer,text,integer,integer,integer)',
  'reap_course_shares(integer)',
];
const newTables = [
  'course_disclosure_receipt',
  'course_privacy_zone_share_offset',
  'course_share',
  'course_share_audit',
  'course_share_rate',
];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(
    `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS`,
  );
  await admin.query(`CREATE ROLE "${plainOwner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  // Found by name, not by number: renumbering at merge time must not move the starting point.
  const index = migrationFileNames.findIndex((file) => /^\d+_course_sharing\.sql$/.test(file));
  expect(index).toBeGreaterThan(0);
  expect(migrationFileNames[index - 1]).toMatch(/^\d+_course_deletion_ledger\.sql$/);
  versionsBefore = index;
  await migrate(upgradeUrl(), versionsBefore);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${plainOwner}"`);
  // What was there before 050: a protected area (no offset yet) and an erased account.
  await upgraded.query(
    `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
       radius_meters,created_at,updated_at) VALUES($1,$2,'집',127.02,37.5,300,now(),now())`,
    [liveTenant, zoneBefore],
  );
  await upgraded.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [erasedTenant]);
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await admin.query(`DROP ROLE IF EXISTS "${plainOwner}"`);
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

/** Every policy on the tables that existed before 050, as `table:policy:roles:cmd:qual`. */
async function earlierPolicies(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT tablename||':'||policyname||':'||array_to_string(roles,',')||':'||cmd||':'||
       coalesce(qual,'') AS entry
     FROM pg_policies WHERE schemaname='public' AND NOT (tablename = ANY($1::text[]))
     ORDER BY 1`,
    [newTables],
  );
  return rows.rows.map((row) => row.entry);
}

/** What a role that is neither superuser nor BYPASSRLS sees of `tenant_erasure`. */
async function erasureRowsSeenBy(role: string, tenant: string | null): Promise<number> {
  const client = await upgraded.connect();
  try {
    await client.query('BEGIN');
    await client.query(`GRANT SELECT ON tenant_erasure TO "${role}"`);
    await client.query(`SET LOCAL ROLE "${role}"`);
    if (tenant !== null)
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const seen = await client.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM tenant_erasure',
    );
    await client.query('ROLLBACK');
    return Number(seen.rows[0]?.total);
  } finally {
    client.release();
  }
}

function expectInOrder(body: string, fragments: readonly string[]): void {
  let previous = -1;
  for (const fragment of fragments) {
    const at = body.indexOf(fragment);
    expect(at, fragment).toBeGreaterThan(previous);
    previous = at;
  }
}

describe('course-sharing migration upgrade of a database built by every earlier one', () => {
  it('adds its tables and functions, re-wraps erase_account, and changes nothing else', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const bodiesBefore = await functionBodies();
    const eraseBefore = bodiesBefore.get('erase_account(text)');
    expect(eraseBefore).toBeDefined();
    const grantsBefore = await tableGrants();
    const policiesBefore = await earlierPolicies();
    // A plain owner sees no erasure row without a tenant, before 050 as after it.
    expect(await erasureRowsSeenBy(plainOwner, null)).toBe(0);

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
    expect(bodiesAfter.get('erase_account_before_course_sharing(text)')).toBe(eraseBefore);
    expect(
      [...bodiesAfter.keys()].filter((signature) => !bodiesBefore.has(signature)).sort(),
    ).toEqual(newFunctions);

    // The chain: 050 → 049 → 048 → what 048 wrapped. Each link takes the account lock, then
    // the per-tenant command lock, then deletes its own rows, then calls the next.
    expectInOrder(bodiesAfter.get('erase_account(text)') ?? '', [
      'ERASURE_TENANT_MISMATCH',
      'hashtextextended($1,77206)',
      'hashtextextended($1,0)',
      'DELETE FROM public.course_share_rate',
      'DELETE FROM public.course_share WHERE',
      'DELETE FROM public.course_share_audit',
      'DELETE FROM public.course_disclosure_receipt',
      'DELETE FROM public.course_privacy_zone_share_offset',
      'public.erase_account_before_course_sharing($1)',
    ]);
    expectInOrder(bodiesAfter.get('erase_account_before_course_sharing(text)') ?? '', [
      'hashtextextended($1,77206)',
      'hashtextextended($1,0)',
      'DELETE FROM public.course_deletion',
      'erase_account_before_course_deletion($1)',
    ]);
    expectInOrder(bodiesAfter.get('erase_account_before_course_deletion(text)') ?? '', [
      'hashtextextended($1,77206)',
      'hashtextextended($1,0)',
      'erase_account_before_garmin_unofficial($1)',
    ]);

    // Every new function and the new erase_account search pg_catalog first and pg_temp last.
    const paths = await upgraded.query<{ signature: string; config: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS signature,p.proconfig AS config FROM pg_proc p
       WHERE p.pronamespace='public'::regnamespace AND p.oid::regprocedure::text = ANY($1)
       ORDER BY 1`,
      [[...newFunctions, 'erase_account(text)']],
    );
    expect(paths.rows).toEqual(
      [...newFunctions, 'erase_account(text)']
        .sort()
        .map((signature) => ({ signature, config: ['search_path=pg_catalog, pg_temp'] })),
    );
    // Nothing is executable by PUBLIC.
    const publicExecute = await upgraded.query(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p,
         LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.pronamespace='public'::regnamespace AND a.grantee=0
         AND p.oid::regprocedure::text = ANY($1)`,
      [[...newFunctions, 'erase_account(text)']],
    );
    expect(publicExecute.rows).toEqual([]);

    // It grants nothing on any table, its own included.
    expect(await tableGrants()).toEqual(grantsBefore);
    // And it adds no policy to any earlier table (peer review item 2): 044/045's purge lease
    // and every other definer function see `tenant_erasure` exactly as before.
    expect(await earlierPolicies()).toEqual(policiesBefore);
    expect(await erasureRowsSeenBy(plainOwner, null)).toBe(0);
    expect(await erasureRowsSeenBy(plainOwner, erasedTenant)).toBe(1);

    const forced = await upgraded.query<{ table: string; on: boolean; forced: boolean }>(
      `SELECT relname AS table,relrowsecurity AS on,relforcerowsecurity AS forced FROM pg_class
       WHERE relnamespace='public'::regnamespace AND relname = ANY($1) ORDER BY 1`,
      [newTables],
    );
    expect(forced.rows).toEqual(newTables.map((table) => ({ table, on: true, forced: true })));
  });

  it('reaches the runtime role only through the grants written for it', async () => {
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    await grantCourses(upgradeUrl(), runtimeRole);
    const grants = (await tableGrants()).filter((entry) =>
      [...newTables, 'course_deletion'].some((table) => entry.startsWith(`${table}:`)),
    );
    expect(grants).toEqual(
      [
        `course_disclosure_receipt:${runtimeRole}:DELETE`,
        `course_disclosure_receipt:${runtimeRole}:INSERT`,
        `course_disclosure_receipt:${runtimeRole}:SELECT`,
        `course_privacy_zone_share_offset:${runtimeRole}:INSERT`,
        `course_privacy_zone_share_offset:${runtimeRole}:SELECT`,
        `course_share:${runtimeRole}:INSERT`,
        `course_share:${runtimeRole}:SELECT`,
        `course_share_audit:${runtimeRole}:INSERT`,
        `course_share_audit:${runtimeRole}:SELECT`,
      ].sort(),
    );
    // A link may only be revoked: those three columns are the whole UPDATE grant.
    const columns = await upgraded.query<{ column: string }>(
      `SELECT attname AS column FROM pg_attribute a,LATERAL aclexplode(a.attacl) x
       WHERE a.attrelid='public.course_share'::regclass AND x.privilege_type='UPDATE'
         AND pg_get_userbyid(x.grantee)=$1 ORDER BY 1`,
      [runtimeRole],
    );
    expect(columns.rows.map((row) => row.column)).toEqual(['revoke_reason', 'revoked_at', 'state']);
    const executable = await upgraded.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
       WHERE p.pronamespace='public'::regnamespace AND p.oid::regprocedure::text = ANY($1)
         AND has_function_privilege($2,p.oid,'EXECUTE') ORDER BY 1`,
      [newFunctions, runtimeRole],
    );
    expect(executable.rows.map((row) => row.signature)).toEqual([
      'export_course_deletions()',
      'read_course_share(text,integer,text,integer,integer,integer)',
      'reap_course_shares(integer)',
    ]);
  });

  it('draws a pre-050 area its offset once, on first use, and drops it with the area', async () => {
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    await grantCourses(upgradeUrl(), runtimeRole);
    const offsets = () =>
      upgraded.query('SELECT zone_id,offset_x,offset_y FROM course_privacy_zone_share_offset');
    expect((await offsets()).rows).toEqual([]);
    let draws = 0;
    const database = createDatabase({ connectionString: runtimeUrl(), max: 2 });
    try {
      const sharing = createCourseSharingRepository(database, {
        drawShareOffset: () => {
          draws += 1;
          return { x: 0.25, y: -0.5 };
        },
      });
      const first = await sharing.zonesWithShareOffsets(liveTenant);
      const second = await sharing.zonesWithShareOffsets(liveTenant);
      expect(draws).toBe(1);
      expect(first.map((entry) => [entry.zone.zoneId, entry.offset])).toEqual([
        [zoneBefore, { x: 0.25, y: -0.5 }],
      ]);
      expect(second).toEqual(first);
    } finally {
      await database.close();
    }
    expect((await offsets()).rows).toEqual([
      { zone_id: zoneBefore, offset_x: 0.25, offset_y: -0.5 },
    ]);
    await upgraded.query('DELETE FROM course_privacy_zone WHERE athlete_id=$1 AND zone_id=$2', [
      liveTenant,
      zoneBefore,
    ]);
    expect((await offsets()).rows).toEqual([]);
  });

  it('refuses an erased account’s link even when the read is owned by a plain role', async () => {
    await migrate(upgradeUrl());
    // The read and its reaper owned by a role that is neither superuser nor BYPASSRLS, with
    // the same owner-only policies 050 gives its own owner on its own two tables, and no
    // policy at all on `tenant_erasure`: the erasure check must still see the erased account.
    for (const statement of [
      `GRANT SELECT,UPDATE,DELETE ON course_share TO "${plainOwner}"`,
      `GRANT SELECT,INSERT,UPDATE,DELETE ON course_share_rate TO "${plainOwner}"`,
      `GRANT SELECT ON tenant_erasure TO "${plainOwner}"`,
      `CREATE POLICY probe_share ON course_share TO "${plainOwner}" USING (true)`,
      `CREATE POLICY probe_rate ON course_share_rate TO "${plainOwner}" USING (true) WITH CHECK (true)`,
      `ALTER FUNCTION public.reap_course_shares(integer) OWNER TO "${plainOwner}"`,
      `ALTER FUNCTION public.read_course_share(text,integer,text,integer,integer,integer)
         OWNER TO "${plainOwner}"`,
    ])
      await upgraded.query(statement);
    const tokenOf = (tenant: string) => createHash('sha256').update(tenant).digest('hex');
    const client = await upgraded.connect();
    try {
      // Rows only, without the course they would hang from: foreign keys and triggers off.
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      for (const tenant of [liveTenant, erasedTenant])
        await client.query(
          `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
             token_digest,epoch,state,include_names,zone_ids,snapshot,created_at,expires_at)
           VALUES($1,$2,$3,1,$4,$5,1,'active',false,ARRAY[$6::uuid],'{"coordinates":[]}'::jsonb,
             now(),now()+interval '1 day')`,
          [tenant, randomUUID(), randomUUID(), randomUUID(), tokenOf(tenant), randomUUID()],
        );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const read = async (tenant: string) =>
      (
        await upgraded.query<{ outcome: string }>(
          'SELECT outcome FROM public.read_course_share($1,1,$2,30,60,100)',
          [tokenOf(tenant), 'a'.repeat(64)],
        )
      ).rows[0]?.outcome;
    expect(await read(liveTenant)).toBe('ok');
    expect(await read(erasedTenant)).toBe('not_found');
    // The tenant the read names for its erasure check is put back at once: a caller that had
    // a tenant set keeps it for the rest of its transaction.
    const caller = await upgraded.connect();
    try {
      await caller.query('BEGIN');
      await caller.query("SELECT set_config('app.athlete_id',$1,true)", [liveTenant]);
      const answered = await caller.query<{ outcome: string }>(
        'SELECT outcome FROM public.read_course_share($1,1,$2,30,60,100)',
        [tokenOf(erasedTenant), 'b'.repeat(64)],
      );
      expect(answered.rows[0]?.outcome).toBe('not_found');
      const setting = await caller.query<{ value: string }>(
        "SELECT current_setting('app.athlete_id',true) AS value",
      );
      expect(setting.rows[0]?.value).toBe(liveTenant);
      await caller.query('ROLLBACK');
    } finally {
      caller.release();
    }
  });
});
