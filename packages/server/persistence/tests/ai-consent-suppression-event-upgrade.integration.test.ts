import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `ai_consent_event_${suffix}`;
const ownerRole = `ai_consent_owner_${suffix}`;
const runtimeRole = `ai_consent_rt_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_ai_consent_transition_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('AI consent event migration is missing');

let owner: Pool;
let database: Database;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await migrate(urlFor(ownerRole), migrationIndex);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON consent TO "${runtimeRole}"`);
  await owner.query(`GRANT SELECT,INSERT ON command_receipt,outbox TO "${runtimeRole}"`);
  await owner.query(`GRANT UPDATE(idempotency_key) ON outbox TO "${runtimeRole}"`);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
});

afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('AI consent event plain-owner upgrade', () => {
  it('keeps the old grant unbackfilled and records a new withdrawal under FORCE RLS', async () => {
    const tenant = randomUUID();
    const consents = createConsentRepository(database);
    await consents.setConsent(tenant, {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await migrate(urlFor(ownerRole));
    expect(
      (
        await owner.query(
          `SELECT 1 FROM restore_suppression_event
           WHERE athlete_id=$1 AND kind='ai_consent_transition'`,
          [tenant],
        )
      ).rows,
    ).toEqual([]);
    await consents.setConsent(tenant, {
      kind: 'ai',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await owner.query(
          `SELECT consent_previous_revision,consent_previous_granted,
             consent_revision,consent_granted FROM restore_suppression_event
           WHERE athlete_id=$1 AND kind='ai_consent_transition'`,
          [tenant],
        )
      ).rows,
    ).toEqual([
      {
        consent_previous_revision: 1,
        consent_previous_granted: true,
        consent_revision: 2,
        consent_granted: false,
      },
    ]);
    const policy = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_suppression_event'::regclass",
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
