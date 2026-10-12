import { z } from 'zod';
import {
  galleryNavigationV2Limits,
  galleryMediaNavigationV2Schema,
  galleryMediaNavigationQueryV2Schema,
  galleryMediaNavigationPageV2Schema,
  galleryNavigationCursorV2Schema,
} from './gallery-navigation-v2.js';

/** Existing query/cursor limits also bound the complete successor response. */
export const galleryNavigationV3Limits = galleryNavigationV2Limits;
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

const availability = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('available') }),
  z.strictObject({ state: z.literal('unavailable') }),
]);
/** A server read fact only: no deletion reason, owner details or access authority. */
export const galleryCourseAvailabilityV3Schema = bounded(availability);
const media = z
  .strictObject({
    schemaVersion: z.literal(3),
    item: z.unknown(),
    albumMembership: z.unknown(),
    courseLink: z.unknown(),
    capturedDay: z.unknown(),
    courseAvailability: availability.nullable(),
  })
  .transform((value, context) => {
    const base = galleryMediaNavigationV2Schema.safeParse({
      schemaVersion: 2,
      item: value.item,
      albumMembership: value.albumMembership,
      courseLink: value.courseLink,
      capturedDay: value.capturedDay,
    });
    if (!base.success) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid gallery navigation descriptor.',
      });
      return z.NEVER;
    }
    if ((base.data.courseLink === null) !== (value.courseAvailability === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Availability must correspond to the saved course link.',
      });
      return z.NEVER;
    }
    return {
      ...base.data,
      schemaVersion: 3 as const,
      courseAvailability: value.courseAvailability,
    };
  });
/** Saved association and its read-time availability never grant access or choose a new head. */
export const galleryMediaNavigationV3Schema = bounded(media);
export const galleryMediaNavigationPageV3Schema = bounded(
  z
    .strictObject({
      schemaVersion: z.literal(3),
      query: galleryMediaNavigationQueryV2Schema,
      items: z.array(media).max(galleryNavigationV3Limits.pageItems),
      hasMore: z.boolean(),
      nextCursor: galleryNavigationCursorV2Schema.nullable(),
    })
    .superRefine((page, context) => {
      // Reuse the canonical V2 filter, microsecond ordering and continuation checks.
      const original = galleryMediaNavigationPageV2Schema.safeParse({
        ...page,
        schemaVersion: 2,
        items: page.items.map(({ courseAvailability, ...item }) => {
          void courseAvailability;
          return { ...item, schemaVersion: 2 };
        }),
      });
      if (!original.success)
        context.addIssue({
          code: 'custom',
          message: 'Invalid gallery navigation page or continuation.',
        });
    }),
);
export type GalleryCourseAvailabilityV3 = z.infer<typeof galleryCourseAvailabilityV3Schema>;
export type GalleryMediaNavigationV3 = z.infer<typeof galleryMediaNavigationV3Schema>;
export type GalleryMediaNavigationPageV3 = z.infer<typeof galleryMediaNavigationPageV3Schema>;
