import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantCourses, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The accessibility-note migration (M2-01r, filed as 043) has to run on a database every
 * earlier migration already built and leave all of them alone: no earlier migration's
 * checksum, no existing function body — `erase_account` above all, whose lock order has
 * deadlocked in this repository before — and no existing table's grants. It adds one table,
 * forces row-level security on it, and grants nothing by itself.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `note_up_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const runtimeRole = `note_rt_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
/** Every migration before this one, whatever number the merge gives it. */
let versionsBefore = 0;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  // Found by name, not by number or position: renumbering at merge time, or migrations
  // added after this one, must not make this test upgrade from the wrong place.
  const index = migrationFileNames.findIndex((file) =>
    /^\d+_course_accessibility_notes\.sql$/.test(file),
  );
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

/** Every function in `public`, with its body: nothing earlier may be redefined. */
async function functionBodies(): Promise<Map<string, string>> {
  const rows = await upgraded.query<{ signature: string; body: string }>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace`,
  );
  return new Map(rows.rows.map((row) => [row.signature, row.body]));
}

/** Every table privilege anybody but the owner holds in `public`. */
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

describe('accessibility-note migration upgrade of a database built by every earlier one', () => {
  it('adds one forced-RLS table and changes nothing that was there', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const bodiesBefore = await functionBodies();
    expect(bodiesBefore.has('erase_account(text)')).toBe(true);
    const grantsBefore = await tableGrants();

    // Exactly this migration, whatever comes after it.
    await expect(migrate(upgradeUrl(), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    expect(await functionBodies()).toEqual(bodiesBefore);
    // It grants nothing: not to PUBLIC, not to any role, on any table — its own included.
    expect(await tableGrants()).toEqual(grantsBefore);

    const table = await upgraded.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid='public.course_accessibility_note'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const reference = await upgraded.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='public.course_accessibility_note'::regclass AND contype='f'`,
    );
    expect(reference.rows.map((row) => row.definition)).toEqual([
      'FOREIGN KEY (athlete_id, course_id) REFERENCES course(athlete_id, course_id) ON DELETE CASCADE',
    ]);
  });

  it('is reachable by the runtime role only through the grants written for it', async () => {
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    await grantCourses(upgradeUrl(), runtimeRole);
    const grants = (await tableGrants()).filter((entry) =>
      entry.startsWith(`course_accessibility_note:`),
    );
    expect(grants).toEqual(
      [
        `course_accessibility_note:${runtimeRole}:DELETE`,
        `course_accessibility_note:${runtimeRole}:INSERT`,
        `course_accessibility_note:${runtimeRole}:SELECT`,
      ].sort(),
    );
    const columns = await upgraded.query<{ column: string }>(
      `SELECT attname AS column FROM pg_attribute a,
         LATERAL aclexplode(a.attacl) x
       WHERE a.attrelid='public.course_accessibility_note'::regclass AND x.privilege_type='UPDATE'
         AND pg_get_userbyid(x.grantee)=$1 ORDER BY 1`,
      [runtimeRole],
    );
    expect(columns.rows.map((row) => row.column)).toEqual([
      'note',
      'updated_at',
      'written_at_revision',
    ]);
  });
});
