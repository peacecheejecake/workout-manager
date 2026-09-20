import { createHash } from 'node:crypto';

const MAX_PARSED_OUTPUT_BYTES = 64 * 1024;

export type ParsedContentType =
  'text/html' | 'application/xhtml+xml' | 'text/markdown' | 'text/plain';

interface ParsedFragmentLocatorBase {
  readonly index: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly offsetUnit: 'utf16_code_unit';
}

export type ParsedFragmentLocator =
  | (ParsedFragmentLocatorBase & {
      readonly kind: 'html_block';
      readonly headingPath: readonly string[];
    })
  | (ParsedFragmentLocatorBase & {
      readonly kind: 'markdown_paragraph';
      readonly headingPath: readonly string[];
      readonly paragraphIndex: number;
    })
  | (ParsedFragmentLocatorBase & {
      readonly kind: 'plain_paragraph';
      readonly paragraphIndex: number;
    });

export interface ParsedFragment {
  readonly text: string;
  readonly locator: ParsedFragmentLocator;
}

export interface ParsedDocument {
  readonly parser: { readonly id: string; readonly version: 1 };
  readonly contentType: ParsedContentType;
  readonly title?: string;
  readonly text: string;
  readonly fragments: readonly ParsedFragment[];
  readonly sourceSha256: string;
  readonly textSha256: string;
}

export interface ParserLimits {
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxFragments?: number;
  readonly maxFragmentCharacters?: number;
  readonly maxHtmlDepth?: number;
  readonly maxHtmlTokens?: number;
}

export class BoundedParserError extends Error {
  constructor(
    readonly code:
      | 'PARSER_INPUT_TOO_LARGE'
      | 'PARSER_INVALID_UTF8'
      | 'PARSER_OUTPUT_TOO_LARGE'
      | 'PARSER_FRAGMENT_LIMIT'
      | 'PARSER_COMPLEXITY_LIMIT',
  ) {
    super(code);
    this.name = 'BoundedParserError';
  }
}

interface RequiredLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxFragments: number;
  maxFragmentCharacters: number;
  maxHtmlDepth: number;
  maxHtmlTokens: number;
}

function limits(input?: ParserLimits): RequiredLimits {
  const resolved = {
    maxInputBytes: input?.maxInputBytes ?? 1024 * 1024,
    maxOutputBytes: input?.maxOutputBytes ?? MAX_PARSED_OUTPUT_BYTES,
    maxFragments: input?.maxFragments ?? 1000,
    maxFragmentCharacters: input?.maxFragmentCharacters ?? 8192,
    maxHtmlDepth: input?.maxHtmlDepth ?? 128,
    maxHtmlTokens: input?.maxHtmlTokens ?? 100_000,
  };
  if (
    !Number.isInteger(resolved.maxInputBytes) ||
    resolved.maxInputBytes < 1 ||
    resolved.maxInputBytes > 1024 * 1024 ||
    !Number.isInteger(resolved.maxOutputBytes) ||
    resolved.maxOutputBytes < 1 ||
    resolved.maxOutputBytes > MAX_PARSED_OUTPUT_BYTES ||
    !Number.isInteger(resolved.maxFragments) ||
    resolved.maxFragments < 1 ||
    resolved.maxFragments > 1000 ||
    !Number.isInteger(resolved.maxFragmentCharacters) ||
    resolved.maxFragmentCharacters < 1 ||
    resolved.maxFragmentCharacters > 8192 ||
    !Number.isInteger(resolved.maxHtmlDepth) ||
    resolved.maxHtmlDepth < 1 ||
    resolved.maxHtmlDepth > 128 ||
    !Number.isInteger(resolved.maxHtmlTokens) ||
    resolved.maxHtmlTokens < 1 ||
    resolved.maxHtmlTokens > 100_000
  )
    throw new BoundedParserError('PARSER_COMPLEXITY_LIMIT');
  return resolved;
}

function decodeUtf8(source: Uint8Array, bound: number): string {
  if (source.byteLength > bound) throw new BoundedParserError('PARSER_INPUT_TOO_LARGE');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new BoundedParserError('PARSER_INVALID_UTF8');
  }
}

function normalizedText(value: string): string {
  return value
    .replaceAll('\u00a0', ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

function locatorHeading(value: string): string {
  let end = Math.min(value.length, 200);
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, token: string) => {
      const normalized = token.toLowerCase();
      if (normalized === 'amp') return '&';
      if (normalized === 'lt') return '<';
      if (normalized === 'gt') return '>';
      if (normalized === 'quot') return '"';
      if (normalized === 'apos') return "'";
      if (normalized === 'nbsp') return ' ';
      const value = normalized.startsWith('#x')
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      if (
        !Number.isInteger(value) ||
        value <= 0 ||
        value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff)
      )
        return match;
      return String.fromCodePoint(value);
    },
  );
}

