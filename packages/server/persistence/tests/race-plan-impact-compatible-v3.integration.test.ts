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
import { nutritionPlanVersionV2Schema } from '@workout/contracts/nutrition-race-plan-v2';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import {
  grantNutritionCore,
  grantOperations,
  grantRaces,
  migrate,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { captureRaceTimingPins } from '../src/race-timing-bindings.js';
import { createRacePlanImpactPreviewService } from '../src/race-plan-impact-preview.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Prepared for Root's isolated PG execution only. Offline107 legacy storage is
// explicitly distinct from a public approval: current public writer rejects race anchors.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `race_preview_compat_${suffix}`;
const ownerRole = `race_preview_compat_owner_${suffix}`;
const runtimeRole = `race_preview_compat_app_${suffix}`;
let owner: Pool, runtime: Pool, database: Database, races: RaceRepository;
let historical: Awaited<ReturnType<typeof offlineLegacyFixture>>;
let frozen: Awaited<ReturnType<typeof offlineLegacyFixture>>;
let plain: Awaited<ReturnType<ReturnType<typeof createNutritionRepository>['savePlan']>>;
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
      localStartTime: '07:00:00',
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
async function offlineLegacyFixture(
  athlete = '',
  event: Awaited<ReturnType<typeof eventFor>> | null = null,
  v2 = false,
) {
  athlete = athlete || (await account());
  event = event ?? (await eventFor(athlete));
  const command = commandFor(event.id);
  const versionId = randomUUID();
  const legacy = nutritionPlanVersionSchema.parse({
    ...command.draft,
    planId: randomUUID(),
    versionId,
    version: 1,
    previousVersionId: null,
    approvalId: randomUUID(),
    approvedAt: '2026-10-07T00:00:00Z',
    items: command.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
  });
  const record = v2
    ? nutritionPlanVersionV2Schema.parse({
        ...legacy,
        schemaVersion: 2,
        raceTimingPins: await database.tenant(athlete, (tx) =>
          captureRaceTimingPins(tx, [
            { namespace: 'race-event', eventId: event.id, revision: event.revision },
          ]),
        ),
        itemRaceTimingBindings: legacy.items.map((item) => ({
          itemId: item.id,
          binding: { state: 'captured', eventId: event.id, eventRevision: event.revision },
        })),
      })
    : legacy;
  // Legitimate plain107 owner storage fixture, with normal locks/RLS/guards.
  // This is offline historical storage coverage, NOT a public V2 writer/approval.
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
  frozen = await offlineLegacyFixture(historical.athlete, await eventFor(historical.athlete), true);
  await owner.query(
    await readFile(
      new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
      'utf8',
    ),
  );
  await grantRaces(urlFor(ownerRole), runtimeRole);
  await grantNutritionCore(urlFor(ownerRole), runtimeRole);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  // Actual configured domain grant composition, no collector-only SELECT fabrication.
  for (const grant of [
    grantRoutineCore,
    grantRecoveryCore,
    grantCheckIns,
    grantCourses,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
  ])
    await grant(urlFor(ownerRole), runtimeRole);
  await races.deleteRaceEvent(historical.athlete, historical.event.id, {
    expectedRevision: historical.event.revision,
    idempotencyKey: randomUUID(),
  });
  plain = await createNutritionRepository(database).savePlan(historical.athlete, commandFor(null));
});
afterAll(async () => {
  await database?.close();
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
function previewIntent(event = frozen.event) {
  return {
    expectedEvent: { id: event.id, revision: event.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' },
  };
}
it('captures mixed normal V1/offline frozen V2/deleted V3 through actual public preview with full digest and unchanged blocked coverage', async () => {
  const athlete = historical.athlete;
  const before = await inventory(athlete);
  const service = createRacePlanImpactPreviewService(database);
  const result = await service.preview(athlete, previewIntent());
  const again = await service.preview(athlete, previewIntent());
  expect(result.context.nutrition.map((row) => row.record.versionId).sort()).toEqual(
    [plain.versionId, frozen.record.versionId, historical.record.versionId].sort(),
  );
  const disconnected = result.context.nutrition.find(
    (row) => row.versionId === historical.record.versionId,
  );
  const redacted = nutritionPlanVersionV3Schema.parse(disconnected?.record);
  expect(redacted.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
  expect(redacted.items[0]?.foods).toEqual(historical.record.items[0]?.foods);
  expect(disconnected?.relativeItems).toEqual([]);
  expect(
    result.context.consumedSources.races.some((event) => event.id === historical.event.id),
  ).toBe(false);
  expect(result.context.readSetDigest).toBe(again.context.readSetDigest);
  expect(result.context.coverage.complete).toBe(false);
  expect(result.context.coverage.missing).toHaveLength(5);
  expect(result.projection.status).toBe('projected');
  if (result.projection.status !== 'projected') throw new Error('MISSING_PROJECTION');
  expect(result.projection.approvalAllowed).toBe(false);
  expect(result.projection.coverageComplete).toBe(false);
  expect(
    result.projection.input.nutrition.find((row) => row.record.versionId === redacted.versionId)
      ?.record,
  ).toEqual(redacted);
  expect(
    result.projection.projection.nutrition.find((row) => row.planVersionId === redacted.versionId)
      ?.items[0],
  ).toMatchObject({
    state: 'unchanged',
    item: { anchor: { kind: 'disconnected', entity: 'race' } },
    before: { state: 'unresolved' },
    after: { state: 'unresolved' },
    notice: 'existing_unresolved_preserved',
  });
  expect(await inventory(athlete)).toEqual(before);
});
it('uses actual immutable producer pin for affected V2 before timing, never live re-pins or approves a date move', async () => {
  const athlete = frozen.athlete;
  const before = await inventory(athlete);
  const result = await createRacePlanImpactPreviewService(database).preview(
    athlete,
    previewIntent(),
  );
  if (result.projection.status !== 'projected') throw new Error('MISSING_PROJECTION');
  expect(
    result.projection.projection.nutrition.find(
      (row) => row.planVersionId === frozen.record.versionId,
    )?.items[0],
  ).toMatchObject({
    state: 'affected',
    before: { state: 'resolved', date: '2026-10-07', localTime: '06:30:00' },
    after: { state: 'resolved', date: '2026-10-08', localTime: '06:30:00' },
    notice: null,
  });
  expect(result.projection.sourceFacts.nutritionRacePins).toContainEqual({
    nutritionVersionId: frozen.record.versionId,
    itemId: 'Meal',
    binding: { state: 'captured', eventId: frozen.event.id, eventRevision: 1 },
  });
  expect(
    result.projection.missingFacts.filter((fact) => fact.kind === 'immutable_race_pin'),
  ).toEqual([]);
  expect(await inventory(athlete)).toEqual(before);
});
it('reads a changed owned event as freshness context while keeping immutable V2 saved pin time and original stored body', async () => {
  const event = await races.getRaceEvent(frozen.athlete, frozen.event.id);
  if (!event) throw new Error('MISSING_EVENT');
  const { id: _id, revision: _revision, ...values } = event;
  const updated = await races.updateRaceEvent(frozen.athlete, event.id, {
    expectedRevision: event.revision,
    idempotencyKey: randomUUID(),
    values: { ...values, localStartTime: '10:00:00' },
  });
  const before = await inventory(frozen.athlete);
  const result = await createRacePlanImpactPreviewService(database).preview(
    frozen.athlete,
    previewIntent(updated),
  );
  if (result.projection.status !== 'projected') throw new Error('MISSING_PROJECTION');
  expect(result.context.event.localStartTime).toBe('10:00:00');
  expect(
    result.projection.projection.nutrition.find(
      (row) => row.planVersionId === frozen.record.versionId,
    )?.items[0]?.after,
  ).toEqual({ state: 'resolved', date: '2026-10-08', localTime: '09:30:00' });
  expect(result.projection.approvalAllowed).toBe(false);

  expect(
    result.context.nutrition.find((row) => row.versionId === frozen.record.versionId)?.record,
  ).toEqual(frozen.record);
  expect(
    result.projection.projection.nutrition.find(
      (row) => row.planVersionId === frozen.record.versionId,
    )?.items[0]?.before,
  ).toEqual({ state: 'resolved', date: '2026-10-07', localTime: '06:30:00' });
  expect(await inventory(frozen.athlete)).toEqual(before);
});
