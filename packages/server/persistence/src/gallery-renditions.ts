import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  galleryRenditionKindV1Schema,
  galleryRenditionListV1Schema,
  type GalleryRenditionKindV1,
  type GalleryRenditionListV1,
} from '@workout/contracts/gallery-rendition';

import type { Database } from './database.js';

/**
 * SQL144 adapters (M2-03c). The worker store runs every call in its own short transaction on a
 * dedicated worker pool; the definer functions take the restore/lifecycle fences, set the
 * tenant and re-check lease, deletion, consent and lineage themselves. Nothing here performs
 * remote I/O inside a transaction.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const tenantSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const workerSchema = uuid;

export const GALLERY_RENDITION_RELEASE_CODES = [
  'unsupported_format',
  'unsupported_pages',
  'input_invalid',
  'input_budget',
  'pixel_budget',
  'invalid_media',
  'decode_failed',
  'output_budget',
  'aborted',
  'timeout',
  'codec_unavailable',
  'transient',
] as const;
export type GalleryRenditionReleaseCode = (typeof GALLERY_RENDITION_RELEASE_CODES)[number];

const claimSchema = z.strictObject({
  athleteId: tenantSchema,
  jobId: uuid,
  leaseToken: uuid,
  leaseUntil: z.iso.datetime({ offset: false }),
  mediaItemId: uuid,
  kind: galleryRenditionKindV1Schema,
  recipeVersion: z.literal(1),
  sourceSha256: sha256,
  sourceByteSize: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  parentAccessRevision: z.number().int().min(1).max(2147483646),
  idempotencyKey: z.string().regex(/^gallery-rendition:v1:[0-9a-f-]{36}:[a-z_]+$/),
  attempt: z.number().int().min(1).max(3),
  originalStorageRef: z.string().min(1).max(512),
  originalMediaType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']),
});
export type GalleryRenditionClaimRow = z.infer<typeof claimSchema>;

const settleReplySchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready') }),
  z.strictObject({
    state: z.literal('rejected'),
    reason: z.enum(['lease_lost', 'stale', 'deleted', 'consent_withdrawn', 'authoring_closed']),
  }),
]);
export type GalleryRenditionSettleReply = z.infer<typeof settleReplySchema>;
const releaseReplySchema = z.strictObject({
  state: z.literal('released'),
  outcome: z.enum(['released', 'requeued', 'failed', 'unsupported']),
});
export type GalleryRenditionReleaseReply = z.infer<typeof releaseReplySchema>;
const sweepSchema = z.strictObject({
  sweepId: uuid,
  athleteId: tenantSchema,
  mediaItemId: uuid,
  jobId: uuid.nullable(),
  attemptId: uuid.nullable(),
});
export type GalleryRenditionSweepRow = z.infer<typeof sweepSchema>;

export interface GalleryRenditionSettleOutput {
  storageRef: string;
  sha256: string;
  byteSize: number;
  mediaType: 'image/webp' | 'video/mp4';
  width: number;
  height: number;
  durationSeconds: number | null;
}
const settleOutputSchema = z.strictObject({
  storageRef: z.string().min(1).max(512),
  sha256,
  byteSize: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  mediaType: z.enum(['image/webp', 'video/mp4']),
  width: z.number().int().positive().max(1600),
  height: z.number().int().positive().max(1600),
  durationSeconds: z.number().finite().positive().max(3600).nullable(),
});

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','3000',true),set_config('search_path','pg_catalog,public',true)",
    );
    const value = await work(client);
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('TRANSACTION_NOT_COMMITTED');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function scalar(client: PoolClient, sql: string, values: unknown[]): Promise<unknown> {
  const result = await client.query<{ value: unknown }>(sql, values);
  if (result.rows.length !== 1) throw new Error('INVALID_GALLERY_RENDITION_REPLY');
  return result.rows[0]?.value;
}

/** Worker-role store. The pool must use the dedicated, non-owner worker credentials. */
export function createGalleryRenditionWorkerStore(
  pool: Pool,
  options: { leaseSeconds: number } = { leaseSeconds: 60 },
) {
  const leaseSeconds = z.number().int().min(5).max(300).parse(options.leaseSeconds);
  return {
    async claim(workerId: string): Promise<GalleryRenditionClaimRow | null> {
      const worker = workerSchema.parse(workerId);
      const value = await inTransaction(pool, (client) =>
        scalar(client, 'SELECT public.claim_gallery_rendition_v1($1,$2) AS value', [
          worker,
          leaseSeconds,
        ]),
      );
      return value === null ? null : claimSchema.parse(value);
    },
    async settle(input: {
      athleteId: string;
      jobId: string;
      leaseToken: string;
      output: GalleryRenditionSettleOutput;
    }): Promise<GalleryRenditionSettleReply> {
      const output = settleOutputSchema.parse(input.output);
      const value = await inTransaction(pool, (client) =>
        scalar(client, 'SELECT public.settle_gallery_rendition_v1($1,$2,$3,$4::jsonb) AS value', [
          tenantSchema.parse(input.athleteId),
          uuid.parse(input.jobId),
          uuid.parse(input.leaseToken),
          JSON.stringify(output),
        ]),
      );
      return settleReplySchema.parse(value);
    },
    async release(input: {
      athleteId: string;
      jobId: string;
      leaseToken: string;
      code: GalleryRenditionReleaseCode;
    }): Promise<GalleryRenditionReleaseReply> {
      const code = z.enum(GALLERY_RENDITION_RELEASE_CODES).parse(input.code);
      const value = await inTransaction(pool, (client) =>
        scalar(client, 'SELECT public.release_gallery_rendition_v1($1,$2,$3,$4) AS value', [
          tenantSchema.parse(input.athleteId),
          uuid.parse(input.jobId),
          uuid.parse(input.leaseToken),
          code,
        ]),
      );
      return releaseReplySchema.parse(value);
    },
    async claimSweep(workerId: string): Promise<GalleryRenditionSweepRow | null> {
      const worker = workerSchema.parse(workerId);
      const value = await inTransaction(pool, (client) =>
        scalar(client, 'SELECT public.claim_gallery_rendition_sweep_v1($1,$2) AS value', [
          worker,
          leaseSeconds,
        ]),
      );
      return value === null ? null : sweepSchema.parse(value);
    },
    async finishSweep(sweepId: string, workerId: string, complete: boolean): Promise<boolean> {
      const value = await inTransaction(pool, (client) =>
        scalar(client, 'SELECT public.finish_gallery_rendition_sweep_v1($1,$2,$3) AS value', [
          uuid.parse(sweepId),
          workerSchema.parse(workerId),
          z.boolean().parse(complete),
        ]),
      );
      return z.boolean().parse(value);
    },
  };
}
export type GalleryRenditionWorkerStore = ReturnType<typeof createGalleryRenditionWorkerStore>;

