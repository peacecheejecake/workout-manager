import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { nutritionPlanVersionCompatibleSchema } from '@workout/contracts/nutrition-race-plan-v2';
import type { NutritionPlanItemDraft } from '@workout/contracts/nutrition-core';
import type { PlanDraft } from '@workout/contracts/planning';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantNutritionCore,
  grantRaces,
  grantRecoveryCore,
  grantRoutineCore,
  grantSupplementaryCore,
  grantStretchingCore,
} from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRaceRepository } from '../src/races.js';
import { captureRaceTimingPins } from '../src/race-timing-bindings.js';
import {
  createIntegratedPlannerRepository,
  IntegratedPlannerLimitError,
} from '../src/integrated-planner.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real restricted-role SQL/read acceptance. V2 records below are explicit offline
// owner INSERT fixtures: no public V2 writer, immutable approval or retention proof.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `nutrition_v5_${suffix}`;
const ownerRole = `nutrition_v5_owner_${suffix}`;
const runtimeRole = `nutrition_v5_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let owner: Pool;
let runtime: Database;
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
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  for (const grant of [
    grantCorePlanning,
    grantOperations,
    grantNutritionCore,
    grantRaces,
    grantRecoveryCore,
    grantRoutineCore,
    grantSupplementaryCore,
    grantStretchingCore,
  ])
    await grant(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 2 });
  runtime = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  expect(
    (
      await admin.query(
        'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)',
        [[ownerRole, runtimeRole]],
      )
    ).rows,
  ).toEqual([
    { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
    { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
  ]);
  expect(
    (await owner.query('SELECT count(*)::int count,max(version) latest FROM schema_migrations'))
      .rows,
  ).toEqual([{ count: 107, latest: 107 }]);
});
afterAll(async () => {
  await runtime?.close();
  await owner?.end();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function athlete() {
  const id = randomUUID();
  await createConsentRepository(runtime).setConsent(id, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  return id;
}
async function owned<T>(id: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [id]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
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
const query = { from: '2026-10-07', toExclusive: '2026-10-09', timezone: 'UTC' };
const reader = () => createIntegratedPlannerRepository(runtime);
function values(): RaceEventValues {
  return {
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
}
function item(id = 'meal'): NutritionPlanItemDraft {
  return {
    id,
    category: 'meal',
    title: 'Synthetic meal',
    anchor: { kind: 'absolute', date: '2026-10-07', localTime: '08:00', timezone: 'UTC' },
    foods: [
      {
        foodVersionId: null,
        description: 'Synthetic food',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
    ],
    targets: [],
    instructions: 'Synthetic action',
    evidenceIds: [],
    source: 'user_confirmed',
  };
}
function training(time = '09:00'): PlanDraft {
  return {
    title: 'Synthetic training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, all) => ({
      id: level,
      parentId: index === 0 ? null : (all[index - 1] ?? null),
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
        localStartTime: time,
        title: 'Synthetic',
        sport: 'running',
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
}
async function saveTraining(
  id: string,
  draft = training(),
  expectedVersionId: string | null = null,
) {
  return createPlanningRepository(runtime).save(id, {
    source: 'manual',
    confirmed: true,
    expectedVersionId,
    idempotencyKey: randomUUID(),
    draft,
  });
}
async function intake(id: string) {
  const generation = await runtime.tenant(id, async (tx) =>
    z
      .uuid()
      .parse((await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
  );
  const unknown = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  return createNutritionRepository(runtime, {
    now: () => new Date('2026-10-08T00:00:00Z'),
  }).createIntake(id, {
    restoreGeneration: generation,
    idempotencyKey: randomUUID(),
    intakeId: randomUUID(),
    confirmed: true,
    occurredAt: '2026-10-07T08:00:00Z',
    timezone: 'UTC',
    foods: item().foods,
    nutrientTotal: {
      energy: { value: 0, unit: 'kcal', status: 'reported', evidenceIds: [] },
      carbohydrate: unknown('g'),
      protein: unknown('g'),
      fat: unknown('g'),
      fluid: unknown('mL'),
      sodium: unknown('mg'),
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
}
async function captured(id: string, eventId: string) {
  return runtime.tenant(id, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
    const pins = await captureRaceTimingPins(tx, [
      { namespace: 'race-event', eventId, revision: 1 },
    ]);
    const pin = pins[0];
    if (!pin) throw Error('EXPECTED_OWN_PIN');
    return pin;
  });
}
async function insertSynthetic(
  id: string,
  items: NutritionPlanItemDraft[],
  options: {
    raceId?: string;
    pin?: Awaited<ReturnType<typeof captured>>;
    linkedPlan?: string;
  } = {},
) {
  const planId = randomUUID(),
    versionId = randomUUID(),
    approvalId = randomUUID();
  const record = nutritionPlanVersionCompatibleSchema.parse({
    ...(options.raceId
      ? {
          schemaVersion: 2,
          raceTimingPins: options.pin ? [options.pin] : [],
          itemRaceTimingBindings: [...items]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map((i) => ({
              itemId: i.id,
              binding: options.pin
                ? {
                    state: 'captured',
                    eventId: options.pin.eventId,
                    eventRevision: options.pin.eventRevision,
                  }
                : {
                    state: 'legacy_unpinned',
                    priorNutritionVersionId: randomUUID(),
                    priorItemId: i.id,
                    priorAnchorDigest: 'a'.repeat(64),
                  },
            })),
        }
      : {}),
    planId,
    versionId,
    version: 1,
    previousVersionId: null,
    approvalId,
    approvedAt: '2026-10-07T00:00:00Z',
    period: { from: '2026-10-07', toInclusive: '2026-10-08' },
    timezone: 'UTC',
    purpose: 'Synthetic offline fixture',
    linkedTrainingPlanVersionId: options.linkedPlan ?? null,
    items: items.map((i) => ({ ...i, planVersionId: versionId })),
  });
  await owned(id, async (client) => {
    await client.query(
      `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,previous_version_id,previous_version,period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json) VALUES($1,$2,$3,1,NULL,NULL,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        id,
        planId,
        versionId,
        record.period.from,
        record.period.toInclusive,
        record.linkedTrainingPlanVersionId,
        approvalId,
        record.approvedAt,
        JSON.stringify(record),
      ],
    );
    await client.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,1,$3)',
      [id, planId, versionId],
    );
  });
  return record;
}
it('public legacy absolute/session plans and intake retain V1/V4/V5 domain results', async () => {
  const id = await athlete(),
    plan = await saveTraining(id);
  await createNutritionRepository(runtime).savePlan(id, {
    kind: 'create',
    idempotencyKey: randomUUID(),
    confirmed: true,
    draft: {
      period: { from: '2026-10-07', toInclusive: '2026-10-08' },
      timezone: 'UTC',
      purpose: 'Synthetic',
      linkedTrainingPlanVersionId: plan.id,
      items: [
        item(),
        {
          ...item('after'),
          anchor: {
            kind: 'relative',
            entity: 'session',
            entityId: 'session',
            point: 'end',
            offsetMinutes: 0,
          },
        },
      ],
    },
  });
  await intake(id);
  const r = reader(),
    v1 = await r.read(id, query),
    v4 = await r.readV4(id, query),
    v5 = await r.readV5(id, query);
  const { schemaVersion: _s5, nutritionOperationalStates, ...common5 } = v5;
  const { schemaVersion: _s4, ...common4 } = v4;
  expect(common5).toEqual(common4);
  expect(nutritionOperationalStates).toEqual([]);
  expect(v5.days.map((d) => ({ nutrition: d.nutritionItems, intakes: d.intakes }))).toEqual(
    v1.days.map((d) => ({ nutrition: d.nutritionItems, intakes: d.intakes })),
  );
  expect(v5.summary.nutrition).toEqual(v1.summary.nutrition);
});
it('public date edit requires impact approval; same-date time edit preserves saved pin and deletion suspends timing without changing food or intake', async () => {
  const id = await athlete(),
    race = createRaceRepository(runtime);
  const event = await race.createRaceEvent(id, { idempotencyKey: randomUUID(), values: values() });
  const pin = await captured(id, event.id);
  const saved = await insertSynthetic(
    id,
    [
      {
        ...item(),
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: event.id,
          point: 'start',
          offsetMinutes: 0,
        },
      },
    ],
    { raceId: event.id, pin },
  );
  const actual = await intake(id);
  const before = await reader().readV5(id, query);
  expect(before.days[0]?.nutritionItems[0]?.localTime).toBe('09:00:00');
  const rejectedDateKey = randomUUID();
  const eventBefore = await race.getRaceEvent(id, event.id);
  const dateReceiptCount = () =>
    runtime.tenant(
      id,
      async (tx) =>
        (
          await tx.query(
            'SELECT count(*)::int AS count FROM race_command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
            [id, rejectedDateKey],
          )
        ).rows[0]?.['count'],
    );
  expect(await dateReceiptCount()).toBe(0);
  await expect(
    race.updateRaceEvent(id, event.id, {
      idempotencyKey: rejectedDateKey,
      expectedRevision: 1,
      values: { ...values(), localDate: '2026-10-08', localStartTime: '10:00' },
    }),
  ).rejects.toMatchObject({ code: 'RACE_PLAN_IMPACT_REQUIRED' });
  expect(await race.getRaceEvent(id, event.id)).toEqual(eventBefore);
  expect(await dateReceiptCount()).toBe(0);
  expect(await reader().readV5(id, query)).toEqual(before);
  expect(await createNutritionRepository(runtime).readIntake(id, actual.intakeId)).toEqual(actual);
  expect(
    await runtime.tenant(
      id,
      async (tx) =>
        (
          await tx.query(
            'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
            [id, saved.versionId],
          )
        ).rows[0]?.['record_json'],
    ),
  ).toEqual(saved);
  // A date change needs the explicit full-impact approval path. A same-date time
  // edit remains a public edit and must preserve this immutable saved race pin.
  await race.updateRaceEvent(id, event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...values(), localStartTime: '10:00' },
  });
  expect(await reader().readV5(id, query)).toEqual(before);
  await race.deleteRaceEvent(id, event.id, { idempotencyKey: randomUUID(), expectedRevision: 2 });
  const after = await reader().readV5(id, query);
  expect(after.days.flatMap((d) => d.nutritionItems)).toEqual([]);
  expect(after.nutritionOperationalStates).toEqual([
    {
      planVersionId: saved.versionId,
      itemId: 'meal',
      state: 'suspended',
      reason: 'race_disconnected',
    },
  ]);
  expect(after.unresolvedNutritionItems).toHaveLength(1);
  expect(await createNutritionRepository(runtime).readIntake(id, actual.intakeId)).toEqual(actual);
  expect(
    await runtime.tenant(
      id,
      async (tx) =>
        (
          await tx.query(
            'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
            [id, saved.versionId],
          )
        ).rows[0]?.['record_json'],
    ),
  ).toEqual(saved);
  await race.createRaceEvent(id, { idempotencyKey: randomUUID(), values: values() });
  expect((await reader().readV5(id, query)).nutritionOperationalStates).toEqual(
    after.nutritionOperationalStates,
  );
});
it('populated foreign and missing race sources stay equally unavailable under true RLS', async () => {
  const alice = await athlete(),
    bob = await athlete(),
    race = createRaceRepository(runtime);
  const foreign = await race.createRaceEvent(bob, {
    idempotencyKey: randomUUID(),
    values: values(),
  });
  await insertSynthetic(
    alice,
    [
      {
        ...item('foreign'),
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: foreign.id,
          point: 'start',
          offsetMinutes: 0,
        },
      },
    ],
    { raceId: foreign.id },
  );
  await insertSynthetic(
    alice,
    [
      {
        ...item('missing'),
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: randomUUID(),
          point: 'start',
          offsetMinutes: 0,
        },
      },
    ],
    { raceId: randomUUID() },
  );
  expect(
    await runtime.tenant(
      alice,
      async (tx) => (await tx.query('SELECT id FROM race_event WHERE id=$1', [foreign.id])).rows,
    ),
  ).toEqual([]);
  await expect(captured(alice, foreign.id)).rejects.toMatchObject({
    code: 'RACE_TIMING_UNAVAILABLE',
  });
  const result = await reader().readV5(alice, query);
  expect(result.nutritionOperationalStates.map((s) => s.reason)).toEqual([
    'source_unavailable',
    'source_unavailable',
  ]);
  expect(JSON.stringify(result)).not.toContain('Synthetic race');
  expect((await reader().readV5(bob, query)).nutritionPlanVersionIds).toEqual([]);
});
it('exact historical linked Plan resolves while current Plan moves and foreign Plan remains inaccessible', async () => {
  const id = await athlete(),
    old = await saveTraining(id);
  // Move the public current Plan before adding the offline historical fixture;
  // never bypass the existing combined-review guard for approved nutrition.
  await saveTraining(id, training('11:00'), old.id);
  const saved = await insertSynthetic(
    id,
    [
      {
        ...item(),
        anchor: {
          kind: 'relative',
          entity: 'session',
          entityId: 'session',
          point: 'start',
          offsetMinutes: 0,
        },
      },
    ],
    { linkedPlan: old.id },
  );
  expect((await reader().readV5(id, query)).days[0]?.nutritionItems[0]?.localTime).toBe('09:00:00');
  const foreign = await athlete(),
    foreignPlan = await saveTraining(foreign);
  expect(
    await runtime.tenant(
      id,
      async (tx) =>
        (await tx.query('SELECT draft FROM plan_snapshot WHERE id=$1', [foreignPlan.id])).rows,
    ),
  ).toEqual([]);
  expect((await reader().readV5(foreign, query)).nutritionPlanVersionIds).not.toContain(
    saved.versionId,
  );
});
it.each(['items', 'references', 'bytes'] as const)(
  'SQL preaggregate %s cap denies schema-valid offline outliers',
  async (kind) => {
    const id = await athlete();
    if (kind === 'bytes') {
      for (let i = 0; i < 13; i++)
        await insertSynthetic(id, [{ ...item(), id: 'x'.repeat(350000) }]);
    } else if (kind === 'items') {
      for (let i = 0; i < 3; i++)
        await insertSynthetic(
          id,
          Array.from({ length: 1001 }, (_, n) => ({
            ...item(String(n)),
            foods: [],
            instructions: 'x',
          })),
        );
    } else {
      const event = await createRaceRepository(runtime).createRaceEvent(id, {
          idempotencyKey: randomUUID(),
          values: values(),
        }),
        pin = await captured(id, event.id);
      for (let i = 0; i < 4; i++)
        await insertSynthetic(
          id,
          Array.from({ length: 624 }, (_, n) => ({
            ...item(String(n)),
            foods: [],
            instructions: 'x',
            anchor: {
              kind: 'relative',
              entity: 'race',
              entityId: event.id,
              point: 'start',
              offsetMinutes: 0,
            },
          })),
          { raceId: event.id, pin },
        );
      const extra = {
        ...item('extra'),
        foods: [],
        instructions: 'x',
        anchor: {
          kind: 'relative' as const,
          entity: 'race' as const,
          entityId: event.id,
          point: 'start' as const,
          offsetMinutes: 0,
        },
      };
      // 2497 items + 2497 bindings + five pins + one unique race head = 5000.
      await insertSynthetic(id, [extra], { raceId: event.id, pin });
      expect((await reader().readV5(id, query)).summary.nutrition.plannedItemCount).toBe(2497);
      // Another record adds one item, one binding and one pin: 5003 must fail.
      await insertSynthetic(id, [extra], { raceId: event.id, pin });
    }
    await expect(reader().readV5(id, query)).rejects.toBeInstanceOf(IntegratedPlannerLimitError);
  },
);
it('one actual MVCC snapshot remains coherent when public deletion commits after its SQL result', async () => {
  const id = await athlete(),
    race = createRaceRepository(runtime),
    event = await race.createRaceEvent(id, { idempotencyKey: randomUUID(), values: values() });
  const pin = await captured(id, event.id);
  await insertSynthetic(
    id,
    [
      {
        ...item(),
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: event.id,
          point: 'start',
          offsetMinutes: 0,
        },
      },
    ],
    { raceId: event.id, pin },
  );
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wrapped: Database = {
    ...runtime,
    tenant: (athleteId, operation) =>
      runtime.tenant(athleteId, (tx) =>
        operation({
          ...tx,
          query: async (sql, parameters) => {
            const result = await tx.query(sql, parameters);
            if (sql.includes('race_source_heads AS MATERIALIZED')) {
              observed();
              await gate;
            }
            return result;
          },
        }),
      ),
  };
  const pending = createIntegratedPlannerRepository(wrapped).readV5(id, query);
  try {
    await Promise.race([
      ready,
      pending.then(() => {
        throw new Error('EXPECTED_SNAPSHOT_PAUSE');
      }),
    ]);
    await race.deleteRaceEvent(id, event.id, { idempotencyKey: randomUUID(), expectedRevision: 1 });
  } finally {
    release();
  }
  const capturedResult = await pending;
  expect(capturedResult.days[0]?.nutritionItems[0]?.localTime).toBe('09:00:00');
  expect(capturedResult.nutritionOperationalStates).toEqual([]);
  expect((await reader().readV5(id, query)).nutritionOperationalStates[0]).toMatchObject({
    state: 'suspended',
    reason: 'race_disconnected',
  });
});
