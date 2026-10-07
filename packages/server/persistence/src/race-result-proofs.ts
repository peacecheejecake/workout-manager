import { z } from 'zod';
import {
  RACE_RESULT_V2_MAX_BYTES,
  raceResultProofInputSchema,
  raceResultProofStoredSchema,
  raceResultProofStorageLifecycleSchema,
  raceResultProofReadSchema,
  raceResultAttachmentStoredSchema,
  type RaceResultAttachmentInput,
  type RaceResultAttachmentStorageLifecycle,
  type RaceResultAttachmentStored,
  type RaceResultProofStored,
} from '@workout/contracts/race-result-v2';
import type { Transaction } from './database.js';
export type RaceResultProofRead = z.infer<typeof raceResultProofReadSchema>;

export class RaceResultProofError extends Error {
  constructor(
    readonly code:
      'INVALID_PROOFS' | 'PROOF_UNAVAILABLE' | 'STALE_PROOF_ACCESS' | 'INVALID_PROOF_SOURCE',
  ) {
    super(code);
  }
}
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const parentSchema = z.strictObject({
  id: uuid,
  access_revision: z.number().int().min(1).max(2147483647),
  alive: z.boolean(),
});
const descriptorSchema = z.strictObject({
  id: uuid,
  version_id: uuid.nullable(),
  media_type: z.string().max(127),
  size_bytes: z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  valid: z.boolean(),
  suppressed: z.boolean(),
});
type Identity = RaceResultAttachmentInput | RaceResultAttachmentStorageLifecycle;
const key = (ref: Identity) =>
  ref.kind === 'gallery-image'
    ? `gallery-image:${ref.mediaItemId}`
    : `resource-pdf:${ref.resourceId}`;
const sourceId = (ref: Identity) =>
  ref.kind === 'gallery-image' ? ref.mediaItemId : ref.resourceId;
function bounded<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  try {
    const bytes = JSON.stringify(value);
    if (bytes === undefined || Buffer.byteLength(bytes, 'utf8') > RACE_RESULT_V2_MAX_BYTES)
      throw new Error();
    return schema.parse(value);
  } catch {
    throw new RaceResultProofError('INVALID_PROOFS');
  }
}
/** Caller owns the authenticated tenant transaction and must acquire its global
 * lifecycle/admission and tenant command locks BEFORE these parent row locks.
 * All parents are locked in the same finite order, before any version/object read.
 * This helper does not open/commit a transaction or authorize app/AI processing. */
async function lockParents(tx: Transaction, refs: readonly Identity[]) {
  const parents = new Map<string, z.infer<typeof parentSchema> | null>();
  for (const ref of [...refs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))) {
    const table = ref.kind === 'gallery-image' ? 'gallery_media_item' : 'resource';
    const result = await tx.query(
      `SELECT id,access_revision,(deleted_at IS NULL) AS alive
      FROM public.${table} WHERE athlete_id=$1 AND id=$2 FOR SHARE`,
      [tx.athleteId, sourceId(ref)],
    );
    if (result.rows.length > 1) throw new RaceResultProofError('INVALID_PROOF_SOURCE');
    const row = result.rows[0];
    if (!row) {
      parents.set(key(ref), null);
      continue;
    }
    const parsed = parentSchema.safeParse(row);
    if (!parsed.success || parsed.data.id !== sourceId(ref))
      throw new RaceResultProofError('INVALID_PROOF_SOURCE');
    parents.set(key(ref), parsed.data);
  }
  return parents;
}
async function descriptor(
  tx: Transaction,
  ref: Identity,
  accessRevision: number,
): Promise<RaceResultAttachmentStored | null> {
  // The SQL109 narrow boolean seam reads suppression under its owner policy;
  // no runtime SELECT privilege on the private suppression ledger is required.
  // Only committed immutable object/version rows count. Upload intents are NOT a
  // permanent authority: finalized intents can be collected. Staged uploads have
  // no committed parent/version/object tuple and cannot pass these joins.
  const result =
    ref.kind === 'gallery-image'
      ? await tx.query(
          `SELECT m.id,NULL::uuid AS version_id,m.media_type,m.size_bytes::text,m.content_hash,
        (m.media_kind='image' AND m.visibility='private' AND m.deleted_at IS NULL
         AND o.content_hash=m.content_hash AND o.size_bytes=m.size_bytes AND o.media_type=m.media_type) AS valid,
        public.race_result_proof_source_suppressed($1::text,'gallery-image',m.id) AS suppressed
      FROM public.gallery_media_item m JOIN public.gallery_media_object o
        ON o.athlete_id=m.athlete_id AND o.storage_ref=m.storage_ref
      WHERE m.athlete_id=$1 AND m.id=$2`,
          [tx.athleteId, ref.mediaItemId],
        )
      : await tx.query(
          `SELECT r.id,v.version_id,v.media_type,v.size_bytes::text,v.content_hash,
        (r.source_kind='file' AND r.deleted_at IS NULL AND v.content_status='raw_stored'
         AND v.content IS NULL AND v.media_type='application/pdf'
         AND o.content_hash=v.content_hash AND o.size_bytes=v.size_bytes AND o.media_type=v.media_type) AS valid,
        public.race_result_proof_source_suppressed($1::text,'resource-pdf',r.id) AS suppressed
      FROM public.resource r JOIN public.resource_version v ON v.athlete_id=r.athlete_id AND v.resource_id=r.id
      JOIN public.resource_object o ON o.athlete_id=v.athlete_id AND o.storage_ref=v.storage_ref
      WHERE r.athlete_id=$1 AND r.id=$2 AND v.version_id=$3`,
          [tx.athleteId, ref.resourceId, ref.versionId],
        );
  if (result.rows.length > 1) throw new RaceResultProofError('INVALID_PROOF_SOURCE');
  const row = result.rows[0];
  if (!row) return null;
  const parsed = descriptorSchema.safeParse(row);
  if (
    !parsed.success ||
    parsed.data.id !== sourceId(ref) ||
    parsed.data.version_id !== (ref.kind === 'resource-pdf' ? ref.versionId : null)
  )
    throw new RaceResultProofError('INVALID_PROOF_SOURCE');
  const value = parsed.data;
  if (!value.valid || value.suppressed) return null;
  const facts =
    ref.kind === 'gallery-image'
      ? {
          kind: ref.kind,
          mediaItemId: ref.mediaItemId,
          accessRevision,
          mediaType: value.media_type,
          byteSize: Number(value.size_bytes),
          sha256: value.content_hash,
        }
      : {
          kind: ref.kind,
          resourceId: ref.resourceId,
          versionId: ref.versionId,
          accessRevision,
          mediaType: value.media_type,
          byteSize: Number(value.size_bytes),
          contentHash: value.content_hash,
        };
  const stored = raceResultAttachmentStoredSchema.safeParse(facts);
  if (!stored.success) throw new RaceResultProofError('INVALID_PROOF_SOURCE');
  return stored.data;
}
/** Internal preparation, NOT active race writer/API or official verification.
 * Existing successful command receipts must be returned BEFORE calling this. */
