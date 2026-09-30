import { createHash } from 'node:crypto';

import { decryptReplaySegment } from './restore-suppression-segment.js';

const hash = /^[a-f0-9]{64}$/;
const lsn = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/;
const cluster = /^[1-9]\d{0,19}$/;
const MAX_CHAIN_BYTES = 64 * 1024 * 1024;

/**
 * This anchor must come from an independently trusted, backup-bound manifest.
 * A caller may not infer it from the segments it is asking us to inspect.
 */
export type TrustedReplayAnchor = {
  clusterId: string;
  fromLsn: string;
  previousHash: string | null;
  throughLsn: string;
  finalLocalHash: string;
  ciphertextHashes: readonly string[];
};

export type ReplayPreflight = {
  eventCount: number;
  segmentCount: number;
  clusterId: string;
  throughLsn: string;
  finalLocalHash: string;
};

function fail(): never {
  throw new Error('RESTORE_REPLAY_PREFLIGHT_FAILED');
}

function lsnValue(value: string): bigint {
  if (!lsn.test(value)) return fail();
  const [high, low] = value.split('/');
  if (!high || !low) return fail();
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}

/**
 * Authenticates the entire supplied chain before any restore write is possible.
 * It rejects unsupported record kinds. Passing this check never writes to the
 * database and is not proof that a backup/tail fence or access gate exists.
 */
export function preflightSuppressionReplay(input: {
  segments: readonly Uint8Array[];
  key: Uint8Array;
  keyId: string;
  anchor: TrustedReplayAnchor;
}): ReplayPreflight {
  const { anchor, segments } = input;
  if (
    !cluster.test(anchor.clusterId) ||
    !lsn.test(anchor.fromLsn) ||
    !lsn.test(anchor.throughLsn) ||
    (anchor.previousHash !== null && !hash.test(anchor.previousHash)) ||
    !hash.test(anchor.finalLocalHash) ||
    segments.length < 1 ||
    segments.length > 256 ||
    anchor.ciphertextHashes.length !== segments.length ||
    anchor.ciphertextHashes.some((value) => !hash.test(value)) ||
    segments.reduce((total, bytes) => total + bytes.byteLength, 0) > MAX_CHAIN_BYTES ||
    lsnValue(anchor.fromLsn) >= lsnValue(anchor.throughLsn)
  )
    return fail();

  let currentLsn = anchor.fromLsn;
  let currentHash = anchor.previousHash;
  let eventCount = 0;
  const seen = new Set<string>();
  for (let index = 0; index < segments.length; index++) {
    const bytes = segments[index];
    const expectedHash = anchor.ciphertextHashes[index];
    if (!bytes || !expectedHash) return fail();
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) return fail();
    let envelope;
    try {
      envelope = decryptReplaySegment({ bytes, key: input.key, expectedKeyId: input.keyId });
    } catch {
      return fail();
    }
    if (
      envelope.clusterId !== anchor.clusterId ||
      lsnValue(envelope.fromLsn) !== lsnValue(currentLsn) ||
      envelope.previousHash !== currentHash ||
      lsnValue(envelope.throughLsn) > lsnValue(anchor.throughLsn)
    )
      return fail();
    for (const transaction of envelope.transactions) {
      for (const record of transaction.records) {
        if (seen.has(record.eventId)) return fail();
        seen.add(record.eventId);
        eventCount++;
        if (record.kind !== 'tenant_erased' && record.kind !== 'course_deleted') return fail();
      }
    }
    currentLsn = envelope.throughLsn;
    currentHash = envelope.sha256;
  }
  if (lsnValue(currentLsn) !== lsnValue(anchor.throughLsn) || currentHash !== anchor.finalLocalHash)
    return fail();
  // The encrypted v1 codec requires at least one event, so this is unreachable
  // for valid input. Keep it as a defensive assertion for future codecs.
  if (eventCount === 0) return fail();
  return {
    eventCount,
    segmentCount: segments.length,
    clusterId: anchor.clusterId,
    throughLsn: currentLsn,
    finalLocalHash: currentHash ?? fail(),
  };
}
