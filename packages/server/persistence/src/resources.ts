import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  privateTextResourceAppendVersionSchema,
  privateTextResourceCreateSchema,
  privateTextResourceDeleteResultSchema,
  privateTextResourceReadResultSchema,
  privateTextResourceSoftDeleteSchema,
  privateResourceDeleteResultSchema,
  privateResourceListQuerySchema,
  privateResourceListSchema,
  privateResourceReadQuerySchema,
  privateResourceReadResultSchema,
  privateResourceSchema,
  privateResourceVersionSchema,
  privateFileResourceVersionSchema,
  privateTextResourceVersionSchema,
  privateUrlResourceVersionSchema,
} from '@workout/contracts/resources';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

type CreateInput = z.infer<typeof privateTextResourceCreateSchema>;
type AppendInput = z.infer<typeof privateTextResourceAppendVersionSchema>;
type ListQuery = z.infer<typeof privateResourceListQuerySchema>;
type ListResult = z.infer<typeof privateResourceListSchema>;
type ReadQuery = z.infer<typeof privateResourceReadQuerySchema>;
type ReadResult = z.infer<typeof privateResourceReadResultSchema>;
type TextReadResult = z.infer<typeof privateTextResourceReadResultSchema>;
type DeleteInput = z.infer<typeof privateTextResourceSoftDeleteSchema>;
type DeleteResult = z.infer<typeof privateTextResourceDeleteResultSchema>;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();
const resourceRowSchema = z.object({
  id: uuid,
  source_kind: z.enum(['text', 'file', 'url']),
  title: z.string(),
  category: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  favorite: z.boolean(),
  include_for_coach: z.boolean(),
  reviewed_state: z.string(),
  access_revision: z.number().int(),
  current_version_id: uuid,
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
  deleted_at: z.union([z.date(), z.string()]).nullable(),
});
const urlProjectionRowSchema = z.object({
  version_id: uuid,
  state: z.enum(['finalized', 'bookmark_only']),
  display_url: z.string(),
  attempt_count: z.number().int().min(0).max(5),
  parser_name: z.string().min(1).max(100),
  parser_version: z.string().min(1).max(100),
  final_display_url: z.string(),
  fetched_at: z.union([z.date(), z.string()]),
  media_type: z.enum(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown']),
  size_bytes: z.coerce.number().int().positive(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  redirect_count: z.coerce.number().int().min(0).max(5),
});
const urlLocatorRowSchema = z.object({
  ordinal: z.number().int().min(0),
  kind: z.enum(['html_block', 'markdown_paragraph', 'plain_paragraph']),
  heading_path: z.array(z.string()),
  paragraph_index: z.number().int().nullable(),
  start_offset: z.number().int().min(0),
  end_offset: z.number().int().positive(),
  text: z.string(),
});
const versionRowSchema = z.object({
  version_id: uuid,
  resource_id: uuid,
  version: z.number().int(),
  previous_version_id: uuid.nullable(),
  content: z.string().nullable(),
  content_hash: z.string(),
  paragraphs: z.array(z.unknown()),
  content_status: z.string(),
  index_status: z.string(),
  storage_ref: z.string().nullable(),
  original_filename: z.string().nullable(),
  media_type: z.enum(['application/pdf', 'text/markdown']).nullable(),
  size_bytes: z.coerce.number().int().nullable(),
  created_at: z.union([z.date(), z.string()]),
});
const availableReceiptSchema = z.strictObject({
  status: z.literal('available'),
  resourceId: uuid,
  versionId: uuid,
  resource: privateResourceSchema.and(z.object({ deletedAt: z.null() })),
});
const resourceReceiptSchema = z.union([availableReceiptSchema, privateResourceDeleteResultSchema]);

export class ResourceNotFoundError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND';
  constructor() {
    super('RESOURCE_NOT_FOUND');
  }
}

export class ResourceValidationError extends Error {
  constructor(
    readonly code: 'PARAGRAPH_TOO_LARGE' | 'TOO_MANY_PARAGRAPHS' | 'RESOURCE_QUOTA_EXCEEDED',
  ) {
    super(code);
  }
}

export interface PrivateTextResourceRepository {
  create(athleteId: string, input: CreateInput): Promise<TextReadResult>;
  appendVersion(athleteId: string, resourceId: string, input: AppendInput): Promise<TextReadResult>;
  list(athleteId: string, query?: Partial<ListQuery>): Promise<ListResult>;
  read(athleteId: string, resourceId: string, query?: Partial<ReadQuery>): Promise<ReadResult>;
  softDelete(athleteId: string, resourceId: string, input: DeleteInput): Promise<DeleteResult>;
}

async function lock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
}

