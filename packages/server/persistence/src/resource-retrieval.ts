import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  chunkResourceParagraphs,
  RESOURCE_PASSAGE_CORPUS_VERSION,
  type ResourcePassageParagraph,
} from '@workout/server-resource-ingestion';
import {
  coachingRunGroundingSchema,
  resourceRetrievalQuerySchema,
  resourceRetrievalResultSchema,
  RESOURCE_RETRIEVAL_MAX_EXCERPTS,
  type CoachingRunGrounding,
  type ResourceRetrievalResult,
} from '@workout/contracts/resource-retrieval';
import type { PrivateResourceCoachUseManifest } from '@workout/contracts/resources';

import type { Database, Transaction } from './database.js';
import { captureResourceCoachUseManifest } from './resource-access.js';

/**
 * ACL-filtered retrieval over reviewed private resources.
 *
 * Authorization is never taken from the index, the cache or a pinned manifest.
 * Every read joins `public.resource_coach_use_authorized()` — the same
 * query-time gate the access ledger uses — so a deleted resource, a withdrawn
 * consent, a revoked share, a review downgrade and an open derived-cleanup
 * manifest all stop retrieval on the next statement, ahead of any model call.
 * The filter runs before ranking, so unauthorized rows never become candidates
 * and never reach a model to be filtered there.
 *
 * Retrieved text is untrusted data. Nothing in a passage grants tool access,
 * policy change or approval authority.
 */
export class ResourceRetrievalError extends Error {
  constructor(
    readonly code:
      | 'COACH_USE_CONSENT_REQUIRED'
      | 'GROUNDING_NOT_FOUND'
      | 'GROUNDING_ALREADY_PINNED'
      | 'GROUNDING_SET_CHANGED'
      | 'RETRIEVAL_SET_UNSTABLE'
      | 'CITATION_NOT_GROUNDED'
      | 'CITATION_OUT_OF_RANGE'
      | 'CITATION_NOT_AUTHORIZED',
  ) {
    super(code);
  }
}

const uuid = z.uuid().transform((value) => value.toLowerCase());
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

/** Bounded per call so one query cannot index an entire corpus synchronously. */
const MAX_INDEXED_RESOURCES_PER_CALL = 5;
const MAX_AUTHORIZED_RESOURCES = 100;
const MAX_GROUNDING_EXCERPTS = 20;
const CACHE_TTL_SECONDS = 600;
/** Bounded per tenant so distinct queries cannot grow the cache without limit. */
const MAX_CACHE_ENTRIES_PER_TENANT = 50;
/** Bounded retries for observing one stable authorized set. */
const RETRIEVAL_SET_ATTEMPTS = 3;
const MAX_QUOTE_LENGTH = 2000;

/**
 * Stable, content-derived identifier. The same version chunked twice yields the
 * same passage id, so re-indexing does not orphan a citation and two concurrent
 * indexers cannot create two rows for one excerpt.
 */