type DraftFragmentLocator =
  | { readonly kind: 'html_block'; readonly headingPath: readonly string[] }
  | {
      readonly kind: 'markdown_paragraph';
      readonly headingPath: readonly string[];
      readonly paragraphIndex: number;
    }
  | { readonly kind: 'plain_paragraph'; readonly paragraphIndex: number };

interface DraftFragment {
  readonly text: string;
  readonly locator: DraftFragmentLocator;
}

class FragmentCollector {
  readonly fragments: DraftFragment[] = [];
  private outputBytes = 0;
  private paragraphIndex = 0;

  constructor(
    private readonly contentKind: DraftFragmentLocator['kind'],
    private readonly bound: RequiredLimits,
  ) {}

  add(rawText: string, headingPath: readonly string[]): void {
    let remaining = normalizedText(rawText);
    let added = false;
    while (remaining.length > 0) {
      if (this.fragments.length >= this.bound.maxFragments)
        throw new BoundedParserError('PARSER_FRAGMENT_LIMIT');
      let cut = Math.min(remaining.length, this.bound.maxFragmentCharacters);
      if (cut < remaining.length) {
        const whitespace = remaining.lastIndexOf(' ', cut);
        if (whitespace > Math.floor(cut / 2)) cut = whitespace;
      }
      const finalCodeUnit = remaining.charCodeAt(cut - 1);
      if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) cut -= 1;
      const text = remaining.slice(0, cut).trim();
      remaining = remaining.slice(cut).trim();
      if (!text) continue;
      this.outputBytes += new TextEncoder().encode(text).byteLength;
      if (this.outputBytes > this.bound.maxOutputBytes)
        throw new BoundedParserError('PARSER_OUTPUT_TOO_LARGE');
      this.fragments.push({
        text,
        locator:
          this.contentKind === 'html_block'
            ? { kind: 'html_block', headingPath: [...headingPath] }
            : this.contentKind === 'markdown_paragraph'
              ? {
                  kind: 'markdown_paragraph',
                  headingPath: [...headingPath],
                  paragraphIndex: this.paragraphIndex,
                }
              : { kind: 'plain_paragraph', paragraphIndex: this.paragraphIndex },
      });
      added = true;
    }
    if (added && this.contentKind !== 'html_block') this.paragraphIndex += 1;
  }
}

function completeLocator(
  locator: DraftFragmentLocator,
  index: number,
  startOffset: number,
  endOffset: number,
): ParsedFragmentLocator {
  const base: ParsedFragmentLocatorBase = {
    index,
    startOffset,
    endOffset,
    offsetUnit: 'utf16_code_unit',
  };
  if (locator.kind === 'html_block')
    return { ...base, kind: locator.kind, headingPath: locator.headingPath };
  if (locator.kind === 'markdown_paragraph')
    return {
      ...base,
      kind: locator.kind,
      headingPath: locator.headingPath,
      paragraphIndex: locator.paragraphIndex,
    };
  return { ...base, kind: locator.kind, paragraphIndex: locator.paragraphIndex };
}

function finalizeFragments(drafts: readonly DraftFragment[]): {
  readonly text: string;
  readonly fragments: readonly ParsedFragment[];
} {
  let offset = 0;
  const fragments = drafts.map((draft, index): ParsedFragment => {
    if (index > 0) offset += 2;
    const startOffset = offset;
    offset += draft.text.length;
    return {
      text: draft.text,
      locator: completeLocator(draft.locator, index, startOffset, offset),
    };
  });
  return { text: fragments.map((fragment) => fragment.text).join('\n\n'), fragments };
}

function parseLines(
  source: string,
  contentType: 'text/markdown' | 'text/plain',
  bound: RequiredLimits,
): { fragments: readonly DraftFragment[]; parserId: string } {
  const collector = new FragmentCollector(
    contentType === 'text/markdown' ? 'markdown_paragraph' : 'plain_paragraph',
    bound,
  );
  const headingsByLevel: Array<string | undefined> = [];
  let paragraph: string[] = [];
  const flush = () => {
    collector.add(
      paragraph.join('\n'),
      headingsByLevel.filter((heading): heading is string => heading !== undefined),
    );
    paragraph = [];
  };
  for (const lineWithEnding of source.match(/.*(?:\r\n|\n|\r|$)/g) ?? []) {
    if (lineWithEnding === '') continue;
    const line = lineWithEnding.replace(/(?:\r\n|\n|\r)$/, '');
    const heading =
      contentType === 'text/markdown' ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      const text = normalizedText(heading[2] ?? '');
      if (text) {
        headingsByLevel.length = level;
        headingsByLevel[level - 1] = locatorHeading(text);
        collector.add(
          text,
          headingsByLevel.filter((item): item is string => item !== undefined),
        );
      }
    } else if (line.trim() === '') {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return {
    fragments: collector.fragments,
    parserId:
      contentType === 'text/markdown' ? 'workout-bounded-markdown' : 'workout-bounded-plain',
  };
}

const SUPPRESSED_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'math', 'form']);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'div',
  'footer',
  'header',
  'li',
  'main',
  'nav',
  'p',
  'pre',
  'section',
  'td',
  'th',
  'tr',
]);
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

