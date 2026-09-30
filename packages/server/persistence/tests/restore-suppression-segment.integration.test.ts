import { createHash } from 'node:crypto';
import type * as Crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';
import type { SuppressionRecord } from '../src/restore-suppression-records.js';
import { decryptReplaySegment, encryptReplaySegment } from '../src/restore-suppression-segment.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof Crypto>();
  let nextNonce = 0;
  return {
    ...original,
    randomBytes: (length: number) => Buffer.alloc(length, nextNonce++),
  };
});

const key = Buffer.alloc(32, 7);
const keyId = 'test-key-v1';
const sensitiveSource = 'https://private.example/민감한-source-id';
const athleteId = 'private-athlete';
const eventId = '33333333-3333-4333-8333-333333333333';
const targetId = '44444444-4444-4444-8444-444444444444';

function fixture(sourceId = sensitiveSource): LocalReplayRecordEnvelope {
  const body = {
    localRecordVersion: 1 as const,
    clusterId: '123456789',
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: 'b'.repeat(64),
    transactions: [
      {
        commitLsn: '0/110',
        endLsn: '0/120',
        records: [
          {
            schemaVersion: 1 as const,
            eventId,
            athleteId,
            occurredAt: '2026-09-30 12:34:56.123456+00',
            kind: 'activity_deleted' as const,
            targetId,
            activityRevision: 2,
            sourceKind: 'healthkit' as const,
            sourceId,
            sourceRevision: 3,
            sourceContentHash: 'a'.repeat(64),
          },
        ],
      },
    ],
  };
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

function withRecord(record: SuppressionRecord): LocalReplayRecordEnvelope {
  const source = fixture();
  const body = {
    localRecordVersion: source.localRecordVersion,
    clusterId: source.clusterId,
    fromLsn: source.fromLsn,
    throughLsn: source.throughLsn,
    previousHash: source.previousHash,
    transactions: [{ commitLsn: '0/110', endLsn: '0/120', records: [record] }],
  };
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

function errorMessage(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('EXPECTED_ERROR');
}

describe('encrypted restore suppression segment', () => {
  it('keeps v1 standalone shares and authenticates v2 parent causes', () => {
    const share = {
      eventId,
      athleteId,
      occurredAt: '2026-09-30 12:34:56.123456+00',
      kind: 'resource_share_revoked' as const,
      targetId,
      shareId: '55555555-5555-4555-8555-555555555555',
      shareGrantedAccessRevision: 2,
      shareRevokedAccessRevision: 3,
    };
    const old = withRecord({ schemaVersion: 1, ...share });
    const caused = withRecord({
      schemaVersion: 2,
      ...share,
      shareCauseKind: 'resource_deleted',
      shareCauseEventId: '66666666-6666-4666-8666-666666666666',
    });
    for (const envelope of [old, caused]) {
      const encrypted = encryptReplaySegment({ envelope, key, keyId });
      expect(decryptReplaySegment({ bytes: encrypted.bytes, key, expectedKeyId: keyId })).toEqual(
        envelope,
      );
    }
    expect(() =>
      encryptReplaySegment({
        envelope: withRecord({ schemaVersion: 2, ...share, shareCauseKind: 'tenant_erased' }),
        key,
        keyId,
      }),
    ).toThrow('INVALID_ENCRYPTED_SEGMENT');
  });

  it('round-trips canonical authenticated content without exposing sensitive record fields', () => {
    const source = fixture();
    const first = encryptReplaySegment({ envelope: source, key, keyId });
    const second = encryptReplaySegment({ envelope: source, key, keyId });
    expect(first.bytes.equals(second.bytes)).toBe(false);
    expect(first.bytes.includes(Buffer.from(sensitiveSource))).toBe(false);
    expect(first.bytes.includes(Buffer.from(athleteId))).toBe(false);
    expect(first.bytes.includes(Buffer.from(eventId))).toBe(false);
    expect(first.byteLength).toBe(first.bytes.length);
    expect(first.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));
    expect(decryptReplaySegment({ bytes: first.bytes, key, expectedKeyId: keyId })).toEqual(source);
  });

  it('rejects wrong key, key ID, tag, header, LSN byte, record byte and truncation', () => {
    const { bytes } = encryptReplaySegment({ envelope: fixture(), key, keyId });
    const invalid: Uint8Array[] = [
      Buffer.from(bytes.subarray(0, -1)),
      Buffer.from(bytes.subarray(0, 10)),
      Buffer.from(bytes),
      Buffer.from(bytes),
      Buffer.from(bytes),
      Buffer.from(bytes),
    ];
    const headerEnd = 12 + bytes.readUInt32BE(8);
    const headerText = bytes.subarray(12, headerEnd).toString();
    const lsnOffset = headerText.indexOf('0/100');
    expect(lsnOffset).toBeGreaterThanOrEqual(0);
    function flip(sample: Uint8Array | undefined, offset: number): void {
      if (!sample || sample[offset] === undefined) throw new Error('BAD_TEST_FIXTURE');
      sample[offset] ^= 1;
    }
    flip(invalid[2], bytes.length - 1); // GCM tag
    flip(invalid[3], 12); // authenticated header
    flip(invalid[4], 12 + lsnOffset); // authenticated LSN field
    flip(invalid[5], headerEnd + 5); // encrypted record body
    for (const sample of invalid) {
      expect(
        errorMessage(() => decryptReplaySegment({ bytes: sample, key, expectedKeyId: keyId })),
      ).toBe('INVALID_ENCRYPTED_SEGMENT');
    }
    expect(
      errorMessage(() =>
        decryptReplaySegment({ bytes, key: Buffer.alloc(32, 8), expectedKeyId: keyId }),
      ),
    ).toBe('INVALID_ENCRYPTED_SEGMENT');
    expect(errorMessage(() => decryptReplaySegment({ bytes, key, expectedKeyId: 'other' }))).toBe(
      'INVALID_ENCRYPTED_SEGMENT',
    );
  });

  it('fails closed on invalid key, unvalidated record mutation, inconsistent LSN and size', () => {
    const source = fixture();
    const mutated = structuredClone(source);
    const record = mutated.transactions[0]?.records[0];
    if (!record || record.kind !== 'activity_deleted') throw new Error('BAD_TEST_FIXTURE');
    record.sourceId = 'changed private source';
    const invalidInputs = [
      () => encryptReplaySegment({ envelope: source, key: Buffer.alloc(31), keyId }),
      () => encryptReplaySegment({ envelope: source, key, keyId: '../invalid key' }),
      () => encryptReplaySegment({ envelope: mutated, key, keyId }),
      () =>
        encryptReplaySegment({
          envelope: { ...source, throughLsn: '0/130' },
          key,
          keyId,
        }),
      () =>
        encryptReplaySegment({
          envelope: {
            ...source,
            transactions: Array.from({ length: 1001 }, () => {
              const first = source.transactions[0];
              if (!first) throw new Error('BAD_TEST_FIXTURE');
              return first;
            }),
          },
          key,
          keyId,
        }),
    ];
    for (const operation of invalidInputs) {
      const message = errorMessage(operation);
      expect(message).toBe('INVALID_ENCRYPTED_SEGMENT');
      expect(message).not.toContain(sensitiveSource);
      expect(message).not.toContain(athleteId);
    }
  });

  it('counts Unicode code points in source IDs like the database decoder', () => {
    const accepted = fixture('😀'.repeat(200));
    const bytes = encryptReplaySegment({ envelope: accepted, key, keyId }).bytes;
    expect(decryptReplaySegment({ bytes, key, expectedKeyId: keyId })).toEqual(accepted);
    expect(
      errorMessage(() => encryptReplaySegment({ envelope: fixture('😀'.repeat(201)), key, keyId })),
    ).toBe('INVALID_ENCRYPTED_SEGMENT');
  });

  it('rejects authenticated but invalid kind-specific relationships', () => {
    const base = {
      schemaVersion: 1 as const,
      eventId,
      athleteId,
      occurredAt: '2026-09-30 12:34:56.123456+00',
    };
    const cases: SuppressionRecord[] = [
      { ...base, kind: 'intake_entry_deleted', targetId, actualDeletionRevision: 1 },
      {
        ...base,
        kind: 'resource_share_revoked',
        targetId,
        shareId: '55555555-5555-4555-8555-555555555555',
        shareGrantedAccessRevision: 3,
        shareRevokedAccessRevision: 2,
      },
      {
        ...base,
        kind: 'healthkit_consent_transition',
        consentPreviousRevision: null,
        consentPreviousGranted: true,
        consentRevision: 1,
        consentGranted: false,
      },
      {
        ...base,
        kind: 'ai_consent_transition',
        consentPreviousRevision: 1,
        consentPreviousGranted: false,
        consentRevision: 3,
        consentGranted: true,
      },
    ];
    for (const record of cases) {
      expect(
        errorMessage(() => encryptReplaySegment({ envelope: withRecord(record), key, keyId })),
      ).toBe('INVALID_ENCRYPTED_SEGMENT');
    }
  });
});
