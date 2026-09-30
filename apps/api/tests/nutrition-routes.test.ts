import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { NutritionReferenceError } from '@workout/server-persistence/nutrition-core';
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
function setup(authenticated = true) {
  const nutrition = {
    listPlans: vi.fn().mockResolvedValue({ plans: [], nextCursor: null }),
    readPlan: vi.fn().mockResolvedValue(null),
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
    restoreGeneration: { read: vi.fn().mockResolvedValue({ generationId }) },
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, nutrition };
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
