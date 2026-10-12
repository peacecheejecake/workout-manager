import { z } from 'zod';
import {
  galleryAlbumListQueryV1Schema,
  type GalleryAlbumListPageV1,
} from '@workout/contracts/gallery-navigation-v2';
import type { Transaction } from './database.js';
import { mapGalleryAlbumRowsPage } from './gallery-navigation-rows.js';

export class GalleryAlbumQueryError extends Error {
  constructor(readonly code: 'INVALID_GALLERY_ALBUM_QUERY' | 'INVALID_GALLERY_ALBUM_CONTEXT') {
    super(code);
    this.name = 'GalleryAlbumQueryError';
  }
}
const ownerSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
// Fixed identifiers and predicates; request values remain parameters. The public
// order is descending instant, ascending UUID, with precise timestamptz bounds.
const albumPageSql = `SELECT a.athlete_id,a.id::text AS id,a.title,a.revision,
 to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
 a.deleted_at
 FROM public.gallery_album a
 WHERE a.athlete_id=$1 AND a.deleted_at IS NULL
 AND ($2::timestamptz IS NULL OR a.created_at<$2::timestamptz
  OR (a.created_at=$2::timestamptz AND a.id>$3::uuid))
 ORDER BY a.created_at DESC,a.id ASC LIMIT $4::integer`;

/** Retained read inside the caller's authenticated tenant transaction. This port
 * creates no transaction, grant, consent or processing authority. SQL143 is not
 * yet registered; successor admission/catalog/lifecycle integration remains Root-owned. */
export async function readGalleryAlbumPageIn(
  transaction: Transaction,
  rawQuery: unknown,
): Promise<GalleryAlbumListPageV1> {
  const owner = ownerSchema.safeParse(transaction.athleteId);
  if (!owner.success) throw new GalleryAlbumQueryError('INVALID_GALLERY_ALBUM_CONTEXT');
  const parsed = galleryAlbumListQueryV1Schema.safeParse(rawQuery);
  if (!parsed.success) throw new GalleryAlbumQueryError('INVALID_GALLERY_ALBUM_QUERY');
  const query = parsed.data;
  const result = await transaction.query(albumPageSql, [
    owner.data,
    query.cursor?.after.createdAt ?? null,
    query.cursor?.after.id ?? null,
    query.limit + 1,
  ]);
  return mapGalleryAlbumRowsPage(owner.data, query, result.rows);
}
