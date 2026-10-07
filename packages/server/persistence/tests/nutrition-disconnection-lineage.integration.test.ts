import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  nutritionPlanVersionCompatibleV4Schema,
  nutritionPlanVersionV4Schema,
  saveNutritionPlanV4IntentSchema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import { captureRaceTimingPins } from '../src/race-timing-bindings.js';
import type { RaceTimingPinV1 } from '@workout/contracts/nutrition-race-timing';
import type { NutritionPlanDraft } from '@workout/contracts/nutrition-core';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantNutritionCore,
  grantRaces,
  grantOperations,
} from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import {
  createNutritionRepository,
  createNutritionPlanV4Reader,
  NutritionReadVersionError,
} from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Focused staging only: normal public107 plus explicit unregistered108/109/110.
// This does not prove registry installation, public API activation or restore admission.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `nutrition_lineage_${suffix}`,
  ownerRole = `nutrition_lineage_owner_${suffix}`,
  runtimeRole = `nutrition_lineage_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    const state = await owner.query('SELECT max(version)::int AS version FROM schema_migrations');
    if (state.rows[0]?.['version'] !== 107) throw Error('LINEAGE_EXPECTED_PUBLIC_107');
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
    ])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  } finally {
    await owner.end();
  }
  for (const grant of [grantCorePlanning, grantNutritionCore, grantRaces, grantOperations])
    await grant(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function app(athlete: string, granted: boolean) {
  const repo = createConsentRepository(db);
  const current = await repo.getConsent(athlete, 'app');
  await repo.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: current?.revision ?? 0,
    idempotencyKey: randomUUID(),
  });
}
const values: RaceEventValues = {
  title: 'Synthetic race',
  localDate: '2026-10-07',
  localStartTime: '09:00',
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: null,
  planVersionId: null,
};
function draft(eventId: string, point: 'start' | 'end' = 'start'): NutritionPlanDraft {
  return {
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Own meal schedule',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'meal',
        category: 'before',
        title: 'Meal',
        anchor: { kind: 'relative', entity: 'race', entityId: eventId, point, offsetMinutes: -30 },
        foods: [
          {
            foodVersionId: null,
            description: 'Retained food',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
        ],
        targets: [],
        instructions: 'User-approved meal action',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
}
function intent(eventId: string, revision = 1) {
  return {
    schemaVersion: 2 as const,
    command: {
      kind: 'create' as const,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
      draft: draft(eventId),
    },
    expectedRaceHeads: [{ namespace: 'race-event' as const, eventId, revision }],
  };
}
async function setup() {
  const athlete = randomUUID();
  const offline = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    await offline.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, randomUUID()],
    );
  } finally {
    await offline.end();
  }
  await app(athlete, true);
  const event = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  return { athlete, event, writer: createNutritionRacePlanWriter(db) };
}
async function counts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*) FROM nutrition_plan_version WHERE athlete_id=$1)::int AS versions,(SELECT count(*) FROM nutrition_plan_history WHERE athlete_id=$1)::int AS history,(SELECT count(*) FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'nutrition-plan:%')::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1 AND topic='nutrition.plan_changed')::int AS outbox`,
          [athlete],
        )
      ).rows,
  );
}

/** Explicit offline migration-owner probe, never the application Database port.
 * FORCE RLS and every SQL guard remain enabled. Only existing owned resources are
 * inspected; this helper grants no runtime privileges or positive write authority. */
