import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { Pool } from 'pg';

import {
  exportSuppressionSegment,
  readSuppressionSlotPosition,
  reconcileSuppressionSlot,
  type VerifiedRemoteSegment,
} from './restore-suppression-exporter.js';
import {
  makeLocalReplayRecordEnvelope,
  peekSuppressionPgoutput,
} from './restore-suppression-pgoutput.js';
import {
  decryptReplaySegment,
  MAX_ENCRYPTED_SEGMENT_BYTES,
} from './restore-suppression-segment.js';

const hash = /^[a-f0-9]{64}$/;
const lsn = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/;
const slot = /^wm_suppression_[a-z0-9_]{1,40}$/;
const cluster = /^[1-9]\d{0,19}$/;

export type VersionedObject = { bytes: Buffer; versionId: string };

/** Every read must address the exact immutable version, never a mutable latest alias. */
export type SuppressionRemoteStore = {
  readHead(): Promise<VersionedObject | null>;
  readSegment(segmentId: string, versionId: string): Promise<VersionedObject | null>;
  putImmutableSegment(bytes: Buffer): Promise<{ segmentId: string; versionId: string }>;
  compareAndSetHead(expectedVersionId: string, bytes: Buffer): Promise<{ versionId: string }>;
};

export type SuppressionHead = {
  formatVersion: 1;
  clusterId: string;
  slotName: string;
  throughLsn: string;
  localHash: string | null;
  segment: (VerifiedRemoteSegment & { fromLsn: string; previousHash: string | null }) | null;
};

function fail(): never {
  throw new Error('SUPPRESSION_REMOTE_COORDINATION_FAILED');
}

function assertHead(value: unknown): SuppressionHead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).sort().join(',') !==
    ['formatVersion', 'clusterId', 'slotName', 'throughLsn', 'localHash', 'segment']
      .sort()
      .join(',')
  )
    return fail();
  if (
    body['formatVersion'] !== 1 ||
    typeof body['clusterId'] !== 'string' ||
    !cluster.test(body['clusterId']) ||
    typeof body['slotName'] !== 'string' ||
    !slot.test(body['slotName']) ||
    typeof body['throughLsn'] !== 'string' ||
    !lsn.test(body['throughLsn'])
  )
    return fail();
  const localHash = body['localHash'];
  const segment = body['segment'];
  if (localHash === null && segment === null) return body as SuppressionHead;
  if (
    typeof localHash !== 'string' ||
    !hash.test(localHash) ||
    typeof segment !== 'object' ||
    segment === null ||
    Array.isArray(segment)
  )
    return fail();
  const item = segment as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !==
    ['sha256', 'byteLength', 'versionId', 'segmentId', 'fromLsn', 'previousHash'].sort().join(',')
  )
    return fail();
  if (
    typeof item['sha256'] !== 'string' ||
    !hash.test(item['sha256']) ||
    !Number.isSafeInteger(item['byteLength']) ||
    (item['byteLength'] as number) < 1 ||
    (item['byteLength'] as number) > MAX_ENCRYPTED_SEGMENT_BYTES ||
    typeof item['versionId'] !== 'string' ||
    item['versionId'].length < 1 ||
    typeof item['segmentId'] !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(item['segmentId']) ||
    typeof item['fromLsn'] !== 'string' ||
    !lsn.test(item['fromLsn']) ||
    (item['previousHash'] !== null &&
      (typeof item['previousHash'] !== 'string' || !hash.test(item['previousHash'])))
  )
    return fail();
  return body as SuppressionHead;
}

/** HMAC key must be provisioned independently of the remote store. */
export function encodeSuppressionHead(
  head: SuppressionHead,
  authenticationKey: Uint8Array,
): Buffer {
  if (!(authenticationKey instanceof Uint8Array) || authenticationKey.byteLength !== 32)
    return fail();
  const checked = assertHead(head);
  const body = Buffer.from(JSON.stringify(checked), 'utf8');
  const mac = createHmac('sha256', authenticationKey).update(body).digest('hex');
  return Buffer.from(JSON.stringify({ body: body.toString('base64'), mac }), 'utf8');
}

