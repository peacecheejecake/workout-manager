import type { TrackPosition } from '@workout/contracts/tracks';
import {
  ESTIMATED_SAMPLE_BYTES,
  TrackIngestionError,
  type ParseBudget,
  type TrackParseLimits,
} from './limits.js';
import type { RawSample, RawTrack, RawTrackFile } from './raw.js';

/** FIT `date_time` counts seconds from 1989-12-31T00:00:00Z. */
const FIT_EPOCH_MILLISECONDS = 631_065_600_000;
const SEMICIRCLE_DEGREES = 180 / 2 ** 31;
const RECORD = 20;
const LAP = 19;
const SESSION = 18;
const EVENT = 21;
const TIMER_EVENT = 0;
const STOP_EVENT_TYPES = new Set([1, 4, 8, 9]);

const BASE_SIZES = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];

/** CRC-16/ARC, the algorithm the FIT header and trailer checksums use. */
export function fitCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

interface FieldDefinition {
  readonly number: number;
  readonly size: number;
  readonly baseType: number;
}

interface MessageDefinition {
  readonly globalNumber: number;
  readonly littleEndian: boolean;
  readonly fields: readonly FieldDefinition[];
  readonly size: number;
}

function readValue(
  view: DataView,
  offset: number,
  field: FieldDefinition,
  littleEndian: boolean,
): number | null {
  const base = field.baseType & 0x1f;
  const size = BASE_SIZES[base];
  if (size === undefined) return null;
  if (field.size !== size) return null; // Arrays and strings carry no scalar value here.
  switch (base) {
    case 0:
    case 2:
    case 10: {
      const value = view.getUint8(offset);
      return value === (base === 10 ? 0 : 0xff) ? null : value;
    }
    case 1: {
      const value = view.getInt8(offset);
      return value === 0x7f ? null : value;
    }
    case 3: {
      const value = view.getInt16(offset, littleEndian);
      return value === 0x7fff ? null : value;
    }
    case 4:
    case 11: {
      const value = view.getUint16(offset, littleEndian);
      return value === (base === 11 ? 0 : 0xffff) ? null : value;
    }
    case 5: {
      const value = view.getInt32(offset, littleEndian);
      return value === 0x7fffffff ? null : value;
    }
    case 6:
    case 12: {
      const value = view.getUint32(offset, littleEndian);
      return value === (base === 12 ? 0 : 0xffffffff) ? null : value;
    }
    case 8: {
      const value = view.getFloat32(offset, littleEndian);
      return Number.isFinite(value) ? value : null;
    }
    case 9: {
      const value = view.getFloat64(offset, littleEndian);
      return Number.isFinite(value) ? value : null;
    }
    default:
      return null;
  }
}

const instant = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(FIT_EPOCH_MILLISECONDS + seconds * 1000).toISOString();

interface FitRecord {
  readonly sourceIndex: number;
  /** Position of this message in the stream. File order, not timestamp order. */
  readonly ordinal: number;
  readonly timestampSeconds: number | null;
  readonly position: TrackPosition | null;
  readonly elevationMeters: number | null;
  readonly distanceMeters: number | null;
  readonly speedMetersPerSecond: number | null;
  readonly heartRateBpm: number | null;
}

interface FitInterval {
  readonly startSeconds: number | null;
  readonly elapsedSeconds: number | null;
  readonly distanceMeters: number | null;
}

interface FitStream {
  readonly records: readonly FitRecord[];
  readonly sessions: readonly FitInterval[];
  readonly laps: readonly FitInterval[];
  /** Message ordinals of timer stop events, ascending. */
  readonly stops: readonly number[];
}

function scaled(value: number | null, scale: number, offset: number): number | null {
  return value === null ? null : value / scale - offset;
}

function semicircles(value: number | null): number | null {
  if (value === null) return null;
  const degrees = value * SEMICIRCLE_DEGREES;
  return Number.isFinite(degrees) ? degrees : null;
}

