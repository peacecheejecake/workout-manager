import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { NutritionPlanDraft } from '@workout/contracts/nutrition-core';
import {
  nutritionPlanVersionV4Schema,
  saveNutritionPlanV4IntentSchema,
} from '@workout/contracts/nutrition-race-plan-v4';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV9 } from '../src/current-runtime-installation-v9.js';
import { grantCurrentRuntimeV9Profile } from '../src/current-runtime-grants-v9.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository, createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createRestoreGenerationRepository } from '../src/restore-generation.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Current V9 installation and configured core grants, matching the identity harness.
// This direct writer case diagnoses initial approval, before reconnect UI or race deletion.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `nutrition_v9_approval_${suffix}`;
const ownerRole = `nutrition_v9_owner_${suffix}`;
const runtimeRole = `nutrition_v9_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const createdRoles: string[] = [];
let createdDatabase = false;
let database: Database | undefined;

const diagnosticCodes = new Set([
  'NUTRITION_V4_SOURCE_INVALID',
  'NUTRITION_V4_LIMIT',
  'NUTRITION_V4_TIMING_UNRESOLVED',
  'NUTRITION_V4_SAVED_IDENTITY',
  'NUTRITION_V4_SOURCE_CAPTURE_INVALID',
  'NUTRITION_V4_INTENT_INVALID',
  'NUTRITION_V4_BODY_INVALID',
  'NUTRITION_V4_ITEM_INVALID',
  'NUTRITION_V4_CAPTURE_REQUIRED',
  'NUTRITION_V4_RACE_ROSTER',
  'NUTRITION_V4_ATOMIC_CORRESPONDENCE_REQUIRED',
  'NUTRITION_LINEAGE_CORRESPONDENCE_REQUIRED',
  'NUTRITION_LINEAGE_COMMIT_PROTOCOL_REQUIRED',
  'NUTRITION_V4_RECEIPT_PROTOCOL_REQUIRED',
  'NUTRITION_V4_ACCOUNT_REQUIRED',
  'NUTRITION_V4_BINDING_ORDER',
  'NUTRITION_V4_ROSTER_REQUIRED',
  'RACE_TIMING_INVALID_SOURCE',
  'RACE_TIMING_UNAVAILABLE',
  'RACE_TIMING_STALE',
  'APP_CONSENT_REQUIRED',
  'APP_ADMISSION_BINDING_REQUIRED',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
]);
const sqlStates = new Set([
  'P0001',
  '42501',
  '23502',
  '23503',
  '23505',
  '23514',
  '22P02',
  '22007',
  '22008',
  '42883',
  '42P01',
  '42703',
  '57014',
  '40001',
  '40P01',
]);
function diagnostic(error: unknown) {
  const record = error instanceof Error ? error : undefined;
  const code = record && 'code' in record && typeof record.code === 'string' ? record.code : '';
  return {
    errorClass:
      record && ['Error', 'TypeError', 'RangeError', 'ZodError'].includes(record.name)
        ? record.name
        : 'unknown',
    code: diagnosticCodes.has(code)
      ? code
      : record && diagnosticCodes.has(record.message)
        ? record.message
        : 'unknown',
    sqlState: sqlStates.has(code) ? code : 'unknown',
  };
}
async function diagnosed<T>(stage: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(JSON.stringify({ stage, ...diagnostic(error) }));
  }
}
function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + databaseName;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
beforeAll(
  async () =>
    diagnosed('installation', async () => {
      for (const role of [ownerRole, runtimeRole]) {
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        createdRoles.push(role);
      }
      await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
      createdDatabase = true;
      await migrate(connection(ownerRole), 107);
      await installCurrentRuntimeV9(connection(ownerRole));
      await grantCurrentRuntimeAppBaselineV2(connection(ownerRole), runtimeRole, 'core');
      await grantCurrentRuntimeV9Profile(connection(ownerRole), runtimeRole);
      database = createDatabase({ connectionString: connection(runtimeRole), max: 1 });
    }),
  180000,
);
afterAll(async () => {
  const failures: unknown[] = [];
  const clean = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      failures.push(diagnostic(error));
    }
  };
  await clean(async () => database?.close());
  if (createdDatabase) await clean(async () => dropIsolatedDatabase(admin, databaseName));
  for (const role of createdRoles.reverse())
    await clean(async () => admin.query(`DROP ROLE "${role}"`));
  await clean(async () => admin.end());
  if (failures.length) throw new Error(JSON.stringify({ stage: 'cleanup', failures }));
}, 30000);

it('approves the current V9 absolute-to-race-relative meal with a long item ID and zero/unknown quantities', async () => {
  const db = database;
  if (!db) throw new Error('DIAGNOSTIC_DATABASE_NOT_READY');
  const athlete = randomUUID();
  await diagnosed('account', async () => {
    const owner = new Pool({ connectionString: connection(ownerRole), max: 1 });
    try {
      await owner.query(
        "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
        [athlete, randomUUID()],
      );
    } finally {
      await owner.end();
    }
  });
  await diagnosed('consent', async () =>
    createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    }),
  );
  const race = await diagnosed('race', async () =>
    createRaceRepository(db).createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: {
        title: '합성 재연결 대회',
        localDate: '2080-01-06',
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
      },
    }),
  );
  const foods = [
    {
      foodVersionId: null,
      description: '보존 음식',
      quantity: 0,
      unit: 'g',
      sourceBasis: 'manual_total',
    },
    {
      foodVersionId: null,
      description: '미상 수량',
      quantity: null,
      unit: 'unspecified',
      sourceBasis: 'unknown',
    },
  ] as const;
  const draft: NutritionPlanDraft = {
    period: { from: '2080-01-01', toInclusive: '2080-01-31' },
    timezone: 'UTC',
    purpose: '합성 재연결 수용',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: '식사-' + '한'.repeat(1001),
        category: 'before',
        title: '합성 식사',
        anchor: { kind: 'absolute', date: '2080-01-06', localTime: '08:30', timezone: 'UTC' },
        foods: [...foods],
        targets: [],
        instructions: '입력한 양을 보존',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
  const nutrition = createNutritionRepository(db);
  const original = await diagnosed('absolute_plan', async () =>
    nutrition.savePlan(athlete, {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft,
    }),
  );
  const { generationId } = await diagnosed('restore_generation', async () =>
    createRestoreGenerationRepository(db).read(athlete),
  );
  const unknown = <Unit extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: Unit) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const intake = await diagnosed('intake', async () =>
    nutrition.createIntake(athlete, {
      intakeId: `intake-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      restoreGeneration: generationId,
      confirmed: true,
      occurredAt: '2026-10-07T00:00:00Z',
      timezone: 'UTC',
      foods: [...foods],
      nutrientTotal: {
        energy: unknown('kcal'),
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
    }),
  );
  const request = saveNutritionPlanV4IntentSchema.parse({
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        planId: original.planId,
        expectedHeadVersionId: original.versionId,
        idempotencyKey: randomUUID(),
        confirmed: true,
        draft: {
          ...draft,
          items: draft.items.map((item) => ({
            ...item,
            anchor: {
              kind: 'relative',
              entity: 'race',
              entityId: race.id,
              point: 'start',
              offsetMinutes: -30,
            },
          })),
        },
      },
      expectedRaceHeads: [{ namespace: 'race-event', eventId: race.id, revision: race.revision }],
      reconnectItemIds: [],
    },
  });
  const approved = await diagnosed('initial_v4_approval', async () =>
    createNutritionRacePlanV4Writer(db).savePlanV4(athlete, request),
  );
  expect(approved.plan.previousVersionId).toBe(original.versionId);
  expect(approved.plan.version).toBe(original.version + 1);
  expect(approved.plan.items[0]?.foods).toEqual(foods);
  expect(
    nutritionPlanVersionV4Schema.parse(approved.plan).itemRaceTimingBindings[0]?.binding.state,
  ).toBe('captured');
  const stored = await diagnosed('read_approved', async () =>
    createNutritionPlanV4Reader(db).readPlanV4(athlete, original.planId),
  );
  expect(stored?.head?.versionId).toBe(approved.plan.versionId);
  const actual = await diagnosed('read_intake', async () =>
    nutrition.readIntake(athlete, intake.intakeId),
  );
  expect(actual).toEqual(intake);
}, 90000);
