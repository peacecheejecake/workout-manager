import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  galleryMediaCreateUploadMetadataSchema,
  galleryMediaDeleteResultSchema,
  galleryMediaDescriptorSchema,
  galleryMediaExtension,
  galleryMediaItemSchema,
  galleryMediaKindOf,
  galleryMediaListQuerySchema,
  galleryMediaListSchema,
  galleryMediaPreviewUploadMetadataSchema,
  galleryMediaReadResultSchema,
  galleryMediaSoftDeleteSchema,
  galleryMediaTypeSchema,
  galleryMediaUpdateSchema,
  galleryPreviewDescriptorSchema,
  galleryUploadReservationSchema,
} from '@workout/contracts/gallery';

import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const failureCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_:-]+$/);

const UUID_SEGMENT = '[0-9a-f-]{36}';
const FINAL_REF_PATTERN = new RegExp(
  `^private/v1/tenants/(${UUID_SEGMENT})/gallery/(${UUID_SEGMENT})/objects/uploads/(${UUID_SEGMENT})/sha256/([a-f0-9]{64})[.](jpg|png|webp|mp4|webm)$`,
);
const finalStorageRef = z.string().max(512).regex(FINAL_REF_PATTERN);

const MAX_ACTIVE_UPLOADS = 20;
const MAX_UPLOAD_HISTORY = 100;
const MAX_PENDING_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_LIVE_MEDIA_ITEMS = 1000;
const UPLOAD_EXPIRY_MINUTES = 30;

type CreateMetadata = z.infer<typeof galleryMediaCreateUploadMetadataSchema>;
type PreviewMetadata = z.infer<typeof galleryMediaPreviewUploadMetadataSchema>;
type MediaDescriptor = z.infer<typeof galleryMediaDescriptorSchema>;
type Reservation = z.infer<typeof galleryUploadReservationSchema>;
type ReadResult = z.infer<typeof galleryMediaReadResultSchema>;
type MediaList = z.infer<typeof galleryMediaListSchema>;
type ListQuery = z.infer<typeof galleryMediaListQuerySchema>;
type UpdateInput = z.infer<typeof galleryMediaUpdateSchema>;
type DeleteInput = z.infer<typeof galleryMediaSoftDeleteSchema>;
type DeleteResult = z.infer<typeof galleryMediaDeleteResultSchema>;

export class GalleryMediaNotFoundError extends Error {
  readonly code = 'MEDIA_NOT_FOUND';

  constructor() {
    super('MEDIA_NOT_FOUND');
    this.name = 'GalleryMediaNotFoundError';
  }
}

export class GalleryUploadStateError extends Error {
  constructor(
    readonly code:
      | 'UPLOAD_FAILED'
      | 'UPLOAD_NOT_PREPARED'
      | 'UPLOAD_NOT_STAGED'
      | 'UPLOAD_QUOTA_EXCEEDED'
      | 'UPLOAD_HISTORY_QUOTA_EXCEEDED'
      | 'MEDIA_QUOTA_EXCEEDED',
  ) {
    super(code);
    this.name = 'GalleryUploadStateError';
  }
}

export interface GalleryMediaObjectRef {
  storageRef: string;
  mediaItemId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  originalFileName: string;
}

export interface GalleryMediaRepository {
  list(athleteId: string, query: ListQuery): Promise<MediaList>;
  read(athleteId: string, mediaItemId: string): Promise<ReadResult>;
  getUpload(athleteId: string, uploadId: string): Promise<Reservation>;
  reserveCreate(
    athleteId: string,
    metadata: CreateMetadata,
    requestIdempotencyKey: string,
  ): Promise<Reservation>;
  reservePreview(
    athleteId: string,
    mediaItemId: string,
    metadata: PreviewMetadata,
    requestIdempotencyKey: string,
  ): Promise<Reservation>;
  prepareObject(
    athleteId: string,
    uploadId: string,
    prepared: { storageRef: string; file: MediaDescriptor },
  ): Promise<Reservation>;
  markStaged(athleteId: string, uploadId: string): Promise<Reservation>;
  finalize(athleteId: string, uploadId: string): Promise<ReadResult>;
  fail(athleteId: string, uploadId: string, code: string): Promise<{ failed: true }>;
  update(athleteId: string, mediaItemId: string, input: UpdateInput): Promise<ReadResult>;
  softDelete(athleteId: string, mediaItemId: string, input: DeleteInput): Promise<DeleteResult>;
  resolveObject(
    athleteId: string,
    mediaItemId: string,
    variant: 'original' | 'preview',
  ): Promise<GalleryMediaObjectRef | null>;
}

