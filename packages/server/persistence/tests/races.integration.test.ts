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
import { migrate, grantOperations, grantRaces, grantCourses } from '../src/migrate.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createOperationsRepository } from '../src/operations.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const fixtureOwner = new Pool({
  connectionString: z.string().parse(process.env['TEST_DATABASE_OWNER_URL']),
});
let database: Database;
let repository: RaceRepository;
const fixedTime = '2026-10-06T10:00:00.000Z';
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantRaces(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  repository = createRaceRepository(database, { now: () => new Date(fixedTime) });
});
afterAll(async () => {
  await database?.close();
  await fixtureOwner.end();
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
async function seedReferences(athleteId: string) {
  const activityId = randomUUID(),
    planId = randomUUID(),
    courseId = randomUUID(),
    revisionId = randomUUID();
  // Course head and immutable revision commit together under the same owned tenant scope.
  await owned(athleteId, async (client) => {
    await client.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [
        athleteId,
        activityId,
        JSON.stringify({
          title: 'Synthetic private activity',
          kind: 'running',
          startedAt: null,
          timezone: null,
          durationSeconds: null,
          durationKind: 'unknown',
          distanceMeters: 0,
        }),
      ],
    );
    await client.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
      [athleteId, planId, JSON.stringify({ fixture: 'Synthetic private plan' })],
    );
    const sourceId = randomUUID();
    await client.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [athleteId, sourceId, 'b'.repeat(64), activityId],
    );
    await client.query(
      "INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw) VALUES($1,'fixture',$2,1,$3,'{}'::jsonb)",
      [athleteId, sourceId, 'b'.repeat(64)],
    );
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,created_at,updated_at) VALUES($1,$2,'Synthetic course','private','available',1,$3,$4,$4)",
      [athleteId, courseId, revisionId, fixedTime],
    );
    await client.query(
      "INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,created_at) VALUES($1,$2,1,$3,'Synthetic course','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,2,10000,$4,$5)",
      [athleteId, courseId, revisionId, 'a'.repeat(64), fixedTime],
    );
  });
  return { activityId, planId, course: { courseId, courseRevision: 1, revisionId } };
}
const allTables = [
  'race_event',
  'race_event_revision',
  'race_result',
  'race_result_revision',
  'training_best',
  'training_best_revision',
  'race_command_receipt',
  'race_collection_head',
] as const;

