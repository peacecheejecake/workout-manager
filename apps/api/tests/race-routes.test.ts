import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RaceEventValues,
  RaceResultValues,
  TrainingBestValues,
} from '@workout/contracts/race-commands';
import {
  RaceRepositoryError,
  createRaceRepository,
  type RaceRepository,
} from '@workout/server-persistence/races';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { migrate, grantRaces, grantOperations } from '@workout/server-persistence/migrate';
import { createApi } from '../src/app.js';
const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const csrfToken = 'c'.repeat(43);
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
  'idempotency-key': 'race_command_0001',
};
const collection = { revision: 1, privacyGeneration: '0' };
const cursor = { kind: 'race-event' as const, collection, afterId: entityId };
const instances: ReturnType<typeof createApi>[] = [];
const logLines: string[] = [];
function eventValues(): RaceEventValues {
  return {
    title: 'Synthetic race',
    localDate: '2026-10-04',
    localStartTime: null,
    timezone: 'Asia/Seoul',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: null,
  };
}
function resultValues(): RaceResultValues {
  return {
    kind: 'race-result',
    raceEventId: null,
    localDate: '2026-10-04',
    timezone: 'Asia/Seoul',
    source: {
      kind: 'official',
      authority: 'Synthetic authority',
      resultUrl: 'https://example.org/private-result',
    },
    chipSeconds: 0,
    gunSeconds: null,
    officialDistanceMeters: null,
    deviceDistanceMeters: 10042,
    linkedActivityId: null,
    weatherNote: 'Synthetic private note',
  };
}
function bestValues(): TrainingBestValues {
  return {
    kind: 'training-best',
    observedAt: '2026-10-03T08:00:00+09:00',
    source: { kind: 'manual' },
    basis: 'user-entered',
    distanceMeters: null,
    elapsedSeconds: 0,
  };
}

