import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { activityListQueryOptions, activityListSchema } from '../src/activities.js';
const scope = { userId: 'user-a', workspaceId: 'workspace-a', sessionId: 'session-a' };
const item = {
  id: 'activity-a',
  title: 'Fixture activity',
  startedAt: '2026-09-16T00:00:00Z',
  durationSeconds: null,
  source: 'fixture',
};
describe('activity query boundary', () => {
  it('keeps unknown duration distinct from measured zero and rejects duplicate IDs', () => {
    expect(activityListSchema.parse({ items: [item] }).items[0]?.durationSeconds).toBeNull();
    expect(
      activityListSchema.parse({ items: [{ ...item, durationSeconds: 0 }] }).items[0]
        ?.durationSeconds,
    ).toBe(0);
    expect(activityListSchema.safeParse({ items: [item, item] }).success).toBe(false);
  });
  it('scopes cache by user/workspace/session and supports injected transport replacement', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const first = {
      request: vi.fn(async () => ({ status: 200, body: { items: [item] }, traceId: null })),
    };
    const second = {
      request: vi.fn(async () => ({ status: 200, body: { items: [] }, traceId: null })),
    };
    const result = await client.fetchQuery(activityListQueryOptions(scope, first));
    expect(result.items).toHaveLength(1);
    expect(
      (await client.fetchQuery(activityListQueryOptions({ ...scope, userId: 'user-b' }, second)))
        .items,
    ).toHaveLength(0);
    expect(
      (
        await client.fetchQuery(
          activityListQueryOptions({ ...scope, sessionId: 'session-b' }, second),
        )
      ).items,
    ).toHaveLength(0);
    expect(first.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/bff/v1/activities',
        method: 'GET',
        body: null,
        signal: expect.any(AbortSignal),
      }),
    );
    client.clear();
  });
  it.each([
    { status: 401, body: { secret: 'not displayed' }, traceId: null },
    { status: 200, body: { items: [{ ...item, durationSeconds: -1 }] }, traceId: null },
    { status: 200, body: { items: [{ ...item, token: 'not allowed' }] }, traceId: null },
  ])('rejects unsuccessful and malformed payloads with sanitized errors', async (reply) => {
    const transport: AuthenticatedTransport = { request: async () => reply };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(activityListQueryOptions(scope, transport))).rejects.toThrow(
      /^ACTIVITIES_/,
    );
    client.clear();
  });
  it('propagates cancellation into the transport on cache disposal', async () => {
    let requestSignal: AbortSignal | undefined;
    const transport: AuthenticatedTransport = {
      request: (input) => {
        requestSignal = input.signal;
        return new Promise(() => {});
      },
    };
    const client = new QueryClient();
    const request = client.fetchQuery(activityListQueryOptions(scope, transport)).catch(() => null);
    expect(requestSignal?.aborted).toBe(false);
    client.clear();
    await request;
    expect(requestSignal?.aborted).toBe(true);
  });
});
