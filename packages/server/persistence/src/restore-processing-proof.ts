import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  decodeSuppressionHead,
  type SuppressionRemoteStore,
  type VersionedObject,
} from './restore-suppression-coordinator.js';
import { preflightSuppressionReplay } from './restore-suppression-replay.js';
import {
  decryptReplaySegment,
  MAX_ENCRYPTED_SEGMENT_BYTES,
} from './restore-suppression-segment.js';

// App-binding/replay witness preparation only, including when purpose is full_restore.
// This is not the complete restore proof: whole-registry row sets, signed baseline
// objects, CLOSED revision, snapshot/slot origin, and loader postconditions are absent.
// No SQL admission, signer provisioning, loader, or commit is implemented here.
const MAX_PROOF_BYTES = 1024 * 1024;
const MAX_CHAIN_BYTES = 64 * 1024 * 1024;
const PROOF_DOMAIN = 'wm-restore-processing-proof-v1\0';
const WITNESS_DOMAIN = 'wm-restore-processing-witness-v1\0';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const lsn = z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/);
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const checkpoint = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n);
const count = z.number().int().min(0).max(100_000);
const emptyDigest = createHash('sha256').update('[]').digest('hex');
const inventory = z
  .strictObject({ count, sha256: hash })
  .refine((value) => value.count !== 0 || value.sha256 === emptyDigest);
const inventories = z.strictObject({
  evidence: inventory,
  run: inventory,
  candidate: inventory,
  integratedCandidate: inventory,
  approval: inventory,
  events: inventory,
  receipts: inventory,
});
const app = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({
    state: z.literal('present'),
    revision: z.number().int().positive().max(2147483647),
    granted: z.boolean(),
  }),
]);
const owner = z.strictObject({ ownerTag: hash, app, inventories });
const owners = z
  .array(owner)
  .max(1000)
  .refine((rows) =>
    rows.every((row, index) => index === 0 || (rows[index - 1]?.ownerTag ?? '') < row.ownerTag),
  );
const target = z.strictObject({
  nonce: z.uuid(),
  generationId: z.uuid(),
  systemIdentifier: checkpoint,
  databaseIncarnation: z.uuid(),
});
const fence = z.strictObject({
  fenceId: z.uuid(),
  leaseId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  throughLsn: lsn,
});
const schema = z.strictObject({ version: z.literal(100), registryFingerprint: hash });
const kinds = [
  'tenant_erased',
  'course_deleted',
  'activity_deleted',
  'resource_deleted',
  'gallery_media_deleted',
  'healthkit_consent_transition',
  'ai_consent_transition',
  'app_consent_transition',
  'check_in_deleted',
  'resource_share_revoked',
  'course_share_revoked',
  'intake_entry_deleted',
  'recovery_action_deleted',
  'healthkit_workout_deregistration_pending',
  'healthkit_workout_deregistration_released',
  'race_event_deleted',
  'race_result_deleted',
  'training_best_deleted',
] as const;
const kindCounts = z.strictObject(Object.fromEntries(kinds.map((kind) => [kind, count])));
const tailCounts = z.array(z.strictObject({ ownerTag: hash, counts: kindCounts })).max(1000);
const reference = z.strictObject({
  segmentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  versionId: identifier,
  sha256: hash,
  byteLength: z.number().int().positive().max(MAX_ENCRYPTED_SEGMENT_BYTES),
});
const tail = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('empty'),
    headVersionId: identifier,
    headSha256: hash,
    throughLsn: lsn,
    localHash: hash.nullable(),
    counts: tailCounts,
  }),
  z.strictObject({
    kind: z.literal('chain'),
    headVersionId: identifier,
    headSha256: hash,
    slotName: z.string().regex(/^wm_suppression_[a-z0-9_]{1,40}$/),
    anchor: z.strictObject({
      clusterId: checkpoint,
      fromLsn: lsn,
      previousHash: hash.nullable(),
      throughLsn: lsn,
      finalLocalHash: hash,
      ciphertextHashes: z.array(hash).min(1).max(512),
    }),
    segments: z.array(reference).min(1).max(512),
    counts: tailCounts,
  }),
]);
const baseline = z.strictObject({
  snapshotId: identifier,
  pointLsn: lsn,
  inventorySha256: hash,
  publicationFingerprint: hash,
  systemIdentifier: checkpoint,
});
const archiveIdentity = z.strictObject({
  backupId: z.uuid(),
  dumpSha256: hash,
  privateManifestSha256: hash,
  completionVersionId: identifier,
});
const base = {
  protocolVersion: z.literal(1),
  proofId: z.uuid(),
  schema,
  target,
  checkpoint,
  leaseId: z.uuid(),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  fence,
  owners,
};
const proofSchema = z.discriminatedUnion('purpose', [
  z.strictObject({
    ...base,
    purpose: z.literal('fresh_bootstrap'),
    baseline: z.null(),
    archive: z.null(),
    tail: z.null(),
  }),
  z.strictObject({
    ...base,
    purpose: z.literal('live_upgrade'),
    baseline,
    archive: z.null(),
    tail,
  }),
  z.strictObject({
    ...base,
    purpose: z.literal('full_restore'),
    baseline,
    archive: archiveIdentity,
    tail,
  }),
]);
const witnessSchema = z.strictObject({
  protocolVersion: z.literal(1),
  purpose: z.enum(['fresh_bootstrap', 'live_upgrade', 'full_restore']),
  proofSha256: hash,
  schema,
  target,
  checkpoint,
  leaseId: z.uuid(),
  fence,
  ownerTags: z.array(hash).max(1000),
  expiresAt: z.iso.datetime({ offset: true }),
});

