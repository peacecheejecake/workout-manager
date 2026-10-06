import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type {
  RaceEventValues,
  RaceResultValues,
  TrainingBestValues,
} from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { migrate, grantOperations, grantRaces } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `race_delete_${suffix}`,
  ownerRole = `race_delete_owner_${suffix}`,
  runtimeRole = `race_delete_app_${suffix}`;
let owner: Pool, runtime: Pool, elevated: Pool, database: Database, races: RaceRepository;
const maxRevision = 2147483647;
const families = ['race-event', 'race-result', 'training-best'] as const;
type Family = (typeof families)[number];
function urlFor(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${databaseName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function asTenant<T>(
  pool: Pool,
  athlete: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const owned = <T>(athlete: string, operation: (client: PoolClient) => Promise<T>) =>
  asTenant(owner, athlete, operation);
async function account() {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  // Explicit synthetic account permission for new race plan/actual fixture writes.
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
function eventValues(): RaceEventValues {
  return {
    title: 'Synthetic event',
    localDate: '2026-10-04',
    localStartTime: null,
    timezone: 'Asia/Seoul',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: null,
  };
}
function resultValues(): RaceResultValues {
  return {
    kind: 'race-result',
    raceEventId: null,
    localDate: '2026-10-04',
    timezone: 'Asia/Seoul',
    source: { kind: 'manual' },
    chipSeconds: 0,
    gunSeconds: null,
    officialDistanceMeters: null,
    deviceDistanceMeters: 10042,
    linkedActivityId: null,
    weatherNote: 'Synthetic independent result',
  };
}
function bestValues(): TrainingBestValues {
  return {
    kind: 'training-best',
    observedAt: '2026-10-03T08:00:00+09:00',
    source: { kind: 'manual' },
    basis: 'user-entered',
    distanceMeters: null,
    elapsedSeconds: 0,
  };
}
function create(athlete: string, kind: Family) {
  const idempotencyKey = randomUUID();
  switch (kind) {
    case 'race-event':
      return races.createRaceEvent(athlete, { idempotencyKey, values: eventValues() });
    case 'race-result':
      return races.createRaceResult(athlete, { idempotencyKey, values: resultValues() });
    case 'training-best':
      return races.createTrainingBest(athlete, { idempotencyKey, values: bestValues() });
  }
}
function remove(
  athlete: string,
  kind: Family,
  id: string,
  expectedRevision = 1,
  idempotencyKey = randomUUID(),
  repository = races,
) {
  const command = { idempotencyKey, expectedRevision };
  switch (kind) {
    case 'race-event':
      return repository.deleteRaceEvent(athlete, id, command);
    case 'race-result':
      return repository.deleteRaceResult(athlete, id, command);
    case 'training-best':
      return repository.deleteTrainingBest(athlete, id, command);
  }
}
function read(athlete: string, kind: Family, id: string) {
  switch (kind) {
    case 'race-event':
      return races.getRaceEvent(athlete, id);
    case 'race-result':
      return races.getRaceResult(athlete, id);
    case 'training-best':
      return races.getTrainingBest(athlete, id);
  }
}
const entrySchema = z.object({
  event_id: z.uuid(),
  athlete_id: z.uuid(),
  kind: z.enum(['race_event_deleted', 'race_result_deleted', 'training_best_deleted']),
  target_id: z.uuid(),
  occurred_at: z.string().datetime({ precision: 6 }),
  race_previous_revision: z.number().int(),
  race_deleted_revision: z.number().int(),
});
type Entry = z.infer<typeof entrySchema>;
function entry(athlete: string, kind: Family, id: string, previous = 1): Entry {
  return {
    event_id: randomUUID(),
    athlete_id: athlete,
    kind:
      kind === 'race-event'
        ? 'race_event_deleted'
        : kind === 'race-result'
          ? 'race_result_deleted'
          : 'training_best_deleted',
    target_id: id,
    occurred_at: new Date(Date.now() - 1000).toISOString().replace(/Z$/, '000Z'),
    race_previous_revision: previous,
    race_deleted_revision: Math.min(previous + 1, maxRevision),
  };
}
function args(value: Entry) {
  return [
    value.athlete_id,
    value.kind,
    value.target_id,
    value.event_id,
    value.occurred_at,
    value.race_previous_revision,
    value.race_deleted_revision,
  ];
}
const replaySql = 'SELECT public.replay_race_deletion_exact($1,$2,$3,$4,$5,$6,$7) AS result';
async function replay(value: Entry, pool = owner) {
  const result = await asTenant(pool, value.athlete_id, (client) =>
    client.query(replaySql, args(value)),
  );
  return result.rows[0]?.['result'];
}
async function counts(athlete: string, kind: Family, id: string) {
  const table = kind.replaceAll('-', '_');
  return owned(athlete, async (client) => {
    const result = await client.query(
      `SELECT (SELECT count(*)::int FROM ${table}_revision WHERE athlete_id=$1 AND entity_id=$2) AS history,(SELECT count(*)::int FROM restore_suppression_event WHERE athlete_id=$1 AND target_id=$2 AND record_version=4) AS events,(SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND topic='race.entity_deleted' AND payload->>'id'=$2::text) AS outbox`,
      [athlete, id],
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
  await migrate(urlFor(ownerRole));
  const elevatedUrl = new URL(adminUrl);
  elevatedUrl.pathname = `/${databaseName}`;
  elevated = new Pool({ connectionString: elevatedUrl.toString() });
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantRaces(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO "${runtimeRole}"`);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 8 });
  races = createRaceRepository(database);
});
afterAll(async () => {
  await database?.close();
  await runtime?.end();
  await elevated?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
// M2-02f/S15/S16: real restricted-role PostgreSQL. External backup restore is not executed.
describe('individual race privacy deletion', () => {
  it.each(families)(
    'deletes %s atomically with minimal original receipt and suppression',
    async (kind) => {
      const athlete = await account(),
        target = await create(athlete, kind),
        key = randomUUID();
      const result = await remove(athlete, kind, target.id, 1, key);
      expect(result).toEqual({ id: target.id, revision: 2 });
      expect(await read(athlete, kind, target.id)).toBeNull();
      expect(await remove(athlete, kind, target.id, 1, key)).toEqual(result);
      expect(await counts(athlete, kind, target.id)).toEqual({ history: 0, events: 1, outbox: 1 });
      await owned(athlete, async (client) => {
        const heads = await client.query(
          `SELECT values_json,deleted,revision FROM ${kind.replaceAll('-', '_')} WHERE id=$1`,
          [target.id],
        );
        expect(heads.rows).toEqual([{ values_json: null, deleted: true, revision: 2 }]);
        const receipts = await client.query(
          'SELECT result FROM race_command_receipt WHERE idempotency_key=$1',
          [key],
        );
        expect(receipts.rows[0]?.['result']).toEqual(result);
        const events = await client.query(
          `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM restore_suppression_event WHERE target_id=$1 AND record_version=4`,
          [target.id],
        );
        const event = entrySchema.parse(events.rows[0]);
        expect(event.race_previous_revision).toBe(1);
        expect(event.race_deleted_revision).toBe(2);
        for (const [column, value] of Object.entries(events.rows[0] ?? {})) {
          if (
            ![
              'event_id',
              'record_version',
              'athlete_id',
              'kind',
              'target_id',
              'occurred_at',
              'race_previous_revision',
              'race_deleted_revision',
            ].includes(column)
          )
            expect(value).toBeNull();
        }
      });
      await expect(remove(athlete, kind, target.id, 2, key)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    },
  );
  it.each(families)(
    'enforces stale CAS, foreign absence and concurrent same revision for %s',
    async (kind) => {
      const athlete = await account(),
        other = await account(),
        target = await create(athlete, kind);
      await expect(remove(athlete, kind, target.id, 2)).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      await expect(remove(other, kind, target.id)).rejects.toMatchObject({
        code: 'RACE_NOT_FOUND',
      });
      await expect(remove(other, kind, randomUUID())).rejects.toMatchObject({
        code: 'RACE_NOT_FOUND',
      });
      expect(await read(athlete, kind, target.id)).not.toBeNull();
      const results = await Promise.allSettled([
        remove(athlete, kind, target.id),
        remove(athlete, kind, target.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await counts(athlete, kind, target.id)).toEqual({ history: 0, events: 1, outbox: 1 });
    },
  );
  it.each(families)(
    'purges every private correction of %s while old create receipt remains minimal',
    async (kind) => {
      const athlete = await account();
      const target = await create(athlete, kind);
      const idempotencyKey = randomUUID();
      switch (kind) {
        case 'race-event':
          await races.updateRaceEvent(athlete, target.id, {
            idempotencyKey,
            expectedRevision: 1,
            values: { ...eventValues(), title: 'Corrected private event' },
          });
          break;
        case 'race-result':
          await races.updateRaceResult(athlete, target.id, {
            idempotencyKey,
            expectedRevision: 1,
            values: { ...resultValues(), chipSeconds: 2400 },
          });
          break;
        case 'training-best':
          await races.updateTrainingBest(athlete, target.id, {
            idempotencyKey,
            expectedRevision: 1,
            values: { ...bestValues(), elapsedSeconds: 42 },
          });
          break;
      }
      expect((await counts(athlete, kind, target.id))?.['history']).toBe(2);
      expect(await remove(athlete, kind, target.id, 2)).toEqual({ id: target.id, revision: 3 });
      expect(await counts(athlete, kind, target.id)).toEqual({ history: 0, events: 1, outbox: 1 });
      const receipts = await database.tenant(athlete, (tx) =>
        tx.query('SELECT result FROM race_command_receipt WHERE athlete_id=$1', [athlete]),
      );
      expect(receipts.rows).toHaveLength(3);
      for (const row of receipts.rows)
        expect(Object.keys(z.record(z.string(), z.unknown()).parse(row['result'])).sort()).toEqual([
          'id',
          'revision',
        ]);
    },
  );
  it('rejects malformed commands and preserves unknown driver errors', async () => {
    const athlete = await account(),
      target = await create(athlete, 'race-event');
    await expect(
      races.deleteRaceEvent(athlete, 'bad', { idempotencyKey: randomUUID(), expectedRevision: 1 }),
    ).rejects.toThrow();
    await expect(remove(athlete, 'race-event', target.id, 0)).rejects.toThrow();
    const invalid = { idempotencyKey: randomUUID(), expectedRevision: 1, values: eventValues() };
    await expect(races.deleteRaceEvent(athlete, target.id, invalid)).rejects.toThrow();
    const fault = new Error('synthetic driver fault');
    const broken: Database = { ...database, tenant: () => Promise.reject(fault) };
    await expect(
      remove(athlete, 'race-event', target.id, 1, randomUUID(), createRaceRepository(broken)),
    ).rejects.toBe(fault);
  });
  it('rolls back real helper transaction on receipt write failure', async () => {
    const athlete = await account(),
      target = await create(athlete, 'race-event'),
      key = randomUUID();
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO race_command_receipt'))
                throw new Error('synthetic receipt failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(
      remove(athlete, 'race-event', target.id, 1, key, createRaceRepository(broken)),
    ).rejects.toThrow('synthetic receipt failure');
    expect(await read(athlete, 'race-event', target.id)).not.toBeNull();
    expect(await counts(athlete, 'race-event', target.id)).toEqual({
      history: 1,
      events: 0,
      outbox: 0,
    });
    expect(await remove(athlete, 'race-event', target.id, 1, key)).toEqual({
      id: target.id,
      revision: 2,
    });
  });
  it('concurrent identical commands replay one receipt', async () => {
    const athlete = await account(),
      target = await create(athlete, 'race-event'),
      key = randomUUID();
    const results = await Promise.all([
      remove(athlete, 'race-event', target.id, 1, key),
      remove(athlete, 'race-event', target.id, 1, key),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await counts(athlete, 'race-event', target.id)).toEqual({
      history: 0,
      events: 1,
      outbox: 1,
    });
  });
  it.each(families)(
    'accepts terminal %s and invalidates a terminal collection cursor',
    async (kind) => {
      const athlete = await account(),
        first = await create(athlete, kind);
      await create(athlete, kind);
      await owned(athlete, (client) =>
        client.query(
          `UPDATE ${kind.replaceAll('-', '_')} SET revision=$2 WHERE athlete_id=$1 AND id=$3`,
          [athlete, maxRevision, first.id],
        ),
      );
      await owned(athlete, (client) =>
        client.query('UPDATE race_collection_head SET revision=$2 WHERE athlete_id=$1', [
          athlete,
          maxRevision,
        ]),
      );
      const page =
        kind === 'race-event'
          ? await races.listRaceEvents(athlete, { limit: 1 })
          : kind === 'race-result'
            ? await races.listRaceResults(athlete, { limit: 1 })
            : await races.listTrainingBests(athlete, { limit: 1 });
      expect(page.nextCursor).not.toBeNull();
      expect(await remove(athlete, kind, first.id, maxRevision)).toEqual({
        id: first.id,
        revision: maxRevision,
      });
      const cursor = z
        .object({
          kind: z.enum(families),
          collection: z.object({ revision: z.number(), privacyGeneration: z.string() }),
          afterId: z.uuid(),
        })
        .parse(page.nextCursor);
      await expect(
        kind === 'race-event'
          ? races.listRaceEvents(athlete, { cursor })
          : kind === 'race-result'
            ? races.listRaceResults(athlete, { cursor })
            : races.listTrainingBests(athlete, { cursor }),
      ).rejects.toMatchObject({ code: 'RACE_CURSOR_STALE' });
      const head = await owned(athlete, (client) =>
        client.query(
          'SELECT revision,privacy_generation::text AS generation FROM race_collection_head WHERE athlete_id=$1 AND kind=$2',
          [athlete, kind],
        ),
      );
      expect(head.rows).toEqual([{ revision: maxRevision, generation: '1' }]);
    },
  );
  it('unlinks independent results, purges historical links and leaves Plan/Activity unchanged', async () => {
    const athlete = await account(),
      activity = randomUUID(),
      plan = randomUUID();
    await owned(athlete, async (client) => {
      await client.query(
        'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
        [athlete, activity, JSON.stringify({ title: 'Synthetic activity' })],
      );
      await client.query(
        'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
        [athlete, plan, JSON.stringify({ fixture: 'Synthetic plan' })],
      );
    });
    const target = await races.createRaceEvent(athlete, {
        idempotencyKey: randomUUID(),
        values: { ...eventValues(), planVersionId: plan },
      }),
      other = await create(athlete, 'race-event');
    const result = await races.createRaceResult(athlete, {
        idempotencyKey: randomUUID(),
        values: { ...resultValues(), raceEventId: target.id, linkedActivityId: activity },
      }),
      historical = await races.createRaceResult(athlete, {
        idempotencyKey: randomUUID(),
        values: { ...resultValues(), raceEventId: target.id },
      });
    await races.updateRaceResult(athlete, historical.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...resultValues(), raceEventId: other.id },
    });
    const snapshotSql =
      'SELECT (SELECT row_to_json(a) FROM activity_canonical a WHERE id=$1) AS activity,(SELECT row_to_json(p) FROM plan_snapshot p WHERE id=$2) AS plan';
    const before = await owned(athlete, (client) => client.query(snapshotSql, [activity, plan]));
    await remove(athlete, 'race-event', target.id);
    expect(await races.getRaceResult(athlete, result.id)).toEqual({
      ...resultValues(),
      linkedActivityId: activity,
      id: result.id,
      revision: 2,
    });
    expect(await races.getRaceResult(athlete, historical.id)).toEqual({
      ...resultValues(),
      raceEventId: other.id,
      id: historical.id,
      revision: 2,
    });
    const after = await owned(athlete, (client) => client.query(snapshotSql, [activity, plan]));
    expect(after.rows).toEqual(before.rows);
    const links = await owned(athlete, (client) =>
      client.query(
        "SELECT count(*)::int AS count FROM race_result_revision WHERE athlete_id=$1 AND values_json->>'raceEventId'=$2",
        [athlete, target.id],
      ),
    );
    expect(links.rows).toEqual([{ count: 0 }]);
    await remove(athlete, 'race-result', result.id, 2);
    const best = await races.createTrainingBest(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...bestValues(), source: { kind: 'activity', activityId: activity } },
    });
    await remove(athlete, 'training-best', best.id);
    expect(
      (
        await owned(athlete, (client) =>
          client.query('SELECT deleted FROM activity_canonical WHERE id=$1', [activity]),
        )
      ).rows,
    ).toEqual([{ deleted: false }]);
  });
  it('rejects runtime direct deletion, tombstone insert, resurrection, private history and forged GUC', async () => {
    const athlete = await account(),
      target = await create(athlete, 'race-event');
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE race_event SET deleted=true,values_json=NULL WHERE id=$1', [target.id]),
      ),
    ).rejects.toThrow('RACE_DELETION_OWNER_REQUIRED');
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          'INSERT INTO race_event(athlete_id,id,revision,deleted,recorded_at,updated_at) VALUES($1,$2,1,true,now(),now())',
          [athlete, randomUUID()],
        ),
      ),
    ).rejects.toThrow('RACE_DELETION_OWNER_REQUIRED');
    await remove(athlete, 'race-event', target.id);
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE race_event SET deleted=false,values_json=$2::jsonb WHERE id=$1', [
          target.id,
          JSON.stringify(eventValues()),
        ]),
      ),
    ).rejects.toThrow('RACE_DELETED_REENTRY');
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,2,$3::jsonb,now())',
          [athlete, target.id, JSON.stringify(eventValues())],
        ),
      ),
    ).rejects.toThrow('RACE_DELETED_REENTRY');
    await expect(
      database.tenant(athlete, async (tx) => {
        await tx.query("SELECT set_config('app.restore_actual_event_id',$1,true)", [randomUUID()]);
        return tx.query('UPDATE race_event SET deleted=false,values_json=$2::jsonb WHERE id=$1', [
          target.id,
          JSON.stringify(eventValues()),
        ]);
      }),
    ).rejects.toThrow('RACE_DELETED_REENTRY');
  });
});
describe('race deletion dependency and suppression guards', () => {
  it('cannot reinsert a suppressed absent target or relink a deleted event in current/history rows', async () => {
    const athlete = await account();
    const event = await create(athlete, 'race-event');
    const result = await create(athlete, 'race-result');
    await remove(athlete, 'race-event', event.id);
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          "UPDATE race_result SET values_json=jsonb_set(values_json,'{raceEventId}',to_jsonb($2::text)) WHERE id=$1",
          [result.id, event.id],
        ),
      ),
    ).rejects.toThrow('RACE_EVENT_DELETED_REFERENCE');
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          'INSERT INTO race_result_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,2,$3::jsonb,now())',
          [athlete, result.id, JSON.stringify({ ...resultValues(), raceEventId: event.id })],
        ),
      ),
    ).rejects.toThrow('RACE_EVENT_DELETED_REFERENCE');
    await owned(athlete, (client) =>
      client.query('DELETE FROM race_event WHERE id=$1', [event.id]),
    );
    const sameId = createRaceRepository(database, { createId: () => event.id });
    await expect(
      sameId.createRaceEvent(athlete, { idempotencyKey: randomUUID(), values: eventValues() }),
    ).rejects.toThrow('RACE_DELETED_REENTRY');
  });
  it('exact event replay purges current and historical-only result dependencies and invalidates collections', async () => {
    const athlete = await account();
    const target = await create(athlete, 'race-event');
    const another = await create(athlete, 'race-event');
    const linked = await races.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...resultValues(), raceEventId: target.id },
    });
    const historical = await races.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...resultValues(), raceEventId: target.id },
    });
    await races.updateRaceResult(athlete, historical.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...resultValues(), raceEventId: another.id },
    });
    await owned(athlete, (client) =>
      client.query('UPDATE race_result SET revision=$2 WHERE id=$1', [linked.id, maxRevision]),
    );
    const before = await races.listRaceResults(athlete, { limit: 1 });
    expect(await replay(entry(athlete, 'race-event', target.id))).toBe('applied');
    expect(await races.getRaceResult(athlete, linked.id)).toEqual({
      ...resultValues(),
      id: linked.id,
      revision: maxRevision,
    });
    expect(await races.getRaceResult(athlete, historical.id)).toEqual({
      ...resultValues(),
      raceEventId: another.id,
      id: historical.id,
      revision: 2,
    });
    await expect(
      races.listRaceResults(athlete, { cursor: before.nextCursor }),
    ).rejects.toMatchObject({ code: 'RACE_CURSOR_STALE' });
    const rows = await owned(athlete, (client) =>
      client.query(
        "SELECT count(*)::int AS count FROM race_result_revision WHERE values_json->>'raceEventId'=$1",
        [target.id],
      ),
    );
    expect(rows.rows).toEqual([{ count: 0 }]);
  });
});
describe('owner-only exact race suppression replay', () => {
  it.each(families)(
    'replays %s and repeats exact receipt without another freshness change',
    async (kind) => {
      const athlete = await account(),
        target = await create(athlete, kind),
        source = entry(athlete, kind, target.id);
      expect(await replay(source)).toBe('applied');
      expect(await read(athlete, kind, target.id)).toBeNull();
      const before = await owned(athlete, (client) =>
        client.query('SELECT * FROM race_collection_head WHERE athlete_id=$1 ORDER BY kind', [
          athlete,
        ]),
      );
      expect(await replay(source)).toBe('already_applied');
      const after = await owned(athlete, (client) =>
        client.query('SELECT * FROM race_collection_head WHERE athlete_id=$1 ORDER BY kind', [
          athlete,
        ]),
      );
      expect(after.rows).toEqual(before.rows);
      expect(await counts(athlete, kind, target.id)).toEqual({ history: 0, events: 1, outbox: 0 });
      await expect(replay({ ...source, event_id: randomUUID() })).rejects.toThrow(
        'RESTORE_RACE_EVENT_CONFLICT',
      );
      await expect(
        replay({
          ...source,
          occurred_at: new Date(new Date(source.occurred_at).getTime() - 1000)
            .toISOString()
            .replace(/Z$/, '000Z'),
        }),
      ).rejects.toThrow('RESTORE_RACE_EVENT_CONFLICT');
      await expect(
        replay({ ...source, race_previous_revision: 2, race_deleted_revision: 3 }),
      ).rejects.toThrow('RESTORE_RACE_EVENT_CONFLICT');
    },
  );
  it('replays production event present in backup but no offline receipt', async () => {
    const athlete = await account(),
      target = await create(athlete, 'race-event');
    await remove(athlete, 'race-event', target.id);
    const rows = await owned(athlete, (client) =>
      client.query(
        `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM restore_suppression_event WHERE target_id=$1 AND record_version=4`,
        [target.id],
      ),
    );
    const source = entrySchema.parse(rows.rows[0]);
    expect(
      (
        await owned(athlete, (client) =>
          client.query(
            'SELECT count(*)::int AS count FROM restore_race_deletion_replay_receipt WHERE event_id=$1',
            [source.event_id],
          ),
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(await replay(source)).toBe('already_applied');
    expect(
      (
        await owned(athlete, (client) =>
          client.query(
            'SELECT count(*)::int AS count FROM restore_race_deletion_replay_receipt WHERE event_id=$1',
            [source.event_id],
          ),
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it('suppresses absent, newer and terminal heads without rollback or resurrection', async () => {
    const athlete = await account(),
      absent = entry(athlete, 'race-event', randomUUID());
    expect(await replay(absent)).toBe('applied');
    const newer = await create(athlete, 'race-result');
    await owned(athlete, (client) =>
      client.query('UPDATE race_result SET revision=10 WHERE id=$1', [newer.id]),
    );
    expect(await replay(entry(athlete, 'race-result', newer.id))).toBe('applied');
    const final = await create(athlete, 'training-best');
    await owned(athlete, (client) =>
      client.query('UPDATE training_best SET revision=$2 WHERE id=$1', [final.id, maxRevision]),
    );
    const terminal = entry(athlete, 'training-best', final.id, maxRevision);
    expect(await replay(terminal)).toBe('applied');
    expect(await replay(terminal)).toBe('already_applied');
    const rows = await owned(athlete, (client) =>
      client.query(
        'SELECT revision,deleted,values_json FROM race_result WHERE id=$1 UNION ALL SELECT revision,deleted,values_json FROM training_best WHERE id=$2',
        [newer.id, final.id],
      ),
    );
    expect(rows.rows).toEqual([
      { revision: 11, deleted: true, values_json: null },
      { revision: maxRevision, deleted: true, values_json: null },
    ]);
    await expect(
      replay({ ...absent, race_previous_revision: 2, race_deleted_revision: 2 }),
    ).rejects.toThrow('RESTORE_RACE_INVALID_ENTRY');
    await expect(
      replay({
        ...absent,
        occurred_at: new Date(Date.now() + 100000).toISOString().replace(/Z$/, '000Z'),
      }),
    ).rejects.toThrow('RESTORE_RACE_INVALID_ENTRY');
  });
  it('denies runtime, GUC, SET ROLE, superuser and foreign tenant replay', async () => {
    const athlete = await account(),
      source = entry(athlete, 'race-event', randomUUID());
    await expect(replay(source, runtime)).rejects.toThrow('permission denied');
    await expect(replay(source, elevated)).rejects.toThrow('RESTORE_RACE_OWNER_REQUIRED');
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer) TO "${runtimeRole}"`,
    );
    await admin.query(`GRANT "${runtimeRole}" TO "${ownerRole}"`);
    try {
      await expect(
        asTenant(runtime, athlete, async (client) => {
          await client.query("SELECT set_config('app.restore_actual_event_id',$1,true)", [
            source.event_id,
          ]);
          return client.query(replaySql, args(source));
        }),
      ).rejects.toThrow('RESTORE_RACE_OWNER_REQUIRED');
      await expect(
        owned(athlete, async (client) => {
          await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
          return client.query(replaySql, args(source));
        }),
      ).rejects.toThrow('RESTORE_RACE_OWNER_REQUIRED');
    } finally {
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer) FROM "${runtimeRole}"`,
      );
      await admin.query(`REVOKE "${runtimeRole}" FROM "${ownerRole}"`);
    }
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('SELECT public.purge_race_entity_private($1,$2,$3,$4,now())', [
          athlete,
          'race-event',
          source.target_id,
          2,
        ]),
      ),
    ).rejects.toThrow('permission denied');
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('SELECT * FROM restore_race_deletion_replay_receipt'),
      ),
    ).rejects.toThrow('permission denied');
    const other = await account();
    await expect(owned(other, (client) => client.query(replaySql, args(source)))).rejects.toThrow(
      'RESTORE_RACE_INVALID_ENTRY',
    );
  });
  it('rejects event/receipt tampering and detects corrupt exact receipt', async () => {
    const athlete = await account(),
      source = entry(athlete, 'race-event', randomUUID());
    await replay(source);
    await expect(
      owned(athlete, (client) =>
        client.query(
          'UPDATE restore_race_deletion_replay_receipt SET previous_revision=2 WHERE event_id=$1',
          [source.event_id],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      owned(athlete, (client) =>
        client.query('DELETE FROM restore_suppression_event WHERE event_id=$1', [source.event_id]),
      ),
    ).rejects.toThrow();
    await owner.query(
      'ALTER TABLE restore_race_deletion_replay_receipt DISABLE TRIGGER restore_race_deletion_receipt_immutable',
    );
    try {
      await owned(athlete, (client) =>
        client.query(
          "UPDATE restore_race_deletion_replay_receipt SET occurred_at=occurred_at-interval '1 second' WHERE event_id=$1",
          [source.event_id],
        ),
      );
    } finally {
      await owner.query(
        'ALTER TABLE restore_race_deletion_replay_receipt ENABLE TRIGGER restore_race_deletion_receipt_immutable',
      );
    }
    await expect(replay(source)).rejects.toThrow('RESTORE_RACE_RECEIPT_CONFLICT');
  });
  it('requires exact erasure proof and cannot recreate race data', async () => {
    const athlete = await account(),
      target = await create(athlete, 'race-event'),
      source = entry(athlete, 'race-event', target.id);
    await replay(source);
    await database.exclusiveTenant(athlete, (tx) =>
      tx.query('SELECT public.erase_account($1)', [athlete]),
    );
    await expect(replay(source)).rejects.toThrow('RESTORE_RACE_TENANT_ERASED');
    // Production erasure has no offline receipt. A separate restore fixture uses
    // the actual plain-owner exact erasure path to establish its required proof.
    const restoredAthlete = await account();
    const restoredTarget = await create(restoredAthlete, 'race-event');
    const restoredSource = entry(restoredAthlete, 'race-event', restoredTarget.id);
    await replay(restoredSource);
    await owned(restoredAthlete, (client) =>
      client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
        restoredAthlete,
        randomUUID(),
        new Date(Date.now() - 1000).toISOString(),
      ]),
    );
    expect(await replay(restoredSource)).toBe('already_applied_by_erasure');
    const rows = await owned(athlete, (client) =>
      client.query(
        'SELECT (SELECT count(*)::int FROM race_event WHERE athlete_id=$1) AS heads,(SELECT count(*)::int FROM race_command_receipt WHERE athlete_id=$1) AS commands,(SELECT count(*)::int FROM race_collection_head WHERE athlete_id=$1) AS collections,(SELECT count(*)::int FROM restore_race_deletion_replay_receipt WHERE athlete_id=$1) AS receipts',
        [athlete],
      ),
    );
    expect(rows.rows).toEqual([{ heads: 0, commands: 0, collections: 0, receipts: 1 }]);
  });
});
