import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createConsentRepository } from '../src/repositories.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let database: Database;

type ConsentEvent = {
  event_id: string;
  athlete_id: string;
  kind: string;
  target_id: string | null;
  consent_previous_revision: number | null;
  consent_previous_granted: boolean | null;
  consent_revision: number;
  consent_granted: boolean;
};

async function events(tenant: string): Promise<ConsentEvent[]> {
  const rows = await admin.query<ConsentEvent>(
    `SELECT event_id,athlete_id,kind,target_id::text,consent_previous_revision,
       consent_previous_granted,consent_revision,consent_granted
     FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='ai_consent_transition' ORDER BY consent_revision`,
    [tenant],
  );
  return rows.rows;
}

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});

afterAll(async () => {
  await database?.close();
  await runtime.end();
  await admin.end();
});

describe('transaction-local AI consent epoch event', () => {
  it('records grant, withdrawal and re-consent with stable retry identities and erasure survival', async () => {
    const tenant = randomUUID();
    const consents = createConsentRepository(database);
    const grant = {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    } as const;
    const withdrawal = {
      kind: 'ai',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    } as const;
    const regrant = {
      kind: 'ai',
      granted: true,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    } as const;
    await consents.setConsent(tenant, grant);
    await consents.setConsent(tenant, withdrawal);
    await consents.setConsent(tenant, regrant);
    const recorded = await events(tenant);
    expect(recorded).toEqual([
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        kind: 'ai_consent_transition',
        target_id: null,
        consent_previous_revision: null,
        consent_previous_granted: null,
        consent_revision: 1,
        consent_granted: true,
      },
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        kind: 'ai_consent_transition',
        target_id: null,
        consent_previous_revision: 1,
        consent_previous_granted: true,
        consent_revision: 2,
        consent_granted: false,
      },
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        kind: 'ai_consent_transition',
        target_id: null,
        consent_previous_revision: 2,
        consent_previous_granted: false,
        consent_revision: 3,
        consent_granted: true,
      },
    ]);
    expect(await consents.setConsent(tenant, grant)).toMatchObject({ revision: 1 });
    expect(await consents.setConsent(tenant, withdrawal)).toMatchObject({ revision: 2 });
    expect(await consents.setConsent(tenant, regrant)).toMatchObject({ revision: 3 });
    expect(await events(tenant)).toEqual(recorded);
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });
    await createOperationsRepository(database).eraseAccount(tenant);
    expect(await events(tenant)).toEqual(recorded);
  });

  it('rolls back the event with its command and denies a foreign tenant', async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const request = {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    } as const;
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('injected outbox failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(createConsentRepository(broken).setConsent(tenant, request)).rejects.toThrow(
      'injected outbox failure',
    );
    expect(await events(tenant)).toEqual([]);
    const consents = createConsentRepository(database);
    expect(await consents.getConsent(tenant, 'ai')).toMatchObject({ revision: 0 });
    await consents.setConsent(tenant, request);
    const foreign = await database.tenant(other, (tx) =>
      tx.query(
        "UPDATE consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='ai'",
        [tenant],
      ),
    );
    expect(foreign.rowCount).toBe(0);
    expect(await events(other)).toEqual([]);
    expect(await events(tenant)).toHaveLength(1);
  });

  it('rejects malformed policy epochs and records no content', async () => {
    const tenant = randomUUID();
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,occurred_at)
         VALUES($1,'ai_consent_transition',now())`,
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,occurred_at,
          consent_previous_revision,consent_previous_granted,consent_revision,consent_granted)
         VALUES($1,'ai_consent_transition',now(),1,true,3,false)`,
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await createConsentRepository(database).setConsent(tenant, {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const payload = await admin.query(
      `SELECT to_jsonb(e) AS value FROM restore_suppression_event e
       WHERE athlete_id=$1 AND kind='ai_consent_transition'`,
      [tenant],
    );
    expect(JSON.stringify(payload.rows)).not.toContain('prompt');
    expect(JSON.stringify(payload.rows)).not.toContain('token');
    expect(JSON.stringify(payload.rows)).not.toContain('body');
  });
});
