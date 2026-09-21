import { trackAggregatesSchema, type RecordedTrack } from '@workout/contracts/tracks';
import { describe, expect, it } from 'vitest';
import { trackAggregates } from '../src/aggregate';
import { MAX_DISPLAY_LATITUDE } from '../src/geo';
import { parseTrackFile } from './sync-parse';
import { buildMapPath } from '../src/path';
import { fitFile, recordMessage, sessionMessage } from './fit-fixture';

const GPX11 = 'http://www.topografix.com/GPX/1/1';
const wrap = (body: string): Uint8Array =>
  new TextEncoder().encode(`<gpx version="1.1" xmlns="${GPX11}">${body}</gpx>`);
const at = (seconds: number): string =>
  new Date(Date.parse('2026-03-01T00:00:00Z') + seconds * 1000).toISOString();
const trkpt = (longitude: number, latitude: number, seconds?: number, heartRate?: number): string =>
  `<trkpt lat="${latitude}" lon="${longitude}">` +
  (seconds === undefined ? '' : `<time>${at(seconds)}</time>`) +
  (heartRate === undefined ? '' : `<extensions><gpxtpx:hr>${heartRate}</gpxtpx:hr></extensions>`) +
  `</trkpt>`;

const firstTrack = (body: string): RecordedTrack => {
  const track = parseTrackFile(wrap(body)).recorded[0];
  if (!track) throw new Error('fixture produced no recorded track');
  return track;
};

/** A wiggly but continuous line: neighbours stay well inside the gap policy. */
const wiggle = (count: number): string => {
  const points = Array.from({ length: count }, (_, index) => {
    const longitude = 127 + index * 0.00012;
    const latitude = 37.5 + Math.sin(index / 3) * 0.00002 + index * 0.000001;
    return trkpt(Number(longitude.toFixed(7)), Number(latitude.toFixed(7)), index, 140);
  });
  return `<trk><trkseg>${points.join('')}</trkseg></trk>`;
};

