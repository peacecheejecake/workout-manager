import { z } from 'zod';

import { instantSchema } from './primitives.js';

const KIBIBYTE = 1024;
const MAX_RESOURCE_TEXT_BYTES = 64 * KIBIBYTE;
const MAX_PARAGRAPHS = 1000;
const MAX_URL_LENGTH = 2048;
const MAX_PARSED_RESOURCE_TEXT_BYTES = 64 * KIBIBYTE;

export const PRIVATE_RESOURCE_PDF_MAX_BYTES = 10 * 1024 * KIBIBYTE;
export const PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES = 1024 * KIBIBYTE;

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

function hasUnsupportedUrlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function isAllowedResourceUrl(value: string) {
  try {
    const parsed = new URL(value);
    const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0] ?? '';
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      !authority.includes('@') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
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

export const privateResourceSourceKindSchema = z.enum(['text', 'file', 'url']);

export const privateResourceReviewedStateSchema = z.enum(['unreviewed', 'reviewed']);

export const privateResourceGranteeKindSchema = z.enum(['coach']);

export const privateResourceGranteePrincipalIdSchema = storageSafeStringSchema
  .trim()
  .min(1)
  .max(200);

export const privateUrlResourceInputUrlSchema = z
  .string()
  .min(1)
  .max(MAX_URL_LENGTH)
  .refine(
    (value) => !hasUnsupportedUrlCharacter(value),
    'Resource URL must not contain control characters or unpaired surrogates.',
  )
  .refine(
    isAllowedResourceUrl,
    'Resource URL must be an absolute HTTPS URL without credentials or a fragment.',
  )
  .transform((value) => new URL(value).href)
  .pipe(z.string().max(MAX_URL_LENGTH));

export const privateUrlResourceDisplayUrlSchema = privateUrlResourceInputUrlSchema.transform(
  (value) => {
    const displayUrl = new URL(value);
    displayUrl.search = '';
    return displayUrl.href;
  },
);

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

export const privateFileResourceExtensionSchema = z.enum(['pdf', 'md', 'markdown']);
export const privateFileResourceMediaTypeSchema = z.enum(['application/pdf', 'text/markdown']);

export const privateFileResourceNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .pipe(
    z
      .string()
      .min(1)
      .refine((value) => value.trim() === value, 'File name must not have outer whitespace.')
      .refine((value) => value !== '.' && value !== '..', 'File name must be a basename.')
      .refine(
        (value) => !hasUnsupportedFileNameCharacter(value),
        'File name must be a basename without control characters.',
      )
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 255,
        'File name must not exceed 255 bytes when UTF-8 encoded.',
      ),
  );

