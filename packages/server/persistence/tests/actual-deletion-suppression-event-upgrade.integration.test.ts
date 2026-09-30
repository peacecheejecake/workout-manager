import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = 'actual_event_' + suffix;
const ownerRole = 'actual_owner_' + suffix;
const runtimeRole = 'actual_runtime_' + suffix;
const migrationIndex = migrationFileNames.findIndex(
  (file) => file === '077_actual_deletion_suppression_event.sql',
);
if (migrationIndex < 0) throw new Error('Actual deletion migration is missing');

let owner: Pool;
let runtime: Pool;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = '/' + databaseName;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function tenantTransaction<T>(
  tenant: string,
  work: (client: PoolClient) => Promise<T>,
  commit = true,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const result = await work(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const recordedAt = '2026-09-30T01:00:00.000Z';
const deletedAt = '2026-09-30T02:00:00.000Z';

async function activeIntake(tenant: string, id: string): Promise<string> {
  const firstId = randomUUID();
  await tenantTransaction(tenant, async (client) => {
    await client.query(
      "INSERT INTO intake_entry(athlete_id,id,current_revision,current_revision_id,status) VALUES($1,$2,1,$3,'active')",
      [tenant, id, firstId],
    );
    await client.query(
      "INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,occurred_at,recorded_at,record_json) VALUES($1,$2,1,$3,'active',$4,$4,$5::jsonb)",
      [
        tenant,
        id,
        firstId,
        recordedAt,
        JSON.stringify({
          intakeId: id,
          revisionId: firstId,
          revision: 1,
          status: 'active',
          occurredAt: recordedAt,
          recordedAt,
          notes: 'synthetic private nutrition content',
        }),
      ],
    );
  });
  return firstId;
}

async function deleteIntake(client: PoolClient, tenant: string, id: string): Promise<void> {
  const tombstoneId = randomUUID();
  await client.query(
    "INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,recorded_at,deleted_at,deletion_reason) VALUES($1,$2,2,$3,'deleted',$4,$4,'user_requested')",
    [tenant, id, tombstoneId, deletedAt],
  );
  await client.query(
    "UPDATE intake_entry SET current_revision=2,current_revision_id=$3,status='deleted' WHERE athlete_id=$1 AND id=$2",
    [tenant, id, tombstoneId],
  );
}

async function activeAction(tenant: string): Promise<string> {
  const actionId = randomUUID();
  const firstId = randomUUID();
  await tenantTransaction(tenant, async (client) => {
    await client.query(
      "INSERT INTO recovery_action_log(athlete_id,action_id,revision,revision_id,status) VALUES($1,$2,1,$3,'active')",
      [tenant, actionId, firstId],
    );
    await client.query(
      "INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json) VALUES($1,$2,1,$3,'active',$4::jsonb)",
      [
        tenant,
        actionId,
        firstId,
        JSON.stringify({
          schemaVersion: 1,
          actionId,
          revisionId: firstId,
          revision: 1,
          status: 'active',
          userNotes: 'synthetic private recovery content',
        }),
      ],
    );
  });
  return actionId;
}

async function deleteAction(client: PoolClient, tenant: string, actionId: string): Promise<void> {
  const tombstoneId = randomUUID();
  await client.query(
    "INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json) VALUES($1,$2,2,$3,'deleted',$4::jsonb)",
    [
      tenant,
      actionId,
      tombstoneId,
      JSON.stringify({
        actionId,
        revisionId: tombstoneId,
        revision: 2,
        status: 'deleted',
        deletedAt,
      }),
    ],
  );
  await client.query(
    "UPDATE recovery_action_log SET revision=2,revision_id=$3,status='deleted' WHERE athlete_id=$1 AND action_id=$2",
    [tenant, actionId, tombstoneId],
  );
}

async function events(tenant: string) {
  return (
    await owner.query(
      "SELECT event_id,kind,target_id::text,actual_deletion_revision,occurred_at,to_jsonb(e) AS event FROM restore_suppression_event e WHERE athlete_id=$1 AND kind IN ('intake_entry_deleted','recovery_action_deleted') ORDER BY kind",
      [tenant],
    )
  ).rows;
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      'CREATE ROLE "' +
        role +
        '" LOGIN PASSWORD ' +
        "'isolated'" +
        ' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
  await admin.query('CREATE DATABASE "' + databaseName + '" OWNER "' + ownerRole + '"');
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await migrate(urlFor(ownerRole), migrationIndex);
  await owner.query('GRANT USAGE ON SCHEMA public TO "' + runtimeRole + '"');
});

afterAll(async () => {
  await Promise.all([owner?.end(), runtime?.end()]);
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole])
    await admin.query('DROP ROLE IF EXISTS "' + role + '"');
  await admin.end();
});