function readStream(
  bytes: Uint8Array,
  start: number,
  end: number,
  limits: TrackParseLimits,
  budget: ParseBudget,
  counters: { messages: number },
): FitStream {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const definitions = new Map<number, MessageDefinition>();
  const records: FitRecord[] = [];
  const sessions: FitInterval[] = [];
  const laps: FitInterval[] = [];
  const stops: number[] = [];
  let offset = start;
  let lastTimestamp: number | null = null;
  let ordinal = 0;
  while (offset < end) {
    budget.check();
    ordinal += 1;
    counters.messages += 1;
    if (counters.messages > limits.messages) throw new TrackIngestionError('TRACK_MESSAGE_LIMIT');
    const header = bytes[offset];
    if (header === undefined) throw new TrackIngestionError('TRACK_FIT_INVALID');
    offset += 1;
    let compressedOffset: number | null = null;
    let localType: number;
    let definition = false;
    let developer = false;
    if ((header & 0x80) !== 0) {
      localType = (header >> 5) & 0x03;
      compressedOffset = header & 0x1f;
    } else {
      localType = header & 0x0f;
      definition = (header & 0x40) !== 0;
      developer = (header & 0x20) !== 0;
    }
    if (definition) {
      if (offset + 5 > end) throw new TrackIngestionError('TRACK_FIT_INVALID');
      const littleEndian = bytes[offset + 1] === 0;
      const globalNumber = view.getUint16(offset + 2, littleEndian);
      const count = bytes[offset + 4] ?? 0;
      offset += 5;
      const fields: FieldDefinition[] = [];
      let size = 0;
      for (let index = 0; index < count; index += 1) {
        if (offset + 3 > end) throw new TrackIngestionError('TRACK_FIT_INVALID');
        const field = {
          number: bytes[offset] ?? 0,
          size: bytes[offset + 1] ?? 0,
          baseType: bytes[offset + 2] ?? 0,
        };
        if (field.size === 0) throw new TrackIngestionError('TRACK_FIT_INVALID');
        fields.push(field);
        size += field.size;
        offset += 3;
      }
      if (developer) {
        if (offset >= end) throw new TrackIngestionError('TRACK_FIT_INVALID');
        const developerCount = bytes[offset] ?? 0;
        offset += 1;
        for (let index = 0; index < developerCount; index += 1) {
          if (offset + 3 > end) throw new TrackIngestionError('TRACK_FIT_INVALID');
          size += bytes[offset + 1] ?? 0;
          offset += 3;
        }
      }
      definitions.set(localType, { globalNumber, littleEndian, fields, size });
      continue;
    }
    const message = definitions.get(localType);
    if (!message) throw new TrackIngestionError('TRACK_FIT_INVALID');
    if (offset + message.size > end) throw new TrackIngestionError('TRACK_FIT_INVALID');
    const values = new Map<number, number | null>();
    let cursor = offset;
    for (const field of message.fields) {
      values.set(field.number, readValue(view, cursor, field, message.littleEndian));
      cursor += field.size;
    }
    offset += message.size;
    let timestamp: number | null = values.get(253) ?? null;
    if (compressedOffset !== null) {
      // A compressed timestamp is an offset from the previous full timestamp. Without one
      // there is no reference, and guessing a time would fabricate an observation.
      if (lastTimestamp === null) throw new TrackIngestionError('TRACK_FIT_INVALID');
      const previousOffset: number = lastTimestamp & 0x1f;
      timestamp =
        lastTimestamp -
        previousOffset +
        compressedOffset +
        (compressedOffset < previousOffset ? 32 : 0);
    }
    if (timestamp !== null) lastTimestamp = timestamp;
    switch (message.globalNumber) {
      case RECORD: {
        if (records.length >= limits.samples) throw new TrackIngestionError('TRACK_SAMPLE_LIMIT');
        budget.charge(ESTIMATED_SAMPLE_BYTES);
        const longitude = semicircles(values.get(1) ?? null);
        const latitude = semicircles(values.get(0) ?? null);
        const position: TrackPosition | null =
          longitude === null || latitude === null ? null : [longitude, latitude];
        if (position && (Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90))
          throw new TrackIngestionError('TRACK_COORDINATE_INVALID');
        const heartRate = values.get(3) ?? null;
        records.push({
          sourceIndex: records.length,
          ordinal,
          timestampSeconds: timestamp,
          position,
          elevationMeters:
            scaled(values.get(78) ?? null, 5, 500) ?? scaled(values.get(2) ?? null, 5, 500),
          distanceMeters: scaled(values.get(5) ?? null, 100, 0),
          speedMetersPerSecond:
            scaled(values.get(73) ?? null, 1000, 0) ?? scaled(values.get(6) ?? null, 1000, 0),
          heartRateBpm: heartRate === null ? null : Math.round(heartRate),
        });
        break;
      }
      case SESSION:
      case LAP: {
        const interval: FitInterval = {
          startSeconds: values.get(2) ?? null,
          elapsedSeconds: scaled(values.get(7) ?? null, 1000, 0),
          distanceMeters: scaled(values.get(9) ?? null, 100, 0),
        };
        if (message.globalNumber === SESSION) {
          if (sessions.length >= limits.tracksPerFile)
            throw new TrackIngestionError('TRACK_COUNT_LIMIT');
          sessions.push(interval);
        } else {
          if (laps.length >= limits.lapsPerStream)
            throw new TrackIngestionError('TRACK_COUNT_LIMIT');
          laps.push(interval);
        }
        break;
      }
      case EVENT: {
        // FIT event_type: 1 stop, 4 stop_all, 8 stop_disable, 9 stop_disable_all. All four
        // end the recording interval, so all four break the line.
        const kind = values.get(0) ?? null;
        const type = values.get(1) ?? null;
        if (kind === TIMER_EVENT && type !== null && STOP_EVENT_TYPES.has(type)) {
          if (stops.length >= limits.eventsPerStream)
            throw new TrackIngestionError('TRACK_COUNT_LIMIT');
          // Stored by file position: two messages can share a whole-second timestamp, and
          // only the original order says whether the stop came before or after a record.
          stops.push(ordinal);
        }
        break;
      }
      default:
        break;
    }
  }
  return { records, sessions, laps, stops };
}

