import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreEvidenceSnapshotSchema } from '@workout/contracts/evidence-snapshots';
import { CoreEvidenceSnapshotError } from '@workout/server-persistence/evidence-snapshots';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const createdAt = '2026-09-18T00:00:00Z';
const window = { from: '2026-09-01', toExclusive: '2026-09-08', timezone: 'UTC' };
const body = { expectedConversationRevision: 1, window };
const thread = {
  id,
  planVersionId: id,
  title: 'Synthetic thread',
  scope: { kind: 'phase', targetId: 'phase' },
  revision: 1,
  createdAt,
  updatedAt: createdAt,
};
const available = coreEvidenceSnapshotSchema.parse({
  id,
  threadId: id,
  createdAt,
  status: 'available',
  body: {
    schemaVersion: 1,
    scope: 'running-core-v1',
    window,
    thread,
    plan: {
      id,
      version: 1,
      createdAt,
      draft: {
        title: 'Synthetic plan',
        timezone: 'UTC',
        sessions: [],
        periods: (['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
          id: level,
          parentId: index === 0 ? null : levels[index - 1],
          level,
          title: level,
          startDate: '2026-09-01',
          endDateExclusive: '2026-09-08',
          timezone: 'UTC',
          intent: '',
          isPartial: false,
        })),
      },
    },
    messages: [
      { id, threadId: id, revision: 1, role: 'user', content: 'Synthetic question', createdAt },
    ],
    dependencies: {
      schemaVersion: 1,
      scope: 'core-ledgers-v1',
      athleteId: 'owner',
      capturedAt: createdAt,
      trainingPlan: { kind: 'exists', versionId: id },
      activities: { count: '0', revisionSum: '0' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      aiConsent: { kind: 'absent' },
    },
    activities: [],
    checkIns: [],
    sessionCompletions: [],
  },
});
const metadata = { id, threadId: id, createdAt, status: 'available' as const };
const headers = {
  'x-workout-session-id': 'current',
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'synthetic-capture',
};
const collection = `/bff/v1/coaching-threads/${id}/evidence-snapshots`;
const detail = `/bff/v1/evidence-snapshots/${id}`;
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const repository = {
    capture: vi.fn().mockResolvedValue(available),
    read: vi.fn().mockResolvedValue(available),
    list: vi.fn().mockResolvedValue({ items: [metadata], total: 1 }),
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
    evidenceSnapshots: repository,
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

describe('core evidence snapshot API boundaries', () => {
  it('derives ownership, normalizes UUIDs and delegates stable header commands and bounded metadata history', async () => {
    const { app, repository } = setup();
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'POST',
        url: collection.replace(id, id.toUpperCase()),
        headers,
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(available);
    }
    expect(repository.capture).toHaveBeenNthCalledWith(2, 'owner', id, {
      ...body,
      idempotencyKey: headers['idempotency-key'],
    });
    expect(
      (await app.inject({ url: detail.replace(id, id.toUpperCase()), headers })).statusCode,
    ).toBe(200);
    expect(repository.read).toHaveBeenCalledWith('owner', id);
    expect((await app.inject({ url: collection, headers })).json()).toEqual({
      items: [metadata],
      total: 1,
    });
    expect(repository.list).toHaveBeenLastCalledWith('owner', id, { limit: 20, offset: 0 });
    expect((await app.inject({ url: `${collection}?limit=3&offset=2`, headers })).statusCode).toBe(
      200,
    );
    expect(repository.list).toHaveBeenLastCalledWith('owner', id, { limit: 3, offset: 2 });
  });
  it('requires authentication, current session and write CSRF before accessing evidence', async () => {
    const anonymous = setup(false);
    for (const url of [collection, detail])
      expect((await anonymous.app.inject({ url, headers })).statusCode).toBe(401);
    expect(
      (await anonymous.app.inject({ method: 'POST', url: collection, headers, payload: body }))
        .statusCode,
    ).toBe(401);
    expect(anonymous.repository.capture).not.toHaveBeenCalled();
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
          url: collection,
          headers: { ...headers, 'x-csrf-token': 'bad' },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.capture).not.toHaveBeenCalled();
  });
  it.each([
    `${collection}?owner=foreign`,
    `${collection}?limit=101`,
    `${collection}?offset=-1`,
    `${collection}?limit=1&limit=2`,
    `${detail}?extra=x`,
    '/bff/v1/evidence-snapshots/not-uuid',
    '/bff/v1/coaching-threads/not-uuid/evidence-snapshots',
  ])('rejects invalid path/query %s before repository access', async (url) => {
    const { app, repository } = setup();
    expect((await app.inject({ url, headers })).statusCode).toBe(400);
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, athleteId: 'foreign' },
    { ...body, idempotencyKey: 'body-key' },
    { ...body, body: { private: 'injected' } },
    { ...body, expectedConversationRevision: 0 },
    { ...body, window: { ...window, toExclusive: window.from } },
    { ...body, window: { ...window, toExclusive: '2027-01-01' } },
    { ...body, window: { ...window, timezone: 'invalid/zone' } },
    { ...body, window: { ...window, extra: true } },
  ])('rejects invalid capture payload %j', async (payload) => {
    const { app, repository } = setup();
    expect(
      (await app.inject({ method: 'POST', url: collection, headers, payload })).statusCode,
    ).toBe(400);
    expect(repository.capture).not.toHaveBeenCalled();
  });
  it('requires a valid header key and empty POST query and limits input to 16 KiB', async () => {
    const { app, repository } = setup();
    const { 'idempotency-key': ignored, ...noKey } = headers;
    expect(ignored).toBe('synthetic-capture');
    for (const requestHeaders of [noKey, { ...headers, 'idempotency-key': ' invalid ' }])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: collection,
            headers: requestHeaders,
            payload: body,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: `${collection}?limit=1`, headers, payload: body }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: collection,
          headers,
          payload: { ...body, text: 'x'.repeat(16384) },
        })
      ).statusCode,
    ).toBe(413);
    expect(repository.capture).not.toHaveBeenCalled();
  });
  it.each([
    ['THREAD_NOT_FOUND', 404],
    ['CONVERSATION_REVISION_CONFLICT', 409],
    ['EVIDENCE_TOO_LARGE', 413],
  ] as const)('maps %s without exposing evidence', async (code, status) => {
    const { app, repository } = setup();
    repository.capture.mockRejectedValue(new CoreEvidenceSnapshotError(code));
    const result = await app.inject({ method: 'POST', url: collection, headers, payload: body });
    expect(result.statusCode).toBe(status);
    expect(result.json()).toMatchObject({ error: { code } });
  });
  it('maps generic idempotency conflicts and missing owned records', async () => {
    const { app, repository } = setup();
    repository.capture.mockRejectedValue(new PersistenceConflict('IDEMPOTENCY_CONFLICT'));
    const conflict = await app.inject({ method: 'POST', url: collection, headers, payload: body });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    repository.read.mockResolvedValue(null);
    repository.list.mockResolvedValue(null);
    expect((await app.inject({ url: detail, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: collection, headers })).statusCode).toBe(404);
  });
  it('returns purged metadata without a body, including replay, and fails closed for malformed output', async () => {
    const { app, repository } = setup();
    const purged = { ...metadata, status: 'purged', reason: 'source_deleted' };
    repository.capture.mockResolvedValue(purged);
    repository.read.mockResolvedValue(purged);
    expect(
      (await app.inject({ method: 'POST', url: collection, headers, payload: body })).json(),
    ).toEqual(purged);
    expect((await app.inject({ url: detail, headers })).json()).toEqual(purged);
    repository.read.mockResolvedValue({ ...purged, body: { private: 'must-not-leak' } });
    const invalid = await app.inject({ url: detail, headers });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).not.toContain('must-not-leak');
    repository.capture.mockResolvedValue({ ...metadata, body: null });
    expect(
      (await app.inject({ method: 'POST', url: collection, headers, payload: body })).statusCode,
    ).toBe(500);
    repository.list.mockResolvedValue({ items: [available], total: 1 });
    expect((await app.inject({ url: collection, headers })).statusCode).toBe(500);
    repository.read.mockRejectedValue(new Error('private-snapshot-secret'));
    const failed = await app.inject({ url: detail, headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('private-snapshot-secret');
  });
});
