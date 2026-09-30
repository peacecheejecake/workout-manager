import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { LocalReplayRecordEnvelope } from './restore-suppression-pgoutput.js';

// Only the encrypted bytes may be handed to a file or remote-store adapter.
// This codec does not issue keys, acknowledge a slot, or prove ledger coverage.
const MAGIC = Buffer.from('WMLEDG01');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024;
export const MAX_ENCRYPTED_SEGMENT_BYTES =
  MAGIC.length + 4 + MAX_HEADER_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES;

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const lsn = z.string().regex(/^(?:[0-9A-F]{1,8})\/(?:[0-9A-F]{1,8})$/);
const revision = z.number().int().min(1).max(2147483647);
const boundedIdentifier = z.string().refine(
  (value) =>
    [...value].length >= 1 &&
    [...value].length <= 200 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    }),
);
const occurredAt = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/.test(value) &&
      Number.isFinite(Date.parse(value)),
  );
const base = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  eventId: uuid,
  athleteId: boundedIdentifier,
  occurredAt,
});
const record = z
  .discriminatedUnion('kind', [
    base.extend({ kind: z.literal('tenant_erased') }).strict(),
    base.extend({ kind: z.literal('course_deleted'), targetId: uuid }).strict(),
    base
      .extend({
        kind: z.literal('activity_deleted'),
        targetId: uuid,
        activityRevision: revision,
        sourceKind: z.enum(['fit', 'fixture', 'manual', 'healthkit']),
        sourceId: boundedIdentifier,
        sourceRevision: revision,
        sourceContentHash: hash,
      })
      .strict(),
    base
      .extend({
        kind: z.literal('resource_deleted'),
        targetId: uuid,
        resourceAccessRevision: revision,
      })
      .strict(),
    base
      .extend({
        kind: z.literal('gallery_media_deleted'),
        targetId: uuid,
        galleryAccessRevision: revision,
      })
      .strict(),
    base
      .extend({
        kind: z.literal('healthkit_consent_transition'),
        consentPreviousRevision: revision.nullable(),
        consentPreviousGranted: z.boolean().nullable(),
        consentRevision: revision,
        consentGranted: z.boolean(),
      })
      .strict(),
    base
      .extend({
        kind: z.literal('ai_consent_transition'),
        consentPreviousRevision: revision.nullable(),
        consentPreviousGranted: z.boolean().nullable(),
        consentRevision: revision,
        consentGranted: z.boolean(),
      })
      .strict(),
    base
      .extend({ kind: z.literal('check_in_deleted'), targetId: uuid, checkInRevision: revision })
      .strict(),
    base
      .extend({
        kind: z.literal('resource_share_revoked'),
        targetId: uuid,
        shareId: uuid,
        shareGrantedAccessRevision: revision,
        shareRevokedAccessRevision: revision,
        shareCauseKind: z.enum(['resource_deleted', 'tenant_erased']).optional(),
        shareCauseEventId: uuid.optional(),
      })
      .strict(),
    base
      .extend({
        kind: z.literal('course_share_revoked'),
        targetId: uuid,
        courseShareId: uuid,
        courseShareEpoch: revision,
        courseShareCourseRevision: revision,
        courseShareRevokeReason: z
          .enum(['owner', 'owner_all', 'zone_added', 'zone_removed'])
          .optional(),
        courseShareAuditId: uuid.optional(),
        courseShareAuditOccurredAt: occurredAt.optional(),
      })
      .strict(),
    base
      .extend({
        kind: z.union([z.literal('intake_entry_deleted'), z.literal('recovery_action_deleted')]),
        targetId: uuid,
        actualDeletionRevision: revision,
        actualPreviousRevisionId: uuid.optional(),
        actualDeletedRevisionId: uuid.optional(),
      })
      .strict(),
  ])
  .superRefine((item, context) => {
    let valid = true;
    switch (item.kind) {
      case 'healthkit_consent_transition':
      case 'ai_consent_transition':
        valid =
          (item.consentPreviousRevision === null) === (item.consentPreviousGranted === null) &&
          (item.consentPreviousRevision === null
            ? item.consentRevision === 1
            : item.consentRevision === item.consentPreviousRevision + 1);
        break;
      case 'resource_deleted':
        valid = item.resourceAccessRevision <= 2147483646;
        break;
      case 'gallery_media_deleted':
        valid = item.galleryAccessRevision <= 2147483646;
        break;
      case 'check_in_deleted':
        valid = item.checkInRevision >= 2 && item.checkInRevision <= 2147483646;
        break;
      case 'resource_share_revoked':
        valid =
          item.shareGrantedAccessRevision <= 2147483645 &&
          item.shareRevokedAccessRevision >= 2 &&
          item.shareRevokedAccessRevision <= 2147483646 &&
          item.shareRevokedAccessRevision > item.shareGrantedAccessRevision &&
          (item.shareCauseKind === undefined) === (item.shareCauseEventId === undefined) &&
          (item.schemaVersion === 2) === (item.shareCauseEventId !== undefined);
        break;
      case 'course_share_revoked':
        valid =
          item.courseShareEpoch <= 2147483646 &&
          item.courseShareCourseRevision <= 2147483646 &&
          (item.courseShareRevokeReason === undefined) ===
            (item.courseShareAuditId === undefined) &&
          (item.courseShareRevokeReason === undefined) ===
            (item.courseShareAuditOccurredAt === undefined) &&
          (item.schemaVersion === 2) === (item.courseShareRevokeReason !== undefined) &&
          (item.courseShareAuditOccurredAt === undefined ||
            Date.parse(item.courseShareAuditOccurredAt) >= Date.parse(item.occurredAt));
        break;
      case 'intake_entry_deleted':
      case 'recovery_action_deleted':
        valid =
          item.actualDeletionRevision >= 2 &&
          item.actualDeletionRevision <= 2147483646 &&
          (item.actualPreviousRevisionId === undefined) ===
            (item.actualDeletedRevisionId === undefined) &&
          (item.schemaVersion === 2) === (item.actualPreviousRevisionId !== undefined) &&
          (item.actualPreviousRevisionId === undefined ||
            item.actualPreviousRevisionId !== item.actualDeletedRevisionId);
        break;
      case 'tenant_erased':
      case 'course_deleted':
      case 'activity_deleted':
        break;
    }
    if (
      item.schemaVersion === 2 &&
      item.kind !== 'resource_share_revoked' &&
      item.kind !== 'course_share_revoked' &&
      item.kind !== 'intake_entry_deleted' &&
      item.kind !== 'recovery_action_deleted'
    )
      valid = false;
    if (!valid) context.addIssue({ code: 'custom', message: 'invalid record relationship' });
  });

