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
import { createDatabase, type Database } from '../src/database.js';
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
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import {
  createNutritionRacePlanV4Writer,
  saveNutritionPlanV4In,
} from '../src/nutrition-race-plan-v4-writer.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Focused staging only: normal public107 plus explicit unregistered108/109/110.
// This does not prove registry installation, public API activation or restore admission.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `nutrition_v4_tx_${suffix}`,
  ownerRole = `nutrition_v4_tx_owner_${suffix}`,
  runtimeRole = `nutrition_v4_tx_app_${suffix}`;
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
              return { ...item, source: 'user_confirmed' as const };
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

it('same transaction successful seam rolls head/history/outbox/receipt back with caller failure', async () => {
  const s = await disconnected();
  const before = await counts(s.athlete);
  await expect(
    db.tenant(s.athlete, async (tx) => {
      const saved = await saveNutritionPlanV4In(tx, update(s.prior));
      expect(saved.plan.version).toBe(s.prior.version + 1);
      throw new Error('CALLER_ROLLBACK');
    }),
  ).rejects.toThrow('CALLER_ROLLBACK');
  expect(await counts(s.athlete)).toEqual(before);
  expect(await read(s.athlete, s.prior.planId)).toEqual(s.prior);
});
it('repeat exact receipt returns original result after app withdrawal without new artifacts', async () => {
  const s = await disconnected(),
    command = update(s.prior);
  const saved = await db.tenant(s.athlete, (tx) => saveNutritionPlanV4In(tx, command));
  const before = await counts(s.athlete);
  await app(s.athlete, false);
  expect(await db.tenant(s.athlete, (tx) => saveNutritionPlanV4In(tx, command))).toEqual(saved);
  expect(await counts(s.athlete)).toEqual(before);
});
it('foreign transaction cannot use another tenants immutable prior or origin', async () => {
  const own = await disconnected(),
    foreign = await setup();
  const before = await counts(foreign.athlete);
  await expect(
    db.tenant(foreign.athlete, (tx) => saveNutritionPlanV4In(tx, update(own.prior))),
  ).rejects.toThrow('PLAN_NOT_FOUND');
  expect(await counts(foreign.athlete)).toEqual(before);
});
it('new disconnected forgery has no original deletion origin and cannot commit', async () => {
  const s = await setup(),
    prior = await s.writer.savePlanV2(s.athlete, intent(s.event.id));
  const forged = update(prior, {
    items: prior.items.map(({ planVersionId, ...item }) => {
      void planVersionId;
      return {
        ...item,
        source: 'user_confirmed' as const,
        anchor: { kind: 'disconnected' as const, entity: 'race' as const },
      };
    }),
  });
  const before = await counts(s.athlete);
  await expect(db.tenant(s.athlete, (tx) => saveNutritionPlanV4In(tx, forged))).rejects.toThrow(
    'NUTRITION_V4_ORIGIN_REQUIRED',
  );
  expect(await counts(s.athlete)).toEqual(before);
});
it('explicit reconnect cannot use the deleted original race as a current source', async () => {
  const s = await disconnected();
  const oldItems = s.initial.items.map(({ planVersionId, ...item }) => {
    void planVersionId;
    return { ...item, source: 'user_confirmed' as const };
  });
  const before = await counts(s.athlete);
  await expect(
    db.tenant(s.athlete, (tx) =>
      saveNutritionPlanV4In(
        tx,
        update(s.prior, { items: oldItems, eventId: s.event.id, reconnect: ['meal'] }),
      ),
    ),
  ).rejects.toThrow('RACE_TIMING_UNAVAILABLE');
  expect(await counts(s.athlete)).toEqual(before);
});
