import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import {
  decodeSuppressionPgoutput,
  makeLocalSequenceEnvelope,
  peekSuppressionPgoutput,
  verifyLocalSequenceChain,
} from '../src/restore-suppression-pgoutput.js';

const enabled = process.env['TEST_PGOUTPUT_CONTRACT'] === '1';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (enabled && !adminUrl) throw new Error('pgoutput test needs a disposable database');
const pool = enabled ? new Pool({ connectionString: adminUrl }) : null;
const slot = `wm_suppression_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

function admin(): Pool {
  if (!pool) throw new Error('pgoutput test pool unavailable');
  return pool;
}

describe.skipIf(!enabled)('local pgoutput suppression publication', () => {
  let startLsn = '';
  let clusterId = '';
  beforeAll(async () => {
    expect((await admin().query<{ wal_level: string }>('SHOW wal_level')).rows[0]?.wal_level).toBe(
      'logical',
    );
    if (!adminUrl) throw new Error('Admin URL missing');
    await migrate(adminUrl);
    const publication = await admin().query<{ schemaname: string; tablename: string }>(
      'SELECT schemaname,tablename FROM pg_publication_tables WHERE pubname=$1',
      ['workout_restore_suppression_events'],
    );
    expect(publication.rows).toEqual([
      { schemaname: 'public', tablename: 'restore_suppression_event' },
    ]);
    const options = await admin().query<{
      pubinsert: boolean;
      pubupdate: boolean;
      pubdelete: boolean;
      pubtruncate: boolean;
    }>('SELECT pubinsert,pubupdate,pubdelete,pubtruncate FROM pg_publication WHERE pubname=$1', [
      'workout_restore_suppression_events',
    ]);
    expect(options.rows).toEqual([
      {
        pubinsert: true,
        pubupdate: false,
        pubdelete: false,
        pubtruncate: false,
      },
    ]);
    const created = await admin().query<{ lsn: string }>(
      'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
      [slot, 'pgoutput'],
    );
    startLsn = created.rows[0]?.lsn ?? '';
    clusterId =
      (
        await admin().query<{ system_identifier: string }>(
          'SELECT system_identifier::text FROM pg_control_system()',
        )
      ).rows[0]?.system_identifier ?? '';
  });

  afterAll(async () => {
    await admin()
      .query('SELECT pg_drop_replication_slot($1)', [slot])
      .catch(() => undefined);
    await admin().end();
  });

  it('exports only complete committed events, in commit order, without advancing the slot', async () => {
    const tenants = {
      startedFirst: randomUUID(),
      committedFirst: randomUUID(),
      paired: randomUUID(),
      rolledBack: randomUUID(),
    };
    // An unrelated table is deliberately changed in the same database and transaction.
    await admin().query('CREATE TABLE public.pgoutput_unrelated_probe (id integer PRIMARY KEY)');
    const first = await admin().connect();
    const second = await admin().connect();
    try {
      await first.query('BEGIN');
      await first.query("SELECT set_config('app.athlete_id',$1,true)", [tenants.startedFirst]);
      await first.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [
        tenants.startedFirst,
      ]);
      await second.query('BEGIN');
      await second.query("SELECT set_config('app.athlete_id',$1,true)", [tenants.committedFirst]);
      await second.query('INSERT INTO public.pgoutput_unrelated_probe VALUES(1)');
      await second.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [
        tenants.committedFirst,
      ]);
      await second.query('COMMIT');
      await first.query('COMMIT');
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
    const paired = await admin().connect();
    try {
      await paired.query('BEGIN');
      await paired.query("SELECT set_config('app.athlete_id',$1,true)", [tenants.paired]);
      await paired.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [tenants.paired]);
      await paired.query('INSERT INTO public.pgoutput_unrelated_probe VALUES(2)');
      await paired.query('COMMIT');
      await paired.query('BEGIN');
      await paired.query("SELECT set_config('app.athlete_id',$1,true)", [tenants.rolledBack]);
      await paired.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [tenants.rolledBack]);
      await paired.query('ROLLBACK');
    } finally {
      await paired.query('ROLLBACK').catch(() => undefined);
      paired.release();
    }
    const before = (
      await admin().query<{ confirmed_flush_lsn: string }>(
        'SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name=$1',
        [slot],
      )
    ).rows[0]?.confirmed_flush_lsn;
    const firstPeek = await peekSuppressionPgoutput(admin(), slot);
    const consumerRestart = new Pool({ connectionString: adminUrl });
    const secondPeek = await peekSuppressionPgoutput(consumerRestart, slot);
    await consumerRestart.end();
    expect(secondPeek.slice(0, firstPeek.length)).toEqual(firstPeek);
    expect(
      (
        await admin().query<{ confirmed_flush_lsn: string }>(
          'SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name=$1',
          [slot],
        )
      ).rows[0]?.confirmed_flush_lsn,
    ).toBe(before);

    const decoded = decodeSuppressionPgoutput(secondPeek, startLsn);
    expect(decoded.filter((tx) => tx.events.length > 0)).toHaveLength(3);
    const idRows = await admin().query<{ athlete_id: string; event_id: string }>(
      `SELECT athlete_id,event_id::text FROM restore_suppression_event
       WHERE athlete_id=ANY($1::text[])`,
      [Object.values(tenants)],
    );
    const ids = new Map(idRows.rows.map((row) => [row.event_id, row.athlete_id]));
    expect(
      decoded
        .filter((tx) => tx.events.length > 0)
        .map((tx) => tx.events.map((event) => ids.get(event.eventId))),
    ).toEqual([[tenants.committedFirst], [tenants.startedFirst], [tenants.paired]]);
    const envelope = makeLocalSequenceEnvelope({
      clusterId,
      fromLsn: startLsn,
      previousHash: null,
      messages: secondPeek,
    });
    expect(envelope.transactions).toEqual(decoded);
    expect(
      makeLocalSequenceEnvelope({
        clusterId,
        fromLsn: startLsn,
        previousHash: null,
        messages: secondPeek,
      }),
    ).toEqual(envelope);
    expect(JSON.stringify(envelope)).not.toContain(tenants.committedFirst);
    expect(JSON.stringify(envelope)).not.toContain('pgoutput_unrelated_probe');
    verifyLocalSequenceChain([envelope]);
    expect(() => verifyLocalSequenceChain([envelope, envelope])).toThrow('LOCAL_SEQUENCE_GAP');
    expect(() => verifyLocalSequenceChain([{ ...envelope, throughLsn: startLsn }])).toThrow(
      'LOCAL_SEQUENCE_HASH_MISMATCH',
    );
    expect(() => decodeSuppressionPgoutput(secondPeek.slice(0, -1), startLsn)).toThrow(
      'PGOUTPUT_PARTIAL_TRANSACTION',
    );
    const truncatedMessage = secondPeek.map((message) => Buffer.from(message));
    const lastMessage = truncatedMessage.at(-1);
    if (!lastMessage) throw new Error('Commit message missing');
    truncatedMessage[truncatedMessage.length - 1] = lastMessage.subarray(0, lastMessage.length - 1);
    expect(() => decodeSuppressionPgoutput(truncatedMessage, startLsn)).toThrow(
      'PGOUTPUT_PARTIAL_MESSAGE',
    );
    const firstMessage = secondPeek[0];
    if (!firstMessage) throw new Error('Begin message missing');
    expect(() =>
      decodeSuppressionPgoutput(Array<Buffer>(1_001).fill(firstMessage), startLsn),
    ).toThrow('PGOUTPUT_MESSAGES_LIMIT');
    const corruptKind = secondPeek.map((message) => Buffer.from(message));
    const index = corruptKind.findIndex((message) =>
      message.includes(Buffer.from('tenant_erased')),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const kindMessage = corruptKind[index];
    if (!kindMessage) throw new Error('Kind message missing');
    kindMessage.write('tenant_badxxx', kindMessage.indexOf('tenant_erased'));
    expect(() => decodeSuppressionPgoutput(corruptKind, startLsn)).toThrow(
      'PGOUTPUT_UNKNOWN_EVENT',
    );
    const corruptSchema = secondPeek.map((message) => Buffer.from(message));
    const relationIndex = corruptSchema.findIndex((message) => message[0] === 82);
    expect(relationIndex).toBeGreaterThanOrEqual(0);
    const relationMessage = corruptSchema[relationIndex];
    if (!relationMessage) throw new Error('Relation message missing');
    relationMessage.write(
      'restore_suppression_evenX',
      relationMessage.indexOf('restore_suppression_event'),
    );
    expect(() => decodeSuppressionPgoutput(corruptSchema, startLsn)).toThrow(
      'PGOUTPUT_UNEXPECTED_TABLE',
    );
  });
});
