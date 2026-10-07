import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RaceRepositoryError } from '@workout/server-persistence/races';
import { RaceResultProofError } from '@workout/server-persistence/race-result-proofs';
import {
  RaceResultV2Error,
  type RaceResultV2Repository,
} from '@workout/server-persistence/race-result-v2';
import { AppConsentRequiredError } from '@workout/server-persistence/app-admission';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { registerRaceResultV2Routes } from '../src/race-result-v2-routes.js';
import { ProductRequestError } from '../src/product-boundary.js';
import { createApi } from '../src/app.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const athlete = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const values = {
  kind: 'race-result' as const,
  raceEventId: null,
  localDate: '2026-10-07',
  timezone: 'UTC',
  source: { kind: 'manual' as const },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: null,
  linkedActivityId: null,
  weatherNote: 'Synthetic private note',
  proofs: { link: null, attachments: [] },
};
const headers = {
  authorization: 'Bearer synthetic',
  'x-fixture-csrf': 'synthetic',
  'idempotency-key': 'race_fixture_0001',
};
const apps: ReturnType<typeof Fastify>[] = [];
function mockRepository(): RaceResultV2Repository {
  return {
    create: vi.fn<RaceResultV2Repository['create']>().mockResolvedValue({ id, revision: 1 }),
    update: vi.fn<RaceResultV2Repository['update']>().mockResolvedValue({ id, revision: 2 }),
    read: vi
      .fn<RaceResultV2Repository['read']>()
      .mockResolvedValue({ ...values, schemaVersion: 2, id, revision: 1 }),
    list: vi.fn<RaceResultV2Repository['list']>().mockResolvedValue({
      schemaVersion: 2,
      kind: 'race-result',
      sort: 'id-asc',
      collection: null,
      items: [],
      nextCursor: null,
    }),
  };
}
function setup(enabled = true) {
  const repo = mockRepository();
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProductRequestError)
      return reply.code(error.statusCode).send({ code: error.code });
    if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply.code(413).send({ code: 'BODY_TOO_LARGE' });
    return reply.code(500).send({ code: 'INTERNAL_ERROR' });
  });
  // Synthetic boundary hooks only. These are NOT createApi's production auth/CSRF
  // plugins, OIDC, a real repository, or evidence of configured route activation.
  app.register(
    async (routes) => {
      routes.addHook('onRequest', async (request) => {
        if (request.headers.authorization !== headers.authorization)
          throw new ProductRequestError(401, 'UNAUTHORIZED');
        if (request.method !== 'GET' && request.headers['x-fixture-csrf'] !== 'synthetic')
          throw new ProductRequestError(403, 'CSRF_REJECTED');
      });
      if (enabled)
        registerRaceResultV2Routes(routes, repo, () => ({
          athleteId: athlete,
          sessionId: 'fixture',
          method: 'bearer',
        }));
    },
    { prefix: '/bff/v1' },
  );
  return { app, repo };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe('explicit race-result V2 route boundary; synthetic auth/repository, no PG', () => {
  it('creates and updates strict intents using only authenticated tenant and equal idempotency key', async () => {
    const { app, repo } = setup();
    const payload = { schemaVersion: 2, values, idempotencyKey: headers['idempotency-key'] };
    expect(
      (await app.inject({ method: 'POST', url: '/bff/v1/race-results/v2', headers, payload }))
        .statusCode,
    ).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(athlete, payload);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/bff/v1/race-results/v2/${id}`,
          headers,
          payload: { ...payload, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(repo.update).toHaveBeenCalledWith(athlete, id, { ...payload, expectedRevision: 1 });
  });
  it.each([
    { schemaVersion: 1, values },
    { schemaVersion: 2, values, athleteId: athlete },
    { schemaVersion: 2, values, idempotencyKey: 'different_key' },
    {
      schemaVersion: 2,
      values: {
        ...values,
        source: {
          kind: 'official',
          authority: 'fixture',
          resultUrl: 'https://example.org/synthetic-result',
          verifiedAt: '2026-10-07T00:00:00Z',
        },
      },
    },
    {
      schemaVersion: 2,
      values: {
        ...values,
        proofs: {
          link: null,
          attachments: [{ kind: 'gallery-image', mediaItemId: id, status: 'unavailable' }],
        },
      },
    },
  ])('rejects forged/legacy/mismatched input before repository', async (payload) => {
    const { app, repo } = setup();
    expect(
      (await app.inject({ method: 'POST', url: '/bff/v1/race-results/v2', headers, payload }))
        .statusCode,
    ).toBe(400);
    expect(repo.create).not.toHaveBeenCalled();
  });
  it('requires a finite header key and rejects body overflow before repository', async () => {
    const { app, repo } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/race-results/v2',
          headers: { authorization: headers.authorization, 'x-fixture-csrf': 'synthetic' },
          payload: { schemaVersion: 2, values },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/race-results/v2',
          headers,
          payload: { schemaVersion: 2, values: { ...values, weatherNote: 'x'.repeat(17000) } },
        })
      ).statusCode,
    ).toBe(413);
    expect(repo.create).not.toHaveBeenCalled();
  });
  it('negotiates V2 read/list and preserves legacy timestamp/null/zero facts', async () => {
    const { app, repo } = setup();
    const { proofs: _proofs, ...legacyValues } = values;
    const legacy = {
      ...legacyValues,
      id,
      revision: 1,
      source: {
        kind: 'official' as const,
        authority: 'fixture',
        resultUrl: 'https://example.org/synthetic-result',
        verifiedAt: '2026-10-07T00:00:00Z',
      },
    };
    vi.mocked(repo.read).mockResolvedValue(legacy);
    const response = await app.inject({
      url: `/bff/v1/race-results/v2/${id}?schemaVersion=2`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(legacy);
    expect(response.headers['cache-control']).toBe('private, no-store');
    vi.mocked(repo.list).mockResolvedValue({
      schemaVersion: 2,
      kind: 'race-result',
      sort: 'id-asc',
      collection: { revision: 1, privacyGeneration: '0' },
      items: [legacy],
      nextCursor: null,
    });
    const list = await app.inject({
      url: '/bff/v1/race-results/v2?schemaVersion=2&limit=1',
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([legacy]);
    expect(repo.list).toHaveBeenCalledWith(athlete, { schemaVersion: 2, limit: 1, cursor: null });
  });
  it.each([
    '',
    '?schemaVersion=1',
    '?schemaVersion=2&limit=101',
    '?schemaVersion=2&cursor=bad',
    '?schemaVersion=2&schemaVersion=2',
    '?schemaVersion=2&athleteId=other',
  ])('rejects invalid query negotiation %s', async (query) => {
    const { app, repo } = setup();
    expect((await app.inject({ url: `/bff/v1/race-results/v2${query}`, headers })).statusCode).toBe(
      400,
    );
    expect(repo.list).not.toHaveBeenCalled();
  });
  it('rejects invalid/mismatched output and missing records without exposing bodies', async () => {
    const { app, repo } = setup();
    vi.mocked(repo.read).mockResolvedValue(null);
    expect(
      (await app.inject({ url: `/bff/v1/race-results/v2/${id}?schemaVersion=2`, headers }))
        .statusCode,
    ).toBe(404);
    vi.mocked(repo.read).mockResolvedValue({
      ...values,
      schemaVersion: 2,
      id: athlete,
      revision: 1,
    });
    const response = await app.inject({
      url: `/bff/v1/race-results/v2/${id}?schemaVersion=2`,
      headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(values.weatherNote);
    vi.mocked(repo.update).mockResolvedValue({ id: athlete, revision: 2 });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/bff/v1/race-results/v2/${id}`,
          headers,
          payload: { schemaVersion: 2, expectedRevision: 1, values },
        })
      ).statusCode,
    ).toBe(500);
  });
  it.each([
    [new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE'), 404, 'RACE_REFERENCE_UNAVAILABLE'],
    [new RaceResultProofError('PROOF_UNAVAILABLE'), 404, 'PROOF_UNAVAILABLE'],
    [new RaceResultProofError('STALE_PROOF_ACCESS'), 409, 'STALE_PROOF_ACCESS'],
    [new AppConsentRequiredError(), 409, 'APP_CONSENT_REQUIRED'],
    [new PersistenceConflict('REVISION_CONFLICT'), 409, 'REVISION_CONFLICT'],
    [new RaceResultV2Error('RACE_RESULT_READ_LIMIT'), 413, 'RACE_RESULT_READ_LIMIT'],
    [new RaceResultProofError('INVALID_PROOF_SOURCE'), 500, 'INTERNAL_ERROR'],
    [new Error('private database detail'), 500, 'INTERNAL_ERROR'],
  ])('maps finite errors and sanitizes unknown failure', async (error, status, code) => {
    const { app, repo } = setup();
    vi.mocked(repo.create).mockRejectedValue(error);
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/race-results/v2',
      headers,
      payload: { schemaVersion: 2, values },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code });
  });
  it('projects contentless unavailable proof without treating it as verified, and rejects malformed pages', async () => {
    const { app, repo } = setup();
    const saved = {
      ...values,
      schemaVersion: 2 as const,
      id,
      revision: 1,
      proofs: {
        link: null,
        attachments: [
          { kind: 'gallery-image' as const, mediaItemId: athlete, status: 'unavailable' as const },
        ],
      },
    };
    vi.mocked(repo.read).mockResolvedValue(saved);
    const response = await app.inject({
      url: `/bff/v1/race-results/v2/${id}?schemaVersion=2`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(saved);
    expect(response.body).not.toContain('verifiedAt');
    expect(response.body).not.toContain('sha256');
    vi.mocked(repo.list).mockResolvedValue({
      schemaVersion: 2,
      kind: 'race-result',
      sort: 'id-asc',
      collection: null,
      items: [saved],
      nextCursor: null,
    });
    expect(
      (await app.inject({ url: '/bff/v1/race-results/v2?schemaVersion=2', headers })).statusCode,
    ).toBe(500);
  });
  it('rejects malformed path and unexpected single-read query before repository', async () => {
    const { app, repo } = setup();
    expect(
      (await app.inject({ url: '/bff/v1/race-results/v2/not-uuid?schemaVersion=2', headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `/bff/v1/race-results/v2/${id}?schemaVersion=2&limit=1`, headers }))
        .statusCode,
    ).toBe(400);
    expect(repo.read).not.toHaveBeenCalled();
  });
  it('synthetic auth/CSRF boundary and disabled registration do not invoke repository', async () => {
    const { app, repo } = setup();
    expect((await app.inject({ url: '/bff/v1/race-results/v2?schemaVersion=2' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/race-results/v2',
          headers: { authorization: headers.authorization },
          payload: { schemaVersion: 2, values },
        })
      ).statusCode,
    ).toBe(403);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.list).not.toHaveBeenCalled();
    const disabled = setup(false);
    expect(
      (await disabled.app.inject({ url: '/bff/v1/race-results/v2?schemaVersion=2', headers }))
        .statusCode,
    ).toBe(404);
    expect(disabled.repo.list).not.toHaveBeenCalled();
  });
});