type Proof = z.infer<typeof proofSchema>;
export type RestoreProcessingPurpose = Proof['purpose'];
export type RestoreProcessingTarget = z.infer<typeof target>;
export type RestoreProcessingInventory = z.infer<typeof owners>;
/** Independently provisioned server capabilities, never request/DB-derived trust. */
export interface RestoreProcessingProofAuthority {
  readonly proofKey: Uint8Array;
  readonly witnessKey: Uint8Array;
  readonly headKey: Uint8Array;
  readonly encryptionKey: Uint8Array;
  readonly encryptionKeyId: string;
  readonly purpose: RestoreProcessingPurpose;
  readonly registryFingerprint: string;
  readonly publicationFingerprint: string;
  readonly sourceSystemIdentifier: string | null;
  readonly expectedTarget: RestoreProcessingTarget;
  readonly expectedCheckpoint: string;
  readonly expectedLeaseId: string;
  readonly expectedWitnessVersionId: string;
  readonly expectedFence: z.infer<typeof fence>;
  readonly expectedOwnerTags: readonly string[];
  readonly now: () => Date;
  readonly readIndependentWitness: () => Promise<VersionedObject | null>;
  readonly readTargetIdentity: () => Promise<unknown>;
  readonly readTargetInventory: () => Promise<unknown>;
  readonly readTargetSchemaFingerprint: () => Promise<unknown>;
  readonly readArchiveIdentity?: () => Promise<unknown>;
  readonly tagOwner: (athleteId: string) => string;
  readonly remoteStore?: Pick<SuppressionRemoteStore, 'readHead' | 'readSegment'>;
}
export type RestoreProcessingProofSummary = Readonly<{
  purpose: RestoreProcessingPurpose;
  proofId: string;
  proofSha256: string;
  targetNonce: string;
  generationId: string;
  checkpoint: string;
  leaseId: string;
  eventCount: number;
}>;
export type VerifiedRestoreProcessingProof = Readonly<{
  kind: 'verified_restore_processing_proof';
}>;
const verified = new WeakMap<VerifiedRestoreProcessingProof, RestoreProcessingProofSummary>();
export type RestoreProcessingProofResult =
  | {
      status: 'closed';
      admissionAllowed: false;
      code:
        | 'INVALID_PROOF'
        | 'WITNESS_UNAVAILABLE'
        | 'AUTHORITY_MISMATCH'
        | 'TARGET_MISMATCH'
        | 'INVENTORY_MISMATCH'
        | 'TAIL_UNVERIFIED';
    }
  | { status: 'proof_verified'; admissionAllowed: false; handle: VerifiedRestoreProcessingProof };

