import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCheckInRepository } from '../src/check-ins.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantCheckIns, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `check_in_event_${suffix}`;
const ownerRole = `check_in_owner_${suffix}`;
const runtimeRole = `check_in_rt_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_check_in_deletion_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('CheckIn deletion event migration is missing');

let owner: Pool;
let database: Database;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

const create = () => ({
  idempotencyKey: randomUUID(),
  values: {
    observedAt: '2026-01-02T23:00:00Z',
    timezone: 'Asia/Seoul',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: 'synthetic old check-in',
  },
});

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await migrate(urlFor(ownerRole), migrationIndex);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantCheckIns(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT ON outbox TO "${runtimeRole}"`);
  await owner.query(`GRANT UPDATE(idempotency_key) ON outbox TO "${runtimeRole}"`);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
});

afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('CheckIn event plain-owner upgrade', () => {
  it('does not backfill an old tombstone and records a later deletion under FORCE RLS', async () => {
    const tenant = randomUUID();
    const repository = createCheckInRepository(database);
    const old = await repository.createCheckIn(tenant, create());
    const live = await repository.createCheckIn(tenant, create());
    await repository.deleteCheckIn(tenant, old.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    });
    await migrate(urlFor(ownerRole));
    expect(
      (
        await owner.query(
          `SELECT target_id FROM restore_suppression_event
           WHERE athlete_id=$1 AND kind='check_in_deleted'`,
          [tenant],
        )
      ).rows,
    ).toEqual([]);
    await repository.deleteCheckIn(tenant, live.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    });
    expect(
      (
        await owner.query(
          `SELECT target_id::text,check_in_revision FROM restore_suppression_event
           WHERE athlete_id=$1 AND kind='check_in_deleted'`,
          [tenant],
        )
      ).rows,
    ).toEqual([{ target_id: live.id, check_in_revision: 2 }]);
    const policy = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_suppression_event'::regclass",
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
