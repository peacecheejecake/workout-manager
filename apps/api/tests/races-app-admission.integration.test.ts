import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { migrate, grantOperations, grantRaces } from '@workout/server-persistence/migrate';
import { createRaceRepository } from '@workout/server-persistence/races';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { createOperationsRepository } from '@workout/server-persistence/operations';
import { raceCommandResultSchema } from '@workout/contracts/race-commands';
import { createApi } from '../src/app.js';

const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const runtimeUrl = z.string().min(1).parse(process.env['TEST_DATABASE_URL']);
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const csrfToken = 's'.repeat(43),
  cookie = 'session=synthetic-race-admission';
const headers = {
  cookie,
  origin: 'https://workout.example',
  'x-workout-session-id': 'synthetic-current',
  'x-csrf-token': csrfToken,
};
const writeHeaders = () => ({ ...headers, 'idempotency-key': randomUUID() });
const apps: ReturnType<typeof createApi>[] = [];
const logs: string[] = [];
/** Only authentication is a bounded synthetic fixture. Every race/consent/operations
 * service below is the existing repository running real transactions/RLS. This does
 * not establish OIDC login; the separate identity E2E suite owns that acceptance. */
function setup(athleteId: string, db: Database = database) {
  const app = createApi({
    auth: {
      authenticate: async (credentials) =>
        credentials.cookie === cookie
          ? { athleteId, sessionId: 'synthetic-current', csrfToken, method: 'cookie' }
          : null,
    },
    consent: createConsentRepository(db),
    races: createRaceRepository(db),
    operations: createOperationsRepository(db),
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk));
        done();
      },
    }),
  });
  apps.push(app);
  return app;
}
const families = [
  {
    path: '/races',
    values: {
      title: 'Synthetic admission private title',
      localDate: '2080-01-03',
      localStartTime: null,
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'considering',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  },
  {
    path: '/race-results',
    values: {
      kind: 'race-result',
      raceEventId: null,
      localDate: '2080-01-03',
      timezone: 'UTC',
      source: {
        kind: 'official',
        authority: 'Synthetic private authority',
        resultUrl: 'https://example.invalid/synthetic-private-result',
      },
      chipSeconds: 0,
      gunSeconds: null,
      officialDistanceMeters: null,
      deviceDistanceMeters: null,
      linkedActivityId: null,
      weatherNote: 'Synthetic private note',
    },
  },
  {
    path: '/training-bests',
    values: {
      kind: 'training-best',
      observedAt: '2080-01-03T00:00:00+09:00',
      source: { kind: 'manual' },
      basis: 'user-entered',
      distanceMeters: null,
      elapsedSeconds: 0,
    },
  },
];
const tables = [
  'race_event',
  'race_event_revision',
  'race_result',
  'race_result_revision',
  'training_best',
  'training_best_revision',
  'race_command_receipt',
  'race_collection_head',
  'outbox',
];
async function facts(athlete: string) {
  const state: Record<string, unknown> = {};
  for (const table of tables)
    state[table] = (
      await admin.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE athlete_id=$1 ORDER BY to_jsonb(t)::text`,
        [athlete],
      )
    ).rows;
  return state;
}
async function consent(app: ReturnType<typeof createApi>, granted: boolean) {
  const head = await app.inject({ url: '/bff/v1/consents/app', headers });
  expect(head.statusCode).toBe(200);
  const current = z.object({ revision: z.number().int() }).parse(head.json());
  const response = await app.inject({
    method: 'PUT',
    url: '/bff/v1/consents/app',
    headers: writeHeaders(),
    payload: { granted, expectedRevision: current.revision },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ kind: 'app', granted });
}
async function absence(athlete: string) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query("DELETE FROM consent WHERE athlete_id=$1 AND kind='app'", [athlete]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantRaces(adminUrl, 'workout_runtime');
  // Minimum existing consent command privileges, scoped by its unchanged tenant RLS.
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent,outbox TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON command_receipt TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  expect(
    (
      await admin.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='workout_runtime'",
      )
    ).rows,
  ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  const emitted = logs.splice(0).join('');
  for (const privateValue of [
    cookie,
    csrfToken,
    'Synthetic admission private title',
    'Synthetic private authority',
    'Synthetic private note',
    'https://example.invalid/synthetic-private-result',
    runtimeUrl,
  ])
    expect(emitted).not.toContain(privateValue);
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
describe('race app admission HTTP + actual restricted PostgreSQL', () => {
  for (const family of families)
    for (const state of ['absent', 'false'] as const)
      it(`${family.path} create/update maps ${state} to409 without artifacts`, async () => {
        const athlete = randomUUID(),
          app = setup(athlete),
          url = '/bff/v1' + family.path;
        if (state === 'false') await consent(app, false);
        const before = await facts(athlete);
        const denied = await app.inject({
          method: 'POST',
          url,
          headers: writeHeaders(),
          payload: { values: family.values },
        });
        expect(denied.statusCode).toBe(409);
        expect(denied.json()).toMatchObject({ error: { code: 'APP_CONSENT_REQUIRED' } });
        expect(await facts(athlete)).toEqual(before);
        await consent(app, true);
        const created = await app.inject({
          method: 'POST',
          url,
          headers: writeHeaders(),
          payload: { values: family.values },
        });
        expect(created.statusCode).toBe(201);
        const record = raceCommandResultSchema.parse(created.json());
        if (state === 'absent') await absence(athlete);
        else await consent(app, false);
        const baseline = await facts(athlete);
        const update = await app.inject({
          method: 'PATCH',
          url: `${url}/${record.id}`,
          headers: writeHeaders(),
          payload: { expectedRevision: 1, values: family.values },
        });
        expect(update.statusCode).toBe(409);
        expect(update.json()).toMatchObject({ error: { code: 'APP_CONSENT_REQUIRED' } });
        expect(await facts(athlete)).toEqual(baseline);
      });
  for (const family of families)
    it(`${family.path} committed replay retained; fresh writes denied; read/list/delete/export allowed`, async () => {
      const athlete = randomUUID(),
        app = setup(athlete),
        url = '/bff/v1' + family.path;
      await consent(app, true);
      const command = {
        method: 'POST' as const,
        url,
        headers: writeHeaders(),
        payload: { values: family.values },
      };
      const created = await app.inject(command);
      expect(created.statusCode).toBe(201);
      const record = raceCommandResultSchema.parse(created.json());
      const patch = {
        method: 'PATCH' as const,
        url: `${url}/${record.id}`,
        headers: writeHeaders(),
        payload: { expectedRevision: 1, values: family.values },
      };
      const changed = await app.inject(patch);
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ revision: 2 });
      await consent(app, false);
      const baseline = await facts(athlete);
      const createReplay = await app.inject(command),
        updateReplay = await app.inject(patch);
      expect(createReplay.statusCode).toBe(201);
      expect(createReplay.json()).toEqual(created.json());
      expect(updateReplay.statusCode).toBe(200);
      expect(updateReplay.json()).toEqual(changed.json());
      expect(await facts(athlete)).toEqual(baseline);
      for (const fresh of [
        { ...command, headers: writeHeaders() },
        { ...patch, headers: writeHeaders(), payload: { ...patch.payload, expectedRevision: 2 } },
      ]) {
        const denied = await app.inject(fresh);
        expect(denied.statusCode).toBe(409);
        expect(denied.json()).toMatchObject({ error: { code: 'APP_CONSENT_REQUIRED' } });
      }
      expect(await facts(athlete)).toEqual(baseline);
      expect((await app.inject({ url: `${url}/${record.id}`, headers })).statusCode).toBe(200);
      const list = await app.inject({ url, headers });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ items: [{ id: record.id, revision: 2 }] });
      const exported = await app.inject({
        method: 'POST',
        url: '/bff/v1/operations/export',
        headers: writeHeaders(),
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-disposition']).toContain('attachment');
      expect(exported.json()).toMatchObject({ athleteId: athlete });
      const deleted = await app.inject({
        method: 'DELETE',
        url: `${url}/${record.id}`,
        headers: writeHeaders(),
        payload: { expectedRevision: 2 },
      });
      expect(deleted.statusCode).toBe(200);
      expect((await app.inject({ url: `${url}/${record.id}`, headers })).statusCode).toBe(404);
      expect((await app.inject(command)).json()).toEqual(created.json());
      expect((await app.inject({ url: `${url}/${record.id}`, headers })).statusCode).toBe(404);
    });
  it('anonymous401, cookie CSRF403, current true foreign404 remain independent', async () => {
    const alice = setup(randomUUID()),
      bob = setup(randomUUID());
    await consent(alice, true);
    await consent(bob, true);
    for (const family of families) {
      const url = '/bff/v1' + family.path;
      const anonymous = await alice.inject({
        method: 'POST',
        url,
        payload: { values: family.values },
      });
      expect(anonymous.statusCode).toBe(401);
      const { 'x-csrf-token': _csrf, ...withoutCsrf } = writeHeaders();
      const csrf = await alice.inject({
        method: 'POST',
        url,
        headers: withoutCsrf,
        payload: { values: family.values },
      });
      expect(csrf.statusCode).toBe(403);
      const created = await alice.inject({
        method: 'POST',
        url,
        headers: writeHeaders(),
        payload: { values: family.values },
      });
      expect(created.statusCode).toBe(201);
      const record = raceCommandResultSchema.parse(created.json());
      for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
        const foreign = await bob.inject({
          method,
          url: `${url}/${record.id}`,
          headers: writeHeaders(),
          ...(method === 'PATCH'
            ? { payload: { expectedRevision: 1, values: family.values } }
            : method === 'DELETE'
              ? { payload: { expectedRevision: 1 } }
              : {}),
        });
        expect(foreign.statusCode).toBe(404);
        expect(foreign.json()).toMatchObject({ error: { code: 'RACE_NOT_FOUND' } });
      }
    }
  });
  it('unrelated real connection failure stays sanitized500, not admission409', async () => {
    const failed = createDatabase({ connectionString: runtimeUrl });
    await failed.close();
    const app = setup(randomUUID(), failed);
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/races',
      headers: writeHeaders(),
      payload: { values: families[0]?.values },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    for (const secret of [
      runtimeUrl,
      cookie,
      csrfToken,
      'pool',
      'connection',
      'Synthetic admission private title',
    ])
      expect(response.body).not.toContain(secret);
  });
});
