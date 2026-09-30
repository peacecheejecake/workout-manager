import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  validateSuppressionRecord,
  type SuppressionRecord,
} from './restore-suppression-records.js';

// This is a local, content-free sequence envelope. It cannot replay a deletion.
// In particular, its hash is not a remote durability acknowledgement.
export const LOCAL_SEQUENCE_VERSION = 1;
export const SUPPRESSION_PUBLICATION = 'workout_restore_suppression_events';
export const MAX_PGOUTPUT_MESSAGES = 1_000;
export const MAX_PGOUTPUT_BYTES = 2 * 1024 * 1024;

const columns = [
  ['event_id', 2950],
  ['record_version', 23],
  ['athlete_id', 25],
  ['kind', 25],
  ['occurred_at', 1184],
  ['target_id', 2950],
  ['activity_revision', 23],
  ['source_kind', 25],
  ['source_id', 25],
  ['source_revision', 23],
  ['source_content_hash', 25],
  ['resource_access_revision', 23],
  ['gallery_access_revision', 23],
  ['consent_previous_revision', 23],
  ['consent_previous_granted', 16],
  ['consent_revision', 23],
  ['consent_granted', 16],
  ['check_in_revision', 23],
  ['share_id', 2950],
  ['share_granted_access_revision', 23],
  ['share_revoked_access_revision', 23],
  ['course_share_id', 2950],
  ['course_share_epoch', 23],
  ['course_share_course_revision', 23],
  ['actual_deletion_revision', 23],
  ['share_cause_kind', 25],
  ['share_cause_event_id', 2950],
  ['course_share_revoke_reason', 25],
  ['course_share_audit_id', 2950],
  ['course_share_audit_occurred_at', 1184],
  ['actual_previous_revision_id', 2950],
  ['actual_deleted_revision_id', 2950],
] as const;

const kinds = new Set([
  'tenant_erased',
  'course_deleted',
  'activity_deleted',
  'resource_deleted',
  'gallery_media_deleted',
  'healthkit_consent_transition',
  'ai_consent_transition',
  'check_in_deleted',
  'resource_share_revoked',
  'course_share_revoked',
  'intake_entry_deleted',
  'recovery_action_deleted',
]);

export type SequenceEvent = { eventId: string; kind: string };
export type SequenceTransaction = {
  commitLsn: string;
  endLsn: string;
  events: SequenceEvent[];
};
export type ReplayRecordTransaction = {
  commitLsn: string;
  endLsn: string;
  records: SuppressionRecord[];
};
export type LocalReplayRecordEnvelope = {
  localRecordVersion: 1;
  clusterId: string;
  fromLsn: string;
  throughLsn: string;
  previousHash: string | null;
  transactions: ReplayRecordTransaction[];
  sha256: string;
};
export type LocalSequenceEnvelope = {
  localSequenceVersion: 1;
  clusterId: string;
  fromLsn: string;
  throughLsn: string;
  previousHash: string | null;
  transactions: SequenceTransaction[];
  sha256: string;
};

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}

  byte(): number {
    this.need(1);
    const value = this.bytes[this.offset++];
    if (value === undefined) throw new Error('PGOUTPUT_PARTIAL_MESSAGE');
    return value;
  }
  uint16(): number {
    this.need(2);
    const value = this.bytes.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  uint32(): number {
    this.need(4);
    const value = this.bytes.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  uint64(): bigint {
    this.need(8);
    const value = this.bytes.readBigUInt64BE(this.offset);
    this.offset += 8;
    return value;
  }
  skip(count: number): void {
    this.need(count);
    this.offset += count;
  }
  string(count: number): string {
    this.need(count);
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(
        this.bytes.subarray(this.offset, this.offset + count),
      );
    } catch {
      throw new Error('PGOUTPUT_INVALID_UTF8');
    }
    this.offset += count;
    if (Buffer.byteLength(value) !== count) throw new Error('PGOUTPUT_INVALID_UTF8');
    return value;
  }
  cstring(): string {
    const end = this.bytes.indexOf(0, this.offset);
    if (end < 0) throw new Error('PGOUTPUT_PARTIAL_MESSAGE');
    const value = this.string(end - this.offset);
    this.skip(1);
    return value;
  }
  done(): void {
    if (this.offset !== this.bytes.length) throw new Error('PGOUTPUT_TRAILING_BYTES');
  }
  private need(count: number): void {
    if (count < 0 || this.offset + count > this.bytes.length)
      throw new Error('PGOUTPUT_PARTIAL_MESSAGE');
  }
}