// Same sorted JSON encoding as existing backup candidate/segment protocols;
// HMAC domain separation prevents a valid old head/candidate from being a proof.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function authenticated<T>(
  bytes: Uint8Array,
  key: Uint8Array,
  domain: string,
  parser: z.ZodType<T>,
): T {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PROOF_BYTES || key.byteLength !== 32)
    throw new Error('INVALID_PROOF');
  const envelope = z
    .strictObject({ body: z.string().max(MAX_PROOF_BYTES), mac: hash })
    .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const body = Buffer.from(envelope.body, 'base64');
  if (body.toString('base64') !== envelope.body || body.byteLength > MAX_PROOF_BYTES)
    throw new Error('INVALID_PROOF');
  const expected = createHmac('sha256', key).update(domain).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex')))
    throw new Error('INVALID_PROOF');
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  // Do not canonicalize unvalidated input: fixed schemas bound nesting first.
  const checked = parser.parse(parsed);
  if (!body.equals(Buffer.from(canonical(checked)))) throw new Error('INVALID_PROOF');
  return checked;
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function lsnNumber(value: string): bigint {
  const [high, low] = value.split('/');
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}
function countsTotal(rows: z.infer<typeof tailCounts>): number {
  return rows.reduce(
    (sum, row) => sum + kinds.reduce((inner, kind) => inner + (row.counts[kind] ?? 0), 0),
    0,
  );
}
function closed(
  code: Extract<RestoreProcessingProofResult, { status: 'closed' }>['code'],
): RestoreProcessingProofResult {
  return { status: 'closed', admissionAllowed: false, code };
}

export function readVerifiedRestoreProcessingProof(
  handle: VerifiedRestoreProcessingProof,
): RestoreProcessingProofSummary {
  const summary = verified.get(handle);
  if (!summary) throw new Error('RESTORE_PROCESSING_PROOF_HANDLE_INVALID');
  return summary;
}

