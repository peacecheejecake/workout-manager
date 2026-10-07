import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { checkInTemplateVersionSchema } from '@workout/contracts/check-in-templates';
import type { CheckInTemplateRoutesRepository } from '../src/check-in-template-routes.js';
import { createApi } from '../src/app.js';

// Real product registration and createApi auth/CSRF hooks; repository is mocked.
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const athleteId = 'authenticated-athlete';
const base = '/bff/v1/check-in-templates';
const record = checkInTemplateVersionSchema.parse({
  templateId: id,
  versionId,
  version: 1,
  previousVersionId: null,
  previousVersion: null,
  createdAt: '2026-10-08T00:00:00.123456Z',
  content: {
    definitionVersion: 'checkin-v1',
    source: 'user',
    method: 'self_report',
    title: '직접 보고',
    instructions: null,
    fields: ['note', 'fatigue'],
  },
});
const body = { templateId: id, expectedVersion: 0, content: record.content };
const headers = {
  cookie: 'synthetic-session',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
  'x-workout-session-id': 'current',
  'idempotency-key': 'template_save_0001',
};
const apps: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const repository = {
    save: vi.fn<CheckInTemplateRoutesRepository['save']>().mockResolvedValue(record),
    readExact: vi.fn<CheckInTemplateRoutesRepository['readExact']>().mockResolvedValue(record),
    readHead: vi.fn<CheckInTemplateRoutesRepository['readHead']>().mockResolvedValue(record),
    list: vi.fn<CheckInTemplateRoutesRepository['list']>().mockResolvedValue({ items: [record] }),
  };
  const app = createApi({
    checkInTemplates: repository,
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId,
              sessionId: 'current',
              csrfToken: headers['x-csrf-token'],
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, repository };
}
const requests = [
  { method: 'GET' as const, url: base },
  { method: 'GET' as const, url: `${base}/${id}` },
  { method: 'GET' as const, url: `${base}/${id}/versions/${versionId}` },
  { method: 'POST' as const, url: base, payload: body },
];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('uses actual parent authentication hooks before every repository call', async () => {
  const { app, repository } = setup(false);
  for (const request of requests)
    expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  for (const fn of Object.values(repository)) expect(fn).not.toHaveBeenCalled();
});
it('rejects stale cookie sessions for reads and writes', async () => {
  const { app, repository } = setup();
  for (const request of requests) {
    const response = await app.inject({
      ...request,
      headers: { ...headers, 'x-workout-session-id': 'stale' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SESSION_CHANGED');
  }
  for (const fn of Object.values(repository)) expect(fn).not.toHaveBeenCalled();
});
it('uses parent cookie CSRF and origin checks for the write', async () => {
  const { app, repository } = setup();
  for (const override of [{ origin: 'https://foreign.example' }, { 'x-csrf-token': '' }])
    expect(
      (await app.inject({ ...requests[3], headers: { ...headers, ...override } })).statusCode,
    ).toBe(403);
  expect(repository.save).not.toHaveBeenCalled();
});
it('derives only server principal and header key, preserving strict content/µs/null/order', async () => {
  const { app, repository } = setup();
  const response = await app.inject({ method: 'POST', url: base, payload: body, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(record);
  expect(repository.save).toHaveBeenCalledWith(athleteId, {
    ...body,
    idempotencyKey: headers['idempotency-key'],
  });
  expect(response.headers['cache-control']).toBe('no-store');
});
it('reads paired historical version and independent head/list under authenticated ownership', async () => {
  const { app, repository } = setup();
  for (const request of requests.slice(0, 3))
    expect((await app.inject({ ...request, headers })).statusCode).toBe(200);
  expect(repository.readExact).toHaveBeenCalledWith(athleteId, id, versionId);
  expect(repository.readHead).toHaveBeenCalledWith(athleteId, id);
  expect(repository.list).toHaveBeenCalledWith(athleteId, { limit: 20, offset: 0 });
  expect((await app.inject({ url: `${base}?limit=100&offset=10000`, headers })).statusCode).toBe(
    200,
  );
  expect(repository.list).toHaveBeenLastCalledWith(athleteId, { limit: 100, offset: 10000 });
});
it.each(['idempotencyKey', 'athleteId', 'versionId', 'createdAt', 'tenant', 'provenance'])(
  'rejects forbidden body field %s without write',
  async (field) => {
    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base,
          headers,
          payload: { ...body, [field]: 'injected' },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
  },
);
it('rejects absent header key and unknown/nested malformed content', async () => {
  const { app, repository } = setup();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: base,
        payload: body,
        headers: { ...headers, 'idempotency-key': '' },
      })
    ).statusCode,
  ).toBe(400);
  for (const content of [
    { ...record.content, actual: 0 },
    { ...record.content, fields: ['note', 'note'] },
  ])
    expect(
      (await app.inject({ method: 'POST', url: base, payload: { ...body, content }, headers }))
        .statusCode,
    ).toBe(400);
  expect(repository.save).not.toHaveBeenCalled();
});
it.each(['limit=101', 'offset=10001', 'offset=-1', 'limit=01', 'limit=2&limit=3', 'unknown=1'])(
  'rejects list query %s',
  async (query) => {
    const { app, repository } = setup();
    expect((await app.inject({ url: `${base}?${query}`, headers })).statusCode).toBe(400);
    expect(repository.list).not.toHaveBeenCalled();
  },
);
it('rejects invalid UUID and unexpected read/write queries', async () => {
  const { app, repository } = setup();
  for (const url of [
    `${base}/opaque`,
    `${base}/${id}/versions/opaque`,
    `${base}/${id}?unknown=1`,
    `${base}/${id}/versions/${versionId}?limit=1`,
  ])
    expect((await app.inject({ url, headers })).statusCode).toBe(400);
  expect(
    (await app.inject({ method: 'POST', url: `${base}?extra=1`, headers, payload: body }))
      .statusCode,
  ).toBe(400);
  for (const fn of Object.values(repository)) expect(fn).not.toHaveBeenCalled();
});
it('normalizes paired UUIDs without falling back to a latest head', async () => {
  const { app, repository } = setup();
  expect(
    (
      await app.inject({
        url: `${base}/${id.toUpperCase()}/versions/${versionId.toUpperCase()}`,
        headers,
      })
    ).statusCode,
  ).toBe(200);
  expect(repository.readExact).toHaveBeenCalledWith(athleteId, id, versionId);
  expect(repository.readHead).not.toHaveBeenCalled();
});
it('returns contentless 404 for foreign/missing exact and head results', async () => {
  const { app, repository } = setup();
  repository.readExact.mockResolvedValue(null);
  repository.readHead.mockResolvedValue(null);
  for (const url of [`${base}/${id}`, `${base}/${id}/versions/${versionId}`]) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(record.content.title);
  }
});
it.each([
  ['CHECK_IN_TEMPLATE_VERSION_CONFLICT', 409],
  ['IDEMPOTENCY_CONFLICT', 409],
  ['APP_CONSENT_REQUIRED', 409],
  ['CHECK_IN_TEMPLATE_BOUND', 413],
  ['CHECK_IN_TEMPLATE_INVALID_RESPONSE', 500],
] as const)('sanitizes finite repository failure %s', async (code, status) => {
  const { app, repository } = setup();
  repository.save.mockRejectedValue(Object.assign(new Error('raw private SQL/body'), { code }));
  const response = await app.inject({ method: 'POST', url: base, payload: body, headers });
  expect(response.statusCode).toBe(status);
  expect(response.body).not.toContain('raw private SQL/body');
});
it('does not leak unknown SQL privilege errors or malformed/mismatched DTO responses', async () => {
  const { app, repository } = setup();
  repository.readExact.mockRejectedValue(
    Object.assign(new Error('private table permission denied'), { code: '42501' }),
  );
  const response = await app.inject({ url: `${base}/${id}/versions/${versionId}`, headers });
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain('private table');
  repository.readExact.mockResolvedValue({ ...record, versionId: id });
  expect(
    (await app.inject({ url: `${base}/${id}/versions/${versionId}`, headers })).statusCode,
  ).toBe(500);
});
it('does not provide PUT/DELETE template deletion or actual-report endpoints', async () => {
  const { app, repository } = setup();
  for (const method of ['PUT', 'DELETE'] as const)
    expect(
      (await app.inject({ method, url: `${base}/${id}`, headers, payload: body })).statusCode,
    ).toBe(404);
  for (const fn of Object.values(repository)) expect(fn).not.toHaveBeenCalled();
});