function stablePassageId(athleteId: string, versionId: string, ordinal: number, hash: string) {
  const digest = createHash('sha256')
    .update(JSON.stringify(['resource-passage-v1', athleteId, versionId, ordinal, hash]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const version = bytes[6];
  const variant = bytes[8];
  if (version === undefined || variant === undefined) throw new Error('DIGEST_TOO_SHORT');
  bytes[6] = (version & 0x0f) | 0x80;
  bytes[8] = (variant & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const storedParagraphSchema = z.object({
  locator: z.object({
    index: z.number().int().min(0).max(999),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().positive(),
    headingPath: z.array(z.string().min(1).max(200)).max(8).optional(),
  }),
  text: z.string().min(1).max(8192),
});

const authorizedRowSchema = z.object({
  resource_id: uuid,
  current_version_id: uuid,
  access_revision: z.number().int().positive(),
  title: z.string().min(1).max(200),
  indexed: z.boolean(),
});

const passageRowSchema = z.object({
  passage_id: uuid,
  resource_id: uuid,
  version_id: uuid,
  ordinal: z.number().int().min(0).max(999),
  heading_path: z.array(z.string().min(1).max(200)).max(8),
  start_offset: z.number().int().min(0),
  end_offset: z.number().int().positive(),
  content: z.string().min(1),
  access_revision: z.number().int().positive(),
  title: z.string().min(1).max(200),
});

/**
 * The authorized set, expressed once. `resource_coach_use_authorized` is the
 * gate function itself, so this predicate cannot drift from the access ledger.
 */
const authorizedResourcesSql = `SELECT r.id AS resource_id,r.current_version_id,
  r.access_revision,r.title,
  EXISTS(SELECT 1 FROM resource_passage p WHERE p.athlete_id=r.athlete_id
    AND p.resource_id=r.id AND p.version_id=r.current_version_id) AS indexed
 FROM resource r
 WHERE r.athlete_id=$1 AND r.deleted_at IS NULL AND public.resource_coach_use_authorized(r.id)
 ORDER BY r.id LIMIT ${MAX_AUTHORIZED_RESOURCES}`;

const passageColumns = `p.passage_id,p.resource_id,p.version_id,p.ordinal,p.heading_path,
  p.start_offset,p.end_offset,p.content,r.access_revision,r.title`;

/** Filter first, rank second. Candidates are drawn only from authorized rows. */
const lexicalSearchSql = `WITH authorized AS (
    SELECT r.id AS resource_id,r.current_version_id,r.access_revision,r.title
    FROM resource r
    WHERE r.athlete_id=$1 AND r.deleted_at IS NULL AND public.resource_coach_use_authorized(r.id)
  )
  SELECT ${passageColumns},
    ts_rank_cd(to_tsvector('simple'::regconfig,p.content),
      plainto_tsquery('simple'::regconfig,$2)) AS score
  FROM resource_passage p
  JOIN authorized r ON r.resource_id=p.resource_id AND r.current_version_id=p.version_id
  WHERE p.athlete_id=$1
    AND to_tsvector('simple'::regconfig,p.content) @@ plainto_tsquery('simple'::regconfig,$2)
  ORDER BY score DESC,p.resource_id,p.ordinal LIMIT $3`;

/** Re-authorizes cached identifiers one by one; a cache entry proves nothing. */
const cachedPassageSql = `SELECT ${passageColumns}
  FROM resource_passage p
  JOIN resource r ON r.athlete_id=p.athlete_id AND r.id=p.resource_id
  WHERE p.athlete_id=$1 AND p.passage_id=ANY($2::uuid[])
    AND r.deleted_at IS NULL AND r.current_version_id=p.version_id
    AND public.resource_coach_use_authorized(r.id)`;

async function readAuthorized(tx: Transaction) {
  const rows = await tx.query(authorizedResourcesSql, [tx.athleteId]);
  return z.array(authorizedRowSchema).parse(rows.rows);
}

/**
 * Deterministic, bounded indexing of the current version of authorized
 * resources. Nothing is fetched and no model is called, so it is safe inside
 * the caller's transaction. An unauthorized resource is never indexed.
 */
async function indexMissing(
  tx: Transaction,
  authorized: z.infer<typeof authorizedRowSchema>[],
): Promise<number> {
  const pending = authorized.filter((row) => !row.indexed).slice(0, MAX_INDEXED_RESOURCES_PER_CALL);
  let indexed = 0;
  for (const resource of pending) {
    const version = (
      await tx.query(
        `SELECT paragraphs FROM resource_version
         WHERE athlete_id=$1 AND resource_id=$2 AND version_id=$3`,
        [tx.athleteId, resource.resource_id, resource.current_version_id],
      )
    ).rows[0];
    if (!version) continue;
    const parsed = z.array(storedParagraphSchema).safeParse(version['paragraphs']);
    if (!parsed.success) continue;
    const paragraphs: ResourcePassageParagraph[] = parsed.data.map((paragraph) => ({
      index: paragraph.locator.index,
      startOffset: paragraph.locator.startOffset,
      endOffset: paragraph.locator.endOffset,
      text: paragraph.text,
      // Heading breadcrumbs are parsed from untrusted documents; normalize them
      // to the bounded shape the contract allows instead of trusting the parser.
      headingPath: (paragraph.locator.headingPath ?? [])
        .map((heading) => heading.replaceAll('\0', '').trim())
        .filter((heading) => heading.length > 0)
        .slice(0, 8),
    }));
    for (const chunk of chunkResourceParagraphs(paragraphs)) {
      await tx.query(
        `INSERT INTO resource_passage(athlete_id,passage_id,resource_id,version_id,ordinal,
           first_paragraph_index,last_paragraph_index,start_offset,end_offset,heading_path,
           content,content_hash,indexed_access_revision,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,statement_timestamp())
         ON CONFLICT (athlete_id,resource_id,version_id,ordinal) DO NOTHING`,
        [
          tx.athleteId,
          stablePassageId(
            tx.athleteId,
            resource.current_version_id,
            chunk.ordinal,
            chunk.contentHash,
          ),
          resource.resource_id,
          resource.current_version_id,
          chunk.ordinal,
          chunk.firstParagraphIndex,
          chunk.lastParagraphIndex,
          chunk.startOffset,
          chunk.endOffset,
          JSON.stringify(chunk.headingPath),
          chunk.content,
          chunk.contentHash,
          resource.access_revision,
        ],
      );
    }
    indexed += 1;
  }
  return indexed;
}

function cacheKey(input: {
  athleteId: string;
  authorizationDigest: string;
  query: string;
  limit: number;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        scope: 'resource-retrieval-v1',
        corpusVersion: RESOURCE_PASSAGE_CORPUS_VERSION,
        athleteId: input.athleteId,
        authorizationDigest: input.authorizationDigest,
        // Filters are part of the key; today the only filter is the limit.
        filters: { limit: input.limit },
        query: input.query,
      }),
    )
    .digest('hex');
}

function excerpt(row: z.infer<typeof passageRowSchema>) {
  return {
    resourceId: row.resource_id,
    versionId: row.version_id,
    passageId: row.passage_id,
    accessRevision: row.access_revision,
    ordinal: row.ordinal,
    title: row.title,
    headingPath: row.heading_path,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    text: row.content,
  };
}

/**
 * One ACL-filtered retrieval. The returned digest is the whole authorized set
 * observed during this statement sequence, so a caller can pin it and later
 * detect any change to the set rather than only to a listed entry.
 */
export async function retrieveAuthorizedExcerpts(
  tx: Transaction,
  input: unknown,
): Promise<ResourceRetrievalResult> {
  return (await retrieveWithManifest(tx, input)).result;
}

async function retrieveWithManifest(
  tx: Transaction,
  input: unknown,
): Promise<{ result: ResourceRetrievalResult; manifest: PrivateResourceCoachUseManifest }> {
  const query = resourceRetrievalQuerySchema.parse(input);
  // The manifest, the authorized set and the search are separate statements.
  // Completing a cleanup manifest widens the set and now takes the same tenant
  // command lock this capture takes, so it cannot interleave; the set identity
  // is re-read and compared before anything is cached or returned, so a set
  // that moved anyway fails closed instead of caching results of a set that is
  // no longer the one whose digest the entry is keyed by.
  for (let attempt = 0; attempt < RETRIEVAL_SET_ATTEMPTS; attempt += 1) {
    const manifest = await captureResourceCoachUseManifest(tx);
    const authorized = await readAuthorized(tx);
    await pruneSupersededPassages(tx);
    await indexMissing(tx, authorized);
    const key = cacheKey({
      athleteId: tx.athleteId,
      authorizationDigest: manifest.entriesDigest,
      query: query.query,
      limit: query.limit,
    });
    let cache: ResourceRetrievalResult['cache'] = 'miss';
    let excerpts: ReturnType<typeof excerpt>[] | null = null;
    const cached = (
      await tx.query(
        `SELECT passage_ids FROM resource_retrieval_cache
         WHERE athlete_id=$1 AND cache_key=$2 AND corpus_version=$3 AND authorization_digest=$4
           AND expires_at>statement_timestamp()`,
        [tx.athleteId, key, RESOURCE_PASSAGE_CORPUS_VERSION, manifest.entriesDigest],
      )
    ).rows[0];
    if (cached) {
      const ids = z.array(uuid).max(RESOURCE_RETRIEVAL_MAX_EXCERPTS).parse(cached['passage_ids']);
      const rows = z
        .array(passageRowSchema)
        .parse((await tx.query(cachedPassageSql, [tx.athleteId, ids])).rows);
      if (rows.length === ids.length) {
        const byId = new Map(rows.map((row) => [row.passage_id, row]));
        excerpts = ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [excerpt(row)] : [];
        });
        cache = 'revalidated';
      } else {
        // Any identifier that no longer re-authorizes discards the whole entry.
        await tx.query(
          'DELETE FROM resource_retrieval_cache WHERE athlete_id=$1 AND cache_key=$2',
          [tx.athleteId, key],
        );
        cache = 'invalidated';
      }
    }
    if (excerpts === null) {
      const found = z
        .array(passageRowSchema)
        .parse((await tx.query(lexicalSearchSql, [tx.athleteId, query.query, query.limit])).rows);
      excerpts = found.map(excerpt);
    }
    // Verified identity: the set observed before the search is still the set.
    const verified = await captureResourceCoachUseManifest(tx);
    if (verified.entriesDigest !== manifest.entriesDigest) continue;
    if (cache !== 'revalidated') {
      await reclaimRetrievalCache(tx);
      await tx.query(
        `INSERT INTO resource_retrieval_cache(athlete_id,cache_key,corpus_version,
           authorization_digest,passage_ids,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5::jsonb,statement_timestamp(),
           statement_timestamp()+make_interval(secs=>$6))
         ON CONFLICT (athlete_id,cache_key) DO UPDATE SET
           corpus_version=EXCLUDED.corpus_version,
           authorization_digest=EXCLUDED.authorization_digest,
           passage_ids=EXCLUDED.passage_ids,created_at=EXCLUDED.created_at,
           expires_at=EXCLUDED.expires_at`,
        [
          tx.athleteId,
          key,
          RESOURCE_PASSAGE_CORPUS_VERSION,
          manifest.entriesDigest,
          JSON.stringify(excerpts.map((item) => item.passageId)),
          CACHE_TTL_SECONDS,
        ],
      );
    }
    return {
      manifest,
      result: resourceRetrievalResultSchema.parse({
        schemaVersion: 1,
        scope: 'resource-retrieval-v1',
        query: query.query,
        checkedAt: manifest.capturedAt,
        authorizationDigest: manifest.entriesDigest,
        cache,
        authorizedResourceCount: authorized.length,
        excerpts,
      }),
    };
  }
  throw new ResourceRetrievalError('RETRIEVAL_SET_UNSTABLE');
}

