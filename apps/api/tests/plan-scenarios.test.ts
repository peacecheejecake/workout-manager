import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { PlanScenario } from '@workout/contracts/plan-scenarios';
import {
  PlanScenarioError,
  type PlanScenarioRepository,
} from '@workout/server-persistence/plan-scenarios';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { PlanLockedError } from '@workout/server-persistence/planning';
import { SessionCompletionError } from '@workout/server-persistence/session-completions';
import { createApi } from '../src/app.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const root = '/bff/v1/plan-scenarios';
const path = `${root}/${id}`;
const headers = {
  cookie: 'verified',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'scenario-command-0001',
};
const draft = {
  title: 'Alternative',
  timezone: 'UTC',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season' as const,
      title: 'Season',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    },
  ],
  sessions: [],
};
const scenario: PlanScenario = {
  id,
  basePlanVersionId: base,
  label: 'A',
  revision: 1,
  createdAt: '2026-09-17T00:00:00Z',
  updatedAt: '2026-09-17T00:00:00Z',
  draft,
};
const create = { confirmed: true, basePlanVersionId: base, label: 'A' };
const save = { confirmed: true, expectedRevision: 1, draft };
const apply = {
  confirmed: true,
  expectedScenarioRevision: 1,
  expectedPlanVersionId: base,
  expectedCompletionRevision: 0,
};
const receipt = {
  plan: { id: base, version: 2, createdAt: '2026-09-17T00:00:00Z', draft },
  scenarioId: id,
  scenarioRevision: 1,
};
const apps: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const repository = {
    list: vi.fn<PlanScenarioRepository['list']>().mockResolvedValue({ items: [], total: 0 }),
    read: vi.fn<PlanScenarioRepository['read']>().mockResolvedValue(scenario),
    readRevision: vi.fn<PlanScenarioRepository['readRevision']>().mockResolvedValue(scenario),
    create: vi.fn<PlanScenarioRepository['create']>().mockResolvedValue(scenario),
    save: vi.fn<PlanScenarioRepository['save']>().mockResolvedValue(scenario),
    apply: vi.fn<PlanScenarioRepository['apply']>().mockResolvedValue(receipt),
  };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'owner-from-auth',
              sessionId: 'current',
              csrfToken: headers['x-csrf-token'],
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    planScenarios: repository,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, repository };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('derives ownership from auth and normalizes bounded list and historical revision reads', async () => {
  const { app, repository } = setup();
  expect(
    (
      await app.inject({
        url: `${root}?basePlanVersionId=${base.toUpperCase()}&limit=2&offset=1`,
        headers,
      })
    ).statusCode,
  ).toBe(200);
  expect(repository.list).toHaveBeenCalledWith('owner-from-auth', {
    basePlanVersionId: base,
    limit: 2,
    offset: 1,
  });
  expect((await app.inject({ url: `${root}/${id.toUpperCase()}`, headers })).statusCode).toBe(200);
  expect(repository.read).toHaveBeenCalledWith('owner-from-auth', id);
  expect((await app.inject({ url: `${path}/revisions/1`, headers })).statusCode).toBe(200);
  expect(repository.readRevision).toHaveBeenCalledWith('owner-from-auth', id, 1);
});
it('delegates confirmed create and save commands without applying a current plan', async () => {
  const { app, repository } = setup();
  expect(
    (await app.inject({ method: 'POST', url: root, headers, payload: create })).statusCode,
  ).toBe(200);
  expect(repository.create).toHaveBeenCalledWith('owner-from-auth', {
    ...create,
    idempotencyKey: headers['idempotency-key'],
  });
  expect((await app.inject({ method: 'PUT', url: path, headers, payload: save })).statusCode).toBe(
    200,
  );
  expect(repository.save).toHaveBeenCalledWith('owner-from-auth', id, {
    ...save,
    idempotencyKey: headers['idempotency-key'],
  });
  expect(repository.apply).not.toHaveBeenCalled();
});
it('returns the original repository receipt on repeated explicit apply and retains all revision dependencies', async () => {
  const { app, repository } = setup();
  for (let i = 0; i < 2; i += 1) {
    const response = await app.inject({
      method: 'POST',
      url: `${path}/apply`,
      headers,
      payload: apply,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(receipt);
  }
  expect(repository.apply).toHaveBeenCalledTimes(2);
  expect(repository.apply).toHaveBeenLastCalledWith('owner-from-auth', id, {
    ...apply,
    idempotencyKey: headers['idempotency-key'],
  });
});
it('guards every route with authentication and cookie writes with session, Origin and CSRF checks', async () => {
  const f = setup(false);
  for (const url of [root, path, `${path}/revisions/1`])
    expect((await f.app.inject({ url, headers })).statusCode).toBe(401);
  for (const [method, url, payload] of [
    ['POST', root, create],
    ['PUT', path, save],
    ['POST', `${path}/apply`, apply],
  ] as const)
    expect((await f.app.inject({ method, url, payload, headers })).statusCode).toBe(401);
  const { app, repository } = setup();
  for (const [changed, status] of [
    [{ 'x-workout-session-id': 'old' }, 409],
    [{ origin: 'https://foreign.example' }, 403],
    [{ 'x-csrf-token': 'wrong' }, 403],
  ] as const) {
    const result = await app.inject({
      method: 'POST',
      url: `${path}/apply`,
      payload: apply,
      headers: { ...headers, ...changed },
    });
    expect(result.statusCode).toBe(status);
  }
  expect(repository.apply).not.toHaveBeenCalled();
  for (const fn of Object.values(f.repository)) expect(fn).not.toHaveBeenCalled();
});
it('rejects malformed IDs, revisions, pagination and query provenance before repository access', async () => {
  const { app, repository } = setup();
  for (const url of [
    `${root}/invalid`,
    `${path}/revisions/0`,
    `${path}/revisions/1.5`,
    `${path}/revisions/2147483647`,
    `${root}?limit=101`,
    `${root}?offset=-1`,
    `${root}?athleteId=foreign`,
    `${path}?extra=true`,
  ])
    expect((await app.inject({ url, headers })).statusCode).toBe(400);
  for (const fn of Object.values(repository)) expect(fn).not.toHaveBeenCalled();
});
it('strictly validates confirmation, body provenance, required dependency revisions and header idempotency', async () => {
  const { app, repository } = setup();
  for (const payload of [
    { ...create, confirmed: false },
    { ...create, athleteId: 'foreign' },
    { ...create, idempotencyKey: 'body-key-0001' },
    { ...create, label: '   ' },
    { ...create, label: 'x'.repeat(81) },
    { ...create, label: 'invalid\u0000name' },
  ])
    expect((await app.inject({ method: 'POST', url: root, headers, payload })).statusCode).toBe(
      400,
    );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: root,
        headers: { ...headers, 'idempotency-key': '' },
        payload: create,
      })
    ).statusCode,
  ).toBe(400);
  for (const payload of [
    { ...apply, expectedCompletionRevision: -1 },
    { confirmed: true, expectedScenarioRevision: 1, expectedPlanVersionId: base },
  ])
    expect(
      (await app.inject({ method: 'POST', url: `${path}/apply`, headers, payload })).statusCode,
    ).toBe(400);
  expect(repository.create).not.toHaveBeenCalled();
  expect(repository.apply).not.toHaveBeenCalled();
});
it('returns owned-not-found identically for absent and foreign scenario reads', async () => {
  const { app, repository } = setup();
  repository.read.mockResolvedValue(null);
  repository.readRevision.mockResolvedValue(null);
  for (const url of [path, `${path}/revisions/1`]) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SCENARIO_NOT_FOUND' } });
  }
});
it.each([
  ['SCENARIO_NOT_FOUND', 404],
  ['PLAN_VERSION_NOT_FOUND', 404],
  ['SCENARIO_SLOT_EXISTS', 409],
  ['SCENARIO_REVISION_CONFLICT', 409],
  ['COMPLETION_REVISION_CONFLICT', 409],
] as const)('maps scenario %s without exposing internals', async (code, status) => {
  const { app, repository } = setup();
  repository.apply.mockRejectedValue(new PlanScenarioError(code));
  const response = await app.inject({
    method: 'POST',
    url: `${path}/apply`,
    headers,
    payload: apply,
  });
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ error: { code } });
});
it('maps shared lock, completion and idempotency conflicts at apply', async () => {
  const { app, repository } = setup();
  for (const [error, code] of [
    [new PlanLockedError(), 'PLAN_LOCKED'],
    [new SessionCompletionError('PLAN_COMPLETED_SESSION'), 'PLAN_COMPLETED_SESSION'],
    [new PersistenceConflict('IDEMPOTENCY_CONFLICT'), 'IDEMPOTENCY_CONFLICT'],
  ] as const) {
    repository.apply.mockRejectedValueOnce(error);
    const response = await app.inject({
      method: 'POST',
      url: `${path}/apply`,
      headers,
      payload: apply,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code } });
  }
});
it('sanitizes malformed repository output instead of exposing invalid responses', async () => {
  const { app, repository } = setup();
  repository.read.mockResolvedValue({ ...scenario, revision: 0 });
  const response = await app.inject({ url: path, headers });
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain('basePlanVersionId');
});
