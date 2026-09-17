import { describe, it, expect, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { CoreEvidenceSnapshot } from '@workout/contracts/evidence-snapshots';
import { createEvidenceApi, EvidenceRequestError } from '../src/evidence-api';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  at = '2026-09-18T00:00:00Z';
const command = {
  expectedConversationRevision: 1,
  window: { from: '2026-09-17', toExclusive: '2026-09-19', timezone: 'UTC' },
  idempotencyKey: 'stable',
};
const purged = { id, threadId: id, createdAt: at, status: 'purged', reason: 'source_deleted' };
function available(): CoreEvidenceSnapshot {
  return {
    id,
    threadId: id,
    createdAt: at,
    status: 'available',
    body: {
      schemaVersion: 1,
      scope: 'running-core-v1',
      window: command.window,
      thread: {
        id,
        planVersionId: id,
        title: 'thread',
        scope: { kind: 'phase', targetId: 'phase' },
        revision: 1,
        createdAt: at,
        updatedAt: at,
      },
      plan: {
        id,
        version: 1,
        createdAt: at,
        draft: {
          title: 'plan',
          timezone: 'UTC',
          sessions: [],
          periods: (['season', 'wave', 'phase'] as const).map((level, i, levels) => ({
            id: level,
            parentId: i ? (levels[i - 1] ?? null) : null,
            level,
            title: level,
            startDate: '2026-09-17',
            endDateExclusive: '2026-09-19',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          })),
        },
      },
      messages: [
        { id, threadId: id, revision: 1, role: 'user', content: 'question', createdAt: at },
      ],
      activities: [],
      checkIns: [],
      sessionCompletions: [],
      dependencies: {
        schemaVersion: 1,
        scope: 'core-ledgers-v1',
        athleteId: 'owner',
        capturedAt: at,
        trainingPlan: { kind: 'exists', versionId: id },
        activities: { count: '0', revisionSum: '0' },
        checkIns: { kind: 'absent' },
        sessionCompletions: { kind: 'absent' },
        aiConsent: { kind: 'absent' },
      },
    },
  };
}
function fixture(body: unknown = purged, status = 200) {
  const request = vi
    .fn<AuthenticatedTransport['request']>()
    .mockResolvedValue(transportReplySchema.parse({ body, status, traceId: null }));
  return { request, api: createEvidenceApi({ request }) };
}
describe('evidence API boundaries', () => {
  it('sends stable key separately, preserves abort and accepts purged replay', async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    expect(await f.api.capture(id.toUpperCase(), command, signal)).toEqual(purged);
    await f.api.capture(id, command, signal);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[0]?.[0]).toEqual({
      path: `/bff/v1/coaching-threads/${id}/evidence-snapshots`,
      method: 'POST',
      body: { expectedConversationRevision: 1, window: command.window },
      idempotencyKey: 'stable',
      signal,
    });
  });
  it('checks available capture window and conversation revision', async () => {
    expect((await fixture(available()).api.capture(id, command)).status).toBe('available');
    await expect(
      fixture(available()).api.capture(id, { ...command, expectedConversationRevision: 2 }),
    ).rejects.toThrow('EVIDENCE_RESPONSE_MISMATCH');
    await expect(
      fixture(available()).api.capture(id, {
        ...command,
        window: { ...command.window, timezone: 'Asia/Seoul' },
      }),
    ).rejects.toThrow('EVIDENCE_RESPONSE_MISMATCH');
  });
  it('rejects wrong snapshot/thread IDs and list limits', async () => {
    await expect(fixture({ ...purged, threadId: other }).api.read(id, id)).rejects.toThrow(
      'EVIDENCE_RESPONSE_MISMATCH',
    );
    await expect(fixture({ ...purged, id: other }).api.read(id, id)).rejects.toThrow(
      'EVIDENCE_RESPONSE_MISMATCH',
    );
    await expect(
      fixture({ items: [{ ...purged, threadId: other }], total: 1 }).api.list(id, {}),
    ).rejects.toThrow('EVIDENCE_RESPONSE_MISMATCH');
    await expect(
      fixture({ items: [purged, { ...purged, id: other }], total: 2 }).api.list(id, { limit: 1 }),
    ).rejects.toThrow('EVIDENCE_RESPONSE_MISMATCH');
  });
  it('validates request paths/query before transport and uses read-only list/read', async () => {
    const f = fixture({ items: [purged], total: 1 }),
      signal = new AbortController().signal;
    await f.api.list(id, {}, signal);
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      path: `/bff/v1/coaching-threads/${id}/evidence-snapshots?limit=20&offset=0`,
      method: 'GET',
      signal,
    });
    await expect(f.api.read('../escape', id)).rejects.toThrow();
    await expect(f.api.list(id, { offset: 10001 })).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('sanitizes errors and keeps malformed/network results uncertain without retries', async () => {
    await expect(
      fixture({ error: { code: 'EVIDENCE_TOO_LARGE' } }, 413).api.capture(id, command),
    ).rejects.toMatchObject({ status: 413, code: 'EVIDENCE_TOO_LARGE' });
    await expect(
      fixture({ error: { code: 'private-token' } }, 500).api.read(id, id),
    ).rejects.toMatchObject({ status: 500, code: 'REQUEST_FAILED' });
    const f = fixture({ private: 'secret' });
    await expect(f.api.read(id, id)).rejects.toThrow('EVIDENCE_RESPONSE_INVALID');
    f.request.mockRejectedValue(new Error('private-token'));
    await expect(f.api.read(id, id)).rejects.not.toBeInstanceOf(EvidenceRequestError);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});
