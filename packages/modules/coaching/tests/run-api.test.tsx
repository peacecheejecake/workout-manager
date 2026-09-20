import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { createCoachingRunApi, type CoachingRunRequestError } from '../src/run-api';

const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const evidenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const run = {
  schemaVersion: 1,
  id: runId,
  threadId,
  evidenceSnapshotId: evidenceId,
  conversationRevision: 1,
  policy: { id: 'running-core-policy', version: '2026-09-18' },
  source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
  status: { kind: 'queued' },
};
function fixture(body: unknown = run, status = 200) {
  const request = vi
    .fn<AuthenticatedTransport['request']>()
    .mockResolvedValue(transportReplySchema.parse({ body, status, traceId: null }));
  return { request, api: createCoachingRunApi({ request }) };
}

describe('coaching run API boundary', () => {
  it('sends a route-scoped command and stable idempotency key without client policy', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(
      await f.api.create(
        threadId.toUpperCase(),
        {
          schemaVersion: 1,
          evidenceSnapshotId: evidenceId,
          expectedConversationRevision: 1,
          idempotencyKey: 'stable-key',
        },
        signal,
      ),
    ).toMatchObject({ id: runId, status: { kind: 'queued' } });
    expect(f.request.mock.calls[0]?.[0]).toEqual({
      path: `/bff/v1/coaching-threads/${threadId}/runs`,
      method: 'POST',
      body: {
        schemaVersion: 1,
        evidenceSnapshotId: evidenceId,
        expectedConversationRevision: 1,
        retrieval: { kind: 'none' },
      },
      idempotencyKey: 'stable-key',
      signal,
    });
  });

  it('bounds and checks tenant-linked list and detail responses', async () => {
    const list = fixture({ items: [run], total: 1 });
    expect((await list.api.list(threadId, { limit: 20, offset: 0 })).items).toHaveLength(1);
    expect(list.request.mock.calls[0]?.[0].path).toBe(
      `/bff/v1/coaching-threads/${threadId}/runs?limit=20&offset=0`,
    );
    await expect(
      fixture({ items: [{ ...run, threadId: evidenceId }], total: 1 }).api.list(threadId, {}),
    ).rejects.toThrow('COACHING_RUN_RESPONSE_MISMATCH');
    await expect(fixture({ ...run, id: evidenceId }).api.read(threadId, runId)).rejects.toThrow(
      'COACHING_RUN_RESPONSE_MISMATCH',
    );
    await expect(
      fixture({ ...run, conversationRevision: 2 }).api.create(threadId, {
        schemaVersion: 1,
        evidenceSnapshotId: evidenceId,
        expectedConversationRevision: 1,
        idempotencyKey: 'stable-key',
      }),
    ).rejects.toThrow('COACHING_RUN_RESPONSE_MISMATCH');
  });

  it('never exposes arbitrary server error content and sends bodyless cancellation', async () => {
    const failed = fixture({ error: { code: 'PRIVATE_ERROR', detail: 'secret' } }, 409);
    await expect(failed.api.read(threadId, runId)).rejects.toMatchObject({
      status: 409,
      code: 'REQUEST_FAILED',
    } satisfies Partial<CoachingRunRequestError>);
    const f = fixture();
    await f.api.cancel(threadId, runId);
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: `/bff/v1/coaching-runs/${runId}/cancel`,
      body: null,
      idempotencyKey: null,
    });
  });
});
