import { describe, expect, it } from 'vitest';

import { BoundedParserError, parseBoundedDocument } from '../src/parser.js';

const encoder = new TextEncoder();

function headingPaths(document: ReturnType<typeof parseBoundedDocument>): readonly string[][] {
  return document.fragments.map((fragment) =>
    fragment.locator.kind === 'plain_paragraph' ? [] : [...fragment.locator.headingPath],
  );
}

describe('bounded document parser', () => {
  it('extracts HTML structure while removing active and embedded content', () => {
    const document = parseBoundedDocument({
      contentType: 'text/html',
      body: encoder.encode(`<!doctype html><html><head>
        <title> Training &amp; Recovery </title>
        <style>.secret { display: block }</style>
        <script>window.secret = 'do not index'</script>
      </head><body>
        <h1>Overview</h1><p>Safe <strong>content</strong>.</p>
        <noscript>hidden fallback</noscript>
        <svg><text>hidden image</text></svg>
        <math><mi>hidden math</mi></math>
        <form><label>hidden form</label></form>
        <h2>Details</h2><p>Second&nbsp;paragraph.</p>
      </body></html>`),
    });

    expect(document.title).toBe('Training & Recovery');
    expect(document.text).toBe('Overview\n\nSafe content.\n\nDetails\n\nSecond paragraph.');
    expect(document.text).not.toMatch(/secret|hidden|window|display/);
    expect(headingPaths(document)).toEqual([
      ['Overview'],
      ['Overview'],
      ['Overview', 'Details'],
      ['Overview', 'Details'],
    ]);
    expect(document.fragments.every((fragment) => fragment.locator.kind === 'html_block')).toBe(
      true,
    );

    const malformed = parseBoundedDocument({
      contentType: 'text/html',
      body: encoder.encode('<p>before</p><script>hidden</style>still hidden</script><p>after</p>'),
    });
    expect(malformed.text).toBe('before\n\nafter');
  });

  it('parses XHTML through the bounded HTML path', () => {
    const document = parseBoundedDocument({
      contentType: 'application/xhtml+xml',
      body: encoder.encode(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Safe</h1><script>hidden()</script><p>Text 😀</p></body></html>',
      ),
    });

    expect(document.parser).toEqual({ id: 'workout-bounded-html', version: 1 });
    expect(document.text).toBe('Safe\n\nText 😀');
    for (const fragment of document.fragments) {
      expect(fragment.locator.kind).toBe('html_block');
      expect(document.text.slice(fragment.locator.startOffset, fragment.locator.endOffset)).toBe(
        fragment.text,
      );
    }
  });

  it('emits deterministic markdown paragraphs, locators, and hashes', () => {
    const body = encoder.encode(
      '# Week One\r\n\r\nFirst line\r\nsecond line\r\n\r\n### Notes\r\nText',
    );
    const first = parseBoundedDocument({ body, contentType: 'text/markdown' });
    const second = parseBoundedDocument({ body, contentType: 'text/markdown' });

    expect(first).toEqual(second);
    expect(first.parser).toEqual({ id: 'workout-bounded-markdown', version: 1 });
    expect(first.text).toBe('Week One\n\nFirst line second line\n\nNotes\n\nText');
    expect(headingPaths(first)).toEqual([
      ['Week One'],
      ['Week One'],
      ['Week One', 'Notes'],
      ['Week One', 'Notes'],
    ]);
    expect(first.fragments.map((fragment) => fragment.locator)).toEqual([
      {
        kind: 'markdown_paragraph',
        index: 0,
        startOffset: 0,
        endOffset: 8,
        offsetUnit: 'utf16_code_unit',
        headingPath: ['Week One'],
        paragraphIndex: 0,
      },
      {
        kind: 'markdown_paragraph',
        index: 1,
        startOffset: 10,
        endOffset: 32,
        offsetUnit: 'utf16_code_unit',
        headingPath: ['Week One'],
        paragraphIndex: 1,
      },
      {
        kind: 'markdown_paragraph',
        index: 2,
        startOffset: 34,
        endOffset: 39,
        offsetUnit: 'utf16_code_unit',
        headingPath: ['Week One', 'Notes'],
        paragraphIndex: 2,
      },
      {
        kind: 'markdown_paragraph',
        index: 3,
        startOffset: 41,
        endOffset: 45,
        offsetUnit: 'utf16_code_unit',
        headingPath: ['Week One', 'Notes'],
        paragraphIndex: 3,
      },
    ]);
    expect(first.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('extracts bounded plain-text paragraphs and retains source paragraph indexes', () => {
    const document = parseBoundedDocument({
      body: encoder.encode('alpha\ncontinued\n\nbeta'),
      contentType: 'text/plain',
      limits: { maxFragmentCharacters: 8 },
    });
    expect(document.text).toBe('alpha\n\ncontinue\n\nd\n\nbeta');
    expect(document.fragments).toHaveLength(4);
    expect(document.fragments.every((fragment) => fragment.text.length <= 8)).toBe(true);
    expect(
      document.fragments.map((fragment) =>
        fragment.locator.kind === 'plain_paragraph' ? fragment.locator.paragraphIndex : -1,
      ),
    ).toEqual([0, 0, 0, 1]);
  });

  it('uses UTF-16 offsets into returned text, including surrogate pairs', () => {
    const document = parseBoundedDocument({
      body: encoder.encode('😀 one\n\nsecond 🏃'),
      contentType: 'text/plain',
    });
    expect(document.fragments.map((fragment) => fragment.locator)).toEqual([
      {
        kind: 'plain_paragraph',
        index: 0,
        startOffset: 0,
        endOffset: 6,
        offsetUnit: 'utf16_code_unit',
        paragraphIndex: 0,
      },
      {
        kind: 'plain_paragraph',
        index: 1,
        startOffset: 8,
        endOffset: 17,
        offsetUnit: 'utf16_code_unit',
        paragraphIndex: 1,
      },
    ]);
    for (const fragment of document.fragments) {
      expect(document.text.slice(fragment.locator.startOffset, fragment.locator.endOffset)).toBe(
        fragment.text,
      );
    }
  });

  it('rejects invalid UTF-8 and input/output overflow', () => {
    expect(() =>
      parseBoundedDocument({
        body: new Uint8Array([0xc3, 0x28]),
        contentType: 'text/plain',
      }),
    ).toThrowError(new BoundedParserError('PARSER_INVALID_UTF8'));
    expect(() =>
      parseBoundedDocument({
        body: encoder.encode('12345'),
        contentType: 'text/plain',
        limits: { maxInputBytes: 4 },
      }),
    ).toThrowError(new BoundedParserError('PARSER_INPUT_TOO_LARGE'));
    expect(() =>
      parseBoundedDocument({
        body: encoder.encode('12345'),
        contentType: 'text/plain',
        limits: { maxOutputBytes: 4 },
      }),
    ).toThrowError(new BoundedParserError('PARSER_OUTPUT_TOO_LARGE'));
    expect(() =>
      parseBoundedDocument({
        body: encoder.encode('a'.repeat(65_537)),
        contentType: 'text/plain',
      }),
    ).toThrowError(new BoundedParserError('PARSER_OUTPUT_TOO_LARGE'));
  });

  it('enforces fragment, HTML depth, and token limits', () => {
    expect(() =>
      parseBoundedDocument({
        body: encoder.encode('abcdefghij'),
        contentType: 'text/plain',
        limits: { maxFragmentCharacters: 2, maxFragments: 4 },
      }),
    ).toThrowError(new BoundedParserError('PARSER_FRAGMENT_LIMIT'));
    expect(() =>
      parseBoundedDocument({
        body: encoder.encode('<div><div><div>deep</div></div></div>'),
        contentType: 'text/html',
        limits: { maxHtmlDepth: 2 },
      }),
    ).toThrowError(new BoundedParserError('PARSER_COMPLEXITY_LIMIT'));
    expect(() =>
      parseBoundedDocument({
        body: encoder.encode('<p>text</p>'),
        contentType: 'text/html',
        limits: { maxHtmlTokens: 2 },
      }),
    ).toThrowError(new BoundedParserError('PARSER_COMPLEXITY_LIMIT'));
  });
});
