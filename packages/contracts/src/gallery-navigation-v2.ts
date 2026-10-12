import { z } from 'zod';
import {
  galleryMediaAlbumSchema,
  galleryMediaItemSchema,
  galleryMediaKindSchema,
} from './gallery.js';
import { instantSchema, localDateSchema } from './primitives.js';

export const galleryNavigationV2Limits = Object.freeze({
  pageItems: 100,
  encodedBytes: 1048576,
  nodes: 20000,
  depth: 16,
});
const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
/** Descriptors are checked before downstream schemas read any field. */
const plainBoundary = z.unknown().transform((raw, ctx): unknown => {
  let nodes = 0;
  let bytes = 0;
  function add(value: string) {
    if (value.length > galleryNavigationV2Limits.encodedBytes) throw new Error('bound');
    bytes += new TextEncoder().encode(value).length + 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 34 || code === 92) bytes++;
      else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('surrogate');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('surrogate');
    }
    if (bytes > galleryNavigationV2Limits.encodedBytes) throw new Error('bound');
  }
  function walk(value: unknown, depth: number): unknown {
    bytes += 16;
    if (
      bytes > galleryNavigationV2Limits.encodedBytes ||
      ++nodes > galleryNavigationV2Limits.nodes ||
      depth > galleryNavigationV2Limits.depth
    )
      throw new Error('bound');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      add(value);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null) throw new Error('plain');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
      throw new Error('plain');
    const keys = Reflect.ownKeys(value);
    if (keys.length > galleryNavigationV2Limits.nodes - nodes) throw new Error('bound');
    const length = array ? Object.getOwnPropertyDescriptor(value, 'length') : null;
    if (
      array &&
      (!length ||
        !('value' in length) ||
        !Number.isSafeInteger(length.value) ||
        keys.length !== length.value + 1)
    )
      throw new Error('dense');
    const copy: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || !length || Number(key) >= length.value))
      )
        throw new Error('plain');
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !('value' in d) || !d.enumerable) throw new Error('plain');
      add(key);
      Object.defineProperty(copy, key, {
        value: walk(d.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  try {
    const copy = walk(raw, 0);
    const encoded = JSON.stringify(copy);
    if (
      encoded === undefined ||
      new TextEncoder().encode(encoded).length > galleryNavigationV2Limits.encodedBytes
    )
      throw new Error('bound');
    return copy;
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid or oversized plain gallery navigation data.',
    });
    return z.NEVER;
  }
});
function bounded<T extends z.ZodType>(schema: T) {
  return plainBoundary.pipe(schema);
}
// PostgreSQL keyset timestamps may differ within the same millisecond.
function micros(value: string): bigint {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0n; // The instant schema reports invalid values.
  return BigInt(parsed) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}
const keyInstant = instantSchema.refine(
  (v) => (/\.(\d+)/.exec(v)?.[1]?.length ?? 0) <= 6,
  'Unsupported timestamp precision.',
);
const album = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: uuid,
    title: galleryMediaAlbumSchema,
    revision,
    createdAt: keyInstant,
    updatedAt: keyInstant,
  })
  .refine((v) => micros(v.updatedAt) >= micros(v.createdAt), 'Album time moved backwards.');
export const galleryAlbumV1Schema = bounded(album);
export const galleryNavigationIdempotencyKeySchema = bounded(
  z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
);
// Idempotency comes from headers; ownership comes from the authenticated principal.
export const galleryAlbumCreateCommandV1Schema = bounded(
  z.strictObject({ title: galleryMediaAlbumSchema }),
);
export const galleryAlbumRenameCommandV1Schema = bounded(
  z.strictObject({ albumId: uuid, expectedRevision: revision, title: galleryMediaAlbumSchema }),
);
export const galleryAlbumDeleteCommandV1Schema = bounded(
  z.strictObject({ albumId: uuid, expectedRevision: revision }),
);
export const galleryAlbumDeleteResultV1Schema = bounded(
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('deleted'),
    albumId: uuid,
    revision,
    detachedMediaCount: z.number().int().min(0).max(2147483647),
  }),
);
// Saved tuples never prove current ownership or select the latest course head.
const courseLink = z.strictObject({ courseId: uuid, courseRevision: revision, revisionId: uuid });
export const galleryCourseLinkV2Schema = bounded(courseLink);
const membership = z.strictObject({ albumId: uuid });
export const galleryMediaMembershipCommandV2Schema = bounded(
  z.strictObject({
    mediaItemId: uuid,
    expectedAccessRevision: revision,
    albumMembership: membership.nullable(),
    courseLink: courseLink.nullable(),
  }),
);
const capturedDay = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('known'), localDate: localDateSchema }),
  z.strictObject({ state: z.literal('unknown') }),
]);
const media = z
  .strictObject({
    schemaVersion: z.literal(2),
    item: galleryMediaItemSchema,
    albumMembership: membership.nullable(),
    courseLink: courseLink.nullable(),
    capturedDay,
  })
  .superRefine((v, ctx) => {
    if (
      (v.capturedDay.state === 'known' ? v.capturedDay.localDate : null) !==
      v.item.capturedLocalDate
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Captured day must preserve the stored local capture fact.',
      });
    if (!keyInstant.safeParse(v.item.createdAt).success)
      ctx.addIssue({ code: 'custom', message: 'Unsupported keyset instant.' });
  });