/**
 * Superseded index rows are inert — retrieval requires the current version —
 * but they are still stored copies, so they are reclaimed on the next query
 * instead of waiting for the resource to be deleted.
 */
async function pruneSupersededPassages(tx: Transaction) {
  await tx.query(
    `DELETE FROM resource_passage p USING resource r
     WHERE p.athlete_id=$1 AND r.athlete_id=p.athlete_id AND r.id=p.resource_id
       AND p.version_id<>r.current_version_id`,
    [tx.athleteId],
  );
}

/**
 * Real reclamation, not only a read filter: expired entries are deleted and the
 * tenant is capped, so distinct queries cannot grow the table without bound.
 * The shared worker prunes globally as well.
 */
async function reclaimRetrievalCache(tx: Transaction) {
  await tx.query(
    'DELETE FROM resource_retrieval_cache WHERE athlete_id=$1 AND expires_at<=statement_timestamp()',
    [tx.athleteId],
  );
  await tx.query(
    `DELETE FROM resource_retrieval_cache c USING (
       SELECT cache_key FROM resource_retrieval_cache WHERE athlete_id=$1
       ORDER BY expires_at DESC,cache_key OFFSET $2
     ) surplus
     WHERE c.athlete_id=$1 AND c.cache_key=surplus.cache_key`,
    [tx.athleteId, MAX_CACHE_ENTRIES_PER_TENANT - 1],
  );
}