// Uses the actual createApi product hooks with synthetic authentication and
// repository ports. This is neither OIDC/PG nor configured deployment evidence.
describe('V2 injection inside the actual authenticated product boundary', () => {
  const csrfToken = 'c'.repeat(43);
  const origin = 'https://workout.example';
  const cookieHeaders = {
    cookie: 'session=fixture',
    origin,
    'x-workout-session-id': 'current',
    'x-csrf-token': csrfToken,
    'idempotency-key': 'race_fixture_0001',
  };
  function boundary(enabled = true) {
    const repo = mockRepository();
    const app = createApi({
      auth: {
        authenticate: async (credentials) =>
          credentials.cookie === 'session=fixture'
            ? { athleteId: athlete, sessionId: 'current', csrfToken, method: 'cookie' }
            : credentials.authorization === 'Bearer fixture'
              ? { athleteId: athlete, sessionId: 'current', method: 'bearer' }
              : null,
      },
      consent: { getConsent: vi.fn(), setConsent: vi.fn() },
      ...(enabled ? { raceResultsV2: repo } : {}),
      allowedOrigins: [origin],
    });
    apps.push(app);
    return { app, repo };
  }
  it('keeps V2 absent without an injected repository', async () => {
    const { app, repo } = boundary(false);
    const response = await app.inject({
      method: 'GET',
      url: '/bff/v1/race-results/v2?schemaVersion=2',
      headers: cookieHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(repo.list).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'unauthenticated', headers: {}, status: 401 },
    {
      name: 'old session',
      headers: { ...cookieHeaders, 'x-workout-session-id': 'old' },
      status: 409,
    },
    { name: 'missing CSRF', headers: { ...cookieHeaders, 'x-csrf-token': '' }, status: 403 },
    {
      name: 'foreign Origin',
      headers: { ...cookieHeaders, origin: 'https://foreign.example' },
      status: 403,
    },
  ])('rejects $name before reaching the V2 repository', async ({ headers, status }) => {
    const { app, repo } = boundary();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/race-results/v2',
      headers,
      payload: { schemaVersion: 2, values },
    });
    expect(response.statusCode).toBe(status);
    expect(repo.create).not.toHaveBeenCalled();
  });
  it('uses the authenticated tenant and carries V2 inside the real cookie boundary', async () => {
    const { app, repo } = boundary();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/race-results/v2',
      headers: cookieHeaders,
      payload: { schemaVersion: 2, values },
    });
    expect(response.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(athlete, {
      schemaVersion: 2,
      values,
      idempotencyKey: cookieHeaders['idempotency-key'],
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it('keeps bearer and strict explicit read query behavior', async () => {
    const { app, repo } = boundary();
    const headers = { authorization: 'Bearer fixture' };
    expect(
      (await app.inject({ method: 'GET', url: '/bff/v1/race-results/v2', headers })).statusCode,
    ).toBe(400);
    expect(repo.list).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'GET',
      url: '/bff/v1/race-results/v2?schemaVersion=2',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(repo.list).toHaveBeenCalledWith(athlete, { schemaVersion: 2, limit: 50, cursor: null });
  });
});
