import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  saveNutritionPlanV4IntentSchema,
  nutritionPlanVersionV4Schema,
  type NutritionPlanVersionV4,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import type { SaveNutritionPlanV3Intent } from '@workout/contracts/nutrition-race-plan-v3';
import type { NutritionPlanDraft } from '@workout/contracts/nutrition-core';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV6 } from '../src/current-runtime-installation-v6.js';
import { grantCurrentRuntimeV6Profile } from '../src/current-runtime-grants-v6.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { planDraftSchema } from '@workout/contracts/planning';
import { createOperationsV38BatchRepository } from '../src/operations.js';
import { createPlanningRepository } from '../src/planning.js';
import { createIntegratedPlannerRepository } from '../src/integrated-planner.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository, createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root-only PG: normal107 + named V6/profile22, then explicit raw133.
// No installer/registry activation, transitive security or restore admission proof.
// Runtime public producers own all domain bodies. Owner writes identity FK scaffolding only.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `nutrition_index_${suffix}`,
  ownerRole = `nutrition_index_owner_${suffix}`,
  runtimeRole = `nutrition_index_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
let migration: string;
let originalMetadata: unknown;
let originalDefinitions: { commit: string; validator: string };
async function metadata(owner: Pool) {
  return (
    await owner.query(`SELECT to_jsonb(p)-'prosrc' AS metadata FROM pg_catalog.pg_proc p
   WHERE p.oid=ANY(ARRAY['public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure,
                       'public.assert_nutrition_disconnect_body(jsonb)'::regprocedure]) ORDER BY p.oid`)
  ).rows;
}
async function offline<T>(operation: (owner: Pool) => Promise<T>) {
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    return await operation(owner);
  } finally {
    await owner.end();
  }
}
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
  await installCurrentRuntimeV6(url(ownerRole));
  await grantCurrentRuntimeAppBaselineV2(url(ownerRole), runtimeRole, 'core');
  await grantCurrentRuntimeV6Profile(url(ownerRole), runtimeRole);
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    originalMetadata = await metadata(owner);
    const defs =
      await owner.query(`SELECT pg_get_functiondef('public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure) AS commit,
      pg_get_functiondef('public.assert_nutrition_disconnect_body(jsonb)'::regprocedure) AS validator`);
    originalDefinitions = z
      .strictObject({ commit: z.string(), validator: z.string() })
      .parse(defs.rows[0]);
    migration = await readFile(
      new URL('../migrations/133_nutrition_v4_indexed_application.sql', import.meta.url),
      'utf8',
    );
    await owner.query(migration);
    expect(await metadata(owner)).toEqual(originalMetadata);
    expect(
      (await owner.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]?.['v'],
    ).toBe(107);
    expect(
      (await owner.query('SELECT count(*)::int AS n FROM wm_runtime_installation.migration'))
        .rows[0]?.['n'],
    ).toBe(17);
  } finally {
    await owner.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
}, 60000);
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

async function tenantAccount() {
  const athlete = randomUUID();
  await offline((owner) =>
    owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, randomUUID()],
    ),
  );
  await app(athlete, true);
  return athlete;
}
async function applicationFixture() {
  const athlete = await tenantAccount();

  const draft = planDraftSchema.parse({
    title: 'Export planned',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, ids) => ({
      id: level,
      parentId: index ? ids[index - 1] : null,
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [],
  });
  const plan = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });

  const races = createRaceRepository(db);
  const event = await races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Export race',
      localDate: '2026-10-06',
      localStartTime: '09:00',
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: plan.id,
    },
  });
  {
    const nutrition = await createNutritionRacePlanWriter(db).savePlanV2(athlete, {
      schemaVersion: 2,
      command: {
        kind: 'create',
        confirmed: true,
        idempotencyKey: randomUUID(),
        draft: {
          period: { from: '2026-10-01', toInclusive: '2026-11-04' },
          timezone: 'UTC',
          purpose: 'Retained meal',
          linkedTrainingPlanVersionId: plan.id,
          items: denseItems(event.id),
        },
      },
      expectedRaceHeads: [{ namespace: 'race-event', eventId: event.id, revision: event.revision }],
    });
    expect(Buffer.byteLength(JSON.stringify(nutrition), 'utf8')).toBeLessThan(524288);
    expect(nutrition.items).toHaveLength(400);

    const aggregateId = await db.tenant(athlete, async (tx) =>
      z
        .uuid()
        .parse(
          (
            await tx.query(
              'SELECT aggregate_id FROM plan_head WHERE athlete_id=$1 AND version_id=$2',
              [athlete, plan.id],
            )
          ).rows[0]?.['aggregate_id'],
        ),
    );
    const recovery = createRecoveryRepository(db),
      optionId = randomUUID();
    const strategy = await recovery.createStrategy(athlete, {
      idempotencyKey: randomUUID(),
      draft: {
        title: 'Selected rest',
        goal: 'Retain user facts',
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-05',
        timezone: 'UTC',
        knownFacts: ['User report'],
        missingInformation: [],
        priority: 'normal',
        observations: [],
        planRefs: [
          { kind: 'training', aggregateId, headVersionId: plan.id },
          {
            kind: 'nutrition',
            aggregateId: nutrition.planId,
            headVersionId: nutrition.versionId,
          },
        ],
        options: [
          {
            id: optionId,
            title: 'Rest',
            kind: 'full_rest',
            methodVersionId: null,
            explanation: 'User option',
          },
        ],
        reassessment: [
          {
            id: randomUUID(),
            trigger: 'plan_changed',
            description: 'Review facts',
            plannedAt: null,
            policyVersion: null,
          },
        ],
      },
    });
    await recovery.confirmStrategy(athlete, {
      strategyId: strategy.strategyId,
      expectedHeadVersionId: strategy.versionId,
      selectedOptionId: optionId,
      idempotencyKey: randomUUID(),
    });

    const routine = createRoutineRepository(db);
    const blueprint = (
      await routine.saveBlueprint(athlete, {
        confirmed: true,
        expectedVersionId: null,
        idempotencyKey: randomUUID(),
        blueprint: {
          schemaVersion: 4,
          routineId: randomUUID(),
          versionId: randomUUID(),
          title: 'Checklist',
          intent: 'Planned only',
          status: 'published',
          tags: [],
          estimatedDurationSeconds: null,
          createdAt: '2026-10-08T00:00:00Z',
          steps: Array.from({ length: 1 }, (_, index) => ({
            id: `step-${String(index).padStart(3, '0')}`,
            title: 'Check',
            content: { kind: 'checklist', prompt: 'User question' },
            timing: { kind: 'ordered', afterStepId: null },
            required: true,
            choiceGroupId: null,
          })),
          choiceGroups: [],
        },
      })
    ).blueprint;
    const scheduleInput = {
      schedule: {
        schemaVersion: 4 as const,
        id: randomUUID(),
        versionId: randomUUID(),
        blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
        window: {
          startDate: '2026-10-01',
          endDateExclusive: '2026-11-05',
          timezone: 'UTC',
          maxOccurrences: 10,
        },
        rule: {
          kind: 'period_days' as const,
          periodId: 'season',
          offsetsDays: [5],
          localTime: '08:00',
        },
        state: 'draft' as const,
      },
      sourcePlanVersionId: plan.id,
    };
    const preview = await routine.previewSchedule(athlete, scheduleInput);
    await routine.approveSchedule(athlete, {
      ...scheduleInput,
      previewDigest: preview.previewDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
  }
  const repo = createRaceManualPublicRepository(db);

  const reviewKey = randomUUID();
  const reviewed = await repo.review(athlete, {
    schemaVersion: 1,
    idempotencyKey: reviewKey,
    intent: {
      expectedEvent: { id: event.id, revision: event.revision },
      newLocalDate: '2026-10-08',
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: plan.id,
        periodId: 'season',
        newStartDate: '2026-10-03',
        scope: 'descendants_and_sessions',
      },
    },
  });
  if (reviewed.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
  return {
    athlete,
    races,
    event,
    repo,
    reviewed,
    reviewKey,
    intent: {
      expectedEvent: { id: event.id, revision: event.revision },
      newLocalDate: '2026-10-08',
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: plan.id,
        periodId: 'season',
        newStartDate: '2026-10-03',
        scope: 'descendants_and_sessions',
      },
    },
  };
}

// Canonical public items; zero is measured quantity while null is unknown.
// This is a genuine saved 400-item producer, not an oversized codec mock.
function denseItems(eventId: string) {
  return Array.from({ length: 400 }, (_, index) => ({
    id: `meal-${String(index).padStart(3, '0')}-한글`,
    category: 'before' as const,
    title: `Retained meal ${index}`,
    anchor: {
      kind: 'relative' as const,
      entity: 'race' as const,
      entityId: eventId,
      point: 'start' as const,
      offsetMinutes: -30,
    },
    foods: [
      {
        foodVersionId: null,
        description: 'User portion',
        quantity: index % 2 ? null : 0,
        unit: 'g',
        sourceBasis: 'unknown' as const,
      },
    ],
    targets: [],
    instructions: 'User planned meal',
    evidenceIds: [],
    source: 'user_confirmed' as const,
  }));
}

it('actual 400-item application commits four immutable domains and exact original receipt after withdrawal', async () => {
  const f = await applicationFixture();
  const command = {
    schemaVersion: 1,
    candidateId: f.reviewed.reference.candidateId,
    applicationDigest: f.reviewed.reference.applicationDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  };
  const committed = await f.repo.approve(f.athlete, command);
  if (committed.status !== 'committed') throw Error('APPROVAL_REQUIRED');
  expect(new Set(committed.versions.map((v) => v.domain))).toEqual(
    new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
  );
  const exported = await createOperationsV38BatchRepository(db).exportAccount(f.athlete);
  const nutrition = committed.versions.find((v) => v.domain === 'nutrition');
  const row = exported.data.nutritionPlanVersions.find(
    (v) => v.version_id === nutrition?.versionId,
  );
  expect(row?.record_json.items).toHaveLength(400);
  expect(row?.record_json.items.map((i) => i.id)).toEqual(denseItems(f.event.id).map((i) => i.id));
  expect(row?.record_json.items.map((i) => i.foods)).toEqual(
    denseItems(f.event.id).map((i) => i.foods),
  );
  expect(exported.data.manualInternalApprovalHistory).toHaveLength(4);
  expect(exported.data.intakeEntries).toEqual([]);
  const before = await counts(f.athlete);
  await app(f.athlete, false);
  expect(await f.repo.approve(f.athlete, command)).toEqual(committed);
  expect(await counts(f.athlete)).toEqual(before);
  const retained = await createOperationsV38BatchRepository(db).exportAccount(f.athlete);
  expect(retained.data.manualInternalApprovalResults).toEqual(
    exported.data.manualInternalApprovalResults,
  );
  expect(
    retained.data.nutritionPlanVersions.find((v) => v.version_id === nutrition?.versionId)
      ?.record_json.items,
  ).toEqual(row?.record_json.items);
}, 60000);

it('single owner-only migration preserves OID owner ACL config and refuses second application', async () => {
  await offline(async (owner) => {
    expect(await metadata(owner)).toEqual(originalMetadata);
    const bodies =
      await owner.query(`SELECT proname,encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS hash FROM pg_proc
     WHERE oid=ANY(ARRAY['public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure,'public.assert_nutrition_disconnect_body(jsonb)'::regprocedure]) ORDER BY proname`);
    expect(bodies.rows).toEqual([
      {
        proname: 'assert_nutrition_disconnect_body',
        hash: '92a0643c5eff075ec00bacd21152666755dc439c1c01571640e8827a618edc6f',
      },
      {
        proname: 'commit_nutrition_plan_v4',
        hash: '16b2dc4c79dec56d417f504d4c005034b2769fefc4249dc8244698c6593a75a6',
      },
    ]);
    await expect(owner.query(migration)).rejects.toThrow('NUTRITION_INDEX_PREDECESSOR_MISMATCH');
    expect(await metadata(owner)).toEqual(originalMetadata);
  });
});

