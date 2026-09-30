import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeSuppressionPgoutputRecords,
  makeLocalReplayRecordEnvelope,
  verifyLocalReplayRecordChain,
} from '../src/restore-suppression-pgoutput.js';
import { validateSuppressionRecord } from '../src/restore-suppression-records.js';

const namesAndOids: readonly (readonly [string, number])[] = [
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
];

const targetId = randomUUID();
const shareId = randomUUID();
const base = {
  event_id: randomUUID(),
  record_version: '1',
  athlete_id: 'synthetic-athlete',
  occurred_at: '2026-09-30 12:34:56.123456+00',
};

function values(
  kind: string,
  extra: Record<string, string | null> = {},
): Map<string, string | null> {
  const result = new Map<string, string | null>(namesAndOids.map(([name]) => [name, null]));
  for (const [name, value] of Object.entries({ ...base, kind, ...extra })) result.set(name, value);
  return result;
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}
function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(value);
  return bytes;
}
function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value), Buffer.from([0])]);
}

function messages(row: ReadonlyMap<string, string | null>): Buffer[] {
  const relation = Buffer.concat([
    Buffer.from('R'),
    u32(42),
    cstring('public'),
    cstring('restore_suppression_event'),
    Buffer.from('d'),
    u16(namesAndOids.length),
    ...namesAndOids.flatMap(([name, oid]) => [
      Buffer.from([0]),
      cstring(name),
      u32(oid),
      u32(0xffffffff),
    ]),
  ]);
  const insert = Buffer.concat([
    Buffer.from('I'),
    u32(42),
    Buffer.from('N'),
    u16(namesAndOids.length),
    ...namesAndOids.flatMap(([name]) => {
      const value = row.get(name);
      if (value === null || value === undefined) return [Buffer.from('n')];
      const bytes = Buffer.from(value);
      return [Buffer.from('t'), u32(bytes.length), bytes];
    }),
  ]);
  return [
    Buffer.concat([Buffer.from('B'), u64(0x110n), u64(0n), u32(1)]),
    relation,
    insert,
    Buffer.concat([Buffer.from('C'), Buffer.from([0]), u64(0x110n), u64(0x120n), u64(0n)]),
  ];
}

