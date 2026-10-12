import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gallerySubtitleCueSchema } from '@workout/contracts/gallery-viewer';
import {
  GalleryWebVttError,
  galleryWebVttLimits,
  galleryWebVttParserVersion,
  parseGalleryWebVtt,
} from '../src/gallery-webvtt.js';

const encode = (text: string) => new TextEncoder().encode(text);
function document(payload = '첫 번째 자막', timing = '00:00.000 --> 00:02.500') {
  return `WEBVTT\n\n${timing}\n${payload}\n`;
}
function code(input: unknown): string {
  try {
    parseGalleryWebVtt(input);
    return 'accepted';
  } catch (error) {
    expect(error).toBeInstanceOf(GalleryWebVttError);
    if (error instanceof GalleryWebVttError) return error.code;
    throw error;
  }
}

describe('bounded user WebVTT plain parser', () => {
  it('returns exact original UTF8 byte count/hash and shared-schema cues', () => {
    const bytes = encode(document());
    const snapshot = bytes.slice();
    const result = parseGalleryWebVtt(bytes);
    expect(result.parserVersion).toBe(galleryWebVttParserVersion);
    expect(result.source).toEqual({
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(result.cues).toEqual([{ startMs: 0, endMs: 2500, text: '첫 번째 자막' }]);
    expect(gallerySubtitleCueSchema.parse(result.cues[0])).toEqual(result.cues[0]);
    expect(bytes).toEqual(snapshot);
    expect(result).not.toHaveProperty('sourceText');
    expect(result).not.toHaveProperty('approved');
  });
  it('normalizes BOM and all line endings without altering source identity or Unicode', () => {
    const lf = document('한국어 日本語 العربية 😀\n두 번째 줄');
    for (const text of [lf, '\ufeff' + lf.replaceAll('\n', '\r\n'), lf.replaceAll('\n', '\r')]) {
      const bytes = encode(text);
      const result = parseGalleryWebVtt(bytes);
      expect(result.cues[0]?.text).toBe('한국어 日本語 العربية 😀\n두 번째 줄');
      expect(result.source.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(parseGalleryWebVtt(encode(lf)).source.sha256).not.toBe(
      parseGalleryWebVtt(encode('\ufeff' + lf)).source.sha256,
    );
    const decomposed = 'e\u0301';
    expect(parseGalleryWebVtt(encode(document(decomposed))).cues[0]?.text).toBe(decomposed);
  });
  it('preserves identifiers, overlaps, equal starts and hours timestamps in original order', () => {
    const raw =
      'WEBVTT\n\n단서-1\n00:01.000 --> 00:04.000\n첫째\n\ncue-2\n00:01.000 --> 00:02.000\n둘째\n\n01:02:03.004 --> 01:02:04.005\n셋째\n';
    const result = parseGalleryWebVtt(encode(raw));
    expect(result.cueIdentifiers).toEqual(['단서-1', 'cue-2', null]);
    expect(result.cues.map((cue) => [cue.startMs, cue.endMs])).toEqual([
      [1000, 4000],
      [1000, 2000],
      [3723004, 3724005],
    ]);
  });
  it('does not silently discard duplicate identifiers or reorder cues', () => {
    expect(
      code(
        encode('WEBVTT\n\nsame\n00:00.000 --> 00:01.000\na\n\nsame\n00:01.000 --> 00:02.000\nb\n'),
      ),
    ).toBe('DUPLICATE_CUE_IDENTIFIER');
    expect(
      code(encode('WEBVTT\n\n00:02.000 --> 00:03.000\na\n\n00:01.000 --> 00:02.000\nb\n')),
    ).toBe('CUE_ORDER_INVALID');
  });
  it('decodes only named character references once into literal text', () => {
    const result = parseGalleryWebVtt(
      encode(document('&amp; &lt; &gt; &nbsp; &lrm; &rlm; &amp;lt;')),
    );
    expect(result.cues[0]?.text).toBe('& < > \u00a0 \u200e \u200f &lt;');
    // Viewer escapes literal text when constructing its VTT Blob; parser never makes DOM.
    expect(
      parseGalleryWebVtt(encode(document('&lt;script&gt;alert(1)&lt;/script&gt;'))).cues[0]?.text,
    ).toBe('<script>alert(1)</script>');
    for (const text of ['&#60;', '&#x3c;', '&unknown;', '&amp', '&', 'a & b'])
      expect(code(encode(document(text)))).toBe('UNSUPPORTED_CHARACTER_REFERENCE');
  });
  it('explicitly rejects markup/style/region/comment/header annotation and cue settings', () => {
    for (const text of [
      '<b>bold</b>',
      '<img src=x onerror=alert(1)>',
      '<00:01.000>',
      '<v Speaker>voice',
    ])
      expect(code(encode(document(text)))).toBe('UNSUPPORTED_CUE_MARKUP');
    for (const block of [
      'STYLE\n::cue { color: red; }',
      'REGION\nid:r width:40%',
      'NOTE private comment',
    ])
      expect(code(encode(`WEBVTT\n\n${block}\n`))).toBe('UNSUPPORTED_BLOCK');
    expect(code(encode('WEBVTT annotation\n\n'))).toBe('UNSUPPORTED_HEADER_METADATA');
    for (const setting of ['align:start', 'position:20%', 'unknown:yes', 'region:r', 'vertical:rl'])
      expect(code(encode(document('text', `00:00.000 --> 00:01.000 ${setting}`)))).toBe(
        'UNSUPPORTED_CUE_SETTINGS',
      );
  });
  it('rejects malformed timestamps, unsafe integer overflow and reversed/empty intervals', () => {
    for (const timing of [
      '0:00.000 --> 00:01.000',
      '00:60.000 --> 01:01.000',
      '60:00.000 --> 61:00.000',
      '00:00,000 --> 00:01,000',
      '00:00.00 --> 00:01.000',
      '00:00.000-->00:01.000',
      '-00:01.000 --> 00:01.000',
      '99999999999999999999999:00:00.000 --> 99999999999999999999999:00:01.000',
    ])
      expect(code(encode(document('text', timing)))).toBe('INVALID_TIMESTAMP');
    expect(code(encode(document('text', '00:02.000 --> 00:01.000')))).toBe('INVALID_CUE');
    expect(code(encode(document('text', '00:00.000 --> 00:00.000')))).toBe('INVALID_CUE');
  });
  it('rejects NUL/controls, invalid UTF8 and SRT without browser error recovery', () => {
    for (const text of ['a\u0000b', 'a\u0001b', 'a\u007fb', 'a\u0085b'])
      expect(code(encode(document(text)))).toBe('INVALID_CHARACTER');
    for (const bytes of [
      new Uint8Array([0xff]),
      new Uint8Array([0xc3]),
      new Uint8Array([0xed, 0xa0, 0x80]),
    ])
      expect(code(bytes)).toBe('INVALID_UTF8');
    expect(code(encode('1\n00:00:01,000 --> 00:00:02,000\ntext\n'))).toBe('INVALID_HEADER');
    expect(code(encode('WEBVTT\n00:00.000 --> 00:01.000\ntext\n'))).toBe('INVALID_HEADER');
  });
  it('preserves text whitespace while enforcing nonempty cue payload and delimiter syntax', () => {
    expect(parseGalleryWebVtt(encode(document('  text\twith spaces  '))).cues[0]?.text).toBe(
      '  text\twith spaces  ',
    );
    expect(code(encode(document('')))).toBe('INVALID_CUE');
    expect(code(encode(document('text --> arrow')))).toBe('INVALID_CUE');
    expect(parseGalleryWebVtt(encode('WEBVTT\n\n')).cues).toEqual([]);
  });
  it('accepts exact cue/count text limits and rejects overflow before output construction', () => {
    expect(parseGalleryWebVtt(encode(document('x'.repeat(2000)))).cues[0]?.text).toHaveLength(2000);
    expect(code(encode(document('x'.repeat(2001))))).toBe('LIMIT_EXCEEDED');
    const cue = '00:00.000 --> 00:01.000\nx\n\n';
    expect(parseGalleryWebVtt(encode('WEBVTT\n\n' + cue.repeat(1000))).cues).toHaveLength(1000);
    expect(code(encode('WEBVTT\n\n' + cue.repeat(1001)))).toBe('LIMIT_EXCEEDED');
    expect(code(new Uint8Array(galleryWebVttLimits.sourceBytes + 1))).toBe('SOURCE_TOO_LARGE');
    expect(code(encode('WEBVTT\n\n' + '\n'.repeat(galleryWebVttLimits.lines)))).toBe(
      'LIMIT_EXCEEDED',
    );
  });
  it('bounds escaped normalized JSON independently of smaller original bytes', () => {
    const raw = encode(
      'WEBVTT\n\n' + ('00:00.000 --> 00:01.000\n' + '\\'.repeat(2000) + '\n\n').repeat(200),
    );
    expect(raw.byteLength).toBeLessThan(galleryWebVttLimits.sourceBytes);
    expect(code(raw)).toBe('LIMIT_EXCEEDED');
  });
  it('snapshots bytes without caller getters/iterators and freezes normalized results', () => {
    const bytes = encode(document());
    let reads = 0;
    Object.defineProperty(bytes, 'byteLength', {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    Object.defineProperty(bytes, Symbol.iterator, {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    const result = parseGalleryWebVtt(bytes);
    bytes.fill(0);
    expect(reads).toBe(0);
    expect(result.cues[0]?.text).toBe('첫 번째 자막');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cues)).toBe(true);
    expect(Object.isFrozen(result.cues[0])).toBe(true);
    expect(Object.isFrozen(result.cueIdentifiers)).toBe(true);
  });
  it('accepts a Buffer byte view but rejects unknown/proxy/shared/detached source safely', () => {
    expect(parseGalleryWebVtt(Buffer.from(document())).cues).toHaveLength(1);
    let reads = 0;
    const getter = Object.defineProperty({}, 'bytes', {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    for (const input of [
      getter,
      null,
      document(),
      new Uint16Array(4),
      new Proxy(encode(document()), {}),
      new Uint8Array(),
      new Uint8Array(new SharedArrayBuffer(20)),
    ])
      expect(code(input)).toBe('INVALID_INPUT');
    expect(reads).toBe(0);
    const detached = encode(document());
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(code(detached)).toBe('INVALID_INPUT');
  });
  it('returns only finite safe error messages without source fragments or raw payload properties', () => {
    try {
      parseGalleryWebVtt(encode(document('<script>synthetic-secret</script>')));
      throw new Error('unexpected');
    } catch (error) {
      expect(error).toBeInstanceOf(GalleryWebVttError);
      if (!(error instanceof GalleryWebVttError)) throw error;
      expect(error.message).toBe('UNSUPPORTED_CUE_MARKUP');
      expect(error.message).not.toContain('synthetic-secret');
      expect(Object.keys(error)).toEqual(['code', 'name']);
    }
  });
});
