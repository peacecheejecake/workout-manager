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
} from '../src/resources.js';

const resourceId = '11111111-1111-4111-8111-111111111111';
const versionOneId = '22222222-2222-4222-8222-222222222222';
const versionTwoId = '33333333-3333-4333-8333-333333333333';
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
