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
import {
  createResourceObjectCleanupRepository,
  processOneObjectScopePurge,
  processOneTenantObjectPurge,
} from '../src/resource-object-cleanup.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The plain-owner purge migration (M2-01at) on a database that a migration owner which is
 * neither superuser nor BYPASSRLS built, one migration at a time, with rows from before the
 * purges existed: an erased account, a deleted activity and an unavailable course.
 *
 * It must change exactly what it says and nothing else:
 *   * no earlier checksum; every function body but the two leases unchanged, and each lease
 *     body equal to the previous one with only the tenant-less reads swapped for the helpers;
 *   * exactly two new policies, both on the purge tables and for the owner only; every other
 *     policy the same; FORCE still on for every table that had it;
 *   * so no other definer function sees more: the owner still sees no `tenant_erasure`,
 *     `activity_canonical` or `course` row without a tenant, and nothing but the owner holds
 *     any privilege on either purge table, grant helpers included;
 *   * and what 044/046 failed to arm on this owner is armed now, and leasable.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `plain_up_${suffix}`;
const ownerRole = `plain_up_owner_${suffix}`;
const runtimeRole = `plain_up_rt_${suffix}`;
const workerRole = `plain_up_worker_${suffix}`;

function urlFor(role: string | null): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  if (role !== null) {
    url.username = role;
    url.password = 'plain';
  }
  return url.toString();
}

// Found by name, never by number: a migration merged in before them renumbers them.
const indexOf = (pattern: RegExp) => {
  const index = migrationFileNames.findIndex((name) => pattern.test(name));
  if (index < 0) throw new Error(`${pattern} is not in the migration list`);
  return index;
};
const beforePurges = indexOf(/^\d+_tenant_object_purge\.sql$/);
const plainOwnerIndex = indexOf(/^\d+_object_purge_plain_owner\.sql$/);
const versionsBefore = plainOwnerIndex;

const erased = randomUUID();
const liveTenant = randomUUID();
const deletedActivity = randomUUID();
const unavailableCourse = randomUUID();

const newFunctions = [
  'object_purge_scope_live(text,text,uuid)',
  'object_purge_tenant_erased(text)',
];
const replacedLeases = {
  'lease_tenant_object_purge(uuid,timestamp with time zone,timestamp with time zone)': [
    [
      'EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=p.athlete_id)',
      'public.object_purge_tenant_erased(p.athlete_id)',
    ],
  ],
  'lease_object_scope_purge(uuid,timestamp with time zone,timestamp with time zone)': [
    [
      `(EXISTS(SELECT 1 FROM public.activity_canonical c
          WHERE p.scope_kind='activity' AND c.athlete_id=p.athlete_id AND c.id=p.scope_id
            AND NOT c.deleted)
        OR EXISTS(SELECT 1 FROM public.course c
          WHERE p.scope_kind='course' AND c.athlete_id=p.athlete_id AND c.course_id=p.scope_id
            AND c.status='available'))`,
      'public.object_purge_scope_live(p.athlete_id,p.scope_kind,p.scope_id)',
    ],
    [
      `NOT EXISTS(SELECT 1 FROM public.activity_canonical c
        WHERE p.scope_kind='activity' AND c.athlete_id=p.athlete_id AND c.id=p.scope_id
          AND NOT c.deleted)
      AND NOT EXISTS(SELECT 1 FROM public.course c
        WHERE p.scope_kind='course' AND c.athlete_id=p.athlete_id AND c.course_id=p.scope_id
          AND c.status='available')`,
      'NOT public.object_purge_scope_live(p.athlete_id,p.scope_kind,p.scope_id)',
    ],
  ],
} as const;
const purgeTables = ['object_scope_purge', 'tenant_object_purge'];

