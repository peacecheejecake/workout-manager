import { describe, expect, it } from 'vitest';

import {
  PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES,
  PRIVATE_RESOURCE_PDF_MAX_BYTES,
  privateFileResourceAppendVersionSchema,
  privateFileResourceAppendVersionUploadMetadataSchema,
  privateFileResourceCreateSchema,
  privateFileResourceCreateUploadMetadataSchema,
  privateFileResourceDescriptorSchema,
  privateFileResourceVersionSchema,
  privateResourceListSchema,
  privateResourceReadResultSchema,
  privateResourceSchema,
  privateResourceVersionSourceSchema,
  privateTextResourceAppendVersionSchema,
  privateTextResourceCreateSchema,
  privateTextResourceDeleteResultSchema,
  privateTextResourceListQuerySchema,
  privateTextResourceListSchema,
  privateTextResourceReadQuerySchema,
  privateTextResourceReadResultSchema,
  privateTextResourceSoftDeleteSchema,
  privateTextResourceTextSchema,
  privateTextResourceVersionSchema,
  privateUrlParsedSnapshotSchema,
  privateUrlResourceAppendVersionSchema,
  privateUrlResourceCreateSchema,
  privateUrlResourceDisplayUrlSchema,
  privateUrlResourceIngestionRecordSchema,
  privateUrlResourceIngestionSchema,
  privateUrlResourceProvenanceSchema,
  privateUrlResourceReaderSchema,
  privateUrlResourceReadResultSchema,
  privateUrlResourceVersionSchema,
} from '../src/resources.js';

const resourceId = '11111111-1111-4111-8111-111111111111';
const versionOneId = '22222222-2222-4222-8222-222222222222';
const versionTwoId = '33333333-3333-4333-8333-333333333333';
const ingestionId = '44444444-4444-4444-8444-444444444444';
const createdAt = '2026-09-19T00:00:00.000Z';
const updatedAt = '2026-09-19T00:01:00.000Z';
const text = 'First.\n\nSecond.';

const lifecycle = { contentStatus: 'parsed', indexStatus: 'not_indexed' } as const;
const fileLifecycle = { contentStatus: 'raw_stored', indexStatus: 'not_indexed' } as const;
const pdfSha256 = 'b'.repeat(64);
const pdfFile = {
  originalFileName: '레이스 전략.pdf',
  extension: 'pdf',
  mediaType: 'application/pdf',
  byteSize: 2048,
  sha256: pdfSha256,
} as const;

const paragraphs = [
  {
    locator: {
      kind: 'paragraph',
      resourceVersionId: versionOneId,
      index: 0,
      startOffset: 0,
      endOffset: 6,
      offsetUnit: 'utf16_code_unit',
    },
    text: 'First.',
  },
  {
    locator: {
      kind: 'paragraph',
      resourceVersionId: versionOneId,
      index: 1,
      startOffset: 8,
      endOffset: 15,
      offsetUnit: 'utf16_code_unit',
    },
    text: 'Second.',
  },
] as const;

const resource = {
  schemaVersion: 1,
  id: resourceId,
  sourceKind: 'text',
  title: 'Race fueling notes',
  category: 'race_material',
  metadata: { author: 'Coach Kim', year: 2026, language: 'ko-KR' },
  tags: ['race', 'nutrition'],
  visibility: 'private',
  favorite: true,
  includeForCoach: false,
  reviewedState: 'unreviewed',
  lifecycle,
  accessRevision: 1,
  currentVersionId: versionTwoId,
  deletedAt: null,
  createdAt,
  updatedAt,
} as const;

const version = {
  schemaVersion: 1,
  id: versionOneId,
  resourceId,
  version: 1,
  previousVersionId: null,
  contentHash: 'a'.repeat(64),
  source: { kind: 'text', text },
  paragraphs,
  lifecycle,
  createdAt,
} as const;

const reader = {
  resourceId,
  resourceVersionId: versionOneId,
  title: resource.title,
  sourceKind: 'text',
  lifecycle,
  originalText: text,
  paragraphs,
} as const;

const fileResource = {
  ...resource,
  sourceKind: 'file',
  lifecycle: fileLifecycle,
} as const;

const fileVersion = {
  schemaVersion: 1,
  id: versionOneId,
  resourceId,
  version: 1,
  previousVersionId: null,
  contentHash: pdfSha256,
  source: { kind: 'file', file: pdfFile },
  lifecycle: fileLifecycle,
  createdAt,
} as const;

