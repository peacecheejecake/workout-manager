import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import type { SuppressionRecord } from './restore-suppression-records.js';
import { decryptReplaySegment } from './restore-suppression-segment.js';

const hash = /^[a-f0-9]{64}$/;
const lsn = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/;
const cluster = /^[1-9]\d{0,19}$/;
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

type SupportedRecord =
  | Extract<
      SuppressionRecord,
      {
        kind:
          | 'tenant_erased'
          | 'course_deleted'
          | 'activity_deleted'
          | 'resource_deleted'
          | 'gallery_media_deleted'
          | 'check_in_deleted';
      }
    >
  | (Extract<
      SuppressionRecord,
      { kind: 'healthkit_consent_transition' | 'ai_consent_transition' }
    > & {
      kind: 'healthkit_consent_transition';
    });
type VerifiedChain = {
  summary: ReplayPreflight;
  transactions: readonly (readonly SupportedRecord[])[];
};
type ReplayInput = {
  segments: readonly Uint8Array[];
  key: Uint8Array;
  keyId: string;
  anchor: TrustedReplayAnchor;
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
function verifyChain(input: ReplayInput): VerifiedChain {
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
  const now = Date.now();
  const seen = new Set<string>();
  const transactions: SupportedRecord[][] = [];
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
      const authenticated: SupportedRecord[] = [];
      for (const record of transaction.records) {
        if (seen.has(record.eventId)) return fail();
        seen.add(record.eventId);
        eventCount++;
        if (
          record.kind !== 'tenant_erased' &&
          record.kind !== 'course_deleted' &&
          record.kind !== 'activity_deleted' &&
          record.kind !== 'resource_deleted' &&
          record.kind !== 'gallery_media_deleted' &&
          record.kind !== 'check_in_deleted' &&
          record.kind !== 'healthkit_consent_transition'
        )
          return fail();
        if (
          !canonicalUuid.test(record.athleteId) ||
          (record.kind !== 'tenant_erased' &&
            record.kind !== 'healthkit_consent_transition' &&
            !('targetId' in record && canonicalUuid.test(record.targetId))) ||
          Date.parse(record.occurredAt) > now
        )
          return fail();
        if (
          record.kind === 'activity_deleted' &&
          (record.activityRevision < 2 ||
            (record.sourceKind === 'healthkit' &&
              (!canonicalUuid.test(record.sourceId) ||
                record.sourceContentHash !== '0'.repeat(64))))
        )
          return fail();
        if (record.kind === 'resource_deleted' && record.resourceAccessRevision > 2147483646)
          return fail();
        if (record.kind === 'gallery_media_deleted' && record.galleryAccessRevision > 2147483646)
          return fail();
        if (
          record.kind === 'check_in_deleted' &&
          (record.checkInRevision < 2 || record.checkInRevision > 2147483646)
        )
          return fail();
        if (
          record.kind === 'healthkit_consent_transition' &&
          (record.consentRevision < 1 ||
            record.consentRevision > 2147483647 ||
            (record.consentPreviousRevision === null) !==
              (record.consentPreviousGranted === null) ||
            (record.consentPreviousRevision === null
              ? record.consentRevision !== 1
              : record.consentPreviousRevision < 1 ||
                record.consentPreviousRevision > 2147483646 ||
                record.consentRevision !== record.consentPreviousRevision + 1))
        )
          return fail();
        if ('consentRevision' in record) {
          authenticated.push({ ...record, kind: 'healthkit_consent_transition' });
        } else {
          authenticated.push(record);
        }
      }
      transactions.push(authenticated);
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
    summary: {
      eventCount,
      segmentCount: segments.length,
      clusterId: anchor.clusterId,
      throughLsn: currentLsn,
      finalLocalHash: currentHash ?? fail(),
    },
    transactions,
  };
}

export function preflightSuppressionReplay(input: ReplayInput): ReplayPreflight {
  return verifyChain(input).summary;
}

/**
 * Owner-only, offline local replay. The caller supplies an independently trusted
 * backup-bound anchor and a dedicated owner pool. Authentication of every byte
 * and every supported record finishes before connecting or writing to PostgreSQL.
 * This does not prove that a remote tail is complete or allow runtime access.
 */
export async function replayVerifiedSuppressionChain(
  input: ReplayInput & {
    ownerPool: Pick<Pool, 'connect'>;
  },
): Promise<ReplayPreflight> {
  const verified = verifyChain(input);
  const client = await input.ownerPool.connect();
  let discard = false;
  let transactionOpen = false;
  let commitAttempted = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SELECT set_config('statement_timeout','5000',true)");
    await client.query("SELECT set_config('lock_timeout','3000',true)");
    for (const records of verified.transactions) {
      for (const record of records) {
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [record.athleteId]);
        if (record.kind === 'tenant_erased') {
          await client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
            record.athleteId,
            record.eventId,
            record.occurredAt,
          ]);
        } else if (record.kind === 'course_deleted') {
          await client.query('SELECT public.replay_course_deletion_exact($1,$2,$3,$4)', [
            record.athleteId,
            record.targetId,
            record.eventId,
            record.occurredAt,
          ]);
        } else if (record.kind === 'activity_deleted') {
          await client.query(
            'SELECT public.replay_activity_deletion_exact($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              record.athleteId,
              record.targetId,
              record.eventId,
              record.occurredAt,
              record.activityRevision,
              record.sourceKind,
              record.sourceId,
              record.sourceRevision,
              record.sourceContentHash,
            ],
          );
        } else if (record.kind === 'resource_deleted') {
          await client.query('SELECT public.replay_resource_deletion_exact($1,$2,$3,$4,$5)', [
            record.athleteId,
            record.targetId,
            record.eventId,
            record.occurredAt,
            record.resourceAccessRevision,
          ]);
        } else if (record.kind === 'gallery_media_deleted') {
          await client.query('SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5)', [
            record.athleteId,
            record.targetId,
            record.eventId,
            record.occurredAt,
            record.galleryAccessRevision,
          ]);
        } else if (record.kind === 'check_in_deleted') {
          await client.query('SELECT public.replay_check_in_deletion_exact($1,$2,$3,$4,$5)', [
            record.athleteId,
            record.targetId,
            record.eventId,
            record.occurredAt,
            record.checkInRevision,
          ]);
        } else {
          await client.query(
            'SELECT public.replay_healthkit_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
            [
              record.athleteId,
              record.eventId,
              record.occurredAt,
              record.consentPreviousRevision,
              record.consentPreviousGranted,
              record.consentRevision,
              record.consentGranted,
            ],
          );
        }
      }
    }
    commitAttempted = true;
    const committed = await client.query('COMMIT');
    transactionOpen = false;
    if (committed.command !== 'COMMIT') throw new Error('RESTORE_REPLAY_NOT_COMMITTED');
    return verified.summary;
  } catch (error) {
    if (commitAttempted) {
      // A lost COMMIT response cannot establish whether PostgreSQL committed.
      // Dispose this connection; an exact-receipt retry resolves the outcome.
      discard = true;
    } else if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
