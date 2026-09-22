import { describe, expect, it } from 'vitest';
import { TrackIngestionError } from '../src/limits';
import { parseTrackFile } from './sync-parse';

const GPX11 = 'http://www.topografix.com/GPX/1/1';
const encode = (xml: string): Uint8Array => new TextEncoder().encode(xml);
const gpx = (body: string, namespace = GPX11): string =>
  `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="${namespace}">${body}</gpx>`;
const point = (longitude: number, latitude: number, time?: string, extra = ''): string =>
  `<trkpt lat="${latitude}" lon="${longitude}">${time ? `<time>${time}</time>` : ''}${extra}</trkpt>`;

const parse = (xml: string, filename?: string) =>
  parseTrackFile(encode(xml), filename === undefined ? {} : { filename });

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof TrackIngestionError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
};

describe('GPX track parsing', () => {
  /**
   * `creator` is a fact about the file and decides nothing in it, so a value this parser
   * cannot make safe is absent rather than a reason to refuse the upload.
   *
   * This matters beyond the course import that reads it: the same parser is the activity
   * track upload path, where nothing reads `creator` at all. Treating it strictly made
   * `creator="Foo &gt; Bar"` (the attribute is entity-decoded, so the value really is
   * `Foo > Bar`) and any creator over the metadata length refuse the whole file.
   */
  describe('the creator attribute', () => {
    const withCreator = (creator: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="${GPX11}" creator="${creator}">` +
      `<trk><trkseg>${point(127, 37)}${point(127.001, 37.001)}</trkseg></trk></gpx>`;

    it('keeps a plain creator', () => {
      expect(parse(withCreator('Garmin Connect')).creator).toBe('Garmin Connect');
    });

    it('is absent, not a refusal, when the value carries angle brackets', () => {
      // The XML attribute is entity-decoded before this is reached.
      const file = parse(withCreator('Foo &gt; Bar'));
      expect(file.creator).toBeNull();
      expect(file.recorded).toHaveLength(1);
    });

    it('is absent, not a refusal, when the value is longer than metadata text may be', () => {
      const file = parse(withCreator('a'.repeat(400)));
      expect(file.creator).toBeNull();
      expect(file.recorded).toHaveLength(1);
    });

    it('is absent when the file names no creator at all', () => {
      expect(
        parse(gpx(`<trk><trkseg>${point(127, 37)}${point(127.001, 37.001)}</trkseg></trk>`))
          .creator,
      ).toBeNull();
    });

    it('still refuses a filename that cannot be made safe', () => {
      // The strict rule is unchanged for the fields the product uses as text.
      expect(
        code(() =>
          parse(
            gpx(`<trk><trkseg>${point(127, 37)}${point(127.001, 37.001)}</trkseg></trk>`),
            'a'.repeat(400),
          ),
        ),
      ).toBe('TRACK_TEXT_UNSAFE');
    });
  });

  it('blocks DOCTYPE and external entity declarations (XXE)', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      `<gpx xmlns="${GPX11}"><trk><trkseg>${point(127, 37)}</trkseg></trk></gpx>`;
    expect(code(() => parse(xxe))).toBe('TRACK_XML_DTD_BLOCKED');
  });

  it('blocks a reference to a custom entity even without a DOCTYPE', () => {
    expect(code(() => parse(gpx('<trk><name>&xxe;</name></trk>')))).toBe(
      'TRACK_XML_ENTITY_BLOCKED',
    );
  });

  it('requires a GPX root element and a known GPX namespace', () => {
    expect(code(() => parse('<kml><Placemark/></kml>'))).toBe('TRACK_GPX_INVALID_ROOT');
    expect(code(() => parse('<gpx version="1.1"><trk/></gpx>'))).toBe('TRACK_GPX_INVALID_ROOT');
    const legacy = parse(
      gpx(
        `<trk><trkseg>${point(127, 37)}${point(127.0001, 37)}</trkseg></trk>`,
        'http://www.topografix.com/GPX/1/0',
      ),
    );
    expect(legacy.recorded).toHaveLength(1);
  });

  it('keeps each trkseg as its own segment', () => {
    const file = parse(
      gpx(
        `<trk><name>Morning</name>` +
          `<trkseg>${point(127, 37, '2026-03-01T00:00:00Z')}${point(127.0001, 37, '2026-03-01T00:00:01Z')}</trkseg>` +
          `<trkseg>${point(127.001, 37, '2026-03-01T00:00:02Z')}${point(127.0011, 37, '2026-03-01T00:00:03Z')}</trkseg>` +
          `</trk>`,
      ),
    );
    const track = file.recorded[0];
    expect(track?.name).toBe('Morning');
    expect(track?.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'gpx-trkseg',
    ]);
    expect(track?.segments.map((segment) => segment.sampleIds)).toEqual([
      ['0:0', '0:1'],
      ['0:2', '0:3'],
    ]);
  });

  it('never promotes a route or a waypoint into a recorded track', () => {
    const file = parse(
      gpx(
        `<wpt lat="37.1" lon="127.1"><name>Gate</name></wpt>` +
          `<rte><name>Planned</name><rtept lat="37.2" lon="127.2"/><rtept lat="37.3" lon="127.3"/></rte>`,
      ),
    );
    expect(file.recorded).toHaveLength(0);
    expect(file.routes).toHaveLength(1);
    expect(file.routes[0]?.sourceKind).toBe('gpx-rte');
    expect(file.waypoints).toHaveLength(1);
    expect(file.requiresSelection).toBe(false);
  });

  it('requires explicit selection when a file holds several tracks', () => {
    const file = parse(
      gpx(
        `<trk><trkseg>${point(127, 37)}${point(127.0001, 37)}</trkseg></trk>` +
          `<trk><trkseg>${point(128, 38)}${point(128.0001, 38)}</trkseg></trk>`,
      ),
    );
    expect(file.recorded).toHaveLength(2);
    expect(file.requiresSelection).toBe(true);
    expect(file.recorded[1]?.samples[0]?.sampleId).toBe('1:0');
  });

  it('rejects out-of-range and non-finite coordinates', () => {
    expect(code(() => parse(gpx(`<trk><trkseg><trkpt lat="91" lon="127"/></trkseg></trk>`)))).toBe(
      'TRACK_COORDINATE_INVALID',
    );
    expect(code(() => parse(gpx(`<trk><trkseg><trkpt lat="37" lon="181"/></trkseg></trk>`)))).toBe(
      'TRACK_COORDINATE_INVALID',
    );
    expect(code(() => parse(gpx(`<trk><trkseg><trkpt lat="37" lon="NaN"/></trkseg></trk>`)))).toBe(
      'TRACK_COORDINATE_INVALID',
    );
  });

  it('splits on time reversal, duplicate timestamps and long time gaps', () => {
    const file = parse(
      gpx(
        `<trk><trkseg>` +
          point(127, 37, '2026-03-01T00:00:00Z') +
          point(127.00001, 37, '2026-03-01T00:00:01Z') +
          point(127.00002, 37, '2026-03-01T00:00:01Z') +
          point(127.00003, 37, '2026-03-01T00:00:00Z') +
          point(127.00004, 37, '2026-03-01T01:00:00Z') +
          `</trkseg></trk>`,
      ),
    );
    expect(file.recorded[0]?.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'duplicate-timestamp',
      'time-reversal',
      'time-gap',
    ]);
    expect(file.recorded[0]?.samples).toHaveLength(5);
  });

  it('rejects angle brackets that survive entity decoding in metadata', () => {
    expect(
      code(() => parse(gpx(`<trk><name>&lt;script&gt;alert(1)&lt;/script&gt;</name></trk>`))),
    ).toBe('TRACK_TEXT_UNSAFE');
  });

  it('strips control and bidi characters from the original filename', () => {
    const file = parse(
      gpx(`<trk><trkseg>${point(127, 37)}${point(127.0001, 37)}</trkseg></trk>`),
      'ri\u0000de\u202E.gpx',
    );
    expect(file.originalFilename).toBe('ride.gpx');
  });

  it('enforces XML depth and text node limits', () => {
    const deep = `${'<a>'.repeat(40)}${'</a>'.repeat(40)}`;
    expect(code(() => parse(gpx(deep)))).toBe('TRACK_XML_DEPTH_LIMIT');
    const long = 'x'.repeat(70_000);
    expect(code(() => parse(gpx(`<trk><name>${long}</name></trk>`)))).toBe('TRACK_XML_TEXT_LIMIT');
  });

  it('reads CDATA names and heart rate extensions', () => {
    const file = parse(
      gpx(
        `<trk><name><![CDATA[Night run]]></name><trkseg>` +
          point(
            127,
            37,
            '2026-03-01T00:00:00Z',
            '<extensions><gpxtpx:TrackPointExtension xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">' +
              '<gpxtpx:hr>151</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>',
          ) +
          point(127.0001, 37, '2026-03-01T00:00:01Z') +
          `</trkseg></trk>`,
      ),
    );
    expect(file.recorded[0]?.name).toBe('Night run');
    expect(file.recorded[0]?.samples[0]?.heartRateBpm).toBe(151);
    expect(file.recorded[0]?.samples[1]?.heartRateBpm).toBeNull();
  });

  it('rejects malformed markup instead of guessing', () => {
    expect(code(() => parse(gpx('<trk><trkseg>')))).toBe('TRACK_XML_MALFORMED');
    expect(
      code(() =>
        parse(
          gpx(
            `<trk><trkseg><trkpt lat="37" lon="127"><time>yesterday</time></trkpt></trkseg></trk>`,
          ),
        ),
      ),
    ).toBe('TRACK_XML_MALFORMED');
  });
});

describe('GPX empty values and namespace scope (peer review findings)', () => {
  it('rejects blank coordinates instead of reading them as 0', () => {
    expect(code(() => parse(gpx(`<trk><trkseg><trkpt lat="" lon=" "/></trkseg></trk>`)))).toBe(
      'TRACK_COORDINATE_INVALID',
    );
    expect(code(() => parse(gpx(`<trk><trkseg><trkpt lat="37"/></trkseg></trk>`)))).toBe(
      'TRACK_COORDINATE_INVALID',
    );
  });

  it('keeps blank optional measurements null rather than 0', () => {
    const file = parse(
      gpx(
        `<trk><trkseg>` +
          `<trkpt lat="37.5" lon="127"><ele/><time/><extensions><gpxtpx:hr/></extensions></trkpt>` +
          `<trkpt lat="37.5001" lon="127"><ele>  </ele></trkpt>` +
          `</trkseg></trk>`,
      ),
    );
    const samples = file.recorded[0]?.samples ?? [];
    expect(samples).toHaveLength(2);
    for (const sample of samples) {
      expect(sample.elevationMeters).toBeNull();
      expect(sample.heartRateBpm).toBeNull();
      expect(sample.recordedAt).toBeNull();
    }
    // The coordinates themselves are real values, not defaults.
    expect(samples[0]?.position).toEqual([127, 37.5]);
  });

  it('resolves the root namespace by scope, not by any declaration present', () => {
    // `evil:gpx` is NOT in the GPX namespace even though GPX is declared on another prefix.
    expect(
      code(() =>
        parse(
          `<evil:gpx xmlns:evil="http://example.invalid/evil" xmlns:gpx="${GPX11}">` +
            `<trk><trkseg>${point(127, 37)}${point(127.0001, 37)}</trkseg></trk></evil:gpx>`,
        ),
      ),
    ).toBe('TRACK_GPX_INVALID_ROOT');
    // A properly prefixed GPX root is accepted.
    const prefixed = parse(
      `<gpx:gpx xmlns:gpx="${GPX11}"><gpx:trk><gpx:trkseg>` +
        `<gpx:trkpt lat="37" lon="127"/><gpx:trkpt lat="37" lon="127.0001"/>` +
        `</gpx:trkseg></gpx:trk></gpx:gpx>`,
    );
    expect(prefixed.recorded).toHaveLength(1);
    expect(prefixed.recorded[0]?.samples).toHaveLength(2);
  });

  it('rejects a second root document element', () => {
    expect(
      code(() =>
        parse(
          `${gpx(`<trk><trkseg>${point(127, 37)}${point(127.0001, 37)}</trkseg></trk>`)}` +
            gpx(`<trk><trkseg>${point(128, 38)}${point(128.0001, 38)}</trkseg></trk>`),
        ),
      ),
    ).toBe('TRACK_GPX_INVALID_ROOT');
  });

  it('rejects track points outside their required parent elements', () => {
    expect(code(() => parse(gpx(`<trkpt lat="37" lon="127"/>`)))).toBe('TRACK_XML_MALFORMED');
    expect(code(() => parse(gpx(`<trk>${`<trkpt lat="37" lon="127"/>`}</trk>`)))).toBe(
      'TRACK_XML_MALFORMED',
    );
    expect(code(() => parse(gpx(`<trkseg><trkpt lat="37" lon="127"/></trkseg>`)))).toBe(
      'TRACK_XML_MALFORMED',
    );
    expect(code(() => parse(gpx(`<rte><trkpt lat="37" lon="127"/></rte>`)))).toBe(
      'TRACK_XML_MALFORMED',
    );
  });

  it('ignores same-named elements from a foreign namespace', () => {
    const file = parse(
      `<gpx version="1.1" xmlns="${GPX11}" xmlns:x="http://example.invalid/x">` +
        `<x:trk><x:trkseg><x:trkpt lat="37" lon="127"/></x:trkseg></x:trk>` +
        `<trk><trkseg>${point(127, 37)}${point(127.0001, 37)}</trkseg></trk></gpx>`,
    );
    expect(file.recorded).toHaveLength(1);
    expect(file.recorded[0]?.samples).toHaveLength(2);
  });
});

const TPE_V1 = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
const TPE_V2 = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v2';

describe('nested roots and extension namespaces (second review)', () => {
  it('rejects a nested gpx root instead of letting it replace the open track', () => {
    const nested = gpx(
      `<trk><name>A</name><trkseg>${point(127, 37, '2026-03-01T00:00:00Z')}` +
        `${point(127.0001, 37, '2026-03-01T00:00:01Z')}</trkseg>` +
        `<gpx xmlns="${GPX11}"><trk><name>B</name><trkseg>${point(128, 38)}${point(128.0001, 38)}` +
        `</trkseg></trk></gpx></trk>`,
    );
    expect(code(() => parse(nested))).toBe('TRACK_GPX_INVALID_ROOT');
  });

  it('refuses to start a second track or point while one is open', () => {
    expect(code(() => parse(gpx(`<trk><trk>${`<trkseg/>`}</trk></trk>`)))).toBe(
      'TRACK_XML_MALFORMED',
    );
    expect(
      code(() =>
        parse(
          gpx(
            `<trk><trkseg><trkpt lat="37" lon="127"><trkpt lat="38" lon="128"/></trkpt></trkseg></trk>`,
          ),
        ),
      ),
    ).toBe('TRACK_XML_MALFORMED');
  });

  it('reads heart rate only from the Garmin TrackPointExtension namespace and structure', () => {
    const withExtension = (body: string): number | null | undefined =>
      parse(
        gpx(
          `<trk><trkseg>` +
            `<trkpt lat="37.5" lon="127">${body}</trkpt>` +
            `<trkpt lat="37.5001" lon="127"/>` +
            `</trkseg></trk>`,
        ),
      ).recorded[0]?.samples[0]?.heartRateBpm;
    for (const namespace of [TPE_V1, TPE_V2])
      expect(
        withExtension(
          `<extensions><gpxtpx:TrackPointExtension xmlns:gpxtpx="${namespace}">` +
            `<gpxtpx:hr>151</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`,
        ),
      ).toBe(151);
    // A foreign namespace is not Garmin's extension, whatever the element is called.
    expect(
      withExtension(
        `<extensions><x:TrackPointExtension xmlns:x="urn:evil"><x:hr>222</x:hr>` +
          `</x:TrackPointExtension></extensions>`,
      ),
    ).toBeNull();
    expect(withExtension(`<x:hr xmlns:x="urn:evil">222</x:hr>`)).toBeNull();
    // Right namespaces, but `extensions` is not a direct child of this track point.
    expect(
      withExtension(
        `<w:wrapper xmlns:w="urn:evil"><extensions>` +
          `<gpxtpx:TrackPointExtension xmlns:gpxtpx="${TPE_V1}"><gpxtpx:hr>222</gpxtpx:hr>` +
          `</gpxtpx:TrackPointExtension></extensions></w:wrapper>`,
      ),
    ).toBeNull();
    // Right namespace, wrong structure: no `extensions` parent.
    expect(
      withExtension(
        `<gpxtpx:TrackPointExtension xmlns:gpxtpx="${TPE_V1}"><gpxtpx:hr>222</gpxtpx:hr>` +
          `</gpxtpx:TrackPointExtension>`,
      ),
    ).toBeNull();
  });
});
