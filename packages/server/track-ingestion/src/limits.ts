import { trackLimits } from '@workout/contracts/tracks';

export type TrackIngestionErrorCode =
  | 'TRACK_FILE_EMPTY'
  | 'TRACK_FILE_TOO_LARGE'
  | 'TRACK_ARCHIVE_REJECTED'
  | 'TRACK_FORMAT_UNSUPPORTED'
  | 'TRACK_FIT_INVALID'
  | 'TRACK_FIT_UNSUPPORTED'
  | 'TRACK_GPX_INVALID_ROOT'
  | 'TRACK_XML_DTD_BLOCKED'
  | 'TRACK_XML_ENTITY_BLOCKED'
  | 'TRACK_XML_DEPTH_LIMIT'
  | 'TRACK_XML_TEXT_LIMIT'
  | 'TRACK_XML_MALFORMED'
  | 'TRACK_TEXT_UNSAFE'
  | 'TRACK_COORDINATE_INVALID'
  | 'TRACK_SAMPLE_LIMIT'
  | 'TRACK_SEGMENT_LIMIT'
  | 'TRACK_COUNT_LIMIT'
  | 'TRACK_MESSAGE_LIMIT'
  | 'TRACK_OUTPUT_TOO_LARGE'
  | 'TRACK_PARSE_TIMEOUT'
  | 'TRACK_PARSE_MEMORY_LIMIT'
  | 'TRACK_PARSER_BUSY'
  | 'TRACK_SESSION_ASSIGNMENT_AMBIGUOUS'
  | 'TRACK_NO_TRACK_DATA'
  | 'TRACK_NORMALIZATION_INVALID';

/** Every bound has exactly one error code; callers never see a raw parser exception. */
export class TrackIngestionError extends Error {
  constructor(readonly code: TrackIngestionErrorCode) {
    super(code);
    this.name = 'TrackIngestionError';
  }
}

export interface TrackParseLimits {
  readonly fileBytes: number;
  readonly samples: number;
  readonly segments: number;
  readonly tracksPerFile: number;
  readonly streams: number;
  readonly xmlDepth: number;
  readonly xmlTextBytes: number;
  readonly metadataTextLength: number;
  readonly normalizedBytes: number;
  readonly parseMilliseconds: number;
  readonly parseMemoryBytes: number;
  readonly messages: number;
  readonly lapsPerStream: number;
  readonly eventsPerStream: number;
}

/** Contract limits are the ceiling: an override may only narrow them. */
export const defaultTrackParseLimits: TrackParseLimits = {
  fileBytes: trackLimits.fileBytes,
  samples: trackLimits.samples,
  segments: trackLimits.segments,
  tracksPerFile: trackLimits.tracksPerFile,
  streams: trackLimits.streams,
  xmlDepth: trackLimits.xmlDepth,
  xmlTextBytes: trackLimits.xmlTextBytes,
  metadataTextLength: trackLimits.metadataTextLength,
  normalizedBytes: trackLimits.normalizedBytes,
  parseMilliseconds: trackLimits.parseMilliseconds,
  parseMemoryBytes: trackLimits.parseMemoryBytes,
  messages: 1_000_000,
  lapsPerStream: trackLimits.lapsPerStream,
  eventsPerStream: trackLimits.eventsPerStream,
};

/**
 * Charged per raw parser sample and again per normalized sample. Deliberately a fixed
 * over-estimate of one small object with its strings: the budget must fail before the
 * allocation, so it cannot be measured after the fact.
 */
export const ESTIMATED_SAMPLE_BYTES = 256;

export function resolveTrackParseLimits(overrides?: Partial<TrackParseLimits>): TrackParseLimits {
  const resolved = { ...defaultTrackParseLimits, ...overrides };
  for (const key of Object.keys(defaultTrackParseLimits) as (keyof TrackParseLimits)[]) {
    const value = resolved[key];
    if (!Number.isInteger(value) || value < 1 || value > defaultTrackParseLimits[key])
      throw new TrackIngestionError('TRACK_FORMAT_UNSUPPORTED');
  }
  return resolved;
}

export interface ParseBudget {
  /** Throws `TRACK_PARSE_TIMEOUT` once the wall-clock budget is spent. */
  readonly check: () => void;
  /**
   * Accounts for bytes the parse is about to allocate (decoded text, raw samples,
   * normalized samples). Throws `TRACK_PARSE_MEMORY_LIMIT` *before* the allocation.
   */
  readonly charge: (bytes: number) => void;
  /**
   * Accounts for serialized output bytes part by part. Because every part is contained in
   * the final document, exceeding the limit on the running sum proves the whole document
   * would exceed it, so the oversized string is never built.
   */
  readonly chargeOutput: (bytes: number) => void;
  readonly allocatedBytes: () => number;
  readonly outputBytes: () => number;
}

export function createParseBudget(
  limits: TrackParseLimits,
  now: () => number = () => Date.now(),
): ParseBudget {
  const deadline = now() + limits.parseMilliseconds;
  let allocated = 0;
  let output = 0;
  return {
    check: () => {
      if (now() > deadline) throw new TrackIngestionError('TRACK_PARSE_TIMEOUT');
    },
    charge: (bytes: number) => {
      allocated += bytes;
      if (allocated > limits.parseMemoryBytes)
        throw new TrackIngestionError('TRACK_PARSE_MEMORY_LIMIT');
    },
    chargeOutput: (bytes: number) => {
      output += bytes;
      if (output > limits.normalizedBytes) throw new TrackIngestionError('TRACK_OUTPUT_TOO_LARGE');
    },
    allocatedBytes: () => allocated,
    outputBytes: () => output,
  };
}

export interface BoundedParserPool {
  readonly run: <T>(task: () => Promise<T> | T) => Promise<T>;
  readonly active: () => number;
}

/**
 * Explicit worker concurrency bound. Work past the bound is rejected with
 * `TRACK_PARSER_BUSY` instead of being queued: an unbounded queue is not a bound.
 */
export function createBoundedParserPool(
  concurrency: number = trackLimits.workerConcurrency,
): BoundedParserPool {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > trackLimits.workerConcurrency
  )
    throw new TrackIngestionError('TRACK_FORMAT_UNSUPPORTED');
  let active = 0;
  return {
    active: () => active,
    run: async <T>(task: () => Promise<T> | T): Promise<T> => {
      if (active >= concurrency) throw new TrackIngestionError('TRACK_PARSER_BUSY');
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
      }
    },
  };
}
