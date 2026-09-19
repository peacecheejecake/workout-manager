import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  privateFileResourceAppendVersionUploadMetadataSchema,
  privateFileResourceCreateUploadMetadataSchema,
  privateFileResourceDescriptorSchema,
  privateFileResourceReadResultSchema,
} from '@workout/contracts/resources';
import type { Database, Transaction } from './database.js';
import { PersistenceConflict } from './outbox.js';
import {
  assertPrivateResourceQuota,
  finishResourceCommand,
  readPrivateResourceStored,
  ResourceNotFoundError,
} from './resources.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const finalStorageRef = z
  .string()
  .max(512)
  .regex(
    /^private\/v1\/tenants\/([0-9a-f-]{36})\/resources\/([0-9a-f-]{36})\/objects\/uploads\/([0-9a-f-]{36})\/sha256\/([a-f0-9]{64})\.(pdf|md)$/,
  );
const failureCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_:-]+$/);
const instant = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

type CreateMetadata = z.infer<typeof privateFileResourceCreateUploadMetadataSchema>;
type AppendMetadata = z.infer<typeof privateFileResourceAppendVersionUploadMetadataSchema>;
type FileDescriptor = z.infer<typeof privateFileResourceDescriptorSchema>;
type FileReadResult = z.infer<typeof privateFileResourceReadResultSchema>;

const intentRowSchema = z.object({
  upload_id: uuid,
  resource_id: uuid,
  version_id: uuid,
  idempotency_key: z.string(),
  request_digest: z.string(),
  operation: z.enum(['create', 'append']),
  expected_current_version_id: uuid.nullable(),
  temporary_ref: z.string().min(1).max(512),
  storage_ref: z.string().nullable(),
  state: z.enum(['reserved', 'prepared', 'staged', 'finalized', 'failed']),
  failure_code: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
  expires_at: z.union([z.date(), z.string()]),
});

export type ResourceFileUploadReservation = {
  uploadId: string;
  resourceId: string;
  versionId: string;
  state: 'reserved' | 'prepared' | 'staged' | 'finalized' | 'failed';
  createdAt: string;
  updatedAt: string;
};

export class ResourceFileUploadStateError extends Error {
  constructor(
    readonly code:
      | 'UPLOAD_FAILED'
      | 'UPLOAD_NOT_PREPARED'
      | 'UPLOAD_NOT_STAGED'
      | 'UPLOAD_QUOTA_EXCEEDED'
      | 'UPLOAD_HISTORY_QUOTA_EXCEEDED',
  ) {
    super(code);
  }
}

export interface ResourceFileUploadRepository {
  get(athleteId: string, uploadId: string): Promise<ResourceFileUploadReservation>;
  reserveCreate(
    athleteId: string,
    metadata: CreateMetadata,
    requestIdempotencyKey: string,
  ): Promise<ResourceFileUploadReservation>;
  reserveAppend(
    athleteId: string,
    resourceId: string,
    metadata: AppendMetadata,
    requestIdempotencyKey: string,
  ): Promise<ResourceFileUploadReservation>;
  prepareObject(
    athleteId: string,
    uploadId: string,
    prepared: { storageRef: string; file: FileDescriptor },
  ): Promise<ResourceFileUploadReservation>;
  markStaged(athleteId: string, uploadId: string): Promise<ResourceFileUploadReservation>;
  finalize(athleteId: string, uploadId: string): Promise<FileReadResult>;
  fail(athleteId: string, uploadId: string, code: string): Promise<{ failed: true }>;
  resolveObject(
    athleteId: string,
    resourceId: string,
    versionId?: string,
  ): Promise<{ storageRef: string; file: FileDescriptor } | null>;
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function tenantLock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
}

function reservation(row: z.infer<typeof intentRowSchema>): ResourceFileUploadReservation {
  return {
    uploadId: row.upload_id,
    resourceId: row.resource_id,
    versionId: row.version_id,
    state: row.state,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  };
}