it.each([
  [
    'function config',
    "ALTER FUNCTION public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) SET TimeZone='Asia/Seoul'",
  ],
  [
    'PUBLIC execute',
    'GRANT EXECUTE ON FUNCTION public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) TO PUBLIC',
  ],
  [
    'INSERT hook disabled',
    'ALTER TABLE public.nutrition_race_disconnection_lineage DISABLE TRIGGER nutrition_lineage_insert',
  ],
  [
    'INSERT hook body',
    'CREATE OR REPLACE FUNCTION public.guard_nutrition_lineage_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RETURN NEW; END $$',
  ],
  [
    'validator body',
    "CREATE OR REPLACE FUNCTION public.assert_nutrition_disconnect_body(b jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RAISE EXCEPTION 'fixture drift'; END $$",
  ],
])('rejects %s drift atomically before either successor escapes', async (_name, change) => {
  await offline(async (owner) => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(originalDefinitions.commit);
      await client.query(originalDefinitions.validator);
      await client.query(change);
      const observed = await client.query(
        `SELECT proname,prosrc FROM pg_proc WHERE oid=ANY(ARRAY['public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure,'public.assert_nutrition_disconnect_body(jsonb)'::regprocedure]) ORDER BY proname`,
      );
      await client.query('SAVEPOINT rejection');
      await expect(client.query(migration)).rejects.toThrow();
      await client.query('ROLLBACK TO SAVEPOINT rejection');
      expect(
        (
          await client.query(
            `SELECT proname,prosrc FROM pg_proc WHERE oid=ANY(ARRAY['public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure,'public.assert_nutrition_disconnect_body(jsonb)'::regprocedure]) ORDER BY proname`,
          )
        ).rows,
      ).toEqual(observed.rows);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  expect(await offline(metadata)).toEqual(originalMetadata);
});
it('runtime cannot execute the owner-only successor', async () => {
  const s = await setup();
  await expect(db.tenant(s.athlete, (tx) => tx.query(migration))).rejects.toMatchObject({
    code: '42501',
  });
  expect(await offline(metadata)).toEqual(originalMetadata);
});

// Negative transport mutation only: bodies originate from the actual public writer.
// No candidate/body owner seed or fabricated successful approval is used.
function mutatedCommitDatabase(mutate: (saved: NutritionPlanVersionV4) => unknown): Database {
  const wrap = (tx: Transaction): Transaction => ({
    athleteId: tx.athleteId,
    query: async (sql, values) => {
      if (!sql.includes('SELECT public.commit_nutrition_plan_v4(')) return tx.query(sql, values);
      const args = z.tuple([z.string(), z.string(), z.string(), z.string()]).parse(values);
      const saved = nutritionPlanVersionV4Schema.parse(JSON.parse(args[3]));
      return tx.query(sql, [args[0], args[1], args[2], JSON.stringify(mutate(saved))]);
    },
  });
  return {
    close: async () => {},
    tenant: (athlete, operation) => db.tenant(athlete, (tx) => operation(wrap(tx))),
    exclusiveTenant: (athlete, operation) =>
      db.exclusiveTenant(athlete, (tx) => operation(wrap(tx))),
  };
}
it.each(['item', 'binding', 'pin', 'binding_duplicate'] as const)(
  'same-count %s substitution or duplicate cannot escape indexed SQL validation',
  async (kind) => {
    const s = await setup();
    const initial = await s.writer.savePlanV2(s.athlete, intent(s.event.id));
    const before = await counts(s.athlete);
    let dispatched = false;
    const altered = mutatedCommitDatabase((saved) => {
      dispatched = true;
      if (kind === 'item')
        return {
          ...saved,
          items: saved.items.map((item, index) =>
            index === 0 ? { ...item, id: 'substitute-한글' } : item,
          ),
        };
      if (kind === 'binding')
        return {
          ...saved,
          itemRaceTimingBindings: saved.itemRaceTimingBindings.map((binding, index) =>
            index === 0 ? { ...binding, itemId: 'substitute-한글' } : binding,
          ),
        };
      if (kind === 'pin')
        return {
          ...saved,
          raceTimingPins: saved.raceTimingPins.map((pin, index) =>
            index === 0 ? { ...pin, eventRevision: pin.eventRevision + 1 } : pin,
          ),
        };
      const binding = saved.itemRaceTimingBindings[0];
      if (!binding) throw Error('PUBLIC_BINDING_REQUIRED');
      return { ...saved, itemRaceTimingBindings: [binding, binding] };
    });
    await expect(
      createNutritionRacePlanV4Writer(altered).savePlanV4(
        s.athlete,
        update(initial, { eventId: s.event.id }),
      ),
    ).rejects.toThrow();
    expect(dispatched).toBe(true);
    expect(await counts(s.athlete)).toEqual(before);
    expect(await read(s.athlete, initial.planId)).toEqual(initial);
  },
);

it('actual current race head drift rejects a fresh standalone write without artifacts', async () => {
  const s = await setup();
  const initial = await s.writer.savePlanV2(s.athlete, intent(s.event.id));
  await createRaceRepository(db).updateRaceEvent(s.athlete, s.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, title: 'Changed metadata' },
  });
  const before = await counts(s.athlete);
  await expect(
    createNutritionRacePlanV4Writer(db).savePlanV4(
      s.athlete,
      update(initial, { eventId: s.event.id, revision: 1 }),
    ),
  ).rejects.toThrow();
  expect(await counts(s.athlete)).toEqual(before);
});