describe('local replay record decoder', () => {
  it('encodes only kind-specific restore fields for all supported event kinds', () => {
    const cases: readonly [string, Record<string, string | null>, readonly string[]][] = [
      ['tenant_erased', {}, []],
      ['course_deleted', { target_id: targetId }, ['targetId']],
      [
        'activity_deleted',
        {
          target_id: targetId,
          activity_revision: '2',
          source_kind: 'healthkit',
          source_id: 'opaque-source',
          source_revision: '3',
          source_content_hash: 'a'.repeat(64),
        },
        [
          'targetId',
          'activityRevision',
          'sourceKind',
          'sourceId',
          'sourceRevision',
          'sourceContentHash',
        ],
      ],
      [
        'resource_deleted',
        { target_id: targetId, resource_access_revision: '2' },
        ['targetId', 'resourceAccessRevision'],
      ],
      [
        'gallery_media_deleted',
        { target_id: targetId, gallery_access_revision: '2' },
        ['targetId', 'galleryAccessRevision'],
      ],
      [
        'healthkit_consent_transition',
        { consent_revision: '1', consent_granted: 't' },
        ['consentPreviousRevision', 'consentPreviousGranted', 'consentRevision', 'consentGranted'],
      ],
      [
        'ai_consent_transition',
        {
          consent_previous_revision: '1',
          consent_previous_granted: 't',
          consent_revision: '2',
          consent_granted: 'f',
        },
        ['consentPreviousRevision', 'consentPreviousGranted', 'consentRevision', 'consentGranted'],
      ],
      [
        'check_in_deleted',
        { target_id: targetId, check_in_revision: '2' },
        ['targetId', 'checkInRevision'],
      ],
      [
        'resource_share_revoked',
        {
          target_id: targetId,
          share_id: shareId,
          share_granted_access_revision: '1',
          share_revoked_access_revision: '2',
        },
        ['targetId', 'shareId', 'shareGrantedAccessRevision', 'shareRevokedAccessRevision'],
      ],
      [
        'course_share_revoked',
        {
          target_id: targetId,
          course_share_id: shareId,
          course_share_epoch: '1',
          course_share_course_revision: '2',
        },
        ['targetId', 'courseShareId', 'courseShareEpoch', 'courseShareCourseRevision'],
      ],
      [
        'intake_entry_deleted',
        { target_id: targetId, actual_deletion_revision: '2' },
        ['targetId', 'actualDeletionRevision'],
      ],
      [
        'recovery_action_deleted',
        { target_id: targetId, actual_deletion_revision: '2' },
        ['targetId', 'actualDeletionRevision'],
      ],
    ];
    for (const [kind, fields, expected] of cases) {
      const record = validateSuppressionRecord(values(kind, fields));
      expect(record.kind).toBe(kind);
      expect(Object.keys(record)).toEqual([
        'schemaVersion',
        'eventId',
        'athleteId',
        'occurredAt',
        'kind',
        ...expected,
      ]);
      expect(JSON.stringify(record)).not.toContain('idempotency');
    }
  });

  it('rejects unknown, malformed, partial and cross-kind values', () => {
    const caused = validateSuppressionRecord(
      values('resource_share_revoked', {
        record_version: '2',
        target_id: targetId,
        share_id: shareId,
        share_granted_access_revision: '1',
        share_revoked_access_revision: '2',
        share_cause_kind: 'resource_deleted',
        share_cause_event_id: randomUUID(),
      }),
    );
    expect(caused).toMatchObject({ schemaVersion: 2, shareCauseKind: 'resource_deleted' });
    expect(() =>
      validateSuppressionRecord(values('tenant_erased', { record_version: '2' })),
    ).toThrow('PGOUTPUT_UNKNOWN_EVENT');
    expect(() =>
      validateSuppressionRecord(
        values('resource_share_revoked', {
          record_version: '2',
          target_id: targetId,
          share_id: shareId,
          share_granted_access_revision: '1',
          share_revoked_access_revision: '2',
          share_cause_kind: 'tenant_erased',
        }),
      ),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
    expect(
      validateSuppressionRecord(
        values('activity_deleted', {
          target_id: targetId,
          activity_revision: '2',
          source_kind: 'manual',
          source_id: '한'.repeat(200),
          source_revision: '1',
          source_content_hash: 'a'.repeat(64),
        }),
      ),
    ).toMatchObject({ sourceId: '한'.repeat(200) });
    expect(() =>
      validateSuppressionRecord(values('tenant_erased', { athlete_id: '한'.repeat(201) })),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
    expect(() => validateSuppressionRecord(values('unknown'))).toThrow('PGOUTPUT_UNKNOWN_EVENT');
    expect(() => validateSuppressionRecord(values('course_deleted'))).toThrow(
      'PGOUTPUT_INVALID_RECORD',
    );
    expect(() =>
      validateSuppressionRecord(values('tenant_erased', { target_id: targetId })),
    ).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
    expect(() =>
      validateSuppressionRecord(
        values('intake_entry_deleted', { target_id: targetId, actual_deletion_revision: '0' }),
      ),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
    expect(() =>
      validateSuppressionRecord(
        values('ai_consent_transition', {
          consent_previous_revision: '1',
          consent_revision: '2',
          consent_granted: 'f',
        }),
      ),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
    expect(() =>
      validateSuppressionRecord(values('tenant_erased', { occurred_at: '2026-09-30 12:34:56' })),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
    expect(() =>
      validateSuppressionRecord(values('tenant_erased', { occurred_at: '2026-02-30 12:34:56+00' })),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
    expect(() =>
      validateSuppressionRecord(values('tenant_erased', { record_version: '2' })),
    ).toThrow('PGOUTPUT_UNKNOWN_EVENT');
    const missing = values('tenant_erased');
    missing.delete('target_id');
    expect(() => validateSuppressionRecord(missing)).toThrow('PGOUTPUT_SCHEMA_CHANGED');
  });

  it('preserves committed WAL boundaries and exact restore fields in memory', () => {
    const row = values('activity_deleted', {
      target_id: targetId,
      activity_revision: '2',
      source_kind: 'healthkit',
      source_id: 'https://example.invalid/opaque-source',
      source_revision: '3',
      source_content_hash: 'a'.repeat(64),
    });
    const binary = messages(row);
    const transactions = decodeSuppressionPgoutputRecords(binary, '0/100');
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.commitLsn).toBe('0/110');
    expect(transactions[0]?.endLsn).toBe('0/120');
    expect(transactions[0]?.records[0]).toMatchObject({
      kind: 'activity_deleted',
      targetId,
      sourceId: 'https://example.invalid/opaque-source',
    });
    const envelope = makeLocalReplayRecordEnvelope({
      clusterId: '12345',
      fromLsn: '0/100',
      previousHash: null,
      messages: binary,
    });
    expect(envelope.transactions).toEqual(transactions);
    verifyLocalReplayRecordChain([envelope]);
    expect(() => verifyLocalReplayRecordChain([envelope, envelope])).toThrow('LOCAL_RECORD_GAP');
    expect(() => decodeSuppressionPgoutputRecords(binary.slice(0, -1), '0/100')).toThrow(
      'PGOUTPUT_PARTIAL_TRANSACTION',
    );
    const duplicate = [...binary.slice(0, -1), binary[2], binary[3]].filter(
      (item): item is Buffer => item !== undefined,
    );
    expect(() => decodeSuppressionPgoutputRecords(duplicate, '0/100')).toThrow(
      'PGOUTPUT_DUPLICATE_EVENT',
    );
    const unexpected = binary.map((message) => Buffer.from(message));
    const insert = unexpected[2];
    if (!insert) throw new Error('fixture missing insert');
    const marker = insert.indexOf(Buffer.from('activity_deleted'));
    insert.write('activity_unknown', marker);
    expect(() => decodeSuppressionPgoutputRecords(unexpected, '0/100')).toThrow(
      'PGOUTPUT_UNKNOWN_EVENT',
    );
  });
});
