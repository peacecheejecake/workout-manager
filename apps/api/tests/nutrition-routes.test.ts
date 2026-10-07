import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  NutritionReadLimitError,
  NutritionReadVersionError,
  NutritionReferenceError,
} from '@workout/server-persistence/nutrition-core';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { StaleRestoreGenerationError } from '@workout/server-persistence/restore-generation';
import { createApi } from '../src/app.js';

const base = '/bff/v1/nutrition';
const generationId = '30000000-0000-4000-8000-000000000001';
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'session-current',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'nutrition-command-1',
};
const draft = {
  period: { from: '2026-09-18', toInclusive: '2026-09-19' },
  timezone: 'Asia/Seoul',
  purpose: 'Training day',
  linkedTrainingPlanVersionId: null,
  items: [],
};
const apps: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true, withV4 = false) {
  const nutritionV4 = {
    readPlanV4: vi.fn().mockResolvedValue(null),
    listPlansV4: vi.fn().mockResolvedValue({ schemaVersion: 4, plans: [], nextCursor: null }),
  };
  const nutrition = {
    listPlans: vi.fn().mockResolvedValue({ plans: [], nextCursor: null }),
    readPlan: vi.fn().mockResolvedValue(null),
    readPlanV2: vi.fn().mockResolvedValue(null),
    readPlanV3: vi.fn().mockResolvedValue(null),
    listPlansV3: vi.fn().mockResolvedValue({ schemaVersion: 3, plans: [], nextCursor: null }),
    replayPlanV3: vi.fn().mockResolvedValue(null),
    savePlan: vi.fn().mockRejectedValue(new NutritionReferenceError('PLAN_LINK_INVALID')),
    listFoods: vi.fn().mockResolvedValue({ foods: [], nextCursor: null }),
    readFood: vi.fn().mockResolvedValue(null),
    saveFood: vi.fn(),
    listIntakes: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
    readIntake: vi.fn().mockResolvedValue(null),
    createIntake: vi.fn(),
    correctIntake: vi.fn(),
    deleteIntake: vi.fn(),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'owner',
              sessionId: 'session-current',
              csrfToken: headers['x-csrf-token'],
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    nutrition,
    ...(withV4 ? { nutritionV4 } : {}),
    restoreGeneration: { read: vi.fn().mockResolvedValue({ generationId }) },
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, nutrition, nutritionV4 };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it('binds nutrition reads and commands to the current tenant and rejects forged command fields', async () => {
  const { app, nutrition } = setup();
  const plans = await app.inject({
    url: `${base}/plans?from=2026-09-18&toInclusive=2026-09-19`,
    headers,
  });
  expect(plans.statusCode).toBe(200);
  expect(nutrition.listPlans).toHaveBeenCalledWith('owner', {
    from: '2026-09-18',
    toInclusive: '2026-09-19',
    limit: 50,
    cursor: null,
  });
  const create = { kind: 'create', confirmed: true, draft };
  for (const payload of [
    { ...create, idempotencyKey: 'body-key-1' },
    { ...create, athleteId: 'foreign' },
    { ...create, confirmed: false },
  ]) {
    expect(
      (await app.inject({ method: 'POST', url: `${base}/plans`, headers, payload })).statusCode,
    ).toBe(400);
  }
  expect(nutrition.savePlan).not.toHaveBeenCalled();
  const invalidLink = await app.inject({
    method: 'POST',
    url: `${base}/plans`,
    headers,
    payload: create,
  });
  expect(invalidLink.statusCode).toBe(422);
  expect(invalidLink.json().error.code).toBe('PLAN_LINK_INVALID');
  expect(nutrition.savePlan).toHaveBeenCalledWith('owner', {
    ...create,
    idempotencyKey: headers['idempotency-key'],
  });
});

it('keeps authentication and CSRF ahead of nutrition repository access', async () => {
  const anonymous = setup(false);
  expect((await anonymous.app.inject({ url: `${base}/foods`, headers })).statusCode).toBe(401);
  expect(anonymous.nutrition.listFoods).not.toHaveBeenCalled();
  const { app, nutrition } = setup();
  const payload = { kind: 'create', confirmed: true, draft };
  for (const changed of [
    { ...headers, 'x-csrf-token': 'bad' },
    { ...headers, 'x-workout-session-id': 'session-old' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `${base}/plans`,
      headers: changed,
      payload,
    });
    expect([403, 409]).toContain(response.statusCode);
  }
  expect(nutrition.savePlan).not.toHaveBeenCalled();
});

it('maps stale heads, missing entries and malformed cursors to stable client errors', async () => {
  const { app, nutrition } = setup();
  nutrition.savePlan.mockRejectedValueOnce(new PersistenceConflict('REVISION_CONFLICT'));
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/plans`,
        headers,
        payload: { kind: 'create', confirmed: true, draft },
      })
    ).statusCode,
  ).toBe(409);
  nutrition.listFoods.mockRejectedValueOnce(new Error('INVALID_CURSOR'));
  expect((await app.inject({ url: `${base}/foods?cursor=invalid`, headers })).statusCode).toBe(400);
  expect((await app.inject({ url: `${base}/intakes/missing`, headers })).statusCode).toBe(404);
});

it('reads the generation only for an authenticated tenant and rejects stale create requests distinctly', async () => {
  const anonymous = setup(false);
  expect((await anonymous.app.inject({ url: '/bff/v1/restore-generation' })).statusCode).toBe(401);
  const { app, nutrition } = setup();
  const read = await app.inject({ url: '/bff/v1/restore-generation', headers });
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('no-store');
  expect(read.json()).toEqual({ generationId });
  expect(
    (await app.inject({ url: '/bff/v1/restore-generation?unexpected=1', headers })).statusCode,
  ).toBe(400);
  const body = {
    restoreGeneration: generationId,
    intakeId: 'intake-route-1',
    confirmed: true,
    occurredAt: '2026-09-18T08:00:00.000Z',
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: null,
        description: 'Snack',
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'unknown',
      },
    ],
    nutrientTotal: Object.fromEntries(
      [
        ['energy', 'kcal'],
        ['carbohydrate', 'g'],
        ['protein', 'g'],
        ['fat', 'g'],
        ['fluid', 'mL'],
        ['sodium', 'mg'],
      ].map(([key, unit]) => [key, { value: null, unit, status: 'unknown', evidenceIds: [] }]),
    ),
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  };
  const missing = await app.inject({
    method: 'POST',
    url: `${base}/intakes`,
    headers,
    payload: { ...body, restoreGeneration: undefined },
  });
  expect(missing.statusCode).toBe(400);
  expect(nutrition.createIntake).not.toHaveBeenCalled();
  nutrition.createIntake.mockRejectedValueOnce(new StaleRestoreGenerationError());
  const stale = await app.inject({
    method: 'POST',
    url: `${base}/intakes`,
    headers,
    payload: body,
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe('STALE_RESTORE_GENERATION');
  expect(nutrition.createIntake).toHaveBeenCalledWith('owner', {
    ...body,
    idempotencyKey: headers['idempotency-key'],
  });
});

const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const retainedV3 = {
  schemaVersion: 3,
  planId,
  versionId,
  version: 1,
  previousVersionId: null,
  approvalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  approvedAt: '2026-10-07T00:00:00Z',
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'Asia/Seoul',
  purpose: 'Retained',
  linkedTrainingPlanVersionId: null,
  items: [
    {
      id: 'Meal',
      planVersionId: versionId,
      category: 'before',
      title: 'Food',
      anchor: { kind: 'disconnected', entity: 'race' },
      foods: [
        {
          foodVersionId: null,
          description: 'Food',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'manual_total',
        },
      ],
      targets: [],
      instructions: '',
      evidenceIds: [],
      source: 'user_confirmed',
    },
  ],
  raceTimingPins: [],
  itemRaceTimingBindings: [],
};
it('replays only an existing owned save receipt through explicit V3 without creating a plan', async () => {
  const { app, nutrition } = setup();
  const payload = { kind: 'create', confirmed: true, draft };
  const url = `${base}/plans/replay-v3`;
  const missing = await app.inject({ method: 'POST', url, headers, payload });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe('NUTRITION_SAVE_RECEIPT_NOT_FOUND');
  nutrition.replayPlanV3.mockResolvedValue(retainedV3);
  const replayed = await app.inject({ method: 'POST', url, headers, payload });
  expect(replayed.statusCode).toBe(200);
  expect(replayed.json()).toEqual(retainedV3);
  expect(nutrition.replayPlanV3).toHaveBeenLastCalledWith('owner', {
    ...payload,
    idempotencyKey: headers['idempotency-key'],
  });
  nutrition.replayPlanV3.mockRejectedValueOnce(new PersistenceConflict('IDEMPOTENCY_CONFLICT'));
  expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(409);
  nutrition.replayPlanV3.mockClear();
  for (const forged of [
    { ...payload, athleteId: 'foreign' },
    { ...payload, confirmed: false },
  ]) {
    expect((await app.inject({ method: 'POST', url, headers, payload: forged })).statusCode).toBe(
      400,
    );
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'x-csrf-token': 'bad' },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(nutrition.replayPlanV3).not.toHaveBeenCalled();
  expect(nutrition.savePlan).not.toHaveBeenCalled();
  const anonymous = setup(false);
  expect((await anonymous.app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(
    401,
  );
  expect(anonymous.nutrition.replayPlanV3).not.toHaveBeenCalled();
});
it('dispatches explicit V3 current-head list and detail with authenticated ownership and strict response decoding', async () => {
  const { app, nutrition } = setup();
  const read = {
    schemaVersion: 3,
    planId,
    head: retainedV3,
    history: [{ versionId, version: 1, approvedAt: retainedV3.approvedAt }],
  };
  nutrition.readPlanV3.mockResolvedValue(read);
  nutrition.listPlansV3.mockResolvedValue({
    schemaVersion: 3,
    plans: [retainedV3],
    nextCursor: null,
  });
  const detail = await app.inject({
    url: `${base}/plans/${planId.toUpperCase()}?maxSchemaVersion=3`,
    headers,
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toEqual(read);
  expect(nutrition.readPlanV3).toHaveBeenCalledWith('owner', planId);
  expect(nutrition.readPlan).not.toHaveBeenCalled();
  const list = await app.inject({
    url: `${base}/plans?from=2026-10-07&toInclusive=2026-10-07&maxSchemaVersion=3`,
    headers,
  });
  expect(list.statusCode).toBe(200);
  expect(list.json().plans).toEqual([retainedV3]);
  expect(nutrition.listPlansV3).toHaveBeenCalledWith('owner', {
    from: '2026-10-07',
    toInclusive: '2026-10-07',
    limit: 50,
    cursor: null,
  });
  nutrition.readPlanV3.mockResolvedValue({ ...read, rawSource: 'never disclose' });
  const invalid = await app.inject({ url: `${base}/plans/${planId}?maxSchemaVersion=3`, headers });
  expect(invalid.statusCode).toBe(500);
  expect(invalid.body).not.toContain('never disclose');
});
it('keeps exact V2 detail separate and refuses nonexistent V2 list transport', async () => {
  const { app, nutrition } = setup();
  nutrition.readPlanV2.mockResolvedValue({ schemaVersion: 2, planId, head: null, history: [] });
  const response = await app.inject({ url: `${base}/plans/${planId}?maxSchemaVersion=2`, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ schemaVersion: 2, planId, head: null, history: [] });
  const list = await app.inject({
    url: `${base}/plans?from=2026-10-07&toInclusive=2026-10-07&maxSchemaVersion=2`,
    headers,
  });
  expect(list.statusCode).toBe(409);
  expect(list.json().error.code).toBe('NUTRITION_READ_VERSION_UNSUPPORTED');
  expect(nutrition.listPlans).not.toHaveBeenCalled();
  expect(nutrition.listPlansV3).not.toHaveBeenCalled();
});
it('preserves legacy detail wire, returns missing V3 distinctly and validates read negotiation before access', async () => {
  const { app, nutrition } = setup();
  nutrition.readPlan.mockResolvedValue({ planId, head: null, history: [] });
  const response = await app.inject({ url: `${base}/plans/${planId}`, headers });
  expect(response.json()).toEqual({ planId, head: null, history: [] });
  expect(
    (await app.inject({ url: `${base}/plans/${planId}?maxSchemaVersion=3`, headers })).statusCode,
  ).toBe(404);
  nutrition.readPlanV3.mockClear();
  for (const suffix of [
    'maxSchemaVersion=5',
    'maxSchemaVersion=0',
    'maxSchemaVersion=3&athleteId=foreign',
  ]) {
    expect(
      (await app.inject({ url: `${base}/plans/${planId}?${suffix}`, headers })).statusCode,
    ).toBe(400);
  }
  expect(nutrition.readPlanV3).not.toHaveBeenCalled();
  const anonymous = setup(false);
  expect(
    (await anonymous.app.inject({ url: `${base}/plans/${planId}?maxSchemaVersion=3`, headers }))
      .statusCode,
  ).toBe(401);
  expect(anonymous.nutrition.readPlanV3).not.toHaveBeenCalled();
});
it.each([
  [new NutritionReadVersionError(), 409, 'NUTRITION_READ_VERSION_UNSUPPORTED'],
  [new NutritionReadLimitError(), 422, 'NUTRITION_READ_LIMIT'],
] as const)(
  'sanitizes read boundary errors without exposing stored bodies',
  async (error, status, code) => {
    const { app, nutrition } = setup();
    nutrition.readPlan.mockRejectedValue(error);
    const response = await app.inject({ url: `${base}/plans/${planId}`, headers });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.body).not.toContain('record_json');
  },
);

it('reads explicit V4 detail and list through the injected owned reader without mutations or legacy dispatch', async () => {
  const { app, nutrition, nutritionV4 } = setup(true, true);
  const head = { ...retainedV3, schemaVersion: 4 };
  const read = {
    schemaVersion: 4,
    planId,
    head,
    history: [{ versionId, version: 1, approvedAt: head.approvedAt }],
  };
  nutritionV4.readPlanV4.mockResolvedValue(read);
  nutritionV4.listPlansV4.mockResolvedValue({ schemaVersion: 4, plans: [head], nextCursor: null });
  const detail = await app.inject({
    url: `${base}/plans/${planId.toUpperCase()}?maxSchemaVersion=4`,
    headers,
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toEqual(read);
  expect(nutritionV4.readPlanV4).toHaveBeenCalledExactlyOnceWith('owner', planId);
  const list = await app.inject({
    url: `${base}/plans?from=2026-10-07&toInclusive=2026-10-07&limit=1&maxSchemaVersion=4`,
    headers,
  });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual({ schemaVersion: 4, plans: [head], nextCursor: null });
  expect(nutritionV4.listPlansV4).toHaveBeenCalledExactlyOnceWith('owner', {
    from: '2026-10-07',
    toInclusive: '2026-10-07',
    limit: 1,
    cursor: null,
  });
  for (const port of [
    nutrition.readPlan,
    nutrition.readPlanV2,
    nutrition.readPlanV3,
    nutrition.listPlans,
    nutrition.listPlansV3,
    nutrition.savePlan,
    nutrition.createIntake,
  ])
    expect(port).not.toHaveBeenCalled();
  expect(detail.json().head.items[0].anchor).toEqual({ kind: 'disconnected', entity: 'race' });
  expect(detail.json().head.items[0].foods[0].quantity).toBe(0);
});

it('distinguishes absent V4 capability, missing owned plan and unauthenticated access', async () => {
  const absent = setup();
  for (const url of [
    `${base}/plans/${planId}?maxSchemaVersion=4`,
    `${base}/plans?from=2026-10-07&toInclusive=2026-10-07&maxSchemaVersion=4`,
  ]) {
    const reply = await absent.app.inject({ url, headers });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('NUTRITION_READ_VERSION_UNSUPPORTED');
  }
  expect(absent.nutrition.readPlan).not.toHaveBeenCalled();
  const present = setup(true, true);
  const foreign = await present.app.inject({
    url: `${base}/plans/${versionId}?maxSchemaVersion=4`,
    headers,
  });
  expect(foreign.statusCode).toBe(404);
  expect(foreign.json().error.code).toBe('NUTRITION_PLAN_NOT_FOUND');
  expect(present.nutritionV4.readPlanV4).toHaveBeenCalledWith('owner', versionId);
  const anonymous = setup(false, true);
  expect(
    (await anonymous.app.inject({ url: `${base}/plans/${planId}?maxSchemaVersion=4`, headers }))
      .statusCode,
  ).toBe(401);
  expect(anonymous.nutritionV4.readPlanV4).not.toHaveBeenCalled();
});

it('rejects invalid negotiation before V4 access while retaining default and max3 dispatch', async () => {
  const { app, nutrition, nutritionV4 } = setup(true, true);
  for (const query of [
    'maxSchemaVersion=0',
    'maxSchemaVersion=5',
    'maxSchemaVersion=4.5',
    'maxSchemaVersion=4&maxSchemaVersion=3',
    'maxSchemaVersion=4&athleteId=foreign',
  ]) {
    expect(
      (await app.inject({ url: `${base}/plans/${planId}?${query}`, headers })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `${base}/plans?from=2026-10-07&toInclusive=2026-10-07&${query}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  }
  expect(nutritionV4.readPlanV4).not.toHaveBeenCalled();
  expect(nutritionV4.listPlansV4).not.toHaveBeenCalled();
  nutrition.readPlan.mockResolvedValue({ planId, head: null, history: [] });
  expect((await app.inject({ url: `${base}/plans/${planId}`, headers })).json()).toEqual({
    planId,
    head: null,
    history: [],
  });
  nutrition.readPlanV3.mockRejectedValue(new NutritionReadVersionError());
  const incompatible = await app.inject({
    url: `${base}/plans/${planId}?maxSchemaVersion=3`,
    headers,
  });
  expect(incompatible.statusCode).toBe(409);
  expect(incompatible.json().error.code).toBe('NUTRITION_READ_VERSION_UNSUPPORTED');
  expect(nutritionV4.readPlanV4).not.toHaveBeenCalled();
});

