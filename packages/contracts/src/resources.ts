import { z } from 'zod';

import { instantSchema } from './primitives.js';

const KIBIBYTE = 1024;
const MAX_RESOURCE_TEXT_BYTES = 64 * KIBIBYTE;
const MAX_PARAGRAPHS = 1000;

const resourceUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const resourceIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

function hasUnsupportedStorageCharacter(value: string) {
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

const storageSafeStringSchema = z
  .string()
  .refine(
    (value) => !hasUnsupportedStorageCharacter(value),
    'String must not contain unsupported storage characters.',
  );

export const privateTextResourceCategorySchema = z.enum([
  'paper',
  'guide',
  'note',
  'race_material',
]);

export const privateTextResourceTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'Text must not be blank.')
  .refine(
    (value) => !hasUnsupportedStorageCharacter(value),
    'Text must not contain unsupported storage characters.',
  )
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= MAX_RESOURCE_TEXT_BYTES,
    'Text must not exceed 64 KiB when UTF-8 encoded.',
  );

const privateTextResourceMetadataSchema = z.strictObject({
  author: storageSafeStringSchema.trim().min(1).max(200).optional(),
  year: z.number().int().min(1000).max(9999).optional(),
  language: z
    .string()
    .trim()
    .min(2)
    .max(35)
    .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
    .optional(),
});

const privateTextResourceTagsSchema = z
  .array(storageSafeStringSchema.trim().min(1).max(40))
  .max(20)
  .superRefine((tags, context) => {
    const normalizedTags = new Set<string>();
    tags.forEach((tag, index) => {
      const normalizedTag = tag.toLocaleLowerCase('en-US');
      if (normalizedTags.has(normalizedTag)) {
        context.addIssue({
          code: 'custom',
          message: 'Tags must be unique, ignoring case.',
          path: [index],
        });
      }
      normalizedTags.add(normalizedTag);
    });
  });

export const privateTextResourceCreateSchema = z.strictObject({
  sourceKind: z.literal('text'),
  title: storageSafeStringSchema.trim().min(1).max(200),
  category: privateTextResourceCategorySchema,
  metadata: privateTextResourceMetadataSchema.default({}),
  tags: privateTextResourceTagsSchema.default([]),
  favorite: z.boolean().default(false),
  text: privateTextResourceTextSchema,
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateTextResourceAppendVersionSchema = z.strictObject({
  expectedCurrentVersionId: resourceUuidSchema,
  text: privateTextResourceTextSchema,
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateTextResourceLifecycleSchema = z.strictObject({
  contentStatus: z.literal('parsed'),
  indexStatus: z.literal('not_indexed'),
});

export const privateTextResourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: resourceUuidSchema,
  sourceKind: z.literal('text'),
  title: storageSafeStringSchema.min(1).max(200),
  category: privateTextResourceCategorySchema,
  metadata: privateTextResourceMetadataSchema,
  tags: privateTextResourceTagsSchema,
  visibility: z.literal('private'),
  favorite: z.boolean(),
  includeForCoach: z.literal(false),
  reviewedState: z.literal('unreviewed'),
  lifecycle: privateTextResourceLifecycleSchema,
  accessRevision: z.number().int().positive(),
  currentVersionId: resourceUuidSchema,
  deletedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const privateTextParagraphLocatorSchema = z
  .strictObject({
    kind: z.literal('paragraph'),
    resourceVersionId: resourceUuidSchema,
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_PARAGRAPHS - 1),
    startOffset: z.number().int().min(0).max(MAX_RESOURCE_TEXT_BYTES),
    endOffset: z.number().int().positive().max(MAX_RESOURCE_TEXT_BYTES),
    offsetUnit: z.literal('utf16_code_unit'),
  })
  .refine((locator) => locator.endOffset > locator.startOffset, {
    message: 'Paragraph endOffset must be greater than startOffset.',
    path: ['endOffset'],
  });

export const privateTextParagraphSchema = z.strictObject({
  locator: privateTextParagraphLocatorSchema,
  text: z.string().min(1).max(8192),
});

export const privateTextResourceVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: resourceUuidSchema,
    resourceId: resourceUuidSchema,
    version: z.number().int().positive(),
    previousVersionId: resourceUuidSchema.nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.strictObject({ kind: z.literal('text'), text: privateTextResourceTextSchema }),
    paragraphs: z.array(privateTextParagraphSchema).min(1).max(MAX_PARAGRAPHS),
    lifecycle: privateTextResourceLifecycleSchema,
    createdAt: instantSchema,
  })
  .superRefine((version, context) => {
    const isInitialVersion = version.version === 1;
    if (isInitialVersion !== (version.previousVersionId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only version 1 may omit previousVersionId.',
        path: ['previousVersionId'],
      });
    }

    let previousEndOffset = 0;
    version.paragraphs.forEach((paragraph, index) => {
      const { locator } = paragraph;
      if (locator.resourceVersionId !== version.id) {
        context.addIssue({
          code: 'custom',
          message: 'Paragraph locator must pin this resource version.',
          path: ['paragraphs', index, 'locator', 'resourceVersionId'],
        });
      }
      if (locator.index !== index) {
        context.addIssue({
          code: 'custom',
          message: 'Paragraph locator indexes must be contiguous.',
          path: ['paragraphs', index, 'locator', 'index'],
        });
      }
      if (locator.startOffset < previousEndOffset) {
        context.addIssue({
          code: 'custom',
          message: 'Paragraph locators must be ordered and non-overlapping.',
          path: ['paragraphs', index, 'locator', 'startOffset'],
        });
      }
      if (version.source.text.slice(locator.startOffset, locator.endOffset) !== paragraph.text) {
        context.addIssue({
          code: 'custom',
          message: 'Paragraph text must match its pinned source range.',
          path: ['paragraphs', index, 'text'],
        });
      }
      previousEndOffset = locator.endOffset;
    });
  });

