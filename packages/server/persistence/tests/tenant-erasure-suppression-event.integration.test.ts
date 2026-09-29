import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `erasure_event_${suffix}`;
const ownerRole = `erasure_owner_${suffix}`;
const appRole = `erasure_app_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_tenant_erasure_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('Tenant erasure event migration is missing');

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

type EventRow = {
  event_id: string;
  record_version: number;
  athlete_id: string;
  kind: string;
  occurred_at: Date;
};

let owner: Pool;
let app: Pool;
const legacyTenant = randomUUID();

async function inTenant<T>(
  pool: Pool,
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  commit = true,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const value = await run(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function events(tenant: string): Promise<EventRow[]> {
  const result = await owner.query<EventRow>(
    'SELECT event_id,record_version,athlete_id,kind,occurred_at FROM restore_suppression_event WHERE athlete_id=$1',
    [tenant],
  );
  return result.rows;
}

beforeAll(async () => {
  for (const role of [ownerRole, appRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  app = new Pool({ connectionString: urlFor(appRole) });
  await migrate(urlFor(ownerRole), migrationIndex);
  await inTenant(owner, legacyTenant, (client) =>
    client.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [legacyTenant]),
  );
  await migrate(urlFor(ownerRole));
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${appRole}"`);
  await grantOperations(urlFor(ownerRole), appRole);
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [appRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe('tenant erasure suppression event foundation on a plain PostgreSQL owner', () => {
  it('has a narrow owner-only forced-RLS policy and no app/browser table access', async () => {
    const role = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',
      [ownerRole],
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const table = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid='public.restore_suppression_event'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policy = await owner.query<{ roles: string; cmd: string }>(
      `SELECT roles::text,cmd FROM pg_policies WHERE schemaname='public'
         AND tablename='restore_suppression_event'`,
    );
    expect(policy.rows).toEqual([{ roles: `{${ownerRole}}`, cmd: 'ALL' }]);
    const grants = await owner.query<{ privilege: boolean }>(
      `SELECT has_table_privilege($1,'public.restore_suppression_event','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS privilege`,
      [appRole],
    );
    expect(grants.rows[0]?.privilege).toBe(false);
    await expect(
      inTenant(app, randomUUID(), (client) =>
        client.query('SELECT * FROM restore_suppression_event'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inTenant(app, randomUUID(), (client) =>
        client.query(
          'INSERT INTO restore_suppression_event(athlete_id,occurred_at) VALUES($1,now())',
          [randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await events(legacyTenant)).toEqual([]);
  });

  it('commits one minimal event with erase_account and keeps its identity on retry', async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    await inTenant(owner, tenant, (client) =>
      client.query("INSERT INTO consent VALUES($1,'ai',true,1)", [tenant]),
    );
    await inTenant(owner, other, (client) =>
      client.query("INSERT INTO consent VALUES($1,'ai',true,1)", [other]),
    );
    const first = await inTenant(app, tenant, (client) =>
      client.query<{ erased_at: Date }>('SELECT public.erase_account($1) AS erased_at', [tenant]),
    );
    const once = await events(tenant);
    expect(once).toHaveLength(1);
    expect(once[0]).toEqual({
      event_id: expect.any(String),
      record_version: 1,
      athlete_id: tenant,
      kind: 'tenant_erased',
      occurred_at: first.rows[0]?.erased_at,
    });
    expect(
      await inTenant(owner, tenant, (client) =>
        client.query('SELECT 1 FROM consent WHERE athlete_id=$1', [tenant]),
      ),
    ).toMatchObject({ rows: [] });
    expect(
      (
        await inTenant(owner, tenant, (client) =>
          client.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [tenant]),
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await inTenant(owner, other, (client) =>
          client.query('SELECT 1 FROM consent WHERE athlete_id=$1', [other]),
        )
      ).rowCount,
    ).toBe(1);
    const second = await inTenant(app, tenant, (client) =>
      client.query<{ erased_at: Date }>('SELECT public.erase_account($1) AS erased_at', [tenant]),
    );
    expect(second.rows[0]?.erased_at).toEqual(first.rows[0]?.erased_at);
    expect(await events(tenant)).toEqual(once);
  });

  it('rolls back the erasure, tombstone and event together', async () => {
    const tenant = randomUUID();
    await inTenant(owner, tenant, (client) =>
      client.query("INSERT INTO consent VALUES($1,'ai',true,1)", [tenant]),
    );
    await inTenant(
      app,
      tenant,
      async (client) => {
        await client.query('SELECT public.erase_account($1)', [tenant]);
        const pending = await client.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [
          tenant,
        ]);
        expect(pending.rowCount).toBe(1);
      },
      false,
    );
    expect(await events(tenant)).toEqual([]);
    expect(
      (
        await inTenant(owner, tenant, (client) =>
          client.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [tenant]),
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await inTenant(owner, tenant, (client) =>
          client.query('SELECT 1 FROM consent WHERE athlete_id=$1', [tenant]),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('rejects cross-tenant erasure and owner mutation of a committed event', async () => {
    const first = randomUUID();
    const second = randomUUID();
    await expect(
      inTenant(app, second, (client) => client.query('SELECT public.erase_account($1)', [first])),
    ).rejects.toThrow('ERASURE_TENANT_MISMATCH');
    expect(await events(first)).toEqual([]);
    await inTenant(app, first, (client) =>
      client.query('SELECT public.erase_account($1)', [first]),
    );
    await expect(
      owner.query('UPDATE restore_suppression_event SET occurred_at=now() WHERE athlete_id=$1', [
        first,
      ]),
    ).rejects.toThrow('IMMUTABLE_RESTORE_SUPPRESSION_EVENT');
    await expect(
      owner.query('DELETE FROM restore_suppression_event WHERE athlete_id=$1', [first]),
    ).rejects.toThrow('IMMUTABLE_RESTORE_SUPPRESSION_EVENT');
    await expect(owner.query('TRUNCATE restore_suppression_event')).rejects.toThrow(
      'IMMUTABLE_RESTORE_SUPPRESSION_EVENT',
    );
    expect(await events(first)).toHaveLength(1);
  });
});
