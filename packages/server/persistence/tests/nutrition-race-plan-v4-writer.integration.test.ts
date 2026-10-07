import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  saveNutritionPlanV4IntentSchema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import type { SaveNutritionPlanV3Intent } from '@workout/contracts/nutrition-race-plan-v3';
import type { NutritionPlanDraft } from '@workout/contracts/nutrition-core';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantNutritionCore,
  grantRaces,
  grantOperations,
  grantRecoveryCore,
  grantRoutineCore,
  grantSupplementaryCore,
  grantStretchingCore,
} from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { createIntegratedPlannerRepository } from '../src/integrated-planner.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository, createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Focused staging only: normal public107 plus explicit unregistered108/109/110.
// This does not prove registry installation, public API activation or restore admission.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `nutrition_v4_writer_${suffix}`,
  ownerRole = `nutrition_v4_writer_owner_${suffix}`,
  runtimeRole = `nutrition_v4_writer_app_${suffix}`;
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
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.read_nutrition_disconnection_origin(uuid,uuid,text),public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) TO "${runtimeRole}"`,
    );
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantNutritionCore,
    grantRaces,
    grantOperations,
    grantRecoveryCore,
    grantRoutineCore,
    grantSupplementaryCore,
    grantStretchingCore,
  ])
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

function update(
  prior: NutritionPlanVersionCompatibleV4,
  options: {
    items?: SaveNutritionPlanV3Intent['command']['draft']['items'];
    eventId?: string;
    revision?: number;
    reconnect?: string[];
    key?: string;
  } = {},
) {
  return saveNutritionPlanV4IntentSchema.parse({
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        planId: prior.planId,
        expectedHeadVersionId: prior.versionId,
        idempotencyKey: options.key ?? randomUUID(),
        confirmed: true,
        draft: {
          period: prior.period,
          timezone: prior.timezone,
          purpose: prior.purpose,
          linkedTrainingPlanVersionId: prior.linkedTrainingPlanVersionId,
          items:
            options.items ??
            prior.items.map(({ planVersionId, ...item }) => {
              void planVersionId;
              return item;
            }),
        },
      },
      expectedRaceHeads:
        options.eventId === undefined
          ? []
          : [
              {
                namespace: 'race-event',
                eventId: options.eventId,
                revision: options.revision ?? 1,
              },
            ],
      reconnectItemIds: options.reconnect ?? [],
    },
  });
}
async function read(athlete: string, plan: string) {
  const result = await createNutritionPlanV4Reader(db).readPlanV4(athlete, plan);
  if (result === null || result.head === null) throw Error('EXPECTED_OWNED_PLAN');
  return result.head;
}
async function disconnected() {
  const s = await setup();
  const initial = await s.writer.savePlanV2(s.athlete, intent(s.event.id));
  await createRaceRepository(db).deleteRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  return {
    ...s,
    initial,
    prior: await read(s.athlete, initial.planId),
    v4: createNutritionRacePlanV4Writer(db),
  };
}
async function counts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT
    (SELECT count(*) FROM nutrition_plan_version WHERE athlete_id=$1)::int AS versions,
    (SELECT count(*) FROM nutrition_plan_history WHERE athlete_id=$1)::int AS history,
    (SELECT count(*) FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'nutrition-plan:%')::int AS receipts,
    (SELECT count(*) FROM outbox WHERE athlete_id=$1 AND topic='nutrition.plan_changed')::int AS outbox`,
          [athlete],
        )
      ).rows,
  );
}