it('strictly rejects wrong V4 response tuple, unknown bodies and duplicate heads without disclosure', async () => {
  const { app, nutritionV4 } = setup(true, true);
  const head = { ...retainedV3, schemaVersion: 4 };
  const read = { schemaVersion: 4, planId, head, history: [] };
  for (const body of [
    { ...read, rawSource: 'private-boundary-secret' },
    { ...read, planId: versionId, head: { ...head, planId: versionId } },
    { ...read, head: { ...head, planId: versionId } },
    { ...read, head: { ...head, rawSource: 'private-boundary-secret' } },
  ]) {
    nutritionV4.readPlanV4.mockResolvedValue(body);
    const reply = await app.inject({ url: `${base}/plans/${planId}?maxSchemaVersion=4`, headers });
    expect(reply.statusCode).toBe(500);
    expect(reply.body).not.toContain('private-boundary-secret');
  }
  nutritionV4.listPlansV4.mockResolvedValue({
    schemaVersion: 4,
    plans: [head, head],
    nextCursor: null,
  });
  expect(
    (
      await app.inject({
        url: `${base}/plans?from=2026-10-07&toInclusive=2026-10-07&maxSchemaVersion=4`,
        headers,
      })
    ).statusCode,
  ).toBe(500);
});

it('maps V4 size boundary failures to stable sanitized errors', async () => {
  const { app, nutritionV4 } = setup(true, true);
  nutritionV4.readPlanV4.mockRejectedValue(new NutritionReadLimitError());
  nutritionV4.listPlansV4.mockRejectedValue(new NutritionReadLimitError());
  for (const url of [
    `${base}/plans/${planId}?maxSchemaVersion=4`,
    `${base}/plans?from=2026-10-07&toInclusive=2026-10-07&maxSchemaVersion=4`,
  ]) {
    const reply = await app.inject({ url, headers });
    expect(reply.statusCode).toBe(422);
    expect(reply.json().error.code).toBe('NUTRITION_READ_LIMIT');
    expect(reply.body).not.toContain('record_json');
  }
});