function parseHtml(source: string, bound: RequiredLimits) {
  const collector = new FragmentCollector('html_block', bound);
  const stack: string[] = [];
  const suppressedStack: string[] = [];
  const headingsByLevel: Array<string | undefined> = [];
  let current = '';
  let currentHeadingLevel: number | null = null;
  let title = '';
  let titleDepth = 0;
  let tokens = 0;

  const flush = () => {
    const text = normalizedText(decodeEntities(current));
    if (text) {
      if (currentHeadingLevel !== null) {
        headingsByLevel.length = currentHeadingLevel;
        headingsByLevel[currentHeadingLevel - 1] = locatorHeading(text);
        collector.add(
          text,
          headingsByLevel.filter((item): item is string => item !== undefined),
        );
      } else
        collector.add(
          text,
          headingsByLevel.filter((item): item is string => item !== undefined),
        );
    }
    current = '';
    currentHeadingLevel = null;
  };

  let cursor = 0;
  while (cursor < source.length) {
    tokens += 1;
    if (tokens > bound.maxHtmlTokens) throw new BoundedParserError('PARSER_COMPLEXITY_LIMIT');
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end === -1) break;
      cursor = end + 3;
      continue;
    }
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      const end = next === -1 ? source.length : next;
      const text = source.slice(cursor, end);
      if (suppressedStack.length === 0) {
        if (titleDepth > 0) title += text;
        else current += text;
      }
      cursor = end;
      continue;
    }
    const close = source.indexOf('>', cursor + 1);
    if (close === -1) {
      if (suppressedStack.length === 0) current += source.slice(cursor);
      break;
    }
    if (close - cursor > 8192) throw new BoundedParserError('PARSER_COMPLEXITY_LIMIT');
    const tagSource = source.slice(cursor + 1, close).trim();
    const closing = tagSource.startsWith('/');
    const nameMatch = /^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tagSource);
    if (!nameMatch) {
      cursor = close + 1;
      continue;
    }
    const tag = (nameMatch[1] ?? '').toLowerCase();
    const selfClosing = tagSource.endsWith('/') || VOID_TAGS.has(tag);
    if (closing) {
      if (SUPPRESSED_TAGS.has(tag)) {
        const suppressedIndex = suppressedStack.lastIndexOf(tag);
        if (suppressedIndex !== -1) suppressedStack.length = suppressedIndex;
      }
      if (tag === 'title' && titleDepth > 0) titleDepth -= 1;
      if (suppressedStack.length === 0 && (BLOCK_TAGS.has(tag) || /^h[1-6]$/.test(tag))) flush();
      const index = stack.lastIndexOf(tag);
      if (index !== -1) stack.length = index;
    } else {
      if (suppressedStack.length === 0 && (BLOCK_TAGS.has(tag) || /^h[1-6]$/.test(tag))) flush();
      if (SUPPRESSED_TAGS.has(tag)) suppressedStack.push(tag);
      if (tag === 'title' && suppressedStack.length === 0) titleDepth += 1;
      if (/^h[1-6]$/.test(tag) && suppressedStack.length === 0)
        currentHeadingLevel = Number(tag.slice(1));
      if (!selfClosing) {
        stack.push(tag);
        if (stack.length > bound.maxHtmlDepth)
          throw new BoundedParserError('PARSER_COMPLEXITY_LIMIT');
      }
    }
    cursor = close + 1;
  }
  flush();
  const normalizedTitle = normalizedText(decodeEntities(title));
  return {
    fragments: collector.fragments,
    parserId: 'workout-bounded-html',
    ...(normalizedTitle ? { title: normalizedTitle.slice(0, 500) } : {}),
  };
}

export function parseBoundedDocument(input: {
  readonly body: Uint8Array;
  readonly contentType: ParsedContentType;
  readonly limits?: ParserLimits;
}): ParsedDocument {
  const bound = limits(input.limits);
  const source = decodeUtf8(input.body, bound.maxInputBytes)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n');
  const parsed =
    input.contentType === 'text/html' || input.contentType === 'application/xhtml+xml'
      ? parseHtml(source, bound)
      : parseLines(source, input.contentType, bound);
  const finalized = finalizeFragments(parsed.fragments);
  const { text } = finalized;
  const title = 'title' in parsed && typeof parsed.title === 'string' ? parsed.title : undefined;
  const completeOutput = title ? `${title}\n\n${text}` : text;
  if (new TextEncoder().encode(completeOutput).byteLength > bound.maxOutputBytes)
    throw new BoundedParserError('PARSER_OUTPUT_TOO_LARGE');
  return {
    parser: { id: parsed.parserId, version: 1 },
    contentType: input.contentType,
    ...(title ? { title } : {}),
    text,
    fragments: finalized.fragments,
    sourceSha256: createHash('sha256').update(input.body).digest('hex'),
    textSha256: createHash('sha256').update(text).digest('hex'),
  };
}
