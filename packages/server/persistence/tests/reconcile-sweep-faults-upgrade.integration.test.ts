import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantResourceObjectCleanupWorker, migrate } from '../src/migrate.js';

/**
 * Migration 040 (M2-01n) has to run against a populated 039 database, with the worker role
 * holding exactly what M2-01m gave it, and leave every earlier migration alone. It adds
 * columns to two index tables and new functions, and takes EXECUTE on the two superseded
 * candidate functions away from everyone — without dropping or editing them.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `sweep_fault_up_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const workerRole = `sweep_fault_up_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
// Stands in for the runtime role as the pre-040 `grantActivityTracks` left it: table-level
// SELECT and INSERT on the track reference index.
const runtimeRole = `sweep_fault_rt_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
const versionsThrough039 = 39;

/**
 * The 039-era sweep surface, written out: the grant helper now names functions 040 creates,
 * so it cannot run against a 039 database.
 */
const grantsAt039 = [
  'public.activity_track_reconcile_cursor()',
  'public.advance_activity_track_reconcile_cursor(text)',
  'public.activity_track_reconcile_candidates(text,integer)',
  'public.settle_activity_track_object_ref(text)',
  'public.reclaim_unreferenced_activity_track_object(text)',
  'public.course_thumbnail_reconcile_cursor()',
  'public.advance_course_thumbnail_reconcile_cursor(text)',
  'public.course_thumbnail_reconcile_candidates(text,integer)',
  'public.settle_course_thumbnail_object_ref(text)',
  'public.reclaim_unreferenced_course_thumbnail_object(text)',
];
const trackRef = `private/v1/tenants/${randomUUID()}/activities/${randomUUID()}/tracks/${randomUUID()}/temporary/${randomUUID()}/raw`;
const thumbnailRef = `private/v1/tenants/${randomUUID()}/courses/${randomUUID()}/thumbnails/temporary/${randomUUID()}`;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  await migrate(upgradeUrl(), versionsThrough039);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  for (const signature of grantsAt039)
    await upgraded.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${workerRole}"`);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await upgraded.query(`GRANT SELECT,INSERT ON activity_track_object_ref TO "${runtimeRole}"`);
  // Populated: one watched reference in each index, as 039 left them.
  await upgraded.query(
    `INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
     VALUES($1,$2,clock_timestamp())`,
    [trackRef, randomUUID()],
  );
  await upgraded.query(
    `INSERT INTO course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
     VALUES($1,$2,clock_timestamp())`,
    [thumbnailRef, randomUUID()],
  );
});