export const privateFileResourceDescriptorSchema = z
  .strictObject({
    originalFileName: privateFileResourceNameSchema,
    extension: privateFileResourceExtensionSchema,
    mediaType: privateFileResourceMediaTypeSchema,
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((file, context) => {
    const expectedMediaType = file.extension === 'pdf' ? 'application/pdf' : 'text/markdown';
    if (file.mediaType !== expectedMediaType) {
      context.addIssue({
        code: 'custom',
        message: 'File extension and media type must agree.',
        path: ['mediaType'],
      });
    }

    const expectedSuffix = `.${file.extension}`;
    if (!file.originalFileName.toLocaleLowerCase('en-US').endsWith(expectedSuffix)) {
      context.addIssue({
        code: 'custom',
        message: 'File name extension must agree with extension.',
        path: ['originalFileName'],
      });
    }

    const maxBytes =
      file.extension === 'pdf'
        ? PRIVATE_RESOURCE_PDF_MAX_BYTES
        : PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES;
    if (file.byteSize > maxBytes) {
      context.addIssue({
        code: 'too_big',
        origin: 'number',
        maximum: maxBytes,
        inclusive: true,
        message: `File must not exceed ${maxBytes} bytes.`,
        path: ['byteSize'],
      });
    }
  });

export const privateTextResourceVersionSourceSchema = z.strictObject({
  kind: z.literal('text'),
  text: privateTextResourceTextSchema,
});

export const privateFileResourceVersionSourceSchema = z.strictObject({
  kind: z.literal('file'),
  file: privateFileResourceDescriptorSchema,
});

export const privateUrlResourceVersionSourceSchema = z.strictObject({
  kind: z.literal('url'),
  displayUrl: privateUrlResourceDisplayUrlSchema,
});

export const privateResourceVersionSourceSchema = z.discriminatedUnion('kind', [
  privateTextResourceVersionSourceSchema,
  privateFileResourceVersionSourceSchema,
  privateUrlResourceVersionSourceSchema,
]);

export const privateResourceSourceSchema = privateResourceVersionSourceSchema;

const privateUrlResourceIngestionBaseShape = {
  displayUrl: privateUrlResourceDisplayUrlSchema,
  attempt: z.number().int().min(0).max(5),
  retryAt: instantSchema.nullable(),
  indexStatus: z.literal('not_indexed'),
};

export const privateUrlResourceFetchFailureCodeSchema = z.enum([
  'blocked_scheme',
  'blocked_host',
  'blocked_address',
  'redirect_blocked',
  'redirect_limit',
  'timeout',
  'response_too_large',
  'unsupported_media_type',
  'http_status',
  'network_error',
]);

export const privateUrlResourceParseFailureCodeSchema = z.enum([
  'timeout',
  'input_too_large',
  'malformed',
  'unsupported',
  'no_extractable_text',
  'output_too_large',
  'internal_error',
]);

export const privateUrlResourceFailureSchema = z.discriminatedUnion('stage', [
  z.strictObject({
    stage: z.literal('fetch'),
    code: privateUrlResourceFetchFailureCodeSchema,
    retryable: z.boolean(),
    failedAt: instantSchema,
  }),
  z.strictObject({
    stage: z.literal('parse'),
    code: privateUrlResourceParseFailureCodeSchema,
    retryable: z.boolean(),
    failedAt: instantSchema,
  }),
]);

export const privateUrlResourceIngestionSchema = z.discriminatedUnion('contentStatus', [
  z.strictObject({
    contentStatus: z.literal('queued'),
    ...privateUrlResourceIngestionBaseShape,
  }),
  z.strictObject({
    contentStatus: z.literal('fetching'),
    ...privateUrlResourceIngestionBaseShape,
  }),
  z.strictObject({
    contentStatus: z.literal('parsing'),
    ...privateUrlResourceIngestionBaseShape,
  }),
  z.strictObject({
    contentStatus: z.literal('finalized'),
    ...privateUrlResourceIngestionBaseShape,
    retryAt: z.null(),
  }),
  z.strictObject({
    contentStatus: z.literal('bookmark_only'),
    ...privateUrlResourceIngestionBaseShape,
    retryAt: z.null(),
  }),
  z.strictObject({
    contentStatus: z.literal('failed'),
    ...privateUrlResourceIngestionBaseShape,
    failure: privateUrlResourceFailureSchema,
  }),
  z.strictObject({
    contentStatus: z.literal('cancelled'),
    ...privateUrlResourceIngestionBaseShape,
    retryAt: z.null(),
  }),
]);

export const privateUrlResourceIngestionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ingestionId: resourceUuidSchema,
  operation: z.enum(['create', 'append']),
  resourceId: resourceUuidSchema,
  versionId: resourceUuidSchema,
  lifecycle: privateUrlResourceIngestionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const privateUrlResourceMediaTypeSchema = z.enum([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
]);

export const privateUrlResourceProvenanceSchema = z.strictObject({
  requestedDisplayUrl: privateUrlResourceDisplayUrlSchema,
  finalDisplayUrl: privateUrlResourceDisplayUrlSchema,
  fetchedAt: instantSchema,
  mediaType: privateUrlResourceMediaTypeSchema,
  byteSize: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * KIBIBYTE),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  redirectCount: z.number().int().min(0).max(5),
  parser: z.strictObject({
    name: storageSafeStringSchema.trim().min(1).max(100),
    version: storageSafeStringSchema.trim().min(1).max(100),
  }),
});

const privateParsedResourceLocatorBaseShape = {
  resourceVersionId: resourceUuidSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_PARAGRAPHS - 1),
  startOffset: z.number().int().min(0).max(MAX_PARSED_RESOURCE_TEXT_BYTES),
  endOffset: z.number().int().positive().max(MAX_PARSED_RESOURCE_TEXT_BYTES),
  offsetUnit: z.literal('utf16_code_unit'),
};

const privateParsedResourceHeadingPathSchema = z
  .array(storageSafeStringSchema.trim().min(1).max(200))
  .max(8);

export const privateUrlHtmlBlockLocatorSchema = z
  .strictObject({
    kind: z.literal('html_block'),
    ...privateParsedResourceLocatorBaseShape,
    headingPath: privateParsedResourceHeadingPathSchema,
  })
  .refine((locator) => locator.endOffset > locator.startOffset, {
    message: 'HTML block endOffset must be greater than startOffset.',
    path: ['endOffset'],
  });

export const privateUrlMarkdownParagraphLocatorSchema = z
  .strictObject({
    kind: z.literal('markdown_paragraph'),
    ...privateParsedResourceLocatorBaseShape,
    headingPath: privateParsedResourceHeadingPathSchema,
    paragraphIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_PARAGRAPHS - 1),
  })
  .refine((locator) => locator.endOffset > locator.startOffset, {
    message: 'Markdown paragraph endOffset must be greater than startOffset.',
    path: ['endOffset'],
  });

export const privateUrlPlainParagraphLocatorSchema = z
  .strictObject({
    kind: z.literal('plain_paragraph'),
    ...privateParsedResourceLocatorBaseShape,
    paragraphIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_PARAGRAPHS - 1),
  })
  .refine((locator) => locator.endOffset > locator.startOffset, {
    message: 'Plain paragraph endOffset must be greater than startOffset.',
    path: ['endOffset'],
  });