export const galleryMediaNavigationV2Schema = bounded(media);
const dateFilter = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({ mode: z.literal('unknown') }),
  z
    .strictObject({
      mode: z.literal('stored_local_range'),
      from: localDateSchema,
      toInclusive: localDateSchema,
    })
    .refine((v) => v.from <= v.toInclusive, 'Reversed local date range.'),
]);
const albumFilter = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({ mode: z.literal('unassigned') }),
  z.strictObject({ mode: z.literal('album'), albumId: uuid }),
]);
const filters = z.strictObject({
  album: albumFilter,
  mediaKind: galleryMediaKindSchema.nullable(),
  activityId: uuid.nullable(),
  courseLink: courseLink.nullable(),
  capturedDay: dateFilter,
});
const binding = z.strictObject({
  filters,
  limit: z.number().int().min(1).max(100),
  sort: z.literal('created_desc_id_asc'),
});
const after = z.strictObject({ createdAt: keyInstant, id: uuid });
const cursor = z.strictObject({ cursorVersion: z.literal(1), binding, after });
/** Navigation only, never a permission, source-authentication or tenant proof. */
export const galleryNavigationCursorV2Schema = bounded(cursor);
const query = z
  .strictObject({ ...binding.shape, cursor: cursor.nullable() })
  .superRefine((v, ctx) => {
    if (
      v.cursor !== null &&
      JSON.stringify(v.cursor.binding) !==
        JSON.stringify({ filters: v.filters, limit: v.limit, sort: v.sort })
    )
      ctx.addIssue({ code: 'custom', message: 'Cursor belongs to a different query.' });
  });
export const galleryMediaNavigationQueryV2Schema = bounded(query);
function follows(a: z.infer<typeof after>, b: z.infer<typeof after>): boolean {
  const delta = micros(a.createdAt) - micros(b.createdAt);
  return delta > 0n || (delta === 0n && a.id < b.id);
}
function matches(v: z.infer<typeof media>, f: z.infer<typeof filters>): boolean {
  const day = v.item.capturedLocalDate;
  return (
    (f.album.mode === 'all' ||
      (f.album.mode === 'unassigned'
        ? v.albumMembership === null
        : v.albumMembership?.albumId === f.album.albumId)) &&
    (f.mediaKind === null || f.mediaKind === v.item.mediaKind) &&
    (f.activityId === null || f.activityId === v.item.activityId) &&
    (f.courseLink === null || JSON.stringify(f.courseLink) === JSON.stringify(v.courseLink)) &&
    (f.capturedDay.mode === 'all' ||
      (f.capturedDay.mode === 'unknown'
        ? day === null
        : day !== null && day >= f.capturedDay.from && day <= f.capturedDay.toInclusive))
  );
}
export const galleryMediaNavigationPageV2Schema = bounded(
  z
    .strictObject({
      schemaVersion: z.literal(2),
      query,
      items: z.array(media).max(100),
      hasMore: z.boolean(),
      nextCursor: cursor.nullable(),
    })
    .superRefine((v, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (v.items.length > v.query.limit) issue('Page exceeds query limit.');
      const ids = new Set<string>();
      let prior = v.query.cursor?.after ?? null;
      for (const entry of v.items) {
        const key = { createdAt: entry.item.createdAt, id: entry.item.id };
        if (ids.has(key.id)) issue('Duplicate media identity.');
        ids.add(key.id);
        if (prior !== null && !follows(prior, key)) issue('Invalid keyset order or boundary.');
        prior = key;
        if (!matches(entry, v.query.filters)) issue('Media does not match query.');
      }
      if (v.hasMore !== (v.nextCursor !== null)) issue('Pagination state disagrees.');
      if (v.hasMore && v.items.length !== v.query.limit)
        issue('Continuation requires a full page.');
      if (
        v.nextCursor !== null &&
        (JSON.stringify(v.nextCursor.binding) !==
          JSON.stringify({ filters: v.query.filters, limit: v.query.limit, sort: v.query.sort }) ||
          prior === null ||
          v.nextCursor.after.id !== prior.id ||
          micros(v.nextCursor.after.createdAt) !== micros(prior.createdAt))
      )
        issue('Continuation must bind query and last item.');
    }),
);
export type GalleryAlbumV1 = z.infer<typeof galleryAlbumV1Schema>;
export type GalleryCourseLinkV2 = z.infer<typeof galleryCourseLinkV2Schema>;
export type GalleryMediaNavigationV2 = z.infer<typeof galleryMediaNavigationV2Schema>;
export type GalleryMediaNavigationQueryV2 = z.infer<typeof galleryMediaNavigationQueryV2Schema>;
export type GalleryMediaNavigationPageV2 = z.infer<typeof galleryMediaNavigationPageV2Schema>;
export type GalleryMediaMembershipCommandV2 = z.infer<typeof galleryMediaMembershipCommandV2Schema>;

