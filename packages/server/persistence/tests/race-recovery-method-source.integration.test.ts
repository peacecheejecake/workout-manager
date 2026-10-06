import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { recoveryMethodVersionSchema } from '@workout/contracts/recovery-core';
import { captureRaceImpactSourcePermissions } from '../src/race-plan-impact-source-permissions.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { lockAppAdmission } from '../src/app-admission.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantRaces,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantNutritionCore,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  dbName = `race_method_${suffix}`,
  ownerRole = `race_method_owner_${suffix}`,
  runtimeRole = `race_method_app_${suffix}`;
let owner: Pool, database: Database, recovery: ReturnType<typeof createRecoveryRepository>;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function account(granted: boolean | null = true) {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  if (granted !== null)
    await createConsentRepository(database).setConsent(athlete, {
      kind: 'app',
      granted,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  return athlete;
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  owner = new Pool({ connectionString: url(ownerRole) });
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  // The configured identity runtime uses these same domain grants; no fixture-only SELECT.
  await grantRoutineCore(url(ownerRole), runtimeRole);
  await grantRecoveryCore(url(ownerRole), runtimeRole);
  await grantCheckIns(url(ownerRole), runtimeRole);
  await grantCourses(url(ownerRole), runtimeRole);
  await grantNutritionCore(url(ownerRole), runtimeRole);
  // Same regular resources/retrieval combination as the configured authenticated runtime.
  await grantResources(url(ownerRole), runtimeRole);
  await grantResourceRetrieval(url(ownerRole), runtimeRole);
  // Existing configured product role composition, not collector-only privilege fabrication.
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  await grantGarminUnofficial(url(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: url(runtimeRole) });
  recovery = createRecoveryRepository(database, { now: () => new Date('2026-10-01T00:00:00Z') });
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

const method = (athlete: string) =>
  recovery.createMethod(athlete, {
    title: 'Synthetic manual method',
    category: 'rest',
    intendedUse: 'Personal record',
    applicability: [],
    cautions: [],
    sourceDescription: 'Synthetic user input',
    evidenceLimitations: 'Unreviewed; no efficacy claim',
    idempotencyKey: randomUUID(),
  });
type Catalog = NonNullable<Parameters<typeof captureRaceImpactSourcePermissions>[1]['catalogRefs']>;
async function capture(
  athlete: string,
  catalogRefs: Catalog,
  baseBytes = 0n,
  existingSourceCount = 0,
  queries?: string[],
) {
  return database.tenant(athlete, async (tx) => {
    await lockAppAdmission(tx);
    return captureRaceImpactSourcePermissions(
      {
        ...tx,
        query: async (sql, values) => {
          queries?.push(sql);
          return tx.query(sql, values);
        },
      },
      {
        plannedRefs: [],
        resourceVersionIds: [],
        catalogRefs,
        baseBytes,
        existingSourceCount,
      },
    );
  });
}
const ref = (record: { methodId: string; versionId: string }) => ({
  kind: 'recovery_method' as const,
  ref: { id: record.methodId, versionId: record.versionId },
});
it('resolves an exact public-created owned method digest and unreviewed manual provenance under normal runtime grants', async () => {
  const athlete = await account(),
    record = await method(athlete),
    queries: string[] = [];
  const result = await capture(athlete, [ref(record), ref(record)], 0n, 0, queries);
  expect(result.complete).toBe(false);
  expect(result.catalog).toEqual([
    {
      requested: ref(record),
      state: 'current',
      reason: null,
      content: { digest: impactDependencyDigest(record) },
      currentHead: { aggregate_id: record.methodId, version_id: record.versionId },
      provenance: { source: 'user_recorded', reviewState: 'unreviewed', reviewedAt: null },
    },
  ]);
  expect(
    queries.filter((sql) =>
      sql.includes('SELECT v.method_id,v.version_id,v.version,v.record_json'),
    ),
  ).toHaveLength(1);
  expect(result.missing).toContain('unsupported_domain_item_membership');
});
it('foreign and absent versions expose no body, provenance, or foreign head; forged owned aggregate tuples reject', async () => {
  const athlete = await account(),
    foreign = await account(),
    record = await method(foreign);
  const result = await capture(athlete, [
    ref(record),
    ref({ methodId: randomUUID(), versionId: randomUUID() }),
  ]);
  for (const row of result.catalog)
    expect(row).toMatchObject({
      state: 'unavailable',
      reason: 'owned_version_unavailable',
      content: null,
      currentHead: null,
      provenance: null,
    });
  const own = await method(athlete);
  await expect(
    capture(athlete, [ref({ methodId: record.methodId, versionId: own.versionId })]),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
it('synthetic owner maintenance head correction and head absence retain exact old immutable content, never current substitution', async () => {
  const athlete = await account(),
    old = await method(athlete),
    versionId = randomUUID();
  const next = recoveryMethodVersionSchema.parse({
    ...old,
    versionId,
    version: 2,
    title: 'Synthetic changed current method',
  });
  const before = await capture(athlete, [ref(old)]);
  await owned(athlete, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await client.query(
      'INSERT INTO recovery_method_version(athlete_id,method_id,version_id,version,record_json) VALUES($1,$2,$3,2,$4::jsonb)',
      [athlete, old.methodId, versionId, JSON.stringify(next)],
    );
    await client.query(
      'UPDATE recovery_method_head SET version=2,version_id=$3 WHERE athlete_id=$1 AND method_id=$2',
      [athlete, old.methodId, versionId],
    );
  });
  const corrected = await capture(athlete, [ref(old), ref(next)]);
  expect(
    corrected.catalog.find((row) => row.requested.ref.versionId === old.versionId),
  ).toMatchObject({
    state: 'historical',
    content: before.catalog[0]?.content,
    currentHead: { aggregate_id: old.methodId, version_id: next.versionId },
  });
  expect(
    corrected.catalog.find((row) => row.requested.ref.versionId === next.versionId),
  ).toMatchObject({ state: 'current', content: { digest: impactDependencyDigest(next) } });
  await owned(athlete, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await client.query('DELETE FROM recovery_method_head WHERE athlete_id=$1 AND method_id=$2', [
      athlete,
      old.methodId,
    ]);
  });
  const headless = await capture(athlete, [ref(old)]);
  expect(headless.catalog[0]).toMatchObject({
    state: 'historical',
    currentHead: null,
    content: { digest: impactDependencyDigest(old) },
  });
  // No public method update/delete/archive exists. These are owner maintenance
  // fixtures, not product command acceptance or invented deleted/tombstone state.
  await owned(athlete, (client) =>
    client.query('DELETE FROM recovery_method_version WHERE athlete_id=$1 AND method_id=$2', [
      athlete,
      old.methodId,
    ]),
  );
  expect((await capture(athlete, [ref(old)])).catalog[0]).toMatchObject({
    state: 'unavailable',
    content: null,
    currentHead: null,
    provenance: null,
  });
});
it('rejects actual stored DTO/SQL ordinal disagreement instead of digesting a forged exact version', async () => {
  const athlete = await account(),
    record = await method(athlete);
  await owned(athlete, (client) =>
    client.query(
      "UPDATE recovery_method_version SET record_json=jsonb_set(record_json,'{version}','2'::jsonb) WHERE athlete_id=$1 AND version_id=$2",
      [athlete, record.versionId],
    ),
  );
  await expect(capture(athlete, [ref(record)])).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
it('bounds source counts and UTF8 transported method bytes before returning bodies through the real driver', async () => {
  const athlete = await account(),
    record = await method(athlete),
    queries: string[] = [];
  await expect(capture(athlete, [ref(record)], 0n, 5000, queries)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(queries).toEqual([]);
  await expect(
    capture(athlete, [ref(record)], 4194304n - 2048n - 200n, 0, queries),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
  expect(
    queries.filter((sql) =>
      sql.includes('SELECT v.method_id,v.version_id,v.version,v.record_json'),
    ),
  ).toEqual([]);
  expect(queries.some((sql) => sql.includes('octet_length(v.record_json::text)'))).toBe(true);
});
it('keeps unsupported checkin content and the generic membership missing flag unchanged', async () => {
  const athlete = await account(),
    requested = {
      kind: 'checkin_template' as const,
      ref: { id: randomUUID(), versionId: randomUUID() },
    };
  const result = await capture(athlete, [requested]);
  expect(result.catalog).toEqual([
    {
      requested,
      state: 'unavailable',
      reason: 'producer_content_contract_unavailable',
      content: null,
      currentHead: null,
    },
  ]);
  expect(result.complete).toBe(false);
});
