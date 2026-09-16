import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckIn } from '@workout/contracts/check-ins';
import {
  CheckInNotFound,
  CheckInValidationError,
  type CheckInRepository,
} from '@workout/server-persistence/check-ins';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';

const athleteId = 'athlete-from-auth';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = '/bff/v1/check-ins';
const values = {
  observedAt: '2026-09-16T01:00:00.000Z',
  timezone: 'Asia/Seoul',
  fatigue: null,
  discomfort: 0,
  bodyLocation: null,
  note: null,
};
const result = { id, revision: 1, collectionRevision: 1, deleted: false };
const entry: CheckIn = {
  id,
  revision: 1,
  values,
  localDate: '2026-09-16',
  recordedAt: values.observedAt,
  updatedAt: values.observedAt,
  source: 'user',
  method: 'self_report',
  definitionVersion: 'checkin-v1',
};
const headers = {
  cookie: 'session=verified-by-port',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
  'x-workout-session-id': 'session-current',
  'idempotency-key': 'check-in-create-0001',
};
const mutations = [
  { method: 'POST', url: base, payload: { values } },
  { method: 'PUT', url: `${base}/${id}`, payload: { values, expectedRevision: 1, reason: '정정' } },
  { method: 'DELETE', url: `${base}/${id}`, payload: { expectedRevision: 1 } },
] as const;
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const checkIns = {
    createCheckIn: vi.fn<CheckInRepository['createCheckIn']>().mockResolvedValue(result),
    updateCheckIn: vi
      .fn<CheckInRepository['updateCheckIn']>()
      .mockResolvedValue({ ...result, revision: 2, collectionRevision: 2 }),
    deleteCheckIn: vi
      .fn<CheckInRepository['deleteCheckIn']>()
      .mockResolvedValue({ ...result, revision: 2, collectionRevision: 2, deleted: true }),
    getCheckIn: vi.fn<CheckInRepository['getCheckIn']>().mockResolvedValue(null),
    listCheckIns: vi
      .fn<CheckInRepository['listCheckIns']>()
      .mockResolvedValue({ items: [], total: 0, collectionRevision: 0 }),
  };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId,
              sessionId: 'session-current',
              csrfToken: headers['x-csrf-token'],
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    checkIns,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, checkIns };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('check-in authorization and wire contract', () => {
  it('rejects unauthenticated reads and writes before accessing reports', async () => {
    const { app, checkIns } = setup(false);
    for (const request of [{ method: 'GET' as const, url: base }, ...mutations]) {
      expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
    }
    for (const fn of Object.values(checkIns)) expect(fn).not.toHaveBeenCalled();
  });
  it('rejects stale session reads and writes', async () => {
    const { app, checkIns } = setup();
    for (const request of [{ method: 'GET' as const, url: `${base}/${id}` }, ...mutations]) {
      const response = await app.inject({
        ...request,
        headers: { ...headers, 'x-workout-session-id': 'previous-session' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('SESSION_CHANGED');
    }
    for (const fn of Object.values(checkIns)) expect(fn).not.toHaveBeenCalled();
  });
  it.each(mutations)('enforces origin and CSRF for $method', async (request) => {
    const { app, checkIns } = setup();
    for (const override of [{ origin: 'https://foreign.example' }, { 'x-csrf-token': '' }]) {
      expect(
        (await app.inject({ ...request, headers: { ...headers, ...override } })).statusCode,
      ).toBe(403);
    }
    for (const fn of Object.values(checkIns)) expect(fn).not.toHaveBeenCalled();
  });
  it('preserves null versus zero and supplies only authenticated ownership and header idempotency', async () => {
    const { app, checkIns } = setup();
    const response = await app.inject({ ...mutations[0], headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(checkIns.createCheckIn).toHaveBeenCalledWith(athleteId, {
      values,
      idempotencyKey: headers['idempotency-key'],
    });
    checkIns.getCheckIn.mockResolvedValue(entry);
    const read = await app.inject({ url: `${base}/${id}`, headers });
    expect(read.json()).toEqual(entry);
    expect(read.headers['cache-control']).toBe('no-store');
  });
  it('passes revisions and correction reason and returns deletion receipt without health values', async () => {
    const { app, checkIns } = setup();
    expect((await app.inject({ ...mutations[1], headers })).statusCode).toBe(200);
    expect(checkIns.updateCheckIn).toHaveBeenCalledWith(athleteId, id, {
      ...mutations[1].payload,
      idempotencyKey: headers['idempotency-key'],
    });
    const removed = await app.inject({ ...mutations[2], headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ id, revision: 2, collectionRevision: 2, deleted: true });
    expect(checkIns.deleteCheckIn).toHaveBeenCalledWith(athleteId, id, {
      expectedRevision: 1,
      idempotencyKey: headers['idempotency-key'],
    });
  });
  it('bounds local-date listing and applies default paging', async () => {
    const { app, checkIns } = setup();
    expect(
      (await app.inject({ url: `${base}?from=2026-01-01&toExclusive=2026-04-01`, headers }))
        .statusCode,
    ).toBe(200);
    expect(checkIns.listCheckIns).toHaveBeenCalledWith(athleteId, {
      from: '2026-01-01',
      toExclusive: '2026-04-01',
      limit: 50,
      offset: 0,
    });
    for (const query of [
      'from=2026-01-01&toExclusive=2026-04-02',
      'from=2026-01-01&toExclusive=2026-01-01',
      'from=2026-02-30&toExclusive=2026-03-02',
      'from=2026-01-01&toExclusive=2026-01-02&limit=101',
      'from=2026-01-01&toExclusive=2026-01-02&athleteId=other',
    ])
      expect((await app.inject({ url: `${base}?${query}`, headers })).statusCode).toBe(400);
    expect(checkIns.listCheckIns).toHaveBeenCalledTimes(1);
  });
  it('rejects client provenance, tenant, embedded key, malformed reports and unbounded body', async () => {
    const { app, checkIns } = setup();
    for (const payload of [
      { values, athleteId: 'other' },
      { values, source: 'device' },
      { values, idempotencyKey: 'client-body-key' },
      { values: { ...values, definitionVersion: 'custom' } },
      { values: { ...values, discomfort: null } },
      { values: { ...values, fatigue: 11 } },
      { values: { ...values, note: 'x'.repeat(2001) } },
    ])
      expect((await app.inject({ method: 'POST', url: base, headers, payload })).statusCode).toBe(
        400,
      );
    expect(
      (await app.inject({ ...mutations[0], headers: { ...headers, 'idempotency-key': '' } }))
        .statusCode,
    ).toBe(400);
    expect(checkIns.createCheckIn).not.toHaveBeenCalled();
  });
  it('validates paths and read queries, and returns sanitized missing resource response', async () => {
    const { app, checkIns } = setup();
    expect((await app.inject({ url: `${base}/not-uuid`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: `${base}/${id}?athleteId=other`, headers })).statusCode).toBe(
      400,
    );
    expect(checkIns.getCheckIn).not.toHaveBeenCalled();
    expect((await app.inject({ url: `${base}/${id}`, headers })).statusCode).toBe(404);
    expect(checkIns.getCheckIn).toHaveBeenCalledWith(athleteId, id);
  });
  it('maps repository conflicts and future observations to safe error codes', async () => {
    const { app, checkIns } = setup();
    for (const code of ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT'] as const) {
      checkIns.createCheckIn.mockRejectedValueOnce(new PersistenceConflict(code));
      const response = await app.inject({ ...mutations[0], headers });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(code);
    }
    checkIns.createCheckIn.mockRejectedValueOnce(new CheckInValidationError());
    const future = await app.inject({ ...mutations[0], headers });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('OBSERVED_AT_IN_FUTURE');
    checkIns.updateCheckIn.mockRejectedValueOnce(new CheckInNotFound());
    expect((await app.inject({ ...mutations[1], headers })).statusCode).toBe(404);
    checkIns.deleteCheckIn.mockRejectedValueOnce(new CheckInNotFound());
    expect((await app.inject({ ...mutations[2], headers })).statusCode).toBe(404);
  });
});
