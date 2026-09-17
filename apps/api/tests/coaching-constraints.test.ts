import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoachingConstraintError } from '@workout/server-persistence/coaching-constraints';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = '/bff/v1/coaching-constraints';
const text = '주말에는 합성 일정 제약이 있습니다.';
const entry = {
  id,
  revision: 1,
  text,
  confirmedAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
};
const receipt = { id, revision: 1, headRevision: 1, deleted: false };
const create = { expectedHeadRevision: null, confirmed: true, text };
const update = { expectedHeadRevision: 1, expectedRevision: 1, confirmed: true, text };
const remove = { expectedHeadRevision: 1, expectedRevision: 1, confirmed: true };
const writes = [
  { method: 'POST', url: base, payload: create, repositoryMethod: 'create' },
  { method: 'PUT', url: `${base}/${id}`, payload: update, repositoryMethod: 'update' },
  { method: 'DELETE', url: `${base}/${id}`, payload: remove, repositoryMethod: 'remove' },
] as const;
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'synthetic-constraint-command',
};
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const repository = {
    list: vi.fn().mockResolvedValue({ headRevision: 1, items: [entry] }),
    create: vi.fn().mockResolvedValue(receipt),
    update: vi.fn().mockResolvedValue({ ...receipt, revision: 2, headRevision: 2 }),
    remove: vi.fn().mockResolvedValue({ ...receipt, revision: 2, headRevision: 2, deleted: true }),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'owner',
              sessionId: 'current',
              csrfToken: headers['x-csrf-token'],
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    coachingConstraints: repository,
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

describe('coaching constraints API', () => {
  it('distinguishes an absent head from an explicitly cleared collection', async () => {
    const { app, repository } = setup();
    repository.list.mockResolvedValueOnce({ headRevision: null, items: [] });
    expect((await app.inject({ url: base, headers })).json()).toEqual({
      headRevision: null,
      items: [],
    });
    repository.list.mockResolvedValueOnce({ headRevision: 2, items: [] });
    expect((await app.inject({ url: base, headers })).json()).toEqual({
      headRevision: 2,
      items: [],
    });
    const populated = await app.inject({ url: base, headers });
    expect(populated.statusCode).toBe(200);
    expect(populated.json()).toEqual({ headRevision: 1, items: [entry] });
    expect(repository.list).toHaveBeenCalledWith('owner');
  });
  it('derives ownership, normalizes UUID paths and forwards confirmed commands with header-only stable keys', async () => {
    const { app, repository } = setup();
    for (let index = 0; index < 2; index++) {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { ...create, text: `  ${text}\n` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(receipt);
    }
    expect(repository.create).toHaveBeenNthCalledWith(2, 'owner', {
      ...create,
      idempotencyKey: headers['idempotency-key'],
    });
    const upper = `${base}/${id.toUpperCase()}`;
    expect(
      (await app.inject({ method: 'PUT', url: upper, headers, payload: update })).json(),
    ).toEqual({ ...receipt, revision: 2, headRevision: 2 });
    expect(repository.update).toHaveBeenCalledWith('owner', id, {
      ...update,
      idempotencyKey: headers['idempotency-key'],
    });
    expect(
      (await app.inject({ method: 'DELETE', url: upper, headers, payload: remove })).json(),
    ).toEqual({ ...receipt, revision: 2, headRevision: 2, deleted: true });
    expect(repository.remove).toHaveBeenCalledWith('owner', id, {
      ...remove,
      idempotencyKey: headers['idempotency-key'],
    });
  });
  it('blocks anonymous reads and writes, old sessions and invalid cookie CSRF before repository access', async () => {
    const anonymous = setup(false);
    expect((await anonymous.app.inject({ url: base, headers })).statusCode).toBe(401);
    for (const request of writes)
      expect(
        (
          await anonymous.app.inject({
            method: request.method,
            url: request.url,
            headers,
            payload: request.payload,
          })
        ).statusCode,
      ).toBe(401);
    for (const method of Object.values(anonymous.repository)) expect(method).not.toHaveBeenCalled();
    const { app, repository } = setup();
    expect(
      (await app.inject({ url: base, headers: { ...headers, 'x-workout-session-id': 'old' } }))
        .statusCode,
    ).toBe(409);
    for (const request of writes) {
      expect(
        (
          await app.inject({
            method: request.method,
            url: request.url,
            headers: { ...headers, 'x-csrf-token': 'bad' },
            payload: request.payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: request.method,
            url: request.url,
            headers: { ...headers, 'x-workout-session-id': 'old' },
            payload: request.payload,
          })
        ).statusCode,
      ).toBe(409);
    }
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });
  it('rejects unknown list/write queries and invalid mutation IDs', async () => {
    const { app, repository } = setup();
    for (const query of ['?athleteId=foreign', '?limit=50'])
      expect((await app.inject({ url: base + query, headers })).statusCode).toBe(400);
    for (const request of writes) {
      expect(
        (
          await app.inject({
            method: request.method,
            url: `${request.url}?owner=foreign`,
            headers,
            payload: request.payload,
          })
        ).statusCode,
      ).toBe(400);
      if (request.method !== 'POST')
        expect(
          (
            await app.inject({
              method: request.method,
              url: `${base}/invalid`,
              headers,
              payload: request.payload,
            })
          ).statusCode,
        ).toBe(400);
    }
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });
  it.each([
    { confirmed: false },
    { confirmed: undefined },
    { athleteId: 'foreign' },
    { idempotencyKey: 'body-key' },
    { expectedHeadRevision: 0 },
    { expectedHeadRevision: -1 },
    { expectedHeadRevision: 1.5 },
  ])('rejects invalid confirmation, ownership and shared revision fields %j', async (patch) => {
    const { app, repository } = setup();
    for (const request of writes)
      expect(
        (
          await app.inject({
            method: request.method,
            url: request.url,
            headers,
            payload: { ...request.payload, ...patch },
          })
        ).statusCode,
      ).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
  });
  it.each(['', ' \n ', 'x\0y', 'x'.repeat(2001)])(
    'rejects empty or unbounded text',
    async (invalidText) => {
      const { app, repository } = setup();
      for (const request of writes.slice(0, 2))
        expect(
          (
            await app.inject({
              method: request.method,
              url: request.url,
              headers,
              payload: { ...request.payload, text: invalidText },
            })
          ).statusCode,
        ).toBe(400);
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );
  it('requires both positive revisions on update/remove and forbids text in deletion commands', async () => {
    const { app, repository } = setup();
    for (const request of writes.slice(1)) {
      for (const patch of [
        { expectedHeadRevision: null },
        { expectedRevision: null },
        { expectedRevision: 0 },
        { expectedRevision: undefined },
      ])
        expect(
          (
            await app.inject({
              method: request.method,
              url: request.url,
              headers,
              payload: { ...request.payload, ...patch },
            })
          ).statusCode,
        ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/${id}`,
          headers,
          payload: { ...remove, text },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
  });
  it('requires a valid idempotency header and enforces 16 KiB for every write', async () => {
    const { app, repository } = setup();
    const { 'idempotency-key': ignored, ...withoutKey } = headers;
    expect(ignored).toBe('synthetic-constraint-command');
    for (const request of writes) {
      for (const requestHeaders of [withoutKey, { ...headers, 'idempotency-key': ' invalid ' }])
        expect(
          (
            await app.inject({
              method: request.method,
              url: request.url,
              headers: requestHeaders,
              payload: request.payload,
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: request.method,
            url: request.url,
            headers,
            payload: { ...request.payload, extra: 'x'.repeat(16384) },
          })
        ).statusCode,
      ).toBe(413);
      expect(repository[request.repositoryMethod]).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['COACHING_CONSTRAINT_NOT_FOUND', 404],
    ['COACHING_CONSTRAINT_REVISION_CONFLICT', 409],
    ['COACHING_CONSTRAINT_LIMIT', 413],
  ] as const)('maps domain error %s on every write', async (code, status) => {
    const { app, repository } = setup();
    for (const request of writes) {
      repository[request.repositoryMethod].mockRejectedValue(new CoachingConstraintError(code));
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers,
        payload: request.payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
    }
  });
  it('maps shared persistence conflicts and sanitizes unexpected failures', async () => {
    const { app, repository } = setup();
    for (const code of ['IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT'] as const) {
      repository.create.mockRejectedValueOnce(new PersistenceConflict(code));
      const response = await app.inject({ method: 'POST', url: base, headers, payload: create });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code } });
    }
    repository.list.mockRejectedValue(new Error('private-constraint-text'));
    const response = await app.inject({ url: base, headers });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private-constraint-text');
  });
  it('rejects malformed repository output instead of exposing private fields or a false success', async () => {
    const { app, repository } = setup();
    repository.list.mockResolvedValueOnce({ headRevision: null, items: [entry] });
    expect((await app.inject({ url: base, headers })).statusCode).toBe(500);
    repository.list.mockResolvedValueOnce({
      headRevision: 1,
      items: [{ ...entry, privateText: 'not-for-response' }],
    });
    const read = await app.inject({ url: base, headers });
    expect(read.statusCode).toBe(500);
    expect(read.body).not.toContain('not-for-response');
    for (const request of writes) {
      repository[request.repositoryMethod].mockResolvedValue({
        ...receipt,
        text: 'not-for-receipt',
      });
      const write = await app.inject({
        method: request.method,
        url: request.url,
        headers,
        payload: request.payload,
      });
      expect(write.statusCode).toBe(500);
      expect(write.body).not.toContain('not-for-receipt');
    }
  });
});