afterAll(async () => {
  await upgraded?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS "${workerRole}"`);
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
    [workerRole],
  );
  return rows.rows.map((row) => row.signature);
}

async function candidateBodies(): Promise<Map<string, string>> {
  const rows = await upgraded.query<{ name: string; body: string }>(
    `SELECT proname AS name,prosrc AS body FROM pg_proc
     WHERE proname IN ('activity_track_reconcile_candidates','course_thumbnail_reconcile_candidates')`,
  );
  return new Map(rows.rows.map((row) => [row.name, row.body]));
}

describe('migration 040 upgrade of a populated 039 database', () => {
  it('leaves earlier migrations and the superseded functions intact, and takes their grants away', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsThrough039);
    const grantedAt039 = await granted();
    expect(grantedAt039).toContain('activity_track_reconcile_candidates(text,integer)');
    expect(grantedAt039).toContain('course_thumbnail_reconcile_candidates(text,integer)');
    const bodiesAt039 = await candidateBodies();
    expect(bodiesAt039.size).toBe(2);

    await expect(migrate(upgradeUrl(), 40)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsThrough039 + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);

    // Not dropped and not edited — only nobody may run them any more.
    expect(await candidateBodies()).toEqual(bodiesAt039);
    const afterUpgrade = await granted();
    expect(afterUpgrade).not.toContain('activity_track_reconcile_candidates(text,integer)');
    expect(afterUpgrade).not.toContain('course_thumbnail_reconcile_candidates(text,integer)');
    const anyoneElse = await upgraded.query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.proname IN ('activity_track_reconcile_candidates',
         'course_thumbnail_reconcile_candidates') AND a.grantee<>p.proowner`,
    );
    expect(Number(anyoneElse.rows[0]?.total)).toBe(0);

    // The rows 039 left carry no fault, and satisfy the new constraint.
    for (const [table, ref] of [
      ['activity_track_object_ref', trackRef],
      ['course_thumbnail_object_ref', thumbnailRef],
    ] as const) {
      const row = await upgraded.query(
        `SELECT settled_at,sweep_attempts,sweep_error_code,sweep_first_failed_at,
           sweep_failed_at,sweep_retry_at FROM ${table} WHERE storage_ref=$1`,
        [ref],
      );
      expect(row.rows).toEqual([
        {
          settled_at: null,
          sweep_attempts: 0,
          sweep_error_code: null,
          sweep_first_failed_at: null,
          sweep_failed_at: null,
          sweep_retry_at: null,
        },
      ]);
    }

    // Re-granting on the upgraded database swaps exactly the two windows for the six new
    // functions, and adds nothing else to the sweep surface.
    await expect(migrate(upgradeUrl())).resolves.toBeUndefined();
    await grantResourceObjectCleanupWorker(upgradeUrl(), workerRole);
    const grantedNow = await granted();
    const sweepSurface = (entries: readonly string[]) =>
      new Set(
        entries.filter((entry) =>
          /reconcile|sweep_fault|object_ref\(|reclaim_unreferenced/.test(entry),
        ),
      );
    const added = [...sweepSurface(grantedNow)].filter((entry) => !grantedAt039.includes(entry));
    const removed = [...sweepSurface(grantedAt039)].filter((entry) => !grantedNow.includes(entry));
    expect(new Set(added)).toEqual(
      new Set([
        'activity_track_reconcile_window(text,integer)',
        'course_thumbnail_reconcile_window(text,integer)',
        'record_activity_track_sweep_fault(text,text)',
        'record_course_thumbnail_sweep_fault(text,text)',
        'clear_activity_track_sweep_fault(text)',
        'clear_course_thumbnail_sweep_fault(text)',
      ]),
    );
    expect(new Set(removed)).toEqual(
      new Set([
        'activity_track_reconcile_candidates(text,integer)',
        'course_thumbnail_reconcile_candidates(text,integer)',
      ]),
    );
  });

  it('takes the whole-row INSERT a pre-040 runtime grant gave and leaves only the recording columns', async () => {
    // Runs after the upgrade above. A table-level grant given before 040 is not narrowed by
    // changing the grant helper; the migration itself has to take it away.
    const privileges = await upgraded.query<{ privilege: string; held: boolean }>(
      `SELECT p.label AS privilege,
         CASE WHEN p.column_name IS NULL
           THEN has_table_privilege($1,'activity_track_object_ref',p.privilege)
           ELSE has_column_privilege($1,'activity_track_object_ref',p.column_name,p.privilege)
         END AS held
       FROM (VALUES('table INSERT',NULL,'INSERT'),('table SELECT',NULL,'SELECT'),
         ('storage_ref','storage_ref','INSERT'),('athlete_id','athlete_id','INSERT'),
         ('recorded_at','recorded_at','INSERT'),('settled_at','settled_at','INSERT'),
         ('sweep_attempts','sweep_attempts','INSERT'),('sweep_error_code','sweep_error_code','INSERT'),
         ('sweep_retry_at','sweep_retry_at','INSERT')) p(label,column_name,privilege)
       ORDER BY p.label`,
      [runtimeRole],
    );
    expect(Object.fromEntries(privileges.rows.map((row) => [row.privilege, row.held]))).toEqual({
      'table INSERT': false,
      'table SELECT': true,
      storage_ref: true,
      athlete_id: true,
      recorded_at: true,
      settled_at: false,
      sweep_attempts: false,
      sweep_error_code: false,
      sweep_retry_at: false,
    });
  });

  it('keeps both index tables behind forced row-level security with no table grants', async () => {
    const security = await upgraded.query<{
      relname: string;
      rowsecurity: boolean;
      forced: boolean;
    }>(
      `SELECT relname,relrowsecurity AS rowsecurity,relforcerowsecurity AS forced
       FROM pg_class WHERE relname IN ('activity_track_object_ref','course_thumbnail_object_ref')
       ORDER BY relname`,
    );
    expect(security.rows).toEqual([
      { relname: 'activity_track_object_ref', rowsecurity: true, forced: true },
      { relname: 'course_thumbnail_object_ref', rowsecurity: true, forced: true },
    ]);
    const tableGrants = await upgraded.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM information_schema.role_table_grants
       WHERE table_name IN ('activity_track_object_ref','course_thumbnail_object_ref')
         AND grantee=$1`,
      [workerRole],
    );
    expect(Number(tableGrants.rows[0]?.total)).toBe(0);
  });
});
