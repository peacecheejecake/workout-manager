import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppConsentRequiredError,
  lockAppAdmission,
  requireAppAdmission,
} from '../src/app-admission.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, migrate } from '../src/migrate.js';
import { enqueue, PersistenceConflict } from '../src/outbox.js';
import { createConsentRepository } from '../src/repositories.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Real isolated PostgreSQL required: run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl });
const applicationName = `app-admission-${randomUUID()}`;
let database: Database;
const resultSchema = z.strictObject({ eventId: z.uuid(), revision: z.number().int().positive() });

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt TO workout_runtime',
  );
  const endpoint = new URL(runtimeUrl);
  endpoint.searchParams.set('application_name', applicationName);
  database = createDatabase({ connectionString: endpoint.toString(), max: 4 });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function setConsent(athleteId: string, granted: boolean, expectedRevision: number) {
  return createConsentRepository(database).setConsent(athleteId, {
    kind: 'app',
    granted,
    expectedRevision,
    idempotencyKey: randomUUID(),
  });
}

/**
 * Deliberately a helper-boundary fixture, not a product repository: the outbox
 * event is its only new processing artifact. Real core callers are later slices.
 */
async function processFixture(athleteId: string, key: string, marker = 'synthetic') {
  return database.tenant(athleteId, async (tx) => {
    await lockAppAdmission(tx);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [athleteId]);
    const request = { operation: 'app-admission-fixture', marker };
    const prior = await tx.query(
      'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
      [athleteId, key, JSON.stringify(request)],
    );
    if (prior.rows[0]) {
      if (prior.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
      return resultSchema.parse(prior.rows[0]['result']);
    }
    const admission = await requireAppAdmission(tx);
    const eventId = await enqueue(tx, {
      id: randomUUID(),
      idempotencyKey: key,
      topic: 'app-admission.fixture',
      payload: { marker },
    });
    const result = { eventId, revision: admission.revision };
    await tx.query(
      'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
      [athleteId, key, JSON.stringify(request), JSON.stringify(result)],
    );
    return result;
  });
}

async function assertNoProcessing(athleteId: string, key: string) {
  await database.tenant(athleteId, async (tx) => {
    expect((await tx.query('SELECT id FROM outbox WHERE idempotency_key=$1', [key])).rows).toEqual(
      [],
    );
    expect(
      (await tx.query('SELECT result FROM command_receipt WHERE idempotency_key=$1', [key])).rows,
    ).toEqual([]);
  });
}

async function waitForBlockedCommand() {
  await expect
    .poll(async () => {
      const waiting = await admin.query(
        "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
        [applicationName],
      );
      return waiting.rows[0]?.['count'];
    })
    .toBeGreaterThan(0);
}

