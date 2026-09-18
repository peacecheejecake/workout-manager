import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoachingRunError } from '@workout/server-persistence/coaching-runs';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';
import { createConfiguredApi } from '../src/configured.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const snapshotId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const run = {
  schemaVersion: 1 as const,
  id,
  threadId,
  evidenceSnapshotId: snapshotId,
  conversationRevision: 1,
  policy: { id: 'running-core-v2-training', version: '1' },
  source: { kind: 'deterministic_fixture' as const, fixtureId: 'training-v1' },
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
  status: { kind: 'queued' as const },
};
const headers = {
  'x-workout-session-id': 'current',
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'synthetic-coaching-run',
};
const collection = `/bff/v1/coaching-threads/${threadId}/runs`;
const detail = `/bff/v1/coaching-runs/${id}`;
const outputDetail = `${detail}/output`;
const output = {
  schemaVersion: 1 as const,
  runId: id,
  outputId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  source: { kind: 'deterministic_fixture' as const, fixtureId: 'synthetic-v1' as const },
  trust: 'untrusted_fixture' as const,
  validation: 'unvalidated' as const,
  content: { summary: 'Synthetic training analysis awaiting validation.' },
};
const instances: ReturnType<typeof createApi>[] = [];

function setup(authenticated = true) {
  const repository = {
    create: vi.fn().mockResolvedValue(run),
    list: vi.fn().mockResolvedValue({ items: [run], total: 1 }),
    read: vi.fn().mockResolvedValue(run),
    readOutput: vi.fn().mockResolvedValue(output),
    cancel: vi.fn().mockResolvedValue({
      ...run,
      status: { kind: 'cancelled', reason: 'user_requested' },
    }),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'owner',
              sessionId: 'current',
              csrfToken: 'c'.repeat(43),
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    coachingRuns: repository,
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, repository };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('coaching run API boundary', () => {
  it('derives owner and server-only policy/source, with bounded list and replay-shaped command', async () => {
    const { app, repository } = setup();
    const payload = {
      schemaVersion: 1,
      evidenceSnapshotId: snapshotId,
      expectedConversationRevision: 1,
    };
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: 'POST', url: collection, headers, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(run);
    }
    expect(repository.create).toHaveBeenNthCalledWith(2, 'owner', threadId, {
      ...payload,
      idempotencyKey: headers['idempotency-key'],
    });
    expect((await app.inject({ url: `${collection}?limit=3&offset=2`, headers })).statusCode).toBe(
      200,
    );
    expect(repository.list).toHaveBeenLastCalledWith('owner', threadId, { limit: 3, offset: 2 });
    expect((await app.inject({ url: detail, headers })).json()).toEqual(run);
    expect(repository.read).toHaveBeenCalledWith('owner', id);
    const cancelled = await app.inject({ method: 'POST', url: `${detail}/cancel`, headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toEqual({ kind: 'cancelled', reason: 'user_requested' });
    expect(repository.cancel).toHaveBeenCalledWith('owner', id);
  });

  it('rejects untrusted command fields, malformed IDs, unbounded pages and cancel payload', async () => {
    const { app, repository } = setup();
    const valid = {
      schemaVersion: 1,
      evidenceSnapshotId: snapshotId,
      expectedConversationRevision: 1,
    };
    for (const payload of [
      { ...valid, athleteId: 'foreign' },
      { ...valid, policy: run.policy },
      { ...valid, source: run.source },
      { ...valid, idempotencyKey: 'body-key' },
      { ...valid, expectedConversationRevision: 0 },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: collection, headers, payload })).statusCode,
      ).toBe(400);
    }
    const { 'idempotency-key': _unused, ...missingKeyHeaders } = headers;
    expect(_unused).toBe(headers['idempotency-key']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: collection,
          headers: missingKeyHeaders,
          payload: valid,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: collection,
          headers: { ...headers, 'idempotency-key': ' invalid ' },
          payload: valid,
        })
      ).statusCode,
    ).toBe(400);
    for (const url of [
      `${collection}?owner=foreign`,
      `${collection}?limit=101`,
      `${collection}?offset=-1`,
      `${collection}?limit=1&limit=2`,
      `${detail}?extra=x`,
      '/bff/v1/coaching-runs/not-a-uuid',
      '/bff/v1/coaching-threads/not-a-uuid/runs',
    ])
      expect((await app.inject({ url, headers })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: `${detail}/cancel`, headers, payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.cancel).not.toHaveBeenCalled();
  });

  it('requires authentication, current cookie session and CSRF before writes', async () => {
    const anonymous = setup(false);
    expect((await anonymous.app.inject({ url: detail, headers })).statusCode).toBe(401);
    expect(
      (await anonymous.app.inject({ method: 'POST', url: `${detail}/cancel`, headers })).statusCode,
    ).toBe(401);
    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          url: detail,
          headers: { ...headers, 'x-workout-session-id': 'previous' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${detail}/cancel`,
          headers: { ...headers, 'x-csrf-token': 'bad' },
        })
      ).statusCode,
    ).toBe(403);
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.cancel).not.toHaveBeenCalled();
  });

  it('returns only explicitly untrusted fixture output through the authenticated owner boundary', async () => {
    const { app, repository } = setup();
    const available = await app.inject({ url: outputDetail, headers });
    expect(available.statusCode).toBe(200);
    expect(available.json()).toEqual(output);
    expect(repository.readOutput).toHaveBeenCalledWith('owner', id);

    repository.readOutput.mockResolvedValue(null);
    const unavailable = await app.inject({ url: outputDetail, headers });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toMatchObject({ error: { code: 'OUTPUT_NOT_FOUND' } });
    expect((await app.inject({ url: `${outputDetail}?extra=1`, headers })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: '/bff/v1/coaching-runs/not-a-uuid/output', headers })).statusCode,
    ).toBe(400);
    expect((await setup(false).app.inject({ url: outputDetail, headers })).statusCode).toBe(401);
  });

  it('fails closed on production fixture configuration before provider or database access', async () => {
    const base = {
      DATABASE_URL: 'postgres://runtime:secret@127.0.0.1/workout',
      PUBLIC_ORIGIN: 'https://workout.example',
      OIDC_ISSUER: 'https://oidc.example',
      OIDC_CLIENT_ID: 'client',
      OIDC_CLIENT_SECRET: 'secret',
      COACHING_FIXTURE_ENABLED: 'true',
      COACHING_FIXTURE_ID: 'synthetic-v1',
    };
    await expect(createConfiguredApi({ ...base, NODE_ENV: 'production' })).rejects.toThrow(
      'Coaching fixture is unavailable in production',
    );
    await expect(
      createConfiguredApi({ ...base, NODE_ENV: 'development', COACHING_FIXTURE_ID: 'other' }),
    ).rejects.toThrow('Unsupported coaching fixture configuration');
  });

  it('maps owned missing, stale and receipt conflict without exposing private errors', async () => {
    const { app, repository } = setup();
    repository.read.mockResolvedValue(null);
    repository.list.mockResolvedValue(null);
    repository.cancel.mockResolvedValue(null);
    expect((await app.inject({ url: detail, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: collection, headers })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `${detail}/cancel`, headers })).statusCode,
    ).toBe(404);
    repository.create.mockRejectedValue(new CoachingRunError('STALE_BASIS'));
    const request = {
      method: 'POST' as const,
      url: collection,
      headers,
      payload: {
        schemaVersion: 1,
        evidenceSnapshotId: snapshotId,
        expectedConversationRevision: 1,
      },
    };
    expect((await app.inject(request)).json()).toMatchObject({ error: { code: 'STALE_BASIS' } });
    repository.create.mockRejectedValue(new PersistenceConflict('IDEMPOTENCY_CONFLICT'));
    expect((await app.inject(request)).statusCode).toBe(409);
    repository.create.mockRejectedValue(new Error('private model token'));
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('private model token');
  });
});