/** Verifies proof bytes and independent witnesses only; never admits a database. */
export async function verifyRestoreProcessingProof(
  bytes: Uint8Array,
  authority?: RestoreProcessingProofAuthority,
): Promise<RestoreProcessingProofResult> {
  if (!authority) return closed('WITNESS_UNAVAILABLE');
  let proof: Proof;
  try {
    for (const key of [
      authority.proofKey,
      authority.witnessKey,
      authority.headKey,
      authority.encryptionKey,
    ])
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) return closed('INVALID_PROOF');
    // Source signer and independent target/fence authority must be distinct keys.
    if (Buffer.from(authority.proofKey).equals(Buffer.from(authority.witnessKey)))
      return closed('AUTHORITY_MISMATCH');
    proof = authenticated(bytes, authority.proofKey, PROOF_DOMAIN, proofSchema);
  } catch {
    return closed('INVALID_PROOF');
  }
  try {
    const now = authority.now().getTime();
    const ownerTags = proof.owners.map((row) => row.ownerTag);
    const validTime = (value: string) => Date.parse(value) > now;
    if (
      !Number.isFinite(now) ||
      proof.purpose !== authority.purpose ||
      proof.schema.registryFingerprint !== authority.registryFingerprint ||
      !same(proof.target, target.parse(authority.expectedTarget)) ||
      proof.checkpoint !== checkpoint.parse(authority.expectedCheckpoint) ||
      proof.leaseId !== authority.expectedLeaseId ||
      !same(proof.fence, fence.parse(authority.expectedFence)) ||
      !same(ownerTags, z.array(hash).max(1000).parse(authority.expectedOwnerTags)) ||
      Date.parse(proof.issuedAt) > now ||
      Date.parse(proof.issuedAt) >= Date.parse(proof.expiresAt) ||
      !validTime(proof.expiresAt) ||
      !validTime(proof.fence.expiresAt) ||
      proof.fence.leaseId !== proof.leaseId
    )
      return closed('AUTHORITY_MISMATCH');
    const independent = await authority.readIndependentWitness();
    if (!independent || independent.versionId !== authority.expectedWitnessVersionId)
      return closed('WITNESS_UNAVAILABLE');
    let witness: z.infer<typeof witnessSchema>;
    try {
      witness = authenticated(
        independent.bytes,
        authority.witnessKey,
        WITNESS_DOMAIN,
        witnessSchema,
      );
    } catch {
      return closed('WITNESS_UNAVAILABLE');
    }
    if (
      witness.proofSha256 !== digest(bytes) ||
      witness.purpose !== proof.purpose ||
      !same(witness.schema, proof.schema) ||
      !same(witness.target, proof.target) ||
      witness.checkpoint !== proof.checkpoint ||
      witness.leaseId !== proof.leaseId ||
      !same(witness.fence, proof.fence) ||
      !same(witness.ownerTags, ownerTags) ||
      !validTime(witness.expiresAt)
    )
      return closed('AUTHORITY_MISMATCH');
    if (!same(target.parse(await authority.readTargetIdentity()), proof.target))
      return closed('TARGET_MISMATCH');
    if (
      hash.parse(await authority.readTargetSchemaFingerprint()) !== proof.schema.registryFingerprint
    )
      return closed('TARGET_MISMATCH');
    if (!same(owners.parse(await authority.readTargetInventory()), proof.owners))
      return closed('INVENTORY_MISMATCH');
    let eventCount = 0;
    if (proof.purpose === 'fresh_bootstrap') {
      if (
        proof.owners.length !== 0 ||
        proof.fence.throughLsn !== '0/0' ||
        authority.sourceSystemIdentifier !== null
      )
        return closed('INVENTORY_MISMATCH');
    } else {
      const currentTail = proof.tail;
      if (
        proof.baseline.systemIdentifier !== authority.sourceSystemIdentifier ||
        (proof.purpose === 'live_upgrade' &&
          proof.baseline.systemIdentifier !== proof.target.systemIdentifier)
      )
        return closed('TAIL_UNVERIFIED');
      if (
        proof.purpose === 'full_restore' &&
        (!authority.readArchiveIdentity ||
          !same(archiveIdentity.parse(await authority.readArchiveIdentity()), proof.archive))
      )
        return closed('TAIL_UNVERIFIED');
      if (
        !authority.remoteStore ||
        proof.baseline.publicationFingerprint !== authority.publicationFingerprint ||
        !same(
          currentTail.counts.map((row) => row.ownerTag),
          ownerTags,
        )
      )
        return closed('TAIL_UNVERIFIED');
      const remote = await authority.remoteStore.readHead();
      if (
        !remote ||
        remote.bytes.byteLength > 2048 ||
        remote.versionId !== currentTail.headVersionId ||
        digest(remote.bytes) !== currentTail.headSha256
      )
        return closed('TAIL_UNVERIFIED');
      const head = decodeSuppressionHead(remote.bytes, authority.headKey);
      const through =
        currentTail.kind === 'chain' ? currentTail.anchor.throughLsn : currentTail.throughLsn;
      if (
        head.clusterId !== proof.baseline.systemIdentifier ||
        head.throughLsn !== through ||
        proof.fence.throughLsn !== through ||
        lsnNumber(proof.baseline.pointLsn) > lsnNumber(through)
      )
        return closed('TAIL_UNVERIFIED');
      if (currentTail.kind === 'empty') {
        if (
          countsTotal(currentTail.counts) !== 0 ||
          head.localHash !== currentTail.localHash ||
          proof.baseline.pointLsn !== through
        )
          return closed('TAIL_UNVERIFIED');
      } else {
        if (
          head.slotName !== currentTail.slotName ||
          head.clusterId !== currentTail.anchor.clusterId ||
          head.localHash !== currentTail.anchor.finalLocalHash ||
          currentTail.anchor.fromLsn !== proof.baseline.pointLsn ||
          currentTail.segments.length !== currentTail.anchor.ciphertextHashes.length ||
          new Set(currentTail.segments.map((row) => `${row.segmentId}/${row.versionId}`)).size !==
            currentTail.segments.length ||
          currentTail.segments.reduce((sum, row) => sum + row.byteLength, 0) > MAX_CHAIN_BYTES
        )
          return closed('TAIL_UNVERIFIED');
        const last = currentTail.segments.at(-1);
        if (
          !last ||
          !head.segment ||
          head.segment.segmentId !== last.segmentId ||
          head.segment.versionId !== last.versionId ||
          head.segment.sha256 !== last.sha256 ||
          head.segment.byteLength !== last.byteLength
        )
          return closed('TAIL_UNVERIFIED');
        const segments: Buffer[] = [];
        for (const [index, ref] of currentTail.segments.entries()) {
          const segment = await authority.remoteStore.readSegment(ref.segmentId, ref.versionId);
          if (
            !segment ||
            segment.versionId !== ref.versionId ||
            segment.bytes.byteLength !== ref.byteLength ||
            digest(segment.bytes) !== ref.sha256 ||
            ref.sha256 !== currentTail.anchor.ciphertextHashes[index]
          )
            return closed('TAIL_UNVERIFIED');
          segments.push(segment.bytes);
        }
        const replay = preflightSuppressionReplay({
          segments,
          key: authority.encryptionKey,
          keyId: authority.encryptionKeyId,
          anchor: currentTail.anchor,
        });
        eventCount = replay.eventCount;
        if (countsTotal(currentTail.counts) !== eventCount) return closed('TAIL_UNVERIFIED');
        const actual = new Map(
          ownerTags.map((tag) => [tag, Object.fromEntries(kinds.map((kind) => [kind, 0]))]),
        );
        for (const segment of segments) {
          const envelope = decryptReplaySegment({
            bytes: segment,
            key: authority.encryptionKey,
            expectedKeyId: authority.encryptionKeyId,
          });
          if (
            segment === segments.at(-1) &&
            (head.segment.fromLsn !== envelope.fromLsn ||
              head.segment.previousHash !== envelope.previousHash)
          )
            return closed('TAIL_UNVERIFIED');
          for (const transaction of envelope.transactions)
            for (const record of transaction.records) {
              const row = actual.get(authority.tagOwner(record.athleteId));
              if (!row || row[record.kind] === undefined) return closed('TAIL_UNVERIFIED');
              row[record.kind] = (row[record.kind] ?? 0) + 1;
            }
        }
        if (
          !same(
            currentTail.counts,
            ownerTags.map((ownerTag) => ({ ownerTag, counts: actual.get(ownerTag) })),
          )
        )
          return closed('TAIL_UNVERIFIED');
      }
    }
    const handle: VerifiedRestoreProcessingProof = Object.freeze({
      kind: 'verified_restore_processing_proof',
    });
    verified.set(
      handle,
      Object.freeze({
        purpose: proof.purpose,
        proofId: proof.proofId,
        proofSha256: digest(bytes),
        targetNonce: proof.target.nonce,
        generationId: proof.target.generationId,
        checkpoint: proof.checkpoint,
        leaseId: proof.leaseId,
        eventCount,
      }),
    );
    return { status: 'proof_verified', admissionAllowed: false, handle };
  } catch {
    return closed('TAIL_UNVERIFIED');
  }
}
