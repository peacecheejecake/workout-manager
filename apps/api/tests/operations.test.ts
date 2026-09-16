import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/app.js';
import { OperationsError, type OperationsRepository } from '@workout/server-persistence/operations';
import { TenantErasedError } from '@workout/server-persistence/database';

const headers = {
  cookie: 'session=fixture',
  origin: 'https://app.example',
  'x-workout-session-id': 'fixture-session',
  'x-csrf-token': 'a'.repeat(32),
};
const empty = {
  consents: [],
  planSnapshots: [],
  planHead: [],
  planHistory: [],
  activities: [],
  activitySources: [],
  sourceRevisions: [],
  overlays: [],
  overlayRevisions: [],
  suppressions: [],
};
const repository = (): OperationsRepository => ({
  exportAccount: vi.fn(async (athleteId) => ({
    schemaVersion: 1 as const,
    athleteId,
    exportedAt: '2026-09-16T00:00:00Z',
    data: empty,
  })),
  eraseAccount: vi.fn(async () => ({ erased: true as const })),
  status: vi.fn(async () => ({
    checkedAt: '2026-09-16T00:00:00Z',
    outbox: { pending: 0, leased: 0, retrying: 0, completed: 0 },
    providers: { garmin: 'not_connected' as const, healthkit: 'not_connected' as const },
    audit: [],
  })),
});
const apps: ReturnType<typeof createApi>[] = [];
function setup() {
  const operations = repository();
  const logs: string[] = [];
  const app = createApi({
    auth: {
      authenticate: async ({ cookie }) =>
        cookie === headers.cookie
          ? {
              athleteId: 'tenant-a',
              sessionId: 'fixture-session',
              method: 'cookie',
              csrfToken: headers['x-csrf-token'],
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    operations,
    allowedOrigins: ['https://app.example'],
    logStream: new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, operations, logs };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe('M1-06a account operations boundary', () => {
  it('requires authentication, same session, CSRF and explicit exact deletion confirmation', async () => {
    const { app, operations } = setup();
    const request = {
      method: 'DELETE' as const,
      url: '/bff/v1/operations/account',
      payload: { confirmation: 'DELETE MY ACCOUNT' },
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(
      (await app.inject({ ...request, headers: { ...headers, 'x-workout-session-id': 'old' } }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ ...request, headers: { ...headers, origin: 'https://evil.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ ...request, headers, payload: { confirmation: 'delete' } })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          ...request,
          headers,
          payload: { ...request.payload, athleteId: 'tenant-b' },
        })
      ).statusCode,
    ).toBe(400);
    expect(operations.eraseAccount).not.toHaveBeenCalled();
    expect((await app.inject({ ...request, headers })).json()).toEqual({ erased: true });
    expect(operations.eraseAccount).toHaveBeenCalledExactlyOnceWith('tenant-a');
  });
  it('exports only the authenticated scope with no-store and never accepts user-selected account IDs', async () => {
    const { app, operations } = setup();
    const request = { method: 'POST' as const, url: '/bff/v1/operations/export', headers };
    expect(
      (await app.inject({ ...request, url: request.url + '?athleteId=tenant-b' })).statusCode,
    ).toBe(400);
    expect((await app.inject({ ...request, payload: { athleteId: 'tenant-b' } })).statusCode).toBe(
      400,
    );
    const result = await app.inject(request);
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-disposition']).toContain('workout-account.json');
    expect(result.json()).toMatchObject({ athleteId: 'tenant-a', data: empty });
    expect(operations.exportAccount).toHaveBeenCalledExactlyOnceWith('tenant-a');
  });
  it('reports bounded export rejection and erased tenant denial without leaking payloads in logs', async () => {
    const { app, operations, logs } = setup();
    vi.mocked(operations.exportAccount).mockRejectedValue(new OperationsError('EXPORT_TOO_LARGE'));
    expect(
      (await app.inject({ method: 'POST', url: '/bff/v1/operations/export', headers })).statusCode,
    ).toBe(413);
    vi.mocked(operations.status).mockRejectedValue(new TenantErasedError());
    expect(
      (await app.inject({ method: 'GET', url: '/bff/v1/operations/status', headers })).statusCode,
    ).toBe(401);
    expect(logs.join('')).not.toContain('session=fixture');
    expect(logs.join('')).not.toContain(headers['x-csrf-token']);
  });
});