async function assertPendingQuota(tx: Transaction) {
  await tx.query('SELECT public.compact_resource_upload_history(100)');
  const quota = await tx.query(
    `SELECT
       count(*) FILTER (WHERE state IN ('reserved','prepared','staged'))::integer AS pending_count,
       count(*) FILTER (WHERE state='failed')::integer AS failed_count,
       coalesce(sum(size_bytes) FILTER (WHERE state IN ('prepared','staged')),0)::bigint AS pending_bytes
     FROM resource_upload_intent WHERE athlete_id=$1`,
    [tx.athleteId],
  );
  const pendingCount = z.number().int().parse(quota.rows[0]?.['pending_count']);
  const failedCount = z.number().int().parse(quota.rows[0]?.['failed_count']);
  const pendingBytes = z.coerce.number().int().parse(quota.rows[0]?.['pending_bytes']);
  if (pendingCount >= 20 || pendingBytes > 50 * 1024 * 1024)
    throw new ResourceFileUploadStateError('UPLOAD_QUOTA_EXCEEDED');
  // A pending intent can become failed without another reservation check. Cap
  // their combined population so terminal transitions cannot exceed the
  // retained failed-history bound.
  if (failedCount + pendingCount >= 100)
    throw new ResourceFileUploadStateError('UPLOAD_HISTORY_QUOTA_EXCEEDED');
}