const fileReader = {
  resourceId,
  resourceVersionId: versionOneId,
  title: resource.title,
  sourceKind: 'file',
  lifecycle: fileLifecycle,
  file: pdfFile,
} as const;

const urlDisplayUrl = 'https://example.com/training/article';
const urlContentHash = 'c'.repeat(64);
const urlLifecycle = {
  contentStatus: 'finalized',
  displayUrl: urlDisplayUrl,
  attempt: 1,
  retryAt: null,
  indexStatus: 'not_indexed',
} as const;
const urlProvenance = {
  requestedDisplayUrl: urlDisplayUrl,
  finalDisplayUrl: 'https://www.example.com/training/article',
  fetchedAt: createdAt,
  mediaType: 'text/html',
  byteSize: 4096,
  sha256: urlContentHash,
  redirectCount: 1,
  parser: { name: 'isolated-html', version: '1.0.0' },
} as const;
const firstParsedFragment = 'Training guide';
const secondParsedFragment = 'Build gradually.';
const parsedText = `${firstParsedFragment}\n\n${secondParsedFragment}`;
const secondParsedStart = parsedText.indexOf(secondParsedFragment);
const urlParsedSnapshot = {
  resourceVersionId: versionOneId,
  text: parsedText,
  fragments: [
    {
      locator: {
        kind: 'html_block',
        resourceVersionId: versionOneId,
        index: 0,
        startOffset: 0,
        endOffset: firstParsedFragment.length,
        offsetUnit: 'utf16_code_unit',
        headingPath: [],
      },
      text: firstParsedFragment,
    },
    {
      locator: {
        kind: 'markdown_paragraph',
        resourceVersionId: versionOneId,
        index: 1,
        startOffset: secondParsedStart,
        endOffset: secondParsedStart + secondParsedFragment.length,
        offsetUnit: 'utf16_code_unit',
        headingPath: ['Training'],
        paragraphIndex: 0,
      },
      text: secondParsedFragment,
    },
  ],
} as const;
const urlResource = {
  ...resource,
  sourceKind: 'url',
  lifecycle: urlLifecycle,
  currentVersionId: versionOneId,
} as const;
const urlVersion = {
  schemaVersion: 1,
  id: versionOneId,
  resourceId,
  version: 1,
  previousVersionId: null,
  contentHash: urlContentHash,
  source: { kind: 'url', displayUrl: urlDisplayUrl },
  lifecycle: urlLifecycle,
  provenance: urlProvenance,
  parsedSnapshot: urlParsedSnapshot,
  createdAt,
} as const;
const urlReader = {
  resourceId,
  resourceVersionId: versionOneId,
  title: resource.title,
  sourceKind: 'url',
  lifecycle: urlLifecycle,
  provenance: urlProvenance,
  parsedSnapshot: urlParsedSnapshot,
} as const;

