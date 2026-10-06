import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { saveNutritionPlanVersionRequestSchema } from '@workout/contracts/nutrition-core';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import {
  migrate,
  grantRaces,
  grantOperations,
  grantNutritionCore,
  grantCorePlanning,
} from '../src/migrate.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { prepareNutritionRaceTimingIn } from '../src/nutrition-race-timing-preparation.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Isolated acceptance fixture: normal106/plain roles, actual RaceRepository source.
// Legacy race Nutrition records are synthetic SQL020 fixtures because current
// writers cannot produce them; no production approval success claimed.
// Synthetic consent heads and owner corruption fixtures are labeled separately.
// No admission reopen, SQL106 positive review storage, provider or plan approval.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const dbName = `nutrition_timing_${suffix}`;
const ownerRole = `nutrition_timing_owner_${suffix}`;
const runtimeRole = `nutrition_timing_app_${suffix}`;
let owner: Pool;
let database: Database;
let races: RaceRepository;
function url(role: string) {
  const result = new URL(adminUrl);
  result.pathname = `/${dbName}`;
  result.username = role;
  result.password = 'isolated';
  return result.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole), 106);
  await grantRaces(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantNutritionCore(url(ownerRole), runtimeRole);
  await grantCorePlanning(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 4 });
  database = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  races = createRaceRepository(database);
  const roles = await admin.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
    [[ownerRole, runtimeRole]],
  );
  expect(roles.rows).toHaveLength(2);
  for (const role of roles.rows) expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  expect(
    (
      await owner.query(
        'SELECT count(*)::integer AS count,max(version) AS version FROM schema_migrations',
      )
    ).rows,
  ).toEqual([{ count: 106, version: 106 }]);
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athlete,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
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
async function account() {
  const athlete = randomUUID();
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athlete, 'https://synthetic.invalid', randomUUID()],
  );
  // Explicit named synthetic app permission, not an automatic production grant.
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
function values(patch: Partial<RaceEventValues> = {}): RaceEventValues {
  return {
    title: 'Synthetic owned race',
    localDate: '2026-10-07',
    localStartTime: '09:00',
    timezone: 'Asia/Seoul',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: null,
    planVersionId: null,
    ...patch,
  };
}
async function source(patch: Partial<RaceEventValues> = {}) {
  const athlete = await account();
  const body = values(patch);
  const event = await races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: body,
  });
  return { athlete, body, event };
}
async function read<T>(athlete: string, operation: (tx: Transaction) => Promise<T>) {
  return database.tenant(athlete, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    return operation(tx);
  });
}
function intent(id: string, point: 'start' | 'end' = 'start') {
  return {
    schemaVersion: 2,
    command: {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft: {
        period: { from: '2026-10-07', toInclusive: '2026-10-07' },
        timezone: 'Asia/Seoul',
        purpose: 'Synthetic',
        linkedTrainingPlanVersionId: null,
        items: [
          {
            id: 'meal-1',
            category: 'before',
            title: 'Synthetic meal',
            anchor: { kind: 'relative', entity: 'race', entityId: id, point, offsetMinutes: 0 },
            foods: [],
            targets: [],
            instructions: 'Synthetic action',
            evidenceIds: [],
            source: 'user_confirmed',
          },
        ],
      },
    },
    expectedRaceHeads: [{ namespace: 'race-event', eventId: id, revision: 1 }],
  };
}
async function legacy(athlete: string, id: string, point: 'start' | 'end' = 'start') {
  const input = intent(id, point);
  const planId = randomUUID(),
    versionId = randomUUID(),
    approvalId = randomUUID();
  const record = {
    ...input.command.draft,
    planId,
    versionId,
    approvalId,
    version: 1,
    previousVersionId: null,
    approvedAt: '2026-10-07T00:00:00Z',
    items: input.command.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
  };
  // Explicit synthetic historical SQL020 record, not a production writer approval.
  await owned(athlete, async (client) => {
    await client.query(
      `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,previous_version_id,previous_version,period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json) VALUES($1,$2,$3,1,NULL,NULL,'2026-10-07','2026-10-07',NULL,$4,'2026-10-07T00:00:00Z',$5::jsonb)`,
      [athlete, planId, versionId, approvalId, JSON.stringify(record)],
    );
    await client.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, planId, versionId],
    );
  });
  return {
    ...input,
    command: { ...input.command, kind: 'update', planId, expectedHeadVersionId: versionId },
  };
}
it('actual owned race prepares immutable binding without writes and control stays CLOSED', async () => {
  const s = await source();
  const result = await read(s.athlete, async (tx) => {
    const before = (
      await tx.query('SELECT count(*)::int AS count FROM command_receipt WHERE athlete_id=$1', [
        s.athlete,
      ])
    ).rows;
    const prepared = await prepareNutritionRaceTimingIn(tx, intent(s.event.id), []);
    expect(
      (
        await tx.query('SELECT count(*)::int AS count FROM command_receipt WHERE athlete_id=$1', [
          s.athlete,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (await tx.query("SELECT public.read_restore_processing_admission()->>'state' AS state"))
        .rows[0]?.['state'],
    ).toBe('CLOSED');
    return prepared;
  });
  expect(result).toMatchObject({
    status: 'prepared',
    storage: 'not_persisted',
    approvalAllowed: false,
    fullApproval: false,
  });
});
it('actual foreign tenant source and immutable prior are unavailable under RLS', async () => {
  const s = await source();
  const foreign = await account();
  const update = await legacy(s.athlete, s.event.id);
  expect(
    await read(foreign, (tx) => prepareNutritionRaceTimingIn(tx, intent(s.event.id), [])),
  ).toMatchObject({ status: 'blocked', blocks: [{ code: 'RACE_TIMING_UNAVAILABLE' }] });
  expect(await read(foreign, (tx) => prepareNutritionRaceTimingIn(tx, update, []))).toMatchObject({
    status: 'blocked',
    blocks: [{ code: 'PRIOR_UNAVAILABLE' }],
  });
});
it('owned synthetic legacy unchanged unresolved survives only outside affected set', async () => {
  const s = await source({ localStartTime: null });
  const update = await legacy(s.athlete, s.event.id);
  expect(await read(s.athlete, (tx) => prepareNutritionRaceTimingIn(tx, update, []))).toMatchObject(
    {
      status: 'prepared',
      notices: [{ code: 'LEGACY_UNPINNED_PRESERVED' }, { code: 'UNRESOLVED_PRESERVED' }],
    },
  );
  expect(
    await read(s.athlete, (tx) => prepareNutritionRaceTimingIn(tx, update, ['meal-1'])),
  ).toMatchObject({ status: 'blocked', blocks: [{ code: 'TIMING_UNRESOLVED' }] });
});
it('actual source deletion blocks legacy preparation without inventing retention permission', async () => {
  const s = await source();
  const update = await legacy(s.athlete, s.event.id);
  await races.deleteRaceEvent(s.athlete, s.event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
  });
  expect(await read(s.athlete, (tx) => prepareNutritionRaceTimingIn(tx, update, []))).toMatchObject(
    { status: 'blocked', blocks: [{ code: 'RACE_TIMING_UNAVAILABLE' }] },
  );
});
it('actual current race revision change does not substitute the requested immutable revision', async () => {
  const s = await source();
  const input = intent(s.event.id);
  await races.updateRaceEvent(s.athlete, s.event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...s.body, localStartTime: '11:00' },
  });
  expect(await read(s.athlete, (tx) => prepareNutritionRaceTimingIn(tx, input, []))).toMatchObject({
    status: 'blocked',
    blocks: [{ code: 'RACE_TIMING_STALE' }],
  });
});
it('actual owned public Nutrition absolute prior validates metadata and stale head CAS', async () => {
  const s = await source();
  const input = intent(s.event.id);
  const repo = createNutritionRepository(database);
  const record = await repo.savePlan(
    s.athlete,
    saveNutritionPlanVersionRequestSchema.parse({
      kind: 'create',
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: {
        ...input.command.draft,
        items: input.command.draft.items.map((item) => ({
          ...item,
          anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' },
        })),
      },
    }),
  );
  const update = {
    ...input,
    command: {
      ...input.command,
      kind: 'update',
      planId: record.planId,
      expectedHeadVersionId: record.versionId,
    },
  };
  expect(await read(s.athlete, (tx) => prepareNutritionRaceTimingIn(tx, update, []))).toMatchObject(
    { status: 'prepared' },
  );
  expect(
    await read(s.athlete, (tx) =>
      prepareNutritionRaceTimingIn(
        tx,
        { ...update, command: { ...update.command, expectedHeadVersionId: randomUUID() } },
        [],
      ),
    ),
  ).toMatchObject({ status: 'blocked', blocks: [{ code: 'PRIOR_HEAD_STALE' }] });
});