export interface PreparedGrounding {
  manifest: PrivateResourceCoachUseManifest;
  query: string;
  excerpts: {
    ordinal: number;
    passageId: string;
    resourceId: string;
    versionId: string;
    accessRevision: number;
    title: string;
    headingPath: string[];
    text: string;
  }[];
}

/**
 * Retrieves and returns what a run would be grounded on, without writing.
 * The caller pins the manifest on the run basis and then writes the grounding
 * with `writeRunGrounding`, so the basis and the stored excerpts always
 * describe the same observation.
 */
export async function prepareRunGrounding(
  tx: Transaction,
  query: string,
): Promise<PreparedGrounding> {
  const { result: retrieval, manifest } = await retrieveWithManifest(tx, {
    schemaVersion: 1,
    query,
    limit: RESOURCE_RETRIEVAL_MAX_EXCERPTS,
  });
  // Consent is a precondition of the gate itself, so an authorized excerpt
  // cannot exist without it; the explicit check keeps the failure named.
  if (!manifest.aiConsentGranted) throw new ResourceRetrievalError('COACH_USE_CONSENT_REQUIRED');
  // The manifest and the search read the authorized set in two statements. The
  // tenant lock serializes the application's own access commands but not the
  // cleanup lifecycle, so refuse rather than pin excerpts the manifest does not
  // describe: approval revalidates the manifest, not the stored excerpts.
  const pinnedResources = new Set(manifest.entries.map((entry) => entry.resourceId));
  if (retrieval.excerpts.some((item) => !pinnedResources.has(item.resourceId)))
    throw new ResourceRetrievalError('GROUNDING_SET_CHANGED');
  const excerpts = retrieval.excerpts.slice(0, MAX_GROUNDING_EXCERPTS).map((item, ordinal) => ({
    ordinal,
    passageId: item.passageId,
    resourceId: item.resourceId,
    versionId: item.versionId,
    accessRevision: item.accessRevision,
    title: item.title,
    headingPath: item.headingPath,
    text: item.text,
  }));
  return { manifest, query, excerpts };
}

