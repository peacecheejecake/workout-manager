import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  decryptReplaySegmentV8,
  MAX_ENCRYPTED_SEGMENT_BYTES,
  suppressionSourceBindingV8Schema,
  type LocalReplayRecordEnvelopeV8,
  type SuppressionSourceBindingV8,
} from './restore-suppression-segment.js';
import {
  planSuppressionReplayTransactionV8,
  replaySuppressionPlansV8In,
  type SuppressionReplayPlanV8,
} from './restore-suppression-replay.js';
import type { SuppressionRemoteStore } from './restore-suppression-coordinator.js';

// SQL145 successor of the V7 head/chain protocol: a distinct head format (3), HMAC domain,
// segment magic and relation profile, so V7 and V8 objects can never be exchanged. Records
// 1-6 keep the legacy semantic checks, record 7 is readable but never replayed (no
// original-event stage exists), record 8 replays only through the exact owner-only SQL145
// function. Local HMAC is not a remote witness; nothing here opens processing admission.

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const lsn = z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/);
const MAX_HEAD_BYTES = 128 * 1024;
const MAX_CHAIN_BYTES = 64 * 1024 * 1024;
const domain = 'wm-suppression-head-v8-v3\0';
const remoteSegment = z.strictObject({
  segmentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  versionId: z.string().min(1).max(1000),
  sha256: hash,
  byteLength: z.number().int().min(1).max(MAX_ENCRYPTED_SEGMENT_BYTES),
  fromLsn: lsn,
  throughLsn: lsn,
  previousHash: hash.nullable(),
  localHash: hash,
});
export const suppressionHeadV8Schema = z.strictObject({
  formatVersion: z.literal(3),
  source: suppressionSourceBindingV8Schema,
  clusterId: z.string().regex(/^[1-9]\d{0,19}$/),
  fromLsn: lsn,
  throughLsn: lsn,
  previousHash: hash.nullable(),
  finalLocalHash: hash.nullable(),
  segments: z.array(remoteSegment).max(256),
});
export type SuppressionHeadV8 = z.infer<typeof suppressionHeadV8Schema>;
function fail(): never {
  throw new Error('RESTORE_V8_CHAIN_INVALID');
}
function key(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) return fail();
  return Buffer.from(value);
}
function position(value: string): bigint {
  const [high, low] = value.split('/');
  if (!high || !low) return fail();
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}
function boundedParse(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_HEAD_BYTES) return fail();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail();
  }
}
function checkedHead(value: unknown): SuppressionHeadV8 {
  const result = suppressionHeadV8Schema.safeParse(value);
  if (!result.success) return fail();
  const head = result.data;
  let cursor = head.fromLsn,
    previous = head.previousHash,
    total = 0;
  const versions = new Set<string>();
  for (const segment of head.segments) {
    const identity = JSON.stringify([segment.segmentId, segment.versionId]);
    if (
      versions.has(identity) ||
      segment.fromLsn !== cursor ||
      segment.previousHash !== previous ||
      position(segment.throughLsn) <= position(cursor)
    )
      return fail();
    versions.add(identity);
    total += segment.byteLength;
    cursor = segment.throughLsn;
    previous = segment.localHash;
  }
  if (total > MAX_CHAIN_BYTES || head.throughLsn !== cursor || head.finalLocalHash !== previous)
    return fail();
  return head;
}
/** Separately provisioned authentication key; this local HMAC is not a remote witness. */
export function encodeSuppressionHeadV8(value: unknown, authenticationKey: Uint8Array): Buffer {
  const head = checkedHead(value);
  const body = Buffer.from(JSON.stringify(head), 'utf8');
  const mac = createHmac('sha256', key(authenticationKey))
    .update(domain)
    .update(body)
    .digest('hex');
  const bytes = Buffer.from(JSON.stringify({ body: body.toString('base64'), mac }), 'utf8');
  if (bytes.byteLength > MAX_HEAD_BYTES) return fail();
  return bytes;
}
export function decodeSuppressionHeadV8(
  bytes: Uint8Array,
  authenticationKey: Uint8Array,
): SuppressionHeadV8 {
  const wrapper = z
    .strictObject({ body: z.string().max(MAX_HEAD_BYTES), mac: hash })
    .safeParse(boundedParse(bytes));
  if (!wrapper.success) return fail();
  const body = Buffer.from(wrapper.data.body, 'base64');
  if (body.toString('base64') !== wrapper.data.body) return fail();
  const expected = createHmac('sha256', key(authenticationKey))
    .update(domain)
    .update(body)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(wrapper.data.mac, 'hex'))) return fail();
  const head = checkedHead(boundedParse(body));
  if (!body.equals(Buffer.from(JSON.stringify(head), 'utf8'))) return fail();
  return head;
}
export type SuppressionHeadWitnessV8 = {
  /** Supplied independently of the object currently being read, not inferred from it. */
  source: SuppressionSourceBindingV8;
  clusterId: string;
  fromLsn: string;
  previousHash: string | null;
  throughLsn: string;
  finalLocalHash: string;
  headVersionId: string;
  headSha256: string;
};
export type VerifiedSuppressionChainV8 = {
  readonly status: 'verified_local_chain';
  readonly eventCount: number;
  readonly segmentCount: number;
  readonly authority: 'none';
  readonly admissionAllowed: false;
  /** 'exact_replay' only when no record 7 event is present (see replay below). */
  readonly originalEventStage: 'exact_replay' | 'unavailable';
};
/** Immutable callback view of validated protocol records, not SQL stage authority. */
type ReadonlyProtocolValue<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyProtocolValue<Item>[]
  : T extends object
    ? { readonly [Field in keyof T]: ReadonlyProtocolValue<T[Field]> }
    : T;
