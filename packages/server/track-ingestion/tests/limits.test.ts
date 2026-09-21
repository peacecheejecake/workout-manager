import { describe, expect, it } from 'vitest';
import {
  createBoundedParserPool,
  defaultTrackParseLimits,
  resolveTrackParseLimits,
  TrackIngestionError,
  type TrackParseLimits,
} from '../src/limits.js';
import { parseTrackFile } from '../src/parse.js';
import { fitFile, recordMessage, sessionMessage } from './fit-fixture.js';

const GPX11 = 'http://www.topografix.com/GPX/1/1';
const gpx = (body: string): string => `<gpx version="1.1" xmlns="${GPX11}">${body}</gpx>`;
const point = (index: number): string =>
  `<trkpt lat="37.0" lon="${(127 + index / 100_000).toFixed(6)}"/>`;
const segment = (count: number, offset = 0): string =>
  `<trkseg>${Array.from({ length: count }, (_, index) => point(offset + index)).join('')}</trkseg>`;
const track = (body: string): string => `<trk>${body}</trk>`;

const parse = (xml: string, limits?: Partial<TrackParseLimits>): unknown =>
  parseTrackFile(new TextEncoder().encode(xml), limits === undefined ? {} : { limits });

/** Smallest limit value that still parses, by binary search over a monotone predicate. */
const smallestPassing = (passes: (value: number) => boolean, ceiling: number): number => {
  let low = 1;
  let high = ceiling;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (passes(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
};

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof TrackIngestionError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
};

describe('bounded parsing: each limit at the boundary and just past it', () => {
  it('file bytes', () => {
    const xml = gpx(track(segment(2)));
    const bytes = new TextEncoder().encode(xml);
    expect(code(() => parseTrackFile(bytes, { limits: { fileBytes: bytes.byteLength } }))).toBe(
      'no-error',
    );
    expect(code(() => parseTrackFile(bytes, { limits: { fileBytes: bytes.byteLength - 1 } }))).toBe(
      'TRACK_FILE_TOO_LARGE',
    );
  });

  it('allocation budget accounts for more than the input bytes and fails before allocating', () => {
    const bytes = new TextEncoder().encode(gpx(track(segment(40))));
    const passes = (parseMemoryBytes: number): boolean =>
      code(() => parseTrackFile(bytes, { limits: { parseMemoryBytes } })) === 'no-error';
    const threshold = smallestPassing(passes, defaultTrackParseLimits.parseMemoryBytes);
    // Boundary and just past it.
    expect(passes(threshold)).toBe(true);
    expect(code(() => parseTrackFile(bytes, { limits: { parseMemoryBytes: threshold - 1 } }))).toBe(
      'TRACK_PARSE_MEMORY_LIMIT',
    );
    // The point of the finding: the budget is not a comparison against the input size.
    // Decoded text and every sample are charged too, so the threshold is far above it.
    expect(threshold).toBeGreaterThan(bytes.byteLength * 3);
    // It also fires while parsing, not only at the very start.
    expect(code(() => parseTrackFile(bytes, { limits: { parseMemoryBytes: threshold - 1 } }))).toBe(
      'TRACK_PARSE_MEMORY_LIMIT',
    );
  });

  it('sample count', () => {
    expect(code(() => parse(gpx(track(segment(3))), { samples: 3 }))).toBe('no-error');
    expect(code(() => parse(gpx(track(segment(4))), { samples: 3 }))).toBe('TRACK_SAMPLE_LIMIT');
  });

  it('segment count', () => {
    const two = track(`${segment(2)}${segment(2, 10)}`);
    const three = track(`${segment(2)}${segment(2, 10)}${segment(2, 20)}`);
    expect(code(() => parse(gpx(two), { segments: 2 }))).toBe('no-error');
    expect(code(() => parse(gpx(three), { segments: 2 }))).toBe('TRACK_SEGMENT_LIMIT');
  });

  it('track count in one file', () => {
    const two = `${track(segment(2))}${track(segment(2, 10))}`;
    const three = `${two}${track(segment(2, 20))}`;
    expect(code(() => parse(gpx(two), { tracksPerFile: 2 }))).toBe('no-error');
    expect(code(() => parse(gpx(three), { tracksPerFile: 2 }))).toBe('TRACK_COUNT_LIMIT');
  });

  it('XML depth', () => {
    // gpx > trk > trkseg > trkpt is four levels; a self-closing element still occupies one.
    expect(code(() => parse(gpx(track(segment(2))), { xmlDepth: 4 }))).toBe('no-error');
    expect(code(() => parse(gpx(track(segment(2))), { xmlDepth: 3 }))).toBe(
      'TRACK_XML_DEPTH_LIMIT',
    );
  });

  it('XML text node bytes', () => {
    const name = (length: number): string => `<trk><name>${'x'.repeat(length)}</name></trk>`;
    // Attribute values are bounded by the same limit, so the namespace must still fit.
    expect(code(() => parse(gpx(name(64)), { xmlTextBytes: 64 }))).toBe('no-error');
    expect(code(() => parse(gpx(name(65)), { xmlTextBytes: 64 }))).toBe('TRACK_XML_TEXT_LIMIT');
  });

  it('metadata text length', () => {
    const name = (length: number): string =>
      `<trk><name>${'x'.repeat(length)}</name>${segment(2)}</trk>`;
    expect(code(() => parse(gpx(name(8)), { metadataTextLength: 8 }))).toBe('no-error');
    expect(code(() => parse(gpx(name(9)), { metadataTextLength: 8 }))).toBe('TRACK_TEXT_UNSAFE');
  });

  it('normalized output bytes are charged part by part, before the document exists', () => {
    const xml = gpx(track(segment(40)));
    const size = new TextEncoder().encode(JSON.stringify(parse(xml))).byteLength;
    const passes = (normalizedBytes: number): boolean =>
      code(() => parse(xml, { normalizedBytes })) === 'no-error';
    const threshold = smallestPassing(passes, defaultTrackParseLimits.normalizedBytes);
    expect(passes(threshold)).toBe(true);
    expect(code(() => parse(xml, { normalizedBytes: threshold - 1 }))).toBe(
      'TRACK_OUTPUT_TOO_LARGE',
    );
    // The running sum is a conservative over-estimate of the real document, so the limit
    // always fails before an oversized document could be built, never after.
    expect(threshold).toBeGreaterThanOrEqual(size);
    expect(threshold).toBeLessThan(size * 2);
  });

  it('parse time budget, with an injected clock', () => {
    const bytes = new TextEncoder().encode(gpx(track(segment(4))));
    const clock = (steps: number[]): (() => number) => {
      let index = 0;
      return () => steps[Math.min(index++, steps.length - 1)] ?? 0;
    };
    expect(
      code(() => parseTrackFile(bytes, { limits: { parseMilliseconds: 10 }, now: clock([0, 10]) })),
    ).toBe('no-error');
    expect(
      code(() => parseTrackFile(bytes, { limits: { parseMilliseconds: 10 }, now: clock([0, 11]) })),
    ).toBe('TRACK_PARSE_TIMEOUT');
  });

  it('FIT message count', () => {
    const bytes = fitFile([
      sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 10 }),
      recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
      recordMessage({ at: '2026-03-01T00:00:01Z', longitude: 127.0001, latitude: 37 }),
    ]);
    // Six record headers: every data message carries its own definition message.
    expect(code(() => parseTrackFile(bytes, { limits: { messages: 6 } }))).toBe('no-error');
    expect(code(() => parseTrackFile(bytes, { limits: { messages: 5 } }))).toBe(
      'TRACK_MESSAGE_LIMIT',
    );
  });

  it('refuses an override that would widen a contract limit', () => {
    expect(
      code(() => resolveTrackParseLimits({ samples: defaultTrackParseLimits.samples + 1 })),
    ).toBe('TRACK_FORMAT_UNSUPPORTED');
    expect(code(() => resolveTrackParseLimits({ xmlDepth: 0 }))).toBe('TRACK_FORMAT_UNSUPPORTED');
    expect(resolveTrackParseLimits({ samples: 10 }).samples).toBe(10);
  });

  it('worker concurrency is bounded and rejects work past the bound', async () => {
    const pool = createBoundedParserPool(2);
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = pool.run(() => blocked);
    const second = pool.run(() => blocked);
    expect(pool.active()).toBe(2);
    await expect(pool.run(() => 'third')).rejects.toMatchObject({ code: 'TRACK_PARSER_BUSY' });
    release();
    await Promise.all([first, second]);
    expect(pool.active()).toBe(0);
    await expect(pool.run(() => 'now free')).resolves.toBe('now free');
    expect(code(() => createBoundedParserPool(3))).toBe('TRACK_FORMAT_UNSUPPORTED');
  });
});

