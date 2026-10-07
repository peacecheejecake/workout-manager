import { Writable } from 'node:stream';
import { createApi } from '../src/app.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { NutritionRacePlanV4WriterError } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { NutritionReferenceError } from '@workout/server-persistence/nutrition-core';
import { RaceTimingBindingError } from '@workout/server-persistence/race-timing-bindings';
import { NutritionRacePlanV4PreviewError } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { AppConsentRequiredError } from '@workout/server-persistence/app-admission';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  priorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const athlete = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const item = {
  id: '식사-' + '한'.repeat(1001),
  category: 'meal',
  title: 'Meal',
  anchor: { kind: 'disconnected', entity: 'race' },
  foods: [
    {
      foodVersionId: null,
      description: 'portion',
      quantity: 0,
      unit: 'g',
      sourceBasis: 'manual_total',
    },
  ],
  targets: [],
  instructions: 'preserved',
  evidenceIds: [],
  source: 'user_confirmed',
};
const draft = {
  period: { from: '2080-01-01', toInclusive: '2080-01-31' },
  timezone: 'UTC',
  purpose: 'Reconnect',
  linkedTrainingPlanVersionId: null,
  items: [item],
};
const body = {
  schemaVersion: 4,
  intent: {
    schemaVersion: 3,
    command: { kind: 'update', expectedHeadVersionId: priorId, confirmed: true, draft },
    expectedRaceHeads: [],
    reconnectItemIds: [],
  },
};
const previewBody = {
  schemaVersion: 4,
  expectedHeadVersionId: priorId,
  draft,
  expectedRaceHeads: [],
  reconnectItemIds: [],
};
const plan = nutritionPlanVersionV4Schema.parse({
  ...draft,
  schemaVersion: 4,
  planId,
  versionId,
  version: 2,
  previousVersionId: priorId,
  approvalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  approvedAt: '2080-01-01T00:00:00.000Z',
  items: [{ ...item, planVersionId: versionId }],
  raceTimingPins: [],
  itemRaceTimingBindings: [],
});
const origin = 'https://workout.example';
const csrfToken = 'c'.repeat(43);
const previewHeaders = {
  cookie: 'session=fixture',
  origin,
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};
const headers = { ...previewHeaders, 'idempotency-key': 'nutrition_fixture_0001' };
function projection() {
  const { evidenceIds, source, ...safe } = item;
  void evidenceIds;
  void source;
  const safePlan = { ...draft, items: [safe] };
  return {
    schemaVersion: 4,
    status: 'projected',
    expectedPlan: { planId, versionId: priorId, version: 1 },
    expectedRaceHeads: [],
    before: safePlan,
    after: safePlan,
    items: [
      {
        itemId: item.id,
        change: 'preserved',
        before: { state: 'suspended', reason: 'race_disconnected' },
        after: { state: 'suspended', reason: 'race_disconnected' },
      },
    ],
    notices: [],
    blocks: [],
    persistence: 'not_stored',
    freshness: 'not_checked',
    approvalAllowed: false,
  };
}
const apps: ReturnType<typeof createApi>[] = [];
function setup(enabled = true) {
  const writer = { savePlanV4: vi.fn().mockResolvedValue({ plan, notices: [] }) },
    preview = { previewPlanV4: vi.fn().mockResolvedValue(projection()) };
  const app = createApi({
    auth: {
      authenticate: async (credentials) =>
        credentials.cookie === 'session=fixture'
          ? { athleteId: athlete, sessionId: 'current', csrfToken, method: 'cookie' }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    allowedOrigins: [origin],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    ...(enabled ? { nutritionV4Writer: writer, nutritionV4Preview: preview } : {}),
  });
  apps.push(app);
  return { app, writer, preview };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const approvalPath = `/bff/v1/nutrition/plans/${planId}/approve-v4`,
  previewPath = `/bff/v1/nutrition/plans/${planId}/preview-v4`;
describe('public nutrition V4 routes inside actual product auth/CSRF; repository mocks only', () => {
  it('composes path and header only and returns validated committed record', async () => {
    const { app, writer } = setup();
    const reply = await app.inject({ method: 'POST', url: approvalPath, headers, payload: body });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ schemaVersion: 4, plan, notices: [] });
    expect(writer.savePlanV4).toHaveBeenCalledWith(athlete, {
      ...body,
      intent: {
        ...body.intent,
        command: { ...body.intent.command, planId, idempotencyKey: headers['idempotency-key'] },
      },
    });
    expect(reply.headers['cache-control']).toBe('private, no-store');
  });
  it('calls write-free preview without key or confirmation and binds path/head', async () => {
    const { app, preview, writer } = setup();
    const reply = await app.inject({
      method: 'POST',
      url: previewPath,
      headers: previewHeaders,
      payload: previewBody,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(projection());
    expect(preview.previewPlanV4).toHaveBeenCalledWith(athlete, { ...previewBody, planId });
    expect(writer.savePlanV4).not.toHaveBeenCalled();
  });
  it.each(['planId', 'idempotencyKey'])(
    'rejects nested body alias %s even matching composed value',
    async (field) => {
      const { app, writer } = setup();
      const response = await app.inject({
        method: 'POST',
        url: approvalPath,
        headers,
        payload: {
          ...body,
          intent: {
            ...body.intent,
            command: {
              ...body.intent.command,
              [field]: field === 'planId' ? planId : headers['idempotency-key'],
            },
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(writer.savePlanV4).not.toHaveBeenCalled();
    },
  );
  it('rejects caller tenant/pins/extra fields and no confirmation', async () => {
    const { app, writer } = setup();
    for (const payload of [
      { ...body, athleteId: athlete },
      { ...body, raceTimingPins: [] },
      {
        ...body,
        intent: { ...body.intent, command: { ...body.intent.command, confirmed: false } },
      },
    ])
      expect(
        (await app.inject({ method: 'POST', url: approvalPath, headers, payload })).statusCode,
      ).toBe(400);
    expect(writer.savePlanV4).not.toHaveBeenCalled();
  });
  it('rejects query and malformed/repeated/missing key', async () => {
    const { app, writer } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: approvalPath + '?schemaVersion=4',
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    for (const idempotencyKey of [
      undefined,
      'short',
      'bad key',
      ['key_00000001', 'key_00000002'],
    ]) {
      const h = {
        ...previewHeaders,
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      };
      expect(
        (await app.inject({ method: 'POST', url: approvalPath, headers: h, payload: body }))
          .statusCode,
      ).toBe(400);
    }
    expect(writer.savePlanV4).not.toHaveBeenCalled();
  });
  it('preview rejects even valid idempotency header and private input', async () => {
    const { app, preview } = setup();
    expect(
      (await app.inject({ method: 'POST', url: previewPath, headers, payload: previewBody }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: previewPath,
          headers: previewHeaders,
          payload: { ...previewBody, confirmed: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(preview.previewPlanV4).not.toHaveBeenCalled();
  });
  it('authenticated exact capabilities show support only and no query', async () => {
    const { app } = setup();
    const url = '/bff/v1/nutrition/plans/capabilities';
    expect((await app.inject({ url, headers })).json()).toEqual({
      schemaVersion: 1,
      readV4: false,
      previewV4: true,
      standaloneApprovalV4: true,
    });
    expect((await app.inject({ url: url + '?x=1', headers })).statusCode).toBe(400);
    expect((await app.inject({ url })).statusCode).toBe(401);
  });
  it('disabled ports return finite unavailable with zero repository calls', async () => {
    const { app, writer, preview } = setup(false);
    expect(
      (await app.inject({ url: '/bff/v1/nutrition/plans/capabilities', headers })).json(),
    ).toEqual({ schemaVersion: 1, readV4: false, previewV4: false, standaloneApprovalV4: false });
    expect(
      (await app.inject({ method: 'POST', url: approvalPath, headers, payload: body })).statusCode,
    ).toBe(503);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: previewPath,
          headers: previewHeaders,
          payload: previewBody,
        })
      ).statusCode,
    ).toBe(503);
    expect(writer.savePlanV4).not.toHaveBeenCalled();
    expect(preview.previewPlanV4).not.toHaveBeenCalled();
  });
  it('preserves parent auth and CSRF rejection before repository calls', async () => {
    const { app, writer } = setup();
    expect(
      (await app.inject({ method: 'POST', url: approvalPath, payload: body })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: approvalPath,
          headers: {
            ...previewHeaders,
            'x-csrf-token': '',
            'idempotency-key': headers['idempotency-key'],
          },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(writer.savePlanV4).not.toHaveBeenCalled();
  });
  it.each([
    [new PersistenceConflict('REVISION_CONFLICT'), 409, 'REVISION_CONFLICT'],
    [new AppConsentRequiredError(), 409, 'APP_CONSENT_REQUIRED'],
    [new NutritionReferenceError('PLAN_NOT_FOUND'), 404, 'PLAN_NOT_FOUND'],
    [
      new NutritionRacePlanV4WriterError('NUTRITION_V4_RECONNECT_REQUIRED'),
      422,
      'NUTRITION_V4_RECONNECT_REQUIRED',
    ],
    [new RaceTimingBindingError('RACE_TIMING_STALE'), 409, 'RACE_TIMING_STALE'],
    [new NutritionRacePlanV4WriterError('NUTRITION_V4_SOURCE_INVALID'), 500, 'INTERNAL_ERROR'],
    [new Error('private raw SQL payload'), 500, 'INTERNAL_ERROR'],
  ])('sanitizes known/unknown failures %s', async (error, status, code) => {
    const { app, writer } = setup();
    writer.savePlanV4.mockRejectedValue(error);
    const reply = await app.inject({ method: 'POST', url: approvalPath, headers, payload: body });
    expect(reply.statusCode).toBe(status);
    expect(reply.json()).toEqual({ error: { code }, requestId: expect.any(String) });
    expect(reply.body).not.toContain('private raw');
  });
  it('rejects invalid outgoing proof/private metadata and wrong identity/predecessor', async () => {
    const { app, writer } = setup();
    for (const result of [
      { plan: { ...plan, planId: priorId }, notices: [] },
      { plan: { ...plan, previousVersionId: versionId }, notices: [] },
      { plan: { ...plan, privateContext: {} }, notices: [] },
      { plan, notices: [{ itemId: 'absent', code: 'UNRESOLVED_PRESERVED' }] },
    ]) {
      writer.savePlanV4.mockResolvedValue(result);
      expect(
        (await app.inject({ method: 'POST', url: approvalPath, headers, payload: body }))
          .statusCode,
      ).toBe(500);
    }
  });
  it('rejects wrong preview plan/head/unknown fields while preserving unavailable finite response', async () => {
    const { app, preview } = setup();
    const auth = previewHeaders;
    for (const result of [
      { ...projection(), expectedPlan: { planId: priorId, versionId: priorId, version: 1 } },
      { ...projection(), expectedPlan: { planId, versionId, version: 1 } },
      { ...projection(), privateRecipe: {} },
    ]) {
      preview.previewPlanV4.mockResolvedValue(result);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: previewPath,
            headers: auth,
            payload: previewBody,
          })
        ).statusCode,
      ).toBe(500);
    }
    const unavailable = {
      schemaVersion: 4,
      status: 'unavailable',
      blocks: [{ itemId: null, code: 'PRIOR_UNAVAILABLE' }],
      persistence: 'not_stored',
      freshness: 'not_checked',
      approvalAllowed: false,
    };
    preview.previewPlanV4.mockResolvedValue(unavailable);
    expect(
      (
        await app.inject({ method: 'POST', url: previewPath, headers: auth, payload: previewBody })
      ).json(),
    ).toEqual(unavailable);
  });
  it('rejects unknown writer envelope/accessor before executing its getter', async () => {
    const { app, writer } = setup();
    writer.savePlanV4.mockResolvedValue({ plan, notices: [], privateContext: {} });
    expect(
      (await app.inject({ method: 'POST', url: approvalPath, headers, payload: body })).statusCode,
    ).toBe(500);
    let called = 0;
    writer.savePlanV4.mockResolvedValue({
      get plan() {
        called++;
        return plan;
      },
      notices: [],
    });
    expect(
      (await app.inject({ method: 'POST', url: approvalPath, headers, payload: body })).statusCode,
    ).toBe(500);
    expect(called).toBe(0);
  });
  it.each([
    ['NUTRITION_V4_PREVIEW_INVALID_INPUT', 400],
    ['NUTRITION_V4_PREVIEW_SNAPSHOT_REQUIRED', 503],
  ] as const)(
    'maps typed preview capability/input error %s without runtime fallback',
    async (code, status) => {
      const { app, preview, writer } = setup();
      preview.previewPlanV4.mockRejectedValue(new NutritionRacePlanV4PreviewError(code));
      const reply = await app.inject({
        method: 'POST',
        url: previewPath,
        headers: previewHeaders,
        payload: previewBody,
      });
      expect(reply.statusCode).toBe(status);
      expect(reply.json()).toEqual({ error: { code }, requestId: expect.any(String) });
      expect(writer.savePlanV4).not.toHaveBeenCalled();
    },
  );
  it('HTTP byte cap rejects before repositories', async () => {
    const { app, writer } = setup();
    const reply = await app.inject({
      method: 'POST',
      url: approvalPath,
      headers,
      payload: { ...body, padding: 'x'.repeat(524288) },
    });
    expect(reply.statusCode).toBe(413);
    expect(writer.savePlanV4).not.toHaveBeenCalled();
  });
  it('keeps uncertain retries on caller same body/header key', async () => {
    const { app, writer } = setup();
    for (let i = 0; i < 2; i++)
      expect(
        (await app.inject({ method: 'POST', url: approvalPath, headers, payload: body }))
          .statusCode,
      ).toBe(200);
    expect(writer.savePlanV4.mock.calls[0]).toEqual(writer.savePlanV4.mock.calls[1]);
  });
});

it.each([
  { name: 'stale session', headers: { ...headers, 'x-workout-session-id': 'old' }, status: 409 },
  {
    name: 'foreign Origin',
    headers: { ...headers, origin: 'https://foreign.example' },
    status: 403,
  },
])('actual product boundary rejects $name before V4 ports', async (scenario) => {
  const { app, writer, preview } = setup();
  const response = await app.inject({
    method: 'POST',
    url: approvalPath,
    headers: scenario.headers,
    payload: body,
  });
  expect(response.statusCode).toBe(scenario.status);
  expect(writer.savePlanV4).not.toHaveBeenCalled();
  expect(preview.previewPlanV4).not.toHaveBeenCalled();
});

it('reports reader support independently of optional write and preview ports', async () => {
  const reader = { readPlanV4: vi.fn(), listPlansV4: vi.fn() };
  const app = createApi({
    auth: {
      authenticate: async () => ({ athleteId: athlete, sessionId: 'current', method: 'bearer' }),
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    nutritionV4: reader,
    allowedOrigins: [origin],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  const response = await app.inject({ method: 'GET', url: '/bff/v1/nutrition/plans/capabilities' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    schemaVersion: 1,
    readV4: true,
    previewV4: false,
    standaloneApprovalV4: false,
  });
  expect(reader.readPlanV4).not.toHaveBeenCalled();
  expect(reader.listPlansV4).not.toHaveBeenCalled();
});
