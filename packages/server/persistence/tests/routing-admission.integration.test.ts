import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantCourses, grantOperations, migrate } from '../src/migrate.js';
import {
  createSharedRoutingAdmission,
  type SharedRoutingAdmissionEvent,
  type SharedRoutingAdmissionLimits,
  type SharedRoutingAdmissionResult,
} from '../src/routing-admission.js';

/**
 * The shared routing limiter (M2-01ah) on real PostgreSQL.
 *
 * "Two API instances" here are two limiters over two SEPARATE pools, so nothing is shared
 * between them but the database — which is the whole claim: the tenant bounds and the engine
 * cap hold summed over instances, an instance that dies without releasing gives its permits
 * back when their lease runs out, and an unreachable database refuses rather than counting
 * locally. The production composition over the same table is asserted in
 * `apps/api/tests/routing-admission.integration.test.ts`.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Real PostgreSQL required: run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl });
const databases: Database[] = [];

function pool(): Database {
  const database = createDatabase({ connectionString: runtimeUrl as string, max: 8 });
  databases.push(database);
  return database;
}

const limits = (overrides: Partial<SharedRoutingAdmissionLimits> = {}) => ({
  tenantConcurrency: 2,
  tenantRequestsPerWindow: 1_000,
  tenantWindowMilliseconds: 60_000,
  engineConcurrency: 64,
  leaseMilliseconds: 60_000,
  ...overrides,
});

const granted = (results: readonly SharedRoutingAdmissionResult[]) =>
  results.filter((result) => result.granted);
const reasons = (results: readonly SharedRoutingAdmissionResult[]) =>
  results.flatMap((result) => (result.granted ? [] : [result.reason]));

async function heldBy(tenant: string): Promise<number> {
  const rows = await admin.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM routing_admission
     WHERE athlete_id=$1 AND released_at IS NULL AND lease_until>clock_timestamp()`,
    [tenant],
  );
  return rows.rows[0]?.total ?? -1;
}

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  // The tenant transaction reads `tenant_erasure` first, and erasure is asserted below.
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
});

beforeEach(async () => {
  // The engine cap counts every tenant's permits, so each case starts from an empty table.
  await admin.query('DELETE FROM routing_admission');
});

afterAll(async () => {
  await Promise.all(databases.map((database) => database.close().catch(() => undefined)));
  await admin.end();
});

describe('two limiter instances with separate pools share one set of bounds', () => {
  it('never admit more than the tenant concurrency between them, however they race', async () => {
    const first = createSharedRoutingAdmission(pool(), limits());
    const second = createSharedRoutingAdmission(pool(), limits());
    const tenant = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        (index % 2 === 0 ? first : second).tryAcquire(tenant),
      ),
    );
    expect(granted(results)).toHaveLength(2);
    expect(reasons(results)).toEqual(Array(14).fill('concurrency'));
    expect(await heldBy(tenant)).toBe(2);
    // One permit back (through the other instance's pool) makes exactly one slot.
    const [held] = granted(results);
    if (held?.granted !== true) throw new Error('expected a permit');
    await held.release();
    await held.release(); // idempotent: the second release returns nothing more
    const again = await Promise.all([second.tryAcquire(tenant), first.tryAcquire(tenant)]);
    expect(granted(again)).toHaveLength(1);
    expect(await heldBy(tenant)).toBe(2);
  });

  it('count the rate window across instances and say when to retry', async () => {
    const first = createSharedRoutingAdmission(pool(), limits({ tenantRequestsPerWindow: 3 }));
    const second = createSharedRoutingAdmission(pool(), limits({ tenantRequestsPerWindow: 3 }));
    const tenant = randomUUID();
    for (const instance of [first, second, first]) {
      const result = await instance.tryAcquire(tenant);
      if (!result.granted) throw new Error('expected a permit');
      await result.release();
    }
    const refused = await second.tryAcquire(tenant);
    expect(refused).toMatchObject({ granted: false, reason: 'rate' });
    if (refused.granted) throw new Error('unreachable');
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(59);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    // Another tenant has its own window.
    expect((await second.tryAcquire(randomUUID())).granted).toBe(true);
  });
});

describe('the engine cap over every tenant', () => {
  it('admits at most the engine concurrency across tenants and instances, and reports it', async () => {
    const events: SharedRoutingAdmissionEvent[] = [];
    const options = { onRefusal: (event: SharedRoutingAdmissionEvent) => events.push(event) };
    const first = createSharedRoutingAdmission(pool(), limits({ engineConcurrency: 3 }), options);
    const second = createSharedRoutingAdmission(pool(), limits({ engineConcurrency: 3 }), options);
    const tenants = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.all(
      tenants.map((tenant, index) => (index % 2 === 0 ? first : second).tryAcquire(tenant)),
    );
    // Every tenant is inside its own bound (one each), so only the engine cap refuses.
    expect(granted(results)).toHaveLength(3);
    expect(reasons(results)).toEqual(Array(5).fill('engine_capacity'));
    expect(events).toHaveLength(5);
    for (const event of events)
      expect(event).toEqual({ reason: 'engine_capacity', engineInFlight: 3, engineConcurrency: 3 });
    const held = await admin.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM routing_admission
       WHERE released_at IS NULL AND lease_until>clock_timestamp()`,
    );
    expect(held.rows[0]?.total).toBe(3);
    // A released slot is one more computation for anyone.
    const [one] = granted(results);
    if (one?.granted !== true) throw new Error('expected a permit');
    await one.release();
    expect((await second.tryAcquire(randomUUID())).granted).toBe(true);
    expect((await first.tryAcquire(randomUUID())).granted).toBe(false);
  });
});

describe('a dead instance and an unreachable database', () => {
  it('returns the permits of an instance that died without releasing when their lease ends', async () => {
    const short = limits({ leaseMilliseconds: 400, engineConcurrency: 2 });
    const dying = pool();
    const doomed = createSharedRoutingAdmission(dying, short);
    const survivor = createSharedRoutingAdmission(pool(), short);
    const tenant = randomUUID();
    expect((await doomed.tryAcquire(tenant)).granted).toBe(true);
    expect((await doomed.tryAcquire(tenant)).granted).toBe(true);
    // The instance goes away with both permits unreleased.
    await dying.close();
    expect(await survivor.tryAcquire(tenant)).toMatchObject({
      granted: false,
      reason: 'concurrency',
    });
    // The engine cap sees them too: another tenant is refused while they hold.
    expect(await survivor.tryAcquire(randomUUID())).toMatchObject({
      granted: false,
      reason: 'engine_capacity',
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await heldBy(tenant)).toBe(0);
    expect((await survivor.tryAcquire(tenant)).granted).toBe(true);
    expect((await survivor.tryAcquire(randomUUID())).granted).toBe(true);
  });

  it('refuses as limiter_unavailable rather than counting locally', async () => {
    const gone = pool();
    await gone.close();
    const events: SharedRoutingAdmissionEvent[] = [];
    const admission = createSharedRoutingAdmission(gone, limits(), {
      onRefusal: (event) => events.push(event),
    });
    expect(await admission.tryAcquire(randomUUID())).toEqual({
      granted: false,
      reason: 'limiter_unavailable',
      retryAfterSeconds: 1,
    });
    expect(events).toEqual([
      { reason: 'limiter_unavailable', engineInFlight: null, engineConcurrency: 64 },
    ]);
  });

  it('refuses limits outside the bounds the database enforces, at construction', () => {
    expect(() => createSharedRoutingAdmission(pool(), limits({ engineConcurrency: 0 }))).toThrow(
      'INVALID_ADMISSION_LIMITS',
    );
    expect(() => createSharedRoutingAdmission(pool(), limits({ leaseMilliseconds: 50 }))).toThrow(
      'INVALID_ADMISSION_LIMITS',
    );
  });

  it('refuses a rate window shorter than the lease, in the limiter and in the database', async () => {
    // Housekeeping deletes rows that left the window and hold nothing; a window shorter than
    // the lease would let a row leave the window while its lease still holds (review N5).
    expect(() =>
      createSharedRoutingAdmission(
        pool(),
        limits({ tenantWindowMilliseconds: 5_000, leaseMilliseconds: 12_000 }),
      ),
    ).toThrow('INVALID_ADMISSION_LIMITS');
    // Equal is allowed: a row leaves the window exactly when its lease ends.
    expect(() =>
      createSharedRoutingAdmission(
        pool(),
        limits({ tenantWindowMilliseconds: 12_000, leaseMilliseconds: 12_000 }),
      ),
    ).not.toThrow();
    const runtime = new Pool({ connectionString: runtimeUrl });
    try {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [randomUUID()]);
        await expect(
          client.query('SELECT * FROM acquire_routing_permit($1,2,20,5000,8,12000)', [
            randomUUID(),
          ]),
        ).rejects.toThrow('INVALID_ROUTING_ADMISSION_LIMITS');
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [randomUUID()]);
        const equal = await client.query(
          'SELECT * FROM acquire_routing_permit($1,2,20,12000,8,12000)',
          [randomUUID()],
        );
        expect(equal.rows[0]).toMatchObject({ permit_granted: true });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
  });

  it('reports a contended acquisition lock as limiter_contended, not as an outage', async () => {
    // Another session holds the acquisition lock past the tenant transaction's lock_timeout
    // (3 s): the database is there and answering, it is busy (review N3).
    const holder = await admin.connect();
    const events: SharedRoutingAdmissionEvent[] = [];
    try {
      await holder.query('SELECT pg_advisory_lock(77206,47)');
      const admission = createSharedRoutingAdmission(pool(), limits(), {
        onRefusal: (event) => events.push(event),
      });
      expect(await admission.tryAcquire(randomUUID())).toEqual({
        granted: false,
        reason: 'limiter_contended',
        retryAfterSeconds: 1,
      });
      expect(events).toEqual([
        { reason: 'limiter_contended', engineInFlight: null, engineConcurrency: 64 },
      ]);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(77206,47)');
      holder.release();
    }
  });
});

describe('the table is reachable only through the two functions', () => {
  it('gives the runtime role no direct read or write, and no call outside a tenant', async () => {
    const tenant = randomUUID();
    await createSharedRoutingAdmission(pool(), limits()).tryAcquire(tenant);
    const runtime = new Pool({ connectionString: runtimeUrl });
    try {
      const client = await runtime.connect();
      try {
        await expect(client.query('SELECT * FROM routing_admission')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(
          client.query(
            `INSERT INTO routing_admission(athlete_id,permit_id,started_at,lease_until)
             VALUES ($1,$2,now(),now()+interval '1 second')`,
            [tenant, randomUUID()],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        // No tenant context: the function refuses instead of counting for nobody.
        await expect(
          client.query('SELECT * FROM acquire_routing_permit($1,2,20,60000,8,12000)', [
            randomUUID(),
          ]),
        ).rejects.toThrow('INVALID_ROUTING_PERMIT');
        // Limits outside the function's own bounds are refused there too.
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        await expect(
          client.query('SELECT * FROM acquire_routing_permit($1,2,20,60000,0,12000)', [
            randomUUID(),
          ]),
        ).rejects.toThrow('INVALID_ROUTING_ADMISSION_LIMITS');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
  });

  it('releases only the calling tenant’s own permit', async () => {
    const owner = randomUUID();
    const permit = randomUUID();
    const admission = createSharedRoutingAdmission(pool(), limits(), { permitId: () => permit });
    expect((await admission.tryAcquire(owner)).granted).toBe(true);
    const other = pool();
    const released = await other.tenant(randomUUID(), async (transaction) => {
      const result = await transaction.query('SELECT release_routing_permit($1) AS released', [
        permit,
      ]);
      return result.rows[0]?.['released'];
    });
    expect(released).toBe(false);
    expect(await heldBy(owner)).toBe(1);
  });

  it('erases the tenant’s permits with the account', async () => {
    const tenant = randomUUID();
    const survivor = randomUUID();
    const admission = createSharedRoutingAdmission(pool(), limits());
    expect((await admission.tryAcquire(tenant)).granted).toBe(true);
    expect((await admission.tryAcquire(survivor)).granted).toBe(true);
    const runtime = new Pool({ connectionString: runtimeUrl });
    try {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        await client.query('SELECT public.erase_account($1)', [tenant]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
    const left = await admin.query<{ athlete_id: string }>(
      'SELECT athlete_id FROM routing_admission ORDER BY athlete_id',
    );
    expect(left.rows.map((row) => row.athlete_id)).toEqual([survivor]);
  });
});
