import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { NutritionPlanDraft } from '@workout/contracts/nutrition-core';
import {
  nutritionPlanVersionV4Schema,
  saveNutritionPlanV4IntentSchema,
} from '@workout/contracts/nutrition-race-plan-v4';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { migrate } from '@workout/server-persistence/migrate';
import { installCurrentRuntimeV11 } from '@workout/server-persistence/current-runtime-installation-v11';
import {
  grantCurrentRuntimeV11Profile,
  grantCurrentRuntimeV11GalleryWorker,
  grantCurrentRuntimeV11AiDispatcher,
  currentRuntimeV11GalleryWorkerRole,
  currentRuntimeV11AiDispatcherRole,
} from '@workout/server-persistence/current-runtime-grants-v11';
import { grantCurrentRuntimeAppBaselineV2 } from '@workout/server-persistence/current-runtime-app-grants-v2';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import {
  createNutritionRepository,
  createNutritionPlanV4Reader,
} from '@workout/server-persistence/nutrition-core';
import { createRaceRepository } from '@workout/server-persistence/races';
import { createRestoreGenerationRepository } from '@workout/server-persistence/restore-generation';
import { createApi } from '../src/app.js';
import {
  currentRuntimeSourceBuildReadinessV3Schema,
  type CurrentRuntimeSourceBuildReadinessV3,
} from '@workout/server-persistence/current-runtime-source-build-readiness-v3';
import { createRegisteredCurrentRuntimeRepositoriesV3 } from '../src/current-runtime-repositories-registration-v3.js';
import {
  nutritionPlanVersionSchema,
  intakeEntryRecordSchema,
} from '@workout/contracts/nutrition-core';
import { raceCommandResultSchema } from '@workout/contracts/race-commands';
import { restoreGenerationResponseSchema } from '@workout/contracts/restore-generation';
import { nutritionPlanPublicApprovalV4ResultSchema } from '@workout/contracts/nutrition-race-plan-public-v4';
import { Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';

// Current V11 (profile27) installation and configured core grants, matching the identity harness.
// PENDING ROOT REGISTRATION: passes only after root registers the V11 installer/grants and
// readiness/source-build proof v3.
// Only authentication is synthetic. Actual HTTP routes, CSRF and the Root-registered
// source-build readiness and named repositories run unchanged.
// This is not evidence of OIDC or shell-proxy behavior.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `nutrition_http_v9_approval_${suffix}`;
const ownerRole = `nutrition_http_v9_owner_${suffix}`;
const runtimeRole = `nutrition_http_v9_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const createdRoles: string[] = [];
let createdDatabase = false;
let database: Database | undefined;
let api: ReturnType<typeof createApi> | undefined;

const diagnosticCodes = new Set([
  'CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE',
  'CURRENT_RUNTIME_SOURCE_BUILD_V2_INCOMPATIBLE',
  'CURRENT_RUNTIME_SOURCE_BUILD_V2_INVALID_READINESS',
  'CURRENT_RUNTIME_V9_UNAVAILABLE',
  'CURRENT_RUNTIME_V9_INCOMPATIBLE',
  'CURRENT_RUNTIME_V9_INVALID_READINESS',
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
      // The profile27 catalog always contains both fixed principals (cluster roles).
      for (const role of [currentRuntimeV11GalleryWorkerRole, currentRuntimeV11AiDispatcherRole]) {
        if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount)
          continue;
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        createdRoles.push(role);
      }
      await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
      createdDatabase = true;
      await migrate(connection(ownerRole), 107);
      await installCurrentRuntimeV11(connection(ownerRole));
      await grantCurrentRuntimeAppBaselineV2(connection(ownerRole), runtimeRole, 'core');
      await grantCurrentRuntimeV11Profile(connection(ownerRole), runtimeRole);
      await grantCurrentRuntimeV11GalleryWorker(
        connection(ownerRole),
        currentRuntimeV11GalleryWorkerRole,
      );
      await grantCurrentRuntimeV11AiDispatcher(
        connection(ownerRole),
        currentRuntimeV11AiDispatcherRole,
      );
      database = createDatabase({ connectionString: connection(runtimeRole) });
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
  await clean(async () => api?.close());
  await clean(async () => database?.close());
  if (createdDatabase)
    await clean(async () => admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`));
  for (const role of createdRoles.reverse())
    await clean(async () => admin.query(`DROP ROLE "${role}"`));
  await clean(async () => admin.end());
  if (failures.length) throw new Error(JSON.stringify({ stage: 'cleanup', failures }));
}, 30000);