export type ReadonlySuppressionReplayRecordEnvelopeV8 =
  ReadonlyProtocolValue<LocalReplayRecordEnvelopeV8>;
export type VerifiedSuppressionChainReadLimitsV8 = Readonly<{
  authority: 'none';
  admissionAllowed: false;
  originalEventStage: 'exact_replay' | 'unavailable';
  witnessFreshness: 'not_rechecked';
  verificationInstant: number;
  eventCount: number;
  segmentCount: number;
}>;
/** Exact immutable objects, authenticated head and full local chain are checked before any apply. */
const witnessSchema = suppressionHeadV8Schema
  .omit({ formatVersion: true, segments: true })
  .extend({
    finalLocalHash: hash,
    headVersionId: z.string().min(1).max(1000),
    headSha256: hash,
  })
  .strict();

export function createSuppressionReplayVerifierV8(configuration: {
  witness: SuppressionHeadWitnessV8;
  encryptionKey: Uint8Array;
  keyId: string;
  headAuthenticationKey: Uint8Array;
  now?: () => number;
}) {
  const input = {
    ...configuration,
    witness: witnessSchema.parse(configuration.witness),
    encryptionKey: key(configuration.encryptionKey),
    headAuthenticationKey: key(configuration.headAuthenticationKey),
  };
  const verifiedChains = new WeakMap<
    VerifiedSuppressionChainV8,
    { readonly encryptedSegments: readonly Uint8Array[]; readonly verificationInstant: number }
  >();
  async function prepareVerifiedSuppressionChainV8(
    store: Pick<SuppressionRemoteStore, 'readHead' | 'readSegment'>,
  ): Promise<VerifiedSuppressionChainV8> {
    const now = (input.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) return fail();
    if (key(input.encryptionKey).equals(key(input.headAuthenticationKey))) return fail();
    const witness = { data: input.witness };
    const object = await store.readHead();
    if (
      !object ||
      object.versionId !== witness.data.headVersionId ||
      !(object.bytes instanceof Uint8Array) ||
      object.bytes.byteLength > MAX_HEAD_BYTES ||
      createHash('sha256').update(object.bytes).digest('hex') !== witness.data.headSha256
    )
      return fail();
    const head = decodeSuppressionHeadV8(object.bytes, input.headAuthenticationKey);
    const { headVersionId: _version, headSha256: _sha, ...expected } = witness.data;
    void _version;
    void _sha;
    const { formatVersion: _format, segments, ...actual } = head;
    void _format;
    if (JSON.stringify(actual) !== JSON.stringify(expected) || segments.length === 0) return fail();
    const envelopes: LocalReplayRecordEnvelopeV8[] = [];
    const encryptedSegments: Uint8Array[] = [];
    const seen = new Set<string>();
    let events = 0,
      total = 0,
      replayable = true;
    for (const segment of segments) {
      const object = await store.readSegment(segment.segmentId, segment.versionId);
      if (
        !object ||
        object.versionId !== segment.versionId ||
        !(object.bytes instanceof Uint8Array) ||
        object.bytes.byteLength !== segment.byteLength
      )
        return fail();
      const segmentBytes = Uint8Array.from(object.bytes);
      total += segmentBytes.byteLength;
      if (
        total > MAX_CHAIN_BYTES ||
        createHash('sha256').update(segmentBytes).digest('hex') !== segment.sha256
      )
        return fail();
      const envelope = decryptReplaySegmentV8({
        bytes: segmentBytes,
        key: input.encryptionKey,
        expectedKeyId: input.keyId,
      });
      if (
        JSON.stringify(envelope.source) !== JSON.stringify(head.source) ||
        envelope.clusterId !== head.clusterId ||
        envelope.fromLsn !== segment.fromLsn ||
        envelope.throughLsn !== segment.throughLsn ||
        envelope.previousHash !== segment.previousHash ||
        envelope.sha256 !== segment.localHash
      )
        return fail();
      for (const tx of envelope.transactions) {
        if (!planSuppressionReplayTransactionV8(tx.records, now).replayable) replayable = false;
        for (const record of tx.records) {
          if (seen.has(record.eventId) || Date.parse(record.occurredAt) > now) return fail();
          seen.add(record.eventId);
          events++;
        }
      }
      // Snapshot verified bytes; a mutable remote-store buffer is never kept.
      encryptedSegments.push(segmentBytes);
      envelopes.push(envelope);
    }
    const result = Object.freeze({
      status: 'verified_local_chain' as const,
      eventCount: events,
      segmentCount: envelopes.length,
      authority: 'none' as const,
      admissionAllowed: false as const,
      originalEventStage: replayable ? ('exact_replay' as const) : ('unavailable' as const),
    });
    verifiedChains.set(result, { encryptedSegments, verificationInstant: now });
    return result;
  }
  /**
   * Owner-only offline replay of a fully verified V8 chain inside the caller's owner
   * transaction (the caller holds the exclusive global restore fence, owns COMMIT and must
   * roll back on any error). The verified ciphertext snapshot is re-decrypted and re-planned
   * before any SQL. A chain holding any record 7 event is blocked before SQL: no
   * original-event stage exists for it, so no partial legacy replay happens either.
   */
  async function replayVerifiedSuppressionChainV8In(
    client: Pick<PoolClient, 'query'>,
    prepared: VerifiedSuppressionChainV8,
  ): Promise<
    | {
        status: 'blocked';
        reason: 'original_event_stage_unavailable';
        eventCount: number;
        authority: 'none';
        admissionAllowed: false;
      }
    | { status: 'replayed'; eventCount: number; authority: 'none'; admissionAllowed: false }
  > {
    const state = verifiedChains.get(prepared);
    if (!state) return fail();
    const plans: SuppressionReplayPlanV8[] = [];
    try {
      for (const bytes of state.encryptedSegments) {
        const envelope = decryptReplaySegmentV8({
          bytes,
          key: input.encryptionKey,
          expectedKeyId: input.keyId,
        });
        for (const tx of envelope.transactions)
          plans.push(planSuppressionReplayTransactionV8(tx.records, state.verificationInstant));
      }
    } catch {
      return fail();
    }
    const eventCount = plans.reduce((total, plan) => total + plan.eventCount, 0);
    if (eventCount !== prepared.eventCount) return fail();
    if (plans.some((plan) => !plan.replayable))
      return {
        status: 'blocked',
        reason: 'original_event_stage_unavailable',
        eventCount,
        authority: 'none',
        admissionAllowed: false,
      };
    const replayed = await replaySuppressionPlansV8In(client, plans);
    if (replayed !== eventCount) return fail();
    return { status: 'replayed', eventCount, authority: 'none', admissionAllowed: false };
  }

  /** A factory-membership gate, not an original-event installer. Re-decrypt the
   * verified ciphertext snapshot through the existing strict envelope codec, so
   * every callback owns a fresh validated copy. Trusted SQL adapters must await a
   * Promise callback; callback failures propagate without becoming auth evidence.
   * No monotonic/remote witness freshness policy is supplied by this factory. */
  function withVerifiedSuppressionChainV8<T>(
    handle: VerifiedSuppressionChainV8,
    consume: (
      envelopes: readonly ReadonlySuppressionReplayRecordEnvelopeV8[],
      limits: VerifiedSuppressionChainReadLimitsV8,
    ) => T,
  ): T {
    const state = verifiedChains.get(handle);
    if (!state || typeof consume !== 'function') return fail();
    let envelopes: LocalReplayRecordEnvelopeV8[];
    try {
      envelopes = state.encryptedSegments.map((bytes) =>
        decryptReplaySegmentV8({
          bytes,
          key: input.encryptionKey,
          expectedKeyId: input.keyId,
        }),
      );
      for (const envelope of envelopes) {
        for (const tx of envelope.transactions) {
          planSuppressionReplayTransactionV8(tx.records, state.verificationInstant);
          for (const record of tx.records)
            if (Date.parse(record.occurredAt) > state.verificationInstant) return fail();
        }
      }
    } catch {
      return fail();
    }
    return consume(
      envelopes,
      Object.freeze({
        authority: 'none',
        admissionAllowed: false,
        originalEventStage: handle.originalEventStage,
        witnessFreshness: 'not_rechecked',
        verificationInstant: state.verificationInstant,
        eventCount: handle.eventCount,
        segmentCount: handle.segmentCount,
      }),
    );
  }

  return {
    prepareVerifiedSuppressionChainV8,
    replayVerifiedSuppressionChainV8In,
    withVerifiedSuppressionChainV8,
  };
}