it('actual writer retains disconnected V4 and reader returns original food zero/null and independent actual intake', async () => {
  const s = await disconnected();
  const unknownMetric = <U extends 'g' | 'kcal' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const generation = await db.tenant(s.athlete, async (tx) =>
    z
      .uuid()
      .parse((await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
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
        description: 'Actual zero',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
      {
        foodVersionId: null,
        description: 'Actual unknown',
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'unknown',
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
  const result = await s.v4.savePlanV4(s.athlete, update(s.prior));
  expect(result.plan).toMatchObject({ schemaVersion: 4, previousVersionId: s.prior.versionId });
  expect(result.plan.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
  expect(result.plan.items[0]?.foods).toEqual(s.prior.items[0]?.foods);
  expect(result.notices).toEqual([]);
  await suspendedV5(s.athlete, result.plan);
  expect(await read(s.athlete, s.initial.planId)).toEqual(result.plan);
  expect(
    (
      await createNutritionPlanV4Reader(db).listPlansV4(s.athlete, {
        ...result.plan.period,
        limit: 100,
        cursor: null,
      })
    ).plans,
  ).toContainEqual(result.plan);
  expect(await createNutritionRepository(db).readIntake(s.athlete, actual.intakeId)).toEqual(
    actual,
  );
});
it('actual explicit reconnection and same-event two-revision multipin preserve untouched frozen pin; subsequent deletion suspends both', async () => {
  const s = await disconnected();
  const retained = await s.v4.savePlanV4(s.athlete, update(s.prior));
  const event = await createRaceRepository(db).createRaceEvent(s.athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  const base = draft(event.id);
  const meal = base.items[0];
  if (!meal) throw Error('EXPECTED_MEAL');
  const items = [meal, { ...meal, id: 'second', title: 'Second meal' }];
  const connected = await s.v4.savePlanV4(
    s.athlete,
    update(retained.plan, { items, eventId: event.id, reconnect: ['meal'] }),
  );
  const firstPin = 'schemaVersion' in connected.plan ? connected.plan.raceTimingPins[0] : undefined;
  expect(firstPin).toMatchObject({ eventId: event.id, eventRevision: 1 });
  const connectedRead = await operational(s.athlete);
  expect(connectedRead.nutritionOperationalStates).toEqual([]);
  expect(
    connectedRead.days.flatMap((day) =>
      day.nutritionItems.map((item) => ({ id: item.id, time: item.localTime })),
    ),
  ).toEqual([
    { id: 'meal', time: '08:30:00' },
    { id: 'second', time: '08:30:00' },
  ]);
  const changed = await createRaceRepository(db).updateRaceEvent(s.athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, localStartTime: '10:00' },
  });
  const proposed = connected.plan.items.map(({ planVersionId, ...item }) => {
    void planVersionId;
    if (item.source !== 'user_confirmed') throw Error('EXPECTED_USER_SOURCE');
    const source = item.source;
    return item.id === 'second'
      ? {
          ...item,
          source,
          anchor: {
            kind: 'relative' as const,
            entity: 'race' as const,
            entityId: event.id,
            point: 'start' as const,
            offsetMinutes: -60,
          },
        }
      : { ...item, source };
  });
  const saved = await s.v4.savePlanV4(
    s.athlete,
    update(connected.plan, { items: proposed, eventId: event.id, revision: changed.revision }),
  );
  if (!('schemaVersion' in saved.plan)) throw Error('EXPECTED_V4');
  expect(saved.plan.raceTimingPins).toHaveLength(2);
  expect(saved.plan.raceTimingPins[0]).toEqual(firstPin);
  expect(saved.plan.raceTimingPins.map((p) => p.eventRevision)).toEqual([1, 2]);
  const multipinRead = await operational(s.athlete);
  expect(multipinRead.nutritionOperationalStates).toEqual([]);
  expect(
    multipinRead.days.flatMap((day) =>
      day.nutritionItems.map((item) => ({ id: item.id, time: item.localTime })),
    ),
  ).toEqual([
    { id: 'meal', time: '08:30:00' },
    { id: 'second', time: '09:00:00' },
  ]);
  await createRaceRepository(db).deleteRaceEvent(s.athlete, event.id, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const deleted = await read(s.athlete, s.initial.planId);
  if (!('schemaVersion' in deleted)) throw Error('EXPECTED_REDACTED_V4');
  expect(deleted.schemaVersion).toBe(4);
  await suspendedV5(s.athlete, deleted);
  expect(deleted.raceTimingPins).toEqual([]);
  expect(deleted.itemRaceTimingBindings).toEqual([]);
  expect(deleted.items.map((i) => i.anchor)).toEqual([
    { kind: 'disconnected', entity: 'race' },
    { kind: 'disconnected', entity: 'race' },
  ]);
  expect(deleted.items.map((i) => i.foods)).toEqual(saved.plan.items.map((i) => i.foods));
  const again = await s.v4.savePlanV4(s.athlete, update(deleted));
  expect(again.plan.items.map((i) => i.anchor)).toEqual(deleted.items.map((i) => i.anchor));
});
it('receipt3 replay after app withdrawal returns exact original version and notices rather than latest head', async () => {
  const s = await disconnected();
  const input = update(s.prior);
  const first = await s.v4.savePlanV4(s.athlete, input);
  const next = await s.v4.savePlanV4(s.athlete, update(first.plan));
  expect(next.plan.versionId).not.toBe(first.plan.versionId);
  const before = await counts(s.athlete);
  await app(s.athlete, false);
  expect(await s.v4.savePlanV4(s.athlete, input)).toEqual(first);
  expect(await counts(s.athlete)).toEqual(before);
  const receipt = await db.tenant(
    s.athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [s.athlete, `nutrition-plan:${input.intent.command.idempotencyKey}`],
        )
      ).rows[0],
  );
  expect(receipt).toMatchObject({
    request: { receiptVersion: 3 },
    result: { receiptVersion: 3, versionId: first.plan.versionId },
  });
  await expect(s.v4.savePlanV4(s.athlete, update(next.plan))).rejects.toThrow();
  expect(await counts(s.athlete)).toEqual(before);
});
it('idempotency key collision rejects altered draft and preserves all approval artifacts', async () => {
  const s = await disconnected();
  const input = update(s.prior);
  await s.v4.savePlanV4(s.athlete, input);
  const before = await counts(s.athlete);
  const different = saveNutritionPlanV4IntentSchema.parse({
    ...input,
    intent: {
      ...input.intent,
      command: {
        ...input.intent.command,
        draft: { ...input.intent.command.draft, purpose: 'Different' },
      },
    },
  });
  await expect(s.v4.savePlanV4(s.athlete, different)).rejects.toThrow();
  expect(await counts(s.athlete)).toEqual(before);
});
it('CAS conflict and populated foreign account cannot approve the owned plan', async () => {
  const s = await disconnected();
  const stale = update(s.prior);
  await s.v4.savePlanV4(s.athlete, update(s.prior));
  const before = await counts(s.athlete);
  await expect(s.v4.savePlanV4(s.athlete, stale)).rejects.toThrow();
  const foreign = await setup();
  await expect(s.v4.savePlanV4(foreign.athlete, stale)).rejects.toThrow();
  expect(await counts(s.athlete)).toEqual(before);
  expect(await counts(foreign.athlete)).toEqual([
    { versions: 0, history: 0, receipts: 0, outbox: 0 },
  ]);
});
it('relative race draft alone never reconnects an original deleted item', async () => {
  const s = await disconnected();
  const event = await createRaceRepository(db).createRaceEvent(s.athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  const before = await counts(s.athlete);
  await expect(
    s.v4.savePlanV4(
      s.athlete,
      update(s.prior, { items: draft(event.id).items, eventId: event.id }),
    ),
  ).rejects.toMatchObject({ code: 'NUTRITION_V4_RECONNECT_REQUIRED' });
  expect(await counts(s.athlete)).toEqual(before);
});
it('runtime public seams grant neither private marker/lineage/seal reads nor writes', async () => {
  const s = await disconnected();
  for (const table of [
    'nutrition_race_item_disconnection',
    'nutrition_race_disconnection_lineage',
    'nutrition_v4_commit_seal',
  ]) {
    await expect(
      db.tenant(s.athlete, (tx) => tx.query(`SELECT * FROM public.${table}`)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.tenant(s.athlete, (tx) => tx.query(`DELETE FROM public.${table}`)),
    ).rejects.toMatchObject({ code: '42501' });
  }
});

async function operational(athlete: string) {
  return createIntegratedPlannerRepository(db).readV5(athlete, {
    from: '2026-10-07',
    toExclusive: '2026-10-08',
    timezone: 'UTC',
  });
}
async function suspendedV5(athlete: string, plan: NutritionPlanVersionCompatibleV4) {
  const value = await operational(athlete);
  expect(value.days.flatMap((day) => day.nutritionItems)).toEqual([]);
  expect(value.nutritionOperationalStates).toEqual(
    plan.items.map((item) => ({
      planVersionId: plan.versionId,
      itemId: item.id,
      state: 'suspended',
      reason: 'race_disconnected',
    })),
  );
  expect(value.unresolvedNutritionItems).toHaveLength(plan.items.length);
}

function promiseGate() {
  let open: () => void = () => {
    throw Error('GATE_NOT_INITIALIZED');
  };
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function transactionDatabase(tx: Transaction): Database {
  const tenant: Database['tenant'] = async (athlete, operation) => {
    if (athlete !== tx.athleteId) throw Error('TRANSACTION_TENANT_MISMATCH');
    return operation(tx);
  };
  return { tenant, exclusiveTenant: tenant, close: async () => {} };
}
/** Existing runtime tenant transaction holds the real tenant command lock. The
 * second producer announces its actual lock query, then waits for commit. No
 * sleep, fabricated source facts, private privilege or disabled SQL guard. */
async function firstCommitted<T, U>(
  athlete: string,
  first: (database: Database) => Promise<T>,
  second: (database: Database) => Promise<U>,
) {
  const ready = promiseGate(),
    release = promiseGate(),
    offered = promiseGate();
  const observedTenant: Database['tenant'] = (id, operation) =>
    db.tenant(id, (tx) =>
      operation({
        athleteId: tx.athleteId,
        query(sql, values) {
          if (/pg_advisory_xact_lock\(hashtextextended\(\$1,\s*0\)\)/.test(sql)) offered.open();
          return tx.query(sql, values);
        },
      }),
    );
  const observed: Database = {
    tenant: observedTenant,
    exclusiveTenant: db.exclusiveTenant,
    close: async () => {},
  };
  const firstResult = db.tenant(athlete, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    const value = await first(transactionDatabase(tx));
    ready.open();
    await release.promise;
    return value;
  });
  // Surface fixture errors before waiting for a query that cannot be offered.
  await Promise.race([
    ready.promise,
    firstResult.then(() => {
      throw Error('FIRST_GATE_MISSING');
    }),
  ]);
  const secondResult = second(observed);
  try {
    await Promise.race([
      offered.promise,
      secondResult.then(
        () => {
          throw Error('SECOND_GATE_MISSING');
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
  } finally {
    release.open();
  }
  return Promise.allSettled([firstResult, secondResult]);
}

it('simultaneous identical intents with opaque Unicode origins return one exact approval; distinct commands compete on CAS', async () => {
  const s = await setup(),
    raw = draft(s.event.id),
    meal = raw.items[0];
  if (!meal) throw Error('EXPECTED_MEAL');
  const ids = ['𐀀', '\uE000'];
  const initial = await s.writer.savePlanV2(s.athlete, {
    ...intent(s.event.id),
    command: {
      ...intent(s.event.id).command,
      draft: { ...raw, items: ids.map((id) => ({ ...meal, id })) },
    },
  });
  await createRaceRepository(db).deleteRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const prior = await read(s.athlete, initial.planId),
    writer = createNutritionRacePlanV4Writer(db),
    input = update(prior);
  const before = await counts(s.athlete);
  const [left, right] = await Promise.all([
    writer.savePlanV4(s.athlete, input),
    writer.savePlanV4(s.athlete, input),
  ]);
  expect(left).toEqual(right);
  expect(left.plan.items.map((i) => i.id)).toEqual(ids);
  const after = await counts(s.athlete);
  expect(after).toEqual(
    before.map((row) => ({
      versions: Number(row['versions']) + 1,
      history: Number(row['history']) + 1,
      receipts: Number(row['receipts']) + 1,
      outbox: Number(row['outbox']) + 1,
    })),
  );
  const event = await createRaceRepository(db).createRaceEvent(s.athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  const reconnectItems = ids.map((id) => ({
    ...meal,
    id,
    anchor: {
      kind: 'relative' as const,
      entity: 'race' as const,
      entityId: event.id,
      point: 'start' as const,
      offsetMinutes: -30,
    },
  }));
  const connected = await writer.savePlanV4(
    s.athlete,
    update(left.plan, { items: reconnectItems, eventId: event.id, reconnect: [...ids].sort() }),
  );
  expect(connected.plan.items.map((i) => i.id)).toEqual(ids);
  const a = update(connected.plan, { eventId: event.id }),
    b = update(connected.plan, { eventId: event.id });
  const beforeCAS = await counts(s.athlete);
  const results = await Promise.allSettled([
    writer.savePlanV4(s.athlete, a),
    writer.savePlanV4(s.athlete, b),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((r) => r.status === 'rejected');
  if (!rejected || rejected.status !== 'rejected') throw Error('EXPECTED_CAS_REJECTION');
  expect(rejected.reason).toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await counts(s.athlete)).toEqual(
    beforeCAS.map((row) => ({
      versions: Number(row['versions']) + 1,
      history: Number(row['history']) + 1,
      receipts: Number(row['receipts']) + 1,
      outbox: Number(row['outbox']) + 1,
    })),
  );
});

it('write and app withdrawal serialize in both orders using the actual transaction lock', async () => {
  for (const writeFirst of [true, false]) {
    const s = await disconnected(),
      input = update(s.prior),
      before = await counts(s.athlete);
    const revision = (await createConsentRepository(db).getConsent(s.athlete, 'app'))?.revision;
    if (revision === undefined) throw Error('EXPECTED_APP_HEAD');
    const write = (database: Database) =>
      createNutritionRacePlanV4Writer(database).savePlanV4(s.athlete, input);
    const withdraw = (database: Database) =>
      createConsentRepository(database).setConsent(s.athlete, {
        kind: 'app',
        granted: false,
        expectedRevision: revision,
        idempotencyKey: randomUUID(),
      });
    if (writeFirst) {
      const outcomes = await firstCommitted(s.athlete, write, withdraw);
      expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const saved = outcomes[0];
      if (saved?.status !== 'fulfilled') throw Error('EXPECTED_SAVED');
      expect(await createNutritionRacePlanV4Writer(db).savePlanV4(s.athlete, input)).toEqual(
        saved.value,
      );
      expect(await counts(s.athlete)).toEqual(
        before.map((row) => ({
          versions: Number(row['versions']) + 1,
          history: Number(row['history']) + 1,
          receipts: Number(row['receipts']) + 1,
          outbox: Number(row['outbox']) + 1,
        })),
      );
    } else {
      const outcomes = await firstCommitted(s.athlete, withdraw, write);
      expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      const failed = outcomes[1];
      if (failed?.status !== 'rejected') throw Error('EXPECTED_BLOCKED');
      expect(failed.reason).toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
      expect(await counts(s.athlete)).toEqual(before);
    }
    expect((await createConsentRepository(db).getConsent(s.athlete, 'app'))?.granted).toBe(false);
  }
});

it('new race source save and deletion serialize: save-first is redacted, deletion-first cannot capture a removed source', async () => {
  for (const saveFirst of [true, false]) {
    const s = await disconnected(),
      event = await createRaceRepository(db).createRaceEvent(s.athlete, {
        idempotencyKey: randomUUID(),
        values,
      });
    const input = update(s.prior, {
        items: draft(event.id).items,
        eventId: event.id,
        reconnect: ['meal'],
      }),
      before = await counts(s.athlete);
    const save = (database: Database) =>
      createNutritionRacePlanV4Writer(database).savePlanV4(s.athlete, input);
    const remove = (database: Database) =>
      createRaceRepository(database).deleteRaceEvent(s.athlete, event.id, {
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
    if (saveFirst) {
      const outcomes = await firstCommitted(s.athlete, save, remove);
      expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const head = await read(s.athlete, s.initial.planId);
      expect(head.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
      if (!('schemaVersion' in head)) throw Error('EXPECTED_V4');
      expect(head.raceTimingPins).toEqual([]);
      expect(head.itemRaceTimingBindings).toEqual([]);
    } else {
      const outcomes = await firstCommitted(s.athlete, remove, save);
      expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(await counts(s.athlete)).toEqual(before);
      expect(await read(s.athlete, s.initial.planId)).toEqual(s.prior);
    }
  }
});

it('normal manual session producer with explicitly unknown time retains nonempty unresolved notices on original receipt replay', async () => {
  const s = await setup();
  const training = await createPlanningRepository(db).save(s.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      title: 'User planned session with unknown time',
      timezone: 'UTC',
      periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
        id: level,
        parentId: index === 0 ? null : (levels[index - 1] ?? null),
        level,
        title: level,
        startDate: '2026-10-07',
        endDateExclusive: '2026-10-09',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'session',
          blockId: 'block',
          date: '2026-10-07',
          localStartTime: null,
          title: 'Untimed user session',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: null,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
  const meal = draft(s.event.id).items[0];
  if (!meal) throw Error('EXPECTED_MEAL');
  const prior = await createNutritionRepository(db).savePlan(s.athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      ...draft(s.event.id),
      linkedTrainingPlanVersionId: training.id,
      items: [
        {
          ...meal,
          anchor: {
            kind: 'relative',
            entity: 'session',
            entityId: 'session',
            point: 'start',
            offsetMinutes: -30,
          },
        },
      ],
    },
  });
  const input = update(prior),
    writer = createNutritionRacePlanV4Writer(db),
    first = await writer.savePlanV4(s.athlete, input);
  expect(first.notices).toEqual([{ itemId: 'meal', code: 'UNRESOLVED_PRESERVED' }]);
  const operationalRead = await operational(s.athlete);
  expect(operationalRead.days.flatMap((day) => day.nutritionItems)).toEqual([]);
  expect(operationalRead.unresolvedNutritionItems).toHaveLength(1);
  const next = await writer.savePlanV4(s.athlete, update(first.plan));
  expect(next.plan.versionId).not.toBe(first.plan.versionId);
  await app(s.athlete, false);
  const before = await counts(s.athlete);
  expect(await writer.savePlanV4(s.athlete, input)).toEqual(first);
  expect(await counts(s.athlete)).toEqual(before);
});
