import { z } from 'zod';

import { instantSchema, localDateSchema } from './primitives.js';

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

/**
 * Bounded upload limits. Only the original bytes are stored: this milestone
 * performs no transcoding, no thumbnail generation and no EXIF rewriting, so no
 * derived representation exists unless a client uploads one explicitly.
 */
export const GALLERY_IMAGE_MAX_BYTES = 15 * MEBIBYTE;
export const GALLERY_VIDEO_MAX_BYTES = 64 * MEBIBYTE;
export const GALLERY_PREVIEW_MAX_BYTES = 2 * MEBIBYTE;

const galleryUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const galleryIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

function hasUnsupportedTextCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127)
      return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function hasUnsupportedFileNameCharacter(value: string) {
  if (value.includes('/') || value.includes('\\')) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

const safeTextSchema = z.string().refine((value) => !hasUnsupportedTextCharacter(value), {
  message: 'Text contains an unsupported character.',
});

export const galleryMediaFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !hasUnsupportedFileNameCharacter(value), {
    message: 'File name contains an unsupported character.',
  })
  .refine((value) => new TextEncoder().encode(value).byteLength <= 255, {
    message: 'File name must be at most 255 bytes.',
  });

export const galleryMediaKindSchema = z.enum(['image', 'video']);
export const galleryImageMediaTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);
export const galleryVideoMediaTypeSchema = z.enum(['video/mp4', 'video/webm']);
export const galleryMediaTypeSchema = z.enum([
  ...galleryImageMediaTypeSchema.options,
  ...galleryVideoMediaTypeSchema.options,
]);
export const galleryMediaExtensionSchema = z.enum(['jpg', 'png', 'webp', 'mp4', 'webm']);

const extensionByMediaType: Record<
  z.infer<typeof galleryMediaTypeSchema>,
  z.infer<typeof galleryMediaExtensionSchema>
> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export function galleryMediaExtension(
  mediaType: z.infer<typeof galleryMediaTypeSchema>,
): z.infer<typeof galleryMediaExtensionSchema> {
  return extensionByMediaType[mediaType];
}

export function galleryMediaKindOf(
  mediaType: z.infer<typeof galleryMediaTypeSchema>,
): z.infer<typeof galleryMediaKindSchema> {
  return mediaType.startsWith('video/') ? 'video' : 'image';
}

export function galleryMediaMaxBytes(mediaType: z.infer<typeof galleryMediaTypeSchema>): number {
  return galleryMediaKindOf(mediaType) === 'video'
    ? GALLERY_VIDEO_MAX_BYTES
    : GALLERY_IMAGE_MAX_BYTES;
}

