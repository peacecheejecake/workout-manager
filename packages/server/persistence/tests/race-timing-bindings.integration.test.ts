import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantRaces, grantOperations } from '../src/migrate.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { captureRaceTimingPins, requireFreshRaceTimingPins } from '../src/race-timing-bindings.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Prepared real-PG suite: normal106/plain roles, actual RaceRepository source.
// Synthetic consent heads and owner corruption fixtures are labeled separately.
// No admission reopen, SQL106 positive review storage, provider or plan approval.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const dbName = `race_timing_${suffix}`;
const ownerRole = `race_timing_owner_${suffix}`;
const runtimeRole = `race_timing_app_${suffix}`;
let owner: Pool;
let database: Database;
let races: RaceRepository;
function url(role: string) {
  const result = new URL(adminUrl);
  result.pathname = `/${dbName}`;
  result.username = role;
  result.password = 'isolated';
  return result.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole), 106);
  await grantRaces(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 4 });
  database = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  races = createRaceRepository(database);
  const roles = await admin.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
    [[ownerRole, runtimeRole]],
  );
  expect(roles.rows).toHaveLength(2);
  for (const role of roles.rows) expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  expect(
    (
      await owner.query(
        'SELECT count(*)::integer AS count,max(version) AS version FROM schema_migrations',
      )
    ).rows,
  ).toEqual([{ count: 106, version: 106 }]);
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athlete,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
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
async function account() {
  const athlete = randomUUID();
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athlete, 'https://synthetic.invalid', randomUUID()],
  );
  // Explicit named synthetic app permission, not an automatic production grant.
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
function values(patch: Partial<RaceEventValues> = {}): RaceEventValues {
  return {
    title: 'Synthetic owned race',
    localDate: '2026-10-07',
    localStartTime: '09:00',
    timezone: 'Asia/Seoul',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: null,
    planVersionId: null,
    ...patch,
  };
}
async function source(patch: Partial<RaceEventValues> = {}) {
  const athlete = await account();
  const body = values(patch);
  const event = await races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: body,
  });
  return { athlete, body, event };
}
const heads = (id: string, revision = 1) => [{ namespace: 'race-event', eventId: id, revision }];
async function read<T>(athlete: string, operation: (tx: Transaction) => Promise<T>) {
  return database.tenant(athlete, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    return operation(tx);
  });
}
function deferred() {
  let release: () => void = () => {
    throw new Error('UNINITIALIZED_BARRIER');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitForTenantWaiter() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const result = await admin.query(
      `SELECT count(*)::integer AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=$1 AND a.usename=$2 AND l.locktype='advisory' AND NOT l.granted`,
      [dbName, runtimeRole],
    );
    if (result.rows[0]?.['count'] === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('EXPECTED_REAL_TENANT_LOCK_WAIT');
}

it('normal106 source captures exact immutable history without any review store or positive admission', async () => {
  const s = await source();
  const pins = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
  expect(pins).toHaveLength(1);
  expect(pins[0]).toMatchObject({
    eventId: s.event.id,
    eventRevision: 1,
    start: { state: 'known', instant: '2026-10-07T00:00:00.000Z' },
    end: { state: 'unknown' },
  });
  await read(s.athlete, async (tx) => {
    await requireFreshRaceTimingPins(tx, pins);
    expect(
      (await tx.query("SELECT public.read_restore_processing_admission()->>'state' AS state"))
        .rows[0]?.['state'],
    ).toBe('CLOSED');
  });
  expect(
    await owned(
      s.athlete,
      async (client) =>
        (
          await client.query(
            'SELECT count(*)::integer AS count FROM race_manual_review WHERE athlete_id=$1',
            [s.athlete],
          )
        ).rows[0]?.['count'],
    ),
  ).toBe(0);
  // Fresh dedicated runtime receives only grantRaces/Operations: no inherited
  // blanket outbox UPDATE from the existing regression suites in their DB.
  await read(s.athlete, async (tx) => {
    expect(
      (
        await tx.query(
          "SELECT has_column_privilege(current_user,'outbox','idempotency_key','UPDATE') AS allowed",
        )
      ).rows[0]?.['allowed'],
    ).toBe(true);
    expect(
      (
        await tx.query('UPDATE outbox SET idempotency_key=idempotency_key WHERE athlete_id=$1', [
          s.athlete,
        ])
      ).rowCount,
    ).toBe(1);
  });
  for (const column of ['lease_token', 'available_at', 'payload']) {
    await read(s.athlete, async (tx) => {
      expect(
        (
          await tx.query(
            "SELECT has_column_privilege(current_user,'outbox',$1,'UPDATE') AS allowed",
            [column],
          )
        ).rows[0]?.['allowed'],
      ).toBe(false);
    });
    // Finite fixture column allowlist; even a no-row update needs its own ACL.
    await expect(
      read(s.athlete, (tx) => tx.query(`UPDATE outbox SET ${column}=${column} WHERE false`)),
    ).rejects.toMatchObject({ code: '42501' });
  }
});
it('literal absence stays empty and foreign owned event is not readable under FORCE RLS', async () => {
  const s = await source(),
    foreign = await account();
  expect(await read(foreign, (tx) => captureRaceTimingPins(tx, []))).toEqual([]);
  await expect(
    read(foreign, (tx) => captureRaceTimingPins(tx, heads(s.event.id))),
  ).rejects.toMatchObject({ code: 'RACE_TIMING_UNAVAILABLE' });
  await read(foreign, async (tx) => {
    expect((await tx.query('SELECT id FROM race_event WHERE id=$1', [s.event.id])).rows).toEqual(
      [],
    );
  });
});
it('same UUID in another tenant resolves only that tenant history (synthetic owner collision fixture)', async () => {
  const s = await source(),
    other = await account();
  const body = values({ localStartTime: '10:00' });
  await owned(other, async (client) => {
    await client.query(
      'INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [other, s.event.id, JSON.stringify(body)],
    );
    await client.query(
      'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [other, s.event.id, JSON.stringify(body)],
    );
  });
  const one = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
  const two = await read(other, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
  expect(one[0]?.sourceDigest).not.toBe(two[0]?.sourceDigest);
  expect(two[0]?.start).toEqual({ state: 'known', instant: '2026-10-07T01:00:00.000Z' });
});
it('unknown ID and actual deleted source fail closed without history-only resurrection', async () => {
  const s = await source();
  await expect(
    read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(randomUUID()))),
  ).rejects.toMatchObject({ code: 'RACE_TIMING_UNAVAILABLE' });
  await races.deleteRaceEvent(s.athlete, s.event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
  });
  await expect(
    read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id))),
  ).rejects.toMatchObject({ code: 'RACE_TIMING_UNAVAILABLE' });
});
it.each([
  { localStartTime: null, reason: 'start_time_not_recorded' },
  {
    localDate: '2026-03-08',
    localStartTime: '02:30',
    timezone: 'America/New_York',
    reason: 'ambiguous_local_time',
  },
  {
    localDate: '2026-11-01',
    localStartTime: '01:30',
    timezone: 'America/New_York',
    reason: 'ambiguous_local_time',
  },
])('actual source null/gap/overlap stays unknown %j', async ({ reason, ...patch }) => {
  const s = await source(patch);
  const pins = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
  expect(pins[0]?.start).toEqual({ state: 'unknown', reason });
  expect(pins[0]?.end).toEqual({ state: 'unknown', reason: 'race_end_not_recorded' });
});
it('actual revision change rejects old captured pin and requires a new explicit revision', async () => {
  const s = await source();
  const pins = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
  await races.updateRaceEvent(s.athlete, s.event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...s.body, localStartTime: '11:00' },
  });
  await expect(read(s.athlete, (tx) => requireFreshRaceTimingPins(tx, pins))).rejects.toMatchObject(
    { code: 'RACE_TIMING_STALE' },
  );
  const latest = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id, 2)));
  expect(latest[0]?.eventRevision).toBe(2);
  expect(pins[0]?.eventRevision).toBe(1);
  expect(pins[0]?.start).toEqual({ state: 'known', instant: '2026-10-07T00:00:00.000Z' });
});
it('synthetic plain-owner missing history is rejected by the reader', async () => {
  const s = await source();
  await owned(s.athlete, (client) =>
    client.query('DELETE FROM race_event_revision WHERE athlete_id=$1 AND entity_id=$2', [
      s.athlete,
      s.event.id,
    ]),
  );
  await expect(
    read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id))),
  ).rejects.toMatchObject({ code: 'RACE_TIMING_INVALID_SOURCE' });
});
it.each(['changed', 'unknown_field'])(
  'immutable history guard refuses %s attack, rolls back and preserves original pin/digest',
  async (attack) => {
    const s = await source();
    const original = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
    // The real immutable guard prevents this malformed body from reaching the
    // reader. Reader malformed-body rejection is separately a QueryPort unit test.
    await expect(
      owned(s.athlete, (client) =>
        client.query(
          'UPDATE race_event_revision SET values_json=values_json || $3::jsonb WHERE athlete_id=$1 AND entity_id=$2',
          [
            s.athlete,
            s.event.id,
            JSON.stringify(
              attack === 'changed' ? { title: 'Synthetic tamper' } : { unknown: true },
            ),
          ],
        ),
      ),
    ).rejects.toThrow('IMMUTABLE_RACE_HISTORY');
    const retained = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
    expect(retained).toEqual(original);
    expect(retained[0]?.sourceDigest).toBe(original[0]?.sourceDigest);
    await read(s.athlete, (tx) => requireFreshRaceTimingPins(tx, original));
  },
);
it('caller transaction rollback preserves source head/history (synthetic runtime DML fixture)', async () => {
  const s = await source();
  await expect(
    read(s.athlete, async (tx) => {
      await tx.query(
        'UPDATE race_event SET revision=2,values_json=$3::jsonb WHERE athlete_id=$1 AND id=$2',
        [s.athlete, s.event.id, JSON.stringify({ ...s.body, localStartTime: '12:00' })],
      );
      await tx.query(
        'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,2,$3::jsonb,now())',
        [s.athlete, s.event.id, JSON.stringify({ ...s.body, localStartTime: '12:00' })],
      );
      expect((await captureRaceTimingPins(tx, heads(s.event.id, 2)))[0]?.eventRevision).toBe(2);
      throw new Error('SYNTHETIC_CALLER_ROLLBACK');
    }),
  ).rejects.toThrow('SYNTHETIC_CALLER_ROLLBACK');
  const persisted = await read(s.athlete, (tx) => captureRaceTimingPins(tx, heads(s.event.id)));
  expect(persisted[0]?.eventRevision).toBe(1);
});
it('real writer waits behind caller tenant0 capture then makes the old pin stale after commit', async () => {
  const s = await source(),
    captured = deferred(),
    release = deferred();
  const reader = read(s.athlete, async (tx) => {
    const pins = await captureRaceTimingPins(tx, heads(s.event.id));
    captured.release();
    await release.promise;
    return pins;
  });
  await captured.promise;
  const writer = races.updateRaceEvent(s.athlete, s.event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...s.body, localStartTime: '13:00' },
  });
  try {
    await waitForTenantWaiter();
  } finally {
    release.release();
  }
  const pins = await reader;
  await writer;
  await expect(read(s.athlete, (tx) => requireFreshRaceTimingPins(tx, pins))).rejects.toMatchObject(
    { code: 'RACE_TIMING_STALE' },
  );
});
