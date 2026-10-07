import { z } from 'zod';
import {
  resourceRetainedReadFactsSchema,
  validateResourceRetainedReadFacts,
} from './race-plan-impact-resource-read-facts.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Exact metadata emitted by source-permissions. AI inclusion and review facts
 * are retained for freshness; they do not grant manual processing permission. */
export const resourceReadMetadataSchema = z.strictObject({
  requestedVersionId: id,
  state: z.enum(['current', 'historical', 'deleted', 'unavailable']),
  reason: z.literal('owned_version_unavailable').nullable(),
  content: z
    .strictObject({
      resourceId: uuid,
      versionId: uuid,
      version: z.number().int().positive(),
      contentHash: hash,
    })
    .nullable(),
  current: z
    .strictObject({
      versionId: uuid,
      accessRevision: z.number().int().positive(),
      deleted: z.boolean(),
      reviewedState: z.enum(['reviewed', 'unreviewed']),
      reviewedVersionId: uuid.nullable(),
      includeForCoach: z.boolean(),
      cleanupPending: z.boolean(),
      aiAuthorized: z.boolean(),
    })
    .nullable(),
});
export const resourceReadManifestProjectionSchema = z.strictObject({
  requestedVersionIds: z.array(id).max(5000),
  metadata: z.array(resourceReadMetadataSchema).max(5000),
  sourceFacts: resourceRetainedReadFactsSchema.optional(),
});
export type ResourceReadManifestBlocker = {
  path: string;
  reason:
    | 'invalid_projection'
    | 'bounds_exceeded'
    | 'source_port_missing'
    | 'source_unavailable'
    | 'source_identity_mismatch'
    | 'source_digest_mismatch'
    | 'source_membership_mismatch'
    | 'unused_source';
};
const key = (value: string) => (uuid.safeParse(value).success ? value.toLowerCase() : value);

/** Correspondence of captured, owned facts only. A matching client object is
 * neither source authentication nor a current admission/approval capability. */
export function validateResourceReadManifest(unknownProjection: unknown) {
  const blockers: ResourceReadManifestBlocker[] = [];
  const block = (path: string, reason: ResourceReadManifestBlocker['reason']) => {
    blockers.push({ path, reason });
  };
  const result = () => ({
    status: blockers.length ? ('blocked' as const) : ('validated_read_sources' as const),
    authority: 'none' as const,
    freshness: 'not_checked' as const,
    complete: false as const,
    blockers,
  });
  try {
    const json = JSON.stringify(unknownProjection);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > 4194304) {
      block('projection', 'bounds_exceeded');
      return result();
    }
  } catch {
    block('projection', 'invalid_projection');
    return result();
  }
  const parsed = resourceReadManifestProjectionSchema.safeParse(unknownProjection);
  if (!parsed.success) {
    block('projection', 'invalid_projection');
    return result();
  }
  const c = parsed.data;
  const expected = new Set(c.requestedVersionIds.map(key));
  const metadata = new Map(c.metadata.map((row) => [key(row.requestedVersionId), row]));
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
  if (validateResourceRetainedReadFacts(source).status !== 'validated_read_sources')
    block('sourceFacts', 'source_identity_mismatch');
  const actual = new Map(source.facts.map((fact) => [key(fact.requestedVersionId), fact]));
  const sourceRequests = new Set(source.requestedVersionIds.map(key));
  if (actual.size !== source.facts.length) block('sourceFacts', 'source_identity_mismatch');
  if (c.requestedVersionIds.length + source.facts.length > 5000)
    block('projection', 'bounds_exceeded');
  for (const requested of [...actual.keys(), ...sourceRequests])
    if (!expected.has(requested)) block('sourceFacts', 'unused_source');
  for (const requested of expected) {
    const fact = actual.get(requested),
      row = metadata.get(requested);
    const path = `resource:${requested}`;
    if (!fact || !row || !sourceRequests.has(requested)) {
      block(path, 'source_unavailable');
      continue;
    }
    if (fact.state !== 'current' && fact.state !== 'historical') {
      block(path, 'source_unavailable');
      continue;
    }
    const body = fact.record,
      current = fact.current;
    if (!body || !current || !row.content || !row.current) {
      block(path, 'source_unavailable');
      continue;
    }
    if (
      row.state !== fact.state ||
      row.reason !== null ||
      fact.reason !== null ||
      row.content.versionId !== requested ||
      key(body.id) !== requested ||
      row.content.resourceId !== key(body.resourceId) ||
      current.resourceId !== key(body.resourceId) ||
      row.content.version !== body.version ||
      row.current.versionId !== current.versionId ||
      row.current.accessRevision !== current.accessRevision ||
      row.current.deleted ||
      current.deleted
    )
      block(path, 'source_identity_mismatch');
    if (row.content.contentHash !== body.contentHash) block(path, 'source_digest_mismatch');
  }
  // Keep the complete policy/permission metadata in the caller's read-set
  // digest. This structural check never promotes AI facts to manual authority.
  return result();
}