export type GalleryAlbumCreateCommandV1 = z.infer<typeof galleryAlbumCreateCommandV1Schema>;
export type GalleryAlbumRenameCommandV1 = z.infer<typeof galleryAlbumRenameCommandV1Schema>;
export type GalleryAlbumDeleteCommandV1 = z.infer<typeof galleryAlbumDeleteCommandV1Schema>;
export type GalleryAlbumDeleteResultV1 = z.infer<typeof galleryAlbumDeleteResultV1Schema>;
export type GalleryNavigationCursorV2 = z.infer<typeof galleryNavigationCursorV2Schema>;

const albumListBinding = z.strictObject({
  limit: z.number().int().min(1).max(galleryNavigationV2Limits.pageItems),
  sort: z.literal('created_desc_id_asc'),
});
const albumListCursor = z.strictObject({
  cursorVersion: z.literal(1),
  binding: albumListBinding,
  after,
});
const albumListQuery = z
  .strictObject({ ...albumListBinding.shape, cursor: albumListCursor.nullable() })
  .superRefine((v, ctx) => {
    if (
      v.cursor !== null &&
      (v.cursor.binding.limit !== v.limit || v.cursor.binding.sort !== v.sort)
    )
      ctx.addIssue({ code: 'custom', message: 'Album cursor belongs to a different query.' });
  });
export const galleryAlbumListQueryV1Schema = bounded(albumListQuery);
export const galleryAlbumListPageV1Schema = bounded(
  z
    .strictObject({
      schemaVersion: z.literal(1),
      query: albumListQuery,
      items: z.array(album).max(galleryNavigationV2Limits.pageItems),
      hasMore: z.boolean(),
      nextCursor: albumListCursor.nullable(),
    })
    .superRefine((v, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (v.items.length > v.query.limit) issue('Album page exceeds query limit.');
      const ids = new Set<string>();
      let prior = v.query.cursor?.after ?? null;
      for (const entry of v.items) {
        const key = { createdAt: entry.createdAt, id: entry.id };
        if (ids.has(key.id)) issue('Duplicate album identity.');
        ids.add(key.id);
        if (prior !== null && !follows(prior, key))
          issue('Invalid album keyset order or boundary.');
        prior = key;
      }
      if (v.hasMore !== (v.nextCursor !== null)) issue('Album pagination state disagrees.');
      if (v.hasMore && v.items.length !== v.query.limit)
        issue('Album continuation requires a full page.');
      if (
        v.nextCursor !== null &&
        (v.nextCursor.binding.limit !== v.query.limit ||
          v.nextCursor.binding.sort !== v.query.sort ||
          prior === null ||
          v.nextCursor.after.id !== prior.id ||
          micros(v.nextCursor.after.createdAt) !== micros(prior.createdAt))
      )
        issue('Album continuation must bind query and last item.');
    }),
);
export type GalleryAlbumListQueryV1 = z.infer<typeof galleryAlbumListQueryV1Schema>;
export type GalleryAlbumListPageV1 = z.infer<typeof galleryAlbumListPageV1Schema>;
