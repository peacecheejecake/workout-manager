import { z } from 'zod';
import { galleryMediaFileNameSchema } from './gallery.js';
import { gallerySubtitleTrackSchema, galleryViewerSubtitlesSchema } from './gallery-viewer.js';

export const GALLERY_SUBTITLE_SOURCE_MAX_BYTES = 512 * 1024;
/** Base64 request JSON and the active GET response have separate budgets. */
export const GALLERY_SUBTITLE_REQUEST_MAX_BYTES = 704 * 1024;
export const GALLERY_SUBTITLE_ACTIVE_RESPONSE_MAX_BYTES = 512 * 1024;
const BASE64_MAX = 4 * Math.ceil(GALLERY_SUBTITLE_SOURCE_MAX_BYTES / 3);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function canonicalBase64(value: string): boolean {
  if (!value.length || value.length > BASE64_MAX || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes < 1 || decodedBytes > GALLERY_SUBTITLE_SOURCE_MAX_BYTES) return false;
  // Canonical roundtrip requires unused low bits in the final sextet to be zero.
  const final = value[value.length - padding - 1];
  if (final === undefined) return false;
  const sextet = alphabet.indexOf(final);
  return padding === 2 ? (sextet & 15) === 0 : padding === 1 ? (sextet & 3) === 0 : true;
}
export const gallerySubtitleBase64V1Schema = z.string().max(BASE64_MAX).refine(canonicalBase64, {
  message: 'Invalid bounded canonical base64 subtitle bytes.',
});

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
/** Descriptor checks precede JSON serialization and all schema property reads. */
function plainSnapshot(value: unknown, maxBytes: number): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  let keysSeen = 0;
  let stringBytes = 0;
  function charge(text: string) {
    if (text.length > maxBytes || !wellFormed(text)) throw new Error('BOUND');
    stringBytes += new TextEncoder().encode(text).byteLength;
    if (stringBytes > maxBytes) throw new Error('BOUND');
  }
  function visit(current: unknown, depth: number): unknown {
    if (++nodes > 20_000 || depth > 12) throw new Error('BOUND');
    if (typeof current === 'string') {
      charge(current);
      return current;
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current !== 'object' || current === null || seen.has(current))
      throw new Error('BOUND');
    seen.add(current);
    const array = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new Error('BOUND');
    const keys = Reflect.ownKeys(current);
    keysSeen += keys.length;
    if (keysSeen > 20_000) throw new Error('BOUND');
    if (array) {
      const length = Object.getOwnPropertyDescriptor(current, 'length');
      if (
        !length ||
        !('value' in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > 10_000 ||
        keys.length !== length.value + 1
      )
        throw new Error('BOUND');
      for (const key of keys)
        if (
          key !== 'length' &&
          (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value)
        )
          throw new Error('BOUND');
    }
    const copy: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('BOUND');
      if (array && key === 'length') continue;
      charge(key);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new Error('BOUND');
      Object.defineProperty(copy, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  const copy = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > maxBytes)
    throw new Error('BOUND');
  return copy;
}
function bounded(maxBytes: number) {
  return z.unknown().transform((value, context) => {
    try {
      return plainSnapshot(value, maxBytes);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid bounded plain subtitle value.' });
      return z.NEVER;
    }
  });
}
const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const gallerySubtitleIdempotencyHeaderV1Schema = bounded(1024).pipe(
  z.strictObject({
    'idempotency-key': z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
  }),
);
export const gallerySubtitleAttachBodyV1Schema = bounded(GALLERY_SUBTITLE_REQUEST_MAX_BYTES).pipe(
  z.strictObject({
    expectedAccessRevision: revision,
    language: gallerySubtitleTrackSchema.shape.language,
    label: gallerySubtitleTrackSchema.shape.label,
    file: z.strictObject({
      originalFileName: galleryMediaFileNameSchema.nullable(),
      base64: gallerySubtitleBase64V1Schema,
    }),
  }),
);
export const gallerySubtitleDetachBodyV1Schema = bounded(1024).pipe(
  z.strictObject({
    expectedAccessRevision: revision,
    trackId: uuid,
    expectedTrackRevision: revision,
  }),
);
export const gallerySubtitleReadRequestV1Schema = bounded(1024).pipe(
  z.strictObject({
    mediaItemId: uuid,
    accessRevision: revision,
  }),
);
export const gallerySubtitleReadResultV1Schema = galleryViewerSubtitlesSchema;
const sourceScalarFields = {
  byteSize: z.number().int().min(1).max(GALLERY_SUBTITLE_SOURCE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: z.literal('user-webvtt-plain-v1'),
  origin: z.literal('user_supplied'),
};
const sourceReceiptFacts = z.strictObject(sourceScalarFields);
/** Owned provenance query only; no ownership/admission claim.
 * Original bytes and file name belong to the private active version and are
 * subject to detach/erase purge. Neither is retained in a durable receipt.
 */
export const gallerySubtitleSourceFactsV1Schema = bounded(2048).pipe(
  z.strictObject({
    originalFileName: galleryMediaFileNameSchema.nullable(),
    ...sourceScalarFields,
  }),
);
const receipt = {
  schemaVersion: z.literal(1),
  mediaItemId: uuid,
  accessRevision: revision,
  trackId: uuid,
  trackRevision: revision,
};
/** Durable receipt omits user text, file name, cues and original bytes. */
export const gallerySubtitleAttachResultV1Schema = bounded(4096).pipe(
  z.strictObject({
    ...receipt,
    status: z.literal('attached'),
    source: sourceReceiptFacts,
  }),
);
export const gallerySubtitleDetachResultV1Schema = bounded(1024).pipe(
  z.strictObject({
    ...receipt,
    status: z.literal('detached'),
  }),
);
export type GallerySubtitleAttachBodyV1 = z.infer<typeof gallerySubtitleAttachBodyV1Schema>;
export type GallerySubtitleDetachBodyV1 = z.infer<typeof gallerySubtitleDetachBodyV1Schema>;
export type GallerySubtitleIdempotencyHeaderV1 = z.infer<
  typeof gallerySubtitleIdempotencyHeaderV1Schema
>;
export type GallerySubtitleReadRequestV1 = z.infer<typeof gallerySubtitleReadRequestV1Schema>;
export type GallerySubtitleReadResultV1 = z.infer<typeof gallerySubtitleReadResultV1Schema>;
export type GallerySubtitleSourceFactsV1 = z.infer<typeof gallerySubtitleSourceFactsV1Schema>;
export type GallerySubtitleAttachResultV1 = z.infer<typeof gallerySubtitleAttachResultV1Schema>;
export type GallerySubtitleDetachResultV1 = z.infer<typeof gallerySubtitleDetachResultV1Schema>;
