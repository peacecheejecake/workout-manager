import { z } from 'zod';
import {
  galleryMediaItemSchema,
  galleryMediaTypeSchema,
  galleryMediaMaxBytes,
} from '@workout/contracts/gallery';

import type { Transaction } from './database.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  raceMediaCleanupSourceSchema,
  readRaceMediaCleanupSource,
} from './race-media-cleanup-source.js';

const uuid = z.uuid().transform((id) => id.toLowerCase());
const opaqueId = z.string().min(1).max(200);
const revision = z.number().int().min(1).max(2147483647);
const ledgerSchema = z
  .strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().min(1),
    mediaType: galleryMediaTypeSchema,
  })
  .refine((value) => value.byteSize <= galleryMediaMaxBytes(value.mediaType), {
    message: 'Ledger descriptor exceeds public media type bound',
    path: ['byteSize'],
  });
const currentSchema = z.strictObject({
  mediaItemId: uuid,
  accessRevision: revision,
  deleted: z.boolean(),
});
const cleanupReadSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), source: raceMediaCleanupSourceSchema }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['INVALID_REQUEST', 'READ_CAPABILITY_UNAVAILABLE', 'INVALID_CLEANUP_SOURCE']),
  }),
]);
const factSchema = z.strictObject({
  requestedId: opaqueId,
  state: z.enum(['owned', 'deleted', 'unavailable']),
  reason: z.enum(['owned_media_unavailable', 'object_inventory_unavailable']).nullable(),
  record: galleryMediaItemSchema.nullable(),
  current: currentSchema.nullable(),
  originalLedger: ledgerSchema.nullable(),
  originalObjectIdentityDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  previewLedger: ledgerSchema.nullable(),
  cleanup: cleanupReadSchema.nullable(),
});
export const mediaRetainedReadFactsSchema = z.strictObject({
  requestedIds: z.array(opaqueId).max(5000),
  facts: z.array(factSchema).max(5000),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
  sourceScope: z.literal('db_recorded_descriptor_only'),
});
export type MediaRetainedReadFacts = z.infer<typeof mediaRetainedReadFactsSchema>;
const normalize = (id: string) => uuid.safeParse(id).data ?? id;
function matches(
  file: { sha256: string; byteSize: number; mediaType: string },
  ledger: z.infer<typeof ledgerSchema> | null,
) {
  return (
    ledger !== null &&
    file.sha256 === ledger.sha256 &&
    file.byteSize === ledger.byteSize &&
    file.mediaType === ledger.mediaType
  );
}

/** Structural correspondence of recorded descriptors, never object-byte existence or permission. */
export function validateMediaRetainedReadFacts(input: unknown) {
  const blockers: { path: string; reason: string }[] = [];
  const result = () => ({
    status: blockers.length ? ('blocked' as const) : ('validated_read_sources' as const),
    blockers,
    authority: 'none' as const,
    freshness: 'not_checked' as const,
    sourceScope: 'db_recorded_descriptor_only' as const,
  });
  try {
    if (Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > 4194304) throw Error('limit');
  } catch {
    blockers.push({ path: 'mediaReadFacts', reason: 'invalid_source' });
    return result();
  }
  const parsed = mediaRetainedReadFactsSchema.safeParse(input);
  if (!parsed.success) {
    blockers.push({ path: 'mediaReadFacts', reason: 'invalid_source' });
    return result();
  }
  const p = parsed.data,
    requests = new Set(p.requestedIds.map(normalize)),
    seen = new Set<string>();
  if (requests.size !== p.requestedIds.length)
    blockers.push({ path: 'requestedIds', reason: 'duplicate_request' });
  for (const [index, fact] of p.facts.entries()) {
    const path = `facts[${index}]`,
      id = normalize(fact.requestedId);
    if (!requests.has(id) || seen.has(id)) blockers.push({ path, reason: 'roster_mismatch' });
    seen.add(id);
    if (fact.current && fact.current.mediaItemId !== id)
      blockers.push({ path, reason: 'tuple_mismatch' });
    if (
      fact.cleanup?.status === 'available' &&
      (!fact.current ||
        fact.cleanup.source.mediaItemId !== id ||
        fact.cleanup.source.expectedAccessRevision !== fact.current.accessRevision)
    )
      blockers.push({ path, reason: 'cleanup_tuple_mismatch' });
    if (fact.state === 'unavailable') {
      if (
        fact.reason === null ||
        fact.record !== null ||
        fact.originalLedger !== null ||
        fact.originalObjectIdentityDigest !== null ||
        fact.previewLedger !== null ||
        (fact.reason === 'owned_media_unavailable' &&
          (fact.current !== null || fact.cleanup !== null))
      )
        blockers.push({ path, reason: 'tuple_mismatch' });
      blockers.push({ path, reason: fact.reason ?? 'owned_media_unavailable' });
      continue;
    }
    if (fact.reason !== null || !fact.current || fact.current.mediaItemId !== id) {
      blockers.push({ path, reason: 'tuple_mismatch' });
      continue;
    }
    if (fact.state === 'deleted') {
      if (
        !fact.current.deleted ||
        fact.record !== null ||
        fact.originalLedger !== null ||
        fact.originalObjectIdentityDigest !== null ||
        fact.previewLedger !== null
      )
        blockers.push({ path, reason: 'tuple_mismatch' });
      blockers.push({ path, reason: 'source_deleted' });
    } else if (
      !fact.record ||
      fact.current.deleted ||
      fact.record.id !== id ||
      fact.record.accessRevision !== fact.current.accessRevision ||
      !matches(fact.record.file, fact.originalLedger) ||
      fact.originalObjectIdentityDigest === null ||
      (fact.record.preview
        ? !matches(fact.record.preview, fact.previewLedger)
        : fact.previewLedger !== null)
    )
      blockers.push({ path, reason: 'tuple_mismatch' });
    const cleanup = fact.cleanup;
    if (!cleanup || cleanup.status === 'unavailable') {
      blockers.push({ path, reason: cleanup?.reason ?? 'cleanup_source_missing' });
      continue;
    }
    const source = cleanup.source;
    if (
      source.mediaItemId !== id ||
      source.expectedAccessRevision !== fact.current.accessRevision ||
      source.observedAccessRevision !== fact.current.accessRevision ||
      source.deleted !== fact.current.deleted
    )
      blockers.push({ path, reason: 'cleanup_tuple_mismatch' });
    if (!source.inventoryComplete || source.state === 'unavailable')
      blockers.push({ path, reason: source.reason ?? 'inventory_unavailable' });
    if (fact.state === 'owned' && !['absent', 'unavailable'].includes(source.state))
      blockers.push({ path, reason: 'cleanup_tuple_mismatch' });
    if (
      fact.state === 'owned' &&
      fact.record &&
      source.refs.length !== (fact.record.preview ? 2 : 1)
    )
      blockers.push({ path, reason: 'cleanup_inventory_mismatch' });
  }
  if ([...requests].some((id) => !seen.has(id)))
    blockers.push({ path: 'facts', reason: 'roster_mismatch' });
  return result();
}

