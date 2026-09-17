import { describe, it, expect, vi } from 'vitest';
import { createSessionTransport } from '@workout/platform/authenticated-workspace';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { runActivityBatchDelete } from '../src/batch-delete-command';
import type { BatchTarget } from '../src/batch-selection';
const target = (index: number): BatchTarget => ({
  id: String(index),
  revision: 7,
  title: 'Title',
  sourceKind: 'fit',
});
const reply = (status: number) => ({ status, body: null, traceId: null });
function setup() {
  const request = vi.fn<AuthenticatedTransport['request']>();
  return { request, transport: { request }, controller: new AbortController(), onResult: vi.fn() };
}
describe('sequential activity batch delete', () => {
  it('returns partial results and retries only explicitly supplied frozen revisions', async () => {
    const f = setup();
    f.request
      .mockResolvedValueOnce(reply(204))
      .mockResolvedValueOnce(reply(409))
      .mockResolvedValueOnce(reply(404))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(reply(500));
    const results = await runActivityBatchDelete({
      ...f,
      signal: f.controller.signal,
      targets: Array.from({ length: 5 }, (_, i) => target(i)),
    });
    expect(results.map((r) => r.status)).toEqual([
      'deleted',
      'conflict',
      'unavailable',
      'uncertain',
      'uncertain',
    ]);
    f.request.mockResolvedValue(reply(204));
    await runActivityBatchDelete({
      ...f,
      signal: f.controller.signal,
      targets: results.filter((r) => r.status === 'uncertain').map((r) => r.target),
    });
    expect(f.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/bff/v1/activities/4', body: { expectedRevision: 7 } }),
    );
  });
  it.each([401, 403])('halts remaining calls after %s', async (status) => {
    const f = setup();
    f.request.mockResolvedValue(reply(status));
    const result = await runActivityBatchDelete({
      ...f,
      signal: f.controller.signal,
      targets: [target(0), target(1)],
    });
    expect(result.map((r) => r.status)).toEqual(['reauth_required', 'not_attempted']);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('never sends or calls callbacks after pre-abort', async () => {
    const f = setup();
    f.controller.abort();
    const result = await runActivityBatchDelete({
      ...f,
      signal: f.controller.signal,
      targets: [target(0)],
    });
    expect(result[0]?.status).toBe('not_attempted');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.onResult).not.toHaveBeenCalled();
  });
  it('treats late success after cancellation as uncertain and freezes the original snapshot', async () => {
    const f = setup();
    let resolve: ((value: ReturnType<typeof reply>) => void) | undefined;
    f.request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const targets = [target(0), target(1)];
    const pending = runActivityBatchDelete({ ...f, signal: f.controller.signal, targets });
    targets[1] = { ...target(1), revision: 99 };
    f.controller.abort();
    if (!resolve) throw new Error('Missing pending request');
    resolve(reply(204));
    const result = await pending;
    expect(result.map((r) => r.status)).toEqual(['uncertain', 'not_attempted']);
    expect(result[1]?.target.revision).toBe(7);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.onResult).not.toHaveBeenCalled();
  });
  it('rejects duplicate or oversized input before requests', async () => {
    const f = setup();
    for (const targets of [
      [target(0), target(0)],
      Array.from({ length: 101 }, (_, i) => target(i)),
    ])
      await expect(
        runActivityBatchDelete({ ...f, signal: f.controller.signal, targets }),
      ).rejects.toThrow('INVALID_BATCH_TARGETS');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('marks malformed replies uncertain', async () => {
    const f = setup();
    // @ts-expect-error Runtime transport responses must be validated.
    f.request.mockResolvedValue({ status: '204', body: null });
    expect(
      (await runActivityBatchDelete({ ...f, signal: f.controller.signal, targets: [target(0)] }))[0]
        ?.status,
    ).toBe('uncertain');
  });
});

it.each([401, 409])(
  'stops real session transport after authentication failure %s without waiting for unmount',
  async (status) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: status === 409 ? 'SESSION_CHANGED' : 'UNAUTHENTICATED' },
        }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      const expired = vi.fn();
      const transport = createSessionTransport(
        {
          athleteId: 'athlete',
          sessionId: 'session',
          csrfToken: 'csrf',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        expired,
      );
      const onResult = vi.fn();
      const results = await runActivityBatchDelete({
        targets: [target(0), target(1)],
        transport,
        signal: new AbortController().signal,
        onResult,
      });
      expect(results.map((result) => result.status)).toEqual(['reauth_required', 'not_attempted']);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(expired).toHaveBeenCalledTimes(1);
      expect(onResult.mock.calls.map((call) => call[0].status)).toEqual([
        'reauth_required',
        'not_attempted',
      ]);
    } finally {
      fetcher.mockRestore();
    }
  },
);

it.each(['before', 'after'] as const)(
  'halts unavailable real session scope %s fetch without claiming reauthentication',
  async (when) => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const expired = vi.fn();
      const transport = createSessionTransport(
        {
          athleteId: 'athlete',
          sessionId: 'session',
          csrfToken: 'csrf',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        expired,
        () => when !== 'before',
        () => when !== 'after',
      );
      const result = await runActivityBatchDelete({
        targets: [target(0), target(1)],
        transport,
        signal: new AbortController().signal,
        onResult: vi.fn(),
      });
      expect(result.map((item) => item.status)).toEqual(['uncertain', 'not_attempted']);
      expect(fetcher).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
      expect(expired).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  },
);