function mockRepository() {
  const event = { ...eventValues(), id: entityId, revision: 1 };
  const result = {
    ...resultValues(),
    id: entityId,
    revision: 1,
    source: {
      ...resultValues().source,
      kind: 'official' as const,
      authority: 'Synthetic authority',
      resultUrl: 'https://example.org/private-result',
      verifiedAt: null,
    },
  };
  const best = { ...bestValues(), id: entityId, revision: 1 };
  const receipt = { id: entityId, revision: 1 };
  return {
    createRaceEvent: vi.fn<RaceRepository['createRaceEvent']>(async () => receipt),
    updateRaceEvent: vi.fn<RaceRepository['updateRaceEvent']>(async () => receipt),
    deleteRaceEvent: vi.fn<RaceRepository['deleteRaceEvent']>(async (_athlete, id, command) => ({
      id,
      revision: Math.min(command.expectedRevision + 1, 2147483647),
    })),
    getRaceEvent: vi.fn<RaceRepository['getRaceEvent']>(async () => event),
    listRaceEvents: vi.fn<RaceRepository['listRaceEvents']>(async () => ({
      schemaVersion: 1,
      kind: 'race-event',
      sort: 'id-asc',
      collection,
      items: [event],
      nextCursor: null,
    })),
    createRaceResult: vi.fn<RaceRepository['createRaceResult']>(async () => receipt),
    updateRaceResult: vi.fn<RaceRepository['updateRaceResult']>(async () => receipt),
    deleteRaceResult: vi.fn<RaceRepository['deleteRaceResult']>(async (_athlete, id, command) => ({
      id,
      revision: Math.min(command.expectedRevision + 1, 2147483647),
    })),
    getRaceResult: vi.fn<RaceRepository['getRaceResult']>(async () => result),
    listRaceResults: vi.fn<RaceRepository['listRaceResults']>(async () => ({
      schemaVersion: 1,
      kind: 'race-result',
      sort: 'id-asc',
      collection,
      items: [result],
      nextCursor: null,
    })),
    createTrainingBest: vi.fn<RaceRepository['createTrainingBest']>(async () => receipt),
    updateTrainingBest: vi.fn<RaceRepository['updateTrainingBest']>(async () => receipt),
    deleteTrainingBest: vi.fn<RaceRepository['deleteTrainingBest']>(
      async (_athlete, id, command) => ({
        id,
        revision: Math.min(command.expectedRevision + 1, 2147483647),
      }),
    ),
    getTrainingBest: vi.fn<RaceRepository['getTrainingBest']>(async () => best),
    listTrainingBests: vi.fn<RaceRepository['listTrainingBests']>(async () => ({
      schemaVersion: 1,
      kind: 'training-best',
      sort: 'id-asc',
      collection,
      items: [best],
      nextCursor: null,
    })),
  } satisfies RaceRepository;
}
function setup(authenticated = true, override?: RaceRepository, tenant = athleteId) {
  const races = mockRepository();
  const app = createApi({
    auth: {
      authenticate: async (credentials) =>
        !authenticated
          ? null
          : credentials.cookie === 'session=fixture'
            ? { athleteId: tenant, sessionId: 'current', csrfToken, method: 'cookie' }
            : credentials.authorization === 'Bearer fixture'
              ? { athleteId: tenant, sessionId: 'current', method: 'bearer' }
              : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    races: override ?? races,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(chunk, _encoding, done) {
        logLines.push(String(chunk));
        done();
      },
    }),
  });
  instances.push(app);
  return { app, races };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
  const logged = logLines.splice(0).join('');
  for (const privateValue of [
    csrfToken,
    'session=fixture',
    'Synthetic private note',
    'https://example.org/private-result',
  ])
    expect(logged).not.toContain(privateValue);
});
const families = [
  {
    path: '/races',
    kind: 'race-event',
    values: eventValues(),
    create: 'createRaceEvent',
    update: 'updateRaceEvent',
    remove: 'deleteRaceEvent',
    get: 'getRaceEvent',
    list: 'listRaceEvents',
  },
  {
    path: '/race-results',
    kind: 'race-result',
    values: resultValues(),
    create: 'createRaceResult',
    update: 'updateRaceResult',
    remove: 'deleteRaceResult',
    get: 'getRaceResult',
    list: 'listRaceResults',
  },
  {
    path: '/training-bests',
    kind: 'training-best',
    values: bestValues(),
    create: 'createTrainingBest',
    update: 'updateTrainingBest',
    remove: 'deleteTrainingBest',
    get: 'getTrainingBest',
    list: 'listTrainingBests',
  },
] as const;
describe('race HTTP boundaries with repository fixtures', () => {
  it.each(families)(
    'reads/lists/creates/updates $path with authenticated ownership and minimal receipts',
    async (family) => {
      const { app, races } = setup();
      const url = `/bff/v1${family.path}`;
      const listed = await app.inject({ url, headers });
      expect(listed.statusCode).toBe(200);
      expect(races[family.list]).toHaveBeenCalledWith(athleteId, { limit: 50, cursor: null });
      expect(listed.json()).toMatchObject({ kind: family.kind, sort: 'id-asc', collection });
      const read = await app.inject({ url: `${url}/${entityId.toUpperCase()}`, headers });
      expect(read.statusCode).toBe(200);
      expect(races[family.get]).toHaveBeenCalledWith(athleteId, entityId);
      const created = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { values: family.values },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: entityId, revision: 1 });
      expect(races[family.create]).toHaveBeenCalledWith(athleteId, {
        values: family.values,
        idempotencyKey: headers['idempotency-key'],
      });
      const updated = await app.inject({
        method: 'PATCH',
        url: `${url}/${entityId}`,
        headers,
        payload: { expectedRevision: 1, values: family.values },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ id: entityId, revision: 1 });
      expect(races[family.update]).toHaveBeenCalledWith(athleteId, entityId, {
        expectedRevision: 1,
        values: family.values,
        idempotencyKey: headers['idempotency-key'],
      });
      for (const response of [listed, read, created, updated]) {
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers['etag']).toBeUndefined();
      }
    },
  );
  it.each(families)(
    'runs global authentication and CSRF before any $path repository call',
    async (family) => {
      const { app, races } = setup(false);
      const url = `/bff/v1${family.path}`;
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const response = await app.inject({
          method,
          url: method === 'PATCH' || method === 'DELETE' ? `${url}/${entityId}` : url,
          headers,
          ...(method === 'GET' ? {} : { payload: { values: family.values, expectedRevision: 1 } }),
        });
        expect(response.statusCode).toBe(401);
      }
      for (const fn of Object.values(races)) expect(fn).not.toHaveBeenCalled();
      const protectedSetup = setup();
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
        const response = await protectedSetup.app.inject({
          method,
          url: method === 'PATCH' || method === 'DELETE' ? `${url}/${entityId}` : url,
          headers: { ...headers, 'x-csrf-token': 'wrong' },
          payload: { values: family.values, expectedRevision: 1 },
        });
        expect(response.statusCode).toBe(403);
      }
      for (const fn of Object.values(protectedSetup.races)) expect(fn).not.toHaveBeenCalled();
    },
  );
  it('preserves session freshness and bearer semantics from the global auth plugin', async () => {
    const { app, races } = setup();
    expect(
      (
        await app.inject({
          url: '/bff/v1/races',
          headers: { ...headers, 'x-workout-session-id': 'old' },
        })
      ).statusCode,
    ).toBe(409);
    expect(races.listRaceEvents).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/races',
          headers: { authorization: 'Bearer fixture', 'idempotency-key': 'bearer_key_0001' },
          payload: { values: eventValues() },
        })
      ).statusCode,
    ).toBe(201);
    expect(races.createRaceEvent).toHaveBeenCalledWith(athleteId, {
      idempotencyKey: 'bearer_key_0001',
      values: eventValues(),
    });
  });
  it.each(families)(
    'rejects body ownership, receipt keys, unknown fields and invalid CAS on $path',
    async (family) => {
      const { app, races } = setup();
      const url = `/bff/v1${family.path}`;
      for (const payload of [
        { values: family.values, athleteId: 'foreign' },
        { values: family.values, idempotencyKey: 'body_key_0001' },
        { values: { ...family.values, id: entityId } },
        { values: { ...family.values, revision: 1 } },
      ]) {
        expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
      }
      for (const expectedRevision of [0, 2147483647, 1.5])
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `${url}/${entityId}`,
              headers,
              payload: { values: family.values, expectedRevision },
            })
          ).statusCode,
        ).toBe(400);
      expect(races[family.create]).not.toHaveBeenCalled();
      expect(races[family.update]).not.toHaveBeenCalled();
    },
  );
  it('rejects every client official verification value and keeps manual/device source keys separate', async () => {
    const { app, races } = setup();
    for (const source of [
      { ...resultValues().source, verifiedAt: null },
      { ...resultValues().source, verifiedAt: '2026-10-06T00:00:00Z' },
      { kind: 'manual', authority: 'Injected' },
      { kind: 'device', providerLabel: 'Synthetic device', verifiedAt: null },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/bff/v1/race-results',
            headers,
            payload: { values: { ...resultValues(), source } },
          })
        ).statusCode,
      ).toBe(400);
    expect(races.createRaceResult).not.toHaveBeenCalled();
  });
  it('bounds and strictly decodes list queries before calling the repository', async () => {
    const { app, races } = setup();
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=01',
      'limit=1&limit=2',
      'athleteId=foreign',
      'cursor=%7B',
      'cursor=' + encodeURIComponent('x'.repeat(2049)),
      ...[
        '[]',
        '{}',
        '0',
        JSON.stringify({ ...cursor, athleteId: 'foreign' }),
        JSON.stringify({ ...cursor, collection: { revision: 1, privacyGeneration: '01' } }),
      ].map((value) => 'cursor=' + encodeURIComponent(value)),
    ]) {
      const response = await app.inject({ url: '/bff/v1/races?' + query, headers });
      expect(response.statusCode).toBe(400);
    }
    expect(races.listRaceEvents).not.toHaveBeenCalled();
    const response = await app.inject({
      url: '/bff/v1/races?limit=1&cursor=' + encodeURIComponent(JSON.stringify(cursor)),
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(races.listRaceEvents).toHaveBeenCalledWith(athleteId, { limit: 1, cursor });
  });
  it('rejects malformed UUIDs, unexpected read/write queries, missing/oversized keys and oversized bodies', async () => {
    const { app, races } = setup();
    expect((await app.inject({ url: '/bff/v1/races/invalid', headers })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: `/bff/v1/races/${entityId}?limit=1`, headers })).statusCode,
    ).toBe(400);
    for (const key of ['', 'x'.repeat(129), 'invalid.key'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/bff/v1/races',
            headers: { ...headers, 'idempotency-key': key },
            payload: { values: eventValues() },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/races?limit=1',
          headers,
          payload: { values: eventValues() },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/races',
          headers,
          payload: { values: { ...eventValues(), title: 'x'.repeat(17000) } },
        })
      ).statusCode,
    ).toBe(413);
    expect(races.getRaceEvent).not.toHaveBeenCalled();
    expect(races.createRaceEvent).not.toHaveBeenCalled();
  });
  it.each([
    ['RACE_CURSOR_STALE', 409],
    ['RACE_CURSOR_KIND_MISMATCH', 409],
    ['RACE_CURSOR_UNAVAILABLE', 404],
    ['RACE_REFERENCE_UNAVAILABLE', 404],
    ['RACE_PLAN_IMPACT_REQUIRED', 409],
    ['RACE_REVISION_LIMIT', 409],
    ['RACE_NOT_FOUND', 404],
  ] as const)('maps %s without exposing domain private values', async (code, status) => {
    const { app, races } = setup();
    races.listRaceEvents.mockRejectedValue(new RaceRepositoryError(code));
    const response = await app.inject({ url: '/bff/v1/races', headers });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
  });
  it.each(['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT'] as const)(
    'keeps persistence %s distinct',
    async (code) => {
      const { app, races } = setup();
      races.updateRaceEvent.mockRejectedValue(new PersistenceConflict(code));
      const response = await app.inject({
        method: 'PATCH',
        url: `/bff/v1/races/${entityId}`,
        headers,
        payload: { expectedRevision: 1, values: eventValues() },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code } });
    },
  );
  it('returns missing records as404 and sanitizes invalid server outputs as500', async () => {
    const { app, races } = setup();
    races.getRaceEvent.mockResolvedValueOnce(null);
    expect((await app.inject({ url: `/bff/v1/races/${entityId}`, headers })).statusCode).toBe(404);
    races.getRaceEvent.mockResolvedValueOnce({
      ...eventValues(),
      id: entityId,
      revision: 1,
      title: '<script>Synthetic private note</script>',
    });
    const invalid = await app.inject({ url: `/bff/v1/races/${entityId}`, headers });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(invalid.body).not.toContain('Synthetic private note');
    races.createRaceEvent.mockResolvedValueOnce({ id: entityId, revision: 0 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/races',
          headers,
          payload: { values: eventValues() },
        })
      ).statusCode,
    ).toBe(500);
    races.listRaceEvents.mockResolvedValueOnce({
      schemaVersion: 1,
      kind: 'race-event',
      sort: 'id-asc',
      collection: null,
      items: [{ ...eventValues(), id: entityId, revision: 1 }],
      nextCursor: null,
    });
    expect((await app.inject({ url: '/bff/v1/races', headers })).statusCode).toBe(500);
  });
});

