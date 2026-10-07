import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  nutritionPlanVersionSchema,
  saveNutritionPlanVersionRequestSchema,
  type SaveNutritionPlanVersionRequest,
} from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createNutritionRepository, NutritionReadVersionError } from '../src/nutrition-core.js';
import { grantNutritionCore, grantOperations, grantRaces, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Prepared for Root's isolated PG execution only. Offline107 legacy storage is
// explicitly distinct from a public approval: current public writer rejects race anchors.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `nutrition_receipt_${suffix}`;
const ownerRole = `nutrition_receipt_owner_${suffix}`;
const runtimeRole = `nutrition_receipt_app_${suffix}`;
let owner: Pool, runtime: Pool, database: Database, races: RaceRepository;
let historical: Awaited<ReturnType<typeof offlineLegacyFixture>>;
function urlFor(role: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
    const result = await operation(client);
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('TRANSACTION_NOT_COMMITTED');
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
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
async function eventFor(athlete: string) {
  return races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic race',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: null,
    },
  });
}
function commandFor(eventId: string | null): SaveNutritionPlanVersionRequest {
  return saveNutritionPlanVersionRequestSchema.parse({
    kind: 'create',
    idempotencyKey: randomUUID(),
    confirmed: true,
    draft: {
      period: { from: '2026-10-07', toInclusive: '2026-10-07' },
      timezone: 'Asia/Seoul',
      purpose: '한글 Café 영양',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'Meal',
          category: 'before',
          title: '보존 식사',
          anchor:
            eventId === null
              ? { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' }
              : {
                  kind: 'relative',
                  entity: 'race',
                  entityId: eventId,
                  point: 'start',
                  offsetMinutes: -30,
                },
          foods: [
            {
              foodVersionId: null,
              description: '바나나 Café',
              quantity: 0,
              unit: 'g',
              sourceBasis: 'manual_total',
            },
            {
              foodVersionId: null,
              description: '양 미상',
              quantity: null,
              unit: 'unspecified',
              sourceBasis: 'unknown',
            },
            {
              foodVersionId: null,
              description: '물',
              quantity: 1.5,
              unit: 'mL',
              sourceBasis: 'manual_total',
            },
          ],
          targets: [],
          instructions: '',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
}
async function inventory(athlete: string) {
  return owned(athlete, async (client) => {
    const result = await client.query(
      `SELECT
      (SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS versions,
      (SELECT count(*)::int FROM nutrition_plan_history WHERE athlete_id=$1) AS history,
      (SELECT count(DISTINCT approval_id)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS approvals,
      (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox,
      (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) AS receipts`,
      [athlete],
    );
    return result.rows[0];
  });
}
async function offlineLegacyFixture() {
  const athlete = await account();
  const event = await eventFor(athlete);
  const command = commandFor(event.id);
  const versionId = randomUUID();
  const record = nutritionPlanVersionSchema.parse({
    ...command.draft,
    planId: randomUUID(),
    versionId,
    version: 1,
    previousVersionId: null,
    approvalId: randomUUID(),
    approvedAt: '2026-10-07T00:00:00Z',
    items: command.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
  });
  // Legitimate plain107 owner storage fixture, with normal locks/RLS/guards.
  // This is historical legacy storage coverage, NOT a public V2 approval.
  await owned(athlete, async (client) => {
    await client.query(
      `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,previous_version_id,previous_version,period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json)
      VALUES($1,$2,$3,1,NULL,NULL,$4,$5,NULL,$6,$7,$8::jsonb)`,
      [
        athlete,
        record.planId,
        versionId,
        record.period.from,
        record.period.toInclusive,
        record.approvalId,
        record.approvedAt,
        JSON.stringify(record),
      ],
    );
    await client.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, record.planId, versionId],
    );
    await client.query(
      "INSERT INTO nutrition_plan_history(athlete_id,plan_id,version_id,approval_id,action) VALUES($1,$2,$3,$4,'user_approved')",
      [athlete, record.planId, versionId, record.approvalId],
    );
    await client.query(
      'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
      [
        athlete,
        `nutrition-plan:${command.idempotencyKey}`,
        JSON.stringify({ operation: 'nutrition_plan_save', ...command }),
        JSON.stringify(record),
      ],
    );
  });
  return { athlete, event, command, record };
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  await migrate(urlFor(ownerRole), 107);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantRaces(urlFor(ownerRole), runtimeRole);
  await grantNutritionCore(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO "${runtimeRole}"`);
  await owner.query(`GRANT SELECT,INSERT ON command_receipt TO "${runtimeRole}"`);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 4 });
  races = createRaceRepository(database);
  historical = await offlineLegacyFixture();
  await owner.query(
    await readFile(
      new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
      'utf8',
    ),
  );
  await grantRaces(urlFor(ownerRole), runtimeRole);
  await grantNutritionCore(urlFor(ownerRole), runtimeRole);
  await grantOperations(urlFor(ownerRole), runtimeRole);
});
afterAll(async () => {
  await database?.close();
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('rejects race-relative public legacy save without minting receipt/version/history/approval/outbox', async () => {
  const athlete = await account();
  const event = await eventFor(athlete);
  const before = await inventory(athlete);
  await expect(
    createNutritionRepository(database).savePlan(athlete, commandFor(event.id)),
  ).rejects.toMatchObject({ code: 'SESSION_LINK_INVALID' });
  expect(await inventory(athlete)).toEqual(before);
});
it('replays normal public absolute V1 receipt unchanged and rejects meaningful numeric/Unicode changes', async () => {
  const athlete = await account();
  const command = commandFor(null);
  const nutrition = createNutritionRepository(database);
  const saved = await nutrition.savePlan(athlete, command);
  const before = await inventory(athlete);
  expect(await nutrition.savePlan(athlete, command)).toEqual(saved);
  expect(await nutrition.replayPlanV3(athlete, command)).toEqual(saved);
  for (const purpose of ['한글 Cafe 영양', '한글 Café 영양!']) {
    await expect(
      nutrition.replayPlanV3(athlete, { ...command, draft: { ...command.draft, purpose } }),
    ).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
  }
  const foods =
    command.draft.items[0]?.foods.map((food, index) =>
      index === 2 ? { ...food, quantity: 1.6 } : food,
    ) ?? [];
  await expect(
    nutrition.replayPlanV3(athlete, {
      ...command,
      draft: { ...command.draft, items: command.draft.items.map((item) => ({ ...item, foods })) },
    }),
  ).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
  expect(await inventory(athlete)).toEqual(before);
});
it('scrubs offline107 legacy receipt on actual public race deletion and replays only the original exact redacted version', async () => {
  const { athlete, event, command, record } = historical;
  const nutrition = createNutritionRepository(database);
  const unknown = <U extends 'g' | 'kcal' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const nutrientTotal = {
    energy: unknown('kcal'),
    carbohydrate: unknown('g'),
    protein: unknown('g'),
    fat: unknown('g'),
    fluid: unknown('mL'),
    sodium: unknown('mg'),
  };
  const food = await nutrition.saveFood(athlete, {
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    confirmed: true,
    definition: {
      foodId: randomUUID(),
      name: 'Independent food',
      basis: { kind: 'per_100g' },
      nutrients: nutrientTotal,
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-10-07T00:00:00Z',
        reviewState: 'unreviewed',
      },
    },
  });
  const generationId = z
    .uuid()
    .parse((await owner.query('SELECT public.current_restore_generation() AS id')).rows[0]?.id);
  const intake = await nutrition.createIntake(athlete, {
    idempotencyKey: randomUUID(),
    restoreGeneration: generationId,
    intakeId: randomUUID(),
    confirmed: true,
    occurredAt: '2026-10-07T00:00:00Z',
    timezone: 'UTC',
    foods: record.items[0]?.foods ?? [],
    nutrientTotal,
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  await races.deleteRaceEvent(athlete, event.id, {
    expectedRevision: event.revision,
    idempotencyKey: randomUUID(),
  });
  const before = await inventory(athlete);
  const replayed = nutritionPlanVersionV3Schema.parse(
    await nutrition.replayPlanV3(athlete, command),
  );
  expect(replayed).toEqual({
    ...record,
    schemaVersion: 3,
    items: record.items.map((item) => ({
      ...item,
      anchor: { kind: 'disconnected', entity: 'race' },
    })),
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
  expect(await nutrition.replayPlanV3(athlete, command)).toEqual(replayed);
  expect(await nutrition.readPlanV3(athlete, record.planId)).toEqual({
    schemaVersion: 3,
    planId: record.planId,
    head: replayed,
    history: [
      {
        versionId: record.versionId,
        version: record.version,
        approvedAt: new Date(record.approvedAt).toISOString(),
      },
    ],
  });
  const query = {
    from: record.period.from,
    toInclusive: record.period.toInclusive,
    limit: 100,
    cursor: null,
  };
  expect(await nutrition.listPlansV3(athlete, query)).toEqual({
    schemaVersion: 3,
    plans: [replayed],
    nextCursor: null,
  });
  await expect(nutrition.readPlan(athlete, record.planId)).rejects.toBeInstanceOf(
    NutritionReadVersionError,
  );
  await expect(nutrition.listPlans(athlete, query)).rejects.toBeInstanceOf(
    NutritionReadVersionError,
  );
  expect(await nutrition.readFood(athlete, food.foodId)).toEqual(food);
  expect(await nutrition.readIntake(athlete, intake.intakeId)).toEqual(intake);
  await expect(nutrition.savePlan(athlete, command)).rejects.toBeInstanceOf(
    NutritionReadVersionError,
  );
  expect(replayed.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null, 1.5]);
  expect(await inventory(athlete)).toEqual(before);
});
it('matches key order and Unicode digest identity while distinguishing JSONB numeric equality from digest bytes', async () => {
  const { athlete, command, record } = historical;
  await owned(athlete, async (client) => {
    const original = JSON.stringify({ operation: 'nutrition_plan_save', ...command });
    const reordered = JSON.stringify({
      draft: command.draft,
      confirmed: command.confirmed,
      idempotencyKey: command.idempotencyKey,
      kind: command.kind,
      operation: 'nutrition_plan_save',
    }).replace('Café', String.raw`Caf\u00e9`);
    const numericScale = original.replace('"quantity":1.5', '"quantity":1.50');
    // The public producer/consumer both serialize parsed JS numbers. Numeric
    // scale retained by raw PG JSONB text is not a second request digest identity.
    expect(JSON.stringify(JSON.parse(numericScale))).toBe(original);
    expect(JSON.parse(reordered)).toEqual(JSON.parse(original));
    const proof = await client.query(
      `SELECT
      ($1::jsonb=$5::jsonb) AS numeric_equal,
      ($1::jsonb=$2::jsonb) AS reordered_equal,
      encode(sha256(convert_to(($5::jsonb)::text,'UTF8')),'hex') AS numeric_digest,
      encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex') AS original_digest,
      encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex') AS reordered_digest,
      c.request->>'requestDigest' AS stored_digest,c.request,c.result
      FROM command_receipt c WHERE c.athlete_id=$3 AND c.idempotency_key=$4`,
      [original, reordered, athlete, `nutrition-plan:${command.idempotencyKey}`, numericScale],
    );
    const row = proof.rows[0];
    expect(row?.reordered_equal).toBe(true);
    expect(row?.original_digest).toBe(row?.reordered_digest);
    expect(row?.numeric_equal).toBe(true);
    expect(row?.numeric_digest).not.toBe(row?.original_digest);
    expect(row?.stored_digest).toBe(row?.original_digest);
    expect(row?.request).toEqual({
      receiptVersion: 2,
      digestVersion: 'postgres-jsonb-sha256-v1',
      requestDigest: row?.original_digest,
    });
    expect(row?.result).toEqual({
      receiptVersion: 2,
      outcome: 'committed',
      kind: 'nutrition_plan',
      planId: record.planId,
      versionId: record.versionId,
      version: record.version,
      approvalId: record.approvalId,
    });
  });
  const nutrition = createNutritionRepository(database);
  const before = await inventory(athlete);
  const parsedNumbers = saveNutritionPlanVersionRequestSchema.parse(
    JSON.parse(JSON.stringify(command).replace('"quantity":1.5', '"quantity":1.50')),
  );
  expect(await nutrition.replayPlanV3(athlete, parsedNumbers)).toEqual(
    await nutrition.replayPlanV3(athlete, command),
  );
  await expect(
    nutrition.replayPlanV3(athlete, {
      ...command,
      draft: { ...command.draft, purpose: `${command.draft.purpose}!` },
    }),
  ).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
  expect(
    await nutrition.replayPlanV3(athlete, { ...command, idempotencyKey: randomUUID() }),
  ).toBeNull();
  expect(await inventory(athlete)).toEqual(before);
});
it('returns no receipt for a foreign authenticated tenant rather than following the other tenant committed refs', async () => {
  const foreign = await account();
  const before = await inventory(foreign);
  expect(
    await createNutritionRepository(database).replayPlanV3(foreign, historical.command),
  ).toBeNull();
  expect(await inventory(foreign)).toEqual(before);
});

it('keeps scrubbed replay tied to original committed version after a normal public absolute head update', async () => {
  const { athlete, command, record } = historical;
  const nutrition = createNutritionRepository(database);
  const original = await nutrition.replayPlanV3(athlete, command);
  const newer = await nutrition.savePlan(athlete, {
    kind: 'update',
    idempotencyKey: randomUUID(),
    confirmed: true,
    planId: record.planId,
    expectedHeadVersionId: record.versionId,
    draft: commandFor(null).draft,
  });
  expect(newer.version).toBe(2);
  expect(newer.versionId).not.toBe(record.versionId);
  const before = await inventory(athlete);
  expect(await nutrition.replayPlanV3(athlete, command)).toEqual(original);
  expect((await nutrition.readPlanV3(athlete, record.planId))?.history).toEqual([
    { versionId: newer.versionId, version: 2, approvedAt: newer.approvedAt },
    {
      versionId: record.versionId,
      version: 1,
      approvedAt: new Date(record.approvedAt).toISOString(),
    },
  ]);
  expect(await inventory(athlete)).toEqual(before);
});
