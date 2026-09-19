import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  privateTextResourceAppendVersionSchema,
  privateTextResourceCreateSchema,
  privateTextResourceDeleteResultSchema,
  privateTextResourceListQuerySchema,
  privateTextResourceListSchema,
  privateTextResourceReadQuerySchema,
  privateTextResourceReadResultSchema,
  privateTextResourceSchema,
  privateTextResourceSoftDeleteSchema,
  privateTextResourceVersionSchema,
} from '@workout/contracts/resources';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

type CreateInput = z.infer<typeof privateTextResourceCreateSchema>;
type AppendInput = z.infer<typeof privateTextResourceAppendVersionSchema>;
type ListQuery = z.infer<typeof privateTextResourceListQuerySchema>;
type ListResult = z.infer<typeof privateTextResourceListSchema>;
type ReadQuery = z.infer<typeof privateTextResourceReadQuerySchema>;
type ReadResult = z.infer<typeof privateTextResourceReadResultSchema>;
type DeleteInput = z.infer<typeof privateTextResourceSoftDeleteSchema>;
type DeleteResult = z.infer<typeof privateTextResourceDeleteResultSchema>;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();
const resourceRowSchema = z.object({
  id: uuid,
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
const versionRowSchema = z.object({
  version_id: uuid,
  resource_id: uuid,
  version: z.number().int(),
  previous_version_id: uuid.nullable(),
  content: z.string(),
  content_hash: z.string(),
  paragraphs: z.array(z.unknown()),
  content_status: z.string(),
  index_status: z.string(),
  created_at: z.union([z.date(), z.string()]),
});
const availableReceiptSchema = z.strictObject({
  status: z.literal('available'),
  resourceId: uuid,
  versionId: uuid,
  resource: privateTextResourceSchema.extend({ deletedAt: z.null() }),
});
const resourceReceiptSchema = z.union([
  availableReceiptSchema,
  privateTextResourceDeleteResultSchema,
]);

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
  create(athleteId: string, input: CreateInput): Promise<ReadResult>;
  appendVersion(athleteId: string, resourceId: string, input: AppendInput): Promise<ReadResult>;
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

async function finish(
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
  const stored = await readStored(tx, receipt.resourceId, receipt.versionId);
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

async function assertResourceQuota(tx: Transaction) {
  const row = (
    await tx.query(
      `SELECT
         count(DISTINCT r.id) FILTER (WHERE r.deleted_at IS NULL)::integer AS active_resources,
         count(v.version_id) FILTER (WHERE r.deleted_at IS NULL)::integer AS active_versions,
         coalesce(sum(octet_length(convert_to(v.content,'UTF8'))+octet_length(v.paragraphs::text))
           FILTER (WHERE r.deleted_at IS NULL),0)::integer AS active_bytes,
         count(v.version_id)::integer AS total_versions,
         coalesce(sum(octet_length(convert_to(v.content,'UTF8'))+octet_length(v.paragraphs::text)),0)::integer
           AS total_bytes
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
      active_bytes: z.number().int(),
      total_versions: z.number().int(),
      total_bytes: z.number().int(),
    })
    .parse(row);
  if (
    quota.active_resources > 100 ||
    quota.active_versions > 1000 ||
    quota.active_bytes > 4 * 1024 * 1024 ||
    quota.total_versions > 2000 ||
    quota.total_bytes > 16 * 1024 * 1024
  )
    throw new ResourceValidationError('RESOURCE_QUOTA_EXCEEDED');
}

function resource(row: z.infer<typeof resourceRowSchema>) {
  return privateTextResourceSchema.parse({
    schemaVersion: 1,
    id: row.id,
    sourceKind: 'text',
    title: row.title,
    category: row.category,
    metadata: row.metadata,
    tags: row.tags,
    visibility: 'private',
    favorite: row.favorite,
    includeForCoach: row.include_for_coach,
    reviewedState: row.reviewed_state,
    lifecycle: { contentStatus: 'parsed', indexStatus: 'not_indexed' },
    accessRevision: row.access_revision,
    currentVersionId: row.current_version_id,
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function version(row: z.infer<typeof versionRowSchema>) {
  return privateTextResourceVersionSchema.parse({
    schemaVersion: 1,
    id: row.version_id,
    resourceId: row.resource_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    contentHash: row.content_hash,
    source: { kind: 'text', text: row.content },
    paragraphs: row.paragraphs,
    lifecycle: { contentStatus: row.content_status, indexStatus: row.index_status },
    createdAt: iso(row.created_at),
  });
}

async function readStored(
  tx: Transaction,
  resourceId: string,
  versionId?: string,
): Promise<ReadResult> {
  const found = await tx.query('SELECT * FROM resource WHERE athlete_id=$1 AND id=$2', [
    tx.athleteId,
    resourceId,
  ]);
  if (!found.rows[0]) return privateTextResourceReadResultSchema.parse({ status: 'unavailable' });
  const resourceRow = resourceRowSchema.parse(found.rows[0]);
  if (resourceRow.deleted_at !== null)
    return privateTextResourceReadResultSchema.parse({
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
    return privateTextResourceReadResultSchema.parse({ status: 'unavailable' });
  const projectedResource = resource(resourceRow);
  const projectedVersion = version(versionRowSchema.parse(storedVersion.rows[0]));
  return privateTextResourceReadResultSchema.parse({
    status: 'available',
    resource: projectedResource,
    version: projectedVersion,
    reader: {
      resourceId,
      resourceVersionId: projectedVersion.id,
      title: projectedResource.title,
      sourceKind: 'text',
      lifecycle: projectedVersion.lifecycle,
      originalText: projectedVersion.source.text,
      paragraphs: projectedVersion.paragraphs,
    },
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
        await assertResourceQuota(tx);
        const result = await readStored(tx, resourceId, versionId);
        if (result.status !== 'available') throw new ResourceNotFoundError();
        await finish(
          tx,
          key,
          request,
          { status: 'available', resourceId, versionId, resource: result.resource },
          { resourceId, versionId },
          'resource.created',
        );
        return result;
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
             WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
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
        await assertResourceQuota(tx);
        const result = await readStored(tx, id, versionId);
        if (result.status !== 'available') throw new ResourceNotFoundError();
        await finish(
          tx,
          key,
          request,
          { status: 'available', resourceId: id, versionId, resource: result.resource },
          { resourceId: id, versionId },
          'resource.version_appended',
        );
        return result;
      });
    },
    list(athleteId, raw = {}) {
      const query = privateTextResourceListQuerySchema.parse(raw);
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
        return privateTextResourceListSchema.parse({
          items: z
            .array(resourceRowSchema)
            .parse(result.rows[0]?.['items'])
            .map((row) => resource(row)),
          total: z.number().int().parse(result.rows[0]?.['total']),
        });
      });
    },
    read(athleteId, resourceId, raw = {}) {
      const id = uuid.parse(resourceId);
      const query = privateTextResourceReadQuerySchema.parse(raw);
      return database.tenant(athleteId, (tx) => readStored(tx, id, query.versionId));
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
          `UPDATE resource SET access_revision=$3,updated_at=$4,deleted_at=$4
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, id, accessRevision, deletedAt],
        );
        const result = privateTextResourceDeleteResultSchema.parse({
          status: 'deleted',
          resourceId: id,
          deletedAt,
          accessRevision,
        });
        await tx.query('SELECT public.tombstone_resource_receipts($1)', [id]);
        await finish(
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