async function ownerTransaction<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const pool = new Pool({
    connectionString: url(ownerRole),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  try {
    await client.query('BEGIN');
    await client.query(
      "SET LOCAL statement_timeout='5000'; SET LOCAL lock_timeout='3000'; SET LOCAL search_path=pg_catalog,public",
    );
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athlete,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await operation(client);
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw Error('OWNER_PROBE_NOT_COMMITTED');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
async function origin(athlete: string, plan: string, version: string, item: string) {
  return ownerTransaction(athlete, async (client) => {
    const result = await client.query(
      'SELECT public.read_nutrition_disconnection_origin($1,$2,$3) AS present',
      [plan, version, item],
    );
    return z.object({ present: z.boolean() }).strict().parse(result.rows[0]).present;
  });
}
it('public race deletion establishes contentless exact original authority; populated foreign and wrong tuple remain absent', async () => {
  const { athlete, event, writer } = await setup();
  const saved = await writer.savePlanV2(athlete, intent(event.id));
  expect(await origin(athlete, saved.planId, saved.versionId, 'meal')).toBe(false);
  await createRaceRepository(db).deleteRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await origin(athlete, saved.planId, saved.versionId, 'meal')).toBe(true);
  expect(await origin(randomUUID(), saved.planId, saved.versionId, 'meal')).toBe(false);
  expect(await origin(athlete, randomUUID(), saved.versionId, 'meal')).toBe(false);
  expect(await origin(athlete, saved.planId, saved.versionId, 'other')).toBe(false);
});
it('plain owner alone cannot manufacture descendant authority and rollback leaves all public artifacts unchanged', async () => {
  const { athlete, event, writer } = await setup();
  const saved = await writer.savePlanV2(athlete, intent(event.id));
  await createRaceRepository(db).deleteRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const before = await counts(athlete);
  await expect(
    ownerTransaction(athlete, (client) =>
      client.query(
        `INSERT INTO public.nutrition_race_disconnection_lineage
      (athlete_id,plan_id,version_id,version,prior_version_id,prior_version,item_key,item_id,origin_version_id,origin_event_id,prior_row_digest_version,prior_row_digest)
      SELECT $1,$2,$3,2,$4,1,sha256(convert_to('meal','UTF8')),'meal',$4,event_id,'postgres-row-jsonb-utc-v1',repeat('0',64)
      FROM public.nutrition_race_item_disconnection WHERE athlete_id=$1 AND version_id=$4`,
        [athlete, saved.planId, randomUUID(), saved.versionId],
      ),
    ),
  ).rejects.toMatchObject({
    code: '42501',
    message: 'NUTRITION_LINEAGE_COMMIT_PROTOCOL_REQUIRED',
  });
  expect(await counts(athlete)).toEqual(before);
  expect(await origin(athlete, saved.planId, saved.versionId, 'meal')).toBe(true);
});
it('restricted runtime has neither private lineage DML nor origin execute authority until explicit root grant integration', async () => {
  const { athlete } = await setup();
  await expect(
    db.tenant(athlete, (tx) =>
      tx.query('SELECT * FROM public.nutrition_race_disconnection_lineage'),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    db.tenant(athlete, (tx) =>
      tx.query('SELECT public.read_nutrition_disconnection_origin($1,$2,$3)', [
        randomUUID(),
        randomUUID(),
        'meal',
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

async function current(athlete: string, plan: string) {
  return db.tenant(athlete, async (tx) =>
    nutritionPlanVersionCompatibleV4Schema.parse(
      (
        await tx.query(
          'SELECT v.record_json FROM nutrition_plan_head h JOIN nutrition_plan_version v ON v.athlete_id=h.athlete_id AND v.plan_id=h.plan_id AND v.version_id=h.version_id WHERE h.athlete_id=$1 AND h.plan_id=$2',
          [athlete, plan],
        )
      ).rows[0]?.['record_json'],
    ),
  );
}
function preparation(
  prior: NutritionPlanVersionCompatibleV4,
  reconnectItemIds: string[] = [],
  eventId: string | null = null,
  pins: readonly RaceTimingPinV1[] = [],
) {
  const command = {
    kind: 'update',
    planId: prior.planId,
    expectedHeadVersionId: prior.versionId,
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: prior.period,
      timezone: prior.timezone,
      purpose: prior.purpose,
      linkedTrainingPlanVersionId: prior.linkedTrainingPlanVersionId,
      items: prior.items.map(({ planVersionId, ...item }) => {
        void planVersionId;
        return eventId !== null && reconnectItemIds.includes(item.id)
          ? {
              ...item,
              anchor: {
                kind: 'relative',
                entity: 'race',
                entityId: eventId,
                point: 'start',
                offsetMinutes: -30,
              },
            }
          : item;
      }),
    },
  };
  const intent = saveNutritionPlanV4IntentSchema.parse({
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command,
      reconnectItemIds,
      expectedRaceHeads:
        eventId === null
          ? []
          : [{ namespace: 'race-event', eventId, revision: pins[0]?.eventRevision }],
    },
  });
  const versionId = randomUUID();
  const saved = nutritionPlanVersionV4Schema.parse({
    ...intent.intent.command.draft,
    schemaVersion: 4,
    planId: prior.planId,
    versionId,
    version: prior.version + 1,
    previousVersionId: prior.versionId,
    approvalId: randomUUID(),
    approvedAt: new Date().toISOString(),
    items: intent.intent.command.draft.items.map((i) => ({ ...i, planVersionId: versionId })),
    raceTimingPins: pins,
    itemRaceTimingBindings: reconnectItemIds.map((itemId) => ({
      itemId,
      binding: { state: 'captured', eventId, eventRevision: pins[0]?.eventRevision },
    })),
  });
  return {
    request: {
      operation: 'nutrition_plan_save',
      intentSchemaVersion: 4,
      ...intent.intent.command,
      expectedRaceHeads: intent.intent.expectedRaceHeads,
      reconnectItemIds: intent.intent.reconnectItemIds,
    },
    saved,
  };
}
async function commit(
  athlete: string,
  prior: NutritionPlanVersionCompatibleV4,
  p: ReturnType<typeof preparation>,
) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT public.commit_nutrition_plan_v4($1,$2,$3::jsonb,$4::jsonb) AS result',
          [prior.planId, prior.versionId, JSON.stringify(p.request), JSON.stringify(p.saved)],
        )
      ).rows[0]?.['result'],
  );
}
async function authorizeCommit() {
  const pool = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) TO "${runtimeRole}"`,
    );
  } finally {
    await pool.end();
  }
}
async function disconnected() {
  const s = await setup();
  const original = await s.writer.savePlanV2(s.athlete, intent(s.event.id));
  await createRaceRepository(db).deleteRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await authorizeCommit();
  return { ...s, original, prior: await current(s.athlete, original.planId) };
}
it('narrow runtime atomic commit preserves disconnected food/actual history and repeats the same minimal receipt3', async () => {
  const s = await disconnected(),
    p = preparation(s.prior);
  const unknownMetric = <U extends 'g' | 'kcal' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const generation = await ownerTransaction(s.athlete, async (c) =>
    z
      .uuid()
      .parse((await c.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
  );
  const actual = await createNutritionRepository(db).createIntake(s.athlete, {
    idempotencyKey: randomUUID(),
    restoreGeneration: generation,
    intakeId: randomUUID(),
    confirmed: true,
    occurredAt: '2026-10-07T00:00:00Z',
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: null,
        description: 'Actual food',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
    ],
    nutrientTotal: {
      energy: unknownMetric('kcal'),
      carbohydrate: unknownMetric('g'),
      protein: unknownMetric('g'),
      fat: unknownMetric('g'),
      fluid: unknownMetric('mL'),
      sodium: unknownMetric('mg'),
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  const result = await commit(s.athlete, s.prior, p);
  expect(result).toMatchObject({
    receiptVersion: 3,
    outcome: 'committed',
    kind: 'nutrition_plan',
    versionId: p.saved.versionId,
  });
  const saved = await current(s.athlete, s.prior.planId);
  expect(saved).toEqual(p.saved);
  const reader = createNutritionPlanV4Reader(db);
  expect((await reader.readPlanV4(s.athlete, saved.planId))?.head).toEqual(saved);
  expect(
    (await reader.listPlansV4(s.athlete, { ...saved.period, limit: 100, cursor: null })).plans,
  ).toContainEqual(saved);
  await expect(
    createNutritionRepository(db).readPlanV3(s.athlete, saved.planId),
  ).rejects.toBeInstanceOf(NutritionReadVersionError);
  const before = await counts(s.athlete);
  expect(await commit(s.athlete, s.prior, p)).toEqual(result);
  expect(await counts(s.athlete)).toEqual(before);
  expect(await origin(s.athlete, s.prior.planId, saved.versionId, 'meal')).toBe(true);
  const metadata = await ownerTransaction(
    s.athlete,
    async (c) =>
      (
        await c.query(
          'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [s.athlete, 'nutrition-plan:' + p.request.idempotencyKey],
        )
      ).rows,
  );
  expect(JSON.stringify(metadata)).not.toContain(s.event.id);
  expect(JSON.stringify(metadata)).not.toContain('raceTimingPins');
  expect(saved.items[0]?.foods).toEqual(s.prior.items[0]?.foods);
  expect(await createNutritionRepository(db).readIntake(s.athlete, actual.intakeId)).toEqual(
    actual,
  );
});
it('retained descendant -> explicit reconnect/reapproval -> later deletion establishes new original origin and stops timing', async () => {
  const s = await disconnected();
  const first = preparation(s.prior);
  await commit(s.athlete, s.prior, first);
  const prior = await current(s.athlete, s.prior.planId);
  const nextRace = await createRaceRepository(db).createRaceEvent(s.athlete, {
    idempotencyKey: randomUUID(),
    values: { ...values, title: 'Explicit reconnect' },
  });
  const pins = await db.tenant(s.athlete, (tx) =>
    captureRaceTimingPins(tx, [
      { namespace: 'race-event', eventId: nextRace.id, revision: nextRace.revision },
    ]),
  );
  const p = preparation(prior, ['meal'], nextRace.id, pins);
  await commit(s.athlete, prior, p);
  expect((await current(s.athlete, prior.planId)).items[0]?.anchor.kind).toBe('relative');
  await createRaceRepository(db).deleteRaceEvent(s.athlete, nextRace.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const after = await current(s.athlete, prior.planId);
  expect(after).toMatchObject({ schemaVersion: 4, raceTimingPins: [], itemRaceTimingBindings: [] });
  expect(after.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
  expect(await origin(s.athlete, prior.planId, after.versionId, 'meal')).toBe(true);
  const marker = await ownerTransaction(
    s.athlete,
    async (c) =>
      (
        await c.query(
          'SELECT e.target_id FROM nutrition_race_item_disconnection d JOIN restore_suppression_event e ON e.event_id=d.event_id WHERE d.athlete_id=$1 AND d.version_id=$2',
          [s.athlete, after.versionId],
        )
      ).rows,
  );
  expect(marker).toEqual([{ target_id: nextRace.id }]);
});
it('missing explicit reconnect, foreign source, stale CAS and account/app withdrawal cannot mint a descendant', async () => {
  const s = await disconnected(),
    before = await counts(s.athlete);
  const race = await createRaceRepository(db).createRaceEvent(s.athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  const pins = await db.tenant(s.athlete, (tx) =>
    captureRaceTimingPins(tx, [{ namespace: 'race-event', eventId: race.id, revision: 1 }]),
  );
  const p = preparation(s.prior, ['meal'], race.id, pins);
  await expect(
    commit(s.athlete, s.prior, { ...p, request: { ...p.request, reconnectItemIds: [] } }),
  ).rejects.toThrow('NUTRITION_V4_RECONNECT_REQUIRED');
  await expect(commit(randomUUID(), s.prior, p)).rejects.toThrow('NUTRITION_V4_ACCOUNT_REQUIRED');
  await expect(commit(s.athlete, { ...s.prior, versionId: randomUUID() }, p)).rejects.toThrow();
  await app(s.athlete, false);
  await expect(commit(s.athlete, s.prior, p)).rejects.toThrow('APP_CONSENT_REQUIRED');
  expect(await counts(s.athlete)).toEqual(before);
});
it('plain owner/context GUC cannot authorize commit or manufacture private seal', async () => {
  const s = await disconnected(),
    p = preparation(s.prior),
    before = await counts(s.athlete);
  await expect(
    ownerTransaction(s.athlete, (c) =>
      c.query('SELECT public.commit_nutrition_plan_v4($1,$2,$3::jsonb,$4::jsonb)', [
        s.prior.planId,
        s.prior.versionId,
        JSON.stringify(p.request),
        JSON.stringify(p.saved),
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    ownerTransaction(s.athlete, async (c) => {
      await c.query("SELECT set_config('app.nutrition_commit','true',true)");
      return c.query(
        "INSERT INTO nutrition_v4_commit_seal VALUES($1,$2,$3,$4,session_user,txid_current(),1,'forged',repeat('0',64),repeat('0',64),clock_timestamp()+interval '1 minute')",
        [s.athlete, p.saved.versionId, s.prior.planId, s.prior.versionId],
      );
    }),
  ).rejects.toMatchObject({ code: '42501' });
  expect(await counts(s.athlete)).toEqual(before);
});
it('forced rollback after function return leaves version/head/history/receipt/outbox/lineage unchanged', async () => {
  const s = await disconnected(),
    p = preparation(s.prior),
    before = await counts(s.athlete);
  await expect(
    db.tenant(s.athlete, async (tx) => {
      await tx.query('SELECT public.commit_nutrition_plan_v4($1,$2,$3::jsonb,$4::jsonb)', [
        s.prior.planId,
        s.prior.versionId,
        JSON.stringify(p.request),
        JSON.stringify(p.saved),
      ]);
      throw Error('synthetic rollback');
    }),
  ).rejects.toThrow('synthetic rollback');
  expect(await counts(s.athlete)).toEqual(before);
  expect(await current(s.athlete, s.prior.planId)).toEqual(s.prior);
});
it('expired deferred seal cannot commit all artifacts even after valid function return', async () => {
  const s = await disconnected(),
    p = preparation(s.prior),
    before = await counts(s.athlete);
  await expect(
    db.tenant(s.athlete, async (tx) => {
      await tx.query('SELECT public.commit_nutrition_plan_v4($1,$2,$3::jsonb,$4::jsonb)', [
        s.prior.planId,
        s.prior.versionId,
        JSON.stringify(p.request),
        JSON.stringify(p.saved),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 31000));
    }),
  ).rejects.toThrow('NUTRITION_V4_ATOMIC_CORRESPONDENCE_REQUIRED');
  expect(await counts(s.athlete)).toEqual(before);
}, 40000);

it('actual same-race old/new revision multipin keeps untouched timing and captures only changed item', async () => {
  const s = await setup();
  await authorizeCommit();
  const initialDraft = draft(s.event.id),
    first = initialDraft.items[0];
  if (!first) throw Error('fixture item');
  const initialIntent = intent(s.event.id);
  const prior = await s.writer.savePlanV2(s.athlete, {
    ...initialIntent,
    command: {
      ...initialIntent.command,
      draft: { ...initialDraft, items: [first, { ...first, id: 'second' }] },
    },
  });
  const updated = await createRaceRepository(db).updateRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, localStartTime: '10:00' },
  });
  const pins = await db.tenant(s.athlete, (tx) =>
    captureRaceTimingPins(tx, [
      { namespace: 'race-event', eventId: s.event.id, revision: updated.revision },
    ]),
  );
  const old = nutritionPlanVersionV4Schema.shape.raceTimingPins.parse(
      'raceTimingPins' in prior ? prior.raceTimingPins : [],
    ),
    versionId = randomUUID();
  const rawDraft = {
    period: prior.period,
    timezone: prior.timezone,
    purpose: prior.purpose,
    linkedTrainingPlanVersionId: prior.linkedTrainingPlanVersionId,
    items: prior.items.map(({ planVersionId, ...item }) => {
      void planVersionId;
      return item.id === 'second'
        ? {
            ...item,
            anchor: {
              kind: 'relative',
              entity: 'race',
              entityId: s.event.id,
              point: 'start',
              offsetMinutes: -60,
            },
          }
        : item;
    }),
  };
  const valid = saveNutritionPlanV4IntentSchema.parse({
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        planId: prior.planId,
        expectedHeadVersionId: prior.versionId,
        confirmed: true,
        idempotencyKey: randomUUID(),
        draft: rawDraft,
      },
      expectedRaceHeads: [
        { namespace: 'race-event', eventId: s.event.id, revision: updated.revision },
      ],
      reconnectItemIds: [],
    },
  });
  const saved = nutritionPlanVersionV4Schema.parse({
    ...valid.intent.command.draft,
    schemaVersion: 4,
    planId: prior.planId,
    versionId,
    version: 2,
    previousVersionId: prior.versionId,
    approvalId: randomUUID(),
    approvedAt: new Date().toISOString(),
    items: valid.intent.command.draft.items.map((i) => ({ ...i, planVersionId: versionId })),
    raceTimingPins: [...old, ...pins],
    itemRaceTimingBindings: [
      { itemId: 'meal', binding: { state: 'captured', eventId: s.event.id, eventRevision: 1 } },
      { itemId: 'second', binding: { state: 'captured', eventId: s.event.id, eventRevision: 2 } },
    ],
  });
  const p = {
    saved,
    request: {
      operation: 'nutrition_plan_save',
      intentSchemaVersion: 4,
      ...valid.intent.command,
      expectedRaceHeads: valid.intent.expectedRaceHeads,
      reconnectItemIds: [],
    },
  };
  await commit(s.athlete, prior, p);
  expect(await current(s.athlete, prior.planId)).toEqual(saved);
  expect(saved.raceTimingPins[0]).toEqual(old[0]);
  await createRaceRepository(db).deleteRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const after = await current(s.athlete, prior.planId);
  expect(after).toMatchObject({ schemaVersion: 4, raceTimingPins: [], itemRaceTimingBindings: [] });
  expect(after.items.every((i) => i.anchor.kind === 'disconnected')).toBe(true);
});
it.each(['nutrition_plan_history', 'command_receipt', 'outbox'] as const)(
  'runtime cannot remove %s from a pending atomic commit; rollback preserves every ledger',
  async (table) => {
    const s = await disconnected(),
      p = preparation(s.prior),
      before = await counts(s.athlete);
    await expect(
      db.tenant(s.athlete, async (tx) => {
        await tx.query('SELECT public.commit_nutrition_plan_v4($1,$2,$3::jsonb,$4::jsonb)', [
          s.prior.planId,
          s.prior.versionId,
          JSON.stringify(p.request),
          JSON.stringify(p.saved),
        ]);
        await tx.query(`DELETE FROM ${table} WHERE athlete_id=$1`, [s.athlete]);
      }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await counts(s.athlete)).toEqual(before);
  },
);

it('authenticated erasure removes original markers, descendant lineage and command seals without residual orphan rows', async () => {
  const s = await disconnected(),
    p = preparation(s.prior);
  await commit(s.athlete, s.prior, p);
  await createOperationsRepository(db).eraseAccount(s.athlete);
  const pool = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [s.athlete]);
      const result = await c.query(
        'SELECT (SELECT count(*) FROM nutrition_race_disconnection_lineage WHERE athlete_id=$1)::int AS lineage,(SELECT count(*) FROM nutrition_v4_commit_seal WHERE athlete_id=$1)::int AS seals,(SELECT count(*) FROM nutrition_race_item_disconnection WHERE athlete_id=$1)::int AS markers',
        [s.athlete],
      );
      expect(result.rows).toEqual([{ lineage: 0, seals: 0, markers: 0 }]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
});

it('accepts explicit reconnect and binding order for supplementary/BMP opaque IDs using contract UTF16 ordering', async () => {
  const s = await setup();
  const ids = ['\u{10000}', '\uE000'];
  expect((ids[0] ?? '') < (ids[1] ?? '')).toBe(true);
  const initial = draft(s.event.id);
  const item = initial.items[0];
  if (!item) throw Error('MISSING_SYNTHETIC_ITEM');
  const command = intent(s.event.id);
  const original = await s.writer.savePlanV2(s.athlete, {
    ...command,
    command: {
      ...command.command,
      draft: { ...initial, items: ids.map((id) => ({ ...item, id })) },
    },
  });
  await createRaceRepository(db).deleteRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const prior = await current(s.athlete, original.planId);
  await authorizeCommit();
  const race = await createRaceRepository(db).createRaceEvent(s.athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  const pins = await db.tenant(s.athlete, (tx) =>
    captureRaceTimingPins(tx, [{ namespace: 'race-event', eventId: race.id, revision: 1 }]),
  );
  const p = preparation(prior, ids, race.id, pins);
  const before = await counts(s.athlete);
  await expect(
    commit(s.athlete, prior, {
      ...p,
      request: { ...p.request, idempotencyKey: randomUUID(), reconnectItemIds: [...ids].reverse() },
    }),
  ).rejects.toThrow('NUTRITION_V4_RECONNECT_MEMBERSHIP');
  expect(await counts(s.athlete)).toEqual(before);
  expect(await commit(s.athlete, prior, p)).toMatchObject({
    receiptVersion: 3,
    versionId: p.saved.versionId,
  });
  expect((await current(s.athlete, original.planId)).items.map((i) => i.id)).toEqual(ids);
  await app(s.athlete, false);
  expect(
    (await createNutritionPlanV4Reader(db).readPlanV4(s.athlete, original.planId))?.head,
  ).toEqual(p.saved);
});
