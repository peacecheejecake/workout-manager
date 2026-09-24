/**
 * The representative long track (M2-01d fixed its size; M2-01k made it continuous; M2-01k-f
 * shares it between the server probes and the browser budget spec).
 *
 * SYNTHETIC: 20,000 samples one second and ~3.9 m apart, a continuous zig-zag of 19
 * north-south legs over central Seoul drifting ~7.9 km east, ~76 km in all. No personal FIT
 * or GPS is read. Continuous on purpose: a jump between samples is a recording gap, and a
 * course may not span one (the first M2-01k version jumped 440 m between legs and the product
 * correctly refused it with SEGMENT_SPANS_A_GAP).
 */
import {
  fitFile,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';

export type LongTrackPosition = [number, number];

export const LONG_TRACK_SAMPLES = 20_000;
const WEST = 126.93;
const EAST_SPAN = 0.09;
const SOUTH = 37.52;
const NORTH_SPAN = 0.036;
const LEGS = 19;
export const LONG_TRACK_STARTED_AT = '2026-03-01T00:00:00.000Z';
const startMilliseconds = Date.parse(LONG_TRACK_STARTED_AT);

export const longTrackAt = (seconds: number): string =>
  new Date(startMilliseconds + seconds * 1000).toISOString();

export function longTrackPosition(index: number): LongTrackPosition {
  const t = index / (LONG_TRACK_SAMPLES - 1);
  const phase = t * LEGS;
  const within = phase % 1;
  const rising = Math.floor(phase) % 2 === 0;
  return [WEST + EAST_SPAN * t, SOUTH + NORTH_SPAN * (rising ? within : 1 - within)];
}

/** Planar length of the zig-zag in metres (equirectangular, good to well under 1 % here). */
export function longTrackLengthMeters(): number {
  let length = 0;
  for (let index = 1; index < LONG_TRACK_SAMPLES; index += 1) {
    const [x1, y1] = longTrackPosition(index - 1);
    const [x2, y2] = longTrackPosition(index);
    const dx = (x2 - x1) * 111_320 * Math.cos((y1 * Math.PI) / 180);
    const dy = (y2 - y1) * 110_574;
    length += Math.hypot(dx, dy);
  }
  return length;
}

/** The FIT bytes: one session and 20,000 records with position, heart rate and distance. */
export function longTrackFitBytes(): Buffer {
  const length = longTrackLengthMeters();
  return Buffer.from(
    fitFile([
      sessionMessage({
        startedAt: longTrackAt(0),
        elapsedSeconds: LONG_TRACK_SAMPLES,
        distanceMeters: Math.round(length),
      }),
      ...Array.from({ length: LONG_TRACK_SAMPLES }, (_, index) =>
        recordMessage({
          at: longTrackAt(index),
          longitude: longTrackPosition(index)[0],
          latitude: longTrackPosition(index)[1],
          heartRate: 140 + (index % 20),
          distanceMeters: Math.round((length * index) / (LONG_TRACK_SAMPLES - 1)),
        }),
      ),
    ]),
  );
}