const facts: {
  stage: string;
  readinessState: CurrentRuntimeSourceBuildReadinessV3['state'] | null;
  readinessReason: CurrentRuntimeSourceBuildReadinessV3['reason'] | null;
  status: number | null;
  publicDTOvalid: boolean | null;
  headCommitted: boolean | null;
  requestMatches: boolean | null;
  writerEntered: number;
  writerReturned: number;
  writerThrew: number;
  writerError: ReturnType<typeof diagnostic> | null;
} = {
  stage: 'not_started',
  readinessState: null,
  readinessReason: null,
  status: null,
  publicDTOvalid: null,
  headCommitted: null,
  requestMatches: null,
  writerEntered: 0,
  writerReturned: 0,
  writerThrew: 0,
  writerError: null,
};
async function saveFacts() {
  const target = process.env['WM_NUTRITION_HTTP_FACTS_PATH'];
  if (target === undefined) return;
  if (
    !/^\/private\/tmp\/wm-nutrition-http-v9-diag-cluster-[A-Za-z0-9]+\/http-facts\.json$/.test(
      target,
    )
  )
    throw new Error('FINITE_DIAGNOSTIC_PATH_INVALID');
  await writeFile(target, JSON.stringify(facts), { flag: 'wx', mode: 0o600 });
}
it('approves the long-ID zero/unknown meal through actual current V9 HTTP and persists the returned approval', async () => {
  const db = database;
  if (!db) throw new Error('DIAGNOSTIC_DATABASE_NOT_READY');
  try {
    facts.stage = 'account';
    const athlete = randomUUID();
    const owner = new Pool({ connectionString: connection(ownerRole), max: 1 });
    try {
      await owner.query(
        "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
        [athlete, randomUUID()],
      );
    } finally {
      await owner.end();
    }
    facts.stage = 'readiness';
    const observedDatabase: Database = { ...db };
    const snapshotCatalog = db.snapshotCatalog;
    if (snapshotCatalog !== undefined) {
      // Same transaction and callback, no additional query/probe. Observation
      // failures never change the callback result or the original error.
      observedDatabase.snapshotCatalog = async (operation) =>
        snapshotCatalog(async (transaction) => {
          const result = await operation(transaction);
          try {
            const parsed = currentRuntimeSourceBuildReadinessV3Schema.safeParse(result);
            if (parsed.success) {
              facts.readinessState = parsed.data.state;
              facts.readinessReason = parsed.data.reason;
            }
          } catch {
            // Leave observation unknown and return the original result.
          }
          return result;
        });
    }
    const ports = await createRegisteredCurrentRuntimeRepositoriesV3(observedDatabase);
    const origin = 'http://127.0.0.1:4301';
    const cookie = 'session=synthetic-nutrition-current-v9';
    const csrfToken = 's'.repeat(43);
    api = createApi({
      auth: {
        authenticate: async (credentials) =>
          credentials.cookie === cookie
            ? { athleteId: athlete, sessionId: 'synthetic-current', csrfToken, method: 'cookie' }
            : null,
      },
      consent: createConsentRepository(db),
      nutrition: createNutritionRepository(db),
      nutritionV4: createNutritionPlanV4Reader(db),
      races: createRaceRepository(db),
      restoreGeneration: createRestoreGenerationRepository(db),
      nutritionV4Writer: {
        savePlanV4: async (athleteId, input) => {
          facts.writerEntered++;
          try {
            const expected = saveNutritionPlanV4IntentSchema.safeParse(expectedWriterRequest);
            const actual = saveNutritionPlanV4IntentSchema.safeParse(input);
            facts.requestMatches =
              athleteId === athlete &&
              expected.success &&
              actual.success &&
              JSON.stringify(expected.data) === JSON.stringify(actual.data);
          } catch {
            facts.requestMatches = false;
          }
          return ports.nutritionV4Writer.savePlanV4(athleteId, input).then(
            (result) => {
              facts.writerReturned++;
              try {
                facts.publicDTOvalid = nutritionPlanPublicApprovalV4ResultSchema.safeParse({
                  schemaVersion: 4,
                  ...result,
                }).success;
              } catch {
                facts.publicDTOvalid = false;
              }
              return result;
            },
            (error) => {
              facts.writerThrew++;
              facts.writerError = diagnostic(error);
              throw error;
            },
          );
        },
      },
      allowedOrigins: [origin],
      logStream: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    });
    facts.stage = 'http_start';
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const get = async (path: string, requestHeaders: Record<string, string> = { cookie }) => {
      const response = await fetch(new URL('/bff/v1' + path, address), {
        headers: requestHeaders,
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      return body;
    };
    const session = z
      .object({ sessionId: z.string(), csrfToken: z.string() })
      .parse(await get('/session'));
    const headers = {
      cookie,
      origin,
      'x-workout-session-id': session.sessionId,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    };
    const post = async (
      path: string,
      body: unknown,
      expectedStatus: 200 | 201 = 200,
      key = randomUUID(),
    ) => {
      const response = await fetch(new URL('/bff/v1' + path, address), {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(expectedStatus);
      const value: unknown = await response.json();
      return value;
    };
    facts.stage = 'consent';
    const currentConsent = z
      .object({ revision: z.number().int() })
      .parse(await get('/consents/app', headers));
    const consent = await fetch(new URL('/bff/v1/consents/app', address), {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ granted: true, expectedRevision: currentConsent.revision }),
      signal: AbortSignal.timeout(10000),
    });
    expect(consent.status).toBe(200);
    facts.stage = 'race';
    const race = raceCommandResultSchema.parse(
      await post(
        '/races',
        {
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
        },
        201,
      ),
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

    facts.stage = 'absolute_plan';
    const original = nutritionPlanVersionSchema.parse(
      await post('/nutrition/plans', { kind: 'create', confirmed: true, draft }),
    );
    facts.stage = 'restore_generation';
    const { generationId } = restoreGenerationResponseSchema.parse(
      await get('/restore-generation', headers),
    );
    const unknown = <Unit extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: Unit) => ({
      value: null,
      unit,
      status: 'unknown' as const,
      evidenceIds: [],
    });
    facts.stage = 'intake';
    const intake = intakeEntryRecordSchema.parse(
      await post('/nutrition/intakes', {
        intakeId: `intake-${randomUUID()}`,
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
    const request = {
      schemaVersion: 4,
      intent: {
        schemaVersion: 3,
        command: {
          kind: 'update',
          expectedHeadVersionId: original.versionId,
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
    };
    const approvalKey = randomUUID();
    const expectedWriterRequest = {
      ...request,
      intent: {
        ...request.intent,
        command: {
          ...request.intent.command,
          planId: original.planId,
          idempotencyKey: approvalKey,
        },
      },
    };
    facts.stage = 'initial_v4_approval';
    const response = await fetch(
      new URL(`/bff/v1/nutrition/plans/${original.planId}/approve-v4`, address),
      {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': approvalKey },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10000),
      },
    );
    facts.status = response.status;
    // Inspect the persisted head even on a rejected HTTP response, without returning its body to diagnostics.
    const stored = await createNutritionPlanV4Reader(db).readPlanV4(athlete, original.planId);
    facts.headCommitted =
      stored?.head?.previousVersionId === original.versionId &&
      stored.head.version === original.version + 1;
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const approved = nutritionPlanPublicApprovalV4ResultSchema.parse(body);
    expect(facts.requestMatches).toBe(true);
    expect(facts.writerEntered).toBe(1);
    expect(facts.writerReturned).toBe(1);
    expect(facts.writerThrew).toBe(0);
    expect(facts.publicDTOvalid).toBe(true);
    expect(facts.headCommitted).toBe(true);
    expect(stored?.head).toEqual(approved.plan);
    expect(approved.plan.previousVersionId).toBe(original.versionId);
    expect(approved.plan.items[0]?.foods).toEqual(foods);
    expect(
      nutritionPlanVersionV4Schema.parse(approved.plan).itemRaceTimingBindings[0]?.binding.state,
    ).toBe('captured');
    const retained = await createNutritionRepository(db).readIntake(athlete, intake.intakeId);
    expect(retained).toEqual(intake);
    facts.stage = 'complete';
  } catch (error) {
    throw new Error(JSON.stringify({ stage: facts.stage, ...diagnostic(error) }));
  } finally {
    await saveFacts();
  }
}, 90000);