it('public opaque Unicode and escaped IDs retain item order, exact bindings and zero-null portions', async () => {
  const s = await setup();
  const original = intent(s.event.id);
  const base = original.command.draft.items[0];
  if (!base) throw Error('PUBLIC_ITEM_REQUIRED');
  const input = {
    ...original,
    command: {
      ...original.command,
      draft: {
        ...original.command.draft,
        items: ['한글', 'a"\\', '😀'].map((id, index) => ({
          ...base,
          id,
          foods: base.foods.map((food) => ({ ...food, quantity: index % 2 ? null : 0 })),
        })),
      },
    },
  };
  const initial = await s.writer.savePlanV2(s.athlete, input);
  if (!('schemaVersion' in initial)) throw Error('PUBLIC_PINNED_VERSION_REQUIRED');
  const next = await createNutritionRacePlanV4Writer(db).savePlanV4(
    s.athlete,
    update(initial, { eventId: s.event.id }),
  );
  expect(next.plan.items.map((item) => item.id)).toEqual(initial.items.map((item) => item.id));
  expect(next.plan.items.map((item) => item.foods)).toEqual(
    initial.items.map((item) => item.foods),
  );
  if (!('schemaVersion' in next.plan)) throw Error('PUBLIC_V4_REQUIRED');
  expect(next.plan.raceTimingPins).toEqual(initial.raceTimingPins);
  expect(next.plan.itemRaceTimingBindings).toEqual(initial.itemRaceTimingBindings);
});