function lsn(value: bigint): string {
  return `${(value >> 32n).toString(16).toUpperCase()}/${(value & 0xffffffffn).toString(16).toUpperCase()}`;
}

function lsnValue(value: string): bigint {
  if (!/^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/.test(value)) throw new Error('INVALID_LSN');
  const [high, low] = value.split('/');
  if (!high || !low || high.length > 8 || low.length > 8) throw new Error('INVALID_LSN');
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}

function tuple(reader: Reader): Map<string, string | null> {
  const count = reader.uint16();
  if (count !== columns.length) throw new Error('PGOUTPUT_SCHEMA_CHANGED');
  const values = new Map<string, string | null>();
  for (const [name] of columns) {
    const marker = reader.byte();
    if (marker === 110) {
      values.set(name, null);
      continue;
    } // n = SQL NULL
    if (marker !== 116) throw new Error('PGOUTPUT_UNSUPPORTED_TUPLE'); // t = text
    const length = reader.uint32();
    if (length > MAX_PGOUTPUT_BYTES) throw new Error('PGOUTPUT_BYTES_LIMIT');
    values.set(name, reader.string(length));
  }
  return values;
}

function validateRelation(reader: Reader): number {
  const relationId = reader.uint32();
  if (reader.cstring() !== 'public' || reader.cstring() !== 'restore_suppression_event') {
    throw new Error('PGOUTPUT_UNEXPECTED_TABLE');
  }
  reader.byte(); // replica identity; publication emits only INSERT.
  if (reader.uint16() !== columns.length) throw new Error('PGOUTPUT_SCHEMA_CHANGED');
  for (const [name, oid] of columns) {
    reader.byte(); // key flag
    if (reader.cstring() !== name || reader.uint32() !== oid)
      throw new Error('PGOUTPUT_SCHEMA_CHANGED');
    reader.uint32(); // type modifier
  }
  reader.done();
  return relationId;
}

/** Decode a complete, bounded pgoutput peek without advancing its logical slot. */
function decodePgoutput<T>(
  messages: readonly Buffer[],
  fromLsn: string,
  project: (values: Map<string, string | null>) => T,
  id: (value: T) => string,
): { commitLsn: string; endLsn: string; events: T[] }[] {
  if (messages.length > MAX_PGOUTPUT_MESSAGES) throw new Error('PGOUTPUT_MESSAGES_LIMIT');
  if (messages.reduce((sum, message) => sum + message.length, 0) > MAX_PGOUTPUT_BYTES) {
    throw new Error('PGOUTPUT_BYTES_LIMIT');
  }
  const transactions: { commitLsn: string; endLsn: string; events: T[] }[] = [];
  const eventIds = new Set<string>();
  let relationId: number | null = null;
  let pending: { finalLsn: bigint; events: T[] } | null = null;
  let previous = lsnValue(fromLsn);
  for (const message of messages) {
    const reader = new Reader(message);
    const type = reader.byte();
    if (type === 66) {
      // Begin
      if (pending) throw new Error('PGOUTPUT_NESTED_TRANSACTION');
      const finalLsn = reader.uint64();
      reader.skip(8); // PostgreSQL epoch commit timestamp
      reader.uint32(); // xid, not a continuity proof
      reader.done();
      pending = { finalLsn, events: [] };
    } else if (type === 82) {
      // Relation
      if (!pending) throw new Error('PGOUTPUT_RELATION_OUTSIDE_TRANSACTION');
      relationId = validateRelation(reader);
    } else if (type === 73) {
      // Insert
      if (
        !pending ||
        relationId === null ||
        reader.uint32() !== relationId ||
        reader.byte() !== 78
      ) {
        throw new Error('PGOUTPUT_UNEXPECTED_INSERT');
      }
      const values = tuple(reader);
      reader.done();
      const projected = project(values);
      const eventId = id(projected);
      if (eventIds.has(eventId)) throw new Error('PGOUTPUT_DUPLICATE_EVENT');
      eventIds.add(eventId);
      pending.events.push(projected);
    } else if (type === 67) {
      // Commit
      if (!pending) throw new Error('PGOUTPUT_COMMIT_WITHOUT_BEGIN');
      if (reader.byte() !== 0) throw new Error('PGOUTPUT_UNSUPPORTED_COMMIT_FLAG');
      const commit = reader.uint64();
      const end = reader.uint64();
      reader.skip(8);
      reader.done();
      if (commit !== pending.finalLsn || commit < previous || end <= commit) {
        throw new Error('PGOUTPUT_INVALID_COMMIT');
      }
      transactions.push({ commitLsn: lsn(commit), endLsn: lsn(end), events: pending.events });
      previous = end;
      pending = null;
    } else {
      throw new Error('PGOUTPUT_UNSUPPORTED_MESSAGE');
    }
  }
  if (pending) throw new Error('PGOUTPUT_PARTIAL_TRANSACTION');
  return transactions;
}