async function replay(tx: Transaction, key: string, request: unknown) {
  const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const row = (
    await tx.query(
      'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
      [tx.athleteId, key, JSON.stringify({ sha256: requestDigest })],
    )
  ).rows[0];
  if (!row) return null;
  if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return resourceReceiptSchema.parse(row['result']);
}

export async function finishResourceCommand(
  tx: Transaction,
  key: string,
  request: unknown,
  receipt: z.infer<typeof resourceReceiptSchema>,
  event: { resourceId: string; versionId: string | null },
  topic: string,
) {
  const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: key,
    topic,
    payload: event,
  });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify({ sha256: requestDigest }), JSON.stringify(receipt)],
  );
}

async function replayRead(tx: Transaction, receipt: z.infer<typeof resourceReceiptSchema>) {
  if (receipt.status === 'deleted') return receipt;
  const stored = await readPrivateResourceStored(tx, receipt.resourceId, receipt.versionId);
  if (stored.status !== 'available') return stored;
  return privateTextResourceReadResultSchema.parse({
    ...stored,
    resource: receipt.resource,
    reader: { ...stored.reader, title: receipt.resource.title },
  });
}

function paragraphRows(text: string, versionId: string) {
  const paragraphs: {
    locator: {
      kind: 'paragraph';
      resourceVersionId: string;
      index: number;
      startOffset: number;
      endOffset: number;
      offsetUnit: 'utf16_code_unit';
    };
    text: string;
  }[] = [];
  const separator = /\r?\n[ \t]*\r?\n/g;
  let start = 0;
  const add = (from: number, to: number) => {
    const segment = text.slice(from, to);
    const leading = segment.search(/\S/);
    if (leading < 0) return;
    const trailing = segment.match(/\s*$/)?.[0].length ?? 0;
    const paragraphStart = from + leading;
    const paragraphEnd = to - trailing;
    const content = text.slice(paragraphStart, paragraphEnd);
    if (content.length > 8192) throw new ResourceValidationError('PARAGRAPH_TOO_LARGE');
    paragraphs.push({
      locator: {
        kind: 'paragraph',
        resourceVersionId: versionId,
        index: paragraphs.length,
        startOffset: paragraphStart,
        endOffset: paragraphEnd,
        offsetUnit: 'utf16_code_unit',
      },
      text: content,
    });
  };
  for (const match of text.matchAll(separator)) {
    add(start, match.index);
    start = match.index + match[0].length;
  }
  add(start, text.length);
  if (paragraphs.length > 1000) throw new ResourceValidationError('TOO_MANY_PARAGRAPHS');
  return paragraphs;
}

