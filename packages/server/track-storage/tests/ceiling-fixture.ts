import type { StoredTrackSelection } from '../src/artifacts.js';

/**
 * The one input the heap-ceiling tests share (M2-01aw).
 *
 * Those tests need bytes that end in two *different* codes depending only on the heap
 * ceiling: `TRACK_OUTPUT_TOO_LARGE` with headroom (the parser's 8 MiB output bound), and
 * `TRACK_PARSE_MEMORY_EXCEEDED` under {@link CEILING_TEST_HEAP_MEGABYTES}. Which one a run
 * sees is decided by whether V8 runs out of heap before the normalizer has charged 8 MiB of
 * output — so the live heap the parse needs by then must be far above the tight ceiling,
 * not near it.
 *
 * The earlier fixture (60,000 points) was near it. Measured on Node 24.12.0 (arm64): at a
 * 32 MiB ceiling it died with ~30.9 MiB live ("Ineffective mark-compacts near heap limit"),
 * and at 33 MiB it parsed to `TRACK_OUTPUT_TOO_LARGE` — under 1 MiB of margin, which GC
 * timing on a loaded machine could close (M2-01aw). At 150,000 points the same parse needs
 * ~57 MiB before the output bound is reached (56 MiB: memory code, 58 MiB: output code),
 * so the 32 MiB ceiling is ~25 MiB short of it. {@link CEILING_MARGIN_PROBE_MEGABYTES} pins
 * that margin in a test: the fixture must still end in the memory code there.
 *
 * It stays inside every other bound, so nothing else can end it first: 150,000 samples
 * (limit 200,000), ~12.7 MB of file (limit 32 MiB), about 0.6 s of parsing with headroom
 * (parser budget 5 s), and the output bound is reached part-way through normalization.
 */
export const CEILING_FIXTURE_POINTS = 150_000;
/** The tight ceiling the tests parse the fixture under. */
export const CEILING_TEST_HEAP_MEGABYTES = 32;
/**
 * A ceiling a quarter above the tight one. The fixture must still run out of heap here; the
 * old 60,000-point fixture reaches the output bound at 33 MiB already.
 */
export const CEILING_MARGIN_PROBE_MEGABYTES = 40;

export const ceilingSelection: StoredTrackSelection = {
  recordedTrackIndex: 0,
  provenance: {
    kind: 'activity-source',
    activityId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    sourceRevision: 1,
    trackRevision: 1,
  },
};

export function ceilingFixtureBytes(points: number = CEILING_FIXTURE_POINTS): Uint8Array {
  let body = '';
  for (let index = 0; index < points; index += 1) {
    const at = new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString();
    body += `<trkpt lat="${37.5 + index / 1e6}" lon="${127 + index / 1e6}"><time>${at}</time></trkpt>`;
  }
  return new TextEncoder().encode(
    `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${body}</trkseg></trk></gpx>`,
  );
}