function assignOwner(
  timestamp: number | null,
  sessions: readonly FitInterval[],
): number | 'ambiguous' {
  if (sessions.length <= 1) return 0;
  if (timestamp === null) throw new TrackIngestionError('TRACK_SESSION_ASSIGNMENT_AMBIGUOUS');
  const owners: number[] = [];
  sessions.forEach((session, index) => {
    if (session.startSeconds === null || session.elapsedSeconds === null)
      throw new TrackIngestionError('TRACK_SESSION_ASSIGNMENT_AMBIGUOUS');
    if (
      timestamp >= session.startSeconds &&
      timestamp <= session.startSeconds + session.elapsedSeconds
    )
      owners.push(index);
  });
  return owners.length === 1 ? (owners[0] ?? 'ambiguous') : 'ambiguous';
}

interface LapIndexEntry {
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

/**
 * Containment table over the lap intervals of one stream, built once.
 *
 * Boundary policy, deliberately pinned: intervals are closed (`start <= t <= end`). A
 * timestamp contained by exactly one lap keeps that relationship even when *other* laps
 * overlap elsewhere; a timestamp contained by two or more laps — including a shared
 * boundary instant — is ambiguous and becomes `null`, never an arbitrary pick.
 */
interface LapLookup {
  readonly points: readonly number[];
  /** Unique owner exactly at `points[i]`, or null when none or several. */
  readonly atPoint: readonly (number | null)[];
  /** Unique owner on the open interval between `points[i]` and `points[i + 1]`. */
  readonly afterPoint: readonly (number | null)[];
}

const EMPTY_LAP_LOOKUP: LapLookup = { points: [], atPoint: [], afterPoint: [] };

function uniqueOwner(entries: readonly LapIndexEntry[]): number | null {
  return entries.length === 1 ? (entries[0]?.index ?? null) : null;
}

function buildLapLookup(laps: readonly FitInterval[], budget: ParseBudget): LapLookup {
  const entries: LapIndexEntry[] = [];
  laps.forEach((lap, index) => {
    if (lap.startSeconds === null || lap.elapsedSeconds === null) return;
    entries.push({ start: lap.startSeconds, end: lap.startSeconds + lap.elapsedSeconds, index });
  });
  if (entries.length === 0) return EMPTY_LAP_LOOKUP;
  const points = [...new Set(entries.flatMap((entry) => [entry.start, entry.end]))].sort(
    (left, right) => left - right,
  );
  const atPoint: (number | null)[] = [];
  const afterPoint: (number | null)[] = [];
  points.forEach((point, index) => {
    budget.check();
    atPoint.push(uniqueOwner(entries.filter((e) => e.start <= point && point <= e.end)));
    const next = points[index + 1];
    afterPoint.push(
      next === undefined
        ? null
        : uniqueOwner(entries.filter((e) => e.start <= point && e.end >= next)),
    );
  });
  return { points, atPoint, afterPoint };
}

/** Last entry whose value is at or before `value`, by binary search. */
function floorIndex(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((values[middle] ?? Number.POSITIVE_INFINITY) <= value) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function lapIndexFor(timestamp: number | null, lookup: LapLookup): number | null {
  if (timestamp === null || lookup.points.length === 0) return null;
  const position = floorIndex(lookup.points, timestamp);
  if (position < 0) return null;
  return lookup.points[position] === timestamp
    ? (lookup.atPoint[position] ?? null)
    : (lookup.afterPoint[position] ?? null);
}

/**
 * True when a timer stop message sits strictly between two record messages in file order.
 * Ordinals, not timestamps: a stop written in the same second as the preceding record
 * still ends that recording interval.
 */
function hasStopBetween(stopOrdinals: readonly number[], after: number, before: number): boolean {
  if (stopOrdinals.length === 0) return false;
  const position = floorIndex(stopOrdinals, after);
  const next = stopOrdinals[position + 1];
  return next !== undefined && next < before;
}

/**
 * Bounded FIT reader. Framing, header CRC and file CRC are verified before any value is
 * interpreted: an extension or declared MIME type never establishes that a file is FIT.
 * Semicircle coordinates are converted here and invalid sentinels become `null`, never 0.
 */
export function parseFit(
  bytes: Uint8Array,
  limits: TrackParseLimits,
  budget: ParseBudget,
): RawTrackFile {
  if (bytes.byteLength === 0) throw new TrackIngestionError('TRACK_FILE_EMPTY');
  const tracks: RawTrack[] = [];
  const counters = { messages: 0 };
  let offset = 0;
  let streamIndex = 0;
  while (offset < bytes.byteLength) {
    budget.check();
    if (streamIndex >= limits.streams) throw new TrackIngestionError('TRACK_COUNT_LIMIT');
    if (offset + 12 > bytes.byteLength) throw new TrackIngestionError('TRACK_FIT_INVALID');
    const headerSize = bytes[offset] ?? 0;
    if (headerSize < 12 || headerSize === 13 || offset + headerSize > bytes.byteLength)
      throw new TrackIngestionError('TRACK_FIT_INVALID');
    const magic = String.fromCharCode(...bytes.subarray(offset + 8, offset + 12));
    if (magic !== '.FIT') throw new TrackIngestionError('TRACK_FIT_INVALID');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dataSize = view.getUint32(offset + 4, true);
    const dataStart = offset + headerSize;
    const dataEnd = dataStart + dataSize;
    if (dataEnd + 2 > bytes.byteLength) throw new TrackIngestionError('TRACK_FIT_INVALID');
    if (headerSize >= 14) {
      const declared = view.getUint16(offset + 12, true);
      if (declared !== 0 && declared !== fitCrc(bytes.subarray(offset, offset + 12)))
        throw new TrackIngestionError('TRACK_FIT_INVALID');
    }
    // The "0 means omitted" allowance is for the header CRC only. Per the FIT spec the
    // trailer CRC is mandatory, so a zeroed trailer is a corrupt file, not an opt-out.
    const fileCrc = view.getUint16(dataEnd, true);
    if (fileCrc !== fitCrc(bytes.subarray(offset, dataEnd)))
      throw new TrackIngestionError('TRACK_FIT_INVALID');
    const stream = readStream(bytes, dataStart, dataEnd, limits, budget, counters);
    const sessionCount = Math.max(1, stream.sessions.length);
    if (tracks.length + sessionCount > limits.tracksPerFile)
      throw new TrackIngestionError('TRACK_COUNT_LIMIT');
    const owned: RawSample[][] = Array.from({ length: sessionCount }, () => []);
    const lapLookup = buildLapLookup(stream.laps, budget);
    const sortedStops = [...stream.stops].sort((left, right) => left - right);
    const lastOrdinals = new Array<number>(sessionCount).fill(-1);
    for (const record of stream.records) {
      // Per record: a deadline check and a charge, so this pass cannot outrun either budget.
      budget.check();
      budget.charge(ESTIMATED_SAMPLE_BYTES);
      const owner = assignOwner(record.timestampSeconds, stream.sessions);
      if (owner === 'ambiguous')
        throw new TrackIngestionError('TRACK_SESSION_ASSIGNMENT_AMBIGUOUS');
      const bucket = owned[owner];
      if (!bucket) throw new TrackIngestionError('TRACK_SESSION_ASSIGNMENT_AMBIGUOUS');
      const previous = bucket.at(-1);
      const previousOrdinal = lastOrdinals[owner] ?? -1;
      const stopped =
        previous !== undefined && hasStopBetween(sortedStops, previousOrdinal, record.ordinal);
      lastOrdinals[owner] = record.ordinal;
      bucket.push({
        sourceIndex: record.sourceIndex,
        recordedAt: instant(record.timestampSeconds),
        position: record.position,
        elevationMeters: record.elevationMeters,
        distanceMeters: record.distanceMeters,
        speedMetersPerSecond: record.speedMetersPerSecond,
        heartRateBpm: record.heartRateBpm,
        lapIndex: lapIndexFor(record.timestampSeconds, lapLookup),
        boundary:
          bucket.length === 0 ? 'fit-session' : stopped && previous ? 'fit-event-stop' : null,
      });
    }
    owned.forEach((samples, index) => {
      if (samples.length === 0) return;
      tracks.push({
        streamIndex,
        sourceItemIndex: index,
        sourceKind: 'fit-session',
        name: null,
        samples,
        deviceDistanceMeters: stream.sessions[index]?.distanceMeters ?? null,
      });
    });
    offset = dataEnd + 2;
    streamIndex += 1;
  }
  if (tracks.length === 0) throw new TrackIngestionError('TRACK_NO_TRACK_DATA');
  return { tracks, routes: [], waypoints: [] };
}
