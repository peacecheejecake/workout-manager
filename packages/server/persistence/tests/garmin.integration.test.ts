import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import {
  createGarminStore,
  createGarminRevocationStore,
  type GarminCipher,
} from '../src/garmin.js';
import { createIdentityRepository } from '../src/identity.js';
import { createOperationsRepository } from '../src/operations.js';
import {
  grantGarmin,
  grantGarminWorker,
  grantIdentityFunctions,
  grantOperations,
  migrate,
} from '../src/migrate.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let identity: ReturnType<typeof createIdentityRepository>;
let store: ReturnType<typeof createGarminStore>;
let worker: ReturnType<typeof createGarminRevocationStore>;
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('EXPECTED_TEST_VALUE');
  return value;
}

function encrypted(value: string): GarminCipher {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  return {
    keyId: 'synthetic',
    iv: iv.toString('base64'),
    ciphertext: Buffer.concat([cipher.update(value), cipher.final()]).toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantIdentityFunctions(adminUrl, 'workout_runtime');
  await grantGarmin(adminUrl, 'workout_runtime');
  await admin.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='garmin_cleanup_test') THEN CREATE ROLE garmin_cleanup_test LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$",
  );
  await grantGarminWorker(adminUrl, 'garmin_cleanup_test');
  const workerUrl = new URL(runtimeUrl);
  workerUrl.username = 'garmin_cleanup_test';
  worker = createGarminRevocationStore({ connectionString: workerUrl.toString() });
  identity = createIdentityRepository({ connectionString: runtimeUrl });
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  store = createGarminStore(database);
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,outbox,command_receipt,plan_snapshot,plan_head,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression TO workout_runtime',
  );
});
beforeEach(async () => {
  await admin.query(
    'TRUNCATE garmin_attempt,garmin_connection,garmin_private.revocation,garmin_private.ownership',
  );
});
afterAll(async () => {
  await database?.close();
  await worker?.close();
  await identity?.close();
  await admin.end();
});
async function session() {
  const now = new Date(),
    tokenHash = hash();
  const principal = await identity.createSession({
    tokenHash,
    csrfToken: hash(),
    issuer: 'https://synthetic.invalid',
    subject: randomUUID(),
    expiresAt: new Date(now.getTime() + 3600000),
    now,
  });
  return { ...principal, now, tokenHash };
}
async function attempt(principal: Awaited<ReturnType<typeof session>>) {
  const stateHash = hash(),
    encryptedVerifier = encrypted('synthetic-verifier');
  const result = await store.createAttempt({
    ...principal,
    stateHash,
    encryptedVerifier,
    expiresAt: new Date(principal.now.getTime() + 600000),
  });
  return { ...principal, ...result, stateHash, encryptedVerifier };
}
function credentials(now: Date) {
  return {
    encryptedTokens: encrypted('secret-access-and-refresh'),
    accessExpiresAt: new Date(now.getTime() + 3600000),
    refreshExpiresAt: new Date(now.getTime() + 172800000),
  };
}
async function connected(userId = randomUUID()) {
  const current = await attempt(await session());
  expect(await store.consumeAttempt(current)).not.toBeNull();
  const tokens = credentials(current.now);
  expect(
    await store.commitConnection({
      ...current,
      ...tokens,
      userId,
      permissions: ['ACTIVITY_EXPORT'],
    }),
  ).toBe(true);
  return { ...current, ...tokens, userId };
}
describe('Garmin OAuth durable tenant lifecycle', () => {
  it('stores encrypted values, isolates tenants, and keeps cleanup and old erasure functions inaccessible to app roles', async () => {
    expect(
      (
        await admin.query(
          "SELECT has_table_privilege('garmin_cleanup_test','garmin_connection','SELECT') AS application_read,has_schema_privilege('garmin_cleanup_test','garmin_private','USAGE') AS private_read",
        )
      ).rows[0],
    ).toEqual({ application_read: false, private_read: false });
    const a = await connected(),
      b = await session();
    const rows = await database.tenant(b.athleteId, (tx) =>
      tx.query('SELECT * FROM garmin_connection WHERE athlete_id=$1', [a.athleteId]),
    );
    expect(rows.rows).toEqual([]);
    const raw = await admin.query(
      'SELECT encrypted_tokens FROM garmin_connection WHERE athlete_id=$1',
      [a.athleteId],
    );
    expect(JSON.stringify(raw.rows)).not.toContain('secret-access-and-refresh');
    expect(raw.rows[0].encrypted_tokens).toEqual(a.encryptedTokens);
    await expect(
      database.tenant(b.athleteId, (tx) => tx.query('SELECT * FROM garmin_private.revocation')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.tenant(b.athleteId, (tx) =>
        tx.query('SELECT public.garmin_lease_revocation($1,$2,$3)', [
          randomUUID(),
          a.now,
          new Date(a.now.getTime() + 90000),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.tenant(b.athleteId, (tx) =>
        tx.query('SELECT public.erase_account_before_garmin($1)', [b.athleteId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      JSON.stringify(await createOperationsRepository(database).exportAccount(a.athleteId)),
    ).not.toContain(a.encryptedTokens.ciphertext);
    expect((await createOperationsRepository(database).status(a.athleteId)).providers.garmin).toBe(
      'connected',
    );
  });
  it('consumes state once atomically, binds session, limits TTL and rechecks logout at final commit', async () => {
    const a = await attempt(await session());
    expect(await store.consumeAttempt({ ...a, sessionId: randomUUID() })).toBeNull();
    const results = await Promise.all([store.consumeAttempt(a), store.consumeAttempt(a)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await identity.revokeSession(a.tokenHash);
    expect((await store.status(a.athleteId)).state).toBe('disconnected');
    expect((await createOperationsRepository(database).status(a.athleteId)).providers.garmin).toBe(
      'not_connected',
    );
    expect(
      await store.commitConnection({
        ...a,
        ...credentials(a.now),
        userId: randomUUID(),
        permissions: [],
      }),
    ).toBe(false);
    const b = await session();
    await expect(
      store.createAttempt({
        ...b,
        stateHash: hash(),
        encryptedVerifier: encrypted('verifier'),
        expiresAt: new Date(b.now.getTime() + 600001),
      }),
    ).rejects.toThrow('INVALID_ATTEMPT_EXPIRY');
    const c = await attempt(b);
    expect(
      await store.consumeAttempt({ ...c, now: new Date(c.now.getTime() + 600001) }),
    ).toBeNull();
  });
  it('does not transfer a Garmin user to a different app owner or revoke that legitimate registration', async () => {
    const a = await connected(),
      b = await attempt(await session());
    await store.consumeAttempt(b);
    const tokens = credentials(b.now);
    expect(
      await store.commitConnection({ ...b, ...tokens, userId: a.userId, permissions: [] }),
    ).toBe(false);
    await store.queueRevoke({ ...b, ...tokens, userId: a.userId });
    expect(
      await worker.leaseRevocation({
        now: b.now,
        leaseId: randomUUID(),
        leaseUntil: new Date(b.now.getTime() + 90000),
      }),
    ).toBeNull();
    expect((await store.status(a.athleteId)).state).toBe('connected');
  });
  it('fences a late callback after disconnect and serializes refresh leases against disconnect', async () => {
    const pending = await attempt(await session());
    await store.consumeAttempt(pending);
    await store.disconnect(pending);
    expect(
      await store.commitConnection({
        ...pending,
        ...credentials(pending.now),
        userId: randomUUID(),
        permissions: [],
      }),
    ).toBe(false);
    const a = await connected(),
      leaseId = randomUUID(),
      leaseUntil = new Date(a.now.getTime() + 90000);
    const results = await Promise.all([
      store.leaseRefresh({ ...a, leaseId, leaseUntil }),
      store.leaseRefresh({ ...a, leaseId: randomUUID(), leaseUntil }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.disconnect(a);
    expect(await store.commitRefresh({ ...a, leaseId, ...credentials(a.now) })).toBe(false);
    expect((await store.status(a.athleteId)).state).toBe('disconnecting');
    await expect(attempt(a)).rejects.toMatchObject({ code: 'CONNECTION_BUSY' });
  });
  it('erases credentials, rejects late callback and allows only bounded encrypted remote cleanup after deletion', async () => {
    const a = await connected();
    await createOperationsRepository(database).eraseAccount(a.athleteId);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM garmin_connection WHERE athlete_id=$1',
          [a.athleteId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(await store.commitConnection({ ...a, permissions: [] })).toBe(false);
    await store.queueRevoke({ ...a, ...credentials(a.now) });
    const leaseId = randomUUID(),
      job = await worker.leaseRevocation({
        now: a.now,
        leaseId,
        leaseUntil: new Date(a.now.getTime() + 90000),
      });
    expect(job).not.toBeNull();
    expect(required(job).expiresAt.getTime()).toBeLessThanOrEqual(
      a.now.getTime() + 86400000 + 1000,
    );
    expect(
      await worker.updateRevocationTokens({
        id: required(job).id,
        leaseId,
        now: a.now,
        ...credentials(a.now),
      }),
    ).toBe(true);
    await worker.finishRevocation({ id: required(job).id, leaseId, success: false, now: a.now });
    const later = new Date(a.now.getTime() + 86401000);
    expect(
      await worker.leaseRevocation({
        now: later,
        leaseId: randomUUID(),
        leaseUntil: new Date(later.getTime() + 90000),
      }),
    ).toBeNull();
    expect(
      (await admin.query('SELECT count(*)::int AS count FROM garmin_private.revocation')).rows[0]
        .count,
    ).toBe(0);
  });
  it('rolls back erasure and its queued cleanup together when the surrounding transaction fails', async () => {
    const a = await connected();
    await expect(
      database.exclusiveTenant(a.athleteId, async (tx) => {
        await tx.query('SELECT public.erase_account($1)', [a.athleteId]);
        throw new Error('rollback-marker');
      }),
    ).rejects.toThrow('rollback-marker');
    expect((await store.status(a.athleteId)).state).toBe('connected');
    expect(
      (await admin.query('SELECT count(*)::int AS count FROM garmin_private.revocation')).rows[0]
        .count,
    ).toBe(0);
  });
  it('resolves unknown orphan identity before revocation and preserves a live owner', async () => {
    const owner = await connected(),
      orphan = await session();
    await store.queueRevoke({ ...orphan, ...credentials(orphan.now), userId: null });
    const leaseId = randomUUID();
    const job = await worker.leaseRevocation({
      now: orphan.now,
      leaseId,
      leaseUntil: new Date(orphan.now.getTime() + 90000),
    });
    expect(job).not.toBeNull();
    expect(
      await worker.prepareRevocation({
        id: required(job).id,
        leaseId,
        userId: owner.userId,
        now: orphan.now,
      }),
    ).toBe(false);
    expect((await store.status(owner.athleteId)).state).toBe('connected');
    expect(
      (await admin.query('SELECT count(*)::int AS count FROM garmin_private.revocation')).rows[0]
        .count,
    ).toBe(0);
  });
  it('keeps a live cleanup lease fenced across retention expiry before another owner can connect', async () => {
    const owner = await connected();
    await store.disconnect(owner);
    await admin.query('UPDATE garmin_private.revocation SET expires_at=$1 WHERE athlete_id=$2', [
      new Date(owner.now.getTime() + 10000),
      owner.athleteId,
    ]);
    const leaseId = randomUUID();
    const job = await worker.leaseRevocation({
      now: owner.now,
      leaseId,
      leaseUntil: new Date(owner.now.getTime() + 90000),
    });
    expect(
      await worker.prepareRevocation({
        id: required(job).id,
        leaseId,
        userId: owner.userId,
        now: owner.now,
      }),
    ).toBe(true);
    const next = await attempt(await session());
    await store.consumeAttempt(next);
    const later = new Date(owner.now.getTime() + 15000);
    expect(
      await worker.leaseRevocation({
        now: later,
        leaseId: randomUUID(),
        leaseUntil: new Date(later.getTime() + 90000),
      }),
    ).toBeNull();
    expect(
      await store.commitConnection({
        ...next,
        ...credentials(later),
        now: later,
        userId: owner.userId,
        permissions: [],
      }),
    ).toBe(false);
    expect(
      (await admin.query('SELECT count(*)::int AS count FROM garmin_private.revocation')).rows[0]
        .count,
    ).toBe(1);
    await worker.finishRevocation({ id: required(job).id, leaseId, success: true, now: later });
    expect(
      await store.commitConnection({
        ...next,
        ...credentials(later),
        now: later,
        userId: owner.userId,
        permissions: [],
      }),
    ).toBe(true);
  });
  it('linearizes simultaneous refresh/disconnect and callback/account deletion without resurrection', async () => {
    const owner = await connected(),
      leaseId = randomUUID();
    await store.leaseRefresh({
      ...owner,
      leaseId,
      leaseUntil: new Date(owner.now.getTime() + 90000),
    });
    await Promise.all([
      store.commitRefresh({ ...owner, ...credentials(owner.now), leaseId }),
      store.disconnect(owner),
    ]);
    expect((await store.status(owner.athleteId)).state).toBe('disconnecting');
    const pending = await attempt(await session());
    await store.consumeAttempt(pending);
    await Promise.all([
      store.commitConnection({
        ...pending,
        ...credentials(pending.now),
        userId: randomUUID(),
        permissions: [],
      }),
      createOperationsRepository(database).eraseAccount(pending.athleteId),
    ]);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM garmin_connection WHERE athlete_id=$1',
          [pending.athleteId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it('serializes old and rotated revocation jobs by Garmin registration and clears the group after success', async () => {
    const owner = await connected();
    await store.disconnect(owner);
    await store.queueRevoke({ ...owner, ...credentials(owner.now) });
    const firstId = randomUUID(),
      secondId = randomUUID(),
      leaseUntil = new Date(owner.now.getTime() + 90000);
    const results = await Promise.all([
      worker.leaseRevocation({ now: owner.now, leaseId: firstId, leaseUntil }),
      worker.leaseRevocation({ now: owner.now, leaseId: secondId, leaseUntil }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const job = results[0] ?? results[1],
      leaseId = results[0] ? firstId : secondId;
    expect(
      await worker.prepareRevocation({
        id: required(job).id,
        leaseId,
        userId: owner.userId,
        now: owner.now,
      }),
    ).toBe(true);
    await worker.finishRevocation({ id: required(job).id, leaseId, success: true, now: owner.now });
    expect(
      (await admin.query('SELECT count(*)::int AS count FROM garmin_private.revocation')).rows[0]
        .count,
    ).toBe(0);
    const next = await attempt(owner);
    await store.consumeAttempt(next);
    expect(
      await store.commitConnection({
        ...next,
        ...credentials(owner.now),
        userId: owner.userId,
        permissions: [],
      }),
    ).toBe(true);
  });
});