async function reserve(
  tx: Transaction,
  operation: 'create' | 'append',
  resourceId: string,
  metadata: CreateMetadata | AppendMetadata,
  key: string,
) {
  await tenantLock(tx);
  await tx.query('SELECT public.expire_resource_uploads(statement_timestamp())');
  const request = { operation, resourceId: operation === 'append' ? resourceId : null, metadata };
  const requestDigest = digest(request);
  const prior = await tx.query(
    `SELECT * FROM resource_upload_intent WHERE athlete_id=$1 AND idempotency_key=$2`,
    [tx.athleteId, key],
  );
  if (prior.rows[0]) {
    const parsed = intentRowSchema.parse(prior.rows[0]);
    if (parsed.request_digest !== requestDigest)
      throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
    return reservation(parsed);
  }
  await assertPendingQuota(tx);

  const versionId = randomUUID();
  const uploadId = randomUUID();
  const at = instant((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']);
  const expiresAt = new Date(new Date(at).getTime() + 30 * 60_000).toISOString();
  const temporaryRef = `private/v1/tenants/${tx.athleteId}/resources/${resourceId}/temporary/${uploadId}`;
  const isCreate = operation === 'create';
  const create = isCreate
    ? privateFileResourceCreateUploadMetadataSchema.parse(metadata)
    : undefined;
  const append = isCreate
    ? undefined
    : privateFileResourceAppendVersionUploadMetadataSchema.parse(metadata);
  if (append) {
    const head = await tx.query(
      `SELECT current_version_id,source_kind FROM resource
       WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [tx.athleteId, resourceId],
    );
    if (!head.rows[0] || head.rows[0]['source_kind'] !== 'file') throw new ResourceNotFoundError();
    if (head.rows[0]['current_version_id'] !== append.expectedCurrentVersionId)
      throw new PersistenceConflict('REVISION_CONFLICT');
  }
  const inserted = await tx.query(
    `INSERT INTO resource_upload_intent
     (athlete_id,upload_id,idempotency_key,request_digest,operation,resource_id,version_id,
      expected_current_version_id,temporary_ref,source_kind,title,category,metadata,tags,favorite,state,
      created_at,updated_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'file',$10,$11,$12::jsonb,$13::jsonb,$14,
      'reserved',$15,$15,$16)
     RETURNING *`,
    [
      tx.athleteId,
      uploadId,
      key,
      requestDigest,
      operation,
      resourceId,
      versionId,
      append?.expectedCurrentVersionId ?? null,
      temporaryRef,
      create?.title ?? null,
      create?.category ?? null,
      JSON.stringify(create?.metadata ?? {}),
      JSON.stringify(create?.tags ?? []),
      create?.favorite ?? false,
      at,
      expiresAt,
    ],
  );
  return reservation(intentRowSchema.parse(inserted.rows[0]));
}

export function createResourceFileUploadRepository(
  database: Database,
): ResourceFileUploadRepository {
  return {
    get(athleteId, rawUploadId) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      return database.tenant(tenantId, async (tx) => {
        await tx.query('SELECT public.expire_resource_uploads(statement_timestamp())');
        const found = await tx.query(
          'SELECT * FROM resource_upload_intent WHERE athlete_id=$1 AND upload_id=$2',
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new ResourceNotFoundError();
        return reservation(intentRowSchema.parse(found.rows[0]));
      });
    },
    reserveCreate(athleteId, rawMetadata, rawKey) {
      const tenantId = uuid.parse(athleteId);
      const metadata = privateFileResourceCreateUploadMetadataSchema.parse(rawMetadata);
      const key = idempotencyKey.parse(rawKey);
      return database.tenant(tenantId, (tx) => reserve(tx, 'create', randomUUID(), metadata, key));
    },
    reserveAppend(athleteId, rawResourceId, rawMetadata, rawKey) {
      const tenantId = uuid.parse(athleteId);
      const resourceId = uuid.parse(rawResourceId);
      const metadata = privateFileResourceAppendVersionUploadMetadataSchema.parse(rawMetadata);
      const key = idempotencyKey.parse(rawKey);
      return database.tenant(tenantId, (tx) => reserve(tx, 'append', resourceId, metadata, key));
    },
    prepareObject(athleteId, rawUploadId, rawPrepared) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      const prepared = z
        .strictObject({ storageRef: finalStorageRef, file: privateFileResourceDescriptorSchema })
        .parse(rawPrepared);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        await tx.query('SELECT public.expire_resource_uploads(statement_timestamp())');
        const found = await tx.query(
          `SELECT * FROM resource_upload_intent WHERE athlete_id=$1 AND upload_id=$2 FOR UPDATE`,
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new ResourceNotFoundError();
        const prior = intentRowSchema.parse(found.rows[0]);
        const keyMatch = finalStorageRef
          .safeParse(prepared.storageRef)
          .data?.match(
            /^private\/v1\/tenants\/([0-9a-f-]{36})\/resources\/([0-9a-f-]{36})\/objects\/uploads\/([0-9a-f-]{36})\/sha256\/([a-f0-9]{64})\.(pdf|md)$/,
          );
        const expectedExtension = prepared.file.mediaType === 'application/pdf' ? 'pdf' : 'md';
        if (
          keyMatch?.[1] !== tenantId ||
          keyMatch[2] !== prior.resource_id ||
          keyMatch[3] !== uploadId ||
          keyMatch[4] !== prepared.file.sha256 ||
          keyMatch[5] !== expectedExtension
        )
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        if (prior.state === 'failed') throw new ResourceFileUploadStateError('UPLOAD_FAILED');
        if (prior.state !== 'reserved') {
          const stored = await tx.query(
            `SELECT storage_ref,original_filename,media_type,size_bytes,content_hash
             FROM resource_upload_intent WHERE athlete_id=$1 AND upload_id=$2`,
            [tenantId, uploadId],
          );
          const row = stored.rows[0];
          if (
            row?.['storage_ref'] !== prepared.storageRef ||
            row['original_filename'] !== prepared.file.originalFileName ||
            row['media_type'] !== prepared.file.mediaType ||
            Number(row['size_bytes']) !== prepared.file.byteSize ||
            row['content_hash'] !== prepared.file.sha256
          )
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return reservation(prior);
        }
        const at = instant((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']);
        const changed = await tx.query(
          `UPDATE resource_upload_intent SET storage_ref=$3,original_filename=$4,media_type=$5,
           size_bytes=$6,content_hash=$7,state='prepared',prepared_at=$8,updated_at=$8
           WHERE athlete_id=$1 AND upload_id=$2 RETURNING *`,
          [
            tenantId,
            uploadId,
            prepared.storageRef,
            prepared.file.originalFileName,
            prepared.file.mediaType,
            prepared.file.byteSize,
            prepared.file.sha256,
            at,
          ],
        );
        await tx.query('SELECT public.protect_resource_upload_object($1)', [uploadId]);
        const quota = await tx.query(
          `SELECT coalesce(sum(size_bytes),0)::bigint AS pending_bytes FROM resource_upload_intent
           WHERE athlete_id=$1 AND state IN ('prepared','staged')`,
          [tenantId],
        );
        if (z.coerce.number().parse(quota.rows[0]?.['pending_bytes']) > 50 * 1024 * 1024)
          throw new ResourceFileUploadStateError('UPLOAD_QUOTA_EXCEEDED');
        return reservation(intentRowSchema.parse(changed.rows[0]));
      });
    },
    markStaged(athleteId, rawUploadId) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        await tx.query('SELECT public.expire_resource_uploads(statement_timestamp())');
        const found = await tx.query(
          `SELECT * FROM resource_upload_intent WHERE athlete_id=$1 AND upload_id=$2 FOR UPDATE`,
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new ResourceNotFoundError();
        const prior = intentRowSchema.parse(found.rows[0]);
        if (prior.state === 'failed') throw new ResourceFileUploadStateError('UPLOAD_FAILED');
        if (prior.state === 'reserved')
          throw new ResourceFileUploadStateError('UPLOAD_NOT_PREPARED');
        if (prior.state !== 'prepared') return reservation(prior);
        await tx.query('SELECT public.protect_resource_upload_object($1)', [uploadId]);
        const at = instant((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']);
        const changed = await tx.query(
          `UPDATE resource_upload_intent SET state='staged',staged_at=$3,updated_at=$3
           WHERE athlete_id=$1 AND upload_id=$2 RETURNING *`,
          [tenantId, uploadId, at],
        );
        return reservation(intentRowSchema.parse(changed.rows[0]));
      });
    },
    finalize(athleteId, rawUploadId) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const found = await tx.query(
          `SELECT * FROM resource_upload_intent WHERE athlete_id=$1 AND upload_id=$2 FOR UPDATE`,
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new ResourceNotFoundError();
        const intent = intentRowSchema
          .extend({
            title: z.string().nullable(),
            category: z.string().nullable(),
            metadata: z.record(z.string(), z.unknown()),
            tags: z.array(z.string()),
            favorite: z.boolean(),
            original_filename: z.string().nullable(),
            media_type: z.enum(['application/pdf', 'text/markdown']).nullable(),
            size_bytes: z.coerce.number().int().nullable(),
            content_hash: z.string().nullable(),
          })
          .parse(found.rows[0]);
        if (intent.state === 'failed') throw new ResourceFileUploadStateError('UPLOAD_FAILED');
        if (intent.state === 'reserved' || intent.state === 'prepared')
          throw new ResourceFileUploadStateError('UPLOAD_NOT_STAGED');
        if (intent.state === 'finalized') {
          return privateFileResourceReadResultSchema.parse(
            await readPrivateResourceStored(tx, intent.resource_id, intent.version_id),
          );
        }
        if (
          intent.storage_ref === null ||
          intent.original_filename === null ||
          intent.media_type === null ||
          intent.size_bytes === null ||
          intent.content_hash === null
        )
          throw new Error('INVALID_STAGED_UPLOAD');
        await tx.query('SELECT public.protect_resource_upload_object($1)', [uploadId]);
        const at = instant((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']);
        let nextVersion = 1;
        if (intent.operation === 'create') {
          await tx.query(
            `INSERT INTO resource
             (athlete_id,id,source_kind,title,category,metadata,tags,favorite,include_for_coach,
              reviewed_state,access_revision,current_version,current_version_id,created_at,updated_at)
             VALUES($1,$2,'file',$3,$4,$5::jsonb,$6::jsonb,$7,false,'unreviewed',1,1,$8,$9,$9)`,
            [
              tenantId,
              intent.resource_id,
              intent.title,
              intent.category,
              JSON.stringify(intent.metadata),
              JSON.stringify(intent.tags),
              intent.favorite,
              intent.version_id,
              at,
            ],
          );
        } else {
          const head = await tx.query(
            `SELECT current_version,current_version_id,source_kind FROM resource
             WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
            [tenantId, intent.resource_id],
          );
          if (!head.rows[0] || head.rows[0]['source_kind'] !== 'file')
            throw new ResourceNotFoundError();
          if (head.rows[0]['current_version_id'] !== intent.expected_current_version_id)
            throw new PersistenceConflict('REVISION_CONFLICT');
          nextVersion = z.number().int().parse(head.rows[0]['current_version']) + 1;
        }
        await tx.query(
          `INSERT INTO resource_object(athlete_id,storage_ref,content_hash,size_bytes,media_type,created_at)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(athlete_id,storage_ref) DO NOTHING`,
          [
            tenantId,
            intent.storage_ref,
            intent.content_hash,
            intent.size_bytes,
            intent.media_type,
            at,
          ],
        );
        const storedObject = await tx.query(
          `SELECT content_hash,size_bytes,media_type FROM resource_object
           WHERE athlete_id=$1 AND storage_ref=$2`,
          [tenantId, intent.storage_ref],
        );
        if (
          storedObject.rows[0]?.['content_hash'] !== intent.content_hash ||
          Number(storedObject.rows[0]?.['size_bytes']) !== intent.size_bytes ||
          storedObject.rows[0]?.['media_type'] !== intent.media_type
        )
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        await tx.query(
          `INSERT INTO resource_version
           (athlete_id,resource_id,version_id,version,previous_version,previous_version_id,
            content,content_hash,paragraphs,content_status,index_status,storage_ref,original_filename,
            media_type,size_bytes,created_at)
           VALUES($1,$2,$3,$4,$5,$6,NULL,$7,'[]'::jsonb,'raw_stored','not_indexed',$8,$9,$10,$11,$12)`,
          [
            tenantId,
            intent.resource_id,
            intent.version_id,
            nextVersion,
            nextVersion === 1 ? null : nextVersion - 1,
            intent.expected_current_version_id,
            intent.content_hash,
            intent.storage_ref,
            intent.original_filename,
            intent.media_type,
            intent.size_bytes,
            at,
          ],
        );
        if (intent.operation === 'append') {
          await tx.query(
            `UPDATE resource SET current_version=$3,current_version_id=$4,
             access_revision=access_revision+1,updated_at=$5 WHERE athlete_id=$1 AND id=$2`,
            [tenantId, intent.resource_id, nextVersion, intent.version_id, at],
          );
        }
        await assertPrivateResourceQuota(tx);
        const result = privateFileResourceReadResultSchema.parse(
          await readPrivateResourceStored(tx, intent.resource_id, intent.version_id),
        );
        if (result.status !== 'available') throw new ResourceNotFoundError();
        const key = `resource:file:${intent.operation}:${intent.idempotency_key}`;
        await finishResourceCommand(
          tx,
          key,
          { kind: `resource_file_${intent.operation}`, uploadId },
          {
            status: 'available',
            resourceId: intent.resource_id,
            versionId: intent.version_id,
            resource: result.resource,
          },
          { resourceId: intent.resource_id, versionId: intent.version_id },
          intent.operation === 'create' ? 'resource.created' : 'resource.version_appended',
        );
        await tx.query(
          `UPDATE resource_upload_intent SET state='finalized',finalized_at=$3,updated_at=$3
           WHERE athlete_id=$1 AND upload_id=$2`,
          [tenantId, uploadId, at],
        );
        return result;
      });
    },
    fail(athleteId, rawUploadId, rawCode) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      const code = failureCode.parse(rawCode);
      return database.tenant(tenantId, async (tx) => {
        const result = await tx.query('SELECT public.fail_resource_upload($1,$2) AS failed', [
          uploadId,
          code,
        ]);
        if (result.rows[0]?.['failed'] !== true) throw new ResourceNotFoundError();
        return { failed: true };
      });
    },
    resolveObject(athleteId, rawResourceId, rawVersionId) {
      const tenantId = uuid.parse(athleteId);
      const resourceId = uuid.parse(rawResourceId);
      const versionId = rawVersionId === undefined ? undefined : uuid.parse(rawVersionId);
      return database.tenant(tenantId, async (tx) => {
        const found = await tx.query(
          `SELECT v.storage_ref,v.original_filename,v.media_type,v.size_bytes,v.content_hash
           FROM resource r JOIN resource_version v
             ON v.athlete_id=r.athlete_id AND v.resource_id=r.id
           WHERE r.athlete_id=$1 AND r.id=$2 AND r.deleted_at IS NULL AND r.source_kind='file'
             AND v.version_id=coalesce($3::uuid,r.current_version_id)`,
          [tenantId, resourceId, versionId ?? null],
        );
        if (!found.rows[0]) return null;
        const row = z
          .object({
            storage_ref: finalStorageRef,
            original_filename: z.string(),
            media_type: z.enum(['application/pdf', 'text/markdown']),
            size_bytes: z.coerce.number().int(),
            content_hash: z.string(),
          })
          .parse(found.rows[0]);
        const extension =
          row.media_type === 'application/pdf'
            ? 'pdf'
            : row.original_filename.toLocaleLowerCase('en-US').endsWith('.markdown')
              ? 'markdown'
              : 'md';
        return {
          storageRef: row.storage_ref,
          file: privateFileResourceDescriptorSchema.parse({
            originalFileName: row.original_filename,
            extension,
            mediaType: row.media_type,
            byteSize: row.size_bytes,
            sha256: row.content_hash,
          }),
        };
      });
    },
  };
}
