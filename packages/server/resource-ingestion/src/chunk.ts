import { createHash } from 'node:crypto';

/**
 * Deterministic passage chunking for the retrieval index.
 *
 * Chunking never invents content: it groups consecutive stored paragraphs of
 * one pinned resource version and keeps their locator offsets, so a passage can
 * always be pointed back at the exact span of that version. It is a pure
 * function of the stored paragraphs and the bounds below, so re-indexing the
 * same version twice produces byte-identical passages.
 *
 * A generated summary is not produced here and is never a passage: only source
 * text is indexed.
 */
export const RESOURCE_PASSAGE_CORPUS_VERSION = 1;
/** Kept under the column bound so a chunk always fits the index row. */
export const RESOURCE_PASSAGE_MAX_BYTES = 12 * 1024;
export const RESOURCE_PASSAGE_MAX_COUNT = 1000;

export interface ResourcePassageParagraph {
  /** Index of the paragraph inside its version, as stored by ingestion. */
  index: number;
  startOffset: number;
  endOffset: number;
  text: string;
  /** Heading breadcrumb where the parser preserved one; empty otherwise. */
  headingPath: string[];
}

export interface ResourcePassageChunk {
  ordinal: number;
  firstParagraphIndex: number;
  lastParagraphIndex: number;
  startOffset: number;
  endOffset: number;
  headingPath: string[];
  content: string;
  contentHash: string;
}

const utf8 = (value: string) => Buffer.byteLength(value, 'utf8');

/**
 * Groups paragraphs into byte-bounded passages. A single paragraph larger than
 * the bound becomes its own passage and is truncated on a code point boundary;
 * the locator still records the full paragraph span, and the truncation is
 * visible because content is shorter than `endOffset - startOffset`.
 */
export function chunkResourceParagraphs(
  paragraphs: readonly ResourcePassageParagraph[],
): ResourcePassageChunk[] {
  const chunks: ResourcePassageChunk[] = [];
  let pending: ResourcePassageParagraph[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const first = pending[0];
    const last = pending[pending.length - 1];
    if (!first || !last) return;
    const content = truncateToBytes(
      pending.map((paragraph) => paragraph.text).join('\n\n'),
      RESOURCE_PASSAGE_MAX_BYTES,
    );
    chunks.push({
      ordinal: chunks.length,
      firstParagraphIndex: first.index,
      lastParagraphIndex: last.index,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      // Only a breadcrumb shared by every grouped paragraph is kept, so a
      // passage is never labelled with a heading it does not belong to.
      headingPath: commonHeadingPath(pending),
      content,
      contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
    pending = [];
    pendingBytes = 0;
  };
  for (const paragraph of paragraphs) {
    if (chunks.length >= RESOURCE_PASSAGE_MAX_COUNT) break;
    const size = utf8(paragraph.text);
    const separator = pending.length === 0 ? 0 : 2;
    // A paragraph that narrows the group's shared breadcrumb belongs to a
    // different section, so it starts a new passage instead of blurring two.
    const headingChanged =
      pending.length > 0 &&
      commonHeadingPath([...pending, paragraph]).length < commonHeadingPath(pending).length;
    if (
      pending.length > 0 &&
      (pendingBytes + separator + size > RESOURCE_PASSAGE_MAX_BYTES || headingChanged)
    )
      flush();
    if (chunks.length >= RESOURCE_PASSAGE_MAX_COUNT) break;
    pending.push(paragraph);
    pendingBytes += (pending.length === 1 ? 0 : 2) + size;
    if (pendingBytes >= RESOURCE_PASSAGE_MAX_BYTES) flush();
  }
  if (chunks.length < RESOURCE_PASSAGE_MAX_COUNT) flush();
  return chunks;
}

function commonHeadingPath(paragraphs: readonly ResourcePassageParagraph[]): string[] {
  const first = paragraphs[0];
  if (!first) return [];
  let shared = first.headingPath;
  for (const paragraph of paragraphs.slice(1)) {
    const next: string[] = [];
    for (let index = 0; index < Math.min(shared.length, paragraph.headingPath.length); index += 1) {
      const value = shared[index];
      if (value === undefined || value !== paragraph.headingPath[index]) break;
      next.push(value);
    }
    shared = next;
    if (shared.length === 0) return [];
  }
  return [...shared];
}

/** Truncates on a code point boundary so the stored text is always valid UTF-8. */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (utf8(value) <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const codePoint of value) {
    const size = utf8(codePoint);
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}
