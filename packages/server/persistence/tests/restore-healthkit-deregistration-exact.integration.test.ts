import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import { replayVerifiedSuppressionChain } from '../src/restore-suppression-replay.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `healthkit_dereg_replay_${suffix}`;
const ownerRole = `healthkit_owner_${suffix}`;
const runtimeRole = `healthkit_app_${suffix}`;
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
  pool: Pool,
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function account(): Promise<string> {
  const result = await owner.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject)
     VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const id = result.rows[0]?.athlete_id;
  if (!id) throw new Error('missing account');
  return id;
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
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON consent TO "${runtimeRole}"`);
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

type ReleaseRecord = {
  athleteId: string;
  eventId: string;
  occurredAt: string;
  kind: 'healthkit_workout_deregistration_pending' | 'healthkit_workout_deregistration_released';
  sampleId: string;
  claimEpoch: string;
  operationId: string;
  consentRevision: number;
  previousRevision: number;
  revision: number;
  scopes: { kind: 'activity' | 'course'; id: string }[];
};
async function record(
  athleteId: string,
  sampleId: string,
  claimEpoch: string,
): Promise<ReleaseRecord> {
  const time = await owner.query<{ occurred_at: string }>(
    'SELECT clock_timestamp()::text occurred_at',
  );
  const occurredAt = time.rows[0]?.occurred_at;
  if (!occurredAt) throw new Error('missing time');
  return {
    athleteId,
    eventId: randomUUID(),
    occurredAt,
    kind: 'healthkit_workout_deregistration_pending',
    sampleId,
    claimEpoch,
    operationId: randomUUID(),
    consentRevision: 1,
    previousRevision: 1,
    revision: 2,
    scopes: [],
  };
}
async function replay(pool: Pool, item: ReleaseRecord) {
  return tenant(pool, item.athleteId, async (client) => {
    const result = await client.query<{ result: string }>(
      'SELECT public.replay_healthkit_workout_deregistration_exact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result',
      [
        item.athleteId,
        item.eventId,
        item.occurredAt,
        item.kind,
        item.sampleId,
        item.claimEpoch,
        item.operationId,
        item.consentRevision,
        item.previousRevision,
        item.revision,
        JSON.stringify(item.scopes),
      ],
    );
    return result.rows[0]?.result;
  });
}
async function replayChain(item: ReleaseRecord) {
  const body = {
    localRecordVersion: 1 as const,
    clusterId: '123456789',
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [
      {
        commitLsn: '0/110',
        endLsn: '0/120',
        records: [
          {
            schemaVersion: 3 as const,
            eventId: item.eventId,
            athleteId: item.athleteId,
            occurredAt: item.occurredAt,
            kind: item.kind,
            targetId: item.sampleId,
            healthKitClaimEpoch: item.claimEpoch,
            healthKitOperationId: item.operationId,
            healthKitConsentRevision: item.consentRevision,
            healthKitRegistryPreviousRevision: item.previousRevision,
            healthKitRegistryRevision: item.revision,
            healthKitObjectScopes: item.scopes,
          },
        ],
      },
    ],
  };
  const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const key = Buffer.alloc(32, 7),
    keyId = 'synthetic-restore-key';
  const segment = encryptReplaySegment({ envelope: { ...body, sha256 }, key, keyId });
  return replayVerifiedSuppressionChain({
    ownerPool: owner,
    segments: [segment.bytes],
    key,
    keyId,
    anchor: {
      clusterId: body.clusterId,
      fromLsn: body.fromLsn,
      throughLsn: body.throughLsn,
      previousHash: null,
      finalLocalHash: sha256,
      ciphertextHashes: [segment.sha256],
    },
  });
}

async function seed(athleteId: string, sampleId: string, claimEpoch: string) {
  await tenant(owner, athleteId, async (client) => {
    await client.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athleteId],
    );
    await client.query(
      'INSERT INTO healthkit_workout_registry_head(athlete_id,revision) VALUES($1,1)',
      [athleteId],
    );
    await client.query(
      'INSERT INTO healthkit_workout_claim(sample_id,athlete_id,claim_epoch,consent_revision) VALUES($1,$2,$3,1)',
      [sampleId, athleteId, claimEpoch],
    );
    await client.query(
      "INSERT INTO healthkit_workout_registration_receipt(athlete_id,idempotency_key,request_digest,result_json) VALUES($1,'synthetic_registration',$2,$3)",
      [athleteId, 'a'.repeat(64), JSON.stringify({ claims: [{ sampleId, claimEpoch }] })],
    );
    await client.query(
      `INSERT INTO healthkit_workout_sample(athlete_id,sample_id,installation_id,state,source_bundle_id,activity_type,observed_from,observed_to,duration_seconds,payload_digest) VALUES($1,$2,$3,'active','synthetic.test',37,now()-interval '1 hour',now(),3600,$4)`,
      [athleteId, sampleId, randomUUID(), 'a'.repeat(64)],
    );
  });
}
async function state(athleteId: string) {
  return tenant(
    owner,
    athleteId,
    async (client) =>
      (
        await client.query<{ claims: string; raw: string; receipts: string; pending: string }>(
          `SELECT (SELECT count(*)::text FROM healthkit_workout_claim WHERE athlete_id=$1) claims,(SELECT count(*)::text FROM healthkit_workout_sample WHERE athlete_id=$1) raw,(SELECT count(*)::text FROM healthkit_workout_registration_receipt WHERE athlete_id=$1) receipts,(SELECT count(*)::text FROM healthkit_workout_deregistration WHERE athlete_id=$1 AND state='pending_cleanup') pending`,
          [athleteId],
        )
      ).rows[0],
  );
}
describe('owner-only exact HealthKit deregistration replay', () => {
  it('replays pending with UUID retained and raw/registration receipts removed; runtime cannot replay', async () => {
    const a = await account(),
      sampleId = randomUUID(),
      epoch = randomUUID();
    await seed(a, sampleId, epoch);
    const pending = await record(a, sampleId, epoch);
    await expect(replay(runtime, pending)).rejects.toThrow();
    expect((await replayChain(pending)).eventCount).toBe(1);
    expect(await state(a)).toEqual({ claims: '1', raw: '0', receipts: '0', pending: '1' });
    await replay(owner, pending);
    expect(await state(a)).toEqual({ claims: '1', raw: '0', receipts: '0', pending: '1' });
    await expect(replay(owner, { ...pending, claimEpoch: randomUUID() })).rejects.toThrow();
    expect(await state(a)).toEqual({ claims: '1', raw: '0', receipts: '0', pending: '1' });
  });
  it('fails closed on released-only facts and preserves the active old claim', async () => {
    const a = await account(),
      sampleId = randomUUID(),
      epoch = randomUUID();
    await seed(a, sampleId, epoch);
    const pending = await record(a, sampleId, epoch);
    await expect(
      replay(owner, {
        ...pending,
        kind: 'healthkit_workout_deregistration_released',
        previousRevision: 2,
        revision: 3,
      }),
    ).rejects.toThrow();
    expect(await state(a)).toEqual({ claims: '1', raw: '1', receipts: '1', pending: '0' });
  });
  it('preserves a later B claim and a newer A epoch when old release facts repeat', async () => {
    for (const sameAccount of [false, true]) {
      const a = await account(),
        b = sameAccount ? a : await account(),
        sampleId = randomUUID(),
        oldEpoch = randomUUID(),
        newEpoch = randomUUID();
      await seed(a, sampleId, oldEpoch);
      const pending = await record(a, sampleId, oldEpoch);
      await replay(owner, pending);
      const released = {
        ...pending,
        eventId: randomUUID(),
        kind: 'healthkit_workout_deregistration_released' as const,
        previousRevision: 2,
        revision: 3,
      };
      await replay(owner, released);
      expect((await state(a))?.claims).toBe('0');
      await tenant(owner, b, async (client) => {
        if (!sameAccount)
          await client.query(
            "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
            [b],
          );
        await client.query(
          'INSERT INTO healthkit_workout_claim(sample_id,athlete_id,claim_epoch,consent_revision) VALUES($1,$2,$3,1)',
          [sampleId, b, newEpoch],
        );
      });
      await replay(owner, pending);
      await replay(owner, released);
      const claim = await tenant(
        owner,
        b,
        async (client) =>
          (
            await client.query<{ claim_epoch: string }>(
              'SELECT claim_epoch::text FROM healthkit_workout_claim WHERE sample_id=$1',
              [sampleId],
            )
          ).rows[0],
      );
      expect(claim?.claim_epoch).toBe(newEpoch);
      await expect(
        replay(owner, { ...released, scopes: [{ kind: 'activity', id: randomUUID() }] }),
      ).rejects.toThrow();
      expect((await state(b))?.claims).toBe('1');
    }
  });
  it('retains pending object cleanup without inventing physical purge evidence', async () => {
    const a = await account(),
      sampleId = randomUUID(),
      epoch = randomUUID(),
      activityId = randomUUID();
    await seed(a, sampleId, epoch);
    const pending = {
      ...(await record(a, sampleId, epoch)),
      scopes: [{ kind: 'activity' as const, id: activityId }],
    };
    await replay(owner, pending);
    expect((await state(a))?.pending).toBe('1');
    const purge = await tenant(
      owner,
      a,
      async (client) =>
        (
          await client.query<{ completed_at: string | null }>(
            "SELECT completed_at::text FROM object_scope_purge WHERE athlete_id=$1 AND scope_kind='activity' AND scope_id=$2",
            [a, activityId],
          )
        ).rows[0],
    );
    expect(purge?.completed_at ?? null).toBeNull();
    expect((await state(a))?.claims).toBe('1');
  });
  it('does not purge current A data when a historical event names an older A epoch', async () => {
    const a = await account(),
      sampleId = randomUUID(),
      newEpoch = randomUUID();
    await seed(a, sampleId, newEpoch);
    const historical = await record(a, sampleId, randomUUID());
    await replay(owner, historical);
    expect(await state(a)).toEqual({ claims: '1', raw: '1', receipts: '1', pending: '1' });
    await replay(owner, {
      ...historical,
      eventId: randomUUID(),
      kind: 'healthkit_workout_deregistration_released',
      previousRevision: 2,
      revision: 3,
    });
    expect(await state(a)).toEqual({ claims: '1', raw: '1', receipts: '1', pending: '0' });
  });
  it('replays old A deletion over a current B claim without deleting B ownership', async () => {
    const a = await account(),
      b = await account(),
      sampleId = randomUUID(),
      oldEpoch = randomUUID(),
      newEpoch = randomUUID();
    await seed(a, sampleId, oldEpoch);
    const pending = await record(a, sampleId, oldEpoch);
    await tenant(owner, a, (client) =>
      client.query('DELETE FROM healthkit_workout_claim WHERE sample_id=$1', [sampleId]),
    );
    await tenant(owner, b, (client) =>
      client.query(
        'INSERT INTO healthkit_workout_claim(sample_id,athlete_id,claim_epoch,consent_revision) VALUES($1,$2,$3,1)',
        [sampleId, b, newEpoch],
      ),
    );
    await replay(owner, pending);
    await replay(owner, {
      ...pending,
      eventId: randomUUID(),
      kind: 'healthkit_workout_deregistration_released',
      previousRevision: 2,
      revision: 3,
    });
    expect(await state(a)).toEqual({ claims: '0', raw: '0', receipts: '0', pending: '0' });
    const claim = await tenant(
      owner,
      b,
      async (client) =>
        (
          await client.query<{ claim_epoch: string }>(
            'SELECT claim_epoch::text FROM healthkit_workout_claim WHERE sample_id=$1',
            [sampleId],
          )
        ).rows[0],
    );
    expect(claim?.claim_epoch).toBe(newEpoch);
  });
});
