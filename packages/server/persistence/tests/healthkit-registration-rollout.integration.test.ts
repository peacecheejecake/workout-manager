import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHealthKitRegistration } from '../src/healthkit-registration-audit.js';
import { migrate } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated PostgreSQL integration harness');
const databaseName = `hk_rollout_${randomUUID().replaceAll('-', '')}`;
const cluster = new Pool({ connectionString: adminUrl });
const auditUrl = new URL(adminUrl);
auditUrl.pathname = `/${databaseName}`;
const limitedUrl = new URL(runtimeUrl);
limitedUrl.pathname = `/${databaseName}`;
const owner = new Pool({ connectionString: auditUrl.toString() });
const runtime = new Pool({ connectionString: limitedUrl.toString() });
const plainOwnerRole = `hk_audit_${randomUUID().replaceAll('-', '')}`;
const athletes = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const samples = [randomUUID(), randomUUID(), randomUUID()];

beforeAll(async () => {
  await cluster.query(`CREATE DATABASE "${databaseName}"`);
  await migrate(auditUrl.toString());
});
afterAll(async () => {
  await runtime.end();
  await owner.end();
  await cluster.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await cluster.query(`DROP ROLE IF EXISTS "${plainOwnerRole}"`);
  await cluster.end();
});

async function insertFixture(sql: string, values: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [values[0]]);
    await client.query(sql, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function fingerprint() {
  const result = await owner.query(`SELECT
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY athlete_id,sample_id)::text,'[]')) FROM healthkit_workout_sample t) raw,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY athlete_id,batch_id)::text,'[]')) FROM healthkit_workout_batch_receipt t) receipt,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY sample_id)::text,'[]')) FROM healthkit_workout_claim t) claim,
    (SELECT count(*)::int FROM healthkit_workout_deregistration) operations,
    (SELECT count(*)::int FROM healthkit_workout_registry_head) heads,
    (SELECT count(*)::int FROM outbox) outbox`);
  return result.rows[0];
}

describe('HealthKit owner rollout audit without backfill or purge', () => {
  it('returns bounded zero facts for an empty database without ownership inference', async () => {
    const result = await auditHealthKitRegistration(owner);
    expect(
      Object.values(result.counts).every((value) => value.count === 0 && !value.saturated),
    ).toBe(true);
    expect(result.historicalOwnershipProven).toBe(false);
  });

  it('counts synthetic raw/known receipt duplicates separately from unknown legacy, tombstones and consent', async () => {
    for (const athlete of athletes.slice(0, 2)) {
      await insertFixture(
        "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
        [athlete],
      );
    }
    for (const [athlete, sample] of [
      [athletes[0], samples[0]],
      [athletes[1], samples[0]],
      [athletes[2], samples[1]],
    ]) {
      await insertFixture(
        `INSERT INTO healthkit_workout_sample(athlete_id,sample_id,installation_id,state,source_bundle_id,activity_type,observed_from,observed_to,duration_seconds,payload_digest)
        VALUES($1,$2,$3,'active','com.example.synthetic',37,'2026-10-01T00:00:00Z','2026-10-01T00:01:00Z',60,$4)`,
        [athlete, sample, randomUUID(), 'a'.repeat(64)],
      );
    }
    await insertFixture(
      "INSERT INTO healthkit_workout_sample(athlete_id,sample_id,installation_id,state,deleted_at) VALUES($1,$2,$3,'deleted',now())",
      [athletes[2], samples[2], randomUUID()],
    );
    await insertFixture(
      'INSERT INTO healthkit_workout_claim(athlete_id,sample_id,claim_epoch,consent_revision) VALUES($1,$2,$3,2)',
      [athletes[0], samples[0], randomUUID()],
    );
    for (const athlete of athletes.slice(0, 2)) {
      await insertFixture(
        `INSERT INTO healthkit_workout_batch_receipt(athlete_id,installation_id,batch_id,request_digest,accepted_count,protocol_version,sample_ids)
      VALUES($1,$2,$3,$4,1,2,ARRAY[$5::uuid])`,
        [athlete, randomUUID(), randomUUID(), 'b'.repeat(64), samples[0]],
      );
    }
    // Receipt-only UUID for B overlaps C raw: combined evidence catches what either table alone cannot.
    await insertFixture(
      `INSERT INTO healthkit_workout_batch_receipt(athlete_id,installation_id,batch_id,request_digest,accepted_count,protocol_version,sample_ids)
      VALUES($1,$2,$3,$4,1,2,ARRAY[$5::uuid])`,
      [athletes[1], randomUUID(), randomUUID(), 'c'.repeat(64), samples[1]],
    );
    for (const protocol of [1, 2]) {
      await insertFixture(
        `INSERT INTO healthkit_workout_batch_receipt(athlete_id,installation_id,batch_id,request_digest,accepted_count,protocol_version,pre_registration_historical)
        VALUES($1,$2,$3,$4,1,$5,true)`,
        [athletes[0], randomUUID(), randomUUID(), 'd'.repeat(64), protocol],
      );
    }
    await insertFixture(
      `INSERT INTO healthkit_workout_batch_receipt(athlete_id,installation_id,batch_id,accepted_count,protocol_version,purged_at)
      VALUES($1,$2,$3,1,2,now())`,
      [athletes[2], randomUUID(), randomUUID()],
    );
    const before = await fingerprint();
    const audit = await auditHealthKitRegistration(owner);
    const values = Object.fromEntries(
      Object.entries(audit.counts).map(([key, value]) => [key, value.count]),
    );
    expect(values).toEqual({
      rawRows: 4,
      rawActiveRows: 3,
      rawTombstoneRows: 1,
      rawDuplicateAccountUuids: 1,
      rawWithoutOwnClaimRows: 3,
      rawOtherClaimOwnerRows: 1,
      rawWithoutGrantedConsentRows: 2,
      receiptRows: 6,
      receiptLegacyV1Rows: 1,
      receiptHistoricalRows: 2,
      receiptPurgedRows: 1,
      receiptActiveUnknownMembershipRows: 2,
      receiptActiveKnownMembershipRows: 3,
      receiptActiveWithoutGrantedConsentRows: 0,
      receiptKnownDuplicateAccountUuids: 1,
      rawAndKnownReceiptDuplicateAccountUuids: 2,
      claimRows: 1,
      claimWithoutCurrentConsentRows: 1,
      pendingDeregistrationRows: 0,
    });
    expect(await fingerprint()).toEqual(before);
    const serialized = JSON.stringify(audit);
    for (const privateValue of [...athletes, ...samples, 'com.example.synthetic', '2026-10-01'])
      expect(serialized).not.toContain(privateValue);
    expect(audit.historicalOwnershipProven).toBe(false);
  });

  it('marks saturated counts as lower bounds and validates options before connection', async () => {
    const result = await auditHealthKitRegistration(owner, { countCeiling: 2 });
    expect(result.counts.rawRows).toEqual({ count: 2, saturated: true });
    expect(result.counts.receiptActiveUnknownMembershipRows).toEqual({
      count: 2,
      saturated: false,
    });
    for (const countCeiling of [0, 1.5, 1_000_001, NaN])
      await expect(auditHealthKitRegistration(owner, { countCeiling })).rejects.toThrow();
  });

  it('rejects ordinary runtime instead of returning tenant-filtered zeros and leaves its connection usable', async () => {
    await expect(auditHealthKitRegistration(runtime)).rejects.toThrow(
      'HEALTHKIT_AUDIT_OWNER_REQUIRED',
    );
    expect((await runtime.query('SELECT 1 value')).rows[0]).toEqual({ value: 1 });
  });
  it('fails closed for a plain table owner under FORCE RLS instead of treating filtered counts as global', async () => {
    await owner.query(`CREATE ROLE "${plainOwnerRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    for (const table of [
      'healthkit_workout_sample',
      'healthkit_workout_batch_receipt',
      'healthkit_workout_claim',
      'healthkit_workout_deregistration',
      'consent',
    ]) {
      await owner.query(`ALTER TABLE public.${table} OWNER TO "${plainOwnerRole}"`);
    }
    const before = await fingerprint();
    const plainUrl = new URL(auditUrl);
    plainUrl.username = plainOwnerRole;
    plainUrl.password = '';
    const plain = new Pool({ connectionString: plainUrl.toString() });
    try {
      await expect(auditHealthKitRegistration(plain)).rejects.toThrow(
        'HEALTHKIT_AUDIT_UNAVAILABLE',
      );
      expect((await plain.query('SELECT 1 value')).rows[0]).toEqual({ value: 1 });
      expect(await fingerprint()).toEqual(before);
    } finally {
      await plain.end();
    }
  });
});