describe('normalization rules', () => {
  it('renders a trkseg break as two segments and a single-point segment as a point', () => {
    const track = firstTrack(
      `<trk><trkseg>${trkpt(127, 37.5, 0, 130)}${trkpt(127.0001, 37.5, 1, 131)}</trkseg>` +
        `<trkseg>${trkpt(127.0002, 37.5, 2, 132)}</trkseg></trk>`,
    );
    const path = buildMapPath(track);
    expect(path.geometry.coordinates).toHaveLength(1);
    expect(path.points).toEqual([{ segmentIndex: 1, sampleId: '0:2', position: [127.0002, 37.5] }]);
    expect(path.insufficient).toEqual([
      { segmentIndex: 1, reason: 'single-point', sampleIds: ['0:2'] },
    ]);
    // The single point is never drawn as a line back to the previous segment.
    expect(path.geometry.coordinates[0]).toEqual([
      [127, 37.5],
      [127.0001, 37.5],
    ]);
  });

  it('reports a single-point recording as a point, not a line', () => {
    const track = firstTrack(`<trk><trkseg>${trkpt(127, 37.5, 0)}</trkseg></trk>`);
    const path = buildMapPath(track);
    expect(path.geometry.coordinates).toEqual([]);
    expect(path.points).toHaveLength(1);
    expect(path.insufficient[0]?.reason).toBe('single-point');
    expect(path.displayedPolylineLengthMeters).toBeNull();
  });

  it('splits an antimeridian crossing instead of drawing a line across the globe', () => {
    const track = firstTrack(
      `<trk><trkseg>${trkpt(179.9999, 37.5, 0)}${trkpt(-179.9999, 37.5, 1)}</trkseg></trk>`,
    );
    expect(track.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'antimeridian-crossing',
    ]);
    const path = buildMapPath(track);
    expect(path.crossesAntimeridian).toBe(true);
    expect(path.geometry.coordinates).toEqual([]);
    expect(path.points).toHaveLength(2);
  });

  it('flags positions beyond the web-mercator display latitude', () => {
    const polar = MAX_DISPLAY_LATITUDE + 1;
    const track = firstTrack(
      `<trk><trkseg>${trkpt(15, polar, 0)}${trkpt(15.0001, polar, 1)}</trkseg></trk>`,
    );
    expect(buildMapPath(track).outsideDisplayLatitude).toBe(true);
    const seoul = firstTrack(
      `<trk><trkseg>${trkpt(127, 37.5, 0)}${trkpt(127.0001, 37.5, 1)}</trkseg></trk>`,
    );
    expect(buildMapPath(seoul).outsideDisplayLatitude).toBe(false);
  });

  it('accepts repeated identical coordinates without splitting or inventing motion', () => {
    const track = firstTrack(
      `<trk><trkseg>${trkpt(127, 37.5, 0)}${trkpt(127, 37.5, 1)}${trkpt(127, 37.5, 2)}</trkseg></trk>`,
    );
    expect(track.segments).toHaveLength(1);
    expect(track.distances.recomputedFromPositionsMeters).toBe(0);
    expect(buildMapPath(track).displayedPolylineLengthMeters).toBe(0);
  });

  it('produces identical sample ids and output when the same bytes are parsed twice', () => {
    const bytes = wrap(wiggle(20));
    expect(JSON.stringify(parseTrackFile(bytes))).toBe(JSON.stringify(parseTrackFile(bytes)));
  });

  it('device, recomputed and displayed distances are three separate values', () => {
    const track = firstTrack(wiggle(200));
    const aggregates = trackAggregates(track);
    const coarse = buildMapPath(track, { toleranceMeters: 50 });
    expect(aggregates.deviceDistanceMeters).toBeNull(); // GPX `trk` reports no device total.
    expect(aggregates.recomputedDistanceMeters).toBeGreaterThan(0);
    expect(coarse.displayedPolylineLengthMeters).not.toBe(aggregates.recomputedDistanceMeters);
    expect(aggregates.averagePaceSecondsPerKilometer).toBeNull(); // No device distance, no pace.
  });

  it('simplification and level-of-detail changes leave every aggregate identical', () => {
    const track = firstTrack(wiggle(400));
    const before = trackAggregates(track);
    const snapshot = JSON.stringify(track);
    const paths = [0, 1, 5, 20, 100].map((toleranceMeters) =>
      buildMapPath(track, { toleranceMeters }),
    );
    const after = trackAggregates(track);
    expect(after).toEqual(before);
    expect(JSON.stringify(track)).toBe(snapshot); // The track itself is never mutated.
    const vertexCounts = paths.map((path) => path.geometry.coordinates[0]?.length ?? 0);
    expect(vertexCounts[0]).toBe(400);
    expect(new Set(vertexCounts).size).toBeGreaterThan(1); // The LOD really changed.
    expect(vertexCounts.at(-1)).toBeLessThan(400);
    for (const path of paths) {
      // Endpoints survive every tolerance, and each vertex still names its source sample.
      expect(path.vertexSampleIds[0]?.at(0)).toBe('0:0');
      expect(path.vertexSampleIds[0]?.at(-1)).toBe('0:399');
      expect(path.vertexSampleIds[0]?.length).toBe(path.geometry.coordinates[0]?.length);
      expect(trackAggregates(track)).toEqual(before);
    }
    // Only the displayed line length moves with the tolerance.
    const lengths = paths.map((path) => path.displayedPolylineLengthMeters);
    expect(new Set(lengths).size).toBeGreaterThan(1);
  });

  it('maps display vertices back to source samples rather than reusing display indices', () => {
    const track = firstTrack(wiggle(50));
    const path = buildMapPath(track, { toleranceMeters: 10 });
    const ids = path.vertexSampleIds[0] ?? [];
    const sourceIndices = ids.map((id) => Number(id.split(':')[1]));
    expect(sourceIndices.length).toBeLessThan(50);
    expect(sourceIndices).toEqual([...sourceIndices].sort((a, b) => a - b));
    expect(sourceIndices.at(-1)).toBe(49);
    for (const [vertex, id] of ids.entries()) {
      const sample = track.samples.find((candidate) => candidate.sampleId === id);
      expect(path.geometry.coordinates[0]?.[vertex]).toEqual(sample?.position);
    }
  });
});

