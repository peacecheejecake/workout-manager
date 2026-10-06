import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type {
  RaceEventValues,
  RaceResultValues,
  TrainingBestValues,
} from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantRaces, grantOperations } from '../src/migrate.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createActivityRepository } from '../src/activities.js';
const adminUrl = z.string().parse(process.env['TEST_DATABASE_ADMIN_URL']);
const runtimeUrl = z.string().parse(process.env['TEST_DATABASE_URL']);
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let repository: RaceRepository;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantRaces(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON outbox,activity_canonical,activity_source_head,activity_source_revision,activity_suppression TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  repository = createRaceRepository(database);
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
function eventValues(): RaceEventValues {
  return {
    title: 'Synthetic race',
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
    source: {
      kind: 'official',
      authority: 'Synthetic authority',
      resultUrl: 'https://example.org/private-result',
    },
    chipSeconds: 0,
    gunSeconds: null,
    officialDistanceMeters: null,
    deviceDistanceMeters: 10042,
    linkedActivityId: null,
    weatherNote: 'Synthetic private note',
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

const kinds = ['race-event', 'race-result', 'training-best'] as const;
type Kind = (typeof kinds)[number];
function list(
  kind: Kind,
  athlete: string,
  input?: Parameters<RaceRepository['listRaceEvents']>[1],
) {
  if (kind === 'race-event') return repository.listRaceEvents(athlete, input);
  if (kind === 'race-result') return repository.listRaceResults(athlete, input);
  return repository.listTrainingBests(athlete, input);
}
async function create(kind: Kind, athlete: string) {
  const idempotencyKey = randomUUID();
  if (kind === 'race-event')
    return repository.createRaceEvent(athlete, { idempotencyKey, values: eventValues() });
  if (kind === 'race-result')
    return repository.createRaceResult(athlete, { idempotencyKey, values: resultValues() });
  return repository.createTrainingBest(athlete, { idempotencyKey, values: bestValues() });
}
const tables = [
  'race_event',
  'race_event_revision',
  'race_result',
  'race_result_revision',
  'training_best',
  'training_best_revision',
  'race_command_receipt',
  'race_collection_head',
  'outbox',
] as const;
async function snapshot(athlete: string) {
  return database.tenant(athlete, async (tx) => {
    const result: Record<string, unknown> = {};
    for (const table of tables)
      result[table] = (
        await tx.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t WHERE athlete_id=$1 ORDER BY to_jsonb(t)::text`,
          [athlete],
        )
      ).rows;
    return result;
  });
}
describe('race lists on real PostgreSQL', () => {
  it.each(kinds)(
    'paginates %s by UUID with same-timestamp rows and preserves typed partial values',
    async (kind) => {
      const athlete = randomUUID();
      const fixed = createRaceRepository(database, { now: () => new Date('2026-10-06T00:00:00Z') });
      for (let i = 0; i < 5; i++) {
        const idempotencyKey = randomUUID();
        if (kind === 'race-event')
          await fixed.createRaceEvent(athlete, { idempotencyKey, values: eventValues() });
        else if (kind === 'race-result')
          await fixed.createRaceResult(athlete, { idempotencyKey, values: resultValues() });
        else await fixed.createTrainingBest(athlete, { idempotencyKey, values: bestValues() });
      }
      const before = await snapshot(athlete);
      const complete = await list(kind, athlete);
      expect(complete.items).toHaveLength(5);
      expect(complete.nextCursor).toBeNull();
      const ids = complete.items.map((item) => item.id);
      expect(ids).toEqual([...ids].sort());
      const seen: string[] = [];
      let page = await list(kind, athlete, { limit: 2 });
      expect(page.items).toHaveLength(2);
      while (true) {
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) break;
        expect(page.nextCursor.collection).toEqual(page.collection);
        expect(page.nextCursor.afterId).toBe(page.items.at(-1)?.id);
        page = await list(kind, athlete, { limit: 2, cursor: page.nextCursor });
      }
      expect(page.items).toHaveLength(1);
      expect(seen).toEqual(ids);
      const last = await list(kind, athlete, {
        cursor: {
          kind,
          collection: z
            .object({ revision: z.number(), privacyGeneration: z.string() })
            .parse(complete.collection),
          afterId: z.string().parse(ids.at(-1)),
        },
      });
      expect(last.items).toEqual([]);
      expect(last.collection).toEqual(complete.collection);
      expect(await snapshot(athlete)).toEqual(before);
      if (kind === 'race-event')
        expect(complete.items[0]).toMatchObject({
          targetSeconds: 0,
          localStartTime: null,
          timezone: 'Asia/Seoul',
        });
      else if (kind === 'race-result')
        expect(complete.items[0]).toMatchObject({
          chipSeconds: 0,
          gunSeconds: null,
          source: { kind: 'official', verifiedAt: null },
        });
      else
        expect(complete.items[0]).toMatchObject({
          distanceMeters: null,
          elapsedSeconds: 0,
          observedAt: '2026-10-03T08:00:00+09:00',
        });
    },
  );
  it('accepts limit1 and limit100, defaults to50, and holds the command lock while reading the page stamp and rows', async () => {
    const athlete = randomUUID();
    for (let index = 0; index < 51; index++) await create('race-event', athlete);
    expect((await repository.listRaceEvents(athlete)).items).toHaveLength(50);
    expect((await repository.listRaceEvents(athlete, { limit: 1 })).items).toHaveLength(1);
    expect((await repository.listRaceEvents(athlete, { limit: 100 })).items).toHaveLength(51);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      const listing = repository.listRaceEvents(athlete, { limit: 1 });
      let waiting = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const wait = await client.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='workout_runtime' AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%') AS waiting",
        );
        if (wait.rows[0]?.['waiting'] === true) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      await client.query(
        "UPDATE race_event SET revision=revision+1,values_json=jsonb_set(values_json,'{title}','\"Atomic correction\"') WHERE athlete_id=$1",
        [athlete],
      );
      await client.query(
        'UPDATE race_collection_head SET revision=revision+1 WHERE athlete_id=$1',
        [athlete],
      );
      await client.query('COMMIT');
      const page = await listing;
      expect(page.collection).toEqual({ revision: 52, privacyGeneration: '0' });
      expect(page.items[0]).toMatchObject({ revision: 2, title: 'Atomic correction' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('returns absent heads without inventing collection state or writing anything', async () => {
    const athlete = randomUUID(),
      before = await snapshot(athlete);
    for (const kind of kinds)
      expect(await list(kind, athlete)).toEqual({
        schemaVersion: 1,
        kind,
        sort: 'id-asc',
        collection: null,
        items: [],
        nextCursor: null,
      });
    expect(await snapshot(athlete)).toEqual(before);
  });
  it('isolates two actual tenants with unfiltered RLS reads and rejects foreign, missing, wrong-kind and stale cursors', async () => {
    const first = randomUUID(),
      second = randomUUID();
    const a = await create('race-event', first),
      b = await create('race-event', second);
    const page = await repository.listRaceEvents(first),
      other = await repository.listRaceEvents(second);
    expect(page.items.map((item) => item.id)).toEqual([a.id]);
    expect(other.items.map((item) => item.id)).toEqual([b.id]);
    await database.tenant(first, async (tx) => {
      const rows = await tx.query('SELECT id FROM race_event');
      expect(rows.rows.map((row) => row['id'])).toEqual([a.id]);
    });
    for (const kind of ['race-result', 'training-best'] as const) {
      const own = await create(kind, first),
        foreign = await create(kind, second);
      const ownPage = await list(kind, first),
        foreignPage = await list(kind, second);
      expect(ownPage.items.map((item) => item.id)).toEqual([own.id]);
      expect(foreignPage.items.map((item) => item.id)).toEqual([foreign.id]);
      await database.tenant(first, async (tx) => {
        const rows = await tx.query(`SELECT id FROM ${kind.replaceAll('-', '_')}`);
        expect(rows.rows.map((row) => row['id'])).toEqual([own.id]);
      });
      await expect(
        list(kind, first, {
          cursor: {
            kind,
            collection: z
              .object({ revision: z.number(), privacyGeneration: z.string() })
              .parse(ownPage.collection),
            afterId: foreign.id,
          },
        }),
      ).rejects.toThrow('RACE_CURSOR_UNAVAILABLE');
    }
    const collection = z
      .object({ revision: z.number(), privacyGeneration: z.string() })
      .parse(page.collection);
    await expect(
      repository.listRaceEvents(first, {
        cursor: { kind: 'race-result', collection, afterId: a.id },
      }),
    ).rejects.toThrow('RACE_CURSOR_KIND_MISMATCH');
    await expect(
      repository.listRaceEvents(first, {
        cursor: { kind: 'race-event', collection, afterId: b.id },
      }),
    ).rejects.toThrow('RACE_CURSOR_UNAVAILABLE');
    await expect(
      repository.listRaceEvents(first, {
        cursor: { kind: 'race-event', collection, afterId: randomUUID() },
      }),
    ).rejects.toThrow('RACE_CURSOR_UNAVAILABLE');
    await expect(
      repository.listRaceEvents(randomUUID(), {
        cursor: { kind: 'race-event', collection, afterId: a.id },
      }),
    ).rejects.toThrow('RACE_CURSOR_STALE');
    await repository.updateRaceEvent(first, a.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...eventValues(), title: 'Correction' },
    });
    await expect(
      repository.listRaceEvents(first, {
        cursor: { kind: 'race-event', collection, afterId: a.id },
      }),
    ).rejects.toThrow('RACE_CURSOR_STALE');
  });
  it('validates request bounds and unknown keys before reading', async () => {
    const athlete = randomUUID(),
      before = await snapshot(athlete);
    for (const limit of [0, 101, 1.5])
      await expect(repository.listRaceEvents(athlete, { limit })).rejects.toThrow();
    await expect(
      repository.listRaceEvents(
        athlete,
        z.object({ limit: z.number(), unknown: z.boolean() }).parse({ limit: 2, unknown: true }),
      ),
    ).rejects.toThrow();
    expect(await snapshot(athlete)).toEqual(before);
  });
  it('rejects a terminal revision cursor after privacy generation changes, while lists never resurrect deleted derived values', async () => {
    const athlete = randomUUID(),
      activityId = randomUUID(),
      sourceId = randomUUID();
    await admin.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}')",
      [athlete, activityId],
    );
    await admin.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [athlete, sourceId, 'a'.repeat(64), activityId],
    );
    await admin.query(
      "INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw) VALUES($1,'fixture',$2,1,$3,'{}')",
      [athlete, sourceId, 'a'.repeat(64)],
    );
    const independent = await repository.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...resultValues(), linkedActivityId: activityId },
    });
    await repository.createTrainingBest(athlete, {
      idempotencyKey: randomUUID(),
      values: {
        ...bestValues(),
        source: { kind: 'activity', activityId },
        basis: 'whole-activity',
      },
    });
    await admin.query('UPDATE race_collection_head SET revision=2147483647 WHERE athlete_id=$1', [
      athlete,
    ]);
    await admin.query('UPDATE race_result SET revision=2147483647 WHERE athlete_id=$1', [athlete]);
    const old = await repository.listRaceResults(athlete);
    const oldBest = await repository.listTrainingBests(athlete);
    await createActivityRepository(database).deleteActivity(athlete, activityId, {
      expectedRevision: 1,
    });
    const current = await repository.listRaceResults(athlete),
      best = await repository.listTrainingBests(athlete);
    expect(current.collection).toEqual({ revision: 2147483647, privacyGeneration: '1' });
    expect(current.items).toHaveLength(1);
    expect(current.items[0]).toMatchObject({
      id: independent.id,
      revision: 2147483647,
      linkedActivityId: null,
      chipSeconds: 0,
    });
    expect(best.items).toEqual([]);
    expect(best.collection).toEqual({ revision: 2147483647, privacyGeneration: '1' });
    await expect(
      repository.listTrainingBests(athlete, {
        cursor: {
          kind: 'training-best',
          collection: { revision: 2147483647, privacyGeneration: '1' },
          afterId: z.string().parse(oldBest.items[0]?.id),
        },
      }),
    ).rejects.toThrow('RACE_CURSOR_UNAVAILABLE');
    await expect(
      repository.listRaceResults(athlete, {
        cursor: {
          kind: 'race-result',
          collection: z
            .object({ revision: z.number(), privacyGeneration: z.string() })
            .parse(old.collection),
          afterId: independent.id,
        },
      }),
    ).rejects.toThrow('RACE_CURSOR_STALE');
    await expect(
      repository.listTrainingBests(athlete, {
        cursor: {
          kind: 'training-best',
          collection: z
            .object({ revision: z.number(), privacyGeneration: z.string() })
            .parse(oldBest.collection),
          afterId: z.string().parse(oldBest.items[0]?.id),
        },
      }),
    ).rejects.toThrow('RACE_CURSOR_STALE');
    const before = await snapshot(athlete);
    await repository.listTrainingBests(athlete);
    expect(await snapshot(athlete)).toEqual(before);
  });
});
