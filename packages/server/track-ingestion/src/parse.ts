import { createHash } from 'node:crypto';
import type { ParsedTrackFile } from '@workout/contracts/tracks';
import { parseFit } from './fit.js';
import { parseGpx } from './gpx.js';
import {
  createParseBudget,
  resolveTrackParseLimits,
  TrackIngestionError,
  type ParseBudget,
  type TrackParseLimits,
} from './limits.js';
import { normalizeTrackFile, type SegmentPolicy } from './normalize.js';
import { detectTrackFormat } from './sanitize.js';

export interface ParseTrackFileOptions {
  readonly filename?: string | null;
  readonly limits?: Partial<TrackParseLimits>;
  readonly policy?: SegmentPolicy;
  /** Injected for deterministic budget tests. */
  readonly now?: () => number;
}

/**
 * The single bounded entry point: sniff the format from content, parse within every
 * limit, normalize and validate against the contract. Failures are `TrackIngestionError`
 * codes, so one bad file is isolated and never leaks parser internals or file content.
 */
export function parseTrackFile(
  bytes: Uint8Array,
  options: ParseTrackFileOptions = {},
): ParsedTrackFile {
  const limits = resolveTrackParseLimits(options.limits);
  if (bytes.byteLength === 0) throw new TrackIngestionError('TRACK_FILE_EMPTY');
  if (bytes.byteLength > limits.fileBytes) throw new TrackIngestionError('TRACK_FILE_TOO_LARGE');
  const budget = createParseBudget(limits, options.now);
  // The input buffer itself is the first charge; everything allocated from it follows.
  budget.charge(bytes.byteLength);
  const format = detectTrackFormat(bytes);
  const fileSha256 = createHash('sha256').update(bytes).digest('hex');
  const raw =
    format === 'fit'
      ? parseFit(bytes, limits, budget)
      : parseGpx(decodeUtf8(bytes, budget), limits, budget);
  return normalizeTrackFile(
    raw,
    {
      format,
      parserId: format === 'fit' ? 'fit-track-v1' : 'gpx-track-v1',
      fileSha256,
      fileByteLength: bytes.byteLength,
      originalFilename: options.filename ?? null,
      ...(options.policy ? { policy: options.policy } : {}),
    },
    limits,
    budget,
  );
}

function decodeUtf8(bytes: Uint8Array, budget: ParseBudget): string {
  // UTF-16 code units: two bytes per input byte is the worst case, charged before decoding.
  budget.charge(bytes.byteLength * 2);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TrackIngestionError('TRACK_XML_MALFORMED');
  }
}
