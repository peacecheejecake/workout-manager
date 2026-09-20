import { describe, expect, it } from 'vitest';
import {
  chunkResourceParagraphs,
  RESOURCE_PASSAGE_MAX_BYTES,
  truncateToBytes,
  type ResourcePassageParagraph,
} from '../src/chunk.js';

function paragraph(
  index: number,
  text: string,
  headingPath: string[] = [],
): ResourcePassageParagraph {
  return {
    index,
    startOffset: index * 100,
    endOffset: index * 100 + text.length,
    text,
    headingPath,
  };
}

describe('resource passage chunking', () => {
  it('produces the same passages for the same version every time', () => {
    const paragraphs = [paragraph(0, '회복 주간'), paragraph(1, 'Recovery week')];
    const first = chunkResourceParagraphs(paragraphs);
    expect(first).toEqual(chunkResourceParagraphs(paragraphs));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      ordinal: 0,
      firstParagraphIndex: 0,
      lastParagraphIndex: 1,
      startOffset: 0,
      endOffset: 100 + 'Recovery week'.length,
      content: '회복 주간\n\nRecovery week',
      headingPath: [],
    });
    expect(first[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps every passage inside the stored byte bound', () => {
    const big = 'ㄱ'.repeat(5000);
    const chunks = chunkResourceParagraphs([
      paragraph(0, big),
      paragraph(1, big),
      paragraph(2, big),
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(Buffer.byteLength(chunk.content, 'utf8')).toBeLessThanOrEqual(
        RESOURCE_PASSAGE_MAX_BYTES,
      );
  });

  it('never labels a passage with a heading it does not belong to', () => {
    const chunks = chunkResourceParagraphs([
      paragraph(0, 'intro', ['Guide', 'Recovery']),
      paragraph(1, 'more', ['Guide', 'Recovery']),
      paragraph(2, 'other', ['Guide', 'Intensity']),
    ]);
    // A changed breadcrumb starts a new passage rather than merging two topics.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headingPath).toEqual(['Guide', 'Recovery']);
    expect(chunks[1]?.headingPath).toEqual(['Guide', 'Intensity']);
  });

  it('truncates only on a code point boundary', () => {
    const value = '가나다라';
    expect(truncateToBytes(value, 7)).toBe('가나');
    expect(Buffer.byteLength(truncateToBytes(value, 7), 'utf8')).toBe(6);
    expect(truncateToBytes(value, 100)).toBe(value);
    const chunk = chunkResourceParagraphs([
      paragraph(0, '가'.repeat(RESOURCE_PASSAGE_MAX_BYTES)),
    ])[0];
    expect(chunk).toBeDefined();
    // The locator still spans the whole paragraph even when the stored text is
    // shorter, so the excerpt is never silently presented as the full span.
    expect(chunk?.content.length).toBeLessThan(RESOURCE_PASSAGE_MAX_BYTES);
    expect(Buffer.byteLength(chunk?.content ?? '', 'utf8')).toBeLessThanOrEqual(
      RESOURCE_PASSAGE_MAX_BYTES,
    );
  });

  it('returns nothing for an empty version', () => {
    expect(chunkResourceParagraphs([])).toEqual([]);
  });
});
