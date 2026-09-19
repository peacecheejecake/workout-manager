import { describe, expect, it } from 'vitest';

import {
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
