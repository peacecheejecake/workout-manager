import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCompletion } from '@workout/contracts/session-completion';
import {
  SessionCompletionError,
  type SessionCompletionRepository,
} from '@workout/server-persistence/session-completions';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';

const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'session / 한국어';
const path = `/bff/v1/plans/sessions/${encodeURIComponent(sessionId)}/completion`;
const listPath = '/bff/v1/plans/current/session-completions';
const headers = {
  cookie: 'verified',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'completion-command-0001',
};
const body = {
  action: 'complete',
  confirmed: true,
  expectedPlanVersionId: version,
  expectedRevision: null,
  reason: null,
};
const report: SessionCompletion = {
  sessionId,
  revision: 1,
  planVersionId: version,
  schedule: { blockId: 'block', date: '2026-09-17', localStartTime: null, timezone: 'Asia/Seoul' },
  status: 'completed',
  reportedAt: '2026-09-17T00:00:00Z',
  reason: null,
  source: 'user',
  method: 'self_report',
  definitionVersion: 'session-completion-v1',
};
const apps: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const sessionCompletions = {
    list: vi
      .fn<SessionCompletionRepository['list']>()
      .mockResolvedValue({ currentPlanVersionId: version, collectionRevision: 1, items: [report] }),
    read: vi.fn<SessionCompletionRepository['read']>().mockResolvedValue({
      sessionId,
      currentPlanVersionId: version,
      report,
      history: [report],
      totalHistory: 1,
    }),
    write: vi
      .fn<SessionCompletionRepository['write']>()
      .mockResolvedValue({ report, collectionRevision: 1 }),
  };
  const planning = { read: vi.fn(), readVersion: vi.fn(), save: vi.fn() };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'auth-athlete',
              sessionId: 'current',
              csrfToken: headers['x-csrf-token'],
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    sessionCompletions,
    planning,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, sessionCompletions, planning };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('blocks unauthenticated reads and commands', async () => {
  const { app, sessionCompletions } = setup(false);
  for (const url of [path, listPath])
    expect((await app.inject({ url, headers })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(
    401,
  );
  for (const fn of Object.values(sessionCompletions)) expect(fn).not.toHaveBeenCalled();
});
it('requires matching session and same-origin CSRF for writes', async () => {
  const { app, sessionCompletions } = setup();
  expect(
    (await app.inject({ url: path, headers: { ...headers, 'x-workout-session-id': 'old' } }))
      .statusCode,
  ).toBe(409);
  for (const override of [{ origin: 'https://foreign.example' }, { 'x-csrf-token': '' }])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { ...headers, ...override },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  expect(sessionCompletions.write).not.toHaveBeenCalled();
});
it('derives tenant and decoded session ID and delegates stable idempotency retries', async () => {
  const { app, sessionCompletions } = setup();
  const first = await app.inject({ method: 'POST', url: path, headers, payload: body });
  expect(first.statusCode).toBe(200);
  const second = await app.inject({ method: 'POST', url: path, headers, payload: body });
  expect(second.json()).toEqual(first.json());
  expect(sessionCompletions.write).toHaveBeenCalledTimes(2);
  expect(sessionCompletions.write).toHaveBeenLastCalledWith('auth-athlete', sessionId, {
    ...body,
    idempotencyKey: headers['idempotency-key'],
  });
  expect((await app.inject({ url: listPath, headers })).statusCode).toBe(200);
  expect(sessionCompletions.list).toHaveBeenCalledWith('auth-athlete');
  expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
  expect(sessionCompletions.read).toHaveBeenCalledWith('auth-athlete', sessionId);
});
it.each(['s'.repeat(200), '한'.repeat(200)])('accepts bounded encoded session IDs', async (id) => {
  const { app, sessionCompletions } = setup();
  sessionCompletions.read.mockResolvedValue({
    sessionId: id,
    currentPlanVersionId: version,
    report: null,
    history: [],
    totalHistory: 0,
  });
  expect(
    (
      await app.inject({
        url: `/bff/v1/plans/sessions/${encodeURIComponent(id)}/completion`,
        headers,
      })
    ).statusCode,
  ).toBe(200);
  expect(sessionCompletions.read).toHaveBeenCalledWith('auth-athlete', id);
});
it('rejects extra query and spoofed body provenance or embedded idempotency', async () => {
  const { app, sessionCompletions } = setup();
  for (const url of [
    `${path}?athleteId=other`,
    `${listPath}?limit=10`,
    '/bff/v1/plans/sessions/%20/completion',
  ])
    expect((await app.inject({ url, headers })).statusCode).toBe(400);
  for (const payload of [
    { ...body, source: 'device' },
    { ...body, idempotencyKey: 'embedded' },
    { ...body, athleteId: 'other' },
    { ...body, confirmed: false },
    { ...body, action: 'retract' },
    { ...body, expectedRevision: 1 },
  ])
    expect((await app.inject({ method: 'POST', url: path, headers, payload })).statusCode).toBe(
      400,
    );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: path,
        headers: { ...headers, 'idempotency-key': '' },
        payload: body,
      })
    ).statusCode,
  ).toBe(400);
  for (const fn of Object.values(sessionCompletions)) expect(fn).not.toHaveBeenCalled();
});
it('returns safe absence for missing or foreign sessions', async () => {
  const { app, sessionCompletions } = setup();
  sessionCompletions.read.mockResolvedValue(null);
  expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
});
it.each([
  'SESSION_COMPLETION_NOT_FOUND',
  'PLAN_REVISION_CONFLICT',
  'COMPLETION_REVISION_CONFLICT',
  'COMPLETION_STATE_CONFLICT',
  'PLAN_COMPLETED_SESSION',
] as const)('maps %s to a stable client error', async (code) => {
  const { app, sessionCompletions } = setup();
  sessionCompletions.write.mockRejectedValue(new SessionCompletionError(code));
  const response = await app.inject({ method: 'POST', url: path, headers, payload: body });
  expect(response.statusCode).toBe(code === 'SESSION_COMPLETION_NOT_FOUND' ? 404 : 409);
  expect(response.json().error.code).toBe(code);
});
it('maps idempotency conflicts without exposing payloads', async () => {
  const { app, sessionCompletions } = setup();
  sessionCompletions.write.mockRejectedValue(new PersistenceConflict('IDEMPOTENCY_CONFLICT'));
  const response = await app.inject({ method: 'POST', url: path, headers, payload: body });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
});
it('maps the completed-session guard on plan saves', async () => {
  const { app, planning } = setup();
  planning.save.mockRejectedValue(new SessionCompletionError('PLAN_COMPLETED_SESSION'));
  const response = await app.inject({
    method: 'PUT',
    url: '/bff/v1/plans/current',
    headers,
    payload: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: version,
      draft: {
        title: 'synthetic',
        timezone: 'UTC',
        periods: [
          {
            id: 'season',
            parentId: null,
            level: 'season',
            title: 'season',
            startDate: '2026-09-01',
            endDateExclusive: '2026-10-01',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('PLAN_COMPLETED_SESSION');
});
