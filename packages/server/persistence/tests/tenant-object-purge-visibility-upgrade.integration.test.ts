import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantResourceObjectCleanupWorker, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The tenant-purge visibility migration (M2-01z) against a populated database, one step at a
 * time. It replaces `lease_tenant_object_purge` in place and adds a CHECK, so what is checked
 * is: no earlier migration changed, no other function body changed, the worker's existing
 * grant survives without a grant helper, and every row already out of attempts without a
 * `DEAD_LETTER:` label is labelled — while a row whose last lease is still live is left alone
 * until that lease runs out.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `purge_visibility_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const workerRole = `purge_vis_wk_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const urlOf = (role?: string) => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (role) url.username = role;
  return url.toString();
};
let upgraded: Pool;
// Found by name, never by number or position: a migration merged in before it renumbers it.
const visibilityIndex = migrationFileNames.findIndex((name) =>
  /^\d+_tenant_object_purge_visibility\.sql$/.test(name),
);
if (visibilityIndex < 0) throw new Error('tenant purge visibility migration is not in the list');
const versionsBefore = visibilityIndex;
const lostLastLease = randomUUID();
const failedUnlabelled = randomUUID();
const liveLastLease = randomUUID();
const ordinary = randomUUID();
const refused = randomUUID();

async function eraseAs(pool: Pool, tenant: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    await client.query('SELECT public.erase_account($1)', [tenant]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type Row = {
  athlete_id: string;
  attempts: number;
  last_error_code: string | null;
  leased: boolean;
};

async function rows(): Promise<Row[]> {
  const result = await upgraded.query<Row>(
    `SELECT athlete_id,attempts,last_error_code,lease_owner IS NOT NULL AS leased
     FROM tenant_object_purge WHERE athlete_id=ANY($1) ORDER BY athlete_id`,
    [[lostLastLease, failedUnlabelled, liveLastLease, ordinary, refused]],
  );
  return result.rows;
}

const rowOf = async (tenant: string) => (await rows()).find((row) => row.athlete_id === tenant);

async function granteesOf(signature: string): Promise<readonly string[]> {
  const result = await upgraded.query<{ grantee: string }>(
    `SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
     FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.oid=$1::regprocedure AND a.grantee<>p.proowner ORDER BY 1`,
    [signature],
  );
  return result.rows.map((row) => row.grantee);
}

async function bodies(): Promise<Map<string, string>> {
  const result = await upgraded.query<{ signature: string; body: string }>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`,
  );
  return new Map(result.rows.map((row) => [row.signature, row.body]));
}

const leaseSignature = 'public.lease_tenant_object_purge(uuid,timestamptz,timestamptz)';
const finishSignature =
  'public.finish_tenant_object_purge(text,uuid,boolean,text,integer,integer,boolean)';

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  upgraded = new Pool({ connectionString: urlOf() });
  await migrate(urlOf(), versionsBefore);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  // What `grantResourceObjectCleanupWorker` gave the worker for this table before the
  // upgrade, written out (the helper itself names the head schema, so it runs only after a
  // full migrate).
  await upgraded.query(`GRANT EXECUTE ON FUNCTION ${leaseSignature},${finishSignature}
    TO "${workerRole}"`);
  for (const tenant of [lostLastLease, failedUnlabelled, liveLastLease, ordinary])
    await eraseAs(upgraded, tenant);
  // The states 044 allowed. A 100th attempt whose lease ran out (the silent dead letter this
  // migration labels); a row out of attempts with no lease and a plain code (not reachable
  // through 044's functions, labelled anyway); a 100th attempt still inside its lease; a row
  // mid-retry; and an inconsistent ledger row whose tenant has an account.
  await upgraded.query(
    `UPDATE tenant_object_purge SET attempts=100,lease_owner=gen_random_uuid(),
       lease_until=clock_timestamp()-interval '1 minute' WHERE athlete_id=$1`,
    [lostLastLease],
  );
  await upgraded.query(
    `UPDATE tenant_object_purge SET attempts=100,last_error_code='UNSAFE_STORAGE_PATH'
     WHERE athlete_id=$1`,
    [failedUnlabelled],
  );
  await upgraded.query(
    `UPDATE tenant_object_purge SET attempts=100,lease_owner=gen_random_uuid(),
       lease_until=clock_timestamp()+interval '2 minutes' WHERE athlete_id=$1`,
    [liveLastLease],
  );
  await upgraded.query(
    `UPDATE tenant_object_purge SET attempts=7,last_error_code='UNSAFE_STORAGE_PATH'
     WHERE athlete_id=$1`,
    [ordinary],
  );
  await upgraded.query(
    `INSERT INTO identity_private.account(athlete_id,issuer,subject)
     VALUES($1::uuid,'https://issuer.test',$2)`,
    [refused, randomUUID()],
  );
  await upgraded.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [refused]);
  await upgraded.query(
    `INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
     VALUES($1,clock_timestamp(),clock_timestamp()-interval '1 minute')`,
    [refused],
  );
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  await admin.query(`DROP ROLE IF EXISTS "${workerRole}"`);
  await admin.end();
});

describe('tenant purge visibility migration upgrade of a populated database', () => {
  it('labels every silent dead letter, changes nothing else, and keeps the worker’s grant', async () => {
    const checksums = async () =>
      new Map(
        (
          await upgraded.query<{ version: number; checksum: string }>(
            'SELECT version,checksum FROM schema_migrations ORDER BY version',
          )
        ).rows.map((row) => [row.version, row.checksum]),
      );
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const bodiesBefore = await bodies();
    expect(await granteesOf(leaseSignature)).toEqual([workerRole]);

    await expect(migrate(urlOf(), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    // Only the lease function's body changed; `erase_account` is not renamed or replaced.
    const bodiesAfter = await bodies();
    expect([...bodiesAfter.keys()].sort()).toEqual([...bodiesBefore.keys()].sort());
    const changed = [...bodiesAfter].filter(([key, body]) => bodiesBefore.get(key) !== body);
    expect(changed.map(([key]) => key)).toEqual([
      'lease_tenant_object_purge(uuid,timestamp with time zone,timestamp with time zone)',
    ]);
    // Replaced in place: the grant survives, nothing else gains one, no PUBLIC.
    expect(await granteesOf(leaseSignature)).toEqual([workerRole]);
    expect(await granteesOf(finishSignature)).toEqual([workerRole]);
    const definer = await upgraded.query<{ definer: boolean; config: string[] }>(
      `SELECT prosecdef AS definer,proconfig AS config FROM pg_proc WHERE oid=$1::regprocedure`,
      [leaseSignature],
    );
    expect(definer.rows).toEqual([{ definer: true, config: ['search_path=pg_catalog'] }]);

    expect(await rows()).toEqual(
      [
        {
          athlete_id: lostLastLease,
          attempts: 100,
          last_error_code: 'DEAD_LETTER:LEASE_EXPIRED',
          leased: false,
        },
        {
          athlete_id: failedUnlabelled,
          attempts: 100,
          last_error_code: 'DEAD_LETTER:UNSAFE_STORAGE_PATH',
          leased: false,
        },
        { athlete_id: liveLastLease, attempts: 100, last_error_code: null, leased: true },
        {
          athlete_id: ordinary,
          attempts: 7,
          last_error_code: 'UNSAFE_STORAGE_PATH',
          leased: false,
        },
        { athlete_id: refused, attempts: 0, last_error_code: null, leased: false },
      ].sort((left, right) => left.athlete_id.localeCompare(right.athlete_id)),
    );
  });

  it('lets the upgraded worker label the rest through the grant it already had', async () => {
    await upgraded.query(
      `UPDATE tenant_object_purge SET lease_until=clock_timestamp()-interval '1 second'
       WHERE athlete_id=$1`,
      [liveLastLease],
    );
    // Hold every ordinary due row back, so the one lease call below leases nothing of ours.
    await upgraded.query(
      `UPDATE tenant_object_purge SET available_at=clock_timestamp()+interval '1 day'
       WHERE athlete_id=$1`,
      [ordinary],
    );
    const worker = new Pool({ connectionString: urlOf(workerRole) });
    try {
      const now = new Date();
      const leased = await worker.query(
        'SELECT * FROM public.lease_tenant_object_purge($1,$2,$3)',
        [randomUUID(), now.toISOString(), new Date(now.getTime() + 60_000).toISOString()],
      );
      expect(leased.rows).toEqual([]);
    } finally {
      await worker.end();
    }
    expect(await rowOf(liveLastLease)).toMatchObject({
      last_error_code: 'DEAD_LETTER:LEASE_EXPIRED',
      leased: false,
    });
    expect(await rowOf(refused)).toMatchObject({
      attempts: 0,
      last_error_code: 'INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT',
      leased: false,
    });
    await expect(
      upgraded.query('UPDATE tenant_object_purge SET last_error_code=NULL WHERE athlete_id=$1', [
        liveLastLease,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('needs no new grant: the head schema’s worker helper grants the same purge calls', async () => {
    await expect(migrate(urlOf())).resolves.toBeUndefined();
    await grantResourceObjectCleanupWorker(urlOf(), workerRole);
    expect(await granteesOf(leaseSignature)).toEqual([workerRole]);
    expect(await granteesOf(finishSignature)).toEqual([workerRole]);
    const table = await upgraded.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM information_schema.role_table_grants
       WHERE table_name='tenant_object_purge' AND grantee<>CURRENT_USER`,
    );
    expect(table.rows[0]?.total).toBe(0);
  });
});
