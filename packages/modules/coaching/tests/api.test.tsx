import { describe, it, expect, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { createCoachingApi, CoachingRequestError } from '../src/api';
import { createCoachingRunApi } from '../src/run-api';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const thread = {
  id,
  planVersionId: id,
  title: 'title',
  scope: { kind: 'session' as const, targetId: 'run' },
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const message = {
  id,
  threadId: id,
  revision: 1,
  role: 'user',
  content: ' text ',
  createdAt: thread.createdAt,
};
function fixture(body: unknown = { thread, message }, status = 200) {
  const request = vi
    .fn<AuthenticatedTransport['request']>()
    .mockResolvedValue(transportReplySchema.parse({ status, body, traceId: null }));
  return { request, api: createCoachingApi({ request }), apiTransport: { request } };
}
describe('coaching API adapter', () => {
  it('separates stable idempotency header and preserves text/abort with no plan writes', async () => {
    const { api, request } = fixture();
    const signal = new AbortController().signal;
    const input = {
      planVersionId: id,
      title: thread.title,
      scope: thread.scope,
      message: message.content,
      idempotencyKey: 'same',
    };
    await api.create(input, signal);
    await api.create(input, signal);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toEqual({
      path: '/bff/v1/coaching-threads',
      method: 'POST',
      body: {
        planVersionId: id,
        title: thread.title,
        scope: thread.scope,
        message: message.content,
      },
      idempotencyKey: 'same',
      signal,
    });
  });
  it('passes bounded query/signal and normalizes path UUID', async () => {
    const { api, request } = fixture({ thread, messages: [message], hasMore: false });
    const signal = new AbortController().signal;
    await api.messages(id.toUpperCase(), {}, signal);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      path: `/bff/v1/coaching-threads/${id}/messages?afterRevision=0&limit=50`,
      signal,
      method: 'GET',
    });
    await expect(api.messages(id, { limit: 101 })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign response IDs and mismatched command receipts as unknown outcomes', async () => {
    const { api } = fixture({ ...thread, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    await expect(api.thread(id)).rejects.toThrow('RESPONSE_MISMATCH');
    const append = fixture();
    await expect(
      append.api.append(id, { expectedRevision: 1, message: ' text ', idempotencyKey: 'key' }),
    ).rejects.toThrow('RESPONSE_MISMATCH');
  });
  it('keeps transport and invalid successful payload failures uncertain without retry', async () => {
    const f = fixture({});
    await expect(f.api.thread(id)).rejects.not.toBeInstanceOf(CoachingRequestError);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.request.mockRejectedValue(new Error('offline'));
    await expect(f.api.thread(id)).rejects.not.toBeInstanceOf(CoachingRequestError);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('fetches plans and lists through read-only bounded requests', async () => {
    const f = fixture({ head: null, history: [] });
    const signal = new AbortController().signal;
    await f.api.plans(signal);
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      path: '/bff/v1/plans/current',
      method: 'GET',
      signal,
    });
    f.request.mockResolvedValue({ status: 200, body: { items: [], total: 0 }, traceId: null });
    await f.api.list({}, signal);
    expect(f.request.mock.calls[1]?.[0]).toMatchObject({
      path: '/bff/v1/coaching-threads?limit=50&offset=0',
      method: 'GET',
      signal,
    });
    await expect(f.api.plan('../foreign')).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('sanitizes HTTP codes while preserving known conflict status', async () => {
    await expect(
      fixture({ error: { code: 'CONVERSATION_REVISION_CONFLICT' } }, 409).api.thread(id),
    ).rejects.toMatchObject({ status: 409, code: 'CONVERSATION_REVISION_CONFLICT' });
    await expect(
      fixture({ error: { code: 'secret upstream payload' } }, 500).api.thread(id),
    ).rejects.toMatchObject({ status: 500, code: 'REQUEST_FAILED' });
  });
});

describe('coaching run retrieval preflight adapter', () => {
  const response = {
    schemaVersion: 2,
    scope: 'resource-retrieval-v2',
    query: '회복',
    checkedAt: '2026-09-20T00:00:00Z',
    authorizationDigest: 'a'.repeat(64),
    cache: 'miss',
    authorizedResourceCount: 6,
    indexing: { status: 'in_progress', indexedResourceCount: 5, pendingResourceCount: 1 },
    excerpts: [],
  };

  it('sends the exact bounded query and signal, returning coverage without private excerpts', async () => {
    const f = fixture(response);
    const signal = new AbortController().signal;
    expect(await createCoachingRunApi(f.apiTransport).retrieval('회복', signal)).toEqual({
      authorizedResourceCount: 6,
      indexing: response.indexing,
    });
    expect(f.request).toHaveBeenCalledWith({
      path: '/bff/v1/retrieval/queries',
      method: 'POST',
      body: { schemaVersion: 1, query: '회복', limit: 6 },
      idempotencyKey: null,
      signal,
    });
  });

  it('rejects malformed, mismatched, and oversized responses before run creation', async () => {
    for (const body of [
      { ...response, query: 'different' },
      {
        ...response,
        indexing: { status: 'complete', indexedResourceCount: 5, pendingResourceCount: 1 },
      },
      {
        ...response,
        authorizedResourceCount: 101,
        indexing: { status: 'complete', indexedResourceCount: 101, pendingResourceCount: 0 },
      },
      { ...response, schemaVersion: 1, scope: 'resource-retrieval-v1' },
    ]) {
      const f = fixture(body);
      await expect(createCoachingRunApi(f.apiTransport).retrieval('회복')).rejects.toThrow();
    }
    const f = fixture(response);
    await expect(createCoachingRunApi(f.apiTransport).retrieval(' ')).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
});
