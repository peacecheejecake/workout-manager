import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { PlanLockedError } from '@workout/server-persistence/planning';
import type { PlanDraft, PlanSnapshot } from '@workout/contracts/planning';
import { createApi } from '../src/app.js';
const athleteId = 'athlete-from-auth';
const csrfToken = 'c'.repeat(43);
const headers = {
  cookie: 'session=verified-by-port',
  origin: 'https://workout.example',
  'x-csrf-token': csrfToken,
  'x-workout-session-id': 'session-current',
  'idempotency-key': 'plan-save-0001',
};
const draft: PlanDraft = {
  title: 'Plan',
  timezone: 'UTC',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season',
      title: 'Season',
      startDate: '2026-01-01',
      endDateExclusive: '2026-02-01',
      timezone: 'UTC',
      intent: 'Base',
      isPartial: false,
    },
  ],
  sessions: [],
};
const body = { source: 'manual', confirmed: true, expectedVersionId: null, draft };
const saved = { id: 'version-one', version: 1, createdAt: '2026-01-01T00:00:00Z', draft };
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const planning = {
    readVersion: vi.fn<(_athlete: string, _id: string) => Promise<PlanSnapshot | null>>(
      async () => saved,
    ),
    read: vi.fn(async () => ({
      head: saved,
      history: [{ id: saved.id, version: 1, createdAt: saved.createdAt, title: draft.title }],
    })),
    save: vi.fn(async () => saved),
  };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? { athleteId, sessionId: 'session-current', csrfToken, method: 'cookie' }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    planning,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, planning };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});
describe('planning route authorization and wire boundaries', () => {
  it.each(['/bff/v1/plans/current'])(
    'never reads a protected resource without authentication: %s',
    async (url) => {
      const { app, planning } = setup(false);
      expect((await app.inject({ url, headers })).statusCode).toBe(401);
      expect(planning.read).not.toHaveBeenCalled();
    },
  );
  it('rejects the previous browser session even when the current cookie is valid', async () => {
    const { app, planning } = setup();
    const response = await app.inject({
      url: '/bff/v1/plans/current',
      headers: { ...headers, 'x-workout-session-id': 'old-session' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_CHANGED' } });
    expect(planning.read).not.toHaveBeenCalled();
  });
  it('derives ownership from authentication and takes idempotency only from its header', async () => {
    const { app, planning } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/plans/current',
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(planning.save).toHaveBeenCalledWith(athleteId, {
      ...body,
      idempotencyKey: 'plan-save-0001',
    });
    expect(response.json()).toEqual(saved);
  });
  it.each([
    { ...body, athleteId: 'foreign' },
    { ...body, confirmed: false },
    { ...body, source: 'proposal' },
    { ...body, idempotencyKey: 'body-key-0001' },
  ])('rejects invalid/manual-approval-bypass fields before mutation', async (payload) => {
    const { app, planning } = setup();
    expect(
      (await app.inject({ method: 'PUT', url: '/bff/v1/plans/current', headers, payload }))
        .statusCode,
    ).toBe(400);
    expect(planning.save).not.toHaveBeenCalled();
  });
  it('requires current session proof and valid cookie CSRF on writes', async () => {
    const { app, planning } = setup();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/bff/v1/plans/current',
          headers: { ...headers, origin: 'https://evil.example' },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/bff/v1/plans/current',
          headers: { ...headers, 'x-csrf-token': '' },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(planning.save).not.toHaveBeenCalled();
  });
  it.each([
    new PersistenceConflict('REVISION_CONFLICT'),
    new PersistenceConflict('IDEMPOTENCY_CONFLICT'),
    new PlanLockedError(),
  ])('reports actionable conflicts without falsely returning save success', async (error) => {
    const { app, planning } = setup();
    planning.save.mockRejectedValue(error);
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/plans/current',
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: error.code } });
  });
});

