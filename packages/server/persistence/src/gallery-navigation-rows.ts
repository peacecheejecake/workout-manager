import { z } from 'zod';
import {
  galleryAlbumListPageV1Schema,
  galleryAlbumListQueryV1Schema,
  galleryAlbumV1Schema,
  galleryMediaNavigationPageV2Schema,
  galleryMediaNavigationQueryV2Schema,
  galleryMediaNavigationV2Schema,
  type GalleryAlbumListPageV1,
  type GalleryAlbumV1,
  type GalleryMediaNavigationPageV2,
  type GalleryMediaNavigationV2,
} from '@workout/contracts/gallery-navigation-v2';

export class GalleryNavigationRowsError extends Error {
  readonly code = 'INVALID_GALLERY_PROJECTION';
  constructor() {
    super('INVALID_GALLERY_PROJECTION');
    this.name = 'GalleryNavigationRowsError';
  }
}
function invalid(): never {
  throw new GalleryNavigationRowsError();
}
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    return invalid();
  }
}
const ownerSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.trim() === v);
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
const storedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => v === v.trim());
// SQL ports must format timestamptz as UTC text with all six fractional digits.
// Date values, timezone conversion and millisecond reconstruction are rejected.
const sqlInstant = z.iso.datetime({ precision: 6 });
const byteCount = z.union([
  z.number().int().min(1).max(67108864),
  z
    .string()
    .regex(/^[1-9][0-9]{0,7}$/)
    .transform(Number)
    .pipe(z.number().int().max(67108864)),
]);
const albumRow = z.strictObject({
  athlete_id: ownerSchema,
  id: uuid,
  title: storedText(100),
  revision,
  created_at: sqlInstant,
  updated_at: sqlInstant,
  deleted_at: z.null(),
});
const mediaRow = z.strictObject({
  athlete_id: ownerSchema,
  id: uuid,
  media_kind: z.enum(['image', 'video']),
  visibility: z.literal('private'),
  include_for_coach: z.literal(false),
  album: storedText(100).nullable(),
  caption: storedText(500).nullable(),
  activity_id: uuid.nullable(),
  captured_at: sqlInstant.nullable(),
  captured_local_date: z.string().max(10).nullable(),
  original_filename: storedText(255),
  media_type: z.string().max(100),
  size_bytes: byteCount,
  content_hash: z.string().max(64),
  access_revision: revision,
  created_at: sqlInstant,
  updated_at: sqlInstant,
  deleted_at: z.null(),
  preview_media_type: z.string().max(100).nullable(),
  preview_size_bytes: byteCount.nullable(),
  preview_content_hash: z.string().max(64).nullable(),
  album_id: uuid.nullable(),
  album_athlete_id: ownerSchema.nullable(),
  course_id: uuid.nullable(),
  course_revision: revision.nullable(),
  course_revision_id: uuid.nullable(),
  course_athlete_id: ownerSchema.nullable(),
});
/** Flat SQL projections only: reject accessors before any schema reads fields. */
function flatRow(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Object.getPrototypeOf(raw) !== Object.prototype)
    return invalid();
  const keys = Reflect.ownKeys(raw);
  if (keys.length > 40) return invalid();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    const value: unknown = descriptor.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    )
      return invalid();
    if (typeof value === 'string' && value.length > 512) return invalid();
    Object.defineProperty(copy, key, { value, enumerable: true });
  }
  return copy;
}
function complete(values: readonly unknown[]): boolean {
  if (values.every((v) => v === null)) return false;
  if (values.some((v) => v === null)) return invalid();
  return true;
}
/** Equality checks projection facts; they do not attest RLS or current course head. */
export function mapGalleryAlbumRow(owner: unknown, raw: unknown): GalleryAlbumV1 {
  return checked(() => {
    const athleteId = ownerSchema.parse(owner);
    const row = albumRow.parse(flatRow(raw));
    if (row.athlete_id !== athleteId) return invalid();
    return galleryAlbumV1Schema.parse({
      schemaVersion: 1,
      id: row.id,
      title: row.title,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });
}
export function mapGalleryNavigationRow(owner: unknown, raw: unknown): GalleryMediaNavigationV2 {
  return checked(() => {
    const athleteId = ownerSchema.parse(owner);
    const row = mediaRow.parse(flatRow(raw));
    if (row.athlete_id !== athleteId || row.updated_at < row.created_at) return invalid();
    const hasAlbum = complete([row.album_id, row.album_athlete_id]);
    const hasCourse = complete([
      row.course_id,
      row.course_revision,
      row.course_revision_id,
      row.course_athlete_id,
    ]);
    const hasPreview = complete([
      row.preview_media_type,
      row.preview_size_bytes,
      row.preview_content_hash,
    ]);
    if (
      (hasAlbum && row.album_athlete_id !== athleteId) ||
      (hasCourse && row.course_athlete_id !== athleteId)
    )
      return invalid();
    return galleryMediaNavigationV2Schema.parse({
      schemaVersion: 2,
      item: {
        id: row.id,
        mediaKind: row.media_kind,
        visibility: row.visibility,
        includeForCoach: row.include_for_coach,
        album: row.album,
        caption: row.caption,
        activityId: row.activity_id,
        capturedAt: row.captured_at,
        capturedLocalDate: row.captured_local_date,
        file: {
          originalFileName: row.original_filename,
          mediaType: row.media_type,
          byteSize: row.size_bytes,
          sha256: row.content_hash,
        },
        preview: hasPreview
          ? {
              kind: 'preview',
              mediaType: row.preview_media_type,
              byteSize: row.preview_size_bytes,
              sha256: row.preview_content_hash,
            }
          : null,
        accessRevision: row.access_revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      albumMembership: hasAlbum ? { albumId: row.album_id } : null,
      courseLink: hasCourse
        ? {
            courseId: row.course_id,
            courseRevision: row.course_revision,
            revisionId: row.course_revision_id,
          }
        : null,
      capturedDay:
        row.captured_local_date === null
          ? { state: 'unknown' }
          : { state: 'known', localDate: row.captured_local_date },
    });
  });
}
function projectionRows(raw: unknown, limit: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(raw, 'length');
  if (
    !length ||
    !('value' in length) ||
    !Number.isInteger(length.value) ||
    length.value > limit + 1
  )
    return invalid();
  if (Reflect.ownKeys(raw).length !== length.value + 1) return invalid();
  const rows: unknown[] = [];
  for (let i = 0; i < length.value; i++) {
    const d = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!d || !('value' in d) || !d.enumerable) return invalid();
    rows.push(d.value);
  }
  return rows;
}
function distinct(ids: string[]) {
  if (new Set(ids).size !== ids.length) return invalid();
}
/** Consume at most limit+1 ordered rows, including validation of the lookahead. */
export function mapGalleryNavigationRowsPage(
  owner: unknown,
  rawQuery: unknown,
  rawRows: unknown,
): GalleryMediaNavigationPageV2 {
  return checked(() => {
    const query = galleryMediaNavigationQueryV2Schema.parse(rawQuery);
    const rows = projectionRows(rawRows, query.limit).map((r) => mapGalleryNavigationRow(owner, r));
    ownerSchema.parse(owner);
    distinct(rows.map((r) => r.item.id));
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? {
            cursorVersion: 1,
            binding: { filters: query.filters, limit: query.limit, sort: query.sort },
            after: { createdAt: last.item.createdAt, id: last.item.id },
          }
        : null;
    const result = galleryMediaNavigationPageV2Schema.parse({
      schemaVersion: 2,
      query,
      items,
      hasMore: nextCursor !== null,
      nextCursor,
    });
    if (nextCursor !== null)
      galleryMediaNavigationPageV2Schema.parse({
        schemaVersion: 2,
        query: { ...query, cursor: nextCursor },
        items: rows.slice(query.limit),
        hasMore: false,
        nextCursor: null,
      });
    return result;
  });
}
export function mapGalleryAlbumRowsPage(
  owner: unknown,
  rawQuery: unknown,
  rawRows: unknown,
): GalleryAlbumListPageV1 {
  return checked(() => {
    const query = galleryAlbumListQueryV1Schema.parse(rawQuery);
    const rows = projectionRows(rawRows, query.limit).map((r) => mapGalleryAlbumRow(owner, r));
    ownerSchema.parse(owner);
    distinct(rows.map((r) => r.id));
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? {
            cursorVersion: 1,
            binding: { limit: query.limit, sort: query.sort },
            after: { createdAt: last.createdAt, id: last.id },
          }
        : null;
    const result = galleryAlbumListPageV1Schema.parse({
      schemaVersion: 1,
      query,
      items,
      hasMore: nextCursor !== null,
      nextCursor,
    });
    if (nextCursor !== null)
      galleryAlbumListPageV1Schema.parse({
        schemaVersion: 1,
        query: { ...query, cursor: nextCursor },
        items: rows.slice(query.limit),
        hasMore: false,
        nextCursor: null,
      });
    return result;
  });
}
