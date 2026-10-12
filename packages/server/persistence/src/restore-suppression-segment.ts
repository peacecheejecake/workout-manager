import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  validateManualReviewSourceIdentity,
  type SuppressionRecord,
} from './restore-suppression-records.js';

import {
  decodeSuppressionPgoutputRecordsV7,
  decodeSuppressionPgoutputRecordsV8,
  type LocalReplayRecordEnvelope,
} from './restore-suppression-pgoutput.js';
import { suppressionRecordV7Schema } from './restore-suppression-records-v7.js';
import { suppressionRecordV8Schema } from './restore-suppression-records-v8.js';

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
const calendarOccurredAt = occurredAt.refine((value) => {
  const date = value.slice(0, 10);
  const midnight = new Date(`${date}T00:00:00Z`);
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  return (
    Number(date.slice(0, 4)) >= 1 &&
    Number.isFinite(midnight.getTime()) &&
    midnight.toISOString().slice(0, 10) === date &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
});
const base = z.object({
  schemaVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
  ]),
  eventId: uuid,
  athleteId: boundedIdentifier,
  occurredAt,
});
const record = z
  .discriminatedUnion('kind', [
    base
      .extend({
        schemaVersion: z.literal(6),
        occurredAt: calendarOccurredAt,
        kind: z.literal('manual_review_source_suppressed'),
        manualReviewSourceKind: z.enum([
          'race-event',
          'plan-snapshot',
          'nutrition-plan-version',
          'recovery-strategy-version',
          'routine-schedule-version',
          'routine-blueprint-version',
          'routine-occurrence',
          'routine-run',
          'session-completion',
        ]),
        manualReviewSourceId: boundedIdentifier,
        manualReviewVersionScope: z.enum(['exact_version', 'all_versions']),
        manualReviewVersionKey: z.string().max(128).nullable(),
      })
      .strict(),
    base.extend({ kind: z.literal('tenant_erased') }).strict(),
    base
      .extend({
        kind: z.enum(['race_event_deleted', 'race_result_deleted', 'training_best_deleted']),
        targetId: uuid,
        racePreviousRevision: revision,
        raceDeletedRevision: revision,
      })
      .strict(),
    base
      .extend({
        kind: z.enum([
          'healthkit_workout_deregistration_pending',
          'healthkit_workout_deregistration_released',
        ]),
        targetId: uuid,
        healthKitClaimEpoch: uuid,
        healthKitOperationId: uuid,
        healthKitConsentRevision: revision,
        healthKitRegistryPreviousRevision: z.number().int().min(0).max(2147483646),
        healthKitRegistryRevision: revision,
        healthKitObjectScopes: z
          .array(z.object({ kind: z.enum(['activity', 'course']), id: uuid }).strict())
          .max(1000),
      })
      .strict(),
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
        schemaVersion: z.literal(5),
        kind: z.literal('app_consent_transition'),
        occurredAt: calendarOccurredAt,
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
      case 'manual_review_source_suppressed':
        try {
          validateManualReviewSourceIdentity(
            item.manualReviewSourceKind,
            item.manualReviewSourceId,
            item.manualReviewVersionScope,
            item.manualReviewVersionKey,
          );
        } catch {
          valid = false;
        }
        break;
      case 'race_event_deleted':
      case 'race_result_deleted':
      case 'training_best_deleted':
        valid =
          item.schemaVersion === 4 &&
          item.raceDeletedRevision === Math.min(item.racePreviousRevision + 1, 2147483647);
        break;
      case 'healthkit_workout_deregistration_pending':
      case 'healthkit_workout_deregistration_released':
        valid =
          item.schemaVersion === 3 &&
          item.healthKitRegistryRevision === item.healthKitRegistryPreviousRevision + 1 &&
          new Set(item.healthKitObjectScopes.map((scope) => `${scope.kind}:${scope.id}`)).size ===
            item.healthKitObjectScopes.length;
        break;
      case 'healthkit_consent_transition':
      case 'ai_consent_transition':
      case 'app_consent_transition':
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
    if (item.schemaVersion === 6 && item.kind !== 'manual_review_source_suppressed') valid = false;
    if (item.schemaVersion === 5 && item.kind !== 'app_consent_transition') valid = false;
    if (
      item.schemaVersion === 4 &&
      item.kind !== 'race_event_deleted' &&
      item.kind !== 'race_result_deleted' &&
      item.kind !== 'training_best_deleted'
    )
      valid = false;
    if (
      item.schemaVersion === 3 &&
      item.kind !== 'healthkit_workout_deregistration_pending' &&
      item.kind !== 'healthkit_workout_deregistration_released'
    )
      valid = false;
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

/** Exact source identity supplied by a separately trusted capture/registry manifest. */
export const suppressionSourceBindingV7Schema = z.strictObject({
  databaseName: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/),
  databaseOid: z.number().int().min(1).max(4294967295),
  slotName: z.string().regex(/^wm_suppression_[a-z0-9_]{1,40}$/),
  publication: z.literal('workout_restore_suppression_events'),
  relationProfile: z.literal('suppression-physical-v7'),
  captureId: uuid,
  registryFingerprint: hash,
});
export type SuppressionSourceBindingV7 = z.infer<typeof suppressionSourceBindingV7Schema>;
const envelopeV7Schema = envelopeSchema
  .extend({
    localRecordVersion: z.literal(2),
    source: suppressionSourceBindingV7Schema,
    transactions: z
      .array(
        z.strictObject({
          commitLsn: lsn,
          endLsn: lsn,
          records: z.array(z.union([record, suppressionRecordV7Schema])).max(1000),
        }),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type LocalReplayRecordEnvelopeV7 = z.infer<typeof envelopeV7Schema>;
const MAGIC_V7 = Buffer.from('WMLEDG02');

/** SQL145 successor capture binding. The physical columns are the unchanged V7 roster, but
 * the record domain admits record_version 8, so a V8 capture is a distinct relation profile
 * and a V7 envelope/head can never carry (or be confused with) an album-deletion record. */
export const suppressionSourceBindingV8Schema = suppressionSourceBindingV7Schema
  .extend({ relationProfile: z.literal('suppression-physical-v8') })
  .strict();
export type SuppressionSourceBindingV8 = z.infer<typeof suppressionSourceBindingV8Schema>;
const envelopeV8Schema = envelopeSchema
  .extend({
    localRecordVersion: z.literal(3),
    source: suppressionSourceBindingV8Schema,
    transactions: z
      .array(
        z.strictObject({
          commitLsn: lsn,
          endLsn: lsn,
          records: z
            .array(z.union([record, suppressionRecordV7Schema, suppressionRecordV8Schema]))
            .max(1000),
        }),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type LocalReplayRecordEnvelopeV8 = z.infer<typeof envelopeV8Schema>;
const MAGIC_V8 = Buffer.from('WMLEDG03');

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

const headerV7Schema = headerSchema
  .extend({
    codecVersion: z.literal(2),
    localRecordVersion: z.literal(2),
    source: suppressionSourceBindingV7Schema,
  })
  .strict();
const headerV8Schema = headerSchema
  .extend({
    codecVersion: z.literal(3),
    localRecordVersion: z.literal(3),
    source: suppressionSourceBindingV8Schema,
  })
  .strict();
type Header =
  z.infer<typeof headerSchema> | z.infer<typeof headerV7Schema> | z.infer<typeof headerV8Schema>;

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

/** Internal strict DTO boundary; physical pgoutput decoding remains separate. */
export function validateLegacySuppressionReplayRecord(value: unknown): SuppressionRecord {
  const parsed = record.safeParse(value);
  if (!parsed.success) return reject();
  const item = parsed.data;
  return item.kind === 'manual_review_source_suppressed'
    ? {
        ...item,
        ...validateManualReviewSourceIdentity(
          item.manualReviewSourceKind,
          item.manualReviewSourceId,
          item.manualReviewVersionScope,
          item.manualReviewVersionKey,
        ),
      }
    : item;
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
  return {
    ...envelope,
    transactions: envelope.transactions.map((transaction) => ({
      ...transaction,
      records: transaction.records.map(validateLegacySuppressionReplayRecord),
    })),
  };
}

function checkedEnvelopeV7(value: unknown): LocalReplayRecordEnvelopeV7 {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return reject();
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_PLAINTEXT_BYTES)
    return reject();
  const parsed = envelopeV7Schema.safeParse(value);
  if (!parsed.success) return reject();
  const envelope = parsed.data;
  const { sha256, ...body } = envelope;
  if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== sha256) return reject();
  let cursor = lsnValue(envelope.fromLsn);
  const seen = new Set<string>();
  for (const tx of envelope.transactions) {
    const commit = lsnValue(tx.commitLsn),
      end = lsnValue(tx.endLsn);
    if (commit < cursor || end <= commit) return reject();
    for (const item of tx.records) {
      if (seen.has(item.eventId)) return reject();
      seen.add(item.eventId);
    }
    cursor = end;
  }
  if (seen.size === 0 || cursor !== lsnValue(envelope.throughLsn)) return reject();
  return envelope;
}

function checkedEnvelopeV8(value: unknown): LocalReplayRecordEnvelopeV8 {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return reject();
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_PLAINTEXT_BYTES)
    return reject();
  const parsed = envelopeV8Schema.safeParse(value);
  if (!parsed.success) return reject();
  const envelope = parsed.data;
  const { sha256, ...body } = envelope;
  if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== sha256) return reject();
  let cursor = lsnValue(envelope.fromLsn);
  const seen = new Set<string>();
  for (const tx of envelope.transactions) {
    const commit = lsnValue(tx.commitLsn),
      end = lsnValue(tx.endLsn);
    if (commit < cursor || end <= commit) return reject();
    for (const item of tx.records) {
      if (seen.has(item.eventId)) return reject();
      seen.add(item.eventId);
    }
    cursor = end;
  }
  if (seen.size === 0 || cursor !== lsnValue(envelope.throughLsn)) return reject();
  return envelope;
}

/** Uses only the explicit physical V7 relation profile, including legacy NULL successor fields. */
export function makeLocalReplayRecordEnvelopeV7(input: {
  clusterId: string;
  fromLsn: string;
  previousHash: string | null;
  source: SuppressionSourceBindingV7;
  messages: readonly Buffer[];
}): LocalReplayRecordEnvelopeV7 {
  const transactions = decodeSuppressionPgoutputRecordsV7(input.messages, input.fromLsn);
  const last = transactions.at(-1);
  if (!last) return reject();
  const parsed = envelopeV7Schema.safeParse({
    localRecordVersion: 2,
    clusterId: input.clusterId,
    fromLsn: input.fromLsn,
    throughLsn: last.endLsn,
    previousHash: input.previousHash,
    transactions,
    source: input.source,
    sha256: '0'.repeat(64),
  });
  if (!parsed.success) return reject();
  const { sha256: _placeholder, ...body } = parsed.data;
  void _placeholder;
  return checkedEnvelopeV7({
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  });
}

/** SQL145 successor: the same physical roster decoded through record_version 8. */
export function makeLocalReplayRecordEnvelopeV8(input: {
  clusterId: string;
  fromLsn: string;
  previousHash: string | null;
  source: SuppressionSourceBindingV8;
  messages: readonly Buffer[];
}): LocalReplayRecordEnvelopeV8 {
  const transactions = decodeSuppressionPgoutputRecordsV8(input.messages, input.fromLsn);
  const last = transactions.at(-1);
  if (!last) return reject();
  const parsed = envelopeV8Schema.safeParse({
    localRecordVersion: 3,
    clusterId: input.clusterId,
    fromLsn: input.fromLsn,
    throughLsn: last.endLsn,
    previousHash: input.previousHash,
    transactions,
    source: input.source,
    sha256: '0'.repeat(64),
  });
  if (!parsed.success) return reject();
  const { sha256: _placeholder, ...body } = parsed.data;
  void _placeholder;
  return checkedEnvelopeV8({
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  });
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
  return encryptSegment(input, checkedEnvelope, headerSchema, MAGIC);
}
export function encryptReplaySegmentV7(input: {
  envelope: LocalReplayRecordEnvelopeV7;
  key: Uint8Array;
  keyId: string;
}): EncryptedReplaySegment {
  return encryptSegment(input, checkedEnvelopeV7, headerV7Schema, MAGIC_V7);
}
export function encryptReplaySegmentV8(input: {
  envelope: LocalReplayRecordEnvelopeV8;
  key: Uint8Array;
  keyId: string;
}): EncryptedReplaySegment {
  return encryptSegment(input, checkedEnvelopeV8, headerV8Schema, MAGIC_V8);
}
type EnvelopeMetadata = {
  localRecordVersion: 1 | 2 | 3;
  clusterId: string;
  fromLsn: string;
  throughLsn: string;
  previousHash: string | null;
  source?: SuppressionSourceBindingV7 | SuppressionSourceBindingV8;
};
function encryptSegment<T extends EnvelopeMetadata>(
  input: { envelope: T; key: Uint8Array; keyId: string },
  check: (value: unknown) => T,
  schema: z.ZodType<Header>,
  magic: Buffer,
): EncryptedReplaySegment {
  const envelope = check(input.envelope);
  const plaintext = Buffer.from(canonical(envelope), 'utf8');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) return reject();
  const nonce = randomBytes(NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) return reject();
  const header = schema.safeParse({
    codecVersion: envelope.localRecordVersion,
    algorithm: 'AES-256-GCM',
    keyId: input.keyId,
    nonce: nonce.toString('base64'),
    localRecordVersion: envelope.localRecordVersion,
    clusterId: envelope.clusterId,
    fromLsn: envelope.fromLsn,
    throughLsn: envelope.throughLsn,
    previousHash: envelope.previousHash,
    plaintextBytes: plaintext.length,
    ...(envelope.source ? { source: envelope.source } : {}),
  });
  if (!header.success) return reject();
  const serializedHeader = headerBytes(header.data);
  const prefix = Buffer.alloc(magic.length + 4);
  magic.copy(prefix);
  prefix.writeUInt32BE(serializedHeader.length, magic.length);
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
  return decryptSegment(input, checkedEnvelope, headerSchema, MAGIC);
}
export function decryptReplaySegmentV7(input: {
  bytes: Uint8Array;
  key: Uint8Array;
  expectedKeyId: string;
}): LocalReplayRecordEnvelopeV7 {
  return decryptSegment(input, checkedEnvelopeV7, headerV7Schema, MAGIC_V7);
}
export function decryptReplaySegmentV8(input: {
  bytes: Uint8Array;
  key: Uint8Array;
  expectedKeyId: string;
}): LocalReplayRecordEnvelopeV8 {
  return decryptSegment(input, checkedEnvelopeV8, headerV8Schema, MAGIC_V8);
}
function decryptSegment<T extends EnvelopeMetadata>(
  input: { bytes: Uint8Array; key: Uint8Array; expectedKeyId: string },
  check: (value: unknown) => T,
  schema: z.ZodType<Header>,
  magic: Buffer,
): T {
  const bytes = input.bytes;
  const minimum = magic.length + 4 + TAG_BYTES + 1;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < minimum ||
    bytes.length > MAX_ENCRYPTED_SEGMENT_BYTES
  )
    return reject();
  const raw = Buffer.from(bytes);
  if (!raw.subarray(0, magic.length).equals(magic)) return reject();
  const headerLength = raw.readUInt32BE(magic.length);
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES) return reject();
  const headerEnd = magic.length + 4 + headerLength;
  if (raw.length < headerEnd + TAG_BYTES + 1) return reject();
  const serializedHeader = raw.subarray(magic.length + 4, headerEnd);
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(serializedHeader));
  } catch {
    return reject();
  }
  const parsedHeader = schema.safeParse(headerValue);
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
  const envelope = check(value);
  if (
    !plaintext.equals(Buffer.from(canonical(envelope), 'utf8')) ||
    envelope.localRecordVersion !== header.localRecordVersion ||
    envelope.clusterId !== header.clusterId ||
    envelope.fromLsn !== header.fromLsn ||
    envelope.throughLsn !== header.throughLsn ||
    envelope.previousHash !== header.previousHash ||
    canonical(envelope.source ?? null) !== canonical('source' in header ? header.source : null)
  )
    return reject();
  return envelope;
}
