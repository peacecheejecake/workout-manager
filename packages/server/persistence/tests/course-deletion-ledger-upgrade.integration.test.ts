import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The course-deletion ledger migration (M2-01ao, filed as 049 after main's 048 Garmin migration) on a database every earlier
 * migration already built. It adds one table, one trigger and three functions, replaces
 * `delete_course`'s body, wraps `erase_account` once more, and must leave everything else alone:
 * no earlier checksum, no other function body, and no table grant.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `course_del_up_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
let versionsBefore = 0;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  // Found by name, not by number: renumbering at merge time must not move the starting point.
  const index = migrationFileNames.findIndex((file) =>
    /^\d+_course_deletion_ledger\.sql$/.test(file),
  );
  expect(index).toBeGreaterThan(0);
  versionsBefore = index;
  await migrate(upgradeUrl(), versionsBefore);
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
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

/** Positions of each fragment in `body`, which must all be present and in this order. */
function expectInOrder(body: string, fragments: readonly string[]): void {
  let previous = -1;
  for (const fragment of fragments) {
    const at = body.indexOf(fragment);
    expect(at, fragment).toBeGreaterThan(previous);
    previous = at;
  }
}

describe('course-deletion ledger migration upgrade of a database built by every earlier one', () => {
  it('adds its table and functions, replaces delete_course, re-wraps erase_account, and changes nothing else', async () => {
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
      if (signature === 'erase_account(text)' || signature === 'delete_course(uuid,integer)')
        continue;
      expect(bodiesAfter.get(signature), `${signature} changed`).toBe(body);
    }
    // The previous erasure chain is kept byte for byte under its new name.
    expect(bodiesAfter.get('erase_account_before_course_deletion(text)')).toBe(eraseBefore);
    expect(
      [...bodiesAfter.keys()].filter((signature) => !bodiesBefore.has(signature)).sort(),
    ).toEqual([
      'apply_course_deletion(text,uuid,timestamp with time zone)',
      'course_deletion_terminal()',
      'erase_account_before_course_deletion(text)',
      'replay_course_deletion(text,uuid,timestamp with time zone)',
    ]);
    // Lock order: the account lock, then the per-tenant command lock, then rows.
    expectInOrder(bodiesAfter.get('erase_account(text)') ?? '', [
      'hashtextextended($1,77206)',
      'hashtextextended($1,0)',
      'DELETE FROM public.course_deletion',
      'erase_account_before_course_deletion($1)',
    ]);
    // The live deletion keeps 038's checks and row lock, then runs the shared body.
    expectInOrder(bodiesAfter.get('delete_course(uuid,integer)') ?? '', [
      'INVALID_COURSE_DELETE',
      'FOR UPDATE',
      'COURSE_REVISION_CONFLICT',
      'public.apply_course_deletion(tenant,$1,clock_timestamp())',
    ]);
    // The shared body: pictures and purge while the picture rows still exist, then 036's
    // removal order, then the ledger row last.
    expectInOrder(
      bodiesAfter.get('apply_course_deletion(text,uuid,timestamp with time zone)') ?? '',
      [
        "supersede_course_thumbnails($1,$2,NULL,'course_deleted')",
        "arm_object_scope_purge($1,'course',$2)",
        'DELETE FROM public.course_route_candidate_set',
        'DELETE FROM public.course_route_proposal',
        'DELETE FROM public.course_revision',
        'DELETE FROM public.course WHERE',
        'INSERT INTO public.course_deletion',
      ],
    );
    // The replay takes the command lock before any row.
    expectInOrder(
      bodiesAfter.get('replay_course_deletion(text,uuid,timestamp with time zone)') ?? '',
      [
        'COURSE_REPLAY_TENANT_MISMATCH',
        'hashtextextended($1,0)',
        'COURSE_REPLAY_TENANT_UNKNOWN',
        'FOR UPDATE',
        'apply_course_deletion($1,$2,$3)',
      ],
    );
    // It grants nothing on any table, its own included.
    expect(await tableGrants()).toEqual(grantsBefore);

    const table = await upgraded.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid='public.course_deletion'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const trigger = await upgraded.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid='public.course'::regclass
         AND tgname='course_deletion_terminal' AND NOT tgisinternal`,
    );
    expect(trigger.rowCount).toBe(1);
    // Every new or replaced function searches pg_catalog first and pg_temp last.
    const paths = await upgraded.query<{ signature: string; config: string[] }>(
      `SELECT p.oid::regprocedure::text AS signature,p.proconfig AS config FROM pg_proc p
       WHERE p.pronamespace='public'::regnamespace
         AND p.proname IN ('apply_course_deletion','course_deletion_terminal','delete_course',
                           'erase_account','replay_course_deletion')
       ORDER BY 1`,
    );
    expect(paths.rows).toEqual(
      [
        'apply_course_deletion(text,uuid,timestamp with time zone)',
        'course_deletion_terminal()',
        'delete_course(uuid,integer)',
        'erase_account(text)',
        'replay_course_deletion(text,uuid,timestamp with time zone)',
      ].map((signature) => ({ signature, config: ['search_path=pg_catalog, pg_temp'] })),
    );
    // Nothing is granted to PUBLIC.
    const publicExecute = await upgraded.query(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p,
         LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.pronamespace='public'::regnamespace AND a.grantee=0
         AND p.proname IN ('apply_course_deletion','course_deletion_terminal','delete_course',
                           'erase_account','erase_account_before_course_deletion',
                           'replay_course_deletion')`,
    );
    expect(publicExecute.rows).toEqual([]);
  });
});