describe('race DELETE HTTP boundaries with repository fixtures', () => {
  it.each(families)(
    'deletes $path under authenticated owner with minimal terminal-capable receipt',
    async (family) => {
      const { app, races } = setup();
      for (const expectedRevision of [1, 2147483647]) {
        const response = await app.inject({
          method: 'DELETE',
          url: `/bff/v1${family.path}/${entityId.toUpperCase()}`,
          headers,
          payload: { expectedRevision },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          id: entityId,
          revision: Math.min(expectedRevision + 1, 2147483647),
        });
        expect(races[family.remove]).toHaveBeenLastCalledWith(athleteId, entityId, {
          expectedRevision,
          idempotencyKey: headers['idempotency-key'],
        });
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers['etag']).toBeUndefined();
      }
      expect(races[family.create]).not.toHaveBeenCalled();
      expect(races[family.update]).not.toHaveBeenCalled();
    },
  );
  it.each(families)(
    'validates DELETE $path headers/body/query/params before repository work',
    async (family) => {
      const { app, races } = setup();
      const url = `/bff/v1${family.path}/${entityId}`;
      for (const payload of [
        {},
        { expectedRevision: 0 },
        { expectedRevision: 2147483648 },
        { expectedRevision: 1.5 },
        { expectedRevision: '1' },
        { expectedRevision: 1, athleteId: 'foreign' },
        { expectedRevision: 1, idempotencyKey: 'body_key_0001' },
        { expectedRevision: 1, values: family.values },
      ])
        expect((await app.inject({ method: 'DELETE', url, headers, payload })).statusCode).toBe(
          400,
        );
      expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(400);
      for (const key of ['', 'x'.repeat(129), 'invalid.key'])
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url,
              headers: { ...headers, 'idempotency-key': key },
              payload: { expectedRevision: 1 },
            })
          ).statusCode,
        ).toBe(400);
      const { 'idempotency-key': _removed, ...missingKeyHeaders } = headers;
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url,
            headers: missingKeyHeaders,
            payload: { expectedRevision: 1 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: url + '?athleteId=foreign',
            headers,
            payload: { expectedRevision: 1 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/bff/v1${family.path}/invalid`,
            headers,
            payload: { expectedRevision: 1 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url,
            headers,
            payload: { expectedRevision: 1, privateNote: 'Synthetic private note'.repeat(1000) },
          })
        ).statusCode,
      ).toBe(413);
      expect(races[family.remove]).not.toHaveBeenCalled();
    },
  );
  it.each(families)(
    'hides foreign/absent $path deletion and exposes only authenticated owner to repository',
    async (family) => {
      const tenant = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const { app, races } = setup(true, undefined, tenant);
      races[family.remove].mockRejectedValue(new RaceRepositoryError('RACE_NOT_FOUND'));
      const response = await app.inject({
        method: 'DELETE',
        url: `/bff/v1${family.path}/${entityId}`,
        headers,
        payload: { expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'RACE_NOT_FOUND' } });
      expect(races[family.remove]).toHaveBeenCalledWith(tenant, entityId, {
        expectedRevision: 1,
        idempotencyKey: headers['idempotency-key'],
      });
    },
  );
  it.each(['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT'] as const)(
    'keeps DELETE %s stable and sanitized',
    async (code) => {
      const { app, races } = setup();
      races.deleteRaceEvent.mockRejectedValue(new PersistenceConflict(code));
      const response = await app.inject({
        method: 'DELETE',
        url: `/bff/v1/races/${entityId}`,
        headers,
        payload: { expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code } });
      expect(response.headers['cache-control']).toBe('private, no-store');
    },
  );
  it('preserves global cookie CSRF/origin/session gates and bearer deletion semantics', async () => {
    const { app, races } = setup();
    for (const overrides of [{ 'x-csrf-token': 'wrong' }, { origin: 'https://foreign.example' }]) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/bff/v1/races/${entityId}`,
        headers: { ...headers, ...overrides },
        payload: { expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/bff/v1/races/${entityId}`,
          headers: { ...headers, 'x-workout-session-id': 'old' },
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(races.deleteRaceEvent).not.toHaveBeenCalled();
    const bearer = await app.inject({
      method: 'DELETE',
      url: `/bff/v1/races/${entityId}`,
      headers: { authorization: 'Bearer fixture', 'idempotency-key': 'delete_bearer_0001' },
      payload: { expectedRevision: 1 },
    });
    expect(bearer.statusCode).toBe(200);
    expect(races.deleteRaceEvent).toHaveBeenCalledWith(athleteId, entityId, {
      expectedRevision: 1,
      idempotencyKey: 'delete_bearer_0001',
    });
  });
  it('rejects invalid or mismatched DELETE server receipts and sanitizes private failures in responses/logs', async () => {
    const { app, races } = setup();
    for (const receipt of [
      { id: entityId, revision: 0 },
      { id: randomUUID(), revision: 2 },
    ]) {
      races.deleteRaceEvent.mockResolvedValueOnce(receipt);
      const response = await app.inject({
        method: 'DELETE',
        url: `/bff/v1/races/${entityId}`,
        headers,
        payload: { expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    }
    races.deleteRaceEvent.mockRejectedValueOnce(
      new Error('Synthetic private note https://example.org/private-result'),
    );
    const failed = await app.inject({
      method: 'DELETE',
      url: `/bff/v1/races/${entityId}`,
      headers,
      payload: { expectedRevision: 1 },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(failed.body).not.toContain('Synthetic private note');
    expect(failed.body).not.toContain('https://example.org/private-result');
  });
});

// This block runs only in the separately invoked ephemeral PostgreSQL harness.
// Unit fixture results above are not evidence of DB transactions or real OIDC.
describe.skipIf(!process.env['TEST_DATABASE_ADMIN_URL'] || !process.env['TEST_DATABASE_URL'])(
  'race HTTP with actual PostgreSQL',
  () => {
    let admin: Pool;
    let database: Database;
    let repository: RaceRepository;
    beforeAll(async () => {
      const adminUrl = z.string().parse(process.env['TEST_DATABASE_ADMIN_URL']);
      admin = new Pool({ connectionString: adminUrl });
      await migrate(adminUrl);
      await grantOperations(adminUrl, 'workout_runtime');
      await grantRaces(adminUrl, 'workout_runtime');
      await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO workout_runtime');
      database = createDatabase({
        connectionString: z.string().parse(process.env['TEST_DATABASE_URL']),
      });
      repository = createRaceRepository(database);
    });
    afterAll(async () => {
      await database?.close();
      await admin?.end();
    });
    it('executes all three families through tenant RLS, exact receipts, CAS, reads and lists', async () => {
      const tenant = randomUUID(),
        other = randomUUID(),
        { app } = setup(true, repository, tenant),
        foreign = setup(true, repository, other).app;
      for (const family of families) {
        const url = `/bff/v1${family.path}`,
          key = randomUUID(),
          commandHeaders = { ...headers, 'idempotency-key': key };
        const created = await app.inject({
          method: 'POST',
          url,
          headers: commandHeaders,
          payload: { values: family.values },
        });
        expect(created.statusCode).toBe(201);
        const receipt = z.object({ id: z.uuid(), revision: z.number() }).parse(created.json());
        expect(receipt.revision).toBe(1);
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: commandHeaders,
              payload: { values: family.values },
            })
          ).json(),
        ).toEqual(receipt);
        expect((await foreign.inject({ url: `${url}/${receipt.id}`, headers })).statusCode).toBe(
          404,
        );
        const foreignList = await foreign.inject({ url, headers });
        expect(foreignList.statusCode).toBe(200);
        expect(foreignList.json()).toMatchObject({ collection: null, items: [] });
        const listed = await app.inject({ url, headers });
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toMatchObject({
          collection: { revision: 1, privacyGeneration: '0' },
          items: [{ id: receipt.id, revision: 1 }],
        });
        const conflicting = await app.inject({
          method: 'PATCH',
          url: `${url}/${receipt.id}`,
          headers: commandHeaders,
          payload: { expectedRevision: 1, values: family.values },
        });
        expect(conflicting.statusCode).toBe(409);
        expect(conflicting.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
        const corrected = await app.inject({
          method: 'PATCH',
          url: `${url}/${receipt.id}`,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { expectedRevision: 1, values: family.values },
        });
        expect(corrected.statusCode).toBe(200);
        expect(corrected.json()).toEqual({ id: receipt.id, revision: 2 });
        const stale = await app.inject({
          method: 'PATCH',
          url: `${url}/${receipt.id}`,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { expectedRevision: 1, values: family.values },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
        const read = await app.inject({ url: `${url}/${receipt.id}`, headers });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toMatchObject({ id: receipt.id, revision: 2 });
        expect(read.json()).toMatchObject(family.values);
        if (family.kind === 'race-result')
          expect(read.json()).toMatchObject({
            chipSeconds: 0,
            gunSeconds: null,
            source: { kind: 'official', verifiedAt: null },
          });
        const oldCursor = {
          kind: family.kind,
          collection: { revision: 1, privacyGeneration: '0' },
          afterId: receipt.id,
        };
        const oldPage = await app.inject({
          url: url + '?cursor=' + encodeURIComponent(JSON.stringify(oldCursor)),
          headers,
        });
        expect(oldPage.statusCode).toBe(409);
        expect(oldPage.json()).toMatchObject({ error: { code: 'RACE_CURSOR_STALE' } });
      }
    });
    it.each(families)(
      'deletes $path through actual HTTP/RLS/CAS/receipts while preserving linked Plan and Activity',
      async (family) => {
        const tenant = randomUUID(),
          other = randomUUID(),
          planId = randomUUID(),
          activityId = randomUUID();
        for (const athlete of [tenant, other])
          await admin.query(
            "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic-api.test',$2)",
            [athlete, randomUUID()],
          );
        await admin.query(
          'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,\'{"fixture":"Synthetic API plan"}\')',
          [tenant, planId],
        );
        await admin.query(
          'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,\'{"title":"Synthetic API activity"}\')',
          [tenant, activityId],
        );
        const unchangedSql =
          'SELECT (SELECT row_to_json(p) FROM plan_snapshot p WHERE athlete_id=$1 AND id=$2) AS plan,(SELECT row_to_json(a) FROM activity_canonical a WHERE athlete_id=$1 AND id=$3) AS activity';
        const baseline = await admin.query(unchangedSql, [tenant, planId, activityId]);
        const linkedValues =
          family.kind === 'race-event'
            ? { ...eventValues(), planVersionId: planId }
            : family.kind === 'race-result'
              ? { ...resultValues(), linkedActivityId: activityId }
              : { ...bestValues(), source: { kind: 'activity', activityId } };
        const { app } = setup(true, repository, tenant),
          foreign = setup(true, repository, other).app;
        const url = `/bff/v1${family.path}`;
        const created = await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { values: linkedValues },
        });
        expect(created.statusCode).toBe(201);
        const receipt = z
          .object({ id: z.uuid(), revision: z.number().int() })
          .parse(created.json());
        const targetUrl = `${url}/${receipt.id}`;
        const correction = await app.inject({
          method: 'PATCH',
          url: targetUrl,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { expectedRevision: 1, values: linkedValues },
        });
        expect(correction.statusCode).toBe(200);
        expect(correction.json()).toEqual({ id: receipt.id, revision: 2 });
        const commandHeaders = { ...headers, 'idempotency-key': randomUUID() };
        for (const id of [receipt.id, randomUUID()]) {
          const hidden = await foreign.inject({
            method: 'DELETE',
            url: `${url}/${id}`,
            headers: commandHeaders,
            payload: { expectedRevision: 2 },
          });
          expect(hidden.statusCode).toBe(404);
          expect(hidden.json()).toMatchObject({ error: { code: 'RACE_NOT_FOUND' } });
        }
        const stale = await app.inject({
          method: 'DELETE',
          url: targetUrl,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { expectedRevision: 1 },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
        expect((await app.inject({ url: targetUrl, headers })).json()).toMatchObject({
          revision: 2,
        });
        const command = {
          method: 'DELETE' as const,
          url: targetUrl,
          headers: commandHeaders,
          payload: { expectedRevision: 2 },
        };
        const deleted = await app.inject(command);
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ id: receipt.id, revision: 3 });
        expect(deleted.headers['cache-control']).toBe('private, no-store');
        const repeat = await app.inject(command);
        expect(repeat.statusCode).toBe(200);
        expect(repeat.json()).toEqual(deleted.json());
        const mismatch = await app.inject({ ...command, payload: { expectedRevision: 3 } });
        expect(mismatch.statusCode).toBe(409);
        expect(mismatch.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
        const newDeletion = await app.inject({
          ...command,
          headers: { ...headers, 'idempotency-key': randomUUID() },
        });
        expect(newDeletion.statusCode).toBe(404);
        expect(newDeletion.json()).toMatchObject({ error: { code: 'RACE_NOT_FOUND' } });
        expect((await app.inject({ url: targetUrl, headers })).statusCode).toBe(404);
        const listed = await app.inject({ url, headers });
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toMatchObject({
          items: [],
          collection: { revision: 3, privacyGeneration: '1' },
        });
        const table = family.kind.replaceAll('-', '_');
        await database.tenant(tenant, async (tx) => {
          const current = await tx.query(
            `SELECT revision,deleted,values_json FROM ${table} WHERE athlete_id=$1 AND id=$2`,
            [tenant, receipt.id],
          );
          expect(current.rows).toEqual([{ revision: 3, deleted: true, values_json: null }]);
          const history = await tx.query(
            `SELECT count(*)::int AS count FROM ${table}_revision WHERE athlete_id=$1 AND entity_id=$2`,
            [tenant, receipt.id],
          );
          expect(history.rows).toEqual([{ count: 0 }]);
          const storedReceipt = await tx.query(
            'SELECT result FROM race_command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
            [tenant, commandHeaders['idempotency-key']],
          );
          expect(storedReceipt.rows).toEqual([{ result: { id: receipt.id, revision: 3 } }]);
        });
        const events = await admin.query(
          'SELECT count(*)::int AS count FROM restore_suppression_event WHERE athlete_id=$1 AND target_id=$2 AND record_version=4',
          [tenant, receipt.id],
        );
        expect(events.rows).toEqual([{ count: 1 }]);
        const outbox = await admin.query(
          "SELECT count(*)::int AS count FROM outbox WHERE athlete_id=$1 AND topic='race.entity_deleted' AND payload->>'id'=$2",
          [tenant, receipt.id],
        );
        expect(outbox.rows).toEqual([{ count: 1 }]);
        expect((await admin.query(unchangedSql, [tenant, planId, activityId])).rows).toEqual(
          baseline.rows,
        );
      },
    );
    it('forwards actual Plan impact and reference failures without writing linked plans', async () => {
      const tenant = randomUUID(),
        { app } = setup(true, repository, tenant),
        planId = randomUUID();
      await admin.query(
        "INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,'{}')",
        [tenant, planId],
      );
      const created = await app.inject({
        method: 'POST',
        url: '/bff/v1/races',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { values: { ...eventValues(), planVersionId: planId } },
      });
      expect(created.statusCode).toBe(201);
      const receipt = z.object({ id: z.uuid(), revision: z.number() }).parse(created.json());
      const rejected = await app.inject({
        method: 'PATCH',
        url: `/bff/v1/races/${receipt.id}`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: {
          expectedRevision: 1,
          values: { ...eventValues(), localDate: '2026-10-05', planVersionId: planId },
        },
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ error: { code: 'RACE_PLAN_IMPACT_REQUIRED' } });
      const unavailable = await app.inject({
        method: 'POST',
        url: '/bff/v1/race-results',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { values: { ...resultValues(), linkedActivityId: randomUUID() } },
      });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.json()).toMatchObject({ error: { code: 'RACE_REFERENCE_UNAVAILABLE' } });
      const plans = await admin.query(
        'SELECT version,draft FROM plan_snapshot WHERE athlete_id=$1',
        [tenant],
      );
      expect(plans.rows).toEqual([{ version: 1, draft: {} }]);
      const current = await app.inject({ url: `/bff/v1/races/${receipt.id}`, headers });
      expect(current.json()).toMatchObject({ revision: 1, localDate: '2026-10-04' });
    });
  },
);