export const privateUrlParsedLocatorSchema = z.discriminatedUnion('kind', [
  privateUrlHtmlBlockLocatorSchema,
  privateUrlMarkdownParagraphLocatorSchema,
  privateUrlPlainParagraphLocatorSchema,
]);

export const privateUrlParsedFragmentSchema = z.strictObject({
  locator: privateUrlParsedLocatorSchema,
  text: z.string().min(1).max(8192),
});

export const privateUrlParsedSnapshotSchema = z
  .strictObject({
    resourceVersionId: resourceUuidSchema,
    text: z
      .string()
      .refine((value) => value.trim().length > 0, 'Parsed text must not be blank.')
      .refine(
        (value) => !hasUnsupportedStorageCharacter(value),
        'Parsed text must not contain unsupported storage characters.',
      )
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= MAX_PARSED_RESOURCE_TEXT_BYTES,
        'Parsed text must not exceed 64 KiB when UTF-8 encoded.',
      ),
    fragments: z.array(privateUrlParsedFragmentSchema).min(1).max(MAX_PARAGRAPHS),
  })
  .superRefine((snapshot, context) => {
    let previousEndOffset = 0;
    snapshot.fragments.forEach((fragment, index) => {
      const { locator } = fragment;
      if (locator.resourceVersionId !== snapshot.resourceVersionId) {
        context.addIssue({
          code: 'custom',
          message: 'Parsed locator must pin this resource version.',
          path: ['fragments', index, 'locator', 'resourceVersionId'],
        });
      }
      if (locator.index !== index) {
        context.addIssue({
          code: 'custom',
          message: 'Parsed locator indexes must be contiguous.',
          path: ['fragments', index, 'locator', 'index'],
        });
      }
      if (locator.startOffset < previousEndOffset) {
        context.addIssue({
          code: 'custom',
          message: 'Parsed locators must be ordered and non-overlapping.',
          path: ['fragments', index, 'locator', 'startOffset'],
        });
      }
      if (snapshot.text.slice(locator.startOffset, locator.endOffset) !== fragment.text) {
        context.addIssue({
          code: 'custom',
          message: 'Parsed fragment text must match its pinned source range.',
          path: ['fragments', index, 'text'],
        });
      }
      previousEndOffset = locator.endOffset;
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

export const privateFileResourceCreateUploadMetadataSchema = z.strictObject({
  sourceKind: z.literal('file'),
  title: storageSafeStringSchema.trim().min(1).max(200),
  category: privateTextResourceCategorySchema,
  metadata: privateTextResourceMetadataSchema.default({}),
  tags: privateTextResourceTagsSchema.default([]),
  favorite: z.boolean().default(false),
});

export const privateFileResourceCreateSchema = privateFileResourceCreateUploadMetadataSchema.extend(
  {
    file: privateFileResourceDescriptorSchema,
    idempotencyKey: resourceIdempotencyKeySchema,
  },
);

export const privateFileResourceAppendVersionUploadMetadataSchema = z.strictObject({
  expectedCurrentVersionId: resourceUuidSchema,
});

export const privateFileResourceAppendVersionSchema =
  privateFileResourceAppendVersionUploadMetadataSchema.extend({
    file: privateFileResourceDescriptorSchema,
    idempotencyKey: resourceIdempotencyKeySchema,
  });

export const privateUrlResourceCreateSchema = z.strictObject({
  sourceKind: z.literal('url'),
  title: storageSafeStringSchema.trim().min(1).max(200),
  category: privateTextResourceCategorySchema,
  metadata: privateTextResourceMetadataSchema.default({}),
  tags: privateTextResourceTagsSchema.default([]),
  favorite: z.boolean().default(false),
  url: privateUrlResourceInputUrlSchema,
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateUrlResourceAppendVersionSchema = z.strictObject({
  expectedCurrentVersionId: resourceUuidSchema,
  url: privateUrlResourceInputUrlSchema.optional(),
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateResourceCreateSchema = z.discriminatedUnion('sourceKind', [
  privateTextResourceCreateSchema,
  privateFileResourceCreateSchema,
  privateUrlResourceCreateSchema,
]);

export const privateResourceAppendVersionSchema = z.union([
  privateTextResourceAppendVersionSchema,
  privateFileResourceAppendVersionSchema,
  privateUrlResourceAppendVersionSchema,
]);

export const privateTextResourceLifecycleSchema = z.strictObject({
  contentStatus: z.literal('parsed'),
  indexStatus: z.literal('not_indexed'),
});

export const privateFileResourceLifecycleSchema = z.strictObject({
  contentStatus: z.literal('raw_stored'),
  indexStatus: z.literal('not_indexed'),
});

export const privateResourceLifecycleSchema = z.discriminatedUnion('contentStatus', [
  privateTextResourceLifecycleSchema,
  privateFileResourceLifecycleSchema,
  ...privateUrlResourceIngestionSchema.options,
]);

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
  includeForCoach: z.boolean(),
  reviewedState: privateResourceReviewedStateSchema,
  lifecycle: privateTextResourceLifecycleSchema,
  accessRevision: z.number().int().positive(),
  currentVersionId: resourceUuidSchema,
  deletedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const privateFileResourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: resourceUuidSchema,
  sourceKind: z.literal('file'),
  title: storageSafeStringSchema.min(1).max(200),
  category: privateTextResourceCategorySchema,
  metadata: privateTextResourceMetadataSchema,
  tags: privateTextResourceTagsSchema,
  visibility: z.literal('private'),
  favorite: z.boolean(),
  includeForCoach: z.boolean(),
  reviewedState: privateResourceReviewedStateSchema,
  lifecycle: privateFileResourceLifecycleSchema,
  accessRevision: z.number().int().positive(),
  currentVersionId: resourceUuidSchema,
  deletedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const privateUrlResourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: resourceUuidSchema,
  sourceKind: z.literal('url'),
  title: storageSafeStringSchema.min(1).max(200),
  category: privateTextResourceCategorySchema,
  metadata: privateTextResourceMetadataSchema,
  tags: privateTextResourceTagsSchema,
  visibility: z.literal('private'),
  favorite: z.boolean(),
  includeForCoach: z.boolean(),
  reviewedState: privateResourceReviewedStateSchema,
  lifecycle: privateUrlResourceIngestionSchema,
  accessRevision: z.number().int().positive(),
  currentVersionId: resourceUuidSchema,
  deletedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const privateResourceSchema = z.discriminatedUnion('sourceKind', [
  privateTextResourceSchema,
  privateFileResourceSchema,
  privateUrlResourceSchema,
]);

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
    source: privateTextResourceVersionSourceSchema,
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

export const privateFileResourceVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: resourceUuidSchema,
    resourceId: resourceUuidSchema,
    version: z.number().int().positive(),
    previousVersionId: resourceUuidSchema.nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: privateFileResourceVersionSourceSchema,
    lifecycle: privateFileResourceLifecycleSchema,
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
    if (version.contentHash !== version.source.file.sha256) {
      context.addIssue({
        code: 'custom',
        message: 'File version contentHash must match the file descriptor sha256.',
        path: ['contentHash'],
      });
    }
  });

export const privateUrlResourceVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: resourceUuidSchema,
    resourceId: resourceUuidSchema,
    version: z.number().int().positive(),
    previousVersionId: resourceUuidSchema.nullable(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    source: privateUrlResourceVersionSourceSchema,
    lifecycle: privateUrlResourceIngestionSchema,
    provenance: privateUrlResourceProvenanceSchema.optional(),
    parsedSnapshot: privateUrlParsedSnapshotSchema.optional(),
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
    if (version.source.displayUrl !== version.lifecycle.displayUrl) {
      context.addIssue({
        code: 'custom',
        message: 'URL source and ingestion must expose the same display URL.',
        path: ['lifecycle', 'displayUrl'],
      });
    }

    const parseFailed =
      version.lifecycle.contentStatus === 'failed' && version.lifecycle.failure.stage === 'parse';
    const requiresProvenance =
      version.lifecycle.contentStatus === 'parsing' ||
      version.lifecycle.contentStatus === 'finalized' ||
      version.lifecycle.contentStatus === 'bookmark_only' ||
      parseFailed;
    if (requiresProvenance !== (version.provenance !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'URL provenance must exist only after a successful fetch.',
        path: ['provenance'],
      });
    }
    if (version.provenance) {
      if (version.provenance.requestedDisplayUrl !== version.source.displayUrl) {
        context.addIssue({
          code: 'custom',
          message: 'URL provenance must pin the requested display URL.',
          path: ['provenance', 'requestedDisplayUrl'],
        });
      }
      if (version.contentHash !== version.provenance.sha256) {
        context.addIssue({
          code: 'custom',
          message: 'URL contentHash must match captured provenance.',
          path: ['contentHash'],
        });
      }
    } else if (version.contentHash !== null) {
      context.addIssue({
        code: 'custom',
        message: 'URL contentHash requires captured provenance.',
        path: ['contentHash'],
      });
    }

    const isFinalized = version.lifecycle.contentStatus === 'finalized';
    if (isFinalized !== (version.parsedSnapshot !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Parsed snapshot is required only for finalized URL content.',
        path: ['parsedSnapshot'],
      });
    }
    if (version.parsedSnapshot && version.parsedSnapshot.resourceVersionId !== version.id) {
      context.addIssue({
        code: 'custom',
        message: 'Parsed snapshot must pin this URL resource version.',
        path: ['parsedSnapshot', 'resourceVersionId'],
      });
    }
  });

export const privateResourceVersionSchema = z.union([
  privateTextResourceVersionSchema,
  privateFileResourceVersionSchema,
  privateUrlResourceVersionSchema,
]);

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

export const privateFileResourceListItemSchema = privateFileResourceSchema.extend({
  deletedAt: z.null(),
});

export const privateUrlResourceListItemSchema = privateUrlResourceSchema.extend({
  deletedAt: z.null(),
});

export const privateResourceListQuerySchema = privateTextResourceListQuerySchema;

export const privateResourceListItemSchema = z.discriminatedUnion('sourceKind', [
  privateTextResourceListItemSchema,
  privateFileResourceListItemSchema,
  privateUrlResourceListItemSchema,
]);

export const privateResourceListSchema = z
  .strictObject({
    items: z.array(privateResourceListItemSchema).max(100),
    total: z.number().int().min(0),
  })
  .refine((list) => list.total >= list.items.length, 'List total cannot be smaller than items.');

export const privateTextResourceReadQuerySchema = z.strictObject({
  versionId: resourceUuidSchema.optional(),
});

export const privateResourceReadQuerySchema = privateTextResourceReadQuerySchema;

export const privateTextResourceReaderSchema = z.strictObject({
  resourceId: resourceUuidSchema,
  resourceVersionId: resourceUuidSchema,
  title: z.string().min(1).max(200),
  sourceKind: z.literal('text'),
  lifecycle: privateTextResourceLifecycleSchema,
  originalText: privateTextResourceTextSchema,
  paragraphs: z.array(privateTextParagraphSchema).min(1).max(MAX_PARAGRAPHS),
});

export const privateFileResourceReaderSchema = z.strictObject({
  resourceId: resourceUuidSchema,
  resourceVersionId: resourceUuidSchema,
  title: z.string().min(1).max(200),
  sourceKind: z.literal('file'),
  lifecycle: privateFileResourceLifecycleSchema,
  file: privateFileResourceDescriptorSchema,
});

export const privateUrlResourceReaderSchema = z
  .strictObject({
    resourceId: resourceUuidSchema,
    resourceVersionId: resourceUuidSchema,
    title: z.string().min(1).max(200),
    sourceKind: z.literal('url'),
    lifecycle: privateUrlResourceIngestionSchema,
    provenance: privateUrlResourceProvenanceSchema.optional(),
    parsedSnapshot: privateUrlParsedSnapshotSchema.optional(),
  })
  .superRefine((reader, context) => {
    const parseFailed =
      reader.lifecycle.contentStatus === 'failed' && reader.lifecycle.failure.stage === 'parse';
    const requiresProvenance =
      reader.lifecycle.contentStatus === 'parsing' ||
      reader.lifecycle.contentStatus === 'finalized' ||
      reader.lifecycle.contentStatus === 'bookmark_only' ||
      parseFailed;
    if (requiresProvenance !== (reader.provenance !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'URL reader provenance must exist only after a successful fetch.',
        path: ['provenance'],
      });
    }

    const isFinalized = reader.lifecycle.contentStatus === 'finalized';
    if (isFinalized !== (reader.parsedSnapshot !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'URL reader content is available only after finalization.',
        path: ['parsedSnapshot'],
      });
    }
    if (
      reader.parsedSnapshot &&
      reader.parsedSnapshot.resourceVersionId !== reader.resourceVersionId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'URL reader snapshot must pin the reader resource version.',
        path: ['parsedSnapshot', 'resourceVersionId'],
      });
    }
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

const privateFileResourceAvailableReadSchema = z
  .strictObject({
    status: z.literal('available'),
    resource: privateFileResourceSchema.extend({ deletedAt: z.null() }),
    version: privateFileResourceVersionSchema,
    reader: privateFileResourceReaderSchema,
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
    if (JSON.stringify(read.reader.file) !== JSON.stringify(read.version.source.file)) {
      context.addIssue({
        code: 'custom',
        message: 'Reader file must be derived from the pinned version.',
        path: ['reader', 'file'],
      });
    }
  });

const privateUrlResourceAvailableReadSchema = z
  .strictObject({
    status: z.literal('available'),
    resource: privateUrlResourceSchema.extend({ deletedAt: z.null() }),
    version: privateUrlResourceVersionSchema,
    reader: privateUrlResourceReaderSchema,
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
    if (JSON.stringify(read.reader.lifecycle) !== JSON.stringify(read.version.lifecycle)) {
      context.addIssue({
        code: 'custom',
        message: 'URL reader must expose the pinned version ingestion state.',
        path: ['reader', 'lifecycle'],
      });
    }
    if (
      JSON.stringify(read.reader.provenance) !== JSON.stringify(read.version.provenance) ||
      JSON.stringify(read.reader.parsedSnapshot) !== JSON.stringify(read.version.parsedSnapshot)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'URL reader must be derived from the pinned version.',
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

export const privateFileResourceReadResultSchema = z.union([
  privateFileResourceAvailableReadSchema,
  privateTextResourceDeletedReadSchema,
  privateTextResourceUnavailableReadSchema,
]);

export const privateUrlResourceReadResultSchema = z.union([
  privateUrlResourceAvailableReadSchema,
  privateTextResourceDeletedReadSchema,
  privateTextResourceUnavailableReadSchema,
]);

export const privateResourceReadResultSchema = z.union([
  privateTextResourceAvailableReadSchema,
  privateFileResourceAvailableReadSchema,
  privateUrlResourceAvailableReadSchema,
  privateTextResourceDeletedReadSchema,
  privateTextResourceUnavailableReadSchema,
]);

export const privateTextResourceSoftDeleteSchema = z.strictObject({
  expectedAccessRevision: z.number().int().positive(),
  expectedCurrentVersionId: resourceUuidSchema,
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateTextResourceDeleteResultSchema = privateTextResourceDeletedReadSchema;

export const privateResourceSoftDeleteSchema = privateTextResourceSoftDeleteSchema;
export const privateResourceDeleteResultSchema = privateTextResourceDeleteResultSchema;

export const privateResourceShareSchema = z.strictObject({
  schemaVersion: z.literal(1),
  shareId: resourceUuidSchema,
  resourceId: resourceUuidSchema,
  granteeKind: privateResourceGranteeKindSchema,
  granteePrincipalId: privateResourceGranteePrincipalIdSchema,
  state: z.enum(['active', 'revoked']),
  grantedAccessRevision: z.number().int().positive(),
  revokedAccessRevision: z.number().int().positive().nullable(),
  grantedAt: instantSchema,
  revokedAt: instantSchema.nullable(),
});

export const privateResourceShareGrantSchema = z.strictObject({
  granteeKind: privateResourceGranteeKindSchema,
  granteePrincipalId: privateResourceGranteePrincipalIdSchema,
  expectedAccessRevision: z.number().int().positive(),
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateResourceShareRevokeSchema = z.strictObject({
  expectedAccessRevision: z.number().int().positive(),
  idempotencyKey: resourceIdempotencyKeySchema,
});

/** Review curation is explicit and never implied by fetch, parse or upload success. */
export const privateResourceReviewedTransitionSchema = z.strictObject({
  reviewed: z.boolean(),
  expectedAccessRevision: z.number().int().positive(),
  expectedCurrentVersionId: resourceUuidSchema,
  idempotencyKey: resourceIdempotencyKeySchema,
});

/** Coach use is a separate explicit transition with its own preconditions. */
export const privateResourceCoachUseTransitionSchema = z.strictObject({
  includeForCoach: z.boolean(),
  expectedAccessRevision: z.number().int().positive(),
  expectedCurrentVersionId: resourceUuidSchema,
  idempotencyKey: resourceIdempotencyKeySchema,
});

export const privateResourceCleanupTargetsSchema = z.strictObject({
  derivedData: z.literal(true),
  searchIndex: z.literal(true),
  cache: z.literal(true),
  citations: z.literal(true),
});

export const privateResourceCleanupReasonSchema = z.enum([
  'resource_deleted',
  'share_revoked',
  'consent_withdrawn',
  'review_withdrawn',
  'coach_use_withdrawn',
  'account_erased',
]);

export const privateResourceAccessStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resourceId: resourceUuidSchema,
  accessRevision: z.number().int().positive(),
  currentVersionId: resourceUuidSchema,
  reviewedState: privateResourceReviewedStateSchema,
  reviewedAt: instantSchema.nullable(),
  includeForCoach: z.boolean(),
  coachUseEnabledAt: instantSchema.nullable(),
  aiConsentGranted: z.boolean(),
  coachUseAuthorized: z.boolean(),
  pendingCleanup: z.boolean(),
  /** Every active grant, so no grant can become unrevocable through history. */
  shares: z.array(privateResourceShareSchema).max(20),
  /** Bounded page of revoked grants, newest first. */
  revokedShares: z.array(privateResourceShareSchema).max(50),
  revokedShareHistoryTruncated: z.boolean(),
});

/** Access facts the coaching evidence manifest pins and re-checks at use time. */
export const privateResourceCoachUseManifestEntrySchema = z.strictObject({
  resourceId: resourceUuidSchema,
  accessRevision: z.number().int().positive(),
  currentVersionId: resourceUuidSchema,
});

/**
 * Digest of the whole authorized set, the consent head it was captured under
 * and the tenant it belongs to. Use-time revalidation compares this, not only
 * the pinned entries, so a resource that became coach-eligible after capture
 * cannot stay invisible and another tenant's manifest cannot validate here.
 */
export const privateResourceCoachUseSetDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const MAX_COACH_USE_MANIFEST_ENTRIES = 100;

/**
 * The manifest is always complete for the tenant it pins. A capture that would
 * exceed the bound fails instead of returning a truncated dependency snapshot.
 */
export const privateResourceCoachUseManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal('resource-access-v1'),
    /** The tenant this dependency set belongs to; never a client-supplied id. */
    athleteId: z.string().min(1).max(200),
    capturedAt: instantSchema,
    aiConsentRevision: z.number().int().nonnegative(),
    aiConsentGranted: z.boolean(),
    complete: z.literal(true),
    entriesDigest: privateResourceCoachUseSetDigestSchema,
    entries: z
      .array(privateResourceCoachUseManifestEntrySchema)
      .max(MAX_COACH_USE_MANIFEST_ENTRIES),
  })
  .superRefine((manifest, context) => {
    // A resource may be pinned once. A duplicate would make the set identity
    // ambiguous and could hide a second, different revision for the same id.
    const seen = new Set<string>();
    manifest.entries.forEach((entry, index) => {
      if (seen.has(entry.resourceId)) {
        context.addIssue({
          code: 'custom',
          message: 'Manifest entries must pin each resource at most once.',
          path: ['entries', index, 'resourceId'],
        });
      }
      seen.add(entry.resourceId);
    });
  });

export const privateResourceCoachUseCheckSchema = z.strictObject({
  resourceId: resourceUuidSchema,
  /** `added` is a resource authorized after capture and therefore not pinned. */
  status: z.enum(['authorized', 'revision_changed', 'blocked', 'added']),
});

export const privateResourceCoachUseRevalidationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkedAt: instantSchema,
  stale: z.boolean(),
  capturedEntriesDigest: privateResourceCoachUseSetDigestSchema,
  currentEntriesDigest: privateResourceCoachUseSetDigestSchema,
  results: z.array(privateResourceCoachUseCheckSchema).max(2 * MAX_COACH_USE_MANIFEST_ENTRIES),
});

export const privateSharedResourceSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  ownerPrincipalId: privateResourceGranteePrincipalIdSchema,
  resourceId: resourceUuidSchema,
  shareId: resourceUuidSchema,
  sourceKind: privateResourceSourceKindSchema,
  title: storageSafeStringSchema.min(1).max(200),
  category: privateTextResourceCategorySchema,
  reviewedState: privateResourceReviewedStateSchema,
  currentVersionId: resourceUuidSchema,
  sharedAt: instantSchema,
  updatedAt: instantSchema,
});

