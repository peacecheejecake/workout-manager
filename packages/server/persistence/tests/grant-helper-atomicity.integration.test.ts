import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantActivityTracks, grantOperations, grantResources, migrate } from '../src/migrate.js';

/**
 * M2-01o: a grant helper that narrows a privilege must never leave a moment without it.
 *
 * Several helpers narrow a table-level grant to columns by revoking the table-level grant and
 * then granting the columns. Revoking at table level also takes away the column grants, so
 * the order is forced — and when the two ran as separate autocommit statements, a helper
 * re-run on a live database left a gap in which the role held neither. Every runtime
 * statement that landed in that gap failed with `42501`: an M2-01c track reference record, a
 * URL-ingestion read. The helpers are meant to be re-run (that is how M2-01n repairs a
 * database an older helper touched), so the gap was on the deployment path, not hypothetical.
 *
 * These tests re-run each such helper many times while another connection, as the role,
 * issues the statement the helper narrows, and count permission failures. The statements
 * select no rows, so what they exercise is the privilege check alone — no RLS context, no
 * constraints, no data to clean up.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const runtimeRole = `grant_atomic_${suffix}`;
const pools: Pool[] = [];

function roleUrl(role: string): string {
  const parsed = new URL(runtimeUrl as string);
  parsed.username = role;
  return parsed.href;
}

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantActivityTracks(adminUrl, runtimeRole);
  await grantResources(adminUrl, runtimeRole);
  await grantOperations(adminUrl, runtimeRole);
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await admin.query(`DROP OWNED BY "${runtimeRole}"`);
  await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await admin.end();
});

/**
 * Run `helper` `reruns` times while `role` issues `probe` back to back on its own connection,
 * and return how many probes failed, by SQLSTATE.
 */
async function probeWhileRerunning(
  role: string,
  probe: string,
  helper: () => Promise<void>,
  reruns: number,
): Promise<{ probes: number; failures: Record<string, number> }> {
  const pool = new Pool({ connectionString: roleUrl(role), max: 1 });
  pools.push(pool);
  const client = await pool.connect();
  let running = true;
  let probes = 0;
  const failures: Record<string, number> = {};
  const prober = (async () => {
    while (running) {
      try {
        await client.query(probe);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'unknown';
        failures[code] = (failures[code] ?? 0) + 1;
      }
      probes += 1;
    }
  })();
  try {
    for (let run = 0; run < reruns; run += 1) await helper();
  } finally {
    running = false;
    await prober;
    client.release();
  }
  return { probes, failures };
}

describe('re-running a narrowing grant helper on a live database (M2-01o)', () => {
  it('never leaves the runtime without INSERT on the track reference index', async () => {
    // The M2-01c record path writes exactly these three columns.
    const result = await probeWhileRerunning(
      runtimeRole,
      `INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
       SELECT storage_ref,athlete_id,recorded_at FROM activity_track_object_ref WHERE false`,
      () => grantActivityTracks(adminUrl, runtimeRole),
      150,
    );
    expect(result.probes).toBeGreaterThan(150);
    expect(result.failures).toEqual({});
  }, 60_000);

  it('never leaves the runtime without its URL-ingestion read columns', async () => {
    // Both helpers that narrow the URL-ingestion reads, each re-run on its own.
    const probe = `SELECT athlete_id, state FROM resource_url_ingestion WHERE false`;
    for (const helper of [
      () => grantResources(adminUrl, runtimeRole),
      () => grantOperations(adminUrl, runtimeRole),
    ]) {
      const result = await probeWhileRerunning(runtimeRole, probe, helper, 60);
      expect(result.probes).toBeGreaterThan(60);
      expect(result.failures).toEqual({});
    }
  }, 60_000);
});
