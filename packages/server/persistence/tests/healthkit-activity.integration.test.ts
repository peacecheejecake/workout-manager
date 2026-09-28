import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthKitIngestionBatch } from '@workout/contracts/healthkit-ingestion';
import { createActivityRepository } from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitActivityRepository } from '../src/healthkit-activity.js';
import { createHealthKitBindingRepository } from '../src/healthkit-binding.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { grantHealthKitIngestion, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');

const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantHealthKitIngestion(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON command_receipt,outbox TO workout_runtime');
  await admin.query('GRANT UPDATE(idempotency_key) ON outbox TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

async function ownerTenant<T>(
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
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

async function grantConsent(athleteId: string) {
  await ownerTenant(athleteId, (client) =>
    client.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athleteId],
    ),
  );
}

function workout(sampleId = randomUUID(), activityType = 37): HealthKitIngestionBatch {
  return {
    schemaVersion: 1,
    installationId: randomUUID(),
    batchId: randomUUID(),
    events: [
      {
        kind: 'upsert',
        sampleId,
        sourceBundleId: 'com.apple.health',
        sourceVersion: null,
        activityType,
        observedFrom: '2026-09-20T06:00:00+09:00',
        observedTo: '2026-09-20T06:35:00+09:00',
        durationSeconds: 2100,
        distanceMeters: 5000,
        energyKilocalories: null,
      },
    ],
  };
}

async function prepared(athleteId = randomUUID(), activityType = 37) {
  await grantConsent(athleteId);
  const batch = workout(randomUUID(), activityType);
  await createHealthKitIngestionRepository(database).ingestBatch(athleteId, batch, 1);
  const sampleId = batch.events[0]?.sampleId;
  if (!sampleId) throw new Error('Expected workout fixture');
  const digest = await database.tenant(athleteId, (tx) =>
    tx.query('SELECT payload_digest FROM healthkit_workout_sample WHERE sample_id=$1', [sampleId]),
  );
  const expectedSampleDigest = String(digest.rows[0]?.['payload_digest']);
  return { athleteId, batch, sampleId, expectedSampleDigest };
}

function command(input: Awaited<ReturnType<typeof prepared>>, idempotencyKey = randomUUID()) {
  return {
    sampleId: input.sampleId,
    expectedSampleDigest: input.expectedSampleDigest,
    confirmed: true as const,
    idempotencyKey,
  };
}

describe('M3-02i explicit HealthKit-primary Activity', () => {
  it('creates one canonical Activity from verified values with no inferred local data', async () => {
    const fixture = await prepared();
    const created = await createHealthKitActivityRepository(database).createActivity(
      fixture.athleteId,
      command(fixture),
    );
    expect(created).toEqual({
      sampleId: fixture.sampleId,
      activityId: expect.any(String),
      activityRevision: 1,
      state: 'created_activity',
    });
    const activity = await createActivityRepository(database).getActivity(
      fixture.athleteId,
      created.activityId,
    );
    expect(activity).toMatchObject({
      source: { kind: 'healthkit', sourceId: fixture.sampleId, revision: 1 },
      original: {
        title: null,
        kind: 'running',
        startedAt: expect.any(String),
        durationSeconds: 2100,
        durationKind: 'unknown',
        timezone: null,
        distanceMeters: 5000,
      },
    });
    if (!activity?.original.startedAt) throw new Error('Expected observed workout start');
    expect(Date.parse(activity.original.startedAt)).toBe(Date.parse('2026-09-20T06:00:00+09:00'));
    const state = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT
         (SELECT count(*)::int FROM activity_canonical WHERE NOT deleted) AS activities,
         (SELECT count(*)::int FROM activity_source_head WHERE kind='healthkit') AS heads,
         (SELECT state FROM healthkit_workout_lineage WHERE sample_id=$1) AS lineage`,
        [fixture.sampleId],
      ),
    );
    expect(state.rows[0]).toEqual({ activities: 1, heads: 1, lineage: 'created_activity' });
    expect((await createActivityRepository(database).summary(fixture.athleteId)).count).toBe(1);
  });

  it('replays one command and serializes competing creation/binding choices', async () => {
    const fixture = await prepared();
    const repo = createHealthKitActivityRepository(database);
    const choice = command(fixture);
    const [first, replay] = await Promise.all([
      repo.createActivity(fixture.athleteId, choice),
      repo.createActivity(fixture.athleteId, choice),
    ]);
    expect(replay).toEqual(first);
    await expect(
      repo.createActivity(fixture.athleteId, { ...choice, expectedSampleDigest: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      repo.createActivity(fixture.athleteId, { ...choice, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'ALREADY_LINKED' });
    expect((await createActivityRepository(database).summary(fixture.athleteId)).count).toBe(1);

    const second = await prepared();
    const contenders = await Promise.allSettled([
      repo.createActivity(second.athleteId, command(second)),
      repo.createActivity(second.athleteId, command(second)),
    ]);
    expect(contenders.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const loser = contenders.find((item) => item.status === 'rejected');
    if (loser?.status !== 'rejected') throw new Error('Expected one rejected decision');
    expect(loser.reason).toMatchObject({ code: 'ALREADY_LINKED' });
  });

  it('rejects stale, foreign, suppressed and already-bound samples', async () => {
    const fixture = await prepared();
    const repo = createHealthKitActivityRepository(database);
    await expect(repo.createActivity(randomUUID(), command(fixture))).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    await expect(
      repo.createActivity(fixture.athleteId, {
        ...command(fixture),
        sampleId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'SAMPLE_NOT_FOUND' });
    await expect(
      repo.createActivity(fixture.athleteId, {
        ...command(fixture),
        expectedSampleDigest: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_CONFLICT' });
    await ownerTenant(fixture.athleteId, (client) =>
      client.query(
        "UPDATE healthkit_workout_lineage SET state='suppressed' WHERE athlete_id=$1 AND sample_id=$2",
        [fixture.athleteId, fixture.sampleId],
      ),
    );
    await expect(repo.createActivity(fixture.athleteId, command(fixture))).rejects.toMatchObject({
      code: 'SAMPLE_UNAVAILABLE',
    });

    const bound = await prepared();
    const targetId = randomUUID();
    await ownerTenant(bound.athleteId, async (client) => {
      await client.query(
        `INSERT INTO activity_canonical(athlete_id,id,revision,original)
         VALUES($1,$2,1,'{"title":"manual","kind":"running","startedAt":"2026-09-19T21:00:00Z","durationSeconds":2100,"durationKind":"elapsed","timezone":"Asia/Seoul","distanceMeters":5000}'::jsonb)`,
        [bound.athleteId, targetId],
      );
      await client.query(
        `INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id)
         VALUES($1,'manual',$2,1,$3,$4)`,
        [bound.athleteId, randomUUID(), 'a'.repeat(64), targetId],
      );
    });
    await createHealthKitBindingRepository(database).bindExisting(bound.athleteId, {
      sampleId: bound.sampleId,
      targetActivityId: targetId,
      expectedActivityRevision: 1,
      expectedSampleDigest: bound.expectedSampleDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    await expect(repo.createActivity(bound.athleteId, command(bound))).rejects.toMatchObject({
      code: 'ALREADY_LINKED',
    });
  });

  it('redacts HealthKit-owned history and leaves other Activities on raw deletion', async () => {
    const fixture = await prepared();
    const repo = createHealthKitActivityRepository(database);
    const request = command(fixture);
    const created = await repo.createActivity(fixture.athleteId, request);
    const otherId = randomUUID();
    await ownerTenant(fixture.athleteId, async (client) => {
      await client.query(
        'INSERT INTO activity_overlay(athlete_id,activity_id,values_json) VALUES($1,$2,$3::jsonb)',
        [fixture.athleteId, created.activityId, JSON.stringify({ title: 'secret health note' })],
      );
      await client.query(
        `INSERT INTO activity_overlay_revision(athlete_id,activity_id,revision,values_json)
         VALUES($1,$2,1,$3::jsonb)`,
        [fixture.athleteId, created.activityId, JSON.stringify({ title: 'secret health note' })],
      );
      await client.query(
        `INSERT INTO activity_canonical(athlete_id,id,revision,original)
         VALUES($1,$2,1,'{"title":"keep manual","kind":"running","startedAt":"2026-09-19T21:00:00Z","durationSeconds":2100,"durationKind":"elapsed","timezone":"Asia/Seoul","distanceMeters":5000}'::jsonb)`,
        [fixture.athleteId, otherId],
      );
      await client.query(
        `INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id)
         VALUES($1,'manual',$2,1,$3,$4)`,
        [fixture.athleteId, randomUUID(), 'a'.repeat(64), otherId],
      );
    });
    await createHealthKitIngestionRepository(database).ingestBatch(
      fixture.athleteId,
      {
        schemaVersion: 1,
        installationId: randomUUID(),
        batchId: randomUUID(),
        events: [{ kind: 'delete', sampleId: fixture.sampleId }],
      },
      1,
    );
    const state = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT
         (SELECT original FROM activity_canonical WHERE id=$1) AS original,
         (SELECT deleted FROM activity_canonical WHERE id=$1) AS deleted,
         (SELECT count(*)::int FROM activity_overlay WHERE activity_id=$1) AS overlays,
         (SELECT count(*)::int FROM activity_overlay_revision WHERE activity_id=$1) AS overlay_revisions,
         (SELECT count(*)::int FROM activity_source_revision WHERE kind='healthkit') AS source_revisions,
         (SELECT content_hash FROM activity_source_head WHERE kind='healthkit') AS content_hash,
         (SELECT count(*)::int FROM activity_suppression WHERE kind='healthkit') AS suppressions,
         (SELECT state FROM healthkit_workout_lineage WHERE sample_id=$2) AS lineage,
         (SELECT result FROM command_receipt WHERE idempotency_key=$3) AS receipt,
         (SELECT deleted FROM activity_canonical WHERE id=$4) AS other_deleted`,
        [
          created.activityId,
          fixture.sampleId,
          `healthkit-create:${request.idempotencyKey}`,
          otherId,
        ],
      ),
    );
    expect(state.rows[0]).toMatchObject({
      original: {
        title: null,
        kind: 'unknown',
        startedAt: null,
        durationSeconds: null,
        timezone: null,
        distanceMeters: null,
      },
      deleted: true,
      overlays: 0,
      overlay_revisions: 0,
      source_revisions: 0,
      content_hash: '0'.repeat(64),
      suppressions: 1,
      lineage: 'deleted',
      receipt: { purged: true },
      other_deleted: false,
    });
    expect((await createActivityRepository(database).summary(fixture.athleteId)).count).toBe(1);
    await expect(repo.createActivity(fixture.athleteId, request)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await createHealthKitIngestionRepository(database).ingestBatch(
      fixture.athleteId,
      {
        ...fixture.batch,
        batchId: randomUUID(),
      },
      1,
    );
    expect((await createActivityRepository(database).summary(fixture.athleteId)).count).toBe(1);
  });

  it('redacts on local Activity deletion before the raw source is removed', async () => {
    const fixture = await prepared();
    const other = workout();
    await createHealthKitIngestionRepository(database).ingestBatch(fixture.athleteId, other, 1);
    const otherSampleId = other.events[0]?.sampleId;
    if (!otherSampleId) throw new Error('Expected second sample');
    const created = await createHealthKitActivityRepository(database).createActivity(
      fixture.athleteId,
      command(fixture),
    );
    await ownerTenant(fixture.athleteId, (client) =>
      client.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [fixture.athleteId, created.activityId],
      ),
    );
    const state = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT (SELECT state FROM healthkit_workout_lineage WHERE sample_id=$1) AS lineage,
         (SELECT original->>'startedAt' FROM activity_canonical WHERE id=$2) AS started_at,
         (SELECT count(*)::int FROM healthkit_workout_sample WHERE sample_id=$1 AND state='active') AS raw_active,
         (SELECT count(*)::int FROM healthkit_workout_sample WHERE sample_id=$1 AND state='deleted' AND payload_digest IS NULL) AS raw_tombstone,
         (SELECT count(*)::int FROM healthkit_workout_sample WHERE sample_id=$3 AND state='active') AS other_active,
         (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE request_digest IS NULL AND purged_at IS NOT NULL) AS purged_receipts`,
        [fixture.sampleId, created.activityId, otherSampleId],
      ),
    );
    expect(state.rows[0]).toEqual({
      lineage: 'suppressed',
      started_at: null,
      raw_active: 0,
      raw_tombstone: 1,
      other_active: 1,
      purged_receipts: 0,
    });
    const exported = await createOperationsRepository(database).exportAccount(fixture.athleteId);
    expect(JSON.stringify(exported)).not.toContain(fixture.expectedSampleDigest);
    expect(JSON.stringify(exported)).not.toContain('secret health note');
  });

  it('replays a lost ingestion ACK after local deletion and accepts later batches without resurrection', async () => {
    const fixture = await prepared();
    const ingestion = createHealthKitIngestionRepository(database);
    const unrelated = workout();
    const foreign = await prepared();
    const unrelatedAck = await ingestion.ingestBatch(fixture.athleteId, unrelated, 1);
    const created = await createHealthKitActivityRepository(database).createActivity(
      fixture.athleteId,
      command(fixture),
    );
    await ownerTenant(fixture.athleteId, (client) =>
      client.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [fixture.athleteId, created.activityId],
      ),
    );

    // The first ACK was lost on the device. It retries the exact persisted batch,
    // then drains the queue by delivering the next batch with the same installation.
    expect(await ingestion.ingestBatch(fixture.athleteId, fixture.batch, 1)).toEqual({
      schemaVersion: 1,
      installationId: fixture.batch.installationId,
      batchId: fixture.batch.batchId,
      acceptedCount: 1,
    });
    expect(await ingestion.ingestBatch(fixture.athleteId, unrelated, 1)).toEqual(unrelatedAck);
    await expect(
      ingestion.ingestBatch(
        fixture.athleteId,
        {
          ...fixture.batch,
          events: [{ kind: 'delete', sampleId: fixture.sampleId }],
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const next = workout();
    const deletedUpsert = fixture.batch.events[0];
    const nextUpsert = next.events[0];
    if (!deletedUpsert || !nextUpsert) throw new Error('Expected upsert events');
    const nextBatch = {
      ...next,
      installationId: fixture.batch.installationId,
      events: [deletedUpsert, nextUpsert],
    } satisfies HealthKitIngestionBatch;
    expect((await ingestion.ingestBatch(fixture.athleteId, nextBatch, 1)).acceptedCount).toBe(2);

    const state = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT
         (SELECT state FROM healthkit_workout_sample WHERE sample_id=$1) AS deleted_raw_state,
         (SELECT payload_digest FROM healthkit_workout_sample WHERE sample_id=$1) AS deleted_raw_digest,
         (SELECT state FROM healthkit_workout_lineage WHERE sample_id=$1) AS deleted_lineage,
         (SELECT count(*)::int FROM activity_canonical WHERE NOT deleted) AS visible_activities,
         (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE request_digest IS NOT NULL AND purged_at IS NULL) AS live_receipts,
         (SELECT count(*)::int FROM healthkit_workout_sample WHERE sample_id=$2 AND state='active') AS next_active`,
        [fixture.sampleId, next.events[0]?.sampleId],
      ),
    );
    expect(state.rows[0]).toEqual({
      deleted_raw_state: 'deleted',
      deleted_raw_digest: null,
      deleted_lineage: 'suppressed',
      visible_activities: 0,
      live_receipts: 3,
      next_active: 1,
    });
    // A different owner can still replay their own receipt; no tenant-wide
    // receipt update crossed RLS or the trigger's athlete predicate.
    expect(await ingestion.ingestBatch(foreign.athleteId, foreign.batch, 1)).toMatchObject({
      batchId: foreign.batch.batchId,
      acceptedCount: 1,
    });
  });

  it('withdrawal removes raw and redacts canonical/export; account erasure removes barriers', async () => {
    const fixture = await prepared();
    const created = await createHealthKitActivityRepository(database).createActivity(
      fixture.athleteId,
      command(fixture),
    );
    await ownerTenant(fixture.athleteId, (client) =>
      client.query(
        "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
        [fixture.athleteId],
      ),
    );
    const exported = await createOperationsRepository(database).exportAccount(fixture.athleteId);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain('2026-09-19T21:00:00');
    expect(serialized).not.toContain('5000');
    expect(serialized).not.toContain(fixture.expectedSampleDigest);
    const state = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT (SELECT count(*)::int FROM healthkit_workout_sample) AS raw_count,
         (SELECT deleted FROM activity_canonical WHERE id=$1) AS deleted,
         (SELECT count(*)::int FROM activity_source_revision WHERE kind='healthkit') AS revisions,
         (SELECT count(*)::int FROM activity_suppression WHERE kind='healthkit') AS suppressions`,
        [created.activityId],
      ),
    );
    expect(state.rows[0]).toEqual({ raw_count: 0, deleted: true, revisions: 0, suppressions: 1 });
    await createOperationsRepository(database).eraseAccount(fixture.athleteId);
    const erased = await admin.query(
      `SELECT (SELECT count(*)::int FROM activity_canonical WHERE athlete_id=$1) AS activities,
       (SELECT count(*)::int FROM activity_source_head WHERE athlete_id=$1) AS heads,
       (SELECT count(*)::int FROM activity_suppression WHERE athlete_id=$1) AS suppressions,
       (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) AS receipts`,
      [fixture.athleteId],
    );
    expect(erased.rows[0]).toEqual({ activities: 0, heads: 0, suppressions: 0, receipts: 0 });
  });

  it('serializes creation against concurrent HKDeletedObject and consent withdrawal', async () => {
    const repository = createHealthKitActivityRepository(database);
    for (const removal of ['sample', 'consent'] as const) {
      const fixture = await prepared();
      const creation = repository.createActivity(fixture.athleteId, command(fixture));
      const deletion =
        removal === 'sample'
          ? createHealthKitIngestionRepository(database).ingestBatch(
              fixture.athleteId,
              {
                schemaVersion: 1,
                installationId: randomUUID(),
                batchId: randomUUID(),
                events: [{ kind: 'delete', sampleId: fixture.sampleId }],
              },
              1,
            )
          : ownerTenant(fixture.athleteId, async (client) => {
              await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                fixture.athleteId,
              ]);
              await client.query(
                "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
                [fixture.athleteId],
              );
            });
      const [created, removed] = await Promise.allSettled([creation, deletion]);
      expect(removed.status).toBe('fulfilled');
      if (created.status === 'rejected') {
        expect(created.reason).toMatchObject({
          code: expect.stringMatching(/^(SAMPLE_UNAVAILABLE|CONSENT_REQUIRED)$/),
        });
      }
      const state = await database.tenant(fixture.athleteId, (tx) =>
        tx.query(
          `SELECT (SELECT count(*)::int FROM activity_canonical WHERE NOT deleted) AS visible,
           (SELECT count(*)::int FROM healthkit_workout_sample WHERE sample_id=$1 AND state='active') AS active_raw,
           (SELECT count(*)::int FROM activity_source_revision WHERE kind='healthkit') AS source_revisions`,
          [fixture.sampleId],
        ),
      );
      expect(state.rows[0]).toEqual({ visible: 0, active_raw: 0, source_revisions: 0 });
    }
  });

  it('replays an absent HealthKit deletion against backed-up raw data and late delivery', async () => {
    const fixture = await prepared();
    await admin.query(
      'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
      [fixture.athleteId, 'https://issuer.test', randomUUID()],
    );
    const activityId = randomUUID();
    const replay = (sampleId: string, id: string, hash = '0'.repeat(64)) =>
      ownerTenant(fixture.athleteId, (client) =>
        client.query(
          'SELECT public.replay_absent_activity_deletion($1,$2,$3,$4,$5,$6,$7) AS replayed',
          [fixture.athleteId, id, 'healthkit', sampleId, 1, 2, hash],
        ),
      );
    await expect(replay(fixture.sampleId, randomUUID(), 'a'.repeat(64))).rejects.toThrow(
      /ACTIVITY_REPLAY_INVALID_ENTRY/,
    );
    expect((await replay(fixture.sampleId, activityId)).rows[0]).toEqual({ replayed: true });
    const state = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT (SELECT state FROM healthkit_workout_sample WHERE sample_id=$1) AS raw_state,
         (SELECT payload_digest FROM healthkit_workout_sample WHERE sample_id=$1) AS digest,
         (SELECT state FROM healthkit_workout_lineage WHERE sample_id=$1) AS lineage,
         (SELECT deleted FROM activity_canonical WHERE id=$2) AS activity_deleted,
         (SELECT count(*)::int FROM activity_suppression WHERE kind='healthkit' AND source_id=$1::text) AS suppression,
         (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE purged_at IS NOT NULL) AS purged_receipts`,
        [fixture.sampleId, activityId],
      ),
    );
    expect(state.rows[0]).toEqual({
      raw_state: 'deleted',
      digest: null,
      lineage: 'suppressed',
      activity_deleted: true,
      suppression: 1,
      purged_receipts: 0,
    });
    await createHealthKitIngestionRepository(database).ingestBatch(
      fixture.athleteId,
      {
        ...fixture.batch,
        installationId: randomUUID(),
        batchId: randomUUID(),
      },
      1,
    );
    const absentSampleId = randomUUID();
    expect((await replay(absentSampleId, randomUUID())).rows[0]).toEqual({ replayed: true });
    await createHealthKitIngestionRepository(database).ingestBatch(
      fixture.athleteId,
      workout(absentSampleId),
      1,
    );
    const late = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(`SELECT state,payload_digest FROM healthkit_workout_sample WHERE sample_id=$1`, [
        absentSampleId,
      ]),
    );
    expect(late.rows[0]).toEqual({ state: 'deleted', payload_digest: null });
    expect((await createActivityRepository(database).summary(fixture.athleteId)).count).toBe(0);
  });
});
