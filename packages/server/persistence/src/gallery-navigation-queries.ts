import { z } from 'zod';
import {
  galleryMediaNavigationQueryV2Schema,
  type GalleryMediaNavigationQueryV2,
} from '@workout/contracts/gallery-navigation-v2';
import type { GalleryMediaNavigationPageV3 } from '@workout/contracts/gallery-navigation-v3';
import type { Transaction } from './database.js';
import { mapGalleryNavigationV3RowsPage } from './gallery-navigation-v3-rows.js';

export class GalleryNavigationQueryError extends Error {
  constructor(
    readonly code: 'INVALID_GALLERY_NAVIGATION_QUERY' | 'INVALID_GALLERY_NAVIGATION_CONTEXT',
  ) {
    super(code);
    this.name = 'GalleryNavigationQueryError';
  }
}
const ownerSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
// Fixed predicates; request values remain parameters. Stored local capture dates
// are compared as stored (no timezone conversion); unknown dates match only the
// explicit unknown filter. A course filter matches only the exact saved tuple.
// The per-row projection is the same SQL143 function the membership command stores.
const navigationSql = `SELECT public.gallery_media_navigation_projection_v1(m.id) AS row
 FROM public.gallery_media_item m
 LEFT JOIN public.gallery_media_album_membership l ON l.athlete_id=m.athlete_id AND l.media_item_id=m.id
 LEFT JOIN public.gallery_media_course_association c ON c.athlete_id=m.athlete_id AND c.media_item_id=m.id
 WHERE m.athlete_id=$1 AND m.deleted_at IS NULL
 AND ($2::text='all' OR ($2::text='unassigned' AND l.album_id IS NULL)
  OR ($2::text='album' AND l.album_id=$3::uuid))
 AND ($4::text IS NULL OR m.media_kind=$4::text)
 AND ($5::uuid IS NULL OR m.activity_id=$5::uuid)
 AND ($6::uuid IS NULL OR (c.course_id=$6::uuid AND c.course_revision=$7::integer AND c.revision_id=$8::uuid))
 AND ($9::text='all' OR ($9::text='unknown' AND m.captured_local_date IS NULL)
  OR ($9::text='stored_local_range' AND m.captured_local_date BETWEEN $10::date AND $11::date))
 AND ($12::timestamptz IS NULL OR m.created_at<$12::timestamptz
  OR (m.created_at=$12::timestamptz AND m.id>$13::uuid))
 ORDER BY m.created_at DESC,m.id ASC LIMIT $14::integer`;

function parameters(owner: string, query: GalleryMediaNavigationQueryV2): unknown[] {
  const { album, capturedDay, courseLink } = query.filters;
  return [
    owner,
    album.mode,
    album.mode === 'album' ? album.albumId : null,
    query.filters.mediaKind,
    query.filters.activityId,
    courseLink?.courseId ?? null,
    courseLink?.courseRevision ?? null,
    courseLink?.revisionId ?? null,
    capturedDay.mode,
    capturedDay.mode === 'stored_local_range' ? capturedDay.from : null,
    capturedDay.mode === 'stored_local_range' ? capturedDay.toInclusive : null,
    query.cursor?.after.createdAt ?? null,
    query.cursor?.after.id ?? null,
    query.limit + 1,
  ];
}
function projectedRows(raw: unknown): unknown {
  // A non-array reply is handed to the mapper unchanged and rejected there; it
  // never becomes a known-empty page.
  if (!Array.isArray(raw)) return raw;
  return raw.map((row: unknown) => {
    if (typeof row !== 'object' || row === null) return row;
    const descriptor = Object.getOwnPropertyDescriptor(row, 'row');
    return descriptor && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
  });
}
/** Retained read inside the caller's authenticated tenant transaction. Creates no
 * transaction, grant, consent or processing authority. The complete limit+1
 * projection (including the lookahead) is validated by the V3 page mapper. */
export async function readGalleryNavigationPageIn(
  transaction: Transaction,
  rawQuery: unknown,
): Promise<GalleryMediaNavigationPageV3> {
  const owner = ownerSchema.safeParse(transaction.athleteId);
  if (!owner.success) throw new GalleryNavigationQueryError('INVALID_GALLERY_NAVIGATION_CONTEXT');
  const parsed = galleryMediaNavigationQueryV2Schema.safeParse(rawQuery);
  if (!parsed.success) throw new GalleryNavigationQueryError('INVALID_GALLERY_NAVIGATION_QUERY');
  const result = await transaction.query(navigationSql, parameters(owner.data, parsed.data));
  return mapGalleryNavigationV3RowsPage(owner.data, parsed.data, projectedRows(result.rows));
}