export function decodeSuppressionPgoutput(
  messages: readonly Buffer[],
  fromLsn: string,
): SequenceTransaction[] {
  return decodePgoutput(
    messages,
    fromLsn,
    (values) => {
      const record = validateSuppressionRecord(values);
      return { eventId: record.eventId, kind: record.kind };
    },
    (event) => event.eventId,
  );
}

/** Complete committed records in memory. Caller must not log or persist this local diagnostic output. */
export function decodeSuppressionPgoutputRecords(
  messages: readonly Buffer[],
  fromLsn: string,
): ReplayRecordTransaction[] {
  return decodePgoutput(
    messages,
    fromLsn,
    validateSuppressionRecord,
    (record) => record.eventId,
  ).map(({ commitLsn, endLsn, events }) => ({ commitLsn, endLsn, records: events }));
}

function digest(value: Omit<LocalSequenceEnvelope, 'sha256'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function makeLocalSequenceEnvelope(input: {
  clusterId: string;
  fromLsn: string;
  previousHash: string | null;
  messages: readonly Buffer[];
}): LocalSequenceEnvelope {
  if (!/^[0-9]+$/.test(input.clusterId)) throw new Error('INVALID_CLUSTER_ID');
  if (input.previousHash !== null && !/^[a-f0-9]{64}$/.test(input.previousHash))
    throw new Error('INVALID_PREVIOUS_HASH');
  const transactions = decodeSuppressionPgoutput(input.messages, input.fromLsn);
  if (!transactions.some((transaction) => transaction.events.length > 0)) {
    throw new Error('EMPTY_SEQUENCE_ENVELOPE');
  }
  const lastTransaction = transactions.at(-1);
  if (!lastTransaction) throw new Error('EMPTY_SEQUENCE_ENVELOPE');
  const throughLsn = lastTransaction.endLsn;
  const body = {
    localSequenceVersion: LOCAL_SEQUENCE_VERSION,
    clusterId: input.clusterId,
    fromLsn: input.fromLsn,
    throughLsn,
    previousHash: input.previousHash,
    transactions,
  } as const;
  return { ...body, sha256: digest(body) };
}

/** Build an in-memory record envelope. No caller may treat its hash as an external ack. */
export function makeLocalReplayRecordEnvelope(input: {
  clusterId: string;
  fromLsn: string;
  previousHash: string | null;
  messages: readonly Buffer[];
}): LocalReplayRecordEnvelope {
  if (!/^[1-9]\d{0,19}$/.test(input.clusterId)) throw new Error('INVALID_CLUSTER_ID');
  if (input.previousHash !== null && !/^[a-f0-9]{64}$/.test(input.previousHash))
    throw new Error('INVALID_PREVIOUS_HASH');
  const fromLsn = lsn(lsnValue(input.fromLsn));
  const transactions = decodeSuppressionPgoutputRecords(input.messages, fromLsn);
  if (!transactions.some((transaction) => transaction.records.length > 0))
    throw new Error('EMPTY_RECORD_ENVELOPE');
  const last = transactions.at(-1);
  if (!last) throw new Error('EMPTY_RECORD_ENVELOPE');
  const body = {
    localRecordVersion: 1 as const,
    clusterId: input.clusterId,
    fromLsn,
    throughLsn: last.endLsn,
    previousHash: input.previousHash,
    transactions,
  };
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

/** Verifies only the supplied in-memory chain; it cannot prove missing WAL or tail coverage. */
export function verifyLocalReplayRecordChain(
  envelopes: readonly LocalReplayRecordEnvelope[],
): void {
  let previous: LocalReplayRecordEnvelope | null = null;
  const seen = new Set<string>();
  for (const envelope of envelopes) {
    const { sha256, ...body } = envelope;
    if (
      body.localRecordVersion !== 1 ||
      createHash('sha256').update(JSON.stringify(body)).digest('hex') !== sha256
    )
      throw new Error('LOCAL_RECORD_HASH_MISMATCH');
    if (!previous && body.previousHash !== null) throw new Error('LOCAL_RECORD_GAP');
    if (
      previous &&
      (body.clusterId !== previous.clusterId ||
        body.fromLsn !== previous.throughLsn ||
        body.previousHash !== previous.sha256)
    )
      throw new Error('LOCAL_RECORD_GAP');
    let cursor = lsnValue(body.fromLsn);
    let count = 0;
    for (const transaction of body.transactions) {
      const commit = lsnValue(transaction.commitLsn);
      const end = lsnValue(transaction.endLsn);
      if (commit < cursor || end <= commit) throw new Error('LOCAL_RECORD_ORDER');
      for (const record of transaction.records) {
        if (seen.has(record.eventId)) throw new Error('LOCAL_RECORD_EVENT_CONFLICT');
        seen.add(record.eventId);
        count += 1;
      }
      cursor = end;
    }
    if (count === 0) throw new Error('EMPTY_RECORD_ENVELOPE');
    if (body.throughLsn !== lsn(cursor)) throw new Error('LOCAL_RECORD_END_MISMATCH');
    previous = envelope;
  }
}

/** Checks local envelope ordering and continuity; not WAL or remote-tail completeness. */
export function verifyLocalSequenceChain(envelopes: readonly LocalSequenceEnvelope[]): void {
  let previous: LocalSequenceEnvelope | null = null;
  const seen = new Set<string>();
  for (const envelope of envelopes) {
    const { sha256, ...body } = envelope;
    if (body.localSequenceVersion !== LOCAL_SEQUENCE_VERSION || digest(body) !== sha256) {
      throw new Error('LOCAL_SEQUENCE_HASH_MISMATCH');
    }
    if (!previous && body.previousHash !== null) throw new Error('LOCAL_SEQUENCE_GAP');
    if (
      previous &&
      (body.clusterId !== previous.clusterId ||
        body.fromLsn !== previous.throughLsn ||
        body.previousHash !== previous.sha256)
    )
      throw new Error('LOCAL_SEQUENCE_GAP');
    let cursor = lsnValue(body.fromLsn);
    let eventCount = 0;
    for (const transaction of body.transactions) {
      const commit = lsnValue(transaction.commitLsn);
      const end = lsnValue(transaction.endLsn);
      if (commit < cursor || end <= commit) throw new Error('LOCAL_SEQUENCE_ORDER');
      for (const event of transaction.events) {
        if (!kinds.has(event.kind) || seen.has(event.eventId))
          throw new Error('LOCAL_SEQUENCE_EVENT_CONFLICT');
        seen.add(event.eventId);
        eventCount += 1;
      }
      cursor = end;
    }
    if (eventCount === 0) throw new Error('EMPTY_SEQUENCE_ENVELOPE');
    if (body.throughLsn !== lsn(cursor)) throw new Error('LOCAL_SEQUENCE_END_MISMATCH');
    previous = envelope;
  }
}

export async function peekSuppressionPgoutput(
  pool: Pick<PoolClient, 'query'>,
  slotName: string,
): Promise<Buffer[]> {
  if (!/^wm_suppression_[a-z0-9_]{1,40}$/.test(slotName)) throw new Error('INVALID_SLOT_NAME');
  const result = await pool.query<{ data: Buffer }>(
    `SELECT data FROM pg_logical_slot_peek_binary_changes(
      $1,NULL,$2,'proto_version','1','publication_names','workout_restore_suppression_events')`,
    [slotName, MAX_PGOUTPUT_MESSAGES + 1],
  );
  if (result.rows.length > MAX_PGOUTPUT_MESSAGES) throw new Error('PGOUTPUT_MESSAGES_LIMIT');
  const messages = result.rows.map((row) => row.data);
  if (messages.reduce((sum, message) => sum + message.length, 0) > MAX_PGOUTPUT_BYTES) {
    throw new Error('PGOUTPUT_BYTES_LIMIT');
  }
  return messages;
}