// Only public descriptor columns enter transport. Opaque storage locators remain SQL join keys.
const itemJson = `jsonb_build_object('id',m.id,'mediaKind',m.media_kind,'visibility',m.visibility,'includeForCoach',m.include_for_coach,
  'album',m.album,'caption',m.caption,'activityId',m.activity_id,
  'capturedAt',to_char(m.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'capturedLocalDate',to_char(m.captured_local_date,'YYYY-MM-DD'),
  'file',jsonb_build_object('originalFileName',m.original_filename,'mediaType',m.media_type,'byteSize',m.size_bytes,'sha256',m.content_hash),
  'preview',CASE WHEN d.media_item_id IS NULL THEN NULL ELSE jsonb_build_object('kind','preview','mediaType',d.media_type,'byteSize',d.size_bytes,'sha256',d.content_hash) END,
  'accessRevision',m.access_revision,'createdAt',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
const fromItem = `FROM gallery_media_item m LEFT JOIN gallery_media_derivative d ON d.athlete_id=m.athlete_id AND d.media_item_id=m.id AND d.kind='preview'`;
const scalarSchema = z.strictObject({
  id: uuid,
  access_revision: revision,
  deleted: z.boolean(),
  bytes: z.string().regex(/^\d+$/),
  derivatives: z.number().int().min(0),
});
const bodySchema = z.strictObject({
  record: galleryMediaItemSchema,
  original_ledger: ledgerSchema.nullable(),
  original_object_ref: z.string().min(1).max(512).nullable(),
  preview_ledger: ledgerSchema.nullable(),
});
const ledgerJson = (alias: string) =>
  `CASE WHEN ${alias}.storage_ref IS NULL THEN NULL ELSE jsonb_build_object('sha256',${alias}.content_hash,'byteSize',${alias}.size_bytes,'mediaType',${alias}.media_type) END`;
function invalid(): never {
  throw new RaceImpactDependencyError('INVALID_CONTEXT');
}
function decode<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) invalid();
  return parsed.data;
}

export async function captureMediaRetainedReadFacts(
  tx: Transaction,
  unknownIds: unknown,
  budget: SourceBudget,
): Promise<MediaRetainedReadFacts> {
  const parsed = z.array(opaqueId).max(5000).safeParse(unknownIds);
  if (!parsed.success) invalid();
  reserveSourceBudget(budget, 0n, parsed.data.length);
  const requestedIds = [...new Set(parsed.data.map(normalize))].sort();
  const facts: MediaRetainedReadFacts['facts'] = [];
  for (const id of requestedIds) {
    reserveSourceBudget(budget, BigInt(512 + 2 * Buffer.byteLength(id, 'utf8')));
    const absent = () =>
      facts.push({
        requestedId: id,
        state: 'unavailable',
        reason: 'owned_media_unavailable',
        record: null,
        current: null,
        originalLedger: null,
        originalObjectIdentityDigest: null,
        previewLedger: null,
        cleanup: null,
      });
    if (!uuid.safeParse(id).success) {
      absent();
      continue;
    }
    const preflight = await tx.query(
      `SELECT m.id,m.access_revision,m.deleted_at IS NOT NULL AS deleted,
      CASE WHEN m.deleted_at IS NULL THEN octet_length((${itemJson})::text) ELSE 0 END::text AS bytes,
      (SELECT count(*)::integer FROM gallery_media_derivative x WHERE x.athlete_id=m.athlete_id AND x.media_item_id=m.id) AS derivatives
      ${fromItem} WHERE m.athlete_id=$1 AND m.id=$2::uuid`,
      [tx.athleteId, id],
    );
    if (!preflight.rows.length) {
      absent();
      continue;
    }
    if (preflight.rows.length !== 1) invalid();
    const scalar = decode(scalarSchema, preflight.rows[0]);
    if (scalar.id !== id) invalid();
    if (scalar.derivatives > 1 || BigInt(scalar.bytes) > 16384n)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
    const current = {
      mediaItemId: id,
      accessRevision: scalar.access_revision,
      deleted: scalar.deleted,
    };
    reserveSourceBudget(budget, 16384n + (scalar.deleted ? 0n : BigInt(scalar.bytes) + 2048n), 1);
    const cleanup = await readRaceMediaCleanupSource(tx, {
      mediaItemId: id,
      expectedAccessRevision: scalar.access_revision,
    });
    if (scalar.deleted) {
      facts.push({
        requestedId: id,
        state: 'deleted',
        reason: null,
        record: null,
        current,
        originalLedger: null,
        originalObjectIdentityDigest: null,
        previewLedger: null,
        cleanup,
      });
      continue;
    }
    if (BigInt(scalar.bytes) < 1n) invalid();
    const fetched = await tx.query(
      `SELECT ${itemJson} AS record,${ledgerJson('o')} AS original_ledger,o.storage_ref AS original_object_ref,${ledgerJson('p')} AS preview_ledger
      ${fromItem} LEFT JOIN gallery_media_object o ON o.athlete_id=m.athlete_id AND o.storage_ref=m.storage_ref
      LEFT JOIN gallery_media_object p ON p.athlete_id=d.athlete_id AND p.storage_ref=d.storage_ref
      WHERE m.athlete_id=$1 AND m.id=$2::uuid AND m.deleted_at IS NULL AND m.access_revision=$3`,
      [tx.athleteId, id, current.accessRevision],
    );
    if (fetched.rows.length !== 1) throw new RaceImpactDependencyError('SOURCE_UNAVAILABLE');
    const body = decode(bodySchema, fetched.rows[0]);
    if (
      body.record.id !== id ||
      body.record.accessRevision !== current.accessRevision ||
      BigInt(Buffer.byteLength(JSON.stringify(body.record))) > BigInt(scalar.bytes)
    )
      invalid();
    if (
      !matches(body.record.file, body.original_ledger) ||
      body.original_object_ref === null ||
      (body.record.preview
        ? !matches(body.record.preview, body.preview_ledger)
        : body.preview_ledger !== null)
    ) {
      facts.push({
        requestedId: id,
        state: 'unavailable',
        reason: 'object_inventory_unavailable',
        record: null,
        current,
        originalLedger: null,
        originalObjectIdentityDigest: null,
        previewLedger: null,
        cleanup,
      });
      continue;
    }
    facts.push({
      requestedId: id,
      state: 'owned',
      reason: null,
      record: body.record,
      current,
      originalLedger: body.original_ledger,
      originalObjectIdentityDigest: impactDependencyDigest(body.original_object_ref),
      previewLedger: body.preview_ledger,
      cleanup,
    });
  }
  const output = decode(mediaRetainedReadFactsSchema, {
    requestedIds,
    facts,
    authority: 'none',
    freshness: 'not_checked',
    sourceScope: 'db_recorded_descriptor_only',
  });
  // Invalid correspondences from a source port are errors. Supported missing facts remain explicit.
  const allowed = new Set([
    'owned_media_unavailable',
    'object_inventory_unavailable',
    'source_deleted',
    'READ_CAPABILITY_UNAVAILABLE',
    'INVALID_CLEANUP_SOURCE',
    'INVALID_REQUEST',
    'cleanup_source_missing',
    'OWNED_MEDIA_UNAVAILABLE',
    'ACCESS_REVISION_STALE',
    'INVENTORY_UNAVAILABLE',
    'QUEUE_TUPLE_UNAVAILABLE',
    'REFERENCE_PRESENT',
  ]);
  if (
    validateMediaRetainedReadFacts(output).blockers.some((blocker) => !allowed.has(blocker.reason))
  )
    invalid();
  return output;
}