export async function prepareRaceResultProofs(
  tx: Transaction,
  unknownProofs: unknown,
): Promise<RaceResultProofStored> {
  const proofs = bounded(raceResultProofInputSchema, unknownProofs);
  const parents = await lockParents(tx, proofs.attachments);
  const attachments: RaceResultAttachmentStored[] = [];
  for (const ref of proofs.attachments) {
    const parent = parents.get(key(ref));
    if (!parent?.alive) throw new RaceResultProofError('PROOF_UNAVAILABLE');
    if (parent.access_revision !== ref.expectedAccessRevision)
      throw new RaceResultProofError('STALE_PROOF_ACCESS');
    const stored = await descriptor(tx, ref, parent.access_revision);
    if (!stored) throw new RaceResultProofError('PROOF_UNAVAILABLE');
    attachments.push(stored);
  }
  return bounded(raceResultProofStoredSchema, { link: proofs.link, attachments });
}
/** Retained own reads do not require app/AI consent. A stored redacted identity
 * stays unavailable forever here; it is never resolved again from a live head.
 * Harmless access-revision/metadata edits preserve the saved descriptor, while
 * deleted/missing/suppressed or mismatched exact objects expose no copied facts. */
export async function projectRaceResultProofsIn(
  tx: Transaction,
  unknownProofs: unknown,
): Promise<RaceResultProofRead> {
  const proofs = bounded(raceResultProofStorageLifecycleSchema, unknownProofs);
  const live = proofs.attachments.filter((ref) => !('status' in ref));
  const parents = await lockParents(tx, live);
  const attachments = [];
  for (const ref of proofs.attachments) {
    const unavailable =
      ref.kind === 'gallery-image'
        ? { kind: ref.kind, mediaItemId: ref.mediaItemId, status: 'unavailable' as const }
        : {
            kind: ref.kind,
            resourceId: ref.resourceId,
            versionId: ref.versionId,
            status: 'unavailable' as const,
          };
    if ('status' in ref) {
      attachments.push(unavailable);
      continue;
    }
    const parent = parents.get(key(ref));
    const current =
      parent?.alive && parent.access_revision >= ref.accessRevision
        ? await descriptor(tx, ref, ref.accessRevision)
        : null;
    if (
      current === null ||
      JSON.stringify(current) !== JSON.stringify(raceResultAttachmentStoredSchema.parse(ref))
    ) {
      attachments.push(unavailable);
    } else {
      attachments.push({ ...ref, status: 'available' as const });
    }
  }
  return bounded(raceResultProofReadSchema, { link: proofs.link, attachments });
}