/** Public descriptor. Storage references and signed URLs are never exposed. */
export const galleryMediaDescriptorSchema = z
  .strictObject({
    originalFileName: galleryMediaFileNameSchema,
    mediaType: galleryMediaTypeSchema,
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((file) => file.byteSize <= galleryMediaMaxBytes(file.mediaType), {
    message: 'Media exceeds the allowed size for its content type.',
    path: ['byteSize'],
  });

export const galleryPreviewDescriptorSchema = z.strictObject({
  kind: z.literal('preview'),
  mediaType: galleryImageMediaTypeSchema,
  byteSize: z.number().int().positive().max(GALLERY_PREVIEW_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const galleryMediaAlbumSchema = safeTextSchema.trim().min(1).max(100);
export const galleryMediaCaptionSchema = safeTextSchema.trim().min(1).max(500);

export const galleryMediaItemSchema = z
  .strictObject({
    id: galleryUuidSchema,
    mediaKind: galleryMediaKindSchema,
    /** Only private ownership exists in this milestone. */
    visibility: z.literal('private'),
    /** Gallery access never implies consent to send media to a model. */
    includeForCoach: z.literal(false),
    album: galleryMediaAlbumSchema.nullable(),
    caption: galleryMediaCaptionSchema.nullable(),
    activityId: galleryUuidSchema.nullable(),
    capturedAt: instantSchema.nullable(),
    capturedLocalDate: localDateSchema.nullable(),
    file: galleryMediaDescriptorSchema,
    preview: galleryPreviewDescriptorSchema.nullable(),
    accessRevision: z.number().int().min(1),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .refine((item) => galleryMediaKindOf(item.file.mediaType) === item.mediaKind, {
    message: 'Media kind and content type must agree.',
    path: ['mediaKind'],
  });

export const galleryMediaListQuerySchema = z.strictObject({
  album: galleryMediaAlbumSchema.optional(),
  mediaKind: galleryMediaKindSchema.optional(),
  activityId: galleryUuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const galleryMediaListSchema = z
  .strictObject({
    items: z.array(galleryMediaItemSchema).max(100),
    total: z.number().int().min(0),
  })
  .refine((list) => list.total >= list.items.length, 'List total cannot be smaller than items.');

export const galleryMediaReadResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), item: galleryMediaItemSchema }),
  z.strictObject({ status: z.literal('unavailable'), mediaItemId: galleryUuidSchema }),
]);

export const galleryMediaCreateUploadMetadataSchema = z.strictObject({
  mediaKind: galleryMediaKindSchema,
  album: galleryMediaAlbumSchema.nullable().default(null),
  caption: galleryMediaCaptionSchema.nullable().default(null),
  activityId: galleryUuidSchema.nullable().default(null),
  capturedAt: instantSchema.nullable().default(null),
  capturedLocalDate: localDateSchema.nullable().default(null),
});

export const galleryMediaPreviewUploadMetadataSchema = z.strictObject({
  expectedAccessRevision: z.number().int().min(1),
});

export const galleryUploadStateSchema = z.enum([
  'reserved',
  'prepared',
  'staged',
  'finalized',
  'failed',
]);

export const galleryUploadReservationSchema = z.strictObject({
  uploadId: galleryUuidSchema,
  mediaItemId: galleryUuidSchema,
  operation: z.enum(['create_item', 'attach_preview']),
  state: galleryUploadStateSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const galleryMediaUpdateSchema = z.strictObject({
  album: galleryMediaAlbumSchema.nullable(),
  caption: galleryMediaCaptionSchema.nullable(),
  activityId: galleryUuidSchema.nullable(),
  expectedAccessRevision: z.number().int().min(1),
  idempotencyKey: galleryIdempotencyKeySchema,
});

export const galleryMediaSoftDeleteSchema = z.strictObject({
  expectedAccessRevision: z.number().int().min(1),
  idempotencyKey: galleryIdempotencyKeySchema,
});

export const galleryMediaDeleteResultSchema = z.strictObject({
  status: z.literal('deleted'),
  mediaItemId: galleryUuidSchema,
  deletedAt: instantSchema,
  accessRevision: z.number().int().min(1),
});

export type GalleryMediaKind = z.infer<typeof galleryMediaKindSchema>;
export type GalleryMediaType = z.infer<typeof galleryMediaTypeSchema>;
export type GalleryImageMediaType = z.infer<typeof galleryImageMediaTypeSchema>;
export type GalleryMediaDescriptor = z.infer<typeof galleryMediaDescriptorSchema>;
export type GalleryPreviewDescriptor = z.infer<typeof galleryPreviewDescriptorSchema>;
export type GalleryMediaItem = z.infer<typeof galleryMediaItemSchema>;
export type GalleryMediaList = z.infer<typeof galleryMediaListSchema>;
export type GalleryMediaListQuery = z.infer<typeof galleryMediaListQuerySchema>;
export type GalleryMediaReadResult = z.infer<typeof galleryMediaReadResultSchema>;
export type GalleryMediaCreateUploadMetadata = z.infer<
  typeof galleryMediaCreateUploadMetadataSchema
>;
export type GalleryMediaPreviewUploadMetadata = z.infer<
  typeof galleryMediaPreviewUploadMetadataSchema
>;
export type GalleryUploadReservation = z.infer<typeof galleryUploadReservationSchema>;
export type GalleryUploadState = z.infer<typeof galleryUploadStateSchema>;
export type GalleryMediaUpdate = z.infer<typeof galleryMediaUpdateSchema>;
export type GalleryMediaSoftDelete = z.infer<typeof galleryMediaSoftDeleteSchema>;
export type GalleryMediaDeleteResult = z.infer<typeof galleryMediaDeleteResultSchema>;