const objectSchema = z.strictObject({
  storageRef: z.string().min(1).max(512),
  sha256,
  byteSize: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  mediaType: z.enum(['image/webp', 'video/mp4']),
});
export type GalleryRenditionObject = z.infer<typeof objectSchema>;

/** Runtime (API role) reader. Tenant fences come from Database.tenant. */
export function createGalleryRenditionReader(database: Database) {
  return {
    async list(athleteId: string, mediaItemId: string): Promise<GalleryRenditionListV1 | null> {
      const media = uuid.parse(mediaItemId);
      const value = await database.tenant(athleteId, async (tx) => {
        const result = await tx.query('SELECT public.read_gallery_renditions_v1($1) AS value', [
          media,
        ]);
        if (result.rows.length !== 1) throw new Error('INVALID_GALLERY_RENDITION_REPLY');
        return result.rows[0]?.['value'];
      });
      if (value === null) return null;
      const parsed = galleryRenditionListV1Schema.parse(value);
      if (parsed.mediaItemId !== media) throw new Error('INVALID_GALLERY_RENDITION_REPLY');
      return parsed;
    },
    async resolveObject(
      athleteId: string,
      mediaItemId: string,
      kind: GalleryRenditionKindV1,
    ): Promise<GalleryRenditionObject | null> {
      const media = uuid.parse(mediaItemId);
      const rendition = galleryRenditionKindV1Schema.parse(kind);
      const value = await database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          'SELECT public.resolve_gallery_rendition_object_v1($1,$2) AS value',
          [media, rendition],
        );
        if (result.rows.length !== 1) throw new Error('INVALID_GALLERY_RENDITION_REPLY');
        return result.rows[0]?.['value'];
      });
      return value === null ? null : objectSchema.parse(value);
    },
    async enqueue(athleteId: string, mediaItemId: string): Promise<number> {
      const media = uuid.parse(mediaItemId);
      const value = await database.tenant(athleteId, async (tx) => {
        const result = await tx.query('SELECT public.enqueue_gallery_renditions_v1($1) AS value', [
          media,
        ]);
        return result.rows[0]?.['value'];
      });
      return z.number().int().min(0).max(2).parse(value);
    },
  };
}
export type GalleryRenditionReader = ReturnType<typeof createGalleryRenditionReader>;