describe('private text resource contracts', () => {
  it('parses valid create, append, delete, list, and read fixtures', () => {
    expect(
      privateTextResourceCreateSchema.parse({
        sourceKind: 'text',
        title: resource.title,
        category: resource.category,
        text,
        idempotencyKey: 'resource:create:1',
      }),
    ).toMatchObject({ metadata: {}, tags: [], favorite: false });

    expect(
      privateTextResourceAppendVersionSchema.parse({
        expectedCurrentVersionId: versionOneId,
        text: 'Updated source text.',
        idempotencyKey: 'resource:append:1',
      }).expectedCurrentVersionId,
    ).toBe(versionOneId);

    expect(
      privateTextResourceSoftDeleteSchema.parse({
        expectedAccessRevision: 1,
        expectedCurrentVersionId: versionTwoId,
        idempotencyKey: 'resource:delete:1',
      }).expectedAccessRevision,
    ).toBe(1);

    expect(privateTextResourceListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(privateTextResourceListQuerySchema.parse({ favorite: 'false' }).favorite).toBe(false);
    expect(
      privateTextResourceListQuerySchema.safeParse({
        query: `unsafe${String.fromCharCode(0)}query`,
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceListQuerySchema.safeParse({
        query: `unsafe${String.fromCharCode(0xd800)}query`,
      }).success,
    ).toBe(false);
    expect(privateTextResourceReadQuerySchema.parse({ versionId: versionOneId })).toEqual({
      versionId: versionOneId,
    });
    expect(
      privateTextResourceListSchema.parse({ items: [resource], total: 1 }).items[0]?.visibility,
    ).toBe('private');

    const available = privateTextResourceReadResultSchema.parse({
      status: 'available',
      resource,
      version,
      reader,
    });
    expect(available.status).toBe('available');
    if (available.status === 'available') {
      expect(available.reader.resourceVersionId).toBe(versionOneId);
      expect(available.resource.currentVersionId).toBe(versionTwoId);
    }

    expect(privateTextResourceReadResultSchema.parse({ status: 'unavailable' })).toEqual({
      status: 'unavailable',
    });
    expect(
      privateTextResourceDeleteResultSchema.parse({
        status: 'deleted',
        resourceId,
        deletedAt: updatedAt,
        accessRevision: 2,
      }).status,
    ).toBe('deleted');
  });

  it.each(['ownerId', 'visibility', 'accessRevision', 'status', 'includeForCoach'])(
    'rejects client-owned %s on create',
    (field) => {
      expect(
        privateTextResourceCreateSchema.safeParse({
          sourceKind: 'text',
          title: 'Private note',
          category: 'note',
          text: 'Content',
          idempotencyKey: 'resource:create:2',
          [field]: field === 'accessRevision' ? 1 : 'client-value',
        }).success,
      ).toBe(false);
    },
  );

  it('enforces UTF-8 byte size, nonblank text, bounded unique tags, and source kind', () => {
    expect(privateTextResourceTextSchema.safeParse('a'.repeat(65_536)).success).toBe(true);
    expect(privateTextResourceTextSchema.safeParse('a'.repeat(65_537)).success).toBe(false);
    expect(privateTextResourceTextSchema.safeParse('한'.repeat(21_846)).success).toBe(false);
    expect(privateTextResourceTextSchema.safeParse('   \n').success).toBe(false);
    expect(privateTextResourceTextSchema.safeParse('before\u0000after').success).toBe(false);
    expect(privateTextResourceTextSchema.safeParse('before\u0001after').success).toBe(false);
    expect(
      privateTextResourceTextSchema.safeParse(`before${String.fromCharCode(0xd800)}after`).success,
    ).toBe(false);
    expect(
      privateTextResourceTextSchema.safeParse('tabs\tand\nnewlines\rare allowed').success,
    ).toBe(true);

    const base = {
      sourceKind: 'text',
      title: 'Private note',
      category: 'note',
      text: 'Content',
      idempotencyKey: 'resource:create:3',
    };
    for (const unsafe of ['before\u0000after', `before${String.fromCharCode(0xd800)}after`]) {
      expect(privateTextResourceCreateSchema.safeParse({ ...base, title: unsafe }).success).toBe(
        false,
      );
      expect(
        privateTextResourceCreateSchema.safeParse({
          ...base,
          metadata: { author: unsafe },
        }).success,
      ).toBe(false);
      expect(privateTextResourceCreateSchema.safeParse({ ...base, tags: [unsafe] }).success).toBe(
        false,
      );
    }
    expect(
      privateTextResourceCreateSchema.safeParse({ ...base, tags: ['Race', 'race'] }).success,
    ).toBe(false);
    expect(
      privateTextResourceCreateSchema.safeParse({
        ...base,
        tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
      }).success,
    ).toBe(false);
    expect(privateTextResourceCreateSchema.safeParse({ ...base, sourceKind: 'url' }).success).toBe(
      false,
    );
  });

  it('enforces version lineage and immutable paragraph locators', () => {
    expect(privateTextResourceVersionSchema.parse(version)).toEqual(version);

    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        previousVersionId: versionTwoId,
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        version: 2,
        previousVersionId: null,
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        paragraphs: [
          paragraphs[0],
          {
            ...paragraphs[1],
            locator: { ...paragraphs[1].locator, resourceVersionId: versionTwoId },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        paragraphs: [
          paragraphs[0],
          { ...paragraphs[1], locator: { ...paragraphs[1].locator, index: 2 } },
        ],
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        paragraphs: [
          paragraphs[0],
          {
            ...paragraphs[1],
            locator: { ...paragraphs[1].locator, startOffset: 5 },
            text: '.\n\nSecond.',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        paragraphs: [{ ...paragraphs[0], text: 'Changed' }, paragraphs[1]],
      }).success,
    ).toBe(false);
  });

  it('bounds paragraph count and length', () => {
    const manyParagraphs = Array.from({ length: 1001 }, (_, index) => ({
      locator: {
        kind: 'paragraph',
        resourceVersionId: versionOneId,
        index,
        startOffset: index,
        endOffset: index + 1,
        offsetUnit: 'utf16_code_unit',
      },
      text: 'a',
    }));
    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        source: { kind: 'text', text: 'a'.repeat(1001) },
        paragraphs: manyParagraphs,
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceVersionSchema.safeParse({
        ...version,
        source: { kind: 'text', text: 'a'.repeat(8193) },
        paragraphs: [
          {
            locator: {
              ...paragraphs[0].locator,
              startOffset: 0,
              endOffset: 8193,
            },
            text: 'a'.repeat(8193),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a reader that is not an exact view of the pinned version', () => {
    const available = { status: 'available', resource, version, reader } as const;
    expect(
      privateTextResourceReadResultSchema.safeParse({
        ...available,
        reader: { ...reader, resourceVersionId: versionTwoId },
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceReadResultSchema.safeParse({
        ...available,
        reader: { ...reader, originalText: 'Different text.' },
      }).success,
    ).toBe(false);
    expect(
      privateTextResourceReadResultSchema.safeParse({
        ...available,
        reader: { ...reader, paragraphs: [paragraphs[0]] },
      }).success,
    ).toBe(false);
  });

  it('keeps deleted reads distinct and strict', () => {
    expect(
      privateTextResourceReadResultSchema.parse({
        status: 'deleted',
        resourceId,
        deletedAt: updatedAt,
        accessRevision: 2,
      }),
    ).toEqual({ status: 'deleted', resourceId, deletedAt: updatedAt, accessRevision: 2 });
    expect(
      privateTextResourceReadResultSchema.safeParse({
        status: 'deleted',
        resourceId,
        deletedAt: updatedAt,
        accessRevision: 2,
        version,
      }).success,
    ).toBe(false);
  });
});

describe('private file resource contracts', () => {
  it('parses bounded PDF and Markdown descriptors without exposing storage internals', () => {
    expect(privateFileResourceDescriptorSchema.parse(pdfFile)).toEqual(pdfFile);
    expect(
      privateFileResourceDescriptorSchema.parse({
        originalFileName: 'Cafe\u0301.md',
        extension: 'md',
        mediaType: 'text/markdown',
        byteSize: PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES,
        sha256: 'c'.repeat(64),
      }).originalFileName,
    ).toBe('Café.md');
    expect(
      privateFileResourceDescriptorSchema.safeParse({ ...pdfFile, storageKey: 'tenant/raw/key' })
        .success,
    ).toBe(false);
    expect(
      privateFileResourceDescriptorSchema.safeParse({
        ...pdfFile,
        byteSize: PRIVATE_RESOURCE_PDF_MAX_BYTES,
      }).success,
    ).toBe(true);
  });

  it.each([
    { originalFileName: '../race.pdf' },
    { originalFileName: ' race.pdf' },
    { originalFileName: 'race.pdf ' },
    { originalFileName: 'folder/race.pdf' },
    { originalFileName: 'folder\\race.pdf' },
    { originalFileName: 'race\u0000.pdf' },
    { originalFileName: `race${String.fromCharCode(0x85)}.pdf` },
    { originalFileName: `race${String.fromCharCode(0xd800)}.pdf` },
    { originalFileName: `${'a'.repeat(252)}.pdf` },
    { originalFileName: 'race.md' },
    { mediaType: 'text/markdown' },
    { byteSize: PRIVATE_RESOURCE_PDF_MAX_BYTES + 1 },
    { byteSize: 0 },
    { sha256: 'A'.repeat(64) },
  ])('rejects unsafe or inconsistent PDF descriptor %#', (override) => {
    expect(privateFileResourceDescriptorSchema.safeParse({ ...pdfFile, ...override }).success).toBe(
      false,
    );
  });

  it('enforces the Markdown size limit for both supported extensions', () => {
    for (const extension of ['md', 'markdown'] as const) {
      const originalFileName = `notes.${extension}`;
      expect(
        privateFileResourceDescriptorSchema.safeParse({
          ...pdfFile,
          originalFileName,
          extension,
          mediaType: 'text/markdown',
          byteSize: PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES,
        }).success,
      ).toBe(true);
      expect(
        privateFileResourceDescriptorSchema.safeParse({
          ...pdfFile,
          originalFileName,
          extension,
          mediaType: 'text/markdown',
          byteSize: PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES + 1,
        }).success,
      ).toBe(false);
    }
  });

  it('keeps upload metadata separate so idempotency can come only from a header', () => {
    const createMetadata = {
      sourceKind: 'file',
      title: 'Private PDF',
      category: 'paper',
    } as const;
    expect(privateFileResourceCreateUploadMetadataSchema.parse(createMetadata)).toMatchObject({
      metadata: {},
      tags: [],
      favorite: false,
    });
    expect(
      privateFileResourceCreateUploadMetadataSchema.safeParse({
        ...createMetadata,
        idempotencyKey: 'resource:file:create:1',
      }).success,
    ).toBe(false);
    expect(
      privateFileResourceCreateSchema.parse({
        ...createMetadata,
        file: pdfFile,
        idempotencyKey: 'resource:file:create:1',
      }).file.sha256,
    ).toBe(pdfSha256);

    expect(
      privateFileResourceAppendVersionUploadMetadataSchema.parse({
        expectedCurrentVersionId: versionOneId,
      }),
    ).toEqual({ expectedCurrentVersionId: versionOneId });
    expect(
      privateFileResourceAppendVersionUploadMetadataSchema.safeParse({
        expectedCurrentVersionId: versionOneId,
        idempotencyKey: 'resource:file:append:1',
      }).success,
    ).toBe(false);
    expect(
      privateFileResourceAppendVersionSchema.parse({
        expectedCurrentVersionId: versionOneId,
        file: pdfFile,
        idempotencyKey: 'resource:file:append:1',
      }).file.originalFileName,
    ).toBe(pdfFile.originalFileName);
  });

  it('parses file source, resource, version, list, and pinned read through common schemas', () => {
    expect(privateResourceVersionSourceSchema.parse(fileVersion.source)).toEqual(
      fileVersion.source,
    );
    expect(privateResourceSchema.parse(fileResource).sourceKind).toBe('file');
    expect(privateFileResourceVersionSchema.parse(fileVersion)).toEqual(fileVersion);
    expect(
      privateResourceListSchema.parse({ items: [resource, fileResource], total: 2 }).total,
    ).toBe(2);

    const read = privateResourceReadResultSchema.parse({
      status: 'available',
      resource: fileResource,
      version: fileVersion,
      reader: fileReader,
    });
    expect(read.status).toBe('available');
    if (read.status === 'available' && read.resource.sourceKind === 'file') {
      expect(read.reader.sourceKind).toBe('file');
    }
  });

  it('rejects parsed text fields, page locators, mismatched hashes, and reader drift for raw files', () => {
    expect(
      privateFileResourceVersionSchema.safeParse({ ...fileVersion, paragraphs: [] }).success,
    ).toBe(false);
    expect(
      privateFileResourceVersionSchema.safeParse({
        ...fileVersion,
        source: { ...fileVersion.source, originalText: 'not parsed' },
      }).success,
    ).toBe(false);
    expect(
      privateFileResourceVersionSchema.safeParse({
        ...fileVersion,
        contentHash: 'd'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      privateResourceReadResultSchema.safeParse({
        status: 'available',
        resource: fileResource,
        version: fileVersion,
        reader: { ...fileReader, pageLocator: { page: 1 } },
      }).success,
    ).toBe(false);
    expect(
      privateResourceReadResultSchema.safeParse({
        status: 'available',
        resource: fileResource,
        version: fileVersion,
        reader: { ...fileReader, file: { ...pdfFile, byteSize: 4096 } },
      }).success,
    ).toBe(false);
  });

  it('preserves legacy text-only schemas and common-schema compatibility', () => {
    expect(privateTextResourceVersionSchema.parse(version)).toEqual(version);
    expect(privateResourceVersionSourceSchema.parse(version.source)).toEqual(version.source);
    expect(privateResourceSchema.parse(resource)).toEqual(resource);
    expect(
      privateResourceReadResultSchema.parse({ status: 'available', resource, version, reader }),
    ).toEqual({ status: 'available', resource, version, reader });
  });
});

describe('private URL resource contracts', () => {
  it('accepts HTTPS create and refresh inputs while keeping SSRF checks server-side', () => {
    const created = privateUrlResourceCreateSchema.parse({
      sourceKind: 'url',
      title: 'Training article',
      category: 'guide',
      url: 'https://example.com/training/article?token=private',
      idempotencyKey: 'resource:url:create:1',
    });
    expect(created).toMatchObject({ metadata: {}, tags: [], favorite: false });
    expect(created.url).toBe('https://example.com/training/article?token=private');
    expect(
      privateUrlResourceDisplayUrlSchema.parse(
        'https://example.com/training/article?token=private',
      ),
    ).toBe(urlDisplayUrl);

    expect(
      privateUrlResourceAppendVersionSchema.parse({
        expectedCurrentVersionId: versionOneId,
        idempotencyKey: 'resource:url:refresh:1',
      }),
    ).toEqual({
      expectedCurrentVersionId: versionOneId,
      idempotencyKey: 'resource:url:refresh:1',
    });
    expect(
      privateUrlResourceAppendVersionSchema.parse({
        expectedCurrentVersionId: versionOneId,
        url: 'https://example.com/new-location',
        idempotencyKey: 'resource:url:refresh:2',
      }).url,
    ).toBe('https://example.com/new-location');

    // URL syntax validation is not an SSRF decision. The server fetch policy
    // must resolve and reject private targets before every request and redirect.
    expect(
      privateUrlResourceCreateSchema.safeParse({
        sourceKind: 'url',
        title: 'Private target syntax',
        category: 'note',
        url: 'https://127.0.0.1/private',
        idempotencyKey: 'resource:url:create:2',
      }).success,
    ).toBe(true);
  });

  it.each([
    'http://example.com/article',
    'ftp://example.com/article',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '/relative/article',
    'https://user@example.com/article',
    'https://user:secret@example.com/article',
    'https://@example.com/article',
    'https://example.com/article#section',
    'https://example.com/article#',
    'https://example.com/before\u0000after',
    `https://example.com/${String.fromCharCode(0xd800)}`,
    `https://example.com/${'a'.repeat(2030)}`,
  ])('rejects unsafe URL input %s', (url) => {
    expect(
      privateUrlResourceCreateSchema.safeParse({
        sourceKind: 'url',
        title: 'Invalid URL',
        category: 'note',
        url,
        idempotencyKey: 'resource:url:invalid:1',
      }).success,
    ).toBe(false);
  });

  it('keeps ingestion states strict and failure codes scoped to their stage', () => {
    const base = {
      displayUrl: 'https://example.com/article?secret=value',
      attempt: 2,
      retryAt: null,
      indexStatus: 'not_indexed',
    } as const;
    expect(
      privateUrlResourceIngestionSchema.parse({ contentStatus: 'queued', ...base }).displayUrl,
    ).toBe('https://example.com/article');
    expect(
      privateUrlResourceIngestionSchema.parse({ contentStatus: 'fetching', ...base }).contentStatus,
    ).toBe('fetching');
    expect(
      privateUrlResourceIngestionSchema.parse({ contentStatus: 'parsing', ...base }).contentStatus,
    ).toBe('parsing');
    expect(
      privateUrlResourceIngestionSchema.parse({ contentStatus: 'bookmark_only', ...base })
        .contentStatus,
    ).toBe('bookmark_only');
    expect(
      privateUrlResourceIngestionSchema.parse({ contentStatus: 'cancelled', ...base })
        .contentStatus,
    ).toBe('cancelled');

    const fetchFailure = {
      stage: 'fetch',
      code: 'blocked_address',
      retryable: false,
      failedAt: updatedAt,
    } as const;
    expect(
      privateUrlResourceIngestionSchema.parse({
        contentStatus: 'failed',
        ...base,
        failure: fetchFailure,
      }).contentStatus,
    ).toBe('failed');
    expect(
      privateUrlResourceIngestionSchema.safeParse({
        contentStatus: 'failed',
        ...base,
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceIngestionSchema.safeParse({
        contentStatus: 'failed',
        ...base,
        failure: { ...fetchFailure, code: 'malformed' },
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceIngestionSchema.safeParse({
        contentStatus: 'failed',
        ...base,
        failure: { ...fetchFailure, stage: 'parse', code: 'blocked_address' },
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceIngestionSchema.safeParse({
        contentStatus: 'queued',
        ...base,
        failure: fetchFailure,
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceIngestionSchema.safeParse({
        contentStatus: 'finalized',
        ...base,
        retryAt: updatedAt,
      }).success,
    ).toBe(false);
  });

  it('wraps public ingestion state with strict stable identifiers and no internal fetch data', () => {
    const record = {
      schemaVersion: 1,
      ingestionId,
      operation: 'create',
      resourceId,
      versionId: versionOneId,
      lifecycle: {
        contentStatus: 'queued',
        displayUrl: `${urlDisplayUrl}?token=private`,
        attempt: 1,
        retryAt: null,
        indexStatus: 'not_indexed',
      },
      createdAt,
      updatedAt,
    } as const;
    expect(privateUrlResourceIngestionRecordSchema.parse(record)).toEqual({
      ...record,
      lifecycle: { ...record.lifecycle, displayUrl: urlDisplayUrl },
    });
    expect(
      privateUrlResourceIngestionRecordSchema.parse({ ...record, operation: 'append' }).operation,
    ).toBe('append');

    for (const invalid of [
      { ingestionId: 'not-a-uuid' },
      { resourceId: 'not-a-uuid' },
      { versionId: 'not-a-uuid' },
      { operation: 'refresh' },
      { schemaVersion: 2 },
    ]) {
      expect(
        privateUrlResourceIngestionRecordSchema.safeParse({ ...record, ...invalid }).success,
      ).toBe(false);
    }
    for (const internalField of [
      'requestedUrl',
      'storageRef',
      'rawTemporaryRef',
      'leaseToken',
      'token',
    ]) {
      expect(
        privateUrlResourceIngestionRecordSchema.safeParse({
          ...record,
          [internalField]: 'private',
        }).success,
      ).toBe(false);
    }
  });

  it('exposes only bounded, query-free capture provenance', () => {
    expect(
      privateUrlResourceProvenanceSchema.parse({
        ...urlProvenance,
        requestedDisplayUrl: `${urlDisplayUrl}?token=private`,
        finalDisplayUrl: `${urlProvenance.finalDisplayUrl}?signed=secret`,
      }),
    ).toEqual(urlProvenance);
    for (const privateField of ['storageRef', 'resolvedIp', 'headers', 'cookie']) {
      expect(
        privateUrlResourceProvenanceSchema.safeParse({
          ...urlProvenance,
          [privateField]: 'private',
        }).success,
      ).toBe(false);
    }
    expect(
      privateUrlResourceProvenanceSchema.safeParse({
        ...urlProvenance,
        redirectCount: 6,
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceProvenanceSchema.safeParse({
        ...urlProvenance,
        mediaType: 'application/octet-stream',
      }).success,
    ).toBe(false);
  });

  it('validates finalized parsed text and exact version-pinned UTF-16 locators', () => {
    expect(privateUrlParsedSnapshotSchema.parse(urlParsedSnapshot)).toEqual(urlParsedSnapshot);
    expect(privateUrlResourceVersionSchema.parse(urlVersion)).toEqual(urlVersion);

    expect(
      privateUrlParsedSnapshotSchema.safeParse({
        ...urlParsedSnapshot,
        fragments: [
          {
            ...urlParsedSnapshot.fragments[0],
            locator: {
              ...urlParsedSnapshot.fragments[0].locator,
              resourceVersionId: versionTwoId,
            },
          },
          urlParsedSnapshot.fragments[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      privateUrlParsedSnapshotSchema.safeParse({
        ...urlParsedSnapshot,
        fragments: [
          urlParsedSnapshot.fragments[0],
          {
            ...urlParsedSnapshot.fragments[1],
            locator: { ...urlParsedSnapshot.fragments[1].locator, index: 2 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      privateUrlParsedSnapshotSchema.safeParse({
        ...urlParsedSnapshot,
        fragments: [
          urlParsedSnapshot.fragments[0],
          { ...urlParsedSnapshot.fragments[1], text: 'Changed.' },
        ],
      }).success,
    ).toBe(false);
    expect(
      privateUrlParsedSnapshotSchema.safeParse({
        ...urlParsedSnapshot,
        text: 'a'.repeat(64 * 1024 + 1),
        fragments: [
          {
            locator: {
              ...urlParsedSnapshot.fragments[0].locator,
              startOffset: 0,
              endOffset: 1,
            },
            text: 'a',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('forbids parsed content before finalization and keeps fetch/parse failure provenance distinct', () => {
    const queuedLifecycle = {
      contentStatus: 'queued',
      displayUrl: urlDisplayUrl,
      attempt: 1,
      retryAt: null,
      indexStatus: 'not_indexed',
    } as const;
    const queuedVersion = {
      ...urlVersion,
      contentHash: null,
      lifecycle: queuedLifecycle,
      provenance: undefined,
      parsedSnapshot: undefined,
    };
    expect(privateUrlResourceVersionSchema.parse(queuedVersion).lifecycle.contentStatus).toBe(
      'queued',
    );
    expect(
      privateUrlResourceVersionSchema.safeParse({
        ...queuedVersion,
        parsedSnapshot: urlParsedSnapshot,
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceReaderSchema.safeParse({
        ...urlReader,
        lifecycle: queuedLifecycle,
        provenance: undefined,
        parsedSnapshot: urlParsedSnapshot,
      }).success,
    ).toBe(false);

    const bookmarkVersion = {
      ...urlVersion,
      lifecycle: { ...urlLifecycle, contentStatus: 'bookmark_only' as const },
      parsedSnapshot: undefined,
    };
    expect(privateUrlResourceVersionSchema.parse(bookmarkVersion).lifecycle.contentStatus).toBe(
      'bookmark_only',
    );
    expect(
      privateUrlResourceVersionSchema.safeParse({
        ...bookmarkVersion,
        parsedSnapshot: urlParsedSnapshot,
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceReaderSchema.safeParse({
        ...urlReader,
        lifecycle: bookmarkVersion.lifecycle,
        parsedSnapshot: urlParsedSnapshot,
      }).success,
    ).toBe(false);

    const fetchFailedLifecycle = {
      ...queuedLifecycle,
      contentStatus: 'failed',
      failure: {
        stage: 'fetch',
        code: 'network_error',
        retryable: true,
        failedAt: updatedAt,
      },
    } as const;
    expect(
      privateUrlResourceVersionSchema.parse({
        ...queuedVersion,
        lifecycle: fetchFailedLifecycle,
      }).lifecycle.contentStatus,
    ).toBe('failed');
    expect(
      privateUrlResourceVersionSchema.safeParse({
        ...queuedVersion,
        lifecycle: fetchFailedLifecycle,
        provenance: urlProvenance,
        contentHash: urlContentHash,
      }).success,
    ).toBe(false);

    const parseFailedLifecycle = {
      ...queuedLifecycle,
      contentStatus: 'failed',
      failure: {
        stage: 'parse',
        code: 'malformed',
        retryable: false,
        failedAt: updatedAt,
      },
    } as const;
    expect(
      privateUrlResourceVersionSchema.safeParse({
        ...queuedVersion,
        lifecycle: parseFailedLifecycle,
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceVersionSchema.parse({
        ...queuedVersion,
        lifecycle: parseFailedLifecycle,
        provenance: urlProvenance,
        contentHash: urlContentHash,
      }).lifecycle.contentStatus,
    ).toBe('failed');
  });

  it('parses a finalized private URL read without granting review, coach use, or indexing', () => {
    const available = privateUrlResourceReadResultSchema.parse({
      status: 'available',
      resource: urlResource,
      version: urlVersion,
      reader: urlReader,
    });
    expect(available.status).toBe('available');
    if (available.status === 'available') {
      expect(available.resource.visibility).toBe('private');
      expect(available.resource.reviewedState).toBe('unreviewed');
      expect(available.resource.includeForCoach).toBe(false);
      expect(available.reader.lifecycle.indexStatus).toBe('not_indexed');
    }
    expect(
      privateResourceReadResultSchema.parse({
        status: 'available',
        resource: urlResource,
        version: urlVersion,
        reader: urlReader,
      }).status,
    ).toBe('available');
    expect(
      privateUrlResourceReadResultSchema.safeParse({
        status: 'available',
        resource: { ...urlResource, reviewedState: 'reviewed', includeForCoach: true },
        version: urlVersion,
        reader: urlReader,
      }).success,
    ).toBe(false);
    expect(
      privateUrlResourceReadResultSchema.safeParse({
        status: 'available',
        resource: urlResource,
        version: urlVersion,
        reader: { ...urlReader, parsedSnapshot: { ...urlParsedSnapshot, text: 'Drift' } },
      }).success,
    ).toBe(false);
  });

  it('preserves the exact legacy text and raw-file schemas', () => {
    expect(privateTextResourceVersionSchema.parse(version)).toEqual(version);
    expect(privateFileResourceVersionSchema.parse(fileVersion)).toEqual(fileVersion);
    expect(privateResourceSchema.parse(resource)).toEqual(resource);
    expect(privateResourceSchema.parse(fileResource)).toEqual(fileResource);
    expect(privateResourceVersionSourceSchema.parse(version.source)).toEqual(version.source);
    expect(privateResourceVersionSourceSchema.parse(fileVersion.source)).toEqual(
      fileVersion.source,
    );
  });
});