let upgraded: Pool;

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${ownerRole}"`);
  upgraded = new Pool({ connectionString: urlFor(null) });
  await migrate(urlFor(ownerRole), beforePurges);
  // Before the purges existed: an erased account, a deleted activity, an unavailable course.
  // Written in the tenant's session, as the application writes them (the owner's triggers fire).
  await asTenant(erased, 'INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [erased]);
  await asTenant(
    liveTenant,
    `INSERT INTO activity_canonical(athlete_id,id,revision,original,deleted)
     VALUES($1,$2,2,'{}'::jsonb,true)`,
    [liveTenant, deletedActivity],
  );
  await asTenant(
    liveTenant,
    `INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
       reclaimed_at,created_at,updated_at)
     VALUES($1,$2,'Gone','private','unavailable','source_activity_deleted',now(),now(),now())`,
    [liveTenant, unavailableCourse],
  );
  await migrate(urlFor(ownerRole), versionsBefore);
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [workerRole, runtimeRole, ownerRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

async function asTenant(tenant: string, statement: string, values: unknown[]): Promise<void> {
  const client = await upgraded.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    await client.query(statement, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

type FunctionFacts = { body: string; definer: boolean; owner: string; config: string | null };

async function functions(): Promise<Map<string, FunctionFacts>> {
  const rows = await upgraded.query<{ signature: string } & FunctionFacts>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body,p.prosecdef AS definer,
       pg_get_userbyid(p.proowner) AS owner,array_to_string(p.proconfig,';') AS config
     FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace,
       'identity_private'::regnamespace,'garmin_private'::regnamespace)`,
  );
  return new Map(rows.rows.map(({ signature, ...facts }) => [signature, facts]));
}

async function policies(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT schemaname||'.'||tablename||':'||policyname||':'||array_to_string(roles,',')||':'||
       cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'') AS entry
     FROM pg_policies ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

async function rowSecurity(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT n.nspname||'.'||c.relname||':'||c.relrowsecurity||':'||c.relforcerowsecurity AS entry
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

/** Every privilege any role but the owner holds on the purge tables, columns included. */
async function purgeTablePrivileges(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT c.relname||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')||':'||a.privilege_type
       AS entry
     FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     WHERE c.relname=ANY($1) AND a.grantee<>c.relowner
     UNION ALL
     SELECT c.relname||'.'||t.attname||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')||':'||
       a.privilege_type
     FROM pg_class c JOIN pg_attribute t ON t.attrelid=c.oid,LATERAL aclexplode(t.attacl) a
     WHERE c.relname=ANY($1)
     ORDER BY 1`,
    [purgeTables],
  );
  return rows.rows.map((row) => row.entry);
}

/** What the owner itself sees of a tenant table, with no tenant set or with one. */
async function ownerSees(table: string, tenant: string | null): Promise<number> {
  const client = await upgraded.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE "${ownerRole}"`);
    if (tenant !== null)
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const seen = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${table}`,
    );
    return Number(seen.rows[0]?.total);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function armedRows(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT 'tenant:'||athlete_id AS entry FROM tenant_object_purge
     WHERE athlete_id=$1 AND completed_at IS NULL AND available_at<=clock_timestamp()
     UNION ALL
     SELECT scope_kind||':'||scope_id FROM object_scope_purge
     WHERE athlete_id=$2 AND completed_at IS NULL AND available_at<=clock_timestamp()
     ORDER BY 1`,
    [erased, liveTenant],
  );
  return rows.rows.map((row) => row.entry);
}

describe('plain-owner purge migration upgrade of a database a plain owner built', () => {
  it('arms what 044/046 missed and changes nothing else', async () => {
    // The starting point is what the issue says: on this owner 044's and 046's backfills saw
    // no erased account, deleted activity or unavailable course.
    expect(await armedRows()).toEqual([]);
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const functionsBefore = await functions();
    const policiesBefore = await policies();
    const rowSecurityBefore = await rowSecurity();
    for (const table of ['tenant_erasure', 'activity_canonical', 'course'])
      expect(await ownerSees(table, null), table).toBe(0);

    await expect(migrate(urlFor(ownerRole), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);

    const functionsAfter = await functions();
    expect(
      [...functionsAfter.keys()].filter((signature) => !functionsBefore.has(signature)).sort(),
    ).toEqual(newFunctions);
    for (const [signature, facts] of functionsBefore) {
      const now = functionsAfter.get(signature);
      const swaps = (replacedLeases as Record<string, readonly (readonly [string, string])[]>)[
        signature
      ];
      if (!swaps) {
        expect(now, `${signature} changed`).toEqual(facts);
        continue;
      }
      // Each lease is the previous body with only the tenant-less reads swapped, still a
      // definer of the same owner; its search path now ends in pg_temp.
      let expected = facts.body;
      for (const [from, to] of swaps) {
        expect(expected.split(from).length - 1, `${signature}: ${from}`).toBe(1);
        expected = expected.replace(from, to);
      }
      expect(now?.body).toBe(expected);
      expect(now).toMatchObject({
        definer: true,
        owner: facts.owner,
        config: 'search_path=pg_catalog, pg_temp',
      });
      expect(facts.config).toBe('search_path=pg_catalog');
    }
    for (const signature of newFunctions)
      expect(functionsAfter.get(signature)).toMatchObject({
        definer: false,
        owner: ownerRole,
        config: 'search_path=pg_catalog, pg_temp',
      });

    // Exactly two new policies, on the purge tables, for the owner only.
    const policiesAfter = await policies();
    expect(policiesAfter.filter((entry) => !policiesBefore.includes(entry))).toEqual([
      `public.object_scope_purge:object_scope_purge_definer:${ownerRole}:ALL:true:true`,
      `public.tenant_object_purge:tenant_object_purge_definer:${ownerRole}:ALL:true:true`,
    ]);
    expect(policiesBefore.filter((entry) => !policiesAfter.includes(entry))).toEqual([]);
    // FORCE, lifted for the backfill, is back on everywhere it was.
    expect(await rowSecurity()).toEqual(rowSecurityBefore);
    // No other definer function sees more: the owner still sees no tenant row without a tenant.
    for (const table of ['tenant_erasure', 'activity_canonical', 'course'])
      expect(await ownerSees(table, null), table).toBe(0);
    expect(await ownerSees('tenant_erasure', erased)).toBe(1);
    expect(await ownerSees('activity_canonical', liveTenant)).toBe(1);

    // What 044/046 missed is armed now, due at once.
    expect(await armedRows()).toEqual([
      `activity:${deletedActivity}`,
      `course:${unavailableCourse}`,
      `tenant:${erased}`,
    ]);
    // Idempotent: a second run applies nothing and arms nothing more.
    await migrate(urlFor(ownerRole));
    expect((await checksums()).size).toBe(versionsBefore + 1);
    const counts = await upgraded.query<{ tenants: number; scopes: number }>(
      `SELECT (SELECT count(*)::int FROM tenant_object_purge) AS tenants,
         (SELECT count(*)::int FROM object_scope_purge) AS scopes`,
    );
    expect(counts.rows[0]).toEqual({ tenants: 1, scopes: 2 });
  });

  it('reaches the purge tables only through the owner, grant helpers included', async () => {
    await migrate(urlFor(ownerRole));
    const owner = urlFor(ownerRole);
    const pool = new Pool({ connectionString: owner, max: 1 });
    try {
      await pool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}"`);
    } finally {
      await pool.end();
    }
    await grantOperations(owner, runtimeRole);
    await grantActivityTracks(owner, runtimeRole);
    await grantCourses(owner, runtimeRole);
    await grantResourceObjectCleanupWorker(owner, workerRole);
    expect(await purgeTablePrivileges()).toEqual([]);
    // Who touches the purge tables at all: the owner's own purge functions and nothing else.
    const touching = await upgraded.query<{ signature: string; owner: string }>(
      `SELECT p.oid::regprocedure::text AS signature,pg_get_userbyid(p.proowner) AS owner
       FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND p.prosrc ~ 'public\\.(tenant_object_purge|object_scope_purge)([^_a-z]|$)'
       ORDER BY 1`,
    );
    expect(touching.rows.every((row) => row.owner === ownerRole)).toBe(true);
    expect(touching.rows.map((row) => row.signature)).toEqual([
      'arm_object_scope_purge(text,text,uuid)',
      'erase_account_before_routing_admission(text)',
      'finish_object_scope_purge(text,text,uuid,uuid,boolean,text,integer,integer,boolean)',
      'finish_tenant_object_purge(text,uuid,boolean,text,integer,integer,boolean)',
      'lease_object_scope_purge(uuid,timestamp with time zone,timestamp with time zone)',
      'lease_tenant_object_purge(uuid,timestamp with time zone,timestamp with time zone)',
      'replay_course_deletion(text,uuid,timestamp with time zone)',
    ]);
    // The helpers are the leases' own: nobody else may call them.
    const callers = await upgraded.query<{ entry: string }>(
      `SELECT p.oid::regprocedure::text||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC') AS entry
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.oid::regprocedure::text=ANY($1) AND a.grantee<>p.proowner`,
      [newFunctions],
    );
    expect(callers.rows).toEqual([]);
    // The worker keeps its lease grants: the replaced leases were replaced in place.
    const executable = await upgraded.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
       WHERE p.proname IN ('lease_tenant_object_purge','lease_object_scope_purge',
         'object_purge_tenant_erased','object_purge_scope_live')
         AND has_function_privilege($1,p.oid,'EXECUTE') ORDER BY 1`,
      [workerRole],
    );
    expect(executable.rows.map((row) => row.signature)).toEqual([
      'lease_object_scope_purge(uuid,timestamp with time zone,timestamp with time zone)',
      'lease_tenant_object_purge(uuid,timestamp with time zone,timestamp with time zone)',
    ]);
  });

  it('lets the worker lease and finish what the backfill armed', async () => {
    await migrate(urlFor(ownerRole));
    await grantResourceObjectCleanupWorker(urlFor(ownerRole), workerRole);
    const worker = createResourceObjectCleanupRepository({
      connectionString: urlFor(workerRole),
      max: 1,
    });
    const empty = { keys: [], unrecognized: 0 } as const;
    try {
      const tenantRun = await processOneTenantObjectPurge(worker, {
        listTenantObjects: async () => empty,
        delete: async () => undefined,
        stat: async () => null,
      });
      expect(tenantRun).toBe('passed');
      const scopeRuns: string[] = [];
      for (let run = 0; run < 3; run += 1)
        scopeRuns.push(
          await processOneObjectScopePurge(worker, {
            listScopeObjects: async () => empty,
            delete: async () => undefined,
            stat: async () => null,
          }),
        );
      expect(scopeRuns).toEqual(['passed', 'passed', 'empty']);
    } finally {
      await worker.close();
    }
    const passes = await upgraded.query<{ entry: string }>(
      `SELECT 'tenant:'||passes AS entry FROM tenant_object_purge WHERE athlete_id=$1
       UNION ALL SELECT scope_kind||':'||passes FROM object_scope_purge WHERE athlete_id=$2
       ORDER BY 1`,
      [erased, liveTenant],
    );
    expect(passes.rows.map((row) => row.entry)).toEqual(['activity:1', 'course:1', 'tenant:1']);
  });
});