// M2-02c / S15 S16 / V2-F20: real PostgreSQL transactions, not repository mocks.
describe('race ledger transactions', () => {
  it('creates all three ledgers with same-tenant references, preserving null, zero and local/offset values', async () => {
    const athlete = randomUUID(),
      refs = await seedReferences(athlete);
    await grantApp(athlete);
    const event = await repository.createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...eventValues(), course: refs.course, planVersionId: refs.planId },
    });
    const result = await repository.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...resultValues(), raceEventId: event.id, linkedActivityId: refs.activityId },
    });
    const best = await repository.createTrainingBest(athlete, {
      idempotencyKey: randomUUID(),
      values: {
        ...bestValues(),
        source: { kind: 'activity', activityId: refs.activityId },
        basis: 'device-estimated-split',
      },
    });
    expect(await repository.getRaceEvent(athlete, event.id)).toEqual({
      ...eventValues(),
      course: refs.course,
      planVersionId: refs.planId,
      ...event,
    });
    expect(await repository.getRaceResult(athlete, result.id)).toEqual({
      ...resultValues(),
      raceEventId: event.id,
      linkedActivityId: refs.activityId,
      source: { ...resultValues().source, verifiedAt: null },
      ...result,
    });
    expect(await repository.getTrainingBest(athlete, best.id)).toMatchObject({
      ...bestValues(),
      source: { kind: 'activity', activityId: refs.activityId },
      basis: 'device-estimated-split',
      ...best,
    });
    const row = await database.tenant(athlete, (tx) =>
      tx.query('SELECT recorded_at,updated_at FROM race_event'),
    );
    expect(row.rows[0]?.['recorded_at']).toEqual(new Date(fixedTime));
    expect(row.rows[0]?.['updated_at']).toEqual(new Date(fixedTime));
  });

  it('serializes concurrent duplicate creates and preserves the original minimal receipt after edits', async () => {
    const athlete = randomUUID(),
      input = { idempotencyKey: randomUUID(), values: resultValues() };
    await grantApp(athlete);
    const [one, two] = await Promise.all([
      repository.createRaceResult(athlete, input),
      repository.createRaceResult(athlete, input),
    ]);
    expect(one).toEqual(two);
    const update = {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...resultValues(), chipSeconds: 2500 },
    };
    const revised = await repository.updateRaceResult(athlete, one.id, update);
    await repository.updateRaceResult(athlete, one.id, {
      ...update,
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
      values: { ...update.values, chipSeconds: 2400 },
    });
    expect(await repository.createRaceResult(athlete, input)).toEqual(one);
    expect(await repository.updateRaceResult(athlete, one.id, update)).toEqual(revised);
    expect((await repository.getRaceResult(athlete, one.id))?.chipSeconds).toBe(2400);
    const rows = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM race_result_revision) AS history,(SELECT count(*)::int FROM outbox) AS events,(SELECT jsonb_agg(result) FROM race_command_receipt) AS receipts',
      ),
    );
    expect(rows.rows[0]).toMatchObject({ history: 3, events: 3 });
    expect(JSON.stringify(rows.rows[0]?.['receipts'])).not.toContain('Synthetic private note');
    expect(JSON.stringify(rows.rows[0]?.['receipts'])).not.toContain('private-result');
    for (const command of [
      () =>
        repository.createRaceResult(athlete, {
          ...input,
          values: { ...input.values, chipSeconds: 1 },
        }),
      () =>
        repository.createRaceEvent(athlete, {
          idempotencyKey: input.idempotencyKey,
          values: eventValues(),
        }),
      () =>
        repository.updateRaceResult(athlete, one.id, {
          ...update,
          idempotencyKey: input.idempotencyKey,
        }),
      () => repository.updateRaceResult(athlete, randomUUID(), update),
    ]) {
      await expect(command()).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
  });

  it('competing updates commit one revision and atomically reject the stale peer for every ledger', async () => {
    const athlete = randomUUID();
    await grantApp(athlete);
    const event = await repository.createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: eventValues(),
    });
    const result = await repository.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: resultValues(),
    });
    const best = await repository.createTrainingBest(athlete, {
      idempotencyKey: randomUUID(),
      values: bestValues(),
    });
    const updates = [
      () =>
        repository.updateRaceEvent(athlete, event.id, {
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
          values: { ...eventValues(), title: 'Updated' },
        }),
      () =>
        repository.updateRaceResult(athlete, result.id, {
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
          values: { ...resultValues(), chipSeconds: 2400 },
        }),
      () =>
        repository.updateTrainingBest(athlete, best.id, {
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
          values: { ...bestValues(), elapsedSeconds: 2400 },
        }),
    ];
    for (const update of updates) {
      const results = await Promise.allSettled([update(), update()]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((x) => x.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason).toMatchObject({
        code: 'REVISION_CONFLICT',
      });
    }
    for (const table of ['race_event', 'race_result', 'training_best']) {
      const rows = await database.tenant(athlete, (tx) =>
        tx.query(
          `SELECT (SELECT revision FROM ${table}) AS revision,(SELECT count(*)::int FROM ${table}_revision) AS history`,
        ),
      );
      expect(rows.rows[0]).toEqual({ revision: 2, history: 2 });
    }
    const counts = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM race_command_receipt) AS receipts,(SELECT count(*)::int FROM outbox) AS events',
      ),
    );
    expect(counts.rows[0]).toEqual({ receipts: 6, events: 6 });
  });

  it('rejects missing/foreign/deleted references and never upgrades a pinned Course revision', async () => {
    const owner = randomUUID(),
      other = randomUUID(),
      refs = await seedReferences(owner),
      foreign = await seedReferences(other);
    await grantApp(owner);
    await grantApp(other);
    const foreignEvent = await repository.createRaceEvent(other, {
      idempotencyKey: randomUUID(),
      values: eventValues(),
    });
    const missing = randomUUID();
    for (const values of [
      { ...eventValues(), planVersionId: foreign.planId },
      { ...eventValues(), planVersionId: missing },
      { ...eventValues(), course: foreign.course },
      { ...eventValues(), course: { ...refs.course, courseRevision: 2 } },
      { ...eventValues(), course: { ...refs.course, revisionId: missing } },
    ]) {
      await expect(
        repository.createRaceEvent(owner, { idempotencyKey: randomUUID(), values }),
      ).rejects.toMatchObject({ code: 'RACE_REFERENCE_UNAVAILABLE' });
    }
    for (const values of [
      { ...resultValues(), raceEventId: foreignEvent.id },
      { ...resultValues(), raceEventId: missing },
      { ...resultValues(), linkedActivityId: foreign.activityId },
      { ...resultValues(), linkedActivityId: missing },
    ]) {
      await expect(
        repository.createRaceResult(owner, { idempotencyKey: randomUUID(), values }),
      ).rejects.toMatchObject({ code: 'RACE_REFERENCE_UNAVAILABLE' });
    }
    await expect(
      repository.createTrainingBest(owner, {
        idempotencyKey: randomUUID(),
        values: { ...bestValues(), source: { kind: 'activity', activityId: foreign.activityId } },
      }),
    ).rejects.toMatchObject({ code: 'RACE_REFERENCE_UNAVAILABLE' });
    await database.tenant(owner, (tx) =>
      tx.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [owner, refs.activityId],
      ),
    );
    await expect(
      repository.createTrainingBest(owner, {
        idempotencyKey: randomUUID(),
        values: { ...bestValues(), source: { kind: 'activity', activityId: refs.activityId } },
      }),
    ).rejects.toMatchObject({ code: 'RACE_REFERENCE_UNAVAILABLE' });
    const rows = await database.tenant(owner, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM race_command_receipt) AS receipts,(SELECT count(*)::int FROM outbox) AS events',
      ),
    );
    expect(rows.rows[0]).toEqual({ receipts: 0, events: 0 });
  });

  it('retains identifier-only historical references without recreating deleted Course/private activity content', async () => {
    const athlete = randomUUID(),
      refs = await seedReferences(athlete);
    await grantApp(athlete);
    const input = {
      idempotencyKey: randomUUID(),
      values: { ...eventValues(), course: refs.course },
    };
    const event = await repository.createRaceEvent(athlete, input);
    const result = await repository.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...resultValues(), linkedActivityId: refs.activityId },
    });
    await database.tenant(athlete, (tx) =>
      tx.query('SELECT public.delete_course($1,1)', [refs.course.courseId]),
    );
    await database.tenant(athlete, (tx) =>
      tx.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [athlete, refs.activityId],
      ),
    );
    expect(await repository.createRaceEvent(athlete, input)).toEqual(event);
    expect((await repository.getRaceEvent(athlete, event.id))?.course).toEqual(refs.course);
    expect((await repository.getRaceResult(athlete, result.id))?.linkedActivityId).toBeNull();
    await expect(
      repository.updateRaceEvent(athlete, event.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        values: input.values,
      }),
    ).rejects.toMatchObject({ code: 'RACE_REFERENCE_UNAVAILABLE' });
    const content = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM course_revision) AS courses,(SELECT deleted FROM activity_canonical) AS deleted',
      ),
    );
    expect(content.rows[0]).toEqual({ courses: 0, deleted: true });
    expect(JSON.stringify(await repository.getRaceEvent(athlete, event.id))).not.toContain(
      'geometry',
    );
  });

  it('rejects old/new linked Plan date changes, including unlink attempts, with no Plan writes', async () => {
    const athlete = randomUUID(),
      refs = await seedReferences(athlete);
    await grantApp(athlete);
    const linked = await repository.createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: { ...eventValues(), planVersionId: refs.planId },
    });
    const unlinked = await repository.createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: eventValues(),
    });
    for (const planVersionId of [refs.planId, null]) {
      await expect(
        repository.updateRaceEvent(athlete, linked.id, {
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
          values: { ...eventValues(), localDate: '2026-10-11', planVersionId },
        }),
      ).rejects.toMatchObject({ code: 'RACE_PLAN_IMPACT_REQUIRED' });
    }
    await expect(
      repository.updateRaceEvent(athlete, unlinked.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        values: { ...eventValues(), localDate: '2026-10-11', planVersionId: refs.planId },
      }),
    ).rejects.toMatchObject({ code: 'RACE_PLAN_IMPACT_REQUIRED' });
    await repository.updateRaceEvent(athlete, unlinked.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...eventValues(), localDate: '2026-10-11' },
    });
    const plan = await admin.query('SELECT version,draft FROM plan_snapshot WHERE athlete_id=$1', [
      athlete,
    ]);
    expect(plan.rows).toEqual([{ version: 1, draft: { fixture: 'Synthetic private plan' } }]);
    expect((await repository.getRaceEvent(athlete, linked.id))?.revision).toBe(1);
  });

  it('rejects client verification and invalidates a trusted pre-existing official review on correction', async () => {
    const athlete = randomUUID();
    await grantApp(athlete);
    const invalid = {
      idempotencyKey: randomUUID(),
      values: { ...resultValues(), source: { ...resultValues().source, verifiedAt: fixedTime } },
    };
    await expect(repository.createRaceResult(athlete, invalid)).rejects.toThrow();
    const result = await repository.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: resultValues(),
    });
    // A privileged fixture stands in for a future reviewed verification use case.
    await admin.query(
      "WITH tenant_context AS (SELECT set_config('app.athlete_id',$1,true)) UPDATE race_result SET values_json=jsonb_set(values_json,'{source,verifiedAt}',to_jsonb($3::text)) FROM tenant_context WHERE athlete_id=$1 AND id=$2",
      [athlete, result.id, fixedTime],
    );
    expect((await repository.getRaceResult(athlete, result.id))?.source).toMatchObject({
      kind: 'official',
      verifiedAt: fixedTime,
    });
    await repository.updateRaceResult(athlete, result.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...resultValues(), chipSeconds: 2400 },
    });
    expect((await repository.getRaceResult(athlete, result.id))?.source).toMatchObject({
      kind: 'official',
      verifiedAt: null,
    });
    await repository.updateRaceResult(athlete, result.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
      values: { ...resultValues(), source: { kind: 'device', providerLabel: 'Synthetic watch' } },
    });
    expect((await repository.getRaceResult(athlete, result.id))?.source).toEqual({
      kind: 'device',
      providerLabel: 'Synthetic watch',
    });
  });

  it('enforces two-tenant RLS for direct unfiltered reads and cross-tenant mutation', async () => {
    const owner = randomUUID(),
      other = randomUUID();
    await grantApp(owner);
    await grantApp(other);
    const event = await repository.createRaceEvent(owner, {
      idempotencyKey: randomUUID(),
      values: eventValues(),
    });
    const result = await repository.createRaceResult(owner, {
      idempotencyKey: randomUUID(),
      values: resultValues(),
    });
    const best = await repository.createTrainingBest(owner, {
      idempotencyKey: randomUUID(),
      values: bestValues(),
    });
    await repository.createRaceEvent(other, {
      idempotencyKey: randomUUID(),
      values: eventValues(),
    });
    await repository.createRaceResult(other, {
      idempotencyKey: randomUUID(),
      values: resultValues(),
    });
    await repository.createTrainingBest(other, {
      idempotencyKey: randomUUID(),
      values: bestValues(),
    });
    expect(await repository.getRaceEvent(other, event.id)).toBeNull();
    expect(await repository.getRaceResult(other, result.id)).toBeNull();
    expect(await repository.getTrainingBest(other, best.id)).toBeNull();
    await expect(
      repository.updateRaceEvent(other, event.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        values: eventValues(),
      }),
    ).rejects.toMatchObject({ code: 'RACE_NOT_FOUND' });
    await expect(
      repository.updateRaceResult(other, result.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        values: resultValues(),
      }),
    ).rejects.toMatchObject({ code: 'RACE_NOT_FOUND' });
    await expect(
      repository.updateTrainingBest(other, best.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        values: bestValues(),
      }),
    ).rejects.toMatchObject({ code: 'RACE_NOT_FOUND' });
    for (const tenant of [owner, other]) {
      for (const table of allTables) {
        const rows = await database.tenant(tenant, (tx) =>
          tx.query(`SELECT athlete_id FROM ${table}`),
        );
        expect(rows.rows).toHaveLength(
          table === 'race_command_receipt' || table === 'race_collection_head' ? 3 : 1,
        );
        expect(rows.rows.every((row) => row['athlete_id'] === tenant)).toBe(true);
      }
    }
    await expect(
      database.tenant(other, (tx) =>
        tx.query(
          "INSERT INTO race_collection_head(athlete_id,kind,revision) VALUES($1,'race-event',1)",
          [owner],
        ),
      ),
    ).rejects.toThrow();
  });

  it('rolls back ledger, history, collection head and receipt on real transaction outbox failure', async () => {
    const athlete = randomUUID();
    await grantApp(athlete);
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, args) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('injected outbox failure');
              return tx.query(sql, args);
            },
          }),
        ),
    };
    const failing = createRaceRepository(broken);
    await expect(
      failing.createRaceEvent(athlete, { idempotencyKey: randomUUID(), values: eventValues() }),
    ).rejects.toThrow('injected outbox failure');
    await expect(
      failing.createRaceResult(athlete, { idempotencyKey: randomUUID(), values: resultValues() }),
    ).rejects.toThrow('injected outbox failure');
    await expect(
      failing.createTrainingBest(athlete, { idempotencyKey: randomUUID(), values: bestValues() }),
    ).rejects.toThrow('injected outbox failure');
    for (const table of [...allTables, 'outbox']) {
      const rows = await database.tenant(athlete, (tx) =>
        tx.query(`SELECT count(*)::int AS count FROM ${table}`),
      );
      expect(rows.rows[0]?.['count']).toBe(0);
    }
  });

  it('exports tenant-owned current/history ledgers and erases all race data before blocking replay', async () => {
    const athlete = randomUUID(),
      other = randomUUID(),
      input = { idempotencyKey: randomUUID(), values: eventValues() };
    await grantApp(athlete);
    await grantApp(other);
    const event = await repository.createRaceEvent(athlete, input);
    await repository.updateRaceEvent(athlete, event.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...eventValues(), title: 'Edited race' },
    });
    await repository.createRaceResult(athlete, {
      idempotencyKey: randomUUID(),
      values: resultValues(),
    });
    await repository.createTrainingBest(athlete, {
      idempotencyKey: randomUUID(),
      values: bestValues(),
    });
    await repository.createRaceEvent(other, {
      idempotencyKey: randomUUID(),
      values: { ...eventValues(), title: 'Foreign title' },
    });
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    const data = z.record(z.string(), z.array(z.record(z.string(), z.json()))).parse(exported.data);
    expect(data['raceEvents']).toHaveLength(1);
    expect(data['raceEventRevisions']).toHaveLength(2);
    expect(data['raceResults']).toHaveLength(1);
    expect(data['raceResultRevisions']).toHaveLength(1);
    expect(data['trainingBests']).toHaveLength(1);
    expect(data['trainingBestRevisions']).toHaveLength(1);
    expect(data['raceCollectionHeads']).toHaveLength(3);
    expect(JSON.stringify(exported)).not.toContain('Foreign title');
    expect(JSON.stringify(exported)).not.toContain(input.idempotencyKey);
    await database.exclusiveTenant(athlete, (tx) =>
      tx.query('SELECT public.erase_account($1)', [athlete]),
    );
    for (const table of allTables) {
      const rows = await admin.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`,
        [athlete],
      );
      expect(rows.rows[0]?.['count']).toBe(0);
    }
    await expect(repository.createRaceEvent(athlete, input)).rejects.toThrow('ACCOUNT_ERASED');
    const otherExport = await createOperationsRepository(database).exportAccount(other);
    expect(z.record(z.string(), z.unknown()).parse(otherExport.data)['raceEvents']).toHaveLength(1);
  });

  it('rolls back a correction of an existing ledger and refuses exhausted head or entity revisions', async () => {
    const athlete = randomUUID();
    await grantApp(athlete);
    const original = await repository.createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: eventValues(),
    });
    const correction = {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { ...eventValues(), title: 'Failed correction' },
    };
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, args) => {
              if (sql.includes('INSERT INTO outbox'))
                throw new Error('injected correction failure');
              return tx.query(sql, args);
            },
          }),
        ),
    };
    await expect(
      createRaceRepository(broken).updateRaceEvent(athlete, original.id, correction),
    ).rejects.toThrow('injected correction failure');
    expect(await repository.getRaceEvent(athlete, original.id)).toEqual({
      ...eventValues(),
      ...original,
    });
    const counts = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM race_event_revision) AS history,(SELECT count(*)::int FROM race_command_receipt) AS receipts,(SELECT revision FROM race_collection_head) AS head',
      ),
    );
    expect(counts.rows[0]).toEqual({ history: 1, receipts: 1, head: 1 });
    // Same request succeeds after the failed transaction; no failed receipt was retained.
    await expect(repository.updateRaceEvent(athlete, original.id, correction)).resolves.toEqual({
      id: original.id,
      revision: 2,
    });
    await admin.query('UPDATE race_collection_head SET revision=2147483646 WHERE athlete_id=$1', [
      athlete,
    ]);
    await admin.query(
      "WITH tenant_context AS (SELECT set_config('app.athlete_id',$1,true)) UPDATE race_event SET revision=2147483646 FROM tenant_context WHERE athlete_id=$1",
      [athlete],
    );
    const finalInput = {
      idempotencyKey: randomUUID(),
      expectedRevision: 2147483646,
      values: eventValues(),
    };
    const finalResult = await repository.updateRaceEvent(athlete, original.id, finalInput);
    expect(finalResult).toEqual({ id: original.id, revision: 2147483647 });
    expect((await repository.getRaceEvent(athlete, original.id))?.revision).toBe(2147483647);
    expect(await repository.updateRaceEvent(athlete, original.id, finalInput)).toEqual(finalResult);
    await expect(
      repository.createRaceEvent(athlete, { idempotencyKey: randomUUID(), values: eventValues() }),
    ).rejects.toMatchObject({ code: 'RACE_REVISION_LIMIT' });
    await expect(
      repository.updateRaceEvent(athlete, original.id, {
        ...finalInput,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const after = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM race_event_revision) AS history,(SELECT count(*)::int FROM race_command_receipt) AS receipts,(SELECT revision FROM race_collection_head) AS head',
      ),
    );
    expect(after.rows[0]).toEqual({ history: 3, receipts: 3, head: 2147483647 });
  });

  it('owner-only exact erasure replay removes seeded race rows and retains the original tombstone', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const databaseName = `race_restore_${suffix}`;
    const ownerRole = `race_owner_${suffix}`;
    const ownerUrl = new URL(z.string().parse(adminUrl));
    ownerUrl.pathname = `/${databaseName}`;
    ownerUrl.username = ownerRole;
    ownerUrl.password = 'isolated';
    const appUrl = new URL(z.string().parse(runtimeUrl));
    appUrl.pathname = `/${databaseName}`;
    await admin.query(
      `CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    let createdDatabase = false;
    let restored: Database | undefined;
    let owner: Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
      createdDatabase = true;
      await migrate(ownerUrl.toString());
      await grantOperations(ownerUrl.toString(), 'workout_runtime');
      await grantRaces(ownerUrl.toString(), 'workout_runtime');
      owner = new Pool({ connectionString: ownerUrl.toString() });
      await owner.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
      await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO workout_runtime');
      restored = createDatabase({ connectionString: appUrl.toString() });
      const races = createRaceRepository(restored);
      const athlete = randomUUID();
      await grantApp(athlete, owner);
      const input = { idempotencyKey: randomUUID(), values: eventValues() };
      const initial = await races.createRaceEvent(athlete, input);
      await races.createRaceResult(athlete, {
        idempotencyKey: randomUUID(),
        values: resultValues(),
      });
      await races.createTrainingBest(athlete, {
        idempotencyKey: randomUUID(),
        values: bestValues(),
      });
      const eventId = randomUUID();
      const occurredAt = new Date(Date.now() - 1000).toISOString();
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
        const first = await client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
          athlete,
          eventId,
          occurredAt,
        ]);
        expect(first.rows[0]?.['replay_tenant_erasure_exact']).toBe('erased');
        for (const table of allTables) {
          const rows = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
          expect(rows.rows[0]?.['count']).toBe(0);
        }
        const second = await client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
          athlete,
          eventId,
          occurredAt,
        ]);
        expect(second.rows[0]?.['replay_tenant_erasure_exact']).toBe('already_applied');
        const tombstone = await client.query(
          "SELECT e.erased_at,s.event_id,s.occurred_at FROM tenant_erasure e JOIN restore_suppression_event s USING(athlete_id) WHERE s.kind='tenant_erased'",
        );
        expect(tombstone.rows).toEqual([
          { erased_at: new Date(occurredAt), event_id: eventId, occurred_at: new Date(occurredAt) },
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      await expect(races.getRaceEvent(athlete, initial.id)).rejects.toThrow('ACCOUNT_ERASED');
      await expect(races.createRaceEvent(athlete, input)).rejects.toThrow('ACCOUNT_ERASED');
    } finally {
      await restored?.close();
      await owner?.end();
      if (createdDatabase) await dropIsolatedDatabase(admin, databaseName);
      await admin.query(`DROP ROLE "${ownerRole}"`);
    }
  });
});

/** Explicit synthetic athlete permission for tests creating core plan/actual records. */
async function grantApp(athlete: string, pool: Pool = admin) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) SELECT $1,'app',true,1 WHERE NOT EXISTS(SELECT 1 FROM tenant_erasure WHERE athlete_id=$1) AND NOT EXISTS(SELECT 1 FROM consent WHERE athlete_id=$1 AND kind='app') ON CONFLICT DO NOTHING",
      [athlete],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Plain schema owner seeds only the named synthetic tenant; FORCE RLS stays enabled. */
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await fixtureOwner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
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