describe('immutable plan version route', () => {
  const id = 'ABCDEFAB-1234-4234-8234-123456789012';
  it('normalizes a UUID and derives ownership without writes', async () => {
    const { app, planning } = setup();
    planning.readVersion.mockResolvedValue({ ...saved, id: id.toLowerCase() });
    const response = await app.inject({ url: `/bff/v1/plans/versions/${id}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...saved, id: id.toLowerCase() });
    expect(planning.readVersion).toHaveBeenCalledWith(athleteId, id.toLowerCase());
    expect(planning.save).not.toHaveBeenCalled();
  });
  it.each(['not-a-uuid', `${id}?athleteId=foreign`, `${id}?limit=1`])(
    'rejects invalid path/query %s',
    async (suffix) => {
      const { app, planning } = setup();
      expect(
        (await app.inject({ url: `/bff/v1/plans/versions/${suffix}`, headers })).statusCode,
      ).toBe(400);
      expect(planning.readVersion).not.toHaveBeenCalled();
    },
  );
  it('uses the same not-found response for inaccessible and missing versions', async () => {
    const { app, planning } = setup();
    planning.readVersion.mockResolvedValue(null);
    for (const missing of [id, '22345678-1234-4234-8234-123456789012']) {
      const response = await app.inject({ url: `/bff/v1/plans/versions/${missing}`, headers });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'PLAN_VERSION_NOT_FOUND' } });
    }
  });
  it('requires authentication and the bound current browser session', async () => {
    const unauthenticated = setup(false);
    expect(
      (await unauthenticated.app.inject({ url: `/bff/v1/plans/versions/${id}`, headers }))
        .statusCode,
    ).toBe(401);
    expect(unauthenticated.planning.readVersion).not.toHaveBeenCalled();
    const current = setup();
    expect(
      (
        await current.app.inject({
          url: `/bff/v1/plans/versions/${id}`,
          headers: { ...headers, 'x-workout-session-id': 'old' },
        })
      ).statusCode,
    ).toBe(409);
    expect(current.planning.readVersion).not.toHaveBeenCalled();
  });
});

it('rejects unsupported period priorities before persistence', async () => {
  const { app, planning } = setup();
  const response = await app.inject({
    method: 'PUT',
    url: '/bff/v1/plans/current',
    headers,
    payload: {
      ...body,
      draft: {
        ...draft,
        periods: draft.periods.map((period) => ({ ...period, priority: 'urgent' })),
      },
    },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  expect(planning.save).not.toHaveBeenCalled();
});

describe('period constraint structural API boundaries', () => {
  const empty = { unavailableDates: [], dailyTimeLimits: [] };
  it.each([
    null,
    'invalid',
    {},
    { ...empty, unavailableDates: ['2026-01-02', '2026-01-02'] },
    { ...empty, unavailableDates: ['2026-02-01'] },
    { ...empty, unavailableDates: ['2025-12-31'] },
    { ...empty, dailyTimeLimits: [{ date: '2026-01-02', availableSeconds: -1 }] },
    { ...empty, dailyTimeLimits: [{ date: '2026-01-02', availableSeconds: 0.5 }] },
    { ...empty, dailyTimeLimits: [{ date: '2026-01-02', availableSeconds: 86401 }] },
    { ...empty, dailyTimeLimits: [{ date: '2026-01-02', availableSeconds: '60' }] },
    { ...empty, dailyTimeLimits: [{ date: '2026-02-01', availableSeconds: 0 }] },
    {
      ...empty,
      dailyTimeLimits: [
        { date: '2026-01-02', availableSeconds: 0 },
        { date: '2026-01-02', availableSeconds: 60 },
      ],
    },
    { ...empty, unavailableDates: Array.from({ length: 3661 }, () => '2026-01-02') },
    { ...empty, unexpected: true },
  ])('rejects invalid constraints %# before saving', async (constraints) => {
    const { app, planning } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/plans/current',
      headers,
      payload: {
        ...body,
        draft: { ...draft, periods: draft.periods.map((period) => ({ ...period, constraints })) },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(planning.save).not.toHaveBeenCalled();
  });
});