/**
 * Writes the prepared grounding for one run. The excerpt copies are derived
 * data: the foreign key to the index row means a copy cannot outlive the
 * passage it came from.
 */
export async function writeRunGrounding(
  tx: Transaction,
  runId: string,
  prepared: PreparedGrounding,
): Promise<string> {
  const { manifest, query, excerpts } = prepared;
  const groundingId = randomUUID();
  const inserted = await tx.query(
    `INSERT INTO resource_grounding(athlete_id,grounding_id,run_id,query_text,excerpt_count,
       manifest,captured_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,statement_timestamp())
     ON CONFLICT (athlete_id,run_id) DO NOTHING RETURNING grounding_id`,
    [tx.athleteId, groundingId, runId, query, excerpts.length, JSON.stringify(manifest)],
  );
  if (!inserted.rows[0]) throw new ResourceRetrievalError('GROUNDING_ALREADY_PINNED');
  for (const item of excerpts)
    await tx.query(
      `INSERT INTO resource_grounding_excerpt(athlete_id,grounding_id,ordinal,passage_id,
         resource_id,version_id,access_revision,excerpt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tx.athleteId,
        groundingId,
        item.ordinal,
        item.passageId,
        item.resourceId,
        item.versionId,
        item.accessRevision,
        item.text,
      ],
    );
  return groundingId;
}

const citationInputSchema = z.strictObject({
  claimIndex: z.number().int().min(0).max(49),
  passageId: uuid,
  quoteStart: z.number().int().min(0),
  quoteEnd: z.number().int().positive(),
});

/**
 * Records citations for one grounding. A citation may only point at a passage
 * that this grounding pinned, that is still authorized by the query-time gate
 * and whose offsets are inside the live passage; the quoted text itself is
 * never copied, only hashed, so nothing has to be purged separately.
 *
 * Every citation is validated before the first row is written, so a rejected
 * batch leaves the caller's transaction usable and writes nothing.
 */
export async function recordRunCitations(
  tx: Transaction,
  runId: string,
  rawCitations: unknown,
): Promise<number> {
  const citations = z.array(citationInputSchema).max(50).parse(rawCitations);
  if (citations.length === 0) return 0;
  const grounding = (
    await tx.query(
      'SELECT grounding_id FROM resource_grounding WHERE athlete_id=$1 AND run_id=$2',
      [tx.athleteId, runId],
    )
  ).rows[0];
  if (!grounding) throw new ResourceRetrievalError('GROUNDING_NOT_FOUND');
  const groundingId = uuid.parse(grounding['grounding_id']);
  const validated: {
    claimIndex: number;
    passageId: string;
    resourceId: string;
    versionId: string;
    quoteStart: number;
    quoteEnd: number;
    quoteHash: string;
  }[] = [];
  for (const citation of citations) {
    if (citation.quoteEnd <= citation.quoteStart)
      throw new ResourceRetrievalError('CITATION_OUT_OF_RANGE');
    if (citation.quoteEnd - citation.quoteStart > MAX_QUOTE_LENGTH)
      throw new ResourceRetrievalError('CITATION_OUT_OF_RANGE');
    const grounded = (
      await tx.query(
        `SELECT e.resource_id,e.version_id,p.content,
           (r.deleted_at IS NULL AND r.current_version_id=p.version_id
             AND public.resource_coach_use_authorized(r.id)) AS authorized
         FROM resource_grounding_excerpt e
         JOIN resource_passage p ON p.athlete_id=e.athlete_id AND p.passage_id=e.passage_id
         JOIN resource r ON r.athlete_id=p.athlete_id AND r.id=p.resource_id
         WHERE e.athlete_id=$1 AND e.grounding_id=$2 AND e.passage_id=$3`,
        [tx.athleteId, groundingId, citation.passageId],
      )
    ).rows[0];
    // A citation may only point at an excerpt this grounding actually pinned.
    if (!grounded) throw new ResourceRetrievalError('CITATION_NOT_GROUNDED');
    // Authorization is rechecked here, in the write transaction, not taken
    // from the pin: a withdrawal between retrieval and write blocks the write.
    if (grounded['authorized'] !== true)
      throw new ResourceRetrievalError('CITATION_NOT_AUTHORIZED');
    const content = z.string().parse(grounded['content']);
    if (citation.quoteEnd > content.length)
      throw new ResourceRetrievalError('CITATION_OUT_OF_RANGE');
    validated.push({
      claimIndex: citation.claimIndex,
      passageId: citation.passageId,
      resourceId: uuid.parse(grounded['resource_id']),
      versionId: uuid.parse(grounded['version_id']),
      quoteStart: citation.quoteStart,
      quoteEnd: citation.quoteEnd,
      quoteHash: createHash('sha256')
        .update(content.slice(citation.quoteStart, citation.quoteEnd), 'utf8')
        .digest('hex'),
    });
  }
  for (const citation of validated)
    await tx.query(
      `INSERT INTO resource_citation(athlete_id,citation_id,grounding_id,passage_id,resource_id,
         version_id,claim_index,quote_start,quote_end,quote_hash,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,statement_timestamp())
       ON CONFLICT (athlete_id,grounding_id,claim_index,passage_id,quote_start,quote_end)
         DO NOTHING`,
      [
        tx.athleteId,
        randomUUID(),
        groundingId,
        citation.passageId,
        citation.resourceId,
        citation.versionId,
        citation.claimIndex,
        citation.quoteStart,
        citation.quoteEnd,
        citation.quoteHash,
      ],
    );
  return validated.length;
}

/**
 * Re-reading a stored answer resolves every excerpt and quote through the gate
 * again. A purged excerpt has no citation row left at all, and an excerpt whose
 * resource is currently blocked is reported as unavailable without its text.
 */
export async function readRunGrounding(
  tx: Transaction,
  runId: string,
): Promise<CoachingRunGrounding> {
  const row = (
    await tx.query(
      `SELECT grounding_id,query_text,excerpt_count,manifest,captured_at FROM resource_grounding
       WHERE athlete_id=$1 AND run_id=$2`,
      [tx.athleteId, runId],
    )
  ).rows[0];
  if (!row) return coachingRunGroundingSchema.parse({ status: 'none' });
  const groundingId = uuid.parse(row['grounding_id']);
  const pinnedResourceCount = z
    .object({ entries: z.array(z.unknown()).max(100) })
    .parse(row['manifest']).entries.length;
  // The count pinned at capture, not a live count: a purged excerpt row is
  // gone, so counting rows would hide exactly the withdrawal being reported.
  const pinnedExcerptCount = z.number().int().min(0).max(20).parse(row['excerpt_count']);
  const excerptRows = z
    .array(
      z.object({
        ordinal: z.number().int().min(0).max(19),
        passage_id: uuid,
        resource_id: uuid,
        version_id: uuid,
        access_revision: z.number().int().positive(),
        title: z.string().min(1).max(200),
        heading_path: z.array(z.string().min(1).max(200)).max(8),
        content: z.string().min(1),
      }),
    )
    .parse(
      (
        await tx.query(
          `SELECT e.ordinal,e.passage_id,e.resource_id,e.version_id,e.access_revision,
             r.title,p.heading_path,p.content
           FROM resource_grounding_excerpt e
           JOIN resource_passage p ON p.athlete_id=e.athlete_id AND p.passage_id=e.passage_id
           JOIN resource r ON r.athlete_id=p.athlete_id AND r.id=p.resource_id
           WHERE e.athlete_id=$1 AND e.grounding_id=$2 AND r.deleted_at IS NULL
             AND r.current_version_id=p.version_id
             AND public.resource_coach_use_authorized(r.id)
           ORDER BY e.ordinal`,
          [tx.athleteId, groundingId],
        )
      ).rows,
    );
  const citationRows = z
    .array(
      z.object({
        citation_id: uuid,
        claim_index: z.number().int().min(0).max(49),
        passage_id: uuid,
        resource_id: uuid,
        version_id: uuid,
        quote_start: z.number().int().min(0),
        quote_end: z.number().int().positive(),
        authorized: z.boolean(),
        title: z.string().min(1).max(200).nullable(),
        heading_path: z.array(z.string().min(1).max(200)).max(8).nullable(),
        content: z.string().min(1).nullable(),
        access_revision: z.number().int().positive().nullable(),
      }),
    )
    .parse(
      (
        await tx.query(
          `SELECT c.citation_id,c.claim_index,c.passage_id,c.resource_id,c.version_id,
             c.quote_start,c.quote_end,
             (live.passage_id IS NOT NULL) AS authorized,live.title,live.heading_path,live.content,
             live.access_revision
           FROM resource_citation c
           LEFT JOIN LATERAL (
             SELECT p.passage_id,p.heading_path,p.content,r.title,r.access_revision
             FROM resource_passage p
             JOIN resource r ON r.athlete_id=p.athlete_id AND r.id=p.resource_id
             WHERE p.athlete_id=c.athlete_id AND p.passage_id=c.passage_id
               AND r.deleted_at IS NULL AND r.current_version_id=p.version_id
               AND public.resource_coach_use_authorized(r.id)
           ) live ON true
           WHERE c.athlete_id=$1 AND c.grounding_id=$2
           ORDER BY c.claim_index,c.citation_id`,
          [tx.athleteId, groundingId],
        )
      ).rows,
    );
  return coachingRunGroundingSchema.parse({
    status: 'available',
    schemaVersion: 1,
    scope: 'resource-grounding-v1',
    groundingId,
    runId,
    query: z.string().parse(row['query_text']),
    capturedAt: iso(row['captured_at']),
    pinnedResourceCount,
    excerpts: excerptRows.map((item) => ({
      ordinal: item.ordinal,
      resourceId: item.resource_id,
      versionId: item.version_id,
      passageId: item.passage_id,
      accessRevision: item.access_revision,
      title: item.title,
      headingPath: item.heading_path,
      text: item.content,
    })),
    withdrawnExcerptCount: Math.max(pinnedExcerptCount - excerptRows.length, 0),
    citations: citationRows.map((item) =>
      item.authorized &&
      item.content !== null &&
      item.title !== null &&
      item.access_revision !== null
        ? {
            status: 'available',
            citationId: item.citation_id,
            claimIndex: item.claim_index,
            resourceId: item.resource_id,
            versionId: item.version_id,
            passageId: item.passage_id,
            accessRevision: item.access_revision,
            title: item.title,
            headingPath: item.heading_path ?? [],
            quoteStart: item.quote_start,
            quoteEnd: item.quote_end,
            quote: item.content.slice(item.quote_start, item.quote_end),
          }
        : {
            status: 'unavailable',
            citationId: item.citation_id,
            claimIndex: item.claim_index,
            reason: 'not_authorized',
          },
    ),
  });
}

export interface ResourceRetrievalRepository {
  retrieve(athleteId: string, query: unknown): Promise<ResourceRetrievalResult>;
  readGrounding(athleteId: string, runId: string): Promise<CoachingRunGrounding>;
}

export function createResourceRetrievalRepository(database: Database): ResourceRetrievalRepository {
  return {
    retrieve(athleteId, query) {
      return database.tenant(athleteId, (tx) => retrieveAuthorizedExcerpts(tx, query));
    },
    readGrounding(athleteId, runId) {
      const id = uuid.parse(runId);
      return database.tenant(athleteId, (tx) => readRunGrounding(tx, id));
    },
  };
}