export const MAX_SHARED_RESOURCE_LIST_OFFSET = 10_000;

/**
 * Offset pagination over the grants held by one principal. The reachable range
 * is bounded: `offset` may not exceed {@link MAX_SHARED_RESOURCE_LIST_OFFSET},
 * so at most that many grants plus one page can be walked. `total` still
 * reports the real count, so a principal past the bound can see that more
 * grants exist even though this endpoint cannot page to them; the per-resource
 * access state, which returns every active grant, remains the complete view an
 * owner revokes from.
 */
export const privateSharedResourceListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_SHARED_RESOURCE_LIST_OFFSET).default(0),
});

export const privateSharedResourceListSchema = z
  .strictObject({
    items: z.array(privateSharedResourceSummarySchema).max(100),
    /** Real count of live grants for this principal, not the page length. */
    total: z.number().int().min(0),
    hasMore: z.boolean(),
  })
  .refine((list) => list.total >= list.items.length, 'List total cannot be smaller than items.');

export const privateSharedResourceReadSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    summary: privateSharedResourceSummarySchema,
    reader: z.discriminatedUnion('sourceKind', [
      z.strictObject({
        sourceKind: z.literal('text'),
        originalText: privateTextResourceTextSchema,
      }),
      z.strictObject({ sourceKind: z.literal('file'), file: privateFileResourceDescriptorSchema }),
      z.strictObject({
        sourceKind: z.literal('url'),
        displayUrl: privateUrlResourceDisplayUrlSchema,
        parsedText: z.string().nullable(),
      }),
    ]),
  }),
  z.strictObject({ status: z.literal('unavailable') }),
]);

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
export type PrivateResourceSourceKind = z.infer<typeof privateResourceSourceKindSchema>;
export type PrivateFileResourceExtension = z.infer<typeof privateFileResourceExtensionSchema>;
export type PrivateFileResourceMediaType = z.infer<typeof privateFileResourceMediaTypeSchema>;
export type PrivateFileResourceDescriptor = z.infer<typeof privateFileResourceDescriptorSchema>;
export type PrivateTextResourceVersionSource = z.infer<
  typeof privateTextResourceVersionSourceSchema
