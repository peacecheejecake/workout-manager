import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import { galleryAccountExportDataV39Schema } from '@workout/contracts/operations';
import type { Transaction } from './database.js';
export class GalleryAccountExportV39Error extends Error {
  constructor(readonly code: 'TOO_LARGE' | 'CORRUPT') {
    super(code);
  }
}
const sql = {
  albums: `SELECT jsonb_build_object('schemaVersion',1,'id',id,'title',title,'revision',revision,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS entry FROM public.gallery_album WHERE athlete_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id ASC LIMIT 1001`,
  memberships: `SELECT jsonb_build_object('mediaItemId',a.media_item_id,'albumId',a.album_id) AS entry FROM public.gallery_media_album_membership a JOIN public.gallery_album h ON h.athlete_id=a.athlete_id AND h.id=a.album_id AND h.deleted_at IS NULL JOIN public.gallery_media_item m ON m.athlete_id=a.athlete_id AND m.id=a.media_item_id AND m.deleted_at IS NULL WHERE a.athlete_id=$1 ORDER BY a.media_item_id LIMIT 1001`,
  courseAssociations: `SELECT jsonb_build_object('mediaItemId',a.media_item_id,'courseLink',jsonb_build_object('courseId',a.course_id,'courseRevision',a.course_revision,'revisionId',a.revision_id),'courseAvailability',jsonb_build_object('state',CASE WHEN EXISTS(SELECT 1 FROM public.course h JOIN public.course_revision r ON r.athlete_id=h.athlete_id AND r.course_id=h.course_id WHERE h.athlete_id=a.athlete_id AND h.course_id=a.course_id AND h.status='available' AND r.course_revision=a.course_revision AND r.revision_id=a.revision_id) THEN 'available' ELSE 'unavailable' END)) AS entry FROM public.gallery_media_course_association a JOIN public.gallery_media_item m ON m.athlete_id=a.athlete_id AND m.id=a.media_item_id AND m.deleted_at IS NULL WHERE a.athlete_id=$1 ORDER BY a.media_item_id LIMIT 1001`,
  albumDeletions: `SELECT jsonb_build_object('albumId',album_id,'deletedRevision',deleted_revision,'deletedAt',to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS entry FROM public.gallery_album_deletion WHERE athlete_id=$1 ORDER BY deleted_at,album_id LIMIT 1001`,
};

/** SAME retained V38 snapshot transaction and shared remaining/debit budget only.
 * This function owns no transaction, audit, auth/source proof or fallback. */
export async function readGalleryAccountExportV39In(
  tx: Transaction,
  remaining: () => number,
  debit: (bytes: number) => void,
) {
  const d = Object.getOwnPropertyDescriptor(tx, 'athleteId');
  if (
    !d ||
    !('value' in d) ||
    typeof d.value !== 'string' ||
    d.value.length < 1 ||
    d.value.length > 200 ||
    d.value.trim() !== d.value
  )
    throw new GalleryAccountExportV39Error('CORRUPT');
  const owner = d.value;
  async function read(sql: string, key: string) {
    const budget = remaining();
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8388608)
      throw new GalleryAccountExportV39Error('TOO_LARGE');
    const response = await tx.query(sql, [owner]);
    const guarded = createBoundedPlainJsonSchema(8388608).safeParse(response.rows);
    if (!guarded.success) throw new GalleryAccountExportV39Error('CORRUPT');
    const rows = z
      .array(z.strictObject({ entry: z.unknown() }))
      .max(1001)
      .safeParse(guarded.data);
    if (!rows.success) throw new GalleryAccountExportV39Error('CORRUPT');
    if (rows.data.length > 1000) throw new GalleryAccountExportV39Error('TOO_LARGE');
    const entries = rows.data.map((row) => row.entry),
      bytes = Buffer.byteLength(JSON.stringify({ [key]: entries }), 'utf8');
    if (bytes > budget) throw new GalleryAccountExportV39Error('TOO_LARGE');
    debit(bytes);
    return entries;
  }
  const galleryAlbums = await read(sql.albums, 'galleryAlbums');
  const galleryAlbumMemberships = await read(sql.memberships, 'galleryAlbumMemberships');
  const galleryCourseAssociations = await read(sql.courseAssociations, 'galleryCourseAssociations');
  const galleryAlbumDeletions = await read(sql.albumDeletions, 'galleryAlbumDeletions');
  const data = galleryAccountExportDataV39Schema.safeParse({
    galleryAlbums,
    galleryAlbumMemberships,
    galleryCourseAssociations,
    galleryAlbumDeletions,
  });
  if (!data.success) throw new GalleryAccountExportV39Error('CORRUPT');
  return data.data;
}
