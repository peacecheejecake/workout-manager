import { z } from 'zod';
import {
  mediaRetainedReadFactsSchema,
  validateMediaRetainedReadFacts,
} from './race-plan-impact-media-read-facts.js';
import { raceMediaCleanupSourceSchema } from './race-media-cleanup-source.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const cleanupUnavailable = z.strictObject({
  state: z.literal('unavailable'),
  reason: z.enum(['INVALID_REQUEST', 'READ_CAPABILITY_UNAVAILABLE', 'INVALID_CLEANUP_SOURCE']),
});
const capturedCleanup = z.union([raceMediaCleanupSourceSchema, cleanupUnavailable]);
const retained = {
  requestedId: id,
  accessRevision: z.number().int().min(1).max(2147483647),
  visibility: z.literal('private'),
  includeForCoach: z.literal(false),
  cleanup: capturedCleanup,
};
/** Exact captureActivityAndMediaPermissions media shape. Inclusion and cleanup
 * are retained facts, never permission or evidence of external bytes deletion. */
export const mediaReadMetadataSchema = z.discriminatedUnion('state', [
  z.strictObject({ requestedId: id, state: z.literal('unavailable'), content: z.null() }),
  z.strictObject({ ...retained, state: z.literal('deleted'), content: z.null() }),
  z.strictObject({
    ...retained,
    state: z.literal('owned'),
    content: z.strictObject({
      kind: z.enum(['image', 'video']),
      objectIdentity: z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('absent') }),
        z.strictObject({ state: z.literal('present'), contentHash: hash, idDigest: hash }),
      ]),
      contentHash: hash,
      previewPresent: z.boolean(),
    }),
  }),
]);
export const mediaReadManifestProjectionSchema = z.strictObject({
  requestedIds: z.array(id).max(5000),
  metadata: z.array(mediaReadMetadataSchema).max(5000),
  sourceFacts: mediaRetainedReadFactsSchema.optional(),
});
export type MediaReadManifestProjection = z.infer<typeof mediaReadManifestProjectionSchema>;
export type MediaReadManifestBlocker = {
  path: string;
  reason:
    | 'invalid_projection'
    | 'bounds_exceeded'
    | 'source_port_missing'
    | 'source_unavailable'
    | 'source_deleted'
    | 'source_identity_mismatch'
    | 'source_digest_mismatch'
    | 'object_identity_port_missing'
    | 'cleanup_mismatch'
    | 'source_membership_mismatch'
    | 'unused_source';
};
const key = (value: string) => uuid.safeParse(value).data ?? value;
/** Exact correspondence only. Authentication, source processing permission,
 * current freshness and complete approval are separate producer boundaries. */
export function validateMediaReadManifest(input: unknown) {
  const blockers: MediaReadManifestBlocker[] = [];
  const block = (path: string, reason: MediaReadManifestBlocker['reason']) =>
    blockers.push({ path, reason });
  const result = () => ({
    status: blockers.length ? ('blocked' as const) : ('validated_read_sources' as const),
    authority: 'none' as const,
    freshness: 'not_checked' as const,
    complete: false as const,
    sourceScope: 'db_recorded_descriptor_only' as const,
    blockers,
  });
  try {
    const json = JSON.stringify(input);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > 4194304) {
      block('projection', 'bounds_exceeded');
      return result();
    }
  } catch {
    block('projection', 'invalid_projection');
    return result();
  }
  const parsed = mediaReadManifestProjectionSchema.safeParse(input);
  if (!parsed.success) {
    block('projection', 'invalid_projection');
    return result();
  }
  const c = parsed.data;
  const expected = new Set(c.requestedIds.map(key));
  const metadata = new Map(c.metadata.map((row) => [key(row.requestedId), row]));
  if (metadata.size !== c.metadata.length) block('metadata', 'source_identity_mismatch');
  for (const requested of expected)
    if (!metadata.has(requested)) block('metadata', 'source_unavailable');
  for (const requested of metadata.keys())
    if (!expected.has(requested)) block('metadata', 'unused_source');
  if (!c.sourceFacts) {
    if (expected.size) block('sourceFacts', 'source_port_missing');
    return result();
  }
  const source = c.sourceFacts;
  if (c.requestedIds.length + source.facts.length > 5000) {
    block('projection', 'bounds_exceeded');
    return result();
  }
  if (validateMediaRetainedReadFacts(source).status !== 'validated_read_sources')
    block('sourceFacts', 'source_identity_mismatch');
  const actual = new Map(source.facts.map((fact) => [key(fact.requestedId), fact]));
  const requests = new Set(source.requestedIds.map(key));
  if (actual.size !== source.facts.length || requests.size !== source.requestedIds.length)
    block('sourceFacts', 'source_membership_mismatch');
  for (const requested of [...actual.keys(), ...requests])
    if (!expected.has(requested)) block('sourceFacts', 'unused_source');
  for (const requested of expected) {
    const row = metadata.get(requested),
      fact = actual.get(requested),
      path = `media:${requested}`;
    if (!row || !fact || !requests.has(requested)) {
      block(path, 'source_unavailable');
      continue;
    }
    if (row.state !== fact.state) block(path, 'source_identity_mismatch');
    if (row.state !== 'unavailable') {
      if (
        !fact.current ||
        fact.current.mediaItemId !== requested ||
        row.accessRevision !== fact.current.accessRevision ||
        (row.state === 'deleted') !== fact.current.deleted
      )
        block(path, 'source_identity_mismatch');
      const cleanup = fact.cleanup;
      if (!cleanup || cleanup.status !== 'available' || !('schemaVersion' in row.cleanup))
        block(path, 'source_unavailable');
      else if (impactDependencyDigest(row.cleanup) !== impactDependencyDigest(cleanup.source))
        block(path, 'cleanup_mismatch');
    }

    if (fact.state === 'deleted' || row.state === 'deleted') {
      block(path, 'source_deleted');
      continue;
    }
    if (fact.state !== 'owned' || row.state !== 'owned') {
      block(path, 'source_unavailable');
      continue;
    }
    const body = fact.record,
      current = fact.current;
    if (!body || !current || !fact.originalLedger) {
      block(path, 'source_unavailable');
      continue;
    }
    if (
      key(body.id) !== requested ||
      current.mediaItemId !== requested ||
      current.deleted ||
      row.accessRevision !== current.accessRevision ||
      row.accessRevision !== body.accessRevision ||
      row.visibility !== body.visibility ||
      row.includeForCoach !== body.includeForCoach ||
      row.content.kind !== body.mediaKind ||
      row.content.previewPresent !== (body.preview !== null)
    )
      block(path, 'source_identity_mismatch');
    if (
      row.content.contentHash !== body.file.sha256 ||
      row.content.objectIdentity.state !== 'present' ||
      (row.content.objectIdentity.state === 'present' &&
        row.content.objectIdentity.contentHash !== fact.originalLedger.sha256)
    )
      block(path, 'source_digest_mismatch');
    // Locator identity is its own semantic fingerprint namespace. It is never
    // compared to content SHA256 or PostgreSQL cleanup reference digests.
    if (fact.originalObjectIdentityDigest === null) block(path, 'object_identity_port_missing');
    else if (
      row.content.objectIdentity.state === 'present' &&
      row.content.objectIdentity.idDigest !== fact.originalObjectIdentityDigest
    )
      block(path, 'source_digest_mismatch');
  }
  return result();
}