const instant = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

const localDate = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return z.string().parse(value).slice(0, 10);
};

const intentRowSchema = z.object({
  upload_id: uuid,
  media_item_id: uuid,
  operation: z.enum(['create_item', 'attach_preview']),
  idempotency_key: z.string(),
  request_digest: z.string(),
  temporary_ref: z.string().min(1).max(512),
  storage_ref: z.string().nullable(),
  media_kind: z.enum(['image', 'video']).nullable(),
  expected_access_revision: z.number().int().nullable(),
  album: z.string().nullable(),
  caption: z.string().nullable(),
  activity_id: uuid.nullable(),
  captured_at: z.union([z.date(), z.string()]).nullable(),
  captured_local_date: z.union([z.date(), z.string()]).nullable(),
  original_filename: z.string().nullable(),
  media_type: z.string().nullable(),
  size_bytes: z.coerce.number().int().nullable(),
  content_hash: z.string().nullable(),
  state: z.enum(['reserved', 'prepared', 'staged', 'finalized', 'failed']),
  failure_code: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
  expires_at: z.union([z.date(), z.string()]),
});

const itemRowSchema = z.object({
  id: uuid,
  media_kind: z.enum(['image', 'video']),
  visibility: z.literal('private'),
  include_for_coach: z.literal(false),
  album: z.string().nullable(),
  caption: z.string().nullable(),
  activity_id: uuid.nullable(),
  captured_at: z.union([z.date(), z.string()]).nullable(),
  captured_local_date: z.union([z.date(), z.string()]).nullable(),
  original_filename: z.string(),
  media_type: galleryMediaTypeSchema,
  size_bytes: z.coerce.number().int(),
  content_hash: z.string(),
  access_revision: z.number().int(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
  preview_media_type: z.string().nullable(),
  preview_size_bytes: z.coerce.number().int().nullable(),
  preview_content_hash: z.string().nullable(),
});

const ITEM_COLUMNS = `m.id,m.media_kind,m.visibility,m.include_for_coach,m.album,m.caption,
  m.activity_id,m.captured_at,m.captured_local_date,m.original_filename,m.media_type,m.size_bytes,
  m.content_hash,m.access_revision,m.created_at,m.updated_at,
  d.media_type AS preview_media_type,d.size_bytes AS preview_size_bytes,
  d.content_hash AS preview_content_hash`;
const ITEM_FROM = `gallery_media_item m
  LEFT JOIN gallery_media_derivative d
    ON d.athlete_id=m.athlete_id AND d.media_item_id=m.id AND d.kind='preview'`;

function toItem(row: unknown) {
  const parsed = itemRowSchema.parse(row);
  return galleryMediaItemSchema.parse({
    id: parsed.id,
    mediaKind: parsed.media_kind,
    visibility: parsed.visibility,
    includeForCoach: parsed.include_for_coach,
    album: parsed.album,
    caption: parsed.caption,
    activityId: parsed.activity_id,
    capturedAt: parsed.captured_at === null ? null : instant(parsed.captured_at),
    capturedLocalDate: localDate(parsed.captured_local_date),
    file: {
      originalFileName: parsed.original_filename,
      mediaType: parsed.media_type,
      byteSize: parsed.size_bytes,
      sha256: parsed.content_hash,
    },
    preview:
      parsed.preview_media_type === null ||
      parsed.preview_size_bytes === null ||
      parsed.preview_content_hash === null
        ? null
        : {
            kind: 'preview',
            mediaType: parsed.preview_media_type,
            byteSize: parsed.preview_size_bytes,
            sha256: parsed.preview_content_hash,
          },
    accessRevision: parsed.access_revision,
    createdAt: instant(parsed.created_at),
    updatedAt: instant(parsed.updated_at),
  });
}

function reservation(row: z.infer<typeof intentRowSchema>): Reservation {
  return galleryUploadReservationSchema.parse({
    uploadId: row.upload_id,
    mediaItemId: row.media_item_id,
    operation: row.operation,
    state: row.state,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  });
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function tenantLock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
}

async function databaseNow(tx: Transaction) {
  return instant((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']);
}

async function expireUploads(tx: Transaction) {
  await tx.query('SELECT public.expire_gallery_uploads(statement_timestamp())');
}

async function replay(tx: Transaction, key: string, request: unknown) {
  const requestDigest = digest(request);
  const row = (
    await tx.query(
      'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
      [tx.athleteId, key, JSON.stringify({ sha256: requestDigest })],
    )
  ).rows[0];
  if (!row) return null;
  if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return row['result'];
}

async function finishCommand(
  tx: Transaction,
  key: string,
  request: unknown,
  receipt: unknown,
  event: { mediaItemId: string },
  topic: string,
) {
  await enqueue(tx, { id: randomUUID(), idempotencyKey: key, topic, payload: event });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [
      tx.athleteId,
      key,
      JSON.stringify({ sha256: digest(request) }),
      JSON.stringify(receipt ?? null),
    ],
  );
}

async function assertUploadQuota(tx: Transaction) {
  await tx.query('SELECT public.compact_gallery_upload_history(100)');
  const quota = await tx.query(
    `SELECT
       count(*) FILTER (WHERE state IN ('reserved','prepared','staged'))::integer AS pending_count,
       count(*) FILTER (WHERE state='failed')::integer AS failed_count,
       coalesce(sum(size_bytes) FILTER (WHERE state IN ('prepared','staged')),0)::bigint AS pending_bytes
     FROM gallery_upload_intent WHERE athlete_id=$1`,
    [tx.athleteId],
  );
  const pendingCount = z.number().int().parse(quota.rows[0]?.['pending_count']);
  const failedCount = z.number().int().parse(quota.rows[0]?.['failed_count']);
  const pendingBytes = z.coerce.number().int().parse(quota.rows[0]?.['pending_bytes']);
  if (pendingCount >= MAX_ACTIVE_UPLOADS || pendingBytes > MAX_PENDING_UPLOAD_BYTES)
    throw new GalleryUploadStateError('UPLOAD_QUOTA_EXCEEDED');
  if (failedCount + pendingCount >= MAX_UPLOAD_HISTORY)
    throw new GalleryUploadStateError('UPLOAD_HISTORY_QUOTA_EXCEEDED');
}

async function assertMediaQuota(tx: Transaction) {
  const total = await tx.query(
    `SELECT count(*)::integer AS live FROM gallery_media_item
     WHERE athlete_id=$1 AND deleted_at IS NULL`,
    [tx.athleteId],
  );
  if (z.number().int().parse(total.rows[0]?.['live']) > MAX_LIVE_MEDIA_ITEMS)
    throw new GalleryUploadStateError('MEDIA_QUOTA_EXCEEDED');
}

async function readItem(tx: Transaction, mediaItemId: string): Promise<ReadResult> {
  const found = await tx.query(
    `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
     WHERE m.athlete_id=$1 AND m.id=$2 AND m.deleted_at IS NULL`,
    [tx.athleteId, mediaItemId],
  );
  if (!found.rows[0])
    return galleryMediaReadResultSchema.parse({ status: 'unavailable', mediaItemId });
  return galleryMediaReadResultSchema.parse({ status: 'available', item: toItem(found.rows[0]) });
}

function assertPreparedRefMatches(input: {
  storageRef: string;
  tenantId: string;
  mediaItemId: string;
  uploadId: string;
  sha256: string;
  mediaType: string;
}) {
  const match = FINAL_REF_PATTERN.exec(input.storageRef);
  const expectedExtension = galleryMediaExtension(galleryMediaTypeSchema.parse(input.mediaType));
  if (
    match?.[1] !== input.tenantId ||
    match[2] !== input.mediaItemId ||
    match[3] !== input.uploadId ||
    match[4] !== input.sha256 ||
    match[5] !== expectedExtension
  )
    throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
}

export function createGalleryMediaRepository(database: Database): GalleryMediaRepository {
  async function reserve(
    tx: Transaction,
    operation: 'create_item' | 'attach_preview',
    mediaItemId: string,
    metadata: CreateMetadata | PreviewMetadata,
    key: string,
  ): Promise<Reservation> {
    await tenantLock(tx);
    await expireUploads(tx);
    const request = {
      operation,
      mediaItemId: operation === 'attach_preview' ? mediaItemId : null,
      metadata,
    };
    const requestDigest = digest(request);
    const prior = await tx.query(
      'SELECT * FROM gallery_upload_intent WHERE athlete_id=$1 AND idempotency_key=$2',
      [tx.athleteId, key],
    );
    if (prior.rows[0]) {
      const parsed = intentRowSchema.parse(prior.rows[0]);
      if (parsed.request_digest !== requestDigest)
        throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
      return reservation(parsed);
    }
    await assertUploadQuota(tx);
    if (operation === 'create_item') await assertMediaQuota(tx);

    const create =
      operation === 'create_item'
        ? galleryMediaCreateUploadMetadataSchema.parse(metadata)
        : undefined;
    let expectedAccessRevision: number | null = null;
    if (operation === 'attach_preview') {
      const preview = galleryMediaPreviewUploadMetadataSchema.parse(metadata);
      const head = await tx.query(
        `SELECT access_revision FROM gallery_media_item
         WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL`,
        [tx.athleteId, mediaItemId],
      );
      if (!head.rows[0]) throw new GalleryMediaNotFoundError();
      if (head.rows[0]['access_revision'] !== preview.expectedAccessRevision)
        throw new PersistenceConflict('REVISION_CONFLICT');
      expectedAccessRevision = preview.expectedAccessRevision;
    } else if (create?.activityId) {
      const activity = await tx.query(
        'SELECT 1 FROM activity_canonical WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
        [tx.athleteId, create.activityId],
      );
      if (!activity.rows[0]) throw new GalleryMediaNotFoundError();
    }
    const uploadId = randomUUID();
    const at = await databaseNow(tx);
    const expiresAt = new Date(
      new Date(at).getTime() + UPLOAD_EXPIRY_MINUTES * 60_000,
    ).toISOString();
    const temporaryRef = `private/v1/tenants/${tx.athleteId}/gallery/${mediaItemId}/temporary/${uploadId}`;
    const inserted = await tx.query(
      `INSERT INTO gallery_upload_intent
       (athlete_id,upload_id,idempotency_key,request_digest,operation,media_item_id,temporary_ref,
        media_kind,expected_access_revision,album,caption,activity_id,captured_at,
        captured_local_date,state,created_at,updated_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'reserved',$15,$15,$16)
       RETURNING *`,
      [
        tx.athleteId,
        uploadId,
        key,
        requestDigest,
        operation,
        mediaItemId,
        temporaryRef,
        create?.mediaKind ?? null,
        expectedAccessRevision,
        create?.album ?? null,
        create?.caption ?? null,
        create?.activityId ?? null,
        create?.capturedAt ?? null,
        create?.capturedLocalDate ?? null,
        at,
        expiresAt,
      ],
    );
    return reservation(intentRowSchema.parse(inserted.rows[0]));
  }

  return {
    list(athleteId, rawQuery) {
      const tenantId = uuid.parse(athleteId);
      const query = galleryMediaListQuerySchema.parse(rawQuery);
      return database.tenant(tenantId, async (tx) => {
        const filters = [
          'm.athlete_id=$1',
          'm.deleted_at IS NULL',
          '($2::text IS NULL OR m.album=$2)',
          '($3::text IS NULL OR m.media_kind=$3)',
          '($4::uuid IS NULL OR m.activity_id=$4)',
        ].join(' AND ');
        const parameters = [
          tenantId,
          query.album ?? null,
          query.mediaKind ?? null,
          query.activityId ?? null,
        ];
        const rows = await tx.query(
          `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${filters}
           ORDER BY m.created_at DESC,m.id LIMIT $5 OFFSET $6`,
          [...parameters, query.limit, query.offset],
        );
        const total = await tx.query(
          `SELECT count(*)::integer AS total FROM gallery_media_item m WHERE ${filters}`,
          parameters,
        );
        return galleryMediaListSchema.parse({
          items: rows.rows.map(toItem),
          total: z.number().int().parse(total.rows[0]?.['total']),
        });
      });
    },

    read(athleteId, rawMediaItemId) {
      const tenantId = uuid.parse(athleteId);
      const mediaItemId = uuid.parse(rawMediaItemId);
      return database.tenant(tenantId, (tx) => readItem(tx, mediaItemId));
    },

    getUpload(athleteId, rawUploadId) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      return database.tenant(tenantId, async (tx) => {
        await expireUploads(tx);
        const found = await tx.query(
          'SELECT * FROM gallery_upload_intent WHERE athlete_id=$1 AND upload_id=$2',
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new GalleryMediaNotFoundError();
        return reservation(intentRowSchema.parse(found.rows[0]));
      });
    },

    reserveCreate(athleteId, rawMetadata, rawKey) {
      const tenantId = uuid.parse(athleteId);
      const metadata = galleryMediaCreateUploadMetadataSchema.parse(rawMetadata);
      const key = idempotencyKey.parse(rawKey);
      return database.tenant(tenantId, (tx) =>
        reserve(tx, 'create_item', randomUUID(), metadata, key),
      );
    },

    reservePreview(athleteId, rawMediaItemId, rawMetadata, rawKey) {
      const tenantId = uuid.parse(athleteId);
      const mediaItemId = uuid.parse(rawMediaItemId);
      const metadata = galleryMediaPreviewUploadMetadataSchema.parse(rawMetadata);
      const key = idempotencyKey.parse(rawKey);
      return database.tenant(tenantId, (tx) =>
        reserve(tx, 'attach_preview', mediaItemId, metadata, key),
      );
    },

    prepareObject(athleteId, rawUploadId, rawPrepared) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      const prepared = z
        .strictObject({ storageRef: finalStorageRef, file: galleryMediaDescriptorSchema })
        .parse(rawPrepared);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        await expireUploads(tx);
        const found = await tx.query(
          'SELECT * FROM gallery_upload_intent WHERE athlete_id=$1 AND upload_id=$2 FOR UPDATE',
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new GalleryMediaNotFoundError();
        const prior = intentRowSchema.parse(found.rows[0]);
        assertPreparedRefMatches({
          storageRef: prepared.storageRef,
          tenantId,
          mediaItemId: prior.media_item_id,
          uploadId,
          sha256: prepared.file.sha256,
          mediaType: prepared.file.mediaType,
        });
        if (prior.operation === 'attach_preview') {
          galleryPreviewDescriptorSchema.parse({
            kind: 'preview',
            mediaType: prepared.file.mediaType,
            byteSize: prepared.file.byteSize,
            sha256: prepared.file.sha256,
          });
        } else if (galleryMediaKindOf(prepared.file.mediaType) !== prior.media_kind) {
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        }
        if (prior.state === 'failed') throw new GalleryUploadStateError('UPLOAD_FAILED');
        if (prior.state !== 'reserved') {
          if (
            prior.storage_ref !== prepared.storageRef ||
            prior.original_filename !== prepared.file.originalFileName ||
            prior.media_type !== prepared.file.mediaType ||
            prior.size_bytes !== prepared.file.byteSize ||
            prior.content_hash !== prepared.file.sha256
          )
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return reservation(prior);
        }
        const at = await databaseNow(tx);
        const changed = await tx.query(
          `UPDATE gallery_upload_intent SET storage_ref=$3,original_filename=$4,media_type=$5,
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
        await tx.query('SELECT public.protect_gallery_upload_object($1)', [uploadId]);
        const quota = await tx.query(
          `SELECT coalesce(sum(size_bytes),0)::bigint AS pending_bytes FROM gallery_upload_intent
           WHERE athlete_id=$1 AND state IN ('prepared','staged')`,
          [tenantId],
        );
        if (z.coerce.number().parse(quota.rows[0]?.['pending_bytes']) > MAX_PENDING_UPLOAD_BYTES)
          throw new GalleryUploadStateError('UPLOAD_QUOTA_EXCEEDED');
        return reservation(intentRowSchema.parse(changed.rows[0]));
      });
    },

    markStaged(athleteId, rawUploadId) {
      const tenantId = uuid.parse(athleteId);
      const uploadId = uuid.parse(rawUploadId);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        await expireUploads(tx);
        const found = await tx.query(
          'SELECT * FROM gallery_upload_intent WHERE athlete_id=$1 AND upload_id=$2 FOR UPDATE',
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new GalleryMediaNotFoundError();
        const prior = intentRowSchema.parse(found.rows[0]);
        if (prior.state === 'failed') throw new GalleryUploadStateError('UPLOAD_FAILED');
        if (prior.state === 'reserved') throw new GalleryUploadStateError('UPLOAD_NOT_PREPARED');
        if (prior.state !== 'prepared') return reservation(prior);
        await tx.query('SELECT public.protect_gallery_upload_object($1)', [uploadId]);
        const at = await databaseNow(tx);
        const changed = await tx.query(
          `UPDATE gallery_upload_intent SET state='staged',staged_at=$3,updated_at=$3
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
          'SELECT * FROM gallery_upload_intent WHERE athlete_id=$1 AND upload_id=$2 FOR UPDATE',
          [tenantId, uploadId],
        );
        if (!found.rows[0]) throw new GalleryMediaNotFoundError();
        const intent = intentRowSchema.parse(found.rows[0]);
        if (intent.state === 'failed') throw new GalleryUploadStateError('UPLOAD_FAILED');
        if (intent.state === 'reserved' || intent.state === 'prepared')
          throw new GalleryUploadStateError('UPLOAD_NOT_STAGED');
        if (intent.state === 'finalized') return readItem(tx, intent.media_item_id);
        if (
          intent.storage_ref === null ||
          intent.original_filename === null ||
          intent.media_type === null ||
          intent.size_bytes === null ||
          intent.content_hash === null
        )
          throw new Error('INVALID_STAGED_GALLERY_UPLOAD');
        const mediaType = galleryMediaTypeSchema.parse(intent.media_type);
        await tx.query('SELECT public.protect_gallery_upload_object($1)', [uploadId]);
        const at = await databaseNow(tx);
        await tx.query(
          `INSERT INTO gallery_media_object(athlete_id,storage_ref,content_hash,size_bytes,media_type,created_at)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(athlete_id,storage_ref) DO NOTHING`,
          [tenantId, intent.storage_ref, intent.content_hash, intent.size_bytes, mediaType, at],
        );
        const storedObject = await tx.query(
          `SELECT content_hash,size_bytes,media_type FROM gallery_media_object
           WHERE athlete_id=$1 AND storage_ref=$2`,
          [tenantId, intent.storage_ref],
        );
        if (
          storedObject.rows[0]?.['content_hash'] !== intent.content_hash ||
          Number(storedObject.rows[0]?.['size_bytes']) !== intent.size_bytes ||
          storedObject.rows[0]?.['media_type'] !== mediaType
        )
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');

        if (intent.operation === 'create_item') {
          await tx.query(
            `INSERT INTO gallery_media_item
             (athlete_id,id,media_kind,visibility,include_for_coach,album,caption,activity_id,
              captured_at,captured_local_date,storage_ref,original_filename,media_type,size_bytes,
              content_hash,access_revision,created_at,updated_at)
             VALUES($1,$2,$3,'private',false,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$14)`,
            [
              tenantId,
              intent.media_item_id,
              intent.media_kind,
              intent.album,
              intent.caption,
              intent.activity_id,
              intent.captured_at,
              intent.captured_local_date,
              intent.storage_ref,
              intent.original_filename,
              mediaType,
              intent.size_bytes,
              intent.content_hash,
              at,
            ],
          );
          await assertMediaQuota(tx);
        } else {
          // The revision observed at reservation is re-checked here, inside the
          // finalize transaction, so a metadata write that landed in between
          // cannot be silently overwritten by a stale preview.
          const head = await tx.query(
            `SELECT access_revision FROM gallery_media_item
             WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
            [tenantId, intent.media_item_id],
          );
          if (!head.rows[0]) throw new GalleryMediaNotFoundError();
          const currentRevision = z.number().int().parse(head.rows[0]['access_revision']);
          if (
            intent.expected_access_revision === null ||
            currentRevision !== intent.expected_access_revision
          )
            throw new PersistenceConflict('REVISION_CONFLICT');
          const inserted = await tx.query(
            `INSERT INTO gallery_media_derivative
             (athlete_id,media_item_id,kind,storage_ref,media_type,size_bytes,content_hash,created_at)
             VALUES($1,$2,'preview',$3,$4,$5,$6,$7)
             ON CONFLICT(athlete_id,media_item_id,kind) DO NOTHING RETURNING storage_ref`,
            [
              tenantId,
              intent.media_item_id,
              intent.storage_ref,
              mediaType,
              intent.size_bytes,
              intent.content_hash,
              at,
            ],
          );
          if (!inserted.rows[0]) throw new PersistenceConflict('REVISION_CONFLICT');
          // Adding a derivative changes what a reader observes, so the item
          // revision advances with it.
          await tx.query(
            `UPDATE gallery_media_item SET access_revision=access_revision+1,updated_at=$3
             WHERE athlete_id=$1 AND id=$2`,
            [tenantId, intent.media_item_id, at],
          );
        }
        const result = await readItem(tx, intent.media_item_id);
        if (result.status !== 'available') throw new GalleryMediaNotFoundError();
        await finishCommand(
          tx,
          `gallery:${intent.operation}:${intent.idempotency_key}`,
          { kind: `gallery_${intent.operation}`, uploadId },
          { status: 'available', mediaItemId: intent.media_item_id },
          { mediaItemId: intent.media_item_id },
          intent.operation === 'create_item' ? 'gallery.media_created' : 'gallery.preview_attached',
        );
        await tx.query(
          `UPDATE gallery_upload_intent SET state='finalized',finalized_at=$3,updated_at=$3
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
        const result = await tx.query('SELECT public.fail_gallery_upload($1,$2) AS failed', [
          uploadId,
          code,
        ]);
        if (result.rows[0]?.['failed'] !== true) throw new GalleryMediaNotFoundError();
        return { failed: true };
      });
    },

    update(athleteId, rawMediaItemId, rawInput) {
      const tenantId = uuid.parse(athleteId);
      const mediaItemId = uuid.parse(rawMediaItemId);
      const input = galleryMediaUpdateSchema.parse(rawInput);
      const key = `gallery:update:${input.idempotencyKey}`;
      const request = { kind: 'gallery_update', mediaItemId, ...input };
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const prior = await replay(tx, key, request);
        if (prior !== null) return readItem(tx, mediaItemId);
        const head = (
          await tx.query(
            `SELECT access_revision,deleted_at FROM gallery_media_item
             WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
            [tenantId, mediaItemId],
          )
        ).rows[0];
        if (!head) throw new GalleryMediaNotFoundError();
        if (head['access_revision'] !== input.expectedAccessRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (input.activityId !== null) {
          const activity = await tx.query(
            'SELECT 1 FROM activity_canonical WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
            [tenantId, input.activityId],
          );
          if (!activity.rows[0]) throw new GalleryMediaNotFoundError();
        }
        const at = await databaseNow(tx);
        await tx.query(
          `UPDATE gallery_media_item SET album=$3,caption=$4,activity_id=$5,
           access_revision=access_revision+1,updated_at=$6
           WHERE athlete_id=$1 AND id=$2`,
          [tenantId, mediaItemId, input.album, input.caption, input.activityId, at],
        );
        const result = await readItem(tx, mediaItemId);
        if (result.status !== 'available') throw new GalleryMediaNotFoundError();
        await finishCommand(
          tx,
          key,
          request,
          { status: 'available', mediaItemId },
          { mediaItemId },
          'gallery.media_updated',
        );
        return result;
      });
    },

    softDelete(athleteId, rawMediaItemId, rawInput) {
      const tenantId = uuid.parse(athleteId);
      const mediaItemId = uuid.parse(rawMediaItemId);
      const input = galleryMediaSoftDeleteSchema.parse(rawInput);
      const key = `gallery:delete:${input.idempotencyKey}`;
      const request = { kind: 'gallery_delete', mediaItemId, ...input };
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const prior = await replay(tx, key, request);
        if (prior !== null) {
          const parsed = galleryMediaDeleteResultSchema.safeParse(prior);
          if (!parsed.success) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return parsed.data;
        }
        const head = (
          await tx.query(
            `SELECT access_revision FROM gallery_media_item
             WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
            [tenantId, mediaItemId],
          )
        ).rows[0];
        if (!head) throw new GalleryMediaNotFoundError();
        if (head['access_revision'] !== input.expectedAccessRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const deletedAt = await databaseNow(tx);
        const accessRevision = input.expectedAccessRevision + 1;
        await tx.query(
          `UPDATE gallery_media_item SET access_revision=$3,updated_at=$4,deleted_at=$4
           WHERE athlete_id=$1 AND id=$2`,
          [tenantId, mediaItemId, accessRevision, deletedAt],
        );
        const result = galleryMediaDeleteResultSchema.parse({
          status: 'deleted',
          mediaItemId,
          deletedAt,
          accessRevision,
        });
        await tx.query('SELECT public.tombstone_gallery_media_receipts($1)', [mediaItemId]);
        await tx.query("SELECT public.cancel_gallery_uploads($1,'MEDIA_DELETED')", [mediaItemId]);
        await tx.query("SELECT public.enqueue_gallery_media_cleanup($1,'resource_deleted')", [
          mediaItemId,
        ]);
        await finishCommand(tx, key, request, result, { mediaItemId }, 'gallery.media_deleted');
        return result;
      });
    },

    resolveObject(athleteId, rawMediaItemId, variant) {
      const tenantId = uuid.parse(athleteId);
      const mediaItemId = uuid.parse(rawMediaItemId);
      const selected = z.enum(['original', 'preview']).parse(variant);
      return database.tenant(tenantId, async (tx) => {
        const found = await tx.query(
          selected === 'original'
            ? `SELECT m.storage_ref,m.media_type,m.size_bytes,m.content_hash,m.original_filename
               FROM gallery_media_item m
               WHERE m.athlete_id=$1 AND m.id=$2 AND m.deleted_at IS NULL`
            : `SELECT d.storage_ref,d.media_type,d.size_bytes,d.content_hash,m.original_filename
               FROM gallery_media_derivative d JOIN gallery_media_item m
                 ON m.athlete_id=d.athlete_id AND m.id=d.media_item_id
               WHERE d.athlete_id=$1 AND d.media_item_id=$2 AND d.kind='preview'
                 AND m.deleted_at IS NULL`,
          [tenantId, mediaItemId],
        );
        if (!found.rows[0]) return null;
        const row = z
          .object({
            storage_ref: finalStorageRef,
            media_type: galleryMediaTypeSchema,
            size_bytes: z.coerce.number().int(),
            content_hash: z.string(),
            original_filename: z.string(),
          })
          .parse(found.rows[0]);
        return {
          storageRef: row.storage_ref,
          mediaItemId,
          mediaType: row.media_type,
          byteSize: row.size_bytes,
          sha256: row.content_hash,
          originalFileName: row.original_filename,
        };
      });
    },
  };
}
