import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';
import type { SuppressionRecord } from '../src/restore-suppression-records.js';
import {
  preflightSuppressionReplay,
  replayVerifiedSuppressionChain,
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
const defaultAthleteId = '44444444-4444-4444-8444-444444444444';

function record(
  kind: 'tenant_erased' | 'course_deleted' | 'activity_deleted',
  eventId: string,
  athleteId = defaultAthleteId,
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
    firstRecord?: SuppressionRecord;
    secondRecord?: SuppressionRecord;
    sameTransaction?: boolean;
    secondPreviousHash?: string | null;
    secondClusterId?: string;
  } = {},
): { segments: Buffer[]; anchor: TrustedReplayAnchor } {
  const first = envelope({
    fromLsn: '0/100',
    commitLsn: '0/110',
    throughLsn: '0/120',
    previousHash: null,
    records: [
      overrides.firstRecord ?? record('tenant_erased', firstId),
      ...(overrides.sameTransaction
        ? [overrides.secondRecord ?? record('course_deleted', secondId)]
        : []),
    ],
  });
  if (overrides.sameTransaction) {
    const bytes = encryptReplaySegment({ envelope: first, key, keyId }).bytes;
    return {
      segments: [bytes],
      anchor: {
        clusterId,
        fromLsn: '0/100',
        previousHash: null,
        throughLsn: '0/120',
        finalLocalHash: first.sha256,
        ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
      },
    };
  }
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

function singleTransaction(records: SuppressionRecord[]): {
  segments: Buffer[];
  anchor: TrustedReplayAnchor;
} {
  const body = envelope({
    fromLsn: '0/100',
    commitLsn: '0/110',
    throughLsn: '0/120',
    previousHash: null,
    records,
  });
  const bytes = encryptReplaySegment({ envelope: body, key, keyId }).bytes;
  return {
    segments: [bytes],
    anchor: {
      clusterId,
      fromLsn: '0/100',
      previousHash: null,
      throughLsn: '0/120',
      finalLocalHash: body.sha256,
      ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
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

  it('accepts nine supported v1 standalone kinds and rejects incomplete older facts', () => {
    const supported = chain({ secondRecord: record('activity_deleted', secondId) });
    expect(inspect(supported.segments, supported.anchor).eventCount).toBe(2);
    const resource = chain({
      secondRecord: {
        schemaVersion: 1,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'resource_deleted',
        targetId: courseId,
        resourceAccessRevision: 1,
      },
    });
    expect(inspect(resource.segments, resource.anchor).eventCount).toBe(2);
    const gallery = chain({
      secondRecord: {
        schemaVersion: 1,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'gallery_media_deleted',
        targetId: courseId,
        galleryAccessRevision: 2,
      },
    });
    expect(inspect(gallery.segments, gallery.anchor).eventCount).toBe(2);
    const checkIn = chain({
      secondRecord: {
        schemaVersion: 1,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'check_in_deleted',
        targetId: courseId,
        checkInRevision: 2,
      },
    });
    expect(inspect(checkIn.segments, checkIn.anchor).eventCount).toBe(2);
    const healthkit = chain({
      secondRecord: {
        schemaVersion: 1,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'healthkit_consent_transition',
        consentPreviousRevision: null,
        consentPreviousGranted: null,
        consentRevision: 1,
        consentGranted: true,
      },
    });
    expect(inspect(healthkit.segments, healthkit.anchor).eventCount).toBe(2);
    const ai = chain({
      secondRecord: {
        schemaVersion: 1,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'ai_consent_transition',
        consentPreviousRevision: null,
        consentPreviousGranted: null,
        consentRevision: 1,
        consentGranted: true,
      },
    });
    expect(inspect(ai.segments, ai.anchor).eventCount).toBe(2);
    const share = chain({
      firstRecord: record('course_deleted', firstId),
      secondRecord: {
        schemaVersion: 1,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'resource_share_revoked',
        targetId: courseId,
        shareId: firstId,
        shareGrantedAccessRevision: 2,
        shareRevokedAccessRevision: 3,
      },
    });
    expect(inspect(share.segments, share.anchor).eventCount).toBe(2);
    const base = {
      schemaVersion: 1 as const,
      eventId: secondId,
      athleteId: defaultAthleteId,
      occurredAt,
    };
    const unsupported: SuppressionRecord[] = [
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

  it('accepts complete v2 course-share and actual deletion records', () => {
    const courseShare: SuppressionRecord = {
      schemaVersion: 2,
      eventId: secondId,
      athleteId: defaultAthleteId,
      occurredAt,
      kind: 'course_share_revoked',
      targetId: courseId,
      courseShareId: '55555555-5555-4555-8555-555555555555',
      courseShareEpoch: 3,
      courseShareCourseRevision: 2,
      courseShareRevokeReason: 'owner_all',
      courseShareAuditId: '66666666-6666-4666-8666-666666666666',
      courseShareAuditOccurredAt: '2026-09-30 12:34:57+00',
    };
    const actual: SuppressionRecord = {
      schemaVersion: 2,
      eventId: secondId,
      athleteId: defaultAthleteId,
      occurredAt,
      kind: 'intake_entry_deleted',
      targetId: courseId,
      actualDeletionRevision: 2,
      actualPreviousRevisionId: '55555555-5555-4555-8555-555555555555',
      actualDeletedRevisionId: '66666666-6666-4666-8666-666666666666',
    };
    for (const item of [
      courseShare,
      actual,
      { ...actual, kind: 'recovery_action_deleted' as const },
    ]) {
      const sample = chain({ firstRecord: record('course_deleted', firstId), secondRecord: item });
      expect(inspect(sample.segments, sample.anchor).eventCount).toBe(2);
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

  it('rejects IDs that the exact database replay functions would reject', () => {
    for (const altered of [
      record('tenant_erased', secondId, 'owner'),
      { ...record('course_deleted', secondId), targetId: '33333333-3333-0333-8333-333333333333' },
      { ...record('activity_deleted', secondId), activityRevision: 1 },
      {
        ...record('activity_deleted', secondId),
        sourceKind: 'healthkit' as const,
        sourceId: courseId,
        sourceContentHash: 'a'.repeat(64),
      },
      {
        schemaVersion: 1 as const,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'gallery_media_deleted' as const,
        targetId: '33333333-3333-0333-8333-333333333333',
        galleryAccessRevision: 2,
      },
      {
        schemaVersion: 1 as const,
        eventId: secondId,
        athleteId: defaultAthleteId,
        occurredAt,
        kind: 'check_in_deleted' as const,
        targetId: '33333333-3333-0333-8333-333333333333',
        checkInRevision: 2,
      },
    ]) {
      const sample = chain({ secondRecord: altered });
      expect(() => inspect(sample.segments, sample.anchor)).toThrow(
        'RESTORE_REPLAY_PREFLIGHT_FAILED',
      );
    }
  });

  it('never connects for a tampered later segment or an unsupported kind', async () => {
    const pool = new Pool({
      connectionString: 'postgresql://invalid@127.0.0.1:1/none',
      connectionTimeoutMillis: 100,
    });
    const connect = vi.spyOn(pool, 'connect');
    try {
      const good = chain();
      const tampered = good.segments.map((bytes) => Buffer.from(bytes));
      const last = tampered[1];
      if (!last) throw new Error('bad fixture');
      last[last.length - 1] = (last[last.length - 1] ?? 0) ^ 1;
      await expect(
        replayVerifiedSuppressionChain({
          ...good,
          segments: tampered,
          key,
          keyId,
          ownerPool: pool,
        }),
      ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      const unsupported = chain({
        secondRecord: {
          schemaVersion: 1,
          eventId: secondId,
          athleteId: defaultAthleteId,
          occurredAt,
          kind: 'course_share_revoked',
          targetId: courseId,
          courseShareId: firstId,
          courseShareEpoch: 1,
          courseShareCourseRevision: 1,
        },
      });
      await expect(
        replayVerifiedSuppressionChain({ ...unsupported, key, keyId, ownerPool: pool }),
      ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      const compound = chain({
        sameTransaction: true,
        firstRecord: {
          schemaVersion: 1,
          eventId: firstId,
          athleteId: defaultAthleteId,
          occurredAt,
          kind: 'resource_deleted',
          targetId: courseId,
          resourceAccessRevision: 3,
        },
        secondRecord: {
          schemaVersion: 1,
          eventId: secondId,
          athleteId: defaultAthleteId,
          occurredAt,
          kind: 'resource_share_revoked',
          targetId: courseId,
          shareId: firstId,
          shareGrantedAccessRevision: 2,
          shareRevokedAccessRevision: 3,
        },
      });
      await expect(
        replayVerifiedSuppressionChain({ ...compound, key, keyId, ownerPool: pool }),
      ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      await pool.end();
    }
  });

  it('accepts authenticated version-2 parent-child transactions in source order', () => {
    const parent: SuppressionRecord = {
      schemaVersion: 1,
      eventId: firstId,
      athleteId: defaultAthleteId,
      occurredAt,
      kind: 'resource_deleted',
      targetId: courseId,
      resourceAccessRevision: 3,
    };
    const child: SuppressionRecord = {
      schemaVersion: 2,
      eventId: secondId,
      athleteId: defaultAthleteId,
      occurredAt,
      kind: 'resource_share_revoked',
      targetId: courseId,
      shareId: '55555555-5555-4555-8555-555555555555',
      shareGrantedAccessRevision: 2,
      shareRevokedAccessRevision: 3,
      shareCauseKind: 'resource_deleted',
      shareCauseEventId: firstId,
    };
    const resource = chain({ sameTransaction: true, firstRecord: parent, secondRecord: child });
    expect(inspect(resource.segments, resource.anchor).eventCount).toBe(2);
    const erasure = chain({
      sameTransaction: true,
      firstRecord: {
        ...child,
        eventId: firstId,
        shareCauseKind: 'tenant_erased',
        shareCauseEventId: secondId,
      },
      secondRecord: record('tenant_erased', secondId),
    });
    expect(inspect(erasure.segments, erasure.anchor).eventCount).toBe(2);
  });

  it('rejects forged or misordered version-2 parent-child relationships before connecting', async () => {
    const parent: SuppressionRecord = {
      schemaVersion: 1,
      eventId: firstId,
      athleteId: defaultAthleteId,
      occurredAt,
      kind: 'resource_deleted',
      targetId: courseId,
      resourceAccessRevision: 3,
    };
    const child: SuppressionRecord = {
      schemaVersion: 2,
      eventId: secondId,
      athleteId: defaultAthleteId,
      occurredAt,
      kind: 'resource_share_revoked',
      targetId: courseId,
      shareId: '55555555-5555-4555-8555-555555555555',
      shareGrantedAccessRevision: 2,
      shareRevokedAccessRevision: 3,
      shareCauseKind: 'resource_deleted',
      shareCauseEventId: firstId,
    };
    const invalid = [
      chain({ sameTransaction: true, firstRecord: child, secondRecord: parent }),
      chain({
        sameTransaction: true,
        firstRecord: parent,
        secondRecord: { ...child, shareCauseEventId: courseId },
      }),
      chain({
        sameTransaction: true,
        firstRecord: parent,
        secondRecord: { ...child, shareRevokedAccessRevision: 4 },
      }),
      chain({ firstRecord: parent, secondRecord: child }),
      singleTransaction([
        parent,
        record('course_deleted', '66666666-6666-4666-8666-666666666666'),
        child,
      ]),
      chain({
        sameTransaction: true,
        firstRecord: parent,
        secondRecord: { ...child, occurredAt: '2026-09-30 12:34:55+00' },
      }),
    ];
    const pool = new Pool({ connectionString: 'postgresql://invalid@127.0.0.1:1/none' });
    const connect = vi.spyOn(pool, 'connect');
    try {
      for (const candidate of invalid) {
        await expect(
          replayVerifiedSuppressionChain({ ...candidate, key, keyId, ownerPool: pool }),
        ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      }
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      await pool.end();
    }
  });
});