export async function assertPrivateResourceQuota(tx: Transaction) {
  const row = (
    await tx.query(
      `SELECT
         count(DISTINCT r.id) FILTER (WHERE r.deleted_at IS NULL)::integer AS active_resources,
         count(v.version_id) FILTER (WHERE r.deleted_at IS NULL)::integer AS active_versions,
         coalesce(sum(octet_length(convert_to(v.content,'UTF8'))+octet_length(v.paragraphs::text))
           FILTER (WHERE r.deleted_at IS NULL AND v.content IS NOT NULL),0)::integer AS active_text_bytes,
         (coalesce(sum(v.size_bytes) FILTER (WHERE r.deleted_at IS NULL AND v.storage_ref IS NOT NULL),0)
           +coalesce((SELECT sum(a.size_bytes) FROM resource_url_artifact a
             JOIN resource ar ON ar.athlete_id=a.athlete_id AND ar.id=a.resource_id
             WHERE a.athlete_id=$1 AND ar.deleted_at IS NULL),0))::bigint AS active_file_bytes,
         count(v.version_id)::integer AS total_versions,
         coalesce(sum(octet_length(convert_to(v.content,'UTF8'))+octet_length(v.paragraphs::text))
           FILTER (WHERE v.content IS NOT NULL),0)::integer AS total_text_bytes,
         (coalesce(sum(v.size_bytes) FILTER (WHERE v.storage_ref IS NOT NULL),0)
           +coalesce((SELECT sum(a.size_bytes) FROM resource_url_artifact a
             WHERE a.athlete_id=$1),0))::bigint AS total_file_bytes
       FROM resource r LEFT JOIN resource_version v
         ON v.athlete_id=r.athlete_id AND v.resource_id=r.id
       WHERE r.athlete_id=$1`,
      [tx.athleteId],
    )
  ).rows[0];
  const quota = z
    .object({
      active_resources: z.number().int(),
      active_versions: z.number().int(),
      active_text_bytes: z.number().int(),
      active_file_bytes: z.coerce.number().int(),
      total_versions: z.number().int(),
      total_text_bytes: z.number().int(),
      total_file_bytes: z.coerce.number().int(),
    })
    .parse(row);
  if (
    quota.active_resources > 100 ||
    quota.active_versions > 1000 ||
    quota.active_text_bytes > 4 * 1024 * 1024 ||
    quota.active_file_bytes > 100 * 1024 * 1024 ||
    quota.total_versions > 2000 ||
    quota.total_text_bytes > 16 * 1024 * 1024 ||
    quota.total_file_bytes > 500 * 1024 * 1024
  )
    throw new ResourceValidationError('RESOURCE_QUOTA_EXCEEDED');
}

type UrlProjection = z.infer<typeof urlProjectionRowSchema>;

function urlLifecycle(row: UrlProjection) {
  return {
    contentStatus: row.state,
    displayUrl: row.display_url,
    attempt: row.attempt_count,
    retryAt: null,
    indexStatus: 'not_indexed' as const,
  };
}

function urlProvenance(row: UrlProjection) {
  return {
    requestedDisplayUrl: row.display_url,
    finalDisplayUrl: row.final_display_url,
    fetchedAt: iso(row.fetched_at),
    mediaType: row.media_type,
    byteSize: row.size_bytes,
    sha256: row.content_hash,
    redirectCount: row.redirect_count,
    parser: { name: row.parser_name, version: row.parser_version },
  };
}

async function loadUrlProjections(tx: Transaction, versionIds: string[]) {
  if (versionIds.length === 0) return new Map<string, UrlProjection>();
  const result = await tx.query(
    `SELECT i.version_id,i.state,i.display_url,i.attempt_count,i.parser_name,i.parser_version,
       p.final_display_url,p.fetched_at,a.media_type,a.size_bytes,a.content_hash,
       greatest((SELECT count(*) FROM resource_url_fetch_hop h
         WHERE h.athlete_id=i.athlete_id AND h.request_id=i.request_id
           AND h.attempt_no=p.successful_attempt_no)-1,0)::integer AS redirect_count
     FROM resource_url_ingestion i
     JOIN resource_url_provenance p
       ON p.athlete_id=i.athlete_id AND p.request_id=i.request_id AND p.version_id=i.version_id
     JOIN resource_url_artifact a
       ON a.athlete_id=i.athlete_id AND a.request_id=i.request_id
       AND a.version_id=i.version_id AND a.kind='raw'
     WHERE i.athlete_id=$1 AND i.version_id=ANY($2::uuid[])
       AND i.state IN ('finalized','bookmark_only')`,
    [tx.athleteId, versionIds],
  );
  return new Map(
    z
      .array(urlProjectionRowSchema)
      .parse(result.rows)
      .map((projection) => [projection.version_id, projection]),
  );
}