export const privateTextResourceListQuerySchema = z.strictObject({
  query: storageSafeStringSchema.trim().min(1).max(200).optional(),
  category: privateTextResourceCategorySchema.optional(),
  favorite: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const privateTextResourceListItemSchema = privateTextResourceSchema.extend({
  deletedAt: z.null(),
});

export const privateTextResourceListSchema = z
  .strictObject({
    items: z.array(privateTextResourceListItemSchema).max(100),
    total: z.number().int().min(0),
  })
  .refine((list) => list.total >= list.items.length, 'List total cannot be smaller than items.');

export const privateTextResourceReadQuerySchema = z.strictObject({
  versionId: resourceUuidSchema.optional(),
});

export const privateTextResourceReaderSchema = z.strictObject({
  resourceId: resourceUuidSchema,
  resourceVersionId: resourceUuidSchema,
  title: z.string().min(1).max(200),
  sourceKind: z.literal('text'),
  lifecycle: privateTextResourceLifecycleSchema,
  originalText: privateTextResourceTextSchema,
  paragraphs: z.array(privateTextParagraphSchema).min(1).max(MAX_PARAGRAPHS),
});

const privateTextResourceAvailableReadSchema = z
  .strictObject({
    status: z.literal('available'),
    resource: privateTextResourceSchema.extend({ deletedAt: z.null() }),
    version: privateTextResourceVersionSchema,
    reader: privateTextResourceReaderSchema,
  })
  .superRefine((read, context) => {
    if (
      read.version.resourceId !== read.resource.id ||
      read.reader.resourceId !== read.resource.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Version and reader must belong to the returned resource.',
        path: ['reader', 'resourceId'],
      });
    }
    if (read.reader.resourceVersionId !== read.version.id) {
      context.addIssue({
        code: 'custom',
        message: 'Reader must pin the returned resource version.',
        path: ['reader', 'resourceVersionId'],
      });
    }
    if (
      read.reader.originalText !== read.version.source.text ||
      JSON.stringify(read.reader.paragraphs) !== JSON.stringify(read.version.paragraphs)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Reader content must be derived from the pinned version.',
        path: ['reader'],
      });
    }
  });

const privateTextResourceDeletedReadSchema = z.strictObject({
  status: z.literal('deleted'),
  resourceId: resourceUuidSchema,
  deletedAt: instantSchema,
  accessRevision: z.number().int().positive(),
});

const privateTextResourceUnavailableReadSchema = z.strictObject({
  status: z.literal('unavailable'),
});

export const privateTextResourceReadResultSchema = z.discriminatedUnion('status', [
  privateTextResourceAvailableReadSchema,
  privateTextResourceDeletedReadSchema,
  privateTextResourceUnavailableReadSchema,
]);

export const privateTextResourceSoftDeleteSchema = z.strictObject({
  expectedAccessRevision: z.number().int().positive(),
  expectedCurrentVersionId: resourceUuidSchema,
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateTextResourceDeleteResultSchema = privateTextResourceDeletedReadSchema;

export type PrivateTextResourceCategory = z.infer<typeof privateTextResourceCategorySchema>;
export type PrivateTextResourceCreate = z.infer<typeof privateTextResourceCreateSchema>;
export type PrivateTextResourceAppendVersion = z.infer<
  typeof privateTextResourceAppendVersionSchema
>;
export type PrivateTextResourceLifecycle = z.infer<typeof privateTextResourceLifecycleSchema>;
export type PrivateTextResource = z.infer<typeof privateTextResourceSchema>;
export type PrivateTextParagraphLocator = z.infer<typeof privateTextParagraphLocatorSchema>;
export type PrivateTextParagraph = z.infer<typeof privateTextParagraphSchema>;
export type PrivateTextResourceVersion = z.infer<typeof privateTextResourceVersionSchema>;
export type PrivateTextResourceListQuery = z.infer<typeof privateTextResourceListQuerySchema>;
export type PrivateTextResourceListItem = z.infer<typeof privateTextResourceListItemSchema>;
export type PrivateTextResourceList = z.infer<typeof privateTextResourceListSchema>;
export type PrivateTextResourceReadQuery = z.infer<typeof privateTextResourceReadQuerySchema>;
export type PrivateTextResourceReader = z.infer<typeof privateTextResourceReaderSchema>;
export type PrivateTextResourceReadResult = z.infer<typeof privateTextResourceReadResultSchema>;
export type PrivateTextResourceSoftDelete = z.infer<typeof privateTextResourceSoftDeleteSchema>;
export type PrivateTextResourceDeleteResult = z.infer<typeof privateTextResourceDeleteResultSchema>;