>;
export type PrivateFileResourceVersionSource = z.infer<
  typeof privateFileResourceVersionSourceSchema
>;
export type PrivateResourceVersionSource = z.infer<typeof privateResourceVersionSourceSchema>;
export type PrivateResourceSource = z.infer<typeof privateResourceSourceSchema>;
export type PrivateUrlResourceVersionSource = z.infer<typeof privateUrlResourceVersionSourceSchema>;
export type PrivateUrlResourceFailure = z.infer<typeof privateUrlResourceFailureSchema>;
export type PrivateUrlResourceIngestion = z.infer<typeof privateUrlResourceIngestionSchema>;
export type PrivateUrlResourceIngestionRecord = z.infer<
  typeof privateUrlResourceIngestionRecordSchema
>;
export type PrivateUrlResourceProvenance = z.infer<typeof privateUrlResourceProvenanceSchema>;
export type PrivateUrlParsedLocator = z.infer<typeof privateUrlParsedLocatorSchema>;
export type PrivateUrlParsedFragment = z.infer<typeof privateUrlParsedFragmentSchema>;
export type PrivateUrlParsedSnapshot = z.infer<typeof privateUrlParsedSnapshotSchema>;
export type PrivateFileResourceCreateUploadMetadata = z.infer<
  typeof privateFileResourceCreateUploadMetadataSchema
