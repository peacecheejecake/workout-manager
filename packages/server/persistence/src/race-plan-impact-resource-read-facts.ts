import { createHash } from 'node:crypto';
import { z } from 'zod';

import { privateTextResourceVersionSchema } from '@workout/contracts/resources';

import type { Transaction } from './database.js';
import { RaceImpactDependencyError } from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483647);
const requestedId = z.string().min(1).max(200);
const currentSchema = z.strictObject({
  resourceId: uuid,
  versionId: uuid,
  version: revision,
  accessRevision: revision,
  deleted: z.boolean(),
});
const factSchema = z.strictObject({
  requestedVersionId: requestedId,
  state: z.enum(['current', 'historical', 'deleted', 'unavailable']),
  reason: z.enum(['owned_version_unavailable', 'unsupported_source_kind']).nullable(),
  record: privateTextResourceVersionSchema.nullable(),
  current: currentSchema.nullable(),
});

export const resourceRetainedReadFactsSchema = z.strictObject({
  requestedVersionIds: z.array(requestedId).max(5000),
  facts: z.array(factSchema).max(5000),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
export type ResourceRetainedReadFacts = z.infer<typeof resourceRetainedReadFactsSchema>;

/** Structural retained-read correspondence only; JSON cannot establish ownership or permission. */
export function validateResourceRetainedReadFacts(input: unknown) {
  // The boundary is finite even when the caller bypasses the database collector.
  try {
    if (Buffer.byteLength(JSON.stringify(input) ?? '') > 4194304) throw new Error('limit');
  } catch {
    return {
      status: 'blocked' as const,
      authority: 'none' as const,
      freshness: 'not_checked' as const,
      complete: false as const,
      blockers: [{ path: 'resourceReadFacts', reason: 'invalid_source' }],
    };
  }
  const parsed = resourceRetainedReadFactsSchema.safeParse(input);
  const blockers: { path: string; reason: string }[] = [];
  if (!parsed.success)
    return {
      status: 'blocked' as const,
      authority: 'none' as const,
      freshness: 'not_checked' as const,
      complete: false as const,
      blockers: [{ path: 'resourceReadFacts', reason: 'invalid_source' }],
    };
  const projection = parsed.data;
  const normalize = (id: string) => uuid.safeParse(id).data ?? id;
  const requests = projection.requestedVersionIds.map(normalize);
  const requestSet = new Set(requests);
  const seen = new Set<string>();
  if (new Set(requests).size !== requests.length)
    blockers.push({ path: 'requestedVersionIds', reason: 'duplicate_request' });
  for (const [index, fact] of projection.facts.entries()) {
    const path = `facts[${index}]`;
    const id = normalize(fact.requestedVersionId);
    if (!requestSet.has(id) || seen.has(id)) blockers.push({ path, reason: 'roster_mismatch' });
    seen.add(id);
    if (fact.state === 'unavailable') {
      if (
        fact.record !== null ||
        fact.reason === null ||
        (fact.reason === 'owned_version_unavailable' && fact.current !== null) ||
        (fact.reason === 'unsupported_source_kind' && (!fact.current || fact.current.deleted))
      )
        blockers.push({ path, reason: 'tuple_mismatch' });
      blockers.push({ path, reason: fact.reason ?? 'owned_version_unavailable' });
      continue;
    }
    if (!fact.current || fact.reason !== null) {
      blockers.push({ path, reason: 'tuple_mismatch' });
      continue;
    }
    if (fact.state === 'deleted') {
      if (fact.record !== null || !fact.current.deleted)
        blockers.push({ path, reason: 'tuple_mismatch' });
      blockers.push({ path, reason: 'source_deleted' });
      continue;
    }
    const body = fact.record;
    if (
      !body ||
      fact.current.deleted ||
      body.id.toLowerCase() !== id ||
      body.resourceId.toLowerCase() !== fact.current.resourceId ||
      body.version > fact.current.version ||
      (fact.state === 'current'
        ? body.id.toLowerCase() !== fact.current.versionId || body.version !== fact.current.version
        : body.id.toLowerCase() === fact.current.versionId || body.version >= fact.current.version)
    ) {
      blockers.push({ path, reason: 'tuple_mismatch' });
      continue;
    }
    if (createHash('sha256').update(body.source.text, 'utf8').digest('hex') !== body.contentHash)
      blockers.push({ path, reason: 'source_digest_mismatch' });
  }
  if (requests.some((id) => !seen.has(id)))
    blockers.push({ path: 'facts', reason: 'roster_mismatch' });
  return {
    status: blockers.length ? ('blocked' as const) : ('validated_read_sources' as const),
    authority: 'none' as const,
    freshness: 'not_checked' as const,
    complete: false as const,
    blockers,
  };
}

const scalarSchema = z.strictObject({
  resource_id: uuid,
  version_id: uuid,
  version: revision,
  current_version_id: uuid,
  current_version: revision,
  access_revision: revision,
  deleted: z.boolean(),
  source_kind: z.enum(['text', 'file', 'url']),
  content_bytes: z.string().regex(/^\d+$/),
  paragraph_bytes: z.string().regex(/^\d+$/),
  paragraph_count: z.number().int().min(0),
});
const bodySchema = z.strictObject({
  resource_id: uuid,
  version_id: uuid,
  version: revision,
  previous_version_id: uuid.nullable(),
  content: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  paragraphs: privateTextResourceVersionSchema.shape.paragraphs,
  content_status: privateTextResourceVersionSchema.shape.lifecycle.shape.contentStatus,
  index_status: privateTextResourceVersionSchema.shape.lifecycle.shape.indexStatus,
  created_at: z
    .union([z.date(), z.iso.datetime({ offset: true })])
    .transform((value) => new Date(value).toISOString()),
});
function invalid(): never {
  throw new RaceImpactDependencyError('INVALID_CONTEXT');
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) invalid();
  return result.data;
}

/** Caller supplies the fenced tenant transaction and shared snapshot budget. */
export async function captureResourceRetainedReadFacts(
  tx: Transaction,
  input: unknown,
  budget: SourceBudget,
): Promise<ResourceRetainedReadFacts> {
  if (
    !z
      .strictObject({
        bytes: z.bigint().min(0n).max(4194304n),
        sources: z.number().int().min(0).max(5000),
      })
      .safeParse(budget).success
  )
    invalid();
  const parsed = z.array(requestedId).max(5000).safeParse(input);
  if (!parsed.success) invalid();
  reserveSourceBudget(budget, 0n, parsed.data.length);
  const requests = [...new Set(parsed.data.map((id) => uuid.safeParse(id).data ?? id))].sort();
  const facts: ResourceRetainedReadFacts['facts'] = [];
  for (const id of requests) {
    // Reserve the finite fact/current tuple before transporting even scalar rows.
    reserveSourceBudget(budget, BigInt(512 + 2 * Buffer.byteLength(id, 'utf8')));
    const absent = () =>
      facts.push({
        requestedVersionId: id,
        state: 'unavailable',
        reason: 'owned_version_unavailable',
        record: null,
        current: null,
      });
    if (!uuid.safeParse(id).success) {
      absent();
      continue;
    }
    const scalar = await tx.query(
      `SELECT v.resource_id,v.version_id,v.version,
      r.current_version_id,r.current_version,r.access_revision,r.deleted_at IS NOT NULL AS deleted,r.source_kind,
      CASE WHEN r.deleted_at IS NULL AND r.source_kind='text' THEN octet_length(v.content) ELSE 0 END::text AS content_bytes,
      CASE WHEN r.deleted_at IS NULL AND r.source_kind='text' THEN octet_length(v.paragraphs::text) ELSE 0 END::text AS paragraph_bytes,
      CASE WHEN r.deleted_at IS NULL AND r.source_kind='text' THEN jsonb_array_length(v.paragraphs) ELSE 0 END AS paragraph_count
      FROM resource_version v JOIN resource r ON r.athlete_id=v.athlete_id AND r.id=v.resource_id
      WHERE v.athlete_id=$1 AND v.version_id=$2::uuid`,
      [tx.athleteId, id],
    );
    if (!scalar.rows.length) {
      absent();
      continue;
    }
    if (scalar.rows.length !== 1) invalid();
    const row = parse(scalarSchema, scalar.rows[0]);
    if (row.version_id !== id || row.version > row.current_version) invalid();
    const current = {
      resourceId: row.resource_id,
      versionId: row.current_version_id,
      version: row.current_version,
      accessRevision: row.access_revision,
      deleted: row.deleted,
    };
    if (row.deleted) {
      facts.push({ requestedVersionId: id, state: 'deleted', reason: null, record: null, current });
      continue;
    }
    if (row.source_kind !== 'text') {
      facts.push({
        requestedVersionId: id,
        state: 'unavailable',
        reason: 'unsupported_source_kind',
        record: null,
        current,
      });
      continue;
    }
    const textBytes = BigInt(row.content_bytes),
      paragraphBytes = BigInt(row.paragraph_bytes);
    if (
      textBytes < 1n ||
      textBytes > 65536n ||
      paragraphBytes > 524288n ||
      row.paragraph_count < 1 ||
      row.paragraph_count > 1000
    )
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
    const reserved = textBytes + paragraphBytes + BigInt(row.paragraph_count * 512) + 4096n;
    reserveSourceBudget(budget, reserved);
    const body = await tx.query(
      `SELECT v.resource_id,v.version_id,v.version,v.previous_version_id,
      v.content,v.content_hash,v.paragraphs,v.content_status,v.index_status,v.created_at
      FROM resource_version v JOIN resource r ON r.athlete_id=v.athlete_id AND r.id=v.resource_id
      WHERE v.athlete_id=$1 AND v.version_id=$2::uuid AND r.deleted_at IS NULL
      AND r.access_revision=$3 AND r.current_version_id=$4::uuid AND r.source_kind='text'`,
      [tx.athleteId, id, current.accessRevision, current.versionId],
    );
    if (body.rows.length !== 1) throw new RaceImpactDependencyError('SOURCE_UNAVAILABLE');
    const recordRow = parse(bodySchema, body.rows[0]);
    if (
      recordRow.resource_id !== row.resource_id ||
      recordRow.version_id !== row.version_id ||
      recordRow.version !== row.version
    )
      invalid();
    const record = parse(privateTextResourceVersionSchema, {
      schemaVersion: 1,
      id: recordRow.version_id,
      resourceId: recordRow.resource_id,
      version: recordRow.version,
      previousVersionId: recordRow.previous_version_id,
      contentHash: recordRow.content_hash,
      source: { kind: 'text', text: recordRow.content },
      paragraphs: recordRow.paragraphs,
      lifecycle: { contentStatus: recordRow.content_status, indexStatus: recordRow.index_status },
      createdAt: recordRow.created_at,
    });
    if (BigInt(Buffer.byteLength(JSON.stringify(record))) > reserved) invalid();
    facts.push({
      requestedVersionId: id,
      state: id === current.versionId ? 'current' : 'historical',
      reason: null,
      record,
      current,
    });
  }
  const projection = parse(resourceRetainedReadFactsSchema, {
    requestedVersionIds: requests,
    facts,
    authority: 'none',
    freshness: 'not_checked',
  });
  const validation = validateResourceRetainedReadFacts(projection);
  if (
    validation.blockers.some(
      (blocker) =>
        !['owned_version_unavailable', 'unsupported_source_kind', 'source_deleted'].includes(
          blocker.reason,
        ),
    )
  )
    invalid();
  return projection;
}
