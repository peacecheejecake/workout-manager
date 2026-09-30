import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate, migrationFileNames } from '../src/migrate.js';
import { createResourceAccessRepository } from '../src/resource-access.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `share_event_upgrade_${suffix}`;
const ownerRole = `share_event_owner_${suffix}`;
const runtimeRole = `share_event_rt_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_resource_share_revoke_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('Resource share event migration is missing');

let owner: Pool;
let database: Database;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
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

describe('resource share revocation event upgrade under a plain PostgreSQL owner', () => {
  it('does not backfill old revocations and captures a later exact share with FORCE RLS', async () => {
    const tenant = randomUUID();
    const resources = createPrivateTextResourceRepository(database);
    const access = createResourceAccessRepository(database);
    const created = await resources.create(tenant, {
      sourceKind: 'text',
      title: 'Synthetic upgrade share',
      category: 'note',
      metadata: {},
      tags: [],
      favorite: false,
      text: 'Synthetic content.',
      idempotencyKey: randomUUID(),
    });
    if (created.status !== 'available') throw new Error('Expected available resource');
    const oldGrant = await access.grantShare(tenant, created.resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: created.resource.accessRevision,
      idempotencyKey: randomUUID(),
    });
    const oldShare = oldGrant.shares[0]?.shareId;
    if (!oldShare) throw new Error('Expected old share');
    const oldRevoke = await access.revokeShare(tenant, created.resource.id, oldShare, {
      expectedAccessRevision: oldGrant.accessRevision,
      idempotencyKey: randomUUID(),
    });
    const liveGrant = await access.grantShare(tenant, created.resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: oldRevoke.accessRevision,
      idempotencyKey: randomUUID(),
    });
    const liveShare = liveGrant.shares.find((share) => share.state === 'active')?.shareId;
    if (!liveShare) throw new Error('Expected live share');

    await migrate(urlFor(ownerRole));
    const before = await owner.query(
      `SELECT share_id FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='resource_share_revoked'`,
      [tenant],
    );
    expect(before.rows).toEqual([]);
    const revoked = await access.revokeShare(tenant, created.resource.id, liveShare, {
      expectedAccessRevision: liveGrant.accessRevision,
      idempotencyKey: randomUUID(),
    });
    const recorded = await owner.query<{
      target_id: string;
      share_id: string;
      share_granted_access_revision: number;
      share_revoked_access_revision: number;
    }>(
      `SELECT target_id::text,share_id::text,share_granted_access_revision,
         share_revoked_access_revision FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='resource_share_revoked'`,
      [tenant],
    );
    expect(recorded.rows).toEqual([
      {
        target_id: created.resource.id,
        share_id: liveShare,
        share_granted_access_revision: liveGrant.accessRevision,
        share_revoked_access_revision: revoked.accessRevision,
      },
    ]);
    const policy = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_suppression_event'::regclass",
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