async function loadUrlProjection(tx: Transaction, versionId: string) {
  return (await loadUrlProjections(tx, [versionId])).get(versionId) ?? null;
}

function resource(row: z.infer<typeof resourceRowSchema>, url: UrlProjection | null = null) {
  const lifecycle =
    row.source_kind === 'text'
      ? { contentStatus: 'parsed' as const, indexStatus: 'not_indexed' as const }
      : row.source_kind === 'file'
        ? { contentStatus: 'raw_stored' as const, indexStatus: 'not_indexed' as const }
        : urlLifecycle(
            url ??
              (() => {
                throw new Error('MISSING_URL_PROJECTION');
              })(),
          );
  return privateResourceSchema.parse({
    schemaVersion: 1,
    id: row.id,
    sourceKind: row.source_kind,
    title: row.title,
    category: row.category,
    metadata: row.metadata,
    tags: row.tags,
    visibility: 'private',
    favorite: row.favorite,
    includeForCoach: row.include_for_coach,
    reviewedState: row.reviewed_state,
    lifecycle,
    accessRevision: row.access_revision,
    currentVersionId: row.current_version_id,
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function version(
  row: z.infer<typeof versionRowSchema>,
  sourceKind: z.infer<typeof resourceRowSchema>['source_kind'],
  url: UrlProjection | null = null,
  parsedSnapshot?: { resourceVersionId: string; text: string; fragments: unknown[] },
) {
  if (sourceKind === 'url') {
    const projection =
      url ??
      (() => {
        throw new Error('MISSING_URL_PROJECTION');
      })();
    return privateResourceVersionSchema.parse({
      schemaVersion: 1,
      id: row.version_id,
      resourceId: row.resource_id,
      version: row.version,
      previousVersionId: row.previous_version_id,
      contentHash: row.content_hash,
      source: { kind: 'url', displayUrl: projection.display_url },
      lifecycle: urlLifecycle(projection),
      provenance: urlProvenance(projection),
      ...(projection.state === 'finalized' ? { parsedSnapshot } : {}),
      createdAt: iso(row.created_at),
    });
  }
  const source =
    row.content === null
      ? {
          kind: 'file' as const,
          file: {
            originalFileName: row.original_filename,
            extension:
              row.media_type === 'application/pdf'
                ? ('pdf' as const)
                : row.original_filename?.toLocaleLowerCase('en-US').endsWith('.markdown')
                  ? ('markdown' as const)
                  : ('md' as const),
            mediaType: row.media_type,
            byteSize: row.size_bytes,
            sha256: row.content_hash,
          },
        }
      : { kind: 'text' as const, text: row.content };
  return privateResourceVersionSchema.parse({
    schemaVersion: 1,
    id: row.version_id,
    resourceId: row.resource_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    contentHash: row.content_hash,
    source,
    ...(row.content === null ? {} : { paragraphs: row.paragraphs }),
    lifecycle: { contentStatus: row.content_status, indexStatus: row.index_status },
    createdAt: iso(row.created_at),
  });
}

export async function readPrivateResourceStored(
  tx: Transaction,
  resourceId: string,
  versionId?: string,
): Promise<ReadResult> {
  const found = await tx.query('SELECT * FROM resource WHERE athlete_id=$1 AND id=$2', [
    tx.athleteId,
    resourceId,
  ]);
  if (!found.rows[0]) return privateResourceReadResultSchema.parse({ status: 'unavailable' });
  const resourceRow = resourceRowSchema.parse(found.rows[0]);
  if (resourceRow.deleted_at !== null)
    return privateResourceReadResultSchema.parse({
      status: 'deleted',
      resourceId,
      deletedAt: iso(resourceRow.deleted_at),
      accessRevision: resourceRow.access_revision,
    });
  const selectedVersionId = versionId ?? resourceRow.current_version_id;
  const storedVersion = await tx.query(
    `SELECT * FROM resource_version
     WHERE athlete_id=$1 AND resource_id=$2 AND version_id=$3`,
    [tx.athleteId, resourceId, selectedVersionId],
  );
  if (!storedVersion.rows[0])
    return privateResourceReadResultSchema.parse({ status: 'unavailable' });
  const storedVersionRow = versionRowSchema.parse(storedVersion.rows[0]);
  const currentUrl =
    resourceRow.source_kind === 'url'
      ? await loadUrlProjection(tx, resourceRow.current_version_id)
      : null;
  const selectedUrl =
    resourceRow.source_kind === 'url'
      ? selectedVersionId === resourceRow.current_version_id
        ? currentUrl
        : await loadUrlProjection(tx, selectedVersionId)
      : null;
  if (resourceRow.source_kind === 'url' && (!currentUrl || !selectedUrl))
    return privateResourceReadResultSchema.parse({ status: 'unavailable' });
  let parsedSnapshot: { resourceVersionId: string; text: string; fragments: unknown[] } | undefined;
  if (resourceRow.source_kind === 'url' && selectedUrl?.state === 'finalized') {
    const locators = await tx.query(
      `SELECT ordinal,kind,heading_path,paragraph_index,start_offset,end_offset,text
       FROM resource_url_locator WHERE athlete_id=$1 AND version_id=$2 ORDER BY ordinal`,
      [tx.athleteId, selectedVersionId],
    );
    const fragments = z
      .array(urlLocatorRowSchema)
      .parse(locators.rows)
      .map((locator) => ({
        locator: {
          kind: locator.kind,
          resourceVersionId: selectedVersionId,
          index: locator.ordinal,
          startOffset: locator.start_offset,
          endOffset: locator.end_offset,
          offsetUnit: 'utf16_code_unit' as const,
          ...(locator.kind === 'html_block' || locator.kind === 'markdown_paragraph'
            ? { headingPath: locator.heading_path }
            : {}),
          ...(locator.kind === 'markdown_paragraph' || locator.kind === 'plain_paragraph'
            ? { paragraphIndex: locator.paragraph_index }
            : {}),
        },
        text: locator.text,
      }));
    parsedSnapshot = {
      resourceVersionId: selectedVersionId,
      text: z.string().parse(storedVersionRow.content),
      fragments,
    };
  }
  const projectedResource = resource(resourceRow, currentUrl);
  const projectedVersion = version(
    storedVersionRow,
    resourceRow.source_kind,
    selectedUrl,
    parsedSnapshot,
  );
  const reader = (() => {
    if (resourceRow.source_kind === 'text') {
      const textVersion = privateTextResourceVersionSchema.parse(projectedVersion);
      return {
        resourceId,
        resourceVersionId: textVersion.id,
        title: projectedResource.title,
        sourceKind: 'text' as const,
        lifecycle: textVersion.lifecycle,
        originalText: textVersion.source.text,
        paragraphs: textVersion.paragraphs,
      };
    }
    if (resourceRow.source_kind === 'file') {
      const fileVersion = privateFileResourceVersionSchema.parse(projectedVersion);
      return {
        resourceId,
        resourceVersionId: fileVersion.id,
        title: projectedResource.title,
        sourceKind: 'file' as const,
        lifecycle: fileVersion.lifecycle,
        file: fileVersion.source.file,
      };
    }
    const urlVersion = privateUrlResourceVersionSchema.parse(projectedVersion);
    return {
      resourceId,
      resourceVersionId: urlVersion.id,
      title: projectedResource.title,
      sourceKind: 'url' as const,
      lifecycle: urlVersion.lifecycle,
      provenance: urlVersion.provenance,
      ...(urlVersion.parsedSnapshot ? { parsedSnapshot: urlVersion.parsedSnapshot } : {}),
    };
  })();
  return privateResourceReadResultSchema.parse({
    status: 'available',
    resource: projectedResource,
    version: projectedVersion,
    reader,
  });
}

export function createPrivateTextResourceRepository(
  database: Database,
): PrivateTextResourceRepository {
  return {
    create(athleteId, raw) {
      const input = privateTextResourceCreateSchema.parse(raw);
      const key = `resource:create:${input.idempotencyKey}`;
      const request = { kind: 'resource_create', ...input };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const prior = await replay(tx, key, request);
        if (prior) return replayRead(tx, prior);
        const resourceId = randomUUID();
        const versionId = randomUUID();
        const paragraphs = paragraphRows(input.text, versionId);
        const createdAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        await tx.query(
          `INSERT INTO resource
           (athlete_id,id,title,category,metadata,tags,favorite,include_for_coach,reviewed_state,
            access_revision,current_version,current_version_id,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,false,'unreviewed',1,1,$8,$9,$9)`,
          [
            athleteId,
            resourceId,
            input.title,
            input.category,
            JSON.stringify(input.metadata),
            JSON.stringify(input.tags),
            input.favorite,
            versionId,
            createdAt,
          ],
        );
        await tx.query(
          `INSERT INTO resource_version
           (athlete_id,resource_id,version_id,version,previous_version,previous_version_id,
            content,content_hash,paragraphs,content_status,index_status,created_at)
           VALUES($1,$2,$3,1,NULL,NULL,$4,$5,$6::jsonb,'parsed','not_indexed',$7)`,
          [
            athleteId,
            resourceId,
            versionId,
            input.text,
            createHash('sha256').update(input.text).digest('hex'),
            JSON.stringify(paragraphs),
            createdAt,
          ],
        );
        await assertPrivateResourceQuota(tx);
        const result = await readPrivateResourceStored(tx, resourceId, versionId);
        if (result.status !== 'available') throw new ResourceNotFoundError();
        await finishResourceCommand(
          tx,
          key,
          request,
          { status: 'available', resourceId, versionId, resource: result.resource },
          { resourceId, versionId },
          'resource.created',
        );
        return privateTextResourceReadResultSchema.parse(result);
      });
    },
    appendVersion(athleteId, resourceId, raw) {
      const id = uuid.parse(resourceId);
      const input = privateTextResourceAppendVersionSchema.parse(raw);
      const key = `resource:append:${input.idempotencyKey}`;
      const request = { kind: 'resource_append', resourceId: id, ...input };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const prior = await replay(tx, key, request);
        if (prior) return replayRead(tx, prior);
        const head = (
          await tx.query(
            `SELECT current_version,current_version_id FROM resource
             WHERE athlete_id=$1 AND id=$2 AND source_kind='text' AND deleted_at IS NULL FOR UPDATE`,
            [athleteId, id],
          )
        ).rows[0];
        if (!head) throw new ResourceNotFoundError();
        if (head['current_version_id'] !== input.expectedCurrentVersionId)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const versionId = randomUUID();
        const paragraphs = paragraphRows(input.text, versionId);
        const nextVersion = z.number().int().parse(head['current_version']) + 1;
        const createdAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        await tx.query(
          `INSERT INTO resource_version
           (athlete_id,resource_id,version_id,version,previous_version,previous_version_id,
            content,content_hash,paragraphs,content_status,index_status,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'parsed','not_indexed',$10)`,
          [
            athleteId,
            id,
            versionId,
            nextVersion,
            nextVersion - 1,
            input.expectedCurrentVersionId,
            input.text,
            createHash('sha256').update(input.text).digest('hex'),
            JSON.stringify(paragraphs),
            createdAt,
          ],
        );
        await tx.query(
          `UPDATE resource SET current_version=$3,current_version_id=$4,
           access_revision=access_revision+1,updated_at=$5
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, id, nextVersion, versionId, createdAt],
        );
        await assertPrivateResourceQuota(tx);
        const result = await readPrivateResourceStored(tx, id, versionId);
        if (result.status !== 'available') throw new ResourceNotFoundError();
        await finishResourceCommand(
          tx,
          key,
          request,
          { status: 'available', resourceId: id, versionId, resource: result.resource },
          { resourceId: id, versionId },
          'resource.version_appended',
        );
        return privateTextResourceReadResultSchema.parse(result);
      });
    },
    list(athleteId, raw = {}) {
      const query = privateResourceListQuerySchema.parse(raw);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `WITH filtered AS MATERIALIZED (
             SELECT * FROM resource WHERE athlete_id=$1 AND deleted_at IS NULL
               AND ($2::text IS NULL OR strpos(lower(title),lower($2))>0)
               AND ($3::text IS NULL OR category=$3)
               AND ($4::boolean IS NULL OR favorite=$4)
           ), page AS (
             SELECT * FROM filtered ORDER BY updated_at DESC,id LIMIT $5 OFFSET $6
           ) SELECT (SELECT count(*)::integer FROM filtered) AS total,
             coalesce((SELECT jsonb_agg(p ORDER BY updated_at DESC,id) FROM page p),'[]'::jsonb) AS items`,
          [
            athleteId,
            query.query ?? null,
            query.category ?? null,
            query.favorite ?? null,
            query.limit,
            query.offset,
          ],
        );
        const rows = z.array(resourceRowSchema).parse(result.rows[0]?.['items']);
        const urlProjections = await loadUrlProjections(
          tx,
          rows.filter((row) => row.source_kind === 'url').map((row) => row.current_version_id),
        );
        return privateResourceListSchema.parse({
          items: rows.map((row) =>
            resource(row, urlProjections.get(row.current_version_id) ?? null),
          ),
          total: z.number().int().parse(result.rows[0]?.['total']),
        });
      });
    },
    read(athleteId, resourceId, raw = {}) {
      const id = uuid.parse(resourceId);
      const query = privateResourceReadQuerySchema.parse(raw);
      return database.tenant(athleteId, (tx) => readPrivateResourceStored(tx, id, query.versionId));
    },
    softDelete(athleteId, resourceId, raw) {
      const id = uuid.parse(resourceId);
      const input = privateTextResourceSoftDeleteSchema.parse(raw);
      const key = `resource:delete:${input.idempotencyKey}`;
      const request = { kind: 'resource_delete', resourceId: id, ...input };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const prior = await replay(tx, key, request);
        if (prior) {
          if (prior.status !== 'deleted') throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return prior;
        }
        const head = (
          await tx.query(
            `SELECT access_revision,current_version_id FROM resource
             WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
            [athleteId, id],
          )
        ).rows[0];
        if (!head) throw new ResourceNotFoundError();
        if (
          head['access_revision'] !== input.expectedAccessRevision ||
          head['current_version_id'] !== input.expectedCurrentVersionId
        )
          throw new PersistenceConflict('REVISION_CONFLICT');
        const deletedAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        const accessRevision = input.expectedAccessRevision + 1;
        await tx.query(
          `UPDATE resource SET access_revision=$3,updated_at=$4,deleted_at=$4,
             include_for_coach=false,coach_use_enabled_at=NULL
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, id, accessRevision, deletedAt],
        );
        const result = privateTextResourceDeleteResultSchema.parse({
          status: 'deleted',
          resourceId: id,
          deletedAt,
          accessRevision,
        });
        await tx.query(
          `INSERT INTO resource_access_audit
            (athlete_id,event_id,resource_id,action,access_revision,share_id,grantee_kind,
             grantee_principal_id,occurred_at)
           VALUES($1,$2,$3,'resource_deleted',$4,NULL,NULL,NULL,$5)`,
          [athleteId, randomUUID(), id, accessRevision, deletedAt],
        );
        await tx.query("SELECT public.revoke_resource_shares($1,'RESOURCE_DELETED')", [id]);
        await tx.query("SELECT public.enqueue_resource_derived_cleanup($1,'resource_deleted')", [
          id,
        ]);
        await tx.query('SELECT public.tombstone_resource_receipts($1)', [id]);
        await tx.query("SELECT public.cancel_resource_uploads($1,'RESOURCE_DELETED')", [id]);
        await tx.query("SELECT public.enqueue_resource_object_cleanup($1,'resource_deleted')", [
          id,
        ]);
        await finishResourceCommand(
          tx,
          key,
          request,
          result,
          { resourceId: id, versionId: null },
          'resource.deleted',
        );
        return result;
      });
    },
  };
}
