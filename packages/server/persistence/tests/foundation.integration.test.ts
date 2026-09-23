import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { claim, complete, enqueue, retry } from '../src/outbox.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error(
    'Real PostgreSQL required: run pnpm test:integration or provide isolated TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL',
  );
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await migrate(adminUrl);
  // Harness runtime role is deliberately neither table owner nor privileged.
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

function event(key = randomUUID()) {
  return { id: randomUUID(), idempotencyKey: key, topic: 'test.event', payload: { revision: 1 } };
}
describe('real PostgreSQL foundation', () => {
  it('uses checksum-tracked repeatable migrations', async () => {
    const result = await admin.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    expect(result.rows).toEqual([
      { version: 1, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 2, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 3, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 4, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 5, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 6, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 7, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 8, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 9, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 10, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 11, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 12, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 13, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 14, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 15, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 16, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 17, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 18, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 19, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 20, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 21, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 22, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 23, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 24, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 25, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 26, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 27, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 28, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 29, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 30, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 31, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 32, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 33, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 34, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 35, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 36, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 37, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 38, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 39, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 40, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
  });
  it('rejects privileged runtime connections', async () => {
    const unsafe = createDatabase({ connectionString: adminUrl });
    try {
      await expect(unsafe.tenant('a', async () => undefined)).rejects.toThrow();
    } finally {
      await unsafe.close();
    }
  });
  it('RLS hides foreign rows even without a tenant WHERE filter and rejects foreign inserts', async () => {
    const first = randomUUID();
    const second = randomUUID();
    await database.tenant(first, (tx) => enqueue(tx, event()));
    await database.tenant(second, async (tx) => {
      expect((await tx.query('SELECT * FROM outbox')).rows).toEqual([]);
    });
    await expect(
      database.tenant(second, (tx) =>
        tx.query("INSERT INTO consent VALUES ($1, 'app', true, 1)", [first]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('rolls back domain state and outbox together and releases tenant context', async () => {
    const athlete = randomUUID();
    await expect(
      database.tenant(athlete, async (tx) => {
        await tx.query("INSERT INTO consent VALUES ($1, 'app', true, 1)", [athlete]);
        await enqueue(tx, event());
        throw new Error('injected failure');
      }),
    ).rejects.toThrow('injected failure');
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM consent')).rows).toEqual([]);
      expect((await tx.query('SELECT * FROM outbox')).rows).toEqual([]);
    });
    const raw = new Pool({ connectionString: runtimeUrl });
    try {
      expect((await raw.query('SELECT * FROM outbox')).rows).toEqual([]);
    } finally {
      await raw.end();
    }
  });
  it('rejects success when the callback swallows an SQL error and PostgreSQL rolls back COMMIT', async () => {
    const athlete = randomUUID();
    await expect(
      database.tenant(athlete, async (tx) => {
        await tx.query("INSERT INTO consent VALUES ($1, 'app', true, 1)", [athlete]);
        await enqueue(tx, event());
        try {
          await tx.query('SELECT 1 / 0');
        } catch {
          // Simulate application code that incorrectly treats a database failure as recovered.
        }
        return { committed: true };
      }),
    ).rejects.toThrow('TRANSACTION_NOT_COMMITTED');
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM consent')).rows).toEqual([]);
      expect((await tx.query('SELECT * FROM outbox')).rows).toEqual([]);
    });
  });
  it('rejects escaped transaction handles after returning the pooled connection', async () => {
    let escaped: Transaction | undefined;
    await database.tenant(randomUUID(), async (tx) => {
      escaped = tx;
    });
    if (!escaped) throw new Error('Missing transaction handle');
    await expect(escaped.query('SELECT * FROM consent')).rejects.toThrow('TRANSACTION_CLOSED');
  });
  it('preserves consent absence, grants, withdrawal, stale writes and original idempotent result', async () => {
    const repository = createConsentRepository(database);
    const athlete = randomUUID();
    expect(await repository.getConsent(athlete, 'ai')).toEqual({
      kind: 'ai',
      granted: false,
      revision: 0,
    });
    const update = {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    } as const;
    const granted = await repository.setConsent(athlete, update);
    expect(granted.revision).toBe(1);
    expect(
      await repository.setConsent(athlete, {
        ...update,
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).toEqual({ kind: 'ai', granted: false, revision: 2 });
    expect(await repository.setConsent(athlete, update)).toEqual(granted);
    await expect(
      repository.setConsent(athlete, { ...update, granted: false }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      repository.setConsent(athlete, { ...update, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(2);
    });
  });
  it('serializes concurrent absent-head writes and duplicate successful commands', async () => {
    const repository = createConsentRepository(database);
    const athlete = randomUUID();
    const update = {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    } as const;
    const results = await Promise.all([
      repository.setConsent(athlete, update),
      repository.setConsent(athlete, update),
    ]);
    expect(results[0]).toEqual(results[1]);
    const races = await Promise.allSettled([
      repository.setConsent(athlete, {
        ...update,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
      repository.setConsent(athlete, {
        ...update,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(races.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(races.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(2);
    });
  });
  it('rolls back consent and its receipt if outbox insertion fails', async () => {
    const athlete = randomUUID();
    const key = randomUUID();
    await database.tenant(athlete, (tx) => enqueue(tx, event(key)));
    const repository = createConsentRepository(database);
    await expect(
      repository.setConsent(athlete, {
        kind: 'media',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await repository.getConsent(athlete, 'media')).toEqual({
      kind: 'media',
      granted: false,
      revision: 0,
    });
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM command_receipt')).rows).toEqual([]);
    });
  });
  it('allows only one concurrent creation of a missing consent head', async () => {
    const repository = createConsentRepository(database);
    const athlete = randomUUID();
    const results = await Promise.allSettled([
      repository.setConsent(athlete, {
        kind: 'provider',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
      repository.setConsent(athlete, {
        kind: 'provider',
        granted: false,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('deduplicates outbox events and rejects different payload under the same key', async () => {
    const athlete = randomUUID();
    const input = event();
    const id = await database.tenant(athlete, (tx) => enqueue(tx, input));
    expect(
      await database.tenant(athlete, (tx) => enqueue(tx, { ...input, id: randomUUID() })),
    ).toBe(id);
    await expect(
      database.tenant(athlete, (tx) => enqueue(tx, { ...input, payload: { revision: 2 } })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('leases distinct events concurrently, retries and fences stale completion', async () => {
    const athlete = randomUUID();
    await database.tenant(athlete, async (tx) => {
      await enqueue(tx, event());
      await enqueue(tx, event());
    });
    const leases = await Promise.all([
      database.tenant(athlete, (tx) => claim(tx, randomUUID())),
      database.tenant(athlete, (tx) => claim(tx, randomUUID())),
    ]);
    const first = leases[0];
    const second = leases[1];
    if (!first || !second) throw new Error('Expected two leases');
    expect(first.id).not.toBe(second.id);
    expect(await database.tenant(athlete, (tx) => claim(tx, randomUUID()))).toBeNull();
    expect(await database.tenant(athlete, (tx) => complete(tx, first.id, randomUUID()))).toBe(
      false,
    );
    expect(await database.tenant(athlete, (tx) => retry(tx, first.id, first.leaseToken, 0))).toBe(
      true,
    );
    const reclaimed = await database.tenant(athlete, (tx) => claim(tx, randomUUID()));
    if (!reclaimed) throw new Error('Expected retried lease');
    expect(reclaimed.attempts).toBe(2);
    expect(await database.tenant(athlete, (tx) => complete(tx, first.id, first.leaseToken))).toBe(
      false,
    );
    expect(
      await database.tenant(athlete, (tx) => complete(tx, reclaimed.id, reclaimed.leaseToken)),
    ).toBe(true);
    expect(
      await database.tenant(athlete, (tx) => complete(tx, reclaimed.id, reclaimed.leaseToken)),
    ).toBe(false);
    expect(await database.tenant(athlete, (tx) => complete(tx, second.id, second.leaseToken))).toBe(
      true,
    );
  });
  it('reclaims expired leases without allowing stale worker acknowledgement', async () => {
    const athlete = randomUUID();
    await database.tenant(athlete, (tx) => enqueue(tx, event()));
    const lease = await database.tenant(athlete, (tx) => claim(tx, randomUUID()));
    if (!lease) throw new Error('Expected lease');
    await database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE outbox SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
        [lease.id],
      ),
    );
    expect(await database.tenant(athlete, (tx) => complete(tx, lease.id, lease.leaseToken))).toBe(
      false,
    );
    const next = await database.tenant(athlete, (tx) => claim(tx, randomUUID()));
    expect(next?.id).toBe(lease.id);
    expect(next?.attempts).toBe(2);
  });
});
