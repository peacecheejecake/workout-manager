import { describe, expect, it } from 'vitest';
import { TrackIngestionError } from '../src/limits';
import { parseTrackFile } from './sync-parse';
import { detectTrackFormat } from '../src/sanitize';
import { fitCrc } from '../src/fit';
import {
  compressedRecordMessage,
  fitFile,
  fitMessage,
  lapMessage,
  recordMessage,
  sessionMessage,
  timerStopMessage,
} from './fit-fixture';

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof TrackIngestionError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
};

describe('FIT track parsing', () => {
  it('converts semicircles to WGS84 degrees and keeps [longitude, latitude] order', () => {
    const file = parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127.05, latitude: 37.5 }),
        recordMessage({ at: '2026-03-01T00:00:01Z', longitude: 127.0501, latitude: 37.5001 }),
      ]),
    );
    const [track] = file.recorded;
    expect(track?.samples[0]?.position?.[0]).toBeCloseTo(127.05, 6);
    expect(track?.samples[0]?.position?.[1]).toBeCloseTo(37.5, 6);
    expect(track?.provenance.kind).toBe('local-file');
    expect(file.requiresSelection).toBe(false);
  });

  it('turns the invalid coordinate sentinel into null and keeps the other measurements', () => {
    const file = parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127.05, latitude: 37.5 }),
        recordMessage({ at: '2026-03-01T00:00:01Z', heartRate: 148, distanceMeters: 12.5 }),
        recordMessage({ at: '2026-03-01T00:00:02Z', longitude: 127.0502, latitude: 37.5002 }),
      ]),
    );
    const samples = file.recorded[0]?.samples ?? [];
    expect(samples).toHaveLength(3);
    expect(samples[1]?.position).toBeNull();
    expect(samples[1]?.heartRateBpm).toBe(148);
    expect(samples[1]?.distanceMeters).toBeCloseTo(12.5, 6);
    // The gap is not bridged: the neighbours end up in different segments.
    expect(file.recorded[0]?.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'missing-position',
      'missing-position',
    ]);
  });

  it('rejects a corrupt file CRC, a corrupt header CRC and a truncated stream', () => {
    const messages = [
      sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
      recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
    ];
    expect(code(() => parseTrackFile(fitFile(messages, { corruptFileCrc: true })))).toBe(
      'TRACK_FIT_INVALID',
    );
    expect(code(() => parseTrackFile(fitFile(messages, { corruptHeaderCrc: true })))).toBe(
      'TRACK_FIT_INVALID',
    );
    const truncated = fitFile(messages).subarray(0, 20);
    expect(code(() => parseTrackFile(truncated))).toBe('TRACK_FIT_INVALID');
  });

  it('does not trust the extension: a renamed text file is never read as FIT', () => {
    const bytes = new TextEncoder().encode('not a fit file at all, just text');
    expect(code(() => parseTrackFile(bytes, { filename: 'ride.fit' }))).toBe(
      'TRACK_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects archives instead of unpacking them', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(code(() => detectTrackFormat(zip))).toBe('TRACK_ARCHIVE_REJECTED');
    expect(code(() => parseTrackFile(zip, { filename: 'tracks.zip' }))).toBe(
      'TRACK_ARCHIVE_REJECTED',
    );
  });

  it('keeps two sessions as two tracks that require an explicit selection', () => {
    const file = parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 10 }),
        sessionMessage({ startedAt: '2026-03-01T01:00:00Z', elapsedSeconds: 10 }),
        recordMessage({ at: '2026-03-01T00:00:01Z', longitude: 127, latitude: 37 }),
        recordMessage({ at: '2026-03-01T00:00:02Z', longitude: 127.0001, latitude: 37 }),
        recordMessage({ at: '2026-03-01T01:00:01Z', longitude: 127.2, latitude: 37.2 }),
        recordMessage({ at: '2026-03-01T01:00:02Z', longitude: 127.2001, latitude: 37.2 }),
      ]),
    );
    expect(file.recorded).toHaveLength(2);
    expect(file.requiresSelection).toBe(true);
    expect(file.recorded[0]?.samples.map((sample) => sample.sampleId)).toEqual(['0:0', '0:1']);
    expect(file.recorded[1]?.samples.map((sample) => sample.sampleId)).toEqual(['0:2', '0:3']);
    expect(file.recorded[1]?.provenance).toMatchObject({ streamIndex: 0, sourceItemIndex: 1 });
  });

  it('refuses to guess an owner when a record belongs to no unique session', () => {
    expect(
      code(() =>
        parseTrackFile(
          fitFile([
            sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 10 }),
            sessionMessage({ startedAt: '2026-03-01T01:00:00Z', elapsedSeconds: 10 }),
            recordMessage({ at: '2026-03-01T00:30:00Z', longitude: 127, latitude: 37 }),
          ]),
        ),
      ),
    ).toBe('TRACK_SESSION_ASSIGNMENT_AMBIGUOUS');
  });

  it('starts a new segment after a timer stop event', () => {
    const file = parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
        timerStopMessage('2026-03-01T00:00:01Z'),
        recordMessage({ at: '2026-03-01T00:00:02Z', longitude: 127.0001, latitude: 37 }),
      ]),
    );
    expect(file.recorded[0]?.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'fit-event-stop',
    ]);
  });

  it('reports a file with no record messages instead of inventing a track', () => {
    expect(
      code(() => parseTrackFile(fitFile([sessionMessage({ startedAt: '2026-03-01T00:00:00Z' })]))),
    ).toBe('TRACK_NO_TRACK_DATA');
  });

  it('reads chained streams as separate tracks with disjoint sample ids', () => {
    const one = fitFile([
      sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 10 }),
      recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
      recordMessage({ at: '2026-03-01T00:00:01Z', longitude: 127.0001, latitude: 37 }),
    ]);
    const file = parseTrackFile(new Uint8Array([...one, ...one]));
    expect(file.recorded).toHaveLength(2);
    expect(file.recorded[0]?.samples[0]?.sampleId).toBe('0:0');
    expect(file.recorded[1]?.samples[0]?.sampleId).toBe('1:0');
    expect(file.requiresSelection).toBe(true);
  });

  it('keeps the device-reported distance apart from the recomputed distance', () => {
    const file = parseTrackFile(
      fitFile([
        sessionMessage({
          startedAt: '2026-03-01T00:00:00Z',
          elapsedSeconds: 10,
          distanceMeters: 1000,
        }),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
        recordMessage({ at: '2026-03-01T00:00:05Z', longitude: 127.001, latitude: 37 }),
      ]),
    );
    const distances = file.recorded[0]?.distances;
    expect(distances?.deviceReportedMeters).toBeCloseTo(1000, 6);
    expect(distances?.recomputedFromPositionsMeters).toBeGreaterThan(80);
    expect(distances?.recomputedFromPositionsMeters).toBeLessThan(100);
  });

  it('ignores an unknown message instead of failing the whole file', () => {
    const file = parseTrackFile(
      fitFile([
        fitMessage(23, [{ number: 0, baseType: 0x02, value: 4 }]),
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 10 }),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
      ]),
    );
    expect(file.recorded[0]?.samples).toHaveLength(1);
  });
});

