import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';
import type { SuppressionRecord } from '../src/restore-suppression-records.js';
import {
  preflightSuppressionReplay,
  type TrustedReplayAnchor,
} from '../src/restore-suppression-replay.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';

const key = Buffer.alloc(32, 29);
const keyId = 'local-test-key';
const clusterId = '123456789';
const occurredAt = '2026-09-30 12:34:56+00';
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const courseId = '33333333-3333-4333-8333-333333333333';

function record(
  kind: 'tenant_erased' | 'course_deleted' | 'activity_deleted',
  eventId: string,
  athleteId = 'owner',
): SuppressionRecord {
  const base = { schemaVersion: 1 as const, eventId, athleteId, occurredAt };
  if (kind === 'tenant_erased') return { ...base, kind };
  if (kind === 'course_deleted') return { ...base, kind, targetId: courseId };
  return {
    ...base,
    kind,
    targetId: courseId,
    activityRevision: 2,
    sourceKind: 'manual',
    sourceId: 'synthetic-source',
    sourceRevision: 1,
    sourceContentHash: 'a'.repeat(64),
  };
}

function envelope(input: {
  fromLsn: string;
  commitLsn: string;
  throughLsn: string;
  previousHash: string | null;
  records: SuppressionRecord[];
  clusterId?: string;
}): LocalReplayRecordEnvelope {
  const body = {
    localRecordVersion: 1 as const,
    clusterId: input.clusterId ?? clusterId,
    fromLsn: input.fromLsn,
    throughLsn: input.throughLsn,
    previousHash: input.previousHash,
    transactions: [
      { commitLsn: input.commitLsn, endLsn: input.throughLsn, records: input.records },
    ],
  };
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

function chain(
  overrides: {
    secondRecord?: SuppressionRecord;
    secondPreviousHash?: string | null;
    secondClusterId?: string;
  } = {},
): { segments: Buffer[]; anchor: TrustedReplayAnchor } {
  const first = envelope({
    fromLsn: '0/100',
    commitLsn: '0/110',
    throughLsn: '0/120',
    previousHash: null,
    records: [record('tenant_erased', firstId)],
  });
  const second = envelope({
    fromLsn: '0/120',
    commitLsn: '0/130',
    throughLsn: '0/140',
    previousHash:
      overrides.secondPreviousHash === undefined ? first.sha256 : overrides.secondPreviousHash,
    records: [overrides.secondRecord ?? record('course_deleted', secondId)],
    ...(overrides.secondClusterId ? { clusterId: overrides.secondClusterId } : {}),
  });
  const segments = [first, second].map(
    (item) => encryptReplaySegment({ envelope: item, key, keyId }).bytes,
  );
  return {
    segments,
    anchor: {
      clusterId,
      fromLsn: '0/100',
      previousHash: null,
      throughLsn: '0/140',
      finalLocalHash: second.sha256,
      ciphertextHashes: segments.map((bytes) => createHash('sha256').update(bytes).digest('hex')),
    },
  };
}

const inspect = (segments: readonly Uint8Array[], anchor: TrustedReplayAnchor) =>
  preflightSuppressionReplay({ segments, anchor, key, keyId });

describe('restore suppression local preflight', () => {
  it('authenticates a complete two-segment chain against an explicit trusted test anchor', () => {
    const { segments, anchor } = chain();
    expect(inspect(segments, anchor)).toEqual({
      eventCount: 2,
      segmentCount: 2,
      clusterId,
      throughLsn: '0/140',
      finalLocalHash: anchor.finalLocalHash,
    });
  });

  it('rejects tamper, missing, reversed, duplicate and substituted segments', () => {
    const { segments, anchor } = chain();
    const tampered = segments.map((bytes) => Buffer.from(bytes));
    const last = tampered[1];
    if (!last) throw new Error('bad fixture');
    last[last.length - 1] = (last[last.length - 1] ?? 0) ^ 1;
    for (const invalid of [
      tampered,
      [segments[0]],
      [segments[1], segments[0]],
      [segments[0], segments[0]],
    ])
      expect(() =>
        inspect(
          invalid.filter((item): item is Buffer => !!item),
          anchor,
        ),
      ).toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
    const alternate = chain();
    expect(() => inspect(alternate.segments, anchor)).toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
  });

  it('rejects broken links, duplicate event IDs and a different cluster', () => {
    for (const sample of [
      chain({ secondPreviousHash: 'a'.repeat(64) }),
      chain({ secondRecord: record('course_deleted', firstId) }),
      chain({ secondClusterId: '987654321' }),
    ])
      expect(() => inspect(sample.segments, sample.anchor)).toThrow(
        'RESTORE_REPLAY_PREFLIGHT_FAILED',
      );
  });

  it('rejects any unsupported kind before a replay caller can write', () => {
    const base = { schemaVersion: 1 as const, eventId: secondId, athleteId: 'owner', occurredAt };
    const unsupported: SuppressionRecord[] = [
      record('activity_deleted', secondId),
      { ...base, kind: 'resource_deleted', targetId: courseId, resourceAccessRevision: 1 },
      { ...base, kind: 'gallery_media_deleted', targetId: courseId, galleryAccessRevision: 1 },
      {
        ...base,
        kind: 'healthkit_consent_transition',
        consentPreviousRevision: null,
        consentPreviousGranted: null,
        consentRevision: 1,
        consentGranted: true,
      },
      {
        ...base,
        kind: 'ai_consent_transition',
        consentPreviousRevision: null,
        consentPreviousGranted: null,
        consentRevision: 1,
        consentGranted: true,
      },
      { ...base, kind: 'check_in_deleted', targetId: courseId, checkInRevision: 2 },
      {
        ...base,
        kind: 'resource_share_revoked',
        targetId: courseId,
        shareId: firstId,
        shareGrantedAccessRevision: 1,
        shareRevokedAccessRevision: 2,
      },
      {
        ...base,
        kind: 'course_share_revoked',
        targetId: courseId,
        courseShareId: firstId,
        courseShareEpoch: 1,
        courseShareCourseRevision: 1,
      },
      { ...base, kind: 'intake_entry_deleted', targetId: courseId, actualDeletionRevision: 2 },
      { ...base, kind: 'recovery_action_deleted', targetId: courseId, actualDeletionRevision: 2 },
    ];
    for (const item of unsupported) {
      const sample = chain({ secondRecord: item });
      expect(() => inspect(sample.segments, sample.anchor)).toThrow(
        'RESTORE_REPLAY_PREFLIGHT_FAILED',
      );
    }
  });

  it('rejects unknown, incomplete or caller-shifted test anchor values', () => {
    const { segments, anchor } = chain();
    for (const modified of [
      { ...anchor, clusterId: '2' },
      { ...anchor, fromLsn: '0/101' },
      { ...anchor, throughLsn: '0/130' },
      { ...anchor, finalLocalHash: 'f'.repeat(64) },
      { ...anchor, ciphertextHashes: [] },
    ])
      expect(() => inspect(segments, modified)).toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
  });
});
