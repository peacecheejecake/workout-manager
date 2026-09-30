import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `actual_exact_${suffix}`;
const ownerRole = `actual_exact_owner_${suffix}`;
const runtimeRole = `actual_exact_rt_${suffix}`;
const migrationIndex = migrationFileNames.indexOf('093_exact_actual_deletion_replay.sql');
if (migrationIndex < 0) throw new Error('Exact actual deletion migration is missing');
const deletedAt = '2026-09-30T02:00:00.000Z';
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
  work: (client: PoolClient) => Promise<T>,
  commit = true,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const value = await work(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
async function account(athleteId: string) {
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,'https://issuer.test',$2)",
    [athleteId, randomUUID()],
  );
}
type Intake = {
  athleteId: string;
  id: string;
  origin: string;
  predecessor: string;
  revision: number;
  event: string;
  tombstone: string;
};
async function intake(athleteId = randomUUID(), revision = 1): Promise<Intake> {
  await account(athleteId);
  const id = `private-meal-${randomUUID()}`;
  const origin = randomUUID();
  const predecessor = revision === 1 ? origin : randomUUID();
  await tenant(athleteId, async (client) => {
    await client.query(
      "INSERT INTO intake_entry(athlete_id,id,current_revision,current_revision_id,status) VALUES($1,$2,1,$3,'active')",
      [athleteId, id, origin],
    );
    for (const [number, revisionId] of [
      [1, origin],
      ...(revision === 2 ? [[2, predecessor]] : []),
    ] as [number, string][]) {
      await client.query(
        `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,occurred_at,recorded_at,record_json)
         VALUES($1,$2,$3,$4,'active',$5,$5,$6::jsonb)`,
        [
          athleteId,
          id,
          number,
          revisionId,
          deletedAt,
          JSON.stringify({
            intakeId: id,
            revisionId,
            revision: number,
            status: 'active',
            occurredAt: deletedAt,
            recordedAt: deletedAt,
            notes: 'secret meal',
          }),
        ],
      );
      if (number === 2)
        await client.query(
          'UPDATE intake_entry SET current_revision=2,current_revision_id=$3 WHERE athlete_id=$1 AND id=$2',
          [athleteId, id, revisionId],
        );
    }
  });
  return {
    athleteId,
    id,
    origin,
    predecessor,
    revision: revision + 1,
    event: randomUUID(),
    tombstone: randomUUID(),
  };
}
type Action = {
  athleteId: string;
  id: string;
  predecessor: string;
  revision: number;
  event: string;
  tombstone: string;
};
async function action(athleteId = randomUUID(), revision = 1): Promise<Action> {
  await account(athleteId);
  const id = randomUUID();
  const first = randomUUID();
  const predecessor = revision === 1 ? first : randomUUID();
  await tenant(athleteId, async (client) => {
    await client.query(
      "INSERT INTO recovery_action_log(athlete_id,action_id,revision,revision_id,status) VALUES($1,$2,1,$3,'active')",
      [athleteId, id, first],
    );
    for (const [number, revisionId] of [
      [1, first],
      ...(revision === 2 ? [[2, predecessor]] : []),
    ] as [number, string][]) {
      await client.query(
        `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
         VALUES($1,$2,$3,$4,'active',$5::jsonb)`,
        [
          athleteId,
          id,
          number,
          revisionId,
          JSON.stringify({
            schemaVersion: 1,
            actionId: id,
            revisionId,
            revision: number,
            status: 'active',
            userNotes: 'secret recovery',
          }),
        ],
      );
      if (number === 2)
        await client.query(
          'UPDATE recovery_action_log SET revision=2,revision_id=$3 WHERE athlete_id=$1 AND action_id=$2',
          [athleteId, id, revisionId],
        );
    }
  });
  return {
    athleteId,
    id,
    predecessor,
    revision: revision + 1,
    event: randomUUID(),
    tombstone: randomUUID(),
  };
}
async function replayIntake(item: Intake) {
  return tenant(item.athleteId, (client) =>
    client.query<{ result: string }>(
      'SELECT public.replay_intake_entry_deletion_exact($1,$2,$3,$4,$5,$6,$7) AS result',
      [
        item.athleteId,
        item.origin,
        item.event,
        deletedAt,
        item.revision,
        item.predecessor,
        item.tombstone,
      ],
    ),
  );
}
async function replayAction(item: Action) {
  return tenant(item.athleteId, (client) =>
    client.query<{ result: string }>(
      'SELECT public.replay_recovery_action_deletion_exact($1,$2,$3,$4,$5,$6,$7) AS result',
      [
        item.athleteId,
        item.id,
        item.event,
        deletedAt,
        item.revision,
        item.predecessor,
        item.tombstone,
      ],
    ),
  );
}
async function state(athleteId: string, event: string) {
  return tenant(athleteId, async (client) => {
    const result = await client.query(
      `SELECT (SELECT count(*)::int FROM restore_suppression_event WHERE event_id=$1) events,
       (SELECT count(*)::int FROM restore_actual_deletion_replay_receipt WHERE event_id=$1) receipts,
       (SELECT count(*)::int FROM restore_actual_deletion_replay_context WHERE event_id=$1) contexts,
       (SELECT count(*)::int FROM outbox WHERE athlete_id=$2 AND id=$1) outbox`,
      [event, athleteId],
    );
    return result.rows[0];
  });
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await migrate(urlFor(ownerRole));
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await owner.query(
    `GRANT SELECT,INSERT,UPDATE ON intake_entry,intake_entry_revision,recovery_action_log,recovery_action_revision TO "${runtimeRole}"`,
  );
});
afterAll(async () => {
  await Promise.all([owner?.end(), runtime?.end()]);
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('owner-only exact replay of v2 actual deletion on PostgreSQL', () => {
  it('preserves source identities and emits only restore-generated outbox effects; retries exactly', async () => {
    for (const revision of [1, 2]) {
      const meal = await intake(undefined, revision);
      const rest = await action(undefined, revision);
      expect((await replayIntake(meal)).rows[0]?.result).toBe('deleted');
      expect((await replayAction(rest)).rows[0]?.result).toBe('deleted');
      for (const [item, target, kind, topic, payload] of [
        [
          meal,
          meal.origin,
          'intake_entry_deleted',
          'nutrition.intake_changed',
          { intakeId: meal.id, revision: meal.revision, action: 'deleted' },
        ],
        [rest, rest.id, 'recovery_action_deleted', 'recovery.action.deleted', { id: rest.id }],
      ] as const) {
        expect(await state(item.athleteId, item.event)).toEqual({
          events: 1,
          receipts: 1,
          contexts: 1,
          outbox: 1,
        });
        const facts = await tenant(item.athleteId, (client) =>
          client.query(
            `SELECT e.record_version,e.kind,e.target_id::text,e.occurred_at,
            e.actual_deletion_revision,e.actual_previous_revision_id::text,e.actual_deleted_revision_id::text,
            o.idempotency_key,o.topic,o.payload
           FROM restore_suppression_event e JOIN outbox o
             ON o.athlete_id=e.athlete_id AND o.id=e.event_id
           WHERE e.event_id=$1`,
            [item.event],
          ),
        );
        expect(facts.rows[0]).toMatchObject({
          record_version: 2,
          kind,
          target_id: target,
          actual_deletion_revision: item.revision,
          actual_previous_revision_id: item.predecessor,
          actual_deleted_revision_id: item.tombstone,
          idempotency_key: `restore:${kind}:${item.event}`,
          topic,
          payload,
        });
        expect(facts.rows[0]?.occurred_at).toEqual(new Date(deletedAt));
        expect(JSON.stringify(facts.rows[0])).not.toContain('secret');
        const receipt = await owner.query(
          'SELECT count(*)::int count FROM command_receipt WHERE athlete_id=$1',
          [item.athleteId],
        );
        expect(receipt.rows[0]?.count).toBe(0);
      }
      expect((await replayIntake(meal)).rows[0]?.result).toBe('already_applied');
      expect((await replayAction(rest)).rows[0]?.result).toBe('already_applied');
      expect(await state(meal.athleteId, meal.event)).toEqual({
        events: 1,
        receipts: 1,
        contexts: 1,
        outbox: 1,
      });
      expect(await state(rest.athleteId, rest.event)).toEqual({
        events: 1,
        receipts: 1,
        contexts: 1,
        outbox: 1,
      });
      await tenant(meal.athleteId, (client) =>
        client.query('DELETE FROM outbox WHERE athlete_id=$1 AND id=$2', [
          meal.athleteId,
          meal.event,
        ]),
      );
      await tenant(rest.athleteId, (client) =>
        client.query('DELETE FROM outbox WHERE athlete_id=$1 AND id=$2', [
          rest.athleteId,
          rest.event,
        ]),
      );
      expect((await replayIntake(meal)).rows[0]?.result).toBe('already_applied');
      expect((await replayAction(rest)).rows[0]?.result).toBe('already_applied');
      expect(await state(meal.athleteId, meal.event)).toEqual({
        events: 1,
        receipts: 1,
        contexts: 1,
        outbox: 0,
      });
      expect(await state(rest.athleteId, rest.event)).toEqual({
        events: 1,
        receipts: 1,
        contexts: 1,
        outbox: 0,
      });
    }
  });

  it('fails closed on missing predecessor, wrong UUID, absent target and legacy v1 event', async () => {
    const meal = await intake();
    const rest = await action();
    await expect(
      tenant(meal.athleteId, (client) =>
        client.query('SELECT public.replay_intake_entry_deletion_exact($1,$2,$3,$4,$5,$6,$7)', [
          meal.athleteId,
          meal.origin,
          meal.event,
          deletedAt,
          meal.revision + 1,
          meal.predecessor,
          meal.tombstone,
        ]),
      ),
    ).rejects.toThrow('RESTORE_ACTUAL_HISTORY_CONFLICT');
    await expect(replayIntake({ ...meal, predecessor: randomUUID() })).rejects.toThrow(
      'RESTORE_ACTUAL_HISTORY_CONFLICT',
    );
    await expect(replayAction({ ...rest, id: randomUUID() })).rejects.toThrow(
      'RESTORE_ACTUAL_ABSENT',
    );
    const foreignAthlete = randomUUID();
    await account(foreignAthlete);
    await expect(replayIntake({ ...meal, athleteId: foreignAthlete })).rejects.toThrow(
      'RESTORE_ACTUAL_ORIGIN_ABSENT',
    );
    await expect(replayAction({ ...rest, athleteId: foreignAthlete })).rejects.toThrow(
      'RESTORE_ACTUAL_ABSENT',
    );
    const conflicting = await intake();
    const strayRevision = randomUUID();
    await tenant(conflicting.athleteId, (client) =>
      client.query(
        `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
       occurred_at,recorded_at,record_json) VALUES($1,$2,2,$3,'active',$4,$4,$5::jsonb)`,
        [
          conflicting.athleteId,
          conflicting.id,
          strayRevision,
          deletedAt,
          JSON.stringify({
            intakeId: conflicting.id,
            revisionId: strayRevision,
            revision: 2,
            status: 'active',
            occurredAt: deletedAt,
            recordedAt: deletedAt,
          }),
        ],
      ),
    );
    await expect(replayIntake(conflicting)).rejects.toThrow('RESTORE_ACTUAL_HISTORY_CONFLICT');
    await tenant(meal.athleteId, (client) =>
      client.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at,actual_deletion_revision)
       VALUES($1,'intake_entry_deleted',$2,$3,$4)`,
        [meal.athleteId, meal.origin, deletedAt, meal.revision],
      ),
    );
    await expect(replayIntake(meal)).rejects.toThrow('RESTORE_ACTUAL_EVENT_CONFLICT');
    expect(await state(rest.athleteId, rest.event)).toEqual({
      events: 0,
      receipts: 0,
      contexts: 0,
      outbox: 0,
    });
  });

  it('rolls back every effect and rejects runtime GUC spoofing', async () => {
    const meal = await intake();
    await tenant(
      meal.athleteId,
      async (client) => {
        await client.query(
          'SELECT public.replay_intake_entry_deletion_exact($1,$2,$3,$4,$5,$6,$7)',
          [
            meal.athleteId,
            meal.origin,
            meal.event,
            deletedAt,
            meal.revision,
            meal.predecessor,
            meal.tombstone,
          ],
        );
      },
      false,
    );
    expect(await state(meal.athleteId, meal.event)).toEqual({
      events: 0,
      receipts: 0,
      contexts: 0,
      outbox: 0,
    });
    const head = await tenant(meal.athleteId, (client) =>
      client.query('SELECT status FROM intake_entry WHERE athlete_id=$1 AND id=$2', [
        meal.athleteId,
        meal.id,
      ]),
    );
    expect(head.rows[0]?.status).toBe('active');
    const runtimeClient = await runtime.connect();
    try {
      await runtimeClient.query('BEGIN');
      await runtimeClient.query("SELECT set_config('app.athlete_id',$1,true)", [meal.athleteId]);
      await runtimeClient.query("SELECT set_config('app.restore_actual_event_id',$1,true)", [
        meal.event,
      ]);
      await runtimeClient.query(
        `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
         recorded_at,deleted_at,deletion_reason) VALUES($1,$2,2,$3,'deleted',$4,$4,'user_requested')`,
        [meal.athleteId, meal.id, meal.tombstone, deletedAt],
      );
      await expect(
        runtimeClient.query(
          "UPDATE intake_entry SET current_revision=2,current_revision_id=$3,status='deleted' WHERE athlete_id=$1 AND id=$2",
          [meal.athleteId, meal.id, meal.tombstone],
        ),
      ).rejects.toThrow('RESTORE_ACTUAL_OWNER_REQUIRED');
      await runtimeClient.query('ROLLBACK');
    } finally {
      runtimeClient.release();
    }
    expect(await state(meal.athleteId, meal.event)).toEqual({
      events: 0,
      receipts: 0,
      contexts: 0,
      outbox: 0,
    });
    const normal = await intake();
    const normalClient = await runtime.connect();
    try {
      await normalClient.query('BEGIN');
      await normalClient.query("SELECT set_config('app.athlete_id',$1,true)", [normal.athleteId]);
      await normalClient.query(
        `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
         recorded_at,deleted_at,deletion_reason) VALUES($1,$2,2,$3,'deleted',$4,$4,'user_requested')`,
        [normal.athleteId, normal.id, normal.tombstone, deletedAt],
      );
      await normalClient.query(
        "UPDATE intake_entry SET current_revision=2,current_revision_id=$3,status='deleted' WHERE athlete_id=$1 AND id=$2",
        [normal.athleteId, normal.id, normal.tombstone],
      );
      await normalClient.query('COMMIT');
    } catch (error) {
      await normalClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      normalClient.release();
    }
    const source = await owner.query(
      'SELECT record_version,actual_deleted_revision_id::text FROM restore_suppression_event WHERE athlete_id=$1 AND kind=$2',
      [normal.athleteId, 'intake_entry_deleted'],
    );
    expect(source.rows).toEqual([
      { record_version: 2, actual_deleted_revision_id: normal.tombstone },
    ]);
    const spoofedAction = await action();
    const actionClient = await runtime.connect();
    try {
      await actionClient.query('BEGIN');
      await actionClient.query("SELECT set_config('app.athlete_id',$1,true)", [
        spoofedAction.athleteId,
      ]);
      await actionClient.query("SELECT set_config('app.restore_actual_event_id',$1,true)", [
        spoofedAction.event,
      ]);
      await actionClient.query(
        `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
         VALUES($1,$2,2,$3,'deleted',$4::jsonb)`,
        [
          spoofedAction.athleteId,
          spoofedAction.id,
          spoofedAction.tombstone,
          JSON.stringify({
            actionId: spoofedAction.id,
            revisionId: spoofedAction.tombstone,
            revision: 2,
            status: 'deleted',
            deletedAt,
          }),
        ],
      );
      await expect(
        actionClient.query(
          "UPDATE recovery_action_log SET revision=2,revision_id=$3,status='deleted' WHERE athlete_id=$1 AND action_id=$2",
          [spoofedAction.athleteId, spoofedAction.id, spoofedAction.tombstone],
        ),
      ).rejects.toThrow('RESTORE_ACTUAL_OWNER_REQUIRED');
      await actionClient.query('ROLLBACK');
    } finally {
      actionClient.release();
    }
    expect(await state(spoofedAction.athleteId, spoofedAction.event)).toEqual({
      events: 0,
      receipts: 0,
      contexts: 0,
      outbox: 0,
    });
    const normalAction = await action();
    const sourceClient = await runtime.connect();
    try {
      await sourceClient.query('BEGIN');
      await sourceClient.query("SELECT set_config('app.athlete_id',$1,true)", [
        normalAction.athleteId,
      ]);
      await sourceClient.query(
        `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
         VALUES($1,$2,2,$3,'deleted',$4::jsonb)`,
        [
          normalAction.athleteId,
          normalAction.id,
          normalAction.tombstone,
          JSON.stringify({
            actionId: normalAction.id,
            revisionId: normalAction.tombstone,
            revision: 2,
            status: 'deleted',
            deletedAt,
          }),
        ],
      );
      await sourceClient.query(
        "UPDATE recovery_action_log SET revision=2,revision_id=$3,status='deleted' WHERE athlete_id=$1 AND action_id=$2",
        [normalAction.athleteId, normalAction.id, normalAction.tombstone],
      );
      await sourceClient.query('COMMIT');
    } catch (error) {
      await sourceClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      sourceClient.release();
    }
    const recoverySource = await owner.query(
      'SELECT record_version,actual_deleted_revision_id::text FROM restore_suppression_event WHERE athlete_id=$1 AND kind=$2',
      [normalAction.athleteId, 'recovery_action_deleted'],
    );
    expect(recoverySource.rows).toEqual([
      { record_version: 2, actual_deleted_revision_id: normalAction.tombstone },
    ]);
  });

  it('rejects a context-only commit without an original event and receipt', async () => {
    const meal = await intake();
    await expect(
      tenant(meal.athleteId, async (client) => {
        await client.query(
          `INSERT INTO restore_actual_deletion_replay_context(event_id,athlete_id,kind,target_id,source_txid)
        VALUES($1,$2,'intake_entry_deleted',$3,txid_current())`,
          [meal.event, meal.athleteId, meal.origin],
        );
      }),
    ).rejects.toThrow('RESTORE_ACTUAL_REPLAY_INCOMPLETE');
    expect(await state(meal.athleteId, meal.event)).toEqual({
      events: 0,
      receipts: 0,
      contexts: 0,
      outbox: 0,
    });
  });

  it('allows exact retry after a separately receipted tenant erasure', async () => {
    const meal = await intake();
    expect((await replayIntake(meal)).rows[0]?.result).toBe('deleted');
    const erasureId = randomUUID();
    await tenant(meal.athleteId, (client) =>
      client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
        meal.athleteId,
        erasureId,
        '2026-09-30T03:00:00.000Z',
      ]),
    );
    expect((await replayIntake(meal)).rows[0]?.result).toBe('already_applied_by_erasure');
    const receipt = await owner.query(
      'SELECT count(*)::int count FROM restore_actual_deletion_replay_receipt WHERE event_id=$1',
      [meal.event],
    );
    expect(receipt.rows[0]?.count).toBe(1);
  });
});
