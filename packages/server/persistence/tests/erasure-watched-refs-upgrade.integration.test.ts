import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The erasure watched-ref migration (M2-01s, 042) has to run against a populated database and leave every earlier
 * migration alone. It renames the outermost `erase_account` link once more and adds a new
 * outermost link that queues what the two reference indexes still watch. Three things are
 * checked, the same three the earlier rename links were checked for: no earlier migration
 * file changed (its recorded checksum is unchanged), the renamed link carries no grant
 * forward under either name, and the renamed body is the 040 body byte for byte.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `erase_watched_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const runtimeRole = `erase_watched_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
// The head just before this migration, found by name rather than by number. It was written as
// "040, then the next file", and M2-01p's 041 landed in between at merge — so the migration is
// located in the list the runner applies, which survives renumbering and later files alike.
const erasureIndex = migrationFileNames.findIndex((name) =>
  /^\d+_erasure_queues_watched_object_refs\.sql$/.test(name),
);
if (erasureIndex < 0) throw new Error('erasure watched-ref migration is not in the list');
const versionsBeforeErasure = erasureIndex;
const athlete = randomUUID();
const trackRef = `private/v1/tenants/${athlete}/activities/${randomUUID()}/tracks/${randomUUID()}/raw/uploads/${randomUUID()}/sha256/${'a'.repeat(64)}.gpx`;
const thumbnailRef = `private/v1/tenants/${athlete}/courses/${randomUUID()}/thumbnails/revisions/${randomUUID()}/sha256/${'b'.repeat(64)}.svg`;
const otherTenantRef = `private/v1/tenants/${randomUUID()}/courses/${randomUUID()}/thumbnails/temporary/${randomUUID()}`;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  await migrate(upgradeUrl(), versionsBeforeErasure);
  // The 040-era grant `grantOperations` gave the runtime role, written out.
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await upgraded.query(`GRANT EXECUTE ON FUNCTION public.erase_account(text) TO "${runtimeRole}"`);
  // Populated: one orphan in each index that nothing else names, one of them with a receipt
  // that already closed, and one watched key of another tenant.
  await upgraded.query(
    `INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
     VALUES($1,$2,clock_timestamp()-interval '9 days')`,
    [trackRef, athlete],
  );
  await upgraded.query(
    `INSERT INTO course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
     VALUES($1,$2,clock_timestamp()-interval '9 days'),($3,$4,clock_timestamp())`,
    [thumbnailRef, athlete, otherTenantRef, randomUUID()],
  );
  await upgraded.query(
    `INSERT INTO resource_object_cleanup(id,storage_ref,reason,attempts,available_at,created_at,completed_at)
     VALUES($1,$2,'upload_abandoned',1,clock_timestamp()-interval '9 days',
       clock_timestamp()-interval '9 days',clock_timestamp()-interval '9 days')`,
    [randomUUID(), thumbnailRef],
  );
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
    `SELECT pg_get_userbyid(a.grantee) AS grantee
     FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.proname=$1 AND a.grantee<>p.proowner ORDER BY 1`,
    [name],
  );
  return rows.rows.map((row) => row.grantee);
}

describe('erasure watched-ref migration upgrade of a populated database', () => {
  it('leaves earlier migrations and the renamed link intact, and carries no grant onto it', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBeforeErasure);
    const bodyAt040 = await bodyOf('erase_account');
    expect(bodyAt040).toContain('course_thumbnail_object_ref');
    expect(await granteesOf('erase_account')).toEqual([runtimeRole]);

    await expect(migrate(upgradeUrl(), versionsBeforeErasure + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBeforeErasure + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);

    // The 040 outermost link is now the inner one, unedited, and nobody may call it.
    expect(await bodyOf('erase_account_before_watched_ref_queue')).toBe(bodyAt040);
    expect(await granteesOf('erase_account_before_watched_ref_queue')).toEqual([]);
    // The new outermost link is a new function: the grant did not travel to it either, so
    // erasure is re-granted deliberately by the grant helper.
    expect(await granteesOf('erase_account')).toEqual([]);
    // The grant helpers name tables from every migration, so they run on a fully migrated
    // schema, as in deployment (migrate, then grant).
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    expect(await granteesOf('erase_account')).toEqual([runtimeRole]);
    expect(await granteesOf('erase_account_before_watched_ref_queue')).toEqual([]);
  });

  it('queues the keys only the indexes still name, and reopens a closed receipt', async () => {
    const client = await upgraded.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await client.query('SELECT public.erase_account($1)', [athlete]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const queued = await upgraded.query<{ storage_ref: string; reason: string; open: boolean }>(
      `SELECT storage_ref,reason,completed_at IS NULL AS open FROM resource_object_cleanup
       WHERE storage_ref=ANY($1::text[]) ORDER BY storage_ref`,
      [[trackRef, thumbnailRef, otherTenantRef]],
    );
    expect(queued.rows).toEqual(
      [
        { storage_ref: trackRef, reason: 'account_erased', open: true },
        { storage_ref: thumbnailRef, reason: 'account_erased', open: true },
      ].sort((left, right) => left.storage_ref.localeCompare(right.storage_ref)),
    );
    const watched = await upgraded.query<{ storage_ref: string }>(
      `SELECT storage_ref FROM activity_track_object_ref WHERE athlete_id=$1
       UNION ALL SELECT storage_ref FROM course_thumbnail_object_ref WHERE storage_ref=ANY($2::text[])`,
      [athlete, [thumbnailRef, otherTenantRef]],
    );
    // Both of the erased tenant's index rows are gone; the other tenant's is untouched.
    expect(watched.rows).toEqual([{ storage_ref: otherTenantRef }]);
  });
});