>;
export type PrivateFileResourceCreate = z.infer<typeof privateFileResourceCreateSchema>;
export type PrivateFileResourceAppendVersionUploadMetadata = z.infer<
  typeof privateFileResourceAppendVersionUploadMetadataSchema
>;
export type PrivateFileResourceAppendVersion = z.infer<
  typeof privateFileResourceAppendVersionSchema
>;
export type PrivateUrlResourceCreate = z.infer<typeof privateUrlResourceCreateSchema>;
export type PrivateUrlResourceAppendVersion = z.infer<typeof privateUrlResourceAppendVersionSchema>;
export type PrivateResourceCreate = z.infer<typeof privateResourceCreateSchema>;
export type PrivateResourceAppendVersion = z.infer<typeof privateResourceAppendVersionSchema>;
export type PrivateFileResourceLifecycle = z.infer<typeof privateFileResourceLifecycleSchema>;
export type PrivateResourceLifecycle = z.infer<typeof privateResourceLifecycleSchema>;
export type PrivateFileResource = z.infer<typeof privateFileResourceSchema>;
export type PrivateUrlResource = z.infer<typeof privateUrlResourceSchema>;
export type PrivateResource = z.infer<typeof privateResourceSchema>;
export type PrivateFileResourceVersion = z.infer<typeof privateFileResourceVersionSchema>;
export type PrivateUrlResourceVersion = z.infer<typeof privateUrlResourceVersionSchema>;
export type PrivateResourceVersion = z.infer<typeof privateResourceVersionSchema>;
export type PrivateFileResourceListItem = z.infer<typeof privateFileResourceListItemSchema>;
export type PrivateUrlResourceListItem = z.infer<typeof privateUrlResourceListItemSchema>;
export type PrivateResourceListQuery = z.infer<typeof privateResourceListQuerySchema>;
export type PrivateResourceListItem = z.infer<typeof privateResourceListItemSchema>;
export type PrivateResourceList = z.infer<typeof privateResourceListSchema>;
export type PrivateResourceReadQuery = z.infer<typeof privateResourceReadQuerySchema>;
export type PrivateFileResourceReader = z.infer<typeof privateFileResourceReaderSchema>;
export type PrivateUrlResourceReader = z.infer<typeof privateUrlResourceReaderSchema>;
export type PrivateFileResourceReadResult = z.infer<typeof privateFileResourceReadResultSchema>;
export type PrivateUrlResourceReadResult = z.infer<typeof privateUrlResourceReadResultSchema>;
export type PrivateResourceReadResult = z.infer<typeof privateResourceReadResultSchema>;
export type PrivateResourceSoftDelete = z.infer<typeof privateResourceSoftDeleteSchema>;
export type PrivateResourceDeleteResult = z.infer<typeof privateResourceDeleteResultSchema>;
export type PrivateResourceReviewedState = z.infer<typeof privateResourceReviewedStateSchema>;
export type PrivateResourceGranteeKind = z.infer<typeof privateResourceGranteeKindSchema>;
export type PrivateResourceShare = z.infer<typeof privateResourceShareSchema>;
export type PrivateResourceShareGrant = z.infer<typeof privateResourceShareGrantSchema>;
export type PrivateResourceShareRevoke = z.infer<typeof privateResourceShareRevokeSchema>;
export type PrivateResourceReviewedTransition = z.infer<
  typeof privateResourceReviewedTransitionSchema
>;
export type PrivateResourceCoachUseTransition = z.infer<
  typeof privateResourceCoachUseTransitionSchema
>;
export type PrivateResourceCleanupTargets = z.infer<typeof privateResourceCleanupTargetsSchema>;
export type PrivateResourceCleanupReason = z.infer<typeof privateResourceCleanupReasonSchema>;
export type PrivateResourceAccessState = z.infer<typeof privateResourceAccessStateSchema>;
export type PrivateResourceCoachUseManifest = z.infer<typeof privateResourceCoachUseManifestSchema>;
export type PrivateResourceCoachUseRevalidation = z.infer<
  typeof privateResourceCoachUseRevalidationSchema
>;
export type PrivateSharedResourceSummary = z.infer<typeof privateSharedResourceSummarySchema>;
export type PrivateSharedResourceListQuery = z.infer<typeof privateSharedResourceListQuerySchema>;
export type PrivateSharedResourceList = z.infer<typeof privateSharedResourceListSchema>;
export type PrivateSharedResourceRead = z.infer<typeof privateSharedResourceReadSchema>;
