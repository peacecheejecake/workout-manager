import { describe, expect, it } from 'vitest';
import {
  decodeSuppressionPgoutputRecordsV7,
  decodeSuppressionPgoutputRecords,
  decodeSuppressionPgoutput,
  makeLocalReplayRecordEnvelope,
  makeLocalSequenceEnvelope,
  MAX_PGOUTPUT_MESSAGES,
  MAX_PGOUTPUT_BYTES,
} from '../src/restore-suppression-pgoutput.js';
import { decodeSuppressionRecordColumnsV7 } from '../src/restore-suppression-records-v7.js';
const legacyColumns: readonly (readonly [string, number])[] = [
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
  ['healthkit_claim_epoch', 2950],
  ['healthkit_operation_id', 2950],
  ['healthkit_consent_revision', 23],
  ['healthkit_registry_previous_revision', 23],
  ['healthkit_registry_revision', 23],
  ['healthkit_object_scopes', 3802],
  ['race_previous_revision', 23],
  ['race_deleted_revision', 23],
];

const v6Columns: readonly (readonly [string, number])[] = [
  ...legacyColumns,
  ['manual_review_source_kind', 25],
  ['manual_review_source_id', 25],
  ['manual_review_version_scope', 25],
  ['manual_review_version_key', 25],
];
const v7Columns: readonly (readonly [string, number])[] = [
  ...v6Columns,
  ['manual_review_v2_source_identity', 3802],
  ['manual_review_v2_version_scope', 25],
];
const id = '12345678-1234-4123-8123-123456789abc';
const version = '22345678-1234-4123-8123-123456789abc';
function physical(extra: Record<string, string | null> = {}, event = id) {
  const row = new Map<string, string | null>(v7Columns.map(([name]) => [name, null]));
  for (const [key, value] of Object.entries({
    event_id: event,
    record_version: '7',
    athlete_id: 'synthetic',
    kind: 'manual_review_source_suppressed_v2',
    occurred_at: '2026-10-07 12:34:56.123456+00',
    manual_review_v2_source_identity: JSON.stringify({
      kind: 'nutrition-plan-version',
      sourceId: id,
      versionId: version,
    }),
    manual_review_v2_version_scope: 'exact_identity',
    ...extra,
  }))
    row.set(key, value);
  return row;
}
const oldRows = [
  { record_version: '1', kind: 'tenant_erased' },
  {
    record_version: '2',
    kind: 'intake_entry_deleted',
    target_id: id,
    actual_deletion_revision: '2',
    actual_previous_revision_id: id,
    actual_deleted_revision_id: version,
  },
  {
    record_version: '3',
    kind: 'healthkit_workout_deregistration_pending',
    target_id: id,
    healthkit_claim_epoch: id,
    healthkit_operation_id: version,
    healthkit_consent_revision: '1',
    healthkit_registry_previous_revision: '0',
    healthkit_registry_revision: '1',
    healthkit_object_scopes: '[]',
  },
  {
    record_version: '4',
    kind: 'race_event_deleted',
    target_id: id,
    race_previous_revision: '1',
    race_deleted_revision: '2',
  },
  {
    record_version: '5',
    kind: 'app_consent_transition',
    consent_revision: '1',
    consent_granted: 't',
  },
  {
    record_version: '6',
    kind: 'manual_review_source_suppressed',
    manual_review_source_kind: 'race-event',
    manual_review_source_id: id,
    manual_review_version_scope: 'exact_version',
    manual_review_version_key: '1',
  },
];
function oldPhysical(extra: Record<string, string>, event = id) {
  return physical(
    { ...extra, manual_review_v2_source_identity: null, manual_review_v2_version_scope: null },
    event,
  );
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

function messages(
  row: ReadonlyMap<string, string | null>,
  roster: readonly (readonly [string, number])[] = v7Columns,
  commit = 0x110n,
): Buffer[] {
  const relation = Buffer.concat([
    Buffer.from('R'),
    u32(42),
    cstring('public'),
    cstring('restore_suppression_event'),
    Buffer.from('d'),
    u16(roster.length),
    ...roster.flatMap(([name, oid]) => [
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
    u16(roster.length),
    ...roster.flatMap(([name]) => {
      const value = row.get(name);
      if (value === null || value === undefined) return [Buffer.from('n')];
      const bytes = Buffer.from(value);
      return [Buffer.from('t'), u32(bytes.length), bytes];
    }),
  ]);
  return [
    Buffer.concat([Buffer.from('B'), u64(commit), u64(0n), u32(1)]),
    relation,
    insert,
    Buffer.concat([Buffer.from('C'), Buffer.from([0]), u64(commit), u64(commit + 0x10n), u64(0n)]),
  ];
}

describe('explicit V7 synthetic pgoutput structural decoder', () => {
  it('decodes committed V7 exact identity and original microseconds without claiming remote authority', () => {
    const row = physical(),
      decoded = decodeSuppressionPgoutputRecordsV7(messages(row), '0/100');
    expect(decoded).toEqual([
      { commitLsn: '0/110', endLsn: '0/120', records: [decodeSuppressionRecordColumnsV7(row)] },
    ]);
    expect(decoded[0]?.records[0]?.occurredAt).toBe('2026-10-07 12:34:56.123456+00');
  });
  it('decodes mixed old1..6 and V7 committed records only under the exact46-column successor profile', () => {
    const rows = [
      ...oldRows.map((r, index) =>
        oldPhysical(r, `12345678-1234-4123-8123-${(index + 1).toString().padStart(12, '0')}`),
      ),
      physical(),
    ];
    const binary = rows.flatMap((r, index) =>
      messages(r, v7Columns, 0x110n + BigInt(index) * 0x20n),
    );
    expect(decodeSuppressionPgoutputRecordsV7(binary, '0/100').flatMap((t) => t.records)).toEqual(
      rows.map(decodeSuppressionRecordColumnsV7),
    );
  });
  it.each([
    ['legacy40', legacyColumns],
    ['currentV6', v6Columns],
  ] as const)('does not accept %s physical profile through new entry', (_name, roster) => {
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(messages(oldPhysical(oldRows[0] ?? {}), roster), '0/100'),
    ).toThrow('PGOUTPUT_SCHEMA_CHANGED');
  });
  it.each([
    { name: 'records', run: () => decodeSuppressionPgoutputRecords(messages(physical()), '0/100') },
    { name: 'sequence', run: () => decodeSuppressionPgoutput(messages(physical()), '0/100') },
    {
      name: 'record envelope',
      run: () =>
        makeLocalReplayRecordEnvelope({
          clusterId: '1',
          fromLsn: '0/100',
          previousHash: null,
          messages: messages(physical()),
        }),
    },
    {
      name: 'sequence envelope',
      run: () =>
        makeLocalSequenceEnvelope({
          clusterId: '1',
          fromLsn: '0/100',
          previousHash: null,
          messages: messages(physical()),
        }),
    },
  ])('legacy $name remains closed to successor46 physical columns', ({ run }) => {
    expect(run).toThrow('PGOUTPUT_SCHEMA_CHANGED');
  });
  it.each([{ roster: legacyColumns }, { roster: v6Columns }])(
    'preserves legacy committed records and local envelope bytes for old physical rosters',
    ({ roster }) => {
      const binary = messages(oldPhysical(oldRows[0] ?? {}), roster);
      expect(decodeSuppressionPgoutputRecords(binary, '0/100')[0]?.records[0]?.schemaVersion).toBe(
        1,
      );
      const a = makeLocalReplayRecordEnvelope({
        clusterId: '1',
        fromLsn: '0/100',
        previousHash: null,
        messages: binary,
      });
      expect(a.localRecordVersion).toBe(1);
      expect(JSON.stringify(a)).toBe(
        JSON.stringify(
          makeLocalReplayRecordEnvelope({
            clusterId: '1',
            fromLsn: '0/100',
            previousHash: null,
            messages: messages(oldPhysical(oldRows[0] ?? {}), legacyColumns),
          }),
        ),
      );
    },
  );
  it.each([44, 45])('rejects wrong OID at successor field %i', (index) => {
    const roster = v7Columns.map((column, n) =>
      n === index ? ([column[0], 23] as const) : column,
    );
    expect(() => decodeSuppressionPgoutputRecordsV7(messages(physical(), roster), '0/100')).toThrow(
      'PGOUTPUT_SCHEMA_CHANGED',
    );
  });
  it('rejects reordered/unknown columns even with correct count', () => {
    const roster = [...v7Columns];
    const last = roster.pop();
    if (!last) throw Error('fixture');
    roster.unshift(last);
    expect(() => decodeSuppressionPgoutputRecordsV7(messages(physical(), roster), '0/100')).toThrow(
      'PGOUTPUT_SCHEMA_CHANGED',
    );
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        messages(
          physical(),
          v7Columns.map((x, n) => (n === 44 ? (['unknown', 3802] as const) : x)),
        ),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_SCHEMA_CHANGED');
  });
  it('rejects old record populated successor fields and V7 populated old payload', () => {
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        messages(physical({ record_version: '1', kind: 'tenant_erased' })),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(messages(physical({ target_id: id })), '0/100'),
    ).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
  });
  it.each([
    null,
    '{bad',
    JSON.stringify({ kind: 'race-event', sourceId: id, revision: 1, approved: true }),
  ])('rejects missing/malformed/extra identity %s', (value) => {
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        messages(physical({ manual_review_v2_source_identity: value })),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
  });
  it('rejects duplicate event across committed transactions', () => {
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        [...messages(physical()), ...messages(physical(), v7Columns, 0x130n)],
        '0/100',
      ),
    ).toThrow('PGOUTPUT_DUPLICATE_EVENT');
  });
  it('partial transaction and trailing or truncated message never returns a partial record', () => {
    const binary = messages(physical());
    expect(() => decodeSuppressionPgoutputRecordsV7(binary.slice(0, -1), '0/100')).toThrow(
      'PGOUTPUT_PARTIAL_TRANSACTION',
    );
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        binary.map((m, n) => (n === 2 ? m.subarray(0, m.length - 1) : m)),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_PARTIAL_MESSAGE');
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        binary.map((m, n) => (n === 2 ? Buffer.concat([m, Buffer.from([0])]) : m)),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_TRAILING_BYTES');
  });
  it('message/aggregate byte caps and malformed LSN remain enforced before projecting records', () => {
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        Array.from({ length: MAX_PGOUTPUT_MESSAGES + 1 }, () => Buffer.from('x')),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_MESSAGES_LIMIT');
    expect(() =>
      decodeSuppressionPgoutputRecordsV7([Buffer.alloc(MAX_PGOUTPUT_BYTES + 1)], '0/100'),
    ).toThrow('PGOUTPUT_BYTES_LIMIT');
    expect(() => decodeSuppressionPgoutputRecordsV7(messages(physical()), 'not-lsn')).toThrow(
      'INVALID_LSN',
    );
  });
  it('rollback/unknown and bad commit ordering or relationID are rejected', () => {
    expect(() => decodeSuppressionPgoutputRecordsV7([Buffer.from('A')], '0/100')).toThrow(
      'PGOUTPUT_UNSUPPORTED_MESSAGE',
    );
    expect(() => decodeSuppressionPgoutputRecordsV7(messages(physical()), '0/130')).toThrow(
      'PGOUTPUT_INVALID_COMMIT',
    );
    const binary = messages(physical());
    const insert = Buffer.from(binary[2] ?? []);
    insert.writeUInt32BE(99, 1);
    binary[2] = insert;
    expect(() => decodeSuppressionPgoutputRecordsV7(binary, '0/100')).toThrow(
      'PGOUTPUT_UNEXPECTED_INSERT',
    );
  });
  it.each(['private', 'restore_other_event'])(
    'rejects unexpected relation namespace/table %s',
    (value) => {
      const binary = messages(physical());
      const relation = Buffer.concat([
        Buffer.from('R'),
        u32(42),
        cstring(value === 'private' ? 'private' : 'public'),
        cstring(value === 'private' ? 'restore_suppression_event' : value),
      ]);
      binary[1] = relation;
      expect(() => decodeSuppressionPgoutputRecordsV7(binary, '0/100')).toThrow(
        'PGOUTPUT_UNEXPECTED_TABLE',
      );
    },
  );
  it('rejects unsupported unchanged-toast tuple marker and wrong tuple count', () => {
    const binary = messages(physical());
    const toast = Buffer.from(binary[2] ?? []);
    toast[8] = 117;
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        binary.map((m, n) => (n === 2 ? toast : m)),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_UNSUPPORTED_TUPLE');
    const count = Buffer.from(binary[2] ?? []);
    count.writeUInt16BE(45, 6);
    expect(() =>
      decodeSuppressionPgoutputRecordsV7(
        binary.map((m, n) => (n === 2 ? count : m)),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_SCHEMA_CHANGED');
  });
});