describe('actual deletion suppression events under a plain owner', () => {
  it('does not backfill, writes minimal events with the deletion, rolls back, and survives erasure', async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const priorIntake = 'private-meal-before-upgrade';
    await activeIntake(tenant, priorIntake);
    const priorAction = await activeAction(tenant);
    await tenantTransaction(tenant, async (client) => {
      await deleteIntake(client, tenant, priorIntake);
      await deleteAction(client, tenant, priorAction);
    });
    await migrate(urlFor(ownerRole));
    await migrate(urlFor(ownerRole));
    expect(await events(tenant)).toEqual([]);

    const intakeId = 'caller-chosen-private-meal-id';
    const originId = await activeIntake(tenant, intakeId);
    const actionId = await activeAction(tenant);
    const rollbackIntake = 'rollback-private-meal-id';
    const rollbackOrigin = await activeIntake(tenant, rollbackIntake);
    const rollbackAction = await activeAction(tenant);
    await activeIntake(other, 'other-tenant-meal');

    await tenantTransaction(tenant, async (client) => {
      await deleteIntake(client, tenant, intakeId);
      await deleteAction(client, tenant, actionId);
    });
    const committed = await events(tenant);
    expect(committed).toHaveLength(2);
    expect(committed).toMatchObject([
      { kind: 'intake_entry_deleted', target_id: originId, actual_deletion_revision: 2 },
      { kind: 'recovery_action_deleted', target_id: actionId, actual_deletion_revision: 2 },
    ]);
    expect(committed.map((row) => row.occurred_at)).toEqual([
      new Date(deletedAt),
      new Date(deletedAt),
    ]);
    expect(JSON.stringify(committed)).not.toContain(intakeId);
    expect(JSON.stringify(committed)).not.toContain('synthetic private');
    expect(JSON.stringify(committed)).not.toContain(rollbackOrigin);

    await tenantTransaction(
      tenant,
      async (client) => {
        await deleteIntake(client, tenant, rollbackIntake);
        await deleteAction(client, tenant, rollbackAction);
        const uncommitted = await client.query(
          "SELECT count(*)::integer AS count FROM restore_suppression_event WHERE athlete_id=$1 AND kind IN ('intake_entry_deleted','recovery_action_deleted')",
          [tenant],
        );
        expect(uncommitted.rows).toEqual([{ count: 4 }]);
      },
      false,
    );
    expect(await events(tenant)).toEqual(committed);
    const active = await tenantTransaction(tenant, async (client) =>
      client.query('SELECT status FROM intake_entry WHERE athlete_id=$1 AND id=$2', [
        tenant,
        rollbackIntake,
      ]),
    );
    expect(active.rows).toEqual([{ status: 'active' }]);
    await expect(
      tenantTransaction(tenant, (client) =>
        client.query(
          "UPDATE intake_entry SET current_revision=2,current_revision_id=$3,status='deleted' WHERE athlete_id=$1 AND id=$2",
          [tenant, rollbackIntake, randomUUID()],
        ),
      ),
    ).rejects.toThrow('INTAKE_EVENT_TOMBSTONE_INVALID');
    await expect(
      tenantTransaction(tenant, (client) =>
        client.query(
          "UPDATE recovery_action_log SET revision=2,revision_id=$3,status='deleted' WHERE athlete_id=$1 AND action_id=$2",
          [tenant, rollbackAction, randomUUID()],
        ),
      ),
    ).rejects.toThrow('RECOVERY_EVENT_TOMBSTONE_INVALID');
    await expect(
      tenantTransaction(tenant, (client) =>
        client.query(
          "UPDATE recovery_action_log SET revision=3,revision_id=$3,status='active' WHERE athlete_id=$1 AND action_id=$2",
          [tenant, actionId, randomUUID()],
        ),
      ),
    ).rejects.toThrow('INVALID_RECOVERY_ACTION_ADVANCE');
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });
    const rls = await owner.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_suppression_event'::regclass",
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await expect(
      owner.query(
        "INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at) VALUES($1,'intake_entry_deleted',$2,now())",
        [tenant, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await tenantTransaction(tenant, async (client) => {
      await client.query('SELECT public.erase_account($1)', [tenant]);
    });
    expect(await events(tenant)).toEqual(committed);
    expect(
      (
        await tenantTransaction(other, (client) =>
          client.query('SELECT id FROM intake_entry WHERE athlete_id=$1', [other]),
        )
      ).rows,
    ).toEqual([{ id: 'other-tenant-meal' }]);
  });
});
