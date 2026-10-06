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

function messages(row: ReadonlyMap<string, string | null>, roster = namesAndOids): Buffer[] {
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

  it.each([
    'healthkit_claim_epoch',
    'healthkit_operation_id',
    'healthkit_consent_revision',
    'healthkit_registry_previous_revision',
    'healthkit_registry_revision',
    'healthkit_object_scopes',
  ])('rejects %s on v2 actual deletion', (field) => {
    expect(() =>
      validateSuppressionRecord(
        values('intake_entry_deleted', {
          record_version: '2',
          target_id: targetId,
          actual_deletion_revision: '2',
          actual_previous_revision_id: randomUUID(),
          actual_deleted_revision_id: randomUUID(),
          [field]:
            field === 'healthkit_object_scopes'
              ? '[]'
              : field.endsWith('_revision')
                ? '1'
                : randomUUID(),
        }),
      ),
    ).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
  });

  it('authenticates bounded v3 workout deregistration epochs and rejects foreign fields', () => {
    const fields = {
      record_version: '3',
      target_id: targetId,
      healthkit_claim_epoch: randomUUID(),
      healthkit_operation_id: randomUUID(),
      healthkit_consent_revision: '1',
      healthkit_registry_previous_revision: '0',
      healthkit_registry_revision: '1',
      healthkit_object_scopes: JSON.stringify([{ kind: 'activity', id: randomUUID() }]),
    };
    for (const kind of [
      'healthkit_workout_deregistration_pending',
      'healthkit_workout_deregistration_released',
    ]) {
      const row = values(kind, fields);
      const record = validateSuppressionRecord(row);
      expect(record).toMatchObject({
        schemaVersion: 3,
        kind,
        healthKitRegistryPreviousRevision: 0,
        healthKitRegistryRevision: 1,
      });
      expect(decodeSuppressionPgoutputRecords(messages(row), '0/100')[0]?.records).toEqual([
        record,
      ]);
      for (const invalid of [
        { record_version: '2' },
        { healthkit_registry_revision: '2' },
        { healthkit_claim_epoch: randomUUID().toUpperCase() },
        {
          healthkit_object_scopes: JSON.stringify([
            { kind: 'activity', id: targetId },
            { kind: 'activity', id: targetId },
          ]),
        },
        {
          healthkit_object_scopes: JSON.stringify([
            { kind: 'activity', id: targetId, extra: true },
          ]),
        },
        { source_id: 'foreign' },
      ])
        expect(() => validateSuppressionRecord(values(kind, { ...fields, ...invalid }))).toThrow();
    }
  });

  it('accepts complete future course and actual provenance while preserving v1 shape', () => {
    const auditId = randomUUID();
    const previousId = randomUUID();
    const deletedId = randomUUID();
    expect(
      validateSuppressionRecord(
        values('course_share_revoked', {
          record_version: '2',
          target_id: targetId,
          course_share_id: shareId,
          course_share_epoch: '3',
          course_share_course_revision: '2',
          course_share_revoke_reason: 'owner_all',
          course_share_audit_id: auditId,
          course_share_audit_occurred_at: '2026-09-30 12:34:57+00',
        }),
      ),
    ).toMatchObject({
      schemaVersion: 2,
      courseShareRevokeReason: 'owner_all',
      courseShareAuditId: auditId,
    });
    expect(
      validateSuppressionRecord(
        values('intake_entry_deleted', {
          record_version: '2',
          target_id: targetId,
          actual_deletion_revision: '2',
          actual_previous_revision_id: previousId,
          actual_deleted_revision_id: deletedId,
        }),
      ),
    ).toMatchObject({
      schemaVersion: 2,
      actualPreviousRevisionId: previousId,
      actualDeletedRevisionId: deletedId,
    });
    for (const [kind, fields] of [
      [
        'course_share_revoked',
        {
          target_id: targetId,
          course_share_id: shareId,
          course_share_epoch: '3',
          course_share_course_revision: '2',
          course_share_revoke_reason: 'owner',
        },
      ],
      [
        'recovery_action_deleted',
        {
          target_id: targetId,
          actual_deletion_revision: '2',
          actual_previous_revision_id: previousId,
        },
      ],
    ] as const)
      expect(() => validateSuppressionRecord(values(kind, fields))).toThrow(
        'PGOUTPUT_INVALID_RECORD',
      );
    expect(() =>
      validateSuppressionRecord(
        values('course_share_revoked', {
          record_version: '2',
          target_id: targetId,
          course_share_id: shareId,
          course_share_epoch: '3',
          course_share_course_revision: '2',
          course_share_revoke_reason: 'owner',
          course_share_audit_id: auditId,
          course_share_audit_occurred_at: '2026-09-30 12:34:55+00',
        }),
      ),
    ).toThrow('PGOUTPUT_INVALID_RECORD');
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

describe('v4 race deletion minimal records', () => {
  it.each(['race_event_deleted', 'race_result_deleted', 'training_best_deleted'])(
    'decodes %s and terminal privacy deletion without extra values',
    (kind) => {
      for (const [previous, deleted] of [
        [1, 2],
        [2147483647, 2147483647],
      ]) {
        const row = values(kind, {
          record_version: '4',
          target_id: targetId,
          race_previous_revision: String(previous),
          race_deleted_revision: String(deleted),
        });
        const decoded = validateSuppressionRecord(row);
        expect(decoded).toEqual({
          schemaVersion: 4,
          eventId: base.event_id,
          athleteId: base.athlete_id,
          occurredAt: base.occurred_at,
          kind,
          targetId,
          racePreviousRevision: previous,
          raceDeletedRevision: deleted,
        });
        expect(decodeSuppressionPgoutputRecords(messages(row), '0/100')[0]?.records).toEqual([
          decoded,
        ]);
        for (const extra of [
          { race_deleted_revision: String(previous === 1 ? 1 : 2147483646) },
          { record_version: '1' },
          { race_previous_revision: '0' },
          { source_id: 'forbidden' },
          { healthkit_operation_id: shareId },
          { target_id: null },
        ])
          expect(() =>
            validateSuppressionRecord(new Map([...row, ...Object.entries(extra)])),
          ).toThrow();
      }
    },
  );
  it('keeps legacy discriminator strict when new columns exist', () => {
    const row = values('tenant_erased');
    expect(validateSuppressionRecord(row).kind).toBe('tenant_erased');
    for (const extra of [
      { record_version: '4' },
      { race_previous_revision: '1', race_deleted_revision: '2' },
    ])
      expect(() =>
        validateSuppressionRecord(new Map([...row, ...Object.entries(extra)])),
      ).toThrow();
  });
});

it('accepts only v5 app transitions with exact nullable one-step epochs and closed payloads', () => {
  const app = {
    record_version: '5',
    consent_previous_revision: null,
    consent_previous_granted: null,
    consent_revision: '1',
    consent_granted: 't',
  };
  expect(validateSuppressionRecord(values('app_consent_transition', app))).toMatchObject({
    schemaVersion: 5,
    kind: 'app_consent_transition',
    consentPreviousRevision: null,
    consentPreviousGranted: null,
    consentRevision: 1,
    consentGranted: true,
  });
  expect(
    validateSuppressionRecord(
      values('app_consent_transition', {
        ...app,
        consent_previous_revision: '2147483646',
        consent_previous_granted: 'f',
        consent_revision: '2147483647',
      }),
    ),
  ).toMatchObject({ consentRevision: 2147483647 });
  for (const change of [
    { record_version: '1' },
    { record_version: '2' },
    { record_version: '3' },
    { record_version: '4' },
    { record_version: '6' },
    { consent_revision: '2' },
    { consent_previous_granted: 'f' },
    { consent_granted: null },
    { consent_granted: 'true' },
    { consent_previous_revision: '1', consent_previous_granted: 't', consent_revision: '3' },
    { target_id: targetId },
    { race_previous_revision: '1' },
    { healthkit_registry_revision: '1' },
    { occurred_at: '2026-02-30 00:00:00+00' },
  ])
    expect(() =>
      validateSuppressionRecord(values('app_consent_transition', { ...app, ...change })),
    ).toThrow();
  expect(() => validateSuppressionRecord(values('ai_consent_transition', app))).toThrow();
  expect(() => validateSuppressionRecord(values('healthkit_consent_transition', app))).toThrow();
});

const manualColumns: readonly (readonly [string, number])[] = [
  ['manual_review_source_kind', 25],
  ['manual_review_source_id', 25],
  ['manual_review_version_scope', 25],
  ['manual_review_version_key', 25],
];
function manualValues(extra: Record<string, string | null> = {}) {
  const row = values('manual_review_source_suppressed', { record_version: '6' });
  for (const [name] of manualColumns) row.set(name, null);
  for (const [name, value] of Object.entries({
    manual_review_source_kind: 'race-event',
    manual_review_source_id: targetId,
    manual_review_version_scope: 'exact_version',
    manual_review_version_key: '1',
    ...extra,
  }))
    row.set(name, value);
  return row;
}
describe('forward106 manual review record boundary (synthetic bytes)', () => {
  it.each([
    ['race-event', '2147483647'],
    ['plan-snapshot', '1'],
    ['nutrition-plan-version', targetId],
    ['recovery-strategy-version', targetId],
    ['routine-schedule-version', targetId],
    ['routine-blueprint-version', targetId],
    ['routine-occurrence', 'immutable'],
    ['routine-run', '0'],
    ['session-completion', JSON.stringify([targetId, 2147483647])],
  ])('decodes exact identity %s without inventing a source deletion', (kind, key) => {
    const row = manualValues({ manual_review_source_kind: kind, manual_review_version_key: key });
    expect(validateSuppressionRecord(row)).toMatchObject({
      schemaVersion: 6,
      kind: 'manual_review_source_suppressed',
      manualReviewSourceKind: kind,
      manualReviewVersionKey: key,
    });
    expect(
      decodeSuppressionPgoutputRecords(
        messages(row, [...namesAndOids, ...manualColumns]),
        '0/100',
      )[0]?.records,
    ).toEqual([validateSuppressionRecord(row)]);
  });
  it('allows all-version null scope, retains old40 and old versions in new44', () => {
    expect(
      validateSuppressionRecord(
        manualValues({
          manual_review_version_scope: 'all_versions',
          manual_review_version_key: null,
        }),
      ),
    ).toMatchObject({ manualReviewVersionKey: null });
    const old = values('tenant_erased');
    const extended = new Map(old);
    for (const [name] of manualColumns) extended.set(name, null);
    expect(validateSuppressionRecord(extended)).toEqual(validateSuppressionRecord(old));
    expect(
      decodeSuppressionPgoutputRecords(
        messages(extended, [...namesAndOids, ...manualColumns]),
        '0/100',
      )[0]?.records,
    ).toEqual([validateSuppressionRecord(old)]);
    extended.set('manual_review_source_kind', 'race-event');
    expect(() => validateSuppressionRecord(extended)).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
    expect(() =>
      validateSuppressionRecord(values('manual_review_source_suppressed', { record_version: '6' })),
    ).toThrow();
  });
  it.each([
    { manual_review_source_kind: 'unknown' },
    { manual_review_source_id: targetId.toUpperCase() },
    { manual_review_source_id: '' },
    { manual_review_version_scope: null },
    { manual_review_version_scope: 'latest' },
    { manual_review_version_key: null },
    { manual_review_version_key: '01' },
    { manual_review_version_key: '2147483648' },
    { manual_review_version_scope: 'all_versions' },
    { target_id: targetId },
    { source_id: 'forged' },
    { record_version: '5' },
    {
      manual_review_source_kind: 'session-completion',
      manual_review_version_key: JSON.stringify([targetId, 0]),
    },
    {
      manual_review_source_kind: 'session-completion',
      manual_review_version_key: '[ "' + targetId + '",1]',
    },
    { manual_review_source_kind: 'routine-run', manual_review_version_key: '-1' },
    { manual_review_source_kind: 'routine-occurrence', manual_review_version_key: '1' },
  ])('rejects malformed identity or old payload %j', (change) => {
    expect(() => validateSuppressionRecord(manualValues(change))).toThrow();
  });
  it('preserves versions2..5 with four explicit NULL columns and rejects each leaked field', () => {
    const rows = [
      values('intake_entry_deleted', {
        record_version: '2',
        target_id: targetId,
        actual_deletion_revision: '2',
        actual_previous_revision_id: targetId,
        actual_deleted_revision_id: shareId,
      }),
      values('healthkit_workout_deregistration_pending', {
        record_version: '3',
        target_id: targetId,
        healthkit_claim_epoch: targetId,
        healthkit_operation_id: shareId,
        healthkit_consent_revision: '1',
        healthkit_registry_previous_revision: '0',
        healthkit_registry_revision: '1',
        healthkit_object_scopes: '[]',
      }),
      values('race_event_deleted', {
        record_version: '4',
        target_id: targetId,
        race_previous_revision: '1',
        race_deleted_revision: '2',
      }),
      values('app_consent_transition', {
        record_version: '5',
        consent_revision: '1',
        consent_granted: 'f',
      }),
    ];
    for (const old of rows) {
      const extended = new Map(old);
      for (const [name] of manualColumns) extended.set(name, null);
      expect(validateSuppressionRecord(extended)).toEqual(validateSuppressionRecord(old));
      for (const [name] of manualColumns) {
        const invalid = new Map(extended);
        invalid.set(name, 'unexpected');
        expect(() => validateSuppressionRecord(invalid)).toThrow('PGOUTPUT_UNEXPECTED_FIELD');
      }
    }
  });
  it('uses the SQL106 canonical namespace for UUIDv7 sources, immutable keys and session Plan tuples', () => {
    const v7 = '12345678-abcd-7abc-8def-123456789abc';
    for (const change of [
      { manual_review_source_id: v7 },
      {
        manual_review_source_kind: 'nutrition-plan-version',
        manual_review_source_id: v7,
        manual_review_version_key: v7,
      },
      {
        manual_review_source_kind: 'session-completion',
        manual_review_source_id: 'session-v7',
        manual_review_version_key: JSON.stringify([v7, 1]),
      },
    ]) {
      const row = manualValues(change);
      expect(validateSuppressionRecord(row).kind).toBe('manual_review_source_suppressed');
      expect(
        decodeSuppressionPgoutputRecords(
          messages(row, [...namesAndOids, ...manualColumns]),
          '0/100',
        )[0]?.records,
      ).toEqual([validateSuppressionRecord(row)]);
    }
    for (const change of [
      { manual_review_source_id: v7.toUpperCase() },
      {
        manual_review_source_kind: 'nutrition-plan-version',
        manual_review_version_key: v7.toUpperCase(),
      },
      {
        manual_review_source_kind: 'session-completion',
        manual_review_version_key: JSON.stringify([v7.toUpperCase(), 1]),
      },
    ])
      expect(() => validateSuppressionRecord(manualValues(change))).toThrow(
        'PGOUTPUT_INVALID_RECORD',
      );
  });
  it('rejects wrong appended OID, reorder and incomplete roster', () => {
    const row = manualValues();
    const roster = [...namesAndOids, ...manualColumns];
    expect(() =>
      decodeSuppressionPgoutputRecords(
        messages(row, [
          ...namesAndOids,
          ...manualColumns.map(([name, oid]) => [name, oid === 25 ? 23 : oid] as const),
        ]),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_SCHEMA_CHANGED');
    expect(() =>
      decodeSuppressionPgoutputRecords(
        messages(row, [...namesAndOids, ...[...manualColumns].reverse()]),
        '0/100',
      ),
    ).toThrow('PGOUTPUT_SCHEMA_CHANGED');
    expect(() =>
      decodeSuppressionPgoutputRecords(messages(row, roster.slice(0, -1)), '0/100'),
    ).toThrow('PGOUTPUT_SCHEMA_CHANGED');
  });
});