export function decodeSuppressionHead(
  bytes: Uint8Array,
  authenticationKey: Uint8Array,
): SuppressionHead {
  if (
    !(authenticationKey instanceof Uint8Array) ||
    authenticationKey.byteLength !== 32 ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > 2048
  )
    return fail();
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail();
  }
  if (typeof wrapper !== 'object' || wrapper === null || Array.isArray(wrapper)) return fail();
  const fields = wrapper as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join(',') !== 'body,mac' ||
    typeof fields['body'] !== 'string' ||
    typeof fields['mac'] !== 'string' ||
    !hash.test(fields['mac'])
  )
    return fail();
  const body = Buffer.from(fields['body'], 'base64');
  if (body.toString('base64') !== fields['body']) return fail();
  const expected = createHmac('sha256', authenticationKey).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(fields['mac'], 'hex'))) return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return fail();
  }
  const head = assertHead(parsed);
  if (!body.equals(Buffer.from(JSON.stringify(head), 'utf8'))) return fail();
  return head;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

async function hasNewSuppressionRecords(input: {
  pool: Pool;
  slotName: string;
  clusterId: string;
  fromLsn: string;
  previousHash: string | null;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    const messages = await peekSuppressionPgoutput(client, input.slotName);
    try {
      makeLocalReplayRecordEnvelope({
        clusterId: input.clusterId,
        fromLsn: input.fromLsn,
        previousHash: input.previousHash,
        messages,
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'EMPTY_RECORD_ENVELOPE') return false;
      throw error;
    }
  } finally {
    client.release();
  }
}

async function checkedHead(
  store: SuppressionRemoteStore,
  authenticationKey: Uint8Array,
): Promise<{
  head: SuppressionHead;
  versionId: string;
  bytes: Buffer;
}> {
  const object = await store.readHead();
  if (!object || !object.versionId) return fail();
  return {
    head: decodeSuppressionHead(object.bytes, authenticationKey),
    versionId: object.versionId,
    bytes: object.bytes,
  };
}

async function checkedSegment(
  store: SuppressionRemoteStore,
  reference: VerifiedRemoteSegment,
): Promise<Buffer> {
  const object = await store.readSegment(reference.segmentId, reference.versionId);
  if (
    !object ||
    object.versionId !== reference.versionId ||
    object.bytes.byteLength !== reference.byteLength ||
    createHash('sha256').update(object.bytes).digest('hex') !== reference.sha256
  )
    return fail();
  return object.bytes;
}

/**
 * Head is published before ACK; on retry an ahead head is reconciled against WAL.
 * This does not prove remote retention, final-tail coverage, or restore readiness.
 */
export async function coordinateSuppressionExport(input: {
  pool: Pool;
  store: SuppressionRemoteStore;
  slotName: string;
  expectedClusterId: string;
  encryptionKey: Uint8Array;
  encryptionKeyId: string;
  headAuthenticationKey: Uint8Array;
}): Promise<SuppressionHead> {
  try {
    if (
      !slot.test(input.slotName) ||
      !cluster.test(input.expectedClusterId) ||
      !(input.encryptionKey instanceof Uint8Array) ||
      !(input.headAuthenticationKey instanceof Uint8Array) ||
      input.encryptionKey.byteLength !== 32 ||
      input.headAuthenticationKey.byteLength !== 32 ||
      sameBytes(input.encryptionKey, input.headAuthenticationKey)
    )
      return fail();
    const current = await checkedHead(input.store, input.headAuthenticationKey);
    const head = current.head;
    if (head.clusterId !== input.expectedClusterId || head.slotName !== input.slotName)
      return fail();
    const position = await readSuppressionSlotPosition({
      pool: input.pool,
      slotName: input.slotName,
    });
    if (position.clusterId !== head.clusterId) return fail();
    if (head.segment) {
      const bytes = await checkedSegment(input.store, head.segment);
      const envelope = decryptReplaySegment({
        bytes,
        key: input.encryptionKey,
        expectedKeyId: input.encryptionKeyId,
      });
      if (
        envelope.clusterId !== head.clusterId ||
        envelope.fromLsn !== head.segment.fromLsn ||
        envelope.throughLsn !== head.throughLsn ||
        envelope.previousHash !== head.segment.previousHash ||
        envelope.sha256 !== head.localHash
      )
        return fail();
      if (position.throughLsn === head.segment.fromLsn) {
        await reconcileSuppressionSlot({
          pool: input.pool,
          slotName: input.slotName,
          expectedClusterId: head.clusterId,
          fromLsn: head.segment.fromLsn,
          throughLsn: head.throughLsn,
          previousHash: head.segment.previousHash,
          localHash: envelope.sha256,
        });
      } else if (position.throughLsn !== head.throughLsn) return fail();
    } else if (position.throughLsn !== head.throughLsn) return fail();
    // A reconciliation attempt does not create a new segment in the same invocation.
    if (position.throughLsn !== head.throughLsn) return head;
    if (
      !(await hasNewSuppressionRecords({
        pool: input.pool,
        slotName: input.slotName,
        clusterId: head.clusterId,
        fromLsn: head.throughLsn,
        previousHash: head.localHash,
      }))
    ) {
      const unchanged = await checkedHead(input.store, input.headAuthenticationKey);
      const slotNow = await readSuppressionSlotPosition({
        pool: input.pool,
        slotName: input.slotName,
      });
      if (
        unchanged.versionId !== current.versionId ||
        !sameBytes(unchanged.bytes, current.bytes) ||
        slotNow.throughLsn !== head.throughLsn
      )
        return fail();
      return head;
    }

    const publication: { head: SuppressionHead | null } = { head: null };
    const result = await exportSuppressionSegment({
      pool: input.pool,
      slotName: input.slotName,
      expectedClusterId: input.expectedClusterId,
      expectedFromLsn: head.throughLsn,
      previousHash: head.localHash,
      key: input.encryptionKey,
      keyId: input.encryptionKeyId,
      storeVerifiedCiphertext: async (outbound) => {
        const put = await input.store.putImmutableSegment(Buffer.from(outbound));
        const receipt: VerifiedRemoteSegment = {
          segmentId: put.segmentId,
          versionId: put.versionId,
          byteLength: outbound.length,
          sha256: createHash('sha256').update(outbound).digest('hex'),
        };
        const actual = await checkedSegment(input.store, receipt);
        if (!sameBytes(actual, outbound)) return fail();
        const envelope = decryptReplaySegment({
          bytes: actual,
          key: input.encryptionKey,
          expectedKeyId: input.encryptionKeyId,
        });
        if (
          envelope.clusterId !== head.clusterId ||
          envelope.fromLsn !== head.throughLsn ||
          envelope.previousHash !== head.localHash
        )
          return fail();
        publication.head = {
          formatVersion: 1,
          clusterId: head.clusterId,
          slotName: head.slotName,
          throughLsn: envelope.throughLsn,
          localHash: envelope.sha256,
          segment: { ...receipt, fromLsn: envelope.fromLsn, previousHash: envelope.previousHash },
        };
        const bytes = encodeSuppressionHead(publication.head, input.headAuthenticationKey);
        const next = await input.store.compareAndSetHead(current.versionId, bytes);
        const readBack = await checkedHead(input.store, input.headAuthenticationKey);
        if (readBack.versionId !== next.versionId || !sameBytes(readBack.bytes, bytes))
          return fail();
        return receipt;
      },
    });
    const published = publication.head;
    if (
      !published ||
      result.localHash !== published.localHash ||
      result.throughLsn !== published.throughLsn
    )
      return fail();
    const after = await readSuppressionSlotPosition({ pool: input.pool, slotName: input.slotName });
    if (after.clusterId !== head.clusterId || after.throughLsn !== result.throughLsn) return fail();
    return published;
  } catch {
    return fail();
  }
}
