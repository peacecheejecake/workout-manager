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
    get: 'getRaceEvent',
    list: 'listRaceEvents',
  },
  {
    path: '/race-results',
    kind: 'race-result',
    values: resultValues(),
    create: 'createRaceResult',
    update: 'updateRaceResult',
    get: 'getRaceResult',
    list: 'listRaceResults',
  },
  {
    path: '/training-bests',
    kind: 'training-best',
    values: bestValues(),
    create: 'createTrainingBest',
    update: 'updateTrainingBest',
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
      for (const method of ['GET', 'POST', 'PATCH'] as const) {
        const response = await app.inject({
          method,
          url: method === 'PATCH' ? `${url}/${entityId}` : url,
          headers,
          ...(method === 'GET' ? {} : { payload: { values: family.values, expectedRevision: 1 } }),
        });
        expect(response.statusCode).toBe(401);
      }
      for (const fn of Object.values(races)) expect(fn).not.toHaveBeenCalled();
      const protectedSetup = setup();
      for (const method of ['POST', 'PATCH'] as const) {
        const response = await protectedSetup.app.inject({
          method,
          url: method === 'PATCH' ? `${url}/${entityId}` : url,
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
