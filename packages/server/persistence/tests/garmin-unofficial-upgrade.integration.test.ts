import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  grantGarmin,
  grantGarminUnofficial,
  grantOperations,
  migrate,
  migrationFileNames,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The unofficial collector migration (M1-06b-tmp, filed as 048) on a database every earlier
 * migration already built. It adds four tenant tables and wraps `erase_account` once more, and
 * must leave everything else alone: no earlier checksum, no earlier function body other than
 * `erase_account`'s (kept unchanged as `erase_account_before_garmin_unofficial`), no table
 * grant, and nothing on the official Garmin tables or the revocation queue.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `gun_up_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const runtimeRole = `gun_rt_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
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
const tables = [
  'garmin_activity_ledger',
  'garmin_activity_ledger_source',
  'garmin_unofficial_connection',
  'garmin_unofficial_run',
];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  // Found by name, not by number: renumbering at merge time must not move the starting point.
  const index = migrationFileNames.findIndex((file) => /^\d+_garmin_unofficial\.sql$/.test(file));
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
     WHERE p.pronamespace IN ('public'::regnamespace,'garmin_private'::regnamespace)`,
  );
  return new Map(rows.rows.map((row) => [row.signature, row.body]));
}
async function tableGrants(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT c.relname||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')||':'||a.privilege_type
       AS entry
     FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     WHERE c.relnamespace IN ('public'::regnamespace,'garmin_private'::regnamespace)
       AND c.relkind='r' AND a.grantee<>c.relowner
     ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

describe('unofficial collector migration upgrade of a database built by every earlier one', () => {
  it('adds its tables, re-wraps erase_account, and changes nothing else', async () => {
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
    expect(bodiesAfter.get('erase_account_before_garmin_unofficial(text)')).toBe(eraseBefore);
    expect(
      [...bodiesAfter.keys()].filter((signature) => !bodiesBefore.has(signature)).sort(),
    ).toEqual(['erase_account_before_garmin_unofficial(text)']);
    // Lock order: the account lock, then the per-tenant command lock, then rows; the ledger's
    // source rows go before the activity rows the inner chain deletes.
    const erase = bodiesAfter.get('erase_account(text)') ?? '';
    const account = erase.indexOf('hashtextextended($1,77206)');
    const command = erase.indexOf('hashtextextended($1,0)');
    const rows = erase.indexOf('DELETE FROM public.garmin_activity_ledger_source');
    const inner = erase.indexOf('erase_account_before_garmin_unofficial($1)');
    expect(account).toBeGreaterThan(0);
    expect(command).toBeGreaterThan(account);
    expect(rows).toBeGreaterThan(command);
    expect(inner).toBeGreaterThan(rows);
    // Nothing reaches the revocation queue or the official connection.
    expect(erase).not.toContain('garmin_private');
    expect(erase).not.toContain('garmin_connection');
    expect(await tableGrants()).toEqual(grantsBefore);
    for (const table of tables) {
      const security = await upgraded.query(
        `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass`,
        [`public.${table}`],
      );
      expect(security.rows[0], table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it('gives the runtime role its own rows only, and erasure removes them', async () => {
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    await grantGarmin(upgradeUrl(), runtimeRole);
    await grantGarminUnofficial(upgradeUrl(), runtimeRole);
    const privileges = await upgraded.query(
      `SELECT has_table_privilege($1,'garmin_private.revocation','INSERT') AS queue,
         has_function_privilege($1,'public.erase_account_before_garmin_unofficial(text)',
           'EXECUTE') AS inner_erase`,
      [runtimeRole],
    );
    expect(privileges.rows[0]).toEqual({ queue: false, inner_erase: false });
    const owner = randomUUID(),
      other = randomUUID();
    const runtime = new Pool({ connectionString: upgradeUrl(runtimeRole) });
    try {
      const client = await runtime.connect();
      try {
        for (const tenant of [owner, other]) {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
          await client.query(
            "INSERT INTO garmin_unofficial_connection(athlete_id,state,profile_hash) VALUES($1,'reconnect_required',$2)",
            [tenant, 'a'.repeat(64)],
          );
          await client.query('COMMIT');
        }
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [owner]);
        const visible = await client.query('SELECT athlete_id FROM garmin_unofficial_connection');
        expect(visible.rows).toEqual([{ athlete_id: owner }]);
        await expect(
          client.query('INSERT INTO garmin_unofficial_connection(athlete_id) VALUES($1)', [
            randomUUID(),
          ]),
        ).rejects.toThrow();
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [owner]);
        await client.query('SELECT public.erase_account($1)', [owner]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
    const left = await upgraded.query(
      'SELECT athlete_id FROM garmin_unofficial_connection ORDER BY athlete_id',
    );
    expect(left.rows).toEqual([{ athlete_id: other }]);
  });
});