describe('the output budget stays at or above the real document (second review)', () => {
  const longName = 'n'.repeat(256);
  const escaped = 'a"b\\céü中';
  const cases: Record<string, string> = {
    'route with a maximum-length name': gpx(
      `<rte><name>${longName}</name><rtept lat="37" lon="127"/><rtept lat="37.1" lon="127.1"/></rte>`,
    ),
    'four thousand track points': gpx(track(segment(4_000))),
    'names that need JSON escaping': gpx(
      `<trk><name>${escaped}</name>${segment(20)}</trk>` +
        `<rte><name>${escaped}</name><rtept lat="37" lon="127"><name>${escaped}</name></rtept>` +
        `<rtept lat="37.1" lon="127.1"/></rte>` +
        `<wpt lat="37.2" lon="127.2"><name>${escaped}</name></wpt>`,
    ),
    'many tracks, routes and waypoints': gpx(
      Array.from({ length: 8 }, (_, index) => track(segment(10, index * 20))).join('') +
        Array.from(
          { length: 8 },
          () => `<rte><name>${longName}</name><rtept lat="37" lon="127"/></rte>`,
        ).join('') +
        Array.from(
          { length: 20 },
          (_, index) => `<wpt lat="37.${index}" lon="127.${index}"><name>${longName}</name></wpt>`,
        ).join(''),
    ),
  };

  it('stays tight for a segment-heavy document too', () => {
    // 2,000 single-point trksegs: 2,000 samples and 2,000 segments.
    const xml = gpx(
      `<trk>${Array.from({ length: 2_000 }, (_, index) => `<trkseg>${point(index)}</trkseg>`).join('')}</trk>`,
    );
    const size = new TextEncoder().encode(JSON.stringify(parse(xml))).byteLength;
    const threshold = smallestPassing(
      (normalizedBytes) => code(() => parse(xml, { normalizedBytes })) === 'no-error',
      defaultTrackParseLimits.normalizedBytes,
    );
    expect(threshold).toBeGreaterThanOrEqual(size);
    // Separators are charged between elements, not per element, so the gap stays tiny.
    expect(threshold - size).toBeLessThanOrEqual(8);
  });

  for (const [label, xml] of Object.entries(cases))
    it(`charges at least the produced bytes: ${label}`, () => {
      const size = new TextEncoder().encode(JSON.stringify(parse(xml))).byteLength;
      const threshold = smallestPassing(
        (normalizedBytes) => code(() => parse(xml, { normalizedBytes })) === 'no-error',
        defaultTrackParseLimits.normalizedBytes,
      );
      // The limit that just barely passes must not be below the document it produced,
      // otherwise a document larger than the limit could be returned.
      expect(threshold).toBeGreaterThanOrEqual(size);
      expect(code(() => parse(xml, { normalizedBytes: size - 1 }))).toBe('TRACK_OUTPUT_TOO_LARGE');
      // Still a useful bound rather than a wild over-estimate.
      expect(threshold - size).toBeLessThanOrEqual(8);
    });
});

describe('XML attribute and depth bypasses (second review)', () => {
  it('rejects a repeated attribute instead of letting it slip past the cap', () => {
    const repeated = `<gpx version="1.1" xmlns="${GPX11}" ${'dup="x" '.repeat(1_000)}/>`;
    expect(code(() => parse(repeated))).toBe('TRACK_XML_MALFORMED');
    expect(code(() => parse(`<gpx version="1.1" version="1.1" xmlns="${GPX11}"/>`))).toBe(
      'TRACK_XML_MALFORMED',
    );
  });

  it('applies the depth limit to self-closing elements', () => {
    // A GPX root holding one self-closing child: two levels deep, nothing to record.
    const nested = `<gpx version="1.1" xmlns="${GPX11}"><x/></gpx>`;
    expect(code(() => parse(nested, { xmlDepth: 2 }))).toBe('no-error');
    expect(code(() => parse(nested, { xmlDepth: 1 }))).toBe('TRACK_XML_DEPTH_LIMIT');
  });
});
