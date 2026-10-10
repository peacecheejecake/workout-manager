import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, migrate } from '../src/migrate.js';
import type { IdlePoolErrorObservation } from '../src/pool-observation.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error(
    'Real PostgreSQL required: run pnpm test:integration or provide isolated TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL',
  );
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const observations: IdlePoolErrorObservation[] = [];
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await migrate(adminUrl);
  database = createDatabase({
    connectionString: runtimeUrl,
    max: 1,
    idleErrorSink: (observation) => observations.push(observation),
  });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

async function backendPid(athleteId: string): Promise<number> {
  return database.tenant(athleteId, async (transaction) => {
    const result = await transaction.query('SELECT pg_backend_pid() AS pid');
    return Number(result.rows[0]?.['pid']);
  });
}

describe('real PostgreSQL idle backend loss', () => {
  it('observes 57P01 on a terminated idle backend, survives and reconnects', async () => {
    const athleteId = `pool-observation-${randomUUID()}`;
    const pid = await backendPid(athleteId);
    expect(pid).toBeGreaterThan(0);
    // The client is back in the pool and idle when its backend is terminated.
    const terminated = await admin.query('SELECT pg_terminate_backend($1) AS ok', [pid]);
    expect(terminated.rows[0]?.['ok']).toBe(true);
    const deadline = Date.now() + 5000;
    while (observations.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observations).toStrictEqual([{ poolId: 'database', code: '57P01' }]);
    // Reaching here means the unhandled-'error' crash did not happen; the next
    // checkout opens a fresh backend.
    const next = await backendPid(athleteId);
    expect(next).toBeGreaterThan(0);
    expect(next).not.toBe(pid);
    expect(observations).toHaveLength(1);
  });
});
