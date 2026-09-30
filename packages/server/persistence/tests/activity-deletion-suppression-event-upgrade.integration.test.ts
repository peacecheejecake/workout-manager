import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `activity_event_upgrade_${suffix}`;
const ownerRole = `activity_event_owner_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_activity_deletion_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('Activity deletion event migration is missing');

const tenant = randomUUID();
const activityId = randomUUID();
let owner: Pool;

function ownerUrl(): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = ownerRole;
  url.password = 'isolated';
  return url.toString();
}

async function inTenant<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await admin.query(
    `CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: ownerUrl() });
  await migrate(ownerUrl(), migrationIndex);
});

afterAll(async () => {
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
  await admin.end();
});

describe('activity event upgrade on a populated plain-owner database', () => {
  it('rejects an orphaned live canonical before installing the trigger, then migrates after repair', async () => {
    await inTenant((client) =>
      client.query(
        `INSERT INTO activity_canonical(athlete_id,id,revision,original)
         VALUES($1,$2,1,'{}'::jsonb)`,
        [tenant, activityId],
      ),
    );

    await expect(migrate(ownerUrl())).rejects.toThrow('ACTIVITY_EVENT_SOURCE_PREFLIGHT');
    expect(
      (await owner.query('SELECT max(version) AS version FROM schema_migrations')).rows[0],
    ).toEqual({ version: migrationIndex });
    const force = await owner.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname,relforcerowsecurity FROM pg_class
       WHERE oid IN ('public.activity_canonical'::regclass,
         'public.activity_source_head'::regclass) ORDER BY relname`,
    );
    expect(force.rows).toEqual([
      { relname: 'activity_canonical', relforcerowsecurity: true },
      { relname: 'activity_source_head', relforcerowsecurity: true },
    ]);
    expect(
      (await owner.query("SELECT to_regclass('public.restore_suppression_event') AS name")).rows[0]
        ?.name,
    ).toBe('restore_suppression_event');
    expect(
      (
        await owner.query(
          "SELECT 1 FROM pg_trigger WHERE tgname='record_activity_deletion_suppression_event'",
        )
      ).rowCount,
    ).toBe(0);

    await inTenant((client) =>
      client.query(
        `INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,
           content_hash,activity_id) VALUES($1,'fixture',$2,1,repeat('a',64),$3)`,
        [tenant, randomUUID(), activityId],
      ),
    );
    await migrate(ownerUrl());
    await inTenant((client) =>
      client.query(
        'UPDATE activity_canonical SET deleted=true,revision=2 WHERE athlete_id=$1 AND id=$2',
        [tenant, activityId],
      ),
    );
    expect(
      (
        await owner.query(
          `SELECT kind,target_id::text,activity_revision,source_kind,source_revision
           FROM restore_suppression_event WHERE athlete_id=$1`,
          [tenant],
        )
      ).rows,
    ).toEqual([
      {
        kind: 'activity_deleted',
        target_id: activityId,
        activity_revision: 2,
        source_kind: 'fixture',
        source_revision: 1,
      },
    ]);
  });
});