describe('V2-F31 app admission helper boundary in real PostgreSQL', () => {
  it.each(['absent', 'withdrawn'] as const)(
    '%s app consent refuses new processing',
    async (state) => {
      const athleteId = randomUUID();
      const key = randomUUID();
      if (state === 'withdrawn') await setConsent(athleteId, false, 0);
      await expect(processFixture(athleteId, key)).rejects.toMatchObject({
        code: 'APP_CONSENT_REQUIRED',
      });
      await assertNoProcessing(athleteId, key);
      expect(await createConsentRepository(database).getConsent(athleteId, 'app')).toEqual({
        kind: 'app',
        granted: false,
        revision: state === 'absent' ? 0 : 1,
      });
    },
  );

  it('returns a validated positive int4 admission and preserves kind isolation', async () => {
    const athleteId = randomUUID();
    await setConsent(athleteId, true, 0);
    for (const kind of ['provider', 'ai', 'healthkit'] as const)
      await createConsentRepository(database).setConsent(athleteId, {
        kind,
        granted: false,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
    expect(await database.tenant(athleteId, requireAppAdmission)).toEqual({
      kind: 'app',
      granted: true,
      revision: 1,
    });
    await setConsent(athleteId, false, 1);
    await setConsent(athleteId, true, 2);
    expect(await database.tenant(athleteId, requireAppAdmission)).toEqual({
      kind: 'app',
      granted: true,
      revision: 3,
    });
  });

  it('a granted foreign tenant and other granted kinds cannot authorize this tenant', async () => {
    await setConsent(randomUUID(), true, 0);
    const athleteId = randomUUID();
    for (const kind of ['provider', 'ai', 'healthkit'] as const)
      await createConsentRepository(database).setConsent(athleteId, {
        kind,
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
    await expect(database.tenant(athleteId, requireAppAdmission)).rejects.toBeInstanceOf(
      AppConsentRequiredError,
    );
  });

  it('replays success before the fresh gate; reads, fixture export and deletion remain available', async () => {
    const athleteId = randomUUID();
    const key = randomUUID();
    await setConsent(athleteId, true, 0);
    const original = await processFixture(athleteId, key);
    await setConsent(athleteId, false, 1);
    expect(await processFixture(athleteId, key)).toEqual(original);
    await expect(processFixture(athleteId, key, 'changed')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const freshKey = randomUUID();
    await expect(processFixture(athleteId, freshKey)).rejects.toBeInstanceOf(
      AppConsentRequiredError,
    );
    await assertNoProcessing(athleteId, freshKey);
    await database.tenant(athleteId, async (tx) => {
      const exported = await tx.query(
        "SELECT payload FROM outbox WHERE topic='app-admission.fixture'",
      );
      expect(exported.rows).toEqual([{ payload: { marker: 'synthetic' } }]);
      expect((await tx.query('DELETE FROM outbox WHERE id=$1', [original.eventId])).rowCount).toBe(
        1,
      );
    });
  });

  it('a refused attempt can succeed after an explicit grant without a phantom receipt', async () => {
    const athleteId = randomUUID();
    const key = randomUUID();
    await expect(processFixture(athleteId, key)).rejects.toBeInstanceOf(AppConsentRequiredError);
    await setConsent(athleteId, true, 0);
    expect(await processFixture(athleteId, key)).toMatchObject({ revision: 1 });
  });

  it('a writer holding tenant 0 commits before a waiting revocation', async () => {
    const athleteId = randomUUID();
    await setConsent(athleteId, true, 0);
    const locked = barrier();
    const finish = barrier();
    const writer = database.tenant(athleteId, async (tx) => {
      const admission = await requireAppAdmission(tx);
      locked.release();
      await finish.ready;
      await enqueue(tx, {
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        topic: 'app-admission.fixture',
        payload: { marker: 'ordered-before-revoke' },
      });
      return admission;
    });
    await locked.ready;
    const revoke = setConsent(athleteId, false, 1);
    try {
      await waitForBlockedCommand();
    } finally {
      finish.release();
    }
    expect(await writer).toMatchObject({ revision: 1 });
    expect(await revoke).toMatchObject({ granted: false, revision: 2 });
    await expect(database.tenant(athleteId, requireAppAdmission)).rejects.toBeInstanceOf(
      AppConsentRequiredError,
    );
  });

  it('a revocation holding tenant 0 commits before a waiting writer, including no artifacts', async () => {
    const athleteId = randomUUID();
    const key = randomUUID();
    await setConsent(athleteId, true, 0);
    const locked = barrier();
    const finish = barrier();
    const revoke = database.tenant(athleteId, async (tx) => {
      await lockAppAdmission(tx);
      await tx.query("UPDATE consent SET granted=false,revision=revision+1 WHERE kind='app'");
      locked.release();
      await finish.ready;
    });
    await locked.ready;
    // Attach the rejection observer before releasing the revoker transaction.
    const writer = expect(processFixture(athleteId, key)).rejects.toBeInstanceOf(
      AppConsentRequiredError,
    );
    try {
      await waitForBlockedCommand();
    } finally {
      finish.release();
    }
    await revoke;
    await writer;
    await assertNoProcessing(athleteId, key);
  });
});
