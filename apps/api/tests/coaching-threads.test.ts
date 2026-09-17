import { Writable } from 'node:stream';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CoachingThreadError } from '@workout/server-persistence/coaching-threads';
import { createApi } from '../src/app.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const thread = {
  id,
  planVersionId: id,
  title: '검토',
  scope: { kind: 'session' as const, targetId: '세션' },
  revision: 1,
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
};
const message = {
  id,
  threadId: id,
  revision: 1,
  role: 'user' as const,
  content: ' 질문 ',
  createdAt: thread.createdAt,
};
const body = { planVersionId: id, title: '검토', scope: thread.scope, message: message.content };
const headers = {
  'x-workout-session-id': 'current',
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'request',
};
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const repository = {
    list: vi.fn().mockResolvedValue({ items: [thread], total: 1 }),
    read: vi.fn().mockResolvedValue(thread),
    messages: vi.fn().mockResolvedValue({ thread, messages: [message], hasMore: false }),
    create: vi.fn().mockResolvedValue({ thread, message }),
    append: vi.fn().mockResolvedValue({ thread, message }),
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
    coachingThreads: repository,
    logStream: new Writable({
      write(_c, _e, callback) {
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
describe('coaching threads API boundary', () => {
  it('derives ownership and delegates bounded pages and stable write commands', async () => {
    const { app, repository } = setup();
    expect(
      (await app.inject({ url: '/bff/v1/coaching-threads?limit=2&offset=1', headers })).statusCode,
    ).toBe(200);
    expect(repository.list).toHaveBeenCalledWith('owner', { limit: 2, offset: 1 });
    expect(
      (
        await app.inject({
          url: `/bff/v1/coaching-threads/${id}/messages?afterRevision=0`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(repository.messages).toHaveBeenCalledWith('owner', id, { limit: 50, afterRevision: 0 });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/bff/v1/coaching-threads',
            headers,
            payload: body,
          })
        ).statusCode,
      ).toBe(200);
    expect(repository.create).toHaveBeenNthCalledWith(2, 'owner', {
      ...body,
      idempotencyKey: 'request',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/bff/v1/coaching-threads/${id}/messages`,
          headers,
          payload: { expectedRevision: 1, message: 'next' },
        })
      ).statusCode,
    ).toBe(200);
    expect(repository.append).toHaveBeenCalledWith('owner', id, {
      expectedRevision: 1,
      message: 'next',
      idempotencyKey: 'request',
    });
  });
  it('requires auth, current session and cookie CSRF', async () => {
    expect(
      (await setup(false).app.inject({ url: '/bff/v1/coaching-threads', headers })).statusCode,
    ).toBe(401);
    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          url: '/bff/v1/coaching-threads',
          headers: { ...headers, 'x-workout-session-id': 'old' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/coaching-threads',
          headers: { ...headers, 'x-csrf-token': 'bad' },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(repository.create).not.toHaveBeenCalled();
  });
  it.each([
    '?athleteId=foreign',
    '?limit=101',
    '/bad',
    '/' + id + '?extra=x',
    '/' + id + '/messages?afterRevision=-1',
  ])('rejects invalid path/query %s', async (suffix) => {
    expect(
      (await setup().app.inject({ url: '/bff/v1/coaching-threads' + suffix, headers })).statusCode,
    ).toBe(400);
  });
  it.each([
    { role: 'assistant' },
    { athleteId: 'other' },
    { idempotencyKey: 'body-key' },
    { message: '\0' },
    { message: ' ' },
  ])('rejects untrusted body fields %j', async (patch) => {
    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/coaching-threads',
          headers,
          payload: { ...body, ...patch },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });
  it.each([
    'THREAD_NOT_FOUND',
    'PLAN_VERSION_NOT_FOUND',
    'SCOPE_NOT_FOUND',
    'CONVERSATION_REVISION_CONFLICT',
    'CONVERSATION_LIMIT',
  ] as const)('maps domain error %s', async (code) => {
    const { app, repository } = setup();
    repository.create.mockRejectedValue(new CoachingThreadError(code));
    const result = await app.inject({
      method: 'POST',
      url: '/bff/v1/coaching-threads',
      headers,
      payload: body,
    });
    expect(result.statusCode).toBe(code.endsWith('NOT_FOUND') ? 404 : 409);
    expect(result.json().error.code).toBe(code);
  });
  it('requires a header key, enforces body bounds, and rejects invalid repository responses', async () => {
    const { app, repository } = setup();
    const { 'idempotency-key': _key, ...withoutKey } = headers;
    expect(_key).toBe('request');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/coaching-threads',
          headers: withoutKey,
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/coaching-threads',
          headers,
          payload: { ...body, message: 'x'.repeat(65537) },
        })
      ).statusCode,
    ).toBe(413);
    expect(repository.create).not.toHaveBeenCalled();
    repository.messages.mockResolvedValue({
      thread,
      messages: [{ ...message, role: 'assistant' }],
      hasMore: false,
    });
    expect(
      (await app.inject({ url: `/bff/v1/coaching-threads/${id}/messages`, headers })).statusCode,
    ).toBe(500);
  });
  it('returns404 for missing owned thread and sanitizes internal failures', async () => {
    const { app, repository } = setup();
    repository.read.mockResolvedValue(null);
    expect((await app.inject({ url: `/bff/v1/coaching-threads/${id}`, headers })).statusCode).toBe(
      404,
    );
    repository.list.mockRejectedValue(new Error('private-content-token'));
    const result = await app.inject({ url: '/bff/v1/coaching-threads', headers });
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('private-content-token');
  });
});
