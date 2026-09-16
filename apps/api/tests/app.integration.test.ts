import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { migrate } from '@workout/server-persistence/migrate';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Isolated real PostgreSQL required: run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

it('FUT-01 API commits scoped consent/outbox once; conflicting writes and foreign tenants remain isolated', async () => {
  const athleteId = randomUUID();
  const secondAthleteId = randomUUID();
  const app = createApi({
    auth: {
      async authenticate({ authorization }) {
        if (authorization === 'Bearer fixture-first')
          return { athleteId, sessionId: 'test-first', method: 'bearer' };
        if (authorization === 'Bearer fixture-second')
          return { athleteId: secondAthleteId, sessionId: 'test-second', method: 'bearer' };
        return null;
      },
    },
    consent: createConsentRepository(database),
    allowedOrigins: [],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  try {
    const headers = { authorization: 'Bearer fixture-first', 'idempotency-key': randomUUID() };
    const command = {
      method: 'PUT',
      url: '/bff/v1/consents/ai',
      headers,
      payload: { granted: true, expectedRevision: 0 },
    } as const;
    const [first, duplicate] = await Promise.all([app.inject(command), app.inject(command)]);
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(first.json()).toEqual({ kind: 'ai', granted: true, revision: 1 });
    expect(duplicate.json()).toEqual(first.json());
    const stale = await app.inject({
      ...command,
      headers: { ...headers, 'idempotency-key': randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    const reused = await app.inject({
      ...command,
      payload: { granted: false, expectedRevision: 1 },
    });
    expect(reused.statusCode).toBe(409);
    const foreign = await app.inject({
      url: '/bff/v1/consents/ai',
      headers: { authorization: 'Bearer fixture-second' },
    });
    expect(foreign.json()).toEqual({ kind: 'ai', granted: false, revision: 0 });
    await database.tenant(athleteId, async (transaction) => {
      expect((await transaction.query('SELECT * FROM outbox')).rowCount).toBe(1);
      expect((await transaction.query('SELECT * FROM command_receipt')).rowCount).toBe(1);
    });
  } finally {
    await app.close();
  }
});
