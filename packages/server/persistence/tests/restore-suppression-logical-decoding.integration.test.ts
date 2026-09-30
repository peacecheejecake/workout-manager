import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';

// Opt-in only: test_decoding is PostgreSQL's diagnostic output plugin. Unlike a
// production pgoutput publication it can see every changed table, so this test
// uses only synthetic erasure rows and never prints or stores decoded payloads.
const enabled = process.env['TEST_LOGICAL_DECODING'] === '1';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (enabled && !adminUrl) throw new Error('Logical decoding requires a disposable database');
const admin = enabled ? new Pool({ connectionString: adminUrl }) : null;
const slot = `wm_suppression_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

type Decoded = { lsn: string; xid: string; data: string };

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function adminPool(): Pool {
  return required(admin, 'Logical decoding admin connection unavailable');
}

async function inTenant(client: PoolClient, tenant: string): Promise<void> {
  await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
  await client.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [tenant]);
}

async function readChanges(pool: Pool, consume: boolean): Promise<Decoded[]> {
  const functionName = consume ? 'pg_logical_slot_get_changes' : 'pg_logical_slot_peek_changes';
  const result = await pool.query<Decoded>(
    `SELECT lsn::text,xid::text,data FROM ${functionName}($1,NULL,NULL,'include-xids','1')`,
    [slot],
  );
  return result.rows;
}

async function confirmedFlushLsn(): Promise<string> {
  const result = await adminPool().query<{ confirmed_flush_lsn: string }>(
    'SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name=$1',
    [slot],
  );
  const lsn = result.rows[0]?.confirmed_flush_lsn;
  if (!lsn) throw new Error('Logical slot missing its confirmed position');
  return lsn;
}

function committedEventIds(changes: Decoded[], ids: Map<string, string>): string[][] {
  const committed: string[][] = [];
  let pending: string[] | null = null;
  for (const change of changes) {
    if (change.data.startsWith('BEGIN ')) {
      if (pending) throw new Error('Nested decoded transaction');
      pending = [];
    } else if (change.data.startsWith('table public.restore_suppression_event: INSERT:')) {
      if (!pending) throw new Error('Decoded event outside a transaction');
      const matched = [...ids.entries()].filter(([, id]) => change.data.includes(id));
      if (matched.length !== 1) throw new Error('Unknown or ambiguous decoded event');
      pending.push(required(matched[0], 'Decoded event was not mapped')[0]);
    } else if (change.data.startsWith('COMMIT ')) {
      if (!pending) throw new Error('Decoded commit without a transaction');
      committed.push(pending);
      pending = null;
    }
  }
  if (pending) throw new Error('Incomplete decoded transaction');
  return committed.filter((events) => events.length > 0);
}

function lsnValue(lsn: string): bigint {
  const [high, low] = lsn.split('/');
  if (!high || !low) throw new Error('Invalid decoded WAL position');
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}

describe.skipIf(!enabled)('local suppression events through PostgreSQL logical decoding', () => {
  beforeAll(async () => {
    const level = await adminPool().query<{ wal_level: string }>('SHOW wal_level');
    expect(level.rows[0]?.wal_level).toBe('logical');
    await migrate(required(adminUrl, 'Logical decoding admin URL unavailable'));
    await adminPool().query('SELECT * FROM pg_create_logical_replication_slot($1,$2)', [
      slot,
      'test_decoding',
    ]);
  });

  afterAll(async () => {
    await adminPool()
      .query('SELECT pg_drop_replication_slot($1)', [slot])
      .catch(() => undefined);
    await adminPool().end();
  });

  it('decodes commit order, grouped events and no rollback; replays until slot consumption', async () => {
    const tenants = {
      startedFirst: randomUUID(),
      committedFirst: randomUUID(),
      pairedOne: randomUUID(),
      pairedTwo: randomUUID(),
      rolledBack: randomUUID(),
      afterAck: randomUUID(),
    };
    const first = await adminPool().connect();
    const second = await adminPool().connect();
    try {
      await first.query('BEGIN');
      await inTenant(first, tenants.startedFirst);
      await second.query('BEGIN');
      await inTenant(second, tenants.committedFirst);
      await second.query('COMMIT');
      await first.query('COMMIT');
    } catch (error) {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      first.release();
      second.release();
    }

    const paired = await adminPool().connect();
    try {
      await paired.query('BEGIN');
      await inTenant(paired, tenants.pairedOne);
      await inTenant(paired, tenants.pairedTwo);
      await paired.query('COMMIT');
      await paired.query('BEGIN');
      await inTenant(paired, tenants.rolledBack);
      await paired.query('ROLLBACK');
    } catch (error) {
      await paired.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      paired.release();
    }

    const idRows = await adminPool().query<{ athlete_id: string; event_id: string }>(
      `SELECT athlete_id,event_id::text FROM restore_suppression_event
       WHERE athlete_id=ANY($1::text[])`,
      [Object.values(tenants)],
    );
    expect(idRows.rows).toHaveLength(4);
    const ids = new Map(idRows.rows.map((row) => [row.athlete_id, row.event_id]));
    const cursorBefore = await confirmedFlushLsn();
    const consumerOne = new Pool({ connectionString: adminUrl });
    const beforeRestart = await readChanges(consumerOne, false);
    await consumerOne.end();
    const consumerTwo = new Pool({ connectionString: adminUrl });
    try {
      const afterRestart = await readChanges(consumerTwo, false);
      expect(afterRestart).toEqual(beforeRestart);
      expect(await confirmedFlushLsn()).toBe(cursorBefore);
      expect(committedEventIds(afterRestart, ids)).toEqual([
        [tenants.committedFirst],
        [tenants.startedFirst],
        [tenants.pairedOne, tenants.pairedTwo],
      ]);
      const commitPositions = afterRestart
        .filter((row) => row.data.startsWith('COMMIT '))
        .map((row) => lsnValue(row.lsn));
      expect(commitPositions).toHaveLength(3);
      expect(
        required(commitPositions[0], 'First commit position missing') <
          required(commitPositions[1], 'Second commit position missing'),
      ).toBe(true);
      expect(
        required(commitPositions[1], 'Second commit position missing') <
          required(commitPositions[2], 'Third commit position missing'),
      ).toBe(true);
      expect(afterRestart.some((row) => row.data.includes(tenants.rolledBack))).toBe(false);

      // SQL get_changes advances the slot. This is a local consumption cursor,
      // not an off-host durability acknowledgement or production standby feedback.
      expect(await readChanges(consumerTwo, true)).toEqual(afterRestart);
      expect(await confirmedFlushLsn()).not.toBe(cursorBefore);
      expect(await readChanges(consumerTwo, false)).toEqual([]);
      const fresh = await adminPool().connect();
      try {
        await fresh.query('BEGIN');
        await inTenant(fresh, tenants.afterAck);
        await fresh.query('COMMIT');
      } finally {
        fresh.release();
      }
      const freshId = await adminPool().query<{ event_id: string }>(
        'SELECT event_id::text FROM restore_suppression_event WHERE athlete_id=$1',
        [tenants.afterAck],
      );
      ids.set(tenants.afterAck, required(freshId.rows[0], 'Fresh event missing').event_id);
      expect(committedEventIds(await readChanges(consumerTwo, false), ids)).toEqual([
        [tenants.afterAck],
      ]);
    } finally {
      await consumerTwo.end();
    }
  });
});