describe('FIT integrity and event boundaries (peer review findings)', () => {
  const withStop = (eventType: number) =>
    parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
        timerStopMessage('2026-03-01T00:00:01Z', eventType),
        recordMessage({ at: '2026-03-01T00:00:02Z', longitude: 127.0001, latitude: 37 }),
      ]),
    );

  it('rejects a zeroed trailer CRC: the omitted-CRC rule is the header rule only', () => {
    const messages = [
      sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
      recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
      recordMessage({ at: '2026-03-01T00:00:01Z', longitude: 127.0001, latitude: 37 }),
    ];
    expect(code(() => parseTrackFile(fitFile(messages)))).toBe('no-error');
    expect(code(() => parseTrackFile(fitFile(messages, { zeroFileCrc: true })))).toBe(
      'TRACK_FIT_INVALID',
    );
    // A zeroed header CRC stays allowed: the FIT specification permits it there.
    const omittedHeader = fitFile(messages);
    new DataView(omittedHeader.buffer).setUint16(12, 0, true);
    const repaired = new Uint8Array(omittedHeader);
    const view = new DataView(repaired.buffer);
    view.setUint16(repaired.length - 2, fitCrc(repaired.subarray(0, repaired.length - 2)), true);
    expect(code(() => parseTrackFile(repaired))).toBe('no-error');
  });

  it('splits on every FIT stop event type, not only stop_all', () => {
    for (const eventType of [1, 4, 8, 9]) {
      const file = withStop(eventType);
      expect(file.recorded[0]?.segments.map((segment) => segment.startReason)).toEqual([
        'stream-start',
        'fit-event-stop',
      ]);
    }
  });

  it('refuses a compressed timestamp with no preceding full timestamp', () => {
    expect(
      code(() =>
        parseTrackFile(
          fitFile([
            sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
            compressedRecordMessage(3),
          ]),
        ),
      ),
    ).toBe('TRACK_FIT_INVALID');
  });

  it('bounds lap and event messages per stream', () => {
    const many = (count: number, build: (index: number) => Uint8Array): Uint8Array[] =>
      Array.from({ length: count }, (_, index) => build(index));
    const build = (laps: number, events: number): Uint8Array =>
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 600 }),
        ...many(laps, (index) =>
          lapMessage(new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString(), 1),
        ),
        ...many(events, (index) =>
          timerStopMessage(
            new Date(Date.parse('2026-03-01T00:05:00Z') + index * 1000).toISOString(),
          ),
        ),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
      ]);
    expect(code(() => parseTrackFile(build(3, 0), { limits: { lapsPerStream: 3 } }))).toBe(
      'no-error',
    );
    expect(code(() => parseTrackFile(build(4, 0), { limits: { lapsPerStream: 3 } }))).toBe(
      'TRACK_COUNT_LIMIT',
    );
    expect(code(() => parseTrackFile(build(0, 3), { limits: { eventsPerStream: 3 } }))).toBe(
      'no-error',
    );
    expect(code(() => parseTrackFile(build(0, 4), { limits: { eventsPerStream: 3 } }))).toBe(
      'TRACK_COUNT_LIMIT',
    );
  });

  it('keeps unambiguous lap membership and makes only the ambiguous instants null', () => {
    const laps = (...records: Uint8Array[]) =>
      parseTrackFile(
        fitFile([
          sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 600 }),
          lapMessage('2026-03-01T00:00:00Z', 10),
          lapMessage('2026-03-01T00:00:05Z', 10),
          lapMessage('2026-03-01T00:00:30Z', 10),
          ...records,
        ]),
      ).recorded[0];
    // t=35 is inside the third lap only, even though the first two overlap each other.
    const unambiguous = laps(
      recordMessage({ at: '2026-03-01T00:00:35Z', longitude: 127, latitude: 37 }),
      recordMessage({ at: '2026-03-01T00:00:36Z', longitude: 127.0001, latitude: 37 }),
    );
    expect(unambiguous?.samples.map((sample) => sample.lapIndex)).toEqual([2, 2]);
    // t=7 sits in two overlapping laps and t=5 is their shared boundary: both unknown.
    const ambiguous = laps(
      recordMessage({ at: '2026-03-01T00:00:07Z', longitude: 127, latitude: 37 }),
      recordMessage({ at: '2026-03-01T00:00:05Z', longitude: 127.0001, latitude: 37 }),
    );
    expect(ambiguous?.samples.map((sample) => sample.lapIndex)).toEqual([null, null]);
    // A timestamp before or after every lap has no lap.
    const outside = laps(
      recordMessage({ at: '2026-03-01T00:00:20Z', longitude: 127, latitude: 37 }),
      recordMessage({ at: '2026-03-01T00:00:21Z', longitude: 127.0001, latitude: 37 }),
    );
    expect(outside?.samples.map((sample) => sample.lapIndex)).toEqual([null, null]);
  });

  it('breaks on a stop written in the same second as the previous record', () => {
    const file = parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
        timerStopMessage('2026-03-01T00:00:00Z'),
        recordMessage({ at: '2026-03-01T00:00:02Z', longitude: 127.0001, latitude: 37 }),
      ]),
    );
    // File order, not timestamps, decides: the stop message follows the first record.
    expect(file.recorded[0]?.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
      'fit-event-stop',
    ]);
  });

  it('does not break on a stop written before the first record of the interval', () => {
    const file = parseTrackFile(
      fitFile([
        sessionMessage({ startedAt: '2026-03-01T00:00:00Z', elapsedSeconds: 60 }),
        timerStopMessage('2026-03-01T00:00:00Z'),
        recordMessage({ at: '2026-03-01T00:00:00Z', longitude: 127, latitude: 37 }),
        recordMessage({ at: '2026-03-01T00:00:01Z', longitude: 127.0001, latitude: 37 }),
      ]),
    );
    expect(file.recorded[0]?.segments.map((segment) => segment.startReason)).toEqual([
      'stream-start',
    ]);
  });
});
