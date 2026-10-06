import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  RaceEventValues,
  RaceResultValues,
  RaceResultSourceInput,
  TrainingBestValues,
} from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createActivityRepository } from '../src/activities.js';
import { createOperationsRepository } from '../src/operations.js';
import { grantOperations, grantRaces, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `race_privacy_${suffix}`;
const ownerRole = `race_privacy_owner_${suffix}`;
const runtimeRole = `race_privacy_app_${suffix}`;
function urlFor(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${databaseName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
let owner: Pool;
let database: Database;
let races: RaceRepository;
async function tenant<T>(
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
  lockCommand = true,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    if (lockCommand)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
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
const tables = [
  'training_best',
  'training_best_revision',
  'race_result',
  'race_result_revision',
] as const;
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  await migrate(urlFor(ownerRole));
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantRaces(urlFor(ownerRole), runtimeRole);
  await owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON outbox,activity_canonical,activity_source_head,activity_source_revision,activity_suppression TO "${runtimeRole}"`,
  );
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 8 });
  races = createRaceRepository(database);
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
type Source = {
  athleteId: string;
  activityId: string;
  sourceId: string;
  eventId: string;
  occurredAt: string;
};
async function seedSource(
  athleteId: string = randomUUID(),
  activityId: string = randomUUID(),
): Promise<Source> {
  const sourceId = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2) ON CONFLICT(athlete_id) DO NOTHING",
    [athleteId, randomUUID()],
  );
  await tenant(athleteId, async (client) => {
    await client.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,\'{"title":"Synthetic source"}\'::jsonb)',
      [athleteId, activityId],
    );
    await client.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [athleteId, sourceId, 'a'.repeat(64), activityId],
    );
    await client.query(
      "INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw) VALUES($1,'fixture',$2,1,$3,'{}'::jsonb)",
      [athleteId, sourceId, 'a'.repeat(64)],
    );
  });
  return {
    athleteId,
    activityId,
    sourceId,
    eventId: randomUUID(),
    occurredAt: new Date(Date.now() - 1000).toISOString(),
  };
}
function eventValues(): RaceEventValues {
  return {
    title: 'Independent event',
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
function resultValues(
  activityId: string | null,
  source: RaceResultSourceInput,
  weatherNote = 'Independent result',
): RaceResultValues {
  return {
    kind: 'race-result',
    raceEventId: null,
    localDate: '2026-10-04',
    timezone: 'Asia/Seoul',
    source,
    chipSeconds: 0,
    gunSeconds: null,
    officialDistanceMeters: null,
    deviceDistanceMeters: 10042,
    linkedActivityId: activityId,
    weatherNote,
  };
}
function bestValues(activityId: string): TrainingBestValues {
  return {
    kind: 'training-best',
    observedAt: '2026-10-03T08:00:00+09:00',
    source: { kind: 'activity', activityId },
    basis: 'device-estimated-split',
    distanceMeters: 10000,
    elapsedSeconds: 2468,
  };
}
async function ledger(source: Source) {
  const bestInput = { idempotencyKey: randomUUID(), values: bestValues(source.activityId) };
  const deviceInput = {
    idempotencyKey: randomUUID(),
    values: resultValues(
      source.activityId,
      { kind: 'device', providerLabel: 'Synthetic watch' },
      'Derived private weather',
    ),
  };
  const best = await races.createTrainingBest(source.athleteId, bestInput);
  const device = await races.createRaceResult(source.athleteId, deviceInput);
  const manual = await races.createRaceResult(source.athleteId, {
    idempotencyKey: randomUUID(),
    values: resultValues(source.activityId, { kind: 'manual' }),
  });
  const officialInput = {
    idempotencyKey: randomUUID(),
    values: resultValues(source.activityId, {
      kind: 'official',
      authority: 'Synthetic authority',
      resultUrl: 'https://example.org/independent-result',
    }),
  };
  const official = await races.createRaceResult(source.athleteId, officialInput);
  const event = await races.createRaceEvent(source.athleteId, {
    idempotencyKey: randomUUID(),
    values: eventValues(),
  });
  return { best, bestInput, device, deviceInput, manual, official, officialInput, event };
}
async function exportedRaces(athleteId: string) {
  const exported = await createOperationsRepository(database).exportAccount(athleteId);
  const data = z.record(z.string(), z.array(z.record(z.string(), z.json()))).parse(exported.data);
  return Object.fromEntries(
    [
      'raceEvents',
      'raceEventRevisions',
      'raceResults',
      'raceResultRevisions',
      'trainingBests',
      'trainingBestRevisions',
    ].map((key) => [key, data[key]]),
  );
}
async function replay(source: Source): Promise<string> {
  return tenant(
    source.athleteId,
    async (client) => {
      const result = await client.query(
        "SELECT public.replay_activity_deletion_exact($1,$2,$3,$4,2,'fixture',$5,1,$6)",
        [
          source.athleteId,
          source.activityId,
          source.eventId,
          source.occurredAt,
          source.sourceId,
          'a'.repeat(64),
        ],
      );
      return z.string().parse(result.rows[0]?.['replay_activity_deletion_exact']);
    },
    false,
  );
}
async function privacyEvents(athleteId: string) {
  return database.tenant(athleteId, (tx) =>
    tx.query(
      "SELECT id,idempotency_key,payload FROM outbox WHERE topic='race.source_dependency_redacted' ORDER BY idempotency_key",
    ),
  );
}
async function freshness(athleteId: string) {
  return database.tenant(athleteId, (tx) =>
    tx.query(
      'SELECT kind,revision,privacy_generation::text AS "privacyGeneration" FROM race_collection_head ORDER BY kind',
    ),
  );
}
async function expectPurged(source: Source, records: Awaited<ReturnType<typeof ledger>>) {
  expect(await races.getTrainingBest(source.athleteId, records.best.id)).toBeNull();
  expect(await races.getRaceResult(source.athleteId, records.device.id)).toBeNull();
  for (const independent of [records.manual, records.official]) {
    expect(await races.getRaceResult(source.athleteId, independent.id)).toMatchObject({
      linkedActivityId: null,
      chipSeconds: 0,
      gunSeconds: null,
      deviceDistanceMeters: 10042,
      weatherNote: 'Independent result',
    });
  }
  expect(await races.getRaceEvent(source.athleteId, records.event.id)).toEqual({
    ...eventValues(),
    ...records.event,
  });
  const serialized = JSON.stringify(await exportedRaces(source.athleteId));
  expect(serialized).not.toContain(source.activityId);
  expect(serialized).not.toContain('Derived private weather');
  const history = await tenant(source.athleteId, (client) =>
    client.query(
      'SELECT (SELECT count(*)::int FROM training_best_revision WHERE entity_id=$1) AS best,(SELECT count(*)::int FROM race_result_revision WHERE entity_id=$2) AS device',
      [records.best.id, records.device.id],
    ),
  );
  expect(history.rows[0]).toEqual({ best: 0, device: 0 });
}

// M2-02c privacy / S16 / V2-F20. Seeded replay state is real PostgreSQL evidence,
// not evidence of a complete authenticated backup restore or an operational drill.
describe('race source deletion privacy', () => {
  it('ordinary Activity deletion purges derived actuals/history, unlinks independent results and preserves other tenants/entities', async () => {
    const source = await seedSource(),
      other = await seedSource(randomUUID(), source.activityId);
    const records = await ledger(source),
      otherRecords = await ledger(other);
    const unrelated = await seedSource(source.athleteId);
    const unrelatedBest = await races.createTrainingBest(source.athleteId, {
      idempotencyKey: randomUUID(),
      values: bestValues(unrelated.activityId),
    });
    await races.updateTrainingBest(source.athleteId, records.best.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...bestValues(source.activityId), elapsedSeconds: 2450 },
    });
    await races.updateRaceResult(source.athleteId, records.device.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...records.deviceInput.values, chipSeconds: 2400 },
    });
    const before = await freshness(source.athleteId);
    await createActivityRepository(database).deleteActivity(source.athleteId, source.activityId, {
      expectedRevision: 1,
    });
    await expectPurged(source, records);
    const after = await freshness(source.athleteId);
    expect(after.rows).not.toEqual(before.rows);
    expect(after.rows.find((row) => row['kind'] === 'training-best')?.['privacyGeneration']).toBe(
      '1',
    );
    expect(after.rows.find((row) => row['kind'] === 'race-result')?.['privacyGeneration']).toBe(
      '3',
    );
    const exported = await createOperationsRepository(database).exportAccount(source.athleteId);
    const exportData = z
      .record(z.string(), z.array(z.record(z.string(), z.json())))
      .parse(exported.data);
    expect(exportData['raceCollectionHeads']).toEqual(after.rows);
    expect(await races.getTrainingBest(source.athleteId, unrelatedBest.id)).toMatchObject(
      unrelatedBest,
    );
    expect(await races.getTrainingBest(other.athleteId, otherRecords.best.id)).toMatchObject(
      otherRecords.best,
    );
    expect(
      (await races.getRaceResult(other.athleteId, otherRecords.device.id))?.linkedActivityId,
    ).toBe(other.activityId);
    expect((await privacyEvents(source.athleteId)).rows).toHaveLength(4);
    expect((await privacyEvents(other.athleteId)).rows).toHaveLength(0);
    const manual = await races.getRaceResult(source.athleteId, records.manual.id);
    expect(manual?.revision).toBe(2);
    await expect(
      races.updateRaceResult(source.athleteId, records.manual.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        values: resultValues(null, { kind: 'manual' }),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await races.createTrainingBest(source.athleteId, records.bestInput)).toEqual(
      records.best,
    );
    expect(await races.createRaceResult(source.athleteId, records.deviceInput)).toEqual(
      records.device,
    );
    await expect(
      races.createTrainingBest(source.athleteId, {
        ...records.bestInput,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'RACE_REFERENCE_UNAVAILABLE' });
    await expectPurged(source, records);
    const events = await privacyEvents(source.athleteId);
    expect(JSON.stringify(events.rows)).not.toContain('Derived private weather');
    expect(JSON.stringify(events.rows)).not.toContain('https://');
    await createActivityRepository(database).deleteActivity(source.athleteId, source.activityId, {
      expectedRevision: 2,
    });
    expect((await privacyEvents(source.athleteId)).rows).toEqual(events.rows);
    expect((await freshness(source.athleteId)).rows).toEqual(after.rows);
  });

  it('purges source-bearing historical revisions while retaining current independent corrections', async () => {
    const source = await seedSource();
    const records = await ledger(source);
    const correctedBest = {
      ...bestValues(source.activityId),
      source: { kind: 'manual' as const },
      basis: 'user-entered' as const,
      elapsedSeconds: 2000,
    };
    await races.updateTrainingBest(source.athleteId, records.best.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: correctedBest,
    });
    const correctedResult = resultValues(null, { kind: 'manual' }, 'Independent corrected weather');
    await races.updateRaceResult(source.athleteId, records.device.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: correctedResult,
    });
    await createActivityRepository(database).deleteActivity(source.athleteId, source.activityId, {
      expectedRevision: 1,
    });
    expect(await races.getTrainingBest(source.athleteId, records.best.id)).toEqual({
      ...correctedBest,
      id: records.best.id,
      revision: 2,
    });
    expect(await races.getRaceResult(source.athleteId, records.device.id)).toEqual({
      ...correctedResult,
      id: records.device.id,
      revision: 2,
    });
    const serialized = JSON.stringify(await exportedRaces(source.athleteId));
    expect(serialized).not.toContain(source.activityId);
    expect(serialized).not.toContain('Derived private weather');
    expect(serialized).toContain('Independent corrected weather');
    const revisions = await tenant(source.athleteId, (client) =>
      client.query(
        'SELECT (SELECT count(*)::int FROM training_best_revision WHERE entity_id=$1) AS best,(SELECT count(*)::int FROM race_result_revision WHERE entity_id=$2) AS result',
        [records.best.id, records.device.id],
      ),
    );
    expect(revisions.rows[0]).toEqual({ best: 1, result: 1 });
  });

  it('owner-only exact deletion replay preserves supplied event ID/time and purges race dependencies exactly once', async () => {
    const source = await seedSource(),
      records = await ledger(source);
    expect(await replay(source)).toBe('deleted');
    await expectPurged(source, records);
    const first = await privacyEvents(source.athleteId);
    const firstFreshness = await freshness(source.athleteId);
    expect(first.rows).toHaveLength(4);
    expect(await replay(source)).toBe('already_applied');
    expect((await privacyEvents(source.athleteId)).rows).toEqual(first.rows);
    expect((await freshness(source.athleteId)).rows).toEqual(firstFreshness.rows);
    const event = await tenant(source.athleteId, (client) =>
      client.query(
        "SELECT event_id,occurred_at FROM restore_suppression_event WHERE kind='activity_deleted' AND target_id=$1",
        [source.activityId],
      ),
    );
    expect(event.rows).toEqual([
      { event_id: source.eventId, occurred_at: new Date(source.occurredAt) },
    ]);
    expect(await races.createTrainingBest(source.athleteId, records.bestInput)).toEqual(
      records.best,
    );
    expect(await races.getTrainingBest(source.athleteId, records.best.id)).toBeNull();
  });

  it('exact absent-source replay purges restored dependent rows without reconstructing activity health data', async () => {
    const source = await seedSource(),
      records = await ledger(source);
    await tenant(source.athleteId, async (client) => {
      await client.query('DELETE FROM activity_source_revision WHERE source_id=$1', [
        source.sourceId,
      ]);
      await client.query('DELETE FROM activity_source_head WHERE source_id=$1', [source.sourceId]);
      await client.query('DELETE FROM activity_canonical WHERE id=$1', [source.activityId]);
    });
    expect(await replay(source)).toBe('absent');
    await expectPurged(source, records);
    const restored = await tenant(source.athleteId, (client) =>
      client.query('SELECT deleted,original FROM activity_canonical WHERE id=$1', [
        source.activityId,
      ]),
    );
    expect(restored.rows[0]?.['deleted']).toBe(true);
    expect(JSON.stringify(restored.rows[0]?.['original'])).not.toContain('Synthetic source');
    expect(await replay(source)).toBe('already_applied');
    expect((await privacyEvents(source.athleteId)).rows).toHaveLength(4);
  });

  it('already-applied exact replay also purges stale race values from a partial restored state', async () => {
    const source = await seedSource(),
      records = await ledger(source);
    expect(await replay(source)).toBe('deleted');
    const first = await privacyEvents(source.athleteId);
    // The new guard rejects ordinary owner UPDATE resurrection as well. To retain
    // the historical partial-restore repair case, simulate pg_restore's data phase
    // before post-data triggers are installed, only in this disposable owner fixture.
    await expect(
      tenant(source.athleteId, (client) =>
        client.query(
          'UPDATE training_best SET deleted=false,revision=1,values_json=$2::jsonb WHERE id=$1',
          [records.best.id, JSON.stringify(records.bestInput.values)],
        ),
      ),
    ).rejects.toThrow('RACE_DELETED_REENTRY');
    await tenant(source.athleteId, async (client) => {
      await client.query(
        'ALTER TABLE public.training_best DISABLE TRIGGER race_head_deletion_guard',
      );
      await client.query(
        'UPDATE training_best SET deleted=false,revision=1,values_json=$2::jsonb WHERE id=$1',
        [records.best.id, JSON.stringify(records.bestInput.values)],
      );
      await client.query(
        'INSERT INTO training_best_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,clock_timestamp())',
        [source.athleteId, records.best.id, JSON.stringify(records.bestInput.values)],
      );
      await client.query(
        'ALTER TABLE public.training_best ENABLE TRIGGER race_head_deletion_guard',
      );
    });
    expect(await replay(source)).toBe('already_applied');
    expect(await races.getTrainingBest(source.athleteId, records.best.id)).toBeNull();
    expect((await privacyEvents(source.athleteId)).rows).toEqual(first.rows);
    expect(JSON.stringify(await exportedRaces(source.athleteId))).not.toContain(source.activityId);
  });

  it('privacy redaction succeeds at terminal record and collection revisions without fabricating same-revision history', async () => {
    const source = await seedSource(),
      records = await ledger(source);
    await tenant(source.athleteId, async (client) => {
      for (const table of ['training_best', 'race_result'])
        await client.query(`UPDATE ${table} SET revision=2147483647`);
      await client.query(
        "UPDATE race_collection_head SET revision=2147483647 WHERE kind IN ('training-best','race-result')",
      );
    });
    const before = await freshness(source.athleteId);
    await createActivityRepository(database).deleteActivity(source.athleteId, source.activityId, {
      expectedRevision: 1,
    });
    await expectPurged(source, records);
    const after = await freshness(source.athleteId);
    // Numeric heads are terminal, but the privacy-generation component changes.
    // Future race evidence/ETag consumers must compare this tuple and source liveness.
    expect(after.rows).not.toEqual(before.rows);
    expect(after.rows.find((row) => row['kind'] === 'training-best')?.['privacyGeneration']).toBe(
      '1',
    );
    expect(after.rows.find((row) => row['kind'] === 'race-result')?.['privacyGeneration']).toBe(
      '3',
    );
    const sourceState = await tenant(source.athleteId, (client) =>
      client.query('SELECT revision,deleted FROM activity_canonical WHERE id=$1', [
        source.activityId,
      ]),
    );
    expect(sourceState.rows).toEqual([{ revision: 2, deleted: true }]);
    await expect(
      database.tenant(source.athleteId, (tx) =>
        tx.query('UPDATE race_collection_head SET privacy_generation=0'),
      ),
    ).rejects.toThrow('RACE_COLLECTION_RESET_FORBIDDEN');
    const current = await tenant(source.athleteId, (client) =>
      client.query(
        'SELECT (SELECT revision FROM training_best WHERE id=$1) AS best,(SELECT revision FROM race_result WHERE id=$2) AS device,(SELECT count(*)::int FROM race_result_revision WHERE revision=2147483647) AS fabricated',
        [records.best.id, records.device.id],
      ),
    );
    expect(current.rows[0]).toEqual({ best: 2147483647, device: 2147483647, fabricated: 0 });
    expect((await races.getRaceResult(source.athleteId, records.manual.id))?.revision).toBe(
      2147483647,
    );
    const heads = await tenant(source.athleteId, (client) =>
      client.query(
        "SELECT revision FROM race_collection_head WHERE kind IN ('training-best','race-result')",
      ),
    );
    expect(heads.rows.every((row) => row['revision'] === 2147483647)).toBe(true);
    expect((await privacyEvents(source.athleteId)).rows).toHaveLength(4);
    expect(await races.createTrainingBest(source.athleteId, records.bestInput)).toEqual(
      records.best,
    );
    expect(await races.getTrainingBest(source.athleteId, records.best.id)).toBeNull();
    expect((await freshness(source.athleteId)).rows).toEqual(after.rows);
  });

  it('an outbox failure rolls back Activity tombstone, race redactions, history purge and collection changes', async () => {
    const source = await seedSource(),
      records = await ledger(source);
    const before = await freshness(source.athleteId);
    await owner.query(
      "CREATE FUNCTION public.race_privacy_test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVACY_OUTBOX_FAILURE'; END $$",
    );
    await owner.query(
      "CREATE TRIGGER race_privacy_test_fail_outbox BEFORE INSERT ON public.outbox FOR EACH ROW WHEN (NEW.topic='race.source_dependency_redacted') EXECUTE FUNCTION public.race_privacy_test_fail_outbox()",
    );
    try {
      await expect(
        createActivityRepository(database).deleteActivity(source.athleteId, source.activityId, {
          expectedRevision: 1,
        }),
      ).rejects.toThrow('PRIVACY_OUTBOX_FAILURE');
      expect(await races.getTrainingBest(source.athleteId, records.best.id)).toMatchObject({
        ...records.bestInput.values,
        ...records.best,
      });
      expect(
        (await races.getRaceResult(source.athleteId, records.manual.id))?.linkedActivityId,
      ).toBe(source.activityId);
      const raw = await tenant(source.athleteId, (client) =>
        client.query(
          'SELECT (SELECT deleted FROM activity_canonical WHERE id=$1) AS deleted,(SELECT count(*)::int FROM training_best_revision) AS best,(SELECT count(*)::int FROM race_result_revision) AS results,(SELECT count(*)::int FROM restore_suppression_event WHERE target_id=$1) AS suppression',
          [source.activityId],
        ),
      );
      expect(raw.rows[0]).toEqual({ deleted: false, best: 1, results: 3, suppression: 0 });
      expect((await privacyEvents(source.athleteId)).rows).toHaveLength(0);
      expect((await freshness(source.athleteId)).rows).toEqual(before.rows);
    } finally {
      await owner.query('DROP TRIGGER race_privacy_test_fail_outbox ON public.outbox');
      await owner.query('DROP FUNCTION public.race_privacy_test_fail_outbox()');
    }
    await createActivityRepository(database).deleteActivity(source.athleteId, source.activityId, {
      expectedRevision: 1,
    });
    await expectPurged(source, records);
  });

  it('serializes correction against source deletion and keeps every committed receipt non-resurrecting', async () => {
    const source = await seedSource(),
      records = await ledger(source);
    const update = {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...bestValues(source.activityId), elapsedSeconds: 2400 },
    };
    const result = await Promise.allSettled([
      races.updateTrainingBest(source.athleteId, records.best.id, update),
      createActivityRepository(database).deleteActivity(source.athleteId, source.activityId, {
        expectedRevision: 1,
      }),
    ]);
    expect(result[1]?.status).toBe('fulfilled');
    expect(await races.getTrainingBest(source.athleteId, records.best.id)).toBeNull();
    if (result[0]?.status === 'fulfilled')
      expect(await races.updateTrainingBest(source.athleteId, records.best.id, update)).toEqual(
        result[0].value,
      );
    expect(await races.createTrainingBest(source.athleteId, records.bestInput)).toEqual(
      records.best,
    );
    await expectPurged(source, records);
  });

  it('keeps source redaction helpers/replay private and foreign RLS mutations cannot trigger another tenant purge', async () => {
    const source = await seedSource(),
      other = await seedSource(),
      records = await ledger(source);
    await expect(
      database.tenant(other.athleteId, (tx) =>
        tx.query('SELECT public.redact_race_activity_dependencies($1,$2)', [
          source.athleteId,
          source.activityId,
        ]),
      ),
    ).rejects.toThrow();
    const update = await database.tenant(other.athleteId, (tx) =>
      tx.query('UPDATE activity_canonical SET deleted=true WHERE athlete_id=$1 AND id=$2', [
        source.athleteId,
        source.activityId,
      ]),
    );
    expect(update.rowCount).toBe(0);
    for (const table of tables) {
      const foreign = await database.tenant(other.athleteId, (tx) =>
        tx.query(`SELECT * FROM ${table}`),
      );
      expect(foreign.rows).toHaveLength(0);
    }
    expect(await races.getTrainingBest(source.athleteId, records.best.id)).toMatchObject(
      records.best,
    );
    expect((await privacyEvents(source.athleteId)).rows).toHaveLength(0);
  });

  it('preserves exact replay already_applied_by_erasure when account erasure removed the canonical source', async () => {
    const source = await seedSource(),
      records = await ledger(source);
    expect(await replay(source)).toBe('deleted');
    await tenant(
      source.athleteId,
      async (client) => {
        const erased = await client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
          source.athleteId,
          randomUUID(),
          new Date().toISOString(),
        ]);
        expect(erased.rows[0]?.['replay_tenant_erasure_exact']).toBe('erased');
      },
      false,
    );
    const before = await tenant(source.athleteId, (client) =>
      client.query('SELECT erased_at FROM tenant_erasure'),
    );
    expect(before.rows).toHaveLength(1);
    expect(await replay(source)).toBe('already_applied_by_erasure');
    expect(await replay(source)).toBe('already_applied_by_erasure');
    const after = await tenant(source.athleteId, (client) =>
      client.query('SELECT erased_at FROM tenant_erasure'),
    );
    expect(after.rows).toEqual(before.rows);
    await tenant(source.athleteId, async (client) => {
      for (const table of [
        'activity_canonical',
        'training_best',
        'training_best_revision',
        'race_result',
        'race_result_revision',
        'race_event',
        'race_event_revision',
        'race_command_receipt',
        'race_collection_head',
      ]) {
        const rows = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
        expect(rows.rows[0]?.['count']).toBe(0);
      }
    });
    await expect(races.createTrainingBest(source.athleteId, records.bestInput)).rejects.toThrow(
      'ACCOUNT_ERASED',
    );
    await expect(races.getTrainingBest(source.athleteId, records.best.id)).rejects.toThrow(
      'ACCOUNT_ERASED',
    );
  });
});
