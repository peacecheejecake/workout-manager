import type { RecordedTrack } from '@workout/contracts/tracks';
import { describe, expect, it } from 'vitest';
import { trackAggregates } from '../src/aggregate';
import { buildMapPath } from '../src/path';
import { fitFile, recordMessage, sessionMessage } from './fit-fixture';
import { parseTrackFile } from './sync-parse';

/**
 * P8-contract-parser (map plan §8): "날짜 경계". A recording that runs across a UTC midnight,
 * a local midnight, a year end or a leap day is one recording: instants are compared as
 * instants, never as their text or their calendar date, and the wire text is kept exactly.
 */
const GPX11 = 'http://www.topografix.com/GPX/1/1';
const gpx = (times: readonly string[]): Uint8Array =>
  new TextEncoder().encode(
    `<gpx version="1.1" xmlns="${GPX11}"><trk><trkseg>` +
      times
        .map(
          (time, index) =>
            `<trkpt lat="${(37.5 + index * 0.00005).toFixed(5)}" lon="127"><time>${time}</time></trkpt>`,
        )
        .join('') +
      `</trkseg></trk></gpx>`,
  );
const first = (bytes: Uint8Array): RecordedTrack => {
  const track = parseTrackFile(bytes).recorded[0];
  if (!track) throw new Error('fixture produced no recorded track');
  return track;
};

describe('recordings across date boundaries', () => {
  it('keeps a year-end crossing written in several offsets as one continuous line', () => {
    const times = [
      '2025-12-31T23:59:58Z',
      '2026-01-01T08:59:59+09:00', // 2025-12-31T23:59:59Z: a later calendar date, same year end
      '2026-01-01T00:00:00Z',
      '2025-12-31T19:00:01-05:00', // 2026-01-01T00:00:01Z: an earlier calendar date
      '2026-01-01T00:00:02.500Z',
    ];
    const track = first(gpx(times));
    expect(track.segments.map((segment) => segment.startReason)).toEqual(['stream-start']);
    expect(track.segments[0]?.sampleIds).toHaveLength(5);
    // The wire text is kept exactly: no offset is rewritten, no date is re-rendered.
    expect(track.samples.map((sample) => sample.recordedAt)).toEqual(times);
    const aggregates = trackAggregates(track);
    expect(aggregates.elapsedSeconds).toBe(4.5);
    expect(buildMapPath(track).geometry.coordinates).toHaveLength(1);
  });

  it('breaks where the instant goes back or repeats, whatever the text says', () => {
    const track = first(
      gpx([
        '2026-03-01T23:59:59Z',
        '2026-03-02T00:00:00Z',
        // Lexically later, but 2026-03-01T15:00:00Z: the clock went back across midnight.
        '2026-03-02T00:00:00+09:00',
        // The same instant as the previous sample, written in another offset.
        '2026-03-01T15:00:00Z',
      ]),
    );
    expect(track.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'time-reversal',
      'duplicate-timestamp',
    ]);
    expect(track.segments.map((segment) => segment.sampleIds)).toEqual([
      ['0:0', '0:1'],
      ['0:2'],
      ['0:3'],
    ]);
  });

  it('keeps a leap day and a local midnight inside one recording', () => {
    const times = [
      '2028-02-29T23:59:59Z',
      '2028-03-01T00:00:00Z',
      '2028-03-01T09:00:01+09:00', // local midnight in Seoul already passed; UTC 00:00:01
    ];
    const track = first(gpx(times));
    expect(track.segments).toHaveLength(1);
    expect(track.samples.map((sample) => sample.recordedAt)).toEqual(times);
    expect(trackAggregates(track).elapsedSeconds).toBe(2);
  });

  it('turns FIT seconds across a year end into the exact UTC instants', () => {
    const at = ['2025-12-31T23:59:58.000Z', '2025-12-31T23:59:59.000Z', '2026-01-01T00:00:00.000Z'];
    const track = first(
      fitFile([
        sessionMessage({ startedAt: at[0] ?? '', elapsedSeconds: 2 }),
        ...at.map((instant, index) =>
          recordMessage({ at: instant, longitude: 127, latitude: 37.5 + index * 0.00005 }),
        ),
      ]),
    );
    expect(track.samples.map((sample) => sample.recordedAt)).toEqual(at);
    expect(track.segments).toHaveLength(1);
    expect(trackAggregates(track).elapsedSeconds).toBe(2);
  });
});