const envelopeSchema = z
  .object({
    localRecordVersion: z.literal(1),
    clusterId: z.string().regex(/^[1-9]\d{0,19}$/),
    fromLsn: lsn,
    throughLsn: lsn,
    previousHash: hash.nullable(),
    transactions: z
      .array(
        z
          .object({
            commitLsn: lsn,
            endLsn: lsn,
            records: z.array(record).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    sha256: hash,
  })
  .strict();

const headerSchema = z
  .object({
    codecVersion: z.literal(1),
    algorithm: z.literal('AES-256-GCM'),
    keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    localRecordVersion: z.literal(1),
    clusterId: z.string().regex(/^[1-9]\d{0,19}$/),
    fromLsn: lsn,
    throughLsn: lsn,
    previousHash: hash.nullable(),
    plaintextBytes: z.number().int().min(1).max(MAX_PLAINTEXT_BYTES),
  })
  .strict();

type Header = z.infer<typeof headerSchema>;

function reject(): never {
  throw new Error('INVALID_ENCRYPTED_SEGMENT');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return reject();
}

function lsnValue(value: string): bigint {
  const [high, low] = value.split('/');
  if (!high || !low) return reject();
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}

function checkedEnvelope(value: unknown): LocalReplayRecordEnvelope {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return reject();
  const envelope = parsed.data;
  const { sha256, ...body } = envelope;
  if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== sha256) return reject();
  let cursor = lsnValue(envelope.fromLsn);
  const seen = new Set<string>();
  for (const transaction of envelope.transactions) {
    const commit = lsnValue(transaction.commitLsn);
    const end = lsnValue(transaction.endLsn);
    if (commit < cursor || end <= commit) return reject();
    for (const item of transaction.records) {
      if (seen.has(item.eventId)) return reject();
      seen.add(item.eventId);
    }
    cursor = end;
  }
  if (seen.size === 0 || cursor !== lsnValue(envelope.throughLsn)) return reject();
  return envelope;
}

function keyBytes(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) return reject();
  return Buffer.from(key);
}

function headerBytes(header: Header): Buffer {
  const bytes = Buffer.from(canonical(header), 'utf8');
  if (bytes.length > MAX_HEADER_BYTES) return reject();
  return bytes;
}

export type EncryptedReplaySegment = {
  bytes: Buffer;
  sha256: string;
  byteLength: number;
};

/** A fresh nonce comes only from the platform CSPRNG on the production path. */
export function encryptReplaySegment(input: {
  envelope: LocalReplayRecordEnvelope;
  key: Uint8Array;
  keyId: string;
}): EncryptedReplaySegment {
  const envelope = checkedEnvelope(input.envelope);
  const plaintext = Buffer.from(canonical(envelope), 'utf8');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) return reject();
  const nonce = randomBytes(NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) return reject();
  const header = headerSchema.safeParse({
    codecVersion: 1,
    algorithm: 'AES-256-GCM',
    keyId: input.keyId,
    nonce: nonce.toString('base64'),
    localRecordVersion: envelope.localRecordVersion,
    clusterId: envelope.clusterId,
    fromLsn: envelope.fromLsn,
    throughLsn: envelope.throughLsn,
    previousHash: envelope.previousHash,
    plaintextBytes: plaintext.length,
  });
  if (!header.success) return reject();
  const serializedHeader = headerBytes(header.data);
  const prefix = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(serializedHeader.length, MAGIC.length);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(input.key), nonce);
  cipher.setAAD(Buffer.concat([prefix, serializedHeader]));
  const bytes = Buffer.concat([
    prefix,
    serializedHeader,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  };
}

