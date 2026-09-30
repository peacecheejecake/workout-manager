import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `actual_v2_${suffix}`;
const ownerRole = `actual_v2_owner_${suffix}`;
const runtimeRole = `actual_v2_rt_${suffix}`;
const migrationIndex = migrationFileNames.indexOf('091_actual_deletion_revision_provenance.sql');
if (migrationIndex < 0) throw new Error('Actual deletion revision provenance migration is missing');
const occurredAt = '2026-09-30T02:00:00.000Z';
let owner: Pool;
let runtime: Pool;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
async function tenant<T>(
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
  commit = true,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const result = await operation(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
async function intake(athleteId: string, revision = 1) {
  const id = `private-intake-${randomUUID()}`;
  const originId = randomUUID();
  const previousId = revision === 1 ? originId : randomUUID();
  await tenant(athleteId, async (client) => {
    await client.query(
      "INSERT INTO intake_entry(athlete_id,id,current_revision,current_revision_id,status) VALUES($1,$2,1,$3,'active')",
      [athleteId, id, originId],
    );
    await client.query(
      `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
       occurred_at,recorded_at,record_json) VALUES($1,$2,1,$3,'active',$4,$4,$5::jsonb)`,
      [
        athleteId,
        id,
        originId,
        occurredAt,
        JSON.stringify({
          intakeId: id,
          revisionId: originId,
          revision: 1,
          status: 'active',
          occurredAt,
          recordedAt: occurredAt,
          notes: 'secret nutrition note',
        }),
      ],
    );
    if (revision === 2) {
      await client.query(
        `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
         occurred_at,recorded_at,record_json) VALUES($1,$2,2,$3,'active',$4,$4,$5::jsonb)`,
        [
          athleteId,
          id,
          previousId,
          occurredAt,
          JSON.stringify({
            intakeId: id,
            revisionId: previousId,
            revision: 2,
            status: 'active',
            occurredAt,
            recordedAt: occurredAt,
            notes: 'secret correction',
          }),
        ],
      );
      await client.query(
        'UPDATE intake_entry SET current_revision=2,current_revision_id=$3 WHERE athlete_id=$1 AND id=$2',
        [athleteId, id, previousId],
      );
    }
  });
  return { id, originId, previousId, nextRevision: revision + 1 };
}
async function action(athleteId: string, revision = 1) {
  const actionId = randomUUID();
  const originId = randomUUID();
  const previousId = revision === 1 ? originId : randomUUID();
  await tenant(athleteId, async (client) => {
    await client.query(
      "INSERT INTO recovery_action_log(athlete_id,action_id,revision,revision_id,status) VALUES($1,$2,1,$3,'active')",
      [athleteId, actionId, originId],
    );
    await client.query(
      `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
       VALUES($1,$2,1,$3,'active',$4::jsonb)`,
      [
        athleteId,
        actionId,
        originId,
        JSON.stringify({
          schemaVersion: 1,
          actionId,
          revisionId: originId,
          revision: 1,
          status: 'active',
          userNotes: 'secret recovery note',
        }),
      ],
    );
    if (revision === 2) {
      await client.query(
        `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
         VALUES($1,$2,2,$3,'active',$4::jsonb)`,
        [
          athleteId,
          actionId,
          previousId,
          JSON.stringify({
            schemaVersion: 1,
            actionId,
            revisionId: previousId,
            revision: 2,
            status: 'active',
            userNotes: 'secret correction',
          }),
        ],
      );
      await client.query(
        'UPDATE recovery_action_log SET revision=2,revision_id=$3 WHERE athlete_id=$1 AND action_id=$2',
        [athleteId, actionId, previousId],
      );
    }
  });
  return { actionId, originId, previousId, nextRevision: revision + 1 };
}
async function deleteIntake(
  client: PoolClient,
  athleteId: string,
  item: Awaited<ReturnType<typeof intake>>,
  tombstoneId: string,
) {
  await client.query(
    `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
     recorded_at,deleted_at,deletion_reason) VALUES($1,$2,$3,$4,'deleted',$5,$5,'user_requested')`,
    [athleteId, item.id, item.nextRevision, tombstoneId, occurredAt],
  );
  await client.query(
    "UPDATE intake_entry SET current_revision=$3,current_revision_id=$4,status='deleted' WHERE athlete_id=$1 AND id=$2",
    [athleteId, item.id, item.nextRevision, tombstoneId],
  );
}
async function deleteAction(
  client: PoolClient,
  athleteId: string,
  item: Awaited<ReturnType<typeof action>>,
  tombstoneId: string,
) {
  await client.query(
    `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
     VALUES($1,$2,$3,$4,'deleted',$5::jsonb)`,
    [
      athleteId,
      item.actionId,
      item.nextRevision,
      tombstoneId,
      JSON.stringify({
        actionId: item.actionId,
        revisionId: tombstoneId,
        revision: item.nextRevision,
        status: 'deleted',
        deletedAt: occurredAt,
      }),
    ],
  );
  await client.query(
    "UPDATE recovery_action_log SET revision=$3,revision_id=$4,status='deleted' WHERE athlete_id=$1 AND action_id=$2",
    [athleteId, item.actionId, item.nextRevision, tombstoneId],
  );
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await migrate(urlFor(ownerRole), migrationIndex - 1);
  const legacyAthlete = randomUUID();
  const legacyIntake = await intake(legacyAthlete);
  const legacyAction = await action(legacyAthlete);
  await tenant(legacyAthlete, async (client) => {
    await deleteIntake(client, legacyAthlete, legacyIntake, randomUUID());
    await deleteAction(client, legacyAthlete, legacyAction, randomUUID());
  });
  legacy = {
    athleteId: legacyAthlete,
    originId: legacyIntake.originId,
    actionId: legacyAction.actionId,
  };
  await migrate(urlFor(ownerRole));
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
});
afterAll(async () => {
  await Promise.all([owner?.end(), runtime?.end()]);
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
let legacy: { athleteId: string; originId: string; actionId: string };

describe('future actual deletion revision provenance on PostgreSQL', () => {
  it('preserves pre-upgrade v1 facts without inferred revision identities', async () => {
    const events = await owner.query(
      `SELECT record_version,actual_previous_revision_id,actual_deleted_revision_id
       FROM restore_suppression_event WHERE athlete_id=$1 AND kind IN
       ('intake_entry_deleted','recovery_action_deleted') ORDER BY kind`,
      [legacy.athleteId],
    );
    expect(events.rows).toEqual([
      { record_version: 1, actual_previous_revision_id: null, actual_deleted_revision_id: null },
      { record_version: 1, actual_previous_revision_id: null, actual_deleted_revision_id: null },
    ]);
  });

  it('captures predecessor and tombstone IDs for first and corrected actuals without payload', async () => {
    const athleteId = randomUUID();
    for (const revision of [1, 2]) {
      const meal = await intake(athleteId, revision);
      const rest = await action(athleteId, revision);
      const intakeTombstone = randomUUID();
      const actionTombstone = randomUUID();
      await tenant(athleteId, async (client) => {
        await deleteIntake(client, athleteId, meal, intakeTombstone);
        await deleteAction(client, athleteId, rest, actionTombstone);
      });
      const events = await owner.query<{
        kind: string;
        target_id: string;
        record_version: number;
        actual_deletion_revision: number;
        actual_previous_revision_id: string;
        actual_deleted_revision_id: string;
        occurred_at: Date;
        event: Record<string, unknown>;
      }>(
        `SELECT kind,target_id::text,record_version,actual_deletion_revision,
         actual_previous_revision_id::text,actual_deleted_revision_id::text,occurred_at,to_jsonb(e) event
         FROM restore_suppression_event e WHERE athlete_id=$1 AND target_id IN ($2,$3) ORDER BY kind`,
        [athleteId, meal.originId, rest.actionId],
      );
      expect(
        events.rows.map((row) => [
          row.kind,
          row.target_id,
          row.record_version,
          row.actual_deletion_revision,
          row.actual_previous_revision_id,
          row.actual_deleted_revision_id,
          row.occurred_at.toISOString(),
        ]),
      ).toEqual([
        [
          'intake_entry_deleted',
          meal.originId,
          2,
          meal.nextRevision,
          meal.previousId,
          intakeTombstone,
          occurredAt,
        ],
        [
          'recovery_action_deleted',
          rest.actionId,
          2,
          rest.nextRevision,
          rest.previousId,
          actionTombstone,
          occurredAt,
        ],
      ]);
      expect(JSON.stringify(events.rows.map((row) => row.event))).not.toContain('secret');
      expect(JSON.stringify(events.rows.map((row) => row.event))).not.toContain(meal.id);
      expect(JSON.stringify(events.rows.map((row) => row.event))).not.toContain('idempotency');
    }
  });

  it('rejects a tombstone committed before its head transition and leaves no event', async () => {
    const athleteId = randomUUID();
    const meal = await intake(athleteId);
    const rest = await action(athleteId);
    const intakeTombstone = randomUUID();
    const actionTombstone = randomUUID();
    await tenant(athleteId, async (client) => {
      await client.query(
        `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
         recorded_at,deleted_at,deletion_reason) VALUES($1,$2,2,$3,'deleted',$4,$4,'user_requested')`,
        [athleteId, meal.id, intakeTombstone, occurredAt],
      );
      await client.query(
        `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
         VALUES($1,$2,2,$3,'deleted',$4::jsonb)`,
        [
          athleteId,
          rest.actionId,
          actionTombstone,
          JSON.stringify({
            actionId: rest.actionId,
            revisionId: actionTombstone,
            revision: 2,
            status: 'deleted',
            deletedAt: occurredAt,
          }),
        ],
      );
    });
    await expect(
      tenant(athleteId, async (client) => {
        await client.query(
          "UPDATE intake_entry SET current_revision=2,current_revision_id=$3,status='deleted' WHERE athlete_id=$1 AND id=$2",
          [athleteId, meal.id, intakeTombstone],
        );
      }),
    ).rejects.toThrow('INTAKE_EVENT_TOMBSTONE_INVALID');
    await expect(
      tenant(athleteId, async (client) => {
        await client.query(
          "UPDATE recovery_action_log SET revision=2,revision_id=$3,status='deleted' WHERE athlete_id=$1 AND action_id=$2",
          [athleteId, rest.actionId, actionTombstone],
        );
      }),
    ).rejects.toThrow('RECOVERY_EVENT_TOMBSTONE_INVALID');
    const facts = await owner.query<{ count: number }>(
      "SELECT count(*)::int count FROM restore_suppression_event WHERE athlete_id=$1 AND kind IN ('intake_entry_deleted','recovery_action_deleted')",
      [athleteId],
    );
    expect(facts.rows[0]?.count).toBe(0);
  });

  it('rolls back source head, tombstone, and event together; runtime cannot read the event table', async () => {
    const athleteId = randomUUID();
    const meal = await intake(athleteId);
    const tombstoneId = randomUUID();
    await tenant(
      athleteId,
      async (client) => {
        await deleteIntake(client, athleteId, meal, tombstoneId);
      },
      false,
    );
    const facts = await tenant(athleteId, async (client) => {
      const head = await client.query(
        'SELECT status,current_revision FROM intake_entry WHERE athlete_id=$1 AND id=$2',
        [athleteId, meal.id],
      );
      const tombstone = await client.query(
        'SELECT count(*)::int count FROM intake_entry_revision WHERE athlete_id=$1 AND intake_id=$2 AND revision=2',
        [athleteId, meal.id],
      );
      const event = await client.query(
        'SELECT count(*)::int count FROM restore_suppression_event WHERE athlete_id=$1 AND target_id=$2',
        [athleteId, meal.originId],
      );
      return { head: head.rows[0], tombstone: tombstone.rows[0], event: event.rows[0] };
    });
    expect(facts).toEqual({
      head: { status: 'active', current_revision: 1 },
      tombstone: { count: 0 },
      event: { count: 0 },
    });
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toThrow();
    await expect(
      runtime.query('SELECT public.record_intake_entry_deletion_suppression_event()'),
    ).rejects.toThrow();
  });
});
