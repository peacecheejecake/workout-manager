import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrivateTextResourceCreate } from '@workout/contracts/resources';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate, migrationFileNames } from '../src/migrate.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `resource_event_upgrade_${suffix}`;
const ownerRole = `resource_event_owner_${suffix}`;
const runtimeRole = `resource_event_rt_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_resource_deletion_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('Resource deletion event migration is missing');

let owner: Pool;
let database: Database;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

function command(): PrivateTextResourceCreate {
  return {
    sourceKind: 'text',
    title: 'Synthetic upgrade note',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic content.',
    idempotencyKey: randomUUID(),
  };
}

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
  await grantResources(urlFor(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
});

afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('resource event upgrade under a plain PostgreSQL owner', () => {
  it('preserves old deletion without backfill and captures later deletion with FORCE RLS', async () => {
    const tenant = randomUUID();
    const resources = createPrivateTextResourceRepository(database);
    const old = await resources.create(tenant, command());
    const live = await resources.create(tenant, command());
    if (old.status !== 'available' || live.status !== 'available')
      throw new Error('Expected available resources');
    await resources.softDelete(tenant, old.resource.id, {
      expectedAccessRevision: old.resource.accessRevision,
      expectedCurrentVersionId: old.version.id,
      idempotencyKey: randomUUID(),
    });

    await migrate(urlFor(ownerRole));
    expect(
      (
        await owner.query(
          `SELECT target_id::text FROM restore_suppression_event
           WHERE athlete_id=$1 AND kind='resource_deleted'`,
          [tenant],
        )
      ).rows,
    ).toEqual([]);
    const deleted = await resources.softDelete(tenant, live.resource.id, {
      expectedAccessRevision: live.resource.accessRevision,
      expectedCurrentVersionId: live.version.id,
      idempotencyKey: randomUUID(),
    });
    if (deleted.status !== 'deleted') throw new Error('Expected deleted resource');
    expect(
      (
        await owner.query(
          `SELECT target_id::text,resource_access_revision,occurred_at
           FROM restore_suppression_event WHERE athlete_id=$1 AND kind='resource_deleted'`,
          [tenant],
        )
      ).rows,
    ).toEqual([
      {
        target_id: live.resource.id,
        resource_access_revision: deleted.accessRevision,
        occurred_at: new Date(deleted.deletedAt),
      },
    ]);
    const policy = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_suppression_event'::regclass",
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