describe('samples without coordinates', () => {
  /** Only FIT can carry an observation with measurements but no fix; GPX `trkpt` cannot. */
  const withGap = () =>
    parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
        recordMessage({
          at: '2026-03-01T00:00:00Z',
          longitude: 127,
          latitude: 37.5,
          heartRate: 140,
        }),
        recordMessage({
          at: '2026-03-01T00:00:01Z',
          longitude: 127.0001,
          latitude: 37.5,
          heartRate: 141,
        }),
        recordMessage({ at: '2026-03-01T00:00:02Z', heartRate: 142, distanceMeters: 25 }),
        recordMessage({ at: '2026-03-01T00:00:03Z', heartRate: 143, distanceMeters: 33 }),
        recordMessage({
          at: '2026-03-01T00:00:04Z',
          longitude: 127.0004,
          latitude: 37.5,
          heartRate: 144,
        }),
        recordMessage({
          at: '2026-03-01T00:00:05Z',
          longitude: 127.0005,
          latitude: 37.5,
          heartRate: 145,
        }),
      ]),
    );

  it('keeps an unpositioned sample with its measurements and never fills the gap', () => {
    const track = withGap().recorded[0];
    if (!track) throw new Error('fixture produced no recorded track');
    expect(track.samples).toHaveLength(6);
    const unpositioned = track.samples.filter((sample) => sample.position === null);
    expect(unpositioned.map((sample) => sample.sampleId)).toEqual(['0:2', '0:3']);
    expect(unpositioned.map((sample) => sample.heartRateBpm)).toEqual([142, 143]);
    expect(unpositioned.map((sample) => sample.distanceMeters)).toEqual([25, 33]);
    expect(unpositioned.every((sample) => sample.recordedAt !== null)).toBe(true);
    // Three segments: positioned, unpositioned, positioned. Nothing is dropped or joined.
    expect(track.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'missing-position',
      'missing-position',
    ]);
    expect(track.segments.map((segment) => segment.sampleIds)).toEqual([
      ['0:0', '0:1'],
      ['0:2', '0:3'],
      ['0:4', '0:5'],
    ]);
  });

  it('reports the gap as an insufficient segment and never bridges the two lines', () => {
    const track = withGap().recorded[0];
    if (!track) throw new Error('fixture produced no recorded track');
    const path = buildMapPath(track);
    expect(path.geometry.coordinates).toHaveLength(2);
    expect(path.lineSegmentIndices).toEqual([0, 2]);
    expect(path.insufficient).toEqual([
      { segmentIndex: 1, reason: 'no-position', sampleIds: ['0:2', '0:3'] },
    ]);
    expect(path.points).toEqual([]);
    // No vertex joins the sample before the gap to the sample after it.
    expect(path.vertexSampleIds).toEqual([
      ['0:0', '0:1'],
      ['0:4', '0:5'],
    ]);
    // The recomputed distance ignores the pair that straddles the gap.
    const aggregates = trackAggregates(track);
    expect(aggregates.positionedSampleCount).toBe(4);
    expect(aggregates.recomputedDistanceMeters).toBeLessThan(30);
  });
});

describe('aggregates satisfy the published contract', () => {
  it('validates against trackAggregatesSchema', () => {
    const track = firstTrack(wiggle(10));
    expect(trackAggregatesSchema.safeParse(trackAggregates(track)).success).toBe(true);
  });
});