/** Authenticate before parsing; no plaintext is written to disk by this codec. */
export function decryptReplaySegment(input: {
  bytes: Uint8Array;
  key: Uint8Array;
  expectedKeyId: string;
}): LocalReplayRecordEnvelope {
  const bytes = input.bytes;
  const minimum = MAGIC.length + 4 + TAG_BYTES + 1;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < minimum ||
    bytes.length > MAX_ENCRYPTED_SEGMENT_BYTES
  )
    return reject();
  const raw = Buffer.from(bytes);
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return reject();
  const headerLength = raw.readUInt32BE(MAGIC.length);
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES) return reject();
  const headerEnd = MAGIC.length + 4 + headerLength;
  if (raw.length < headerEnd + TAG_BYTES + 1) return reject();
  const serializedHeader = raw.subarray(MAGIC.length + 4, headerEnd);
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(serializedHeader));
  } catch {
    return reject();
  }
  const parsedHeader = headerSchema.safeParse(headerValue);
  if (!parsedHeader.success || parsedHeader.data.keyId !== input.expectedKeyId) return reject();
  const header = parsedHeader.data;
  if (!serializedHeader.equals(headerBytes(header))) return reject();
  const ciphertext = raw.subarray(headerEnd, raw.length - TAG_BYTES);
  if (ciphertext.length !== header.plaintextBytes) return reject();
  const nonce = Buffer.from(header.nonce, 'base64');
  if (nonce.length !== NONCE_BYTES || nonce.toString('base64') !== header.nonce) return reject();
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(input.key), nonce);
    decipher.setAAD(raw.subarray(0, headerEnd));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return reject();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    return reject();
  }
  const envelope = checkedEnvelope(value);
  if (
    !plaintext.equals(Buffer.from(canonical(envelope), 'utf8')) ||
    envelope.localRecordVersion !== header.localRecordVersion ||
    envelope.clusterId !== header.clusterId ||
    envelope.fromLsn !== header.fromLsn ||
    envelope.throughLsn !== header.throughLsn ||
    envelope.previousHash !== header.previousHash
  )
    return reject();
  return envelope;
}
