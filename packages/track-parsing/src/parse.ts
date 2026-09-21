import type { ParsedTrackFile } from '@workout/contracts/tracks';
import { parseFit } from './fit';
import { parseGpx } from './gpx';
import {
  createParseBudget,
  resolveTrackParseLimits,
  TrackIngestionError,
  type ParseBudget,
  type TrackParseLimits,
} from './limits';
import { normalizeTrackFile, type SegmentPolicy } from './normalize';
import { detectTrackFormat } from './sanitize';

export interface ParseTrackFileOptions {
  readonly filename?: string | null;
  readonly limits?: Partial<TrackParseLimits>;
  readonly policy?: SegmentPolicy;
  /** Injected for deterministic budget tests. */
  readonly now?: () => number;
}

/**
 * SHA-256 of the file, from the platform's own Web Crypto implementation.
 *
 * This package runs in both a Node process and a browser worker, so it must not import a
 * Node built-in, and it must not carry a hand-written digest. `crypto.subtle` exists in
 * Node 24 and in browsers (including workers), and it is asynchronous, which is why the
 * digest is taken outside the synchronous parse below.
 */
export async function hashTrackFileSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new TrackIngestionError('TRACK_DIGEST_UNAVAILABLE');
  // Copy the exact range into a buffer of its own. Passing `bytes.buffer` — or the result
  // of `Buffer.prototype.slice`, which is a view and not a copy — would hash whatever else
  // shares the backing store, and Node hands out pooled `Buffer`s that are views into an
  // 8 KiB pool. `new Uint8Array(bytes)` copies element-wise from the view, so the digest
  // describes the file and nothing around it.
  const copy = new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * The bounded entry point: sniff the format from content, parse within every limit,
 * normalize and validate against the contract. Failures are `TrackIngestionError` codes,
 * so one bad file is isolated and never leaks parser internals or file content.
 *
 * The digest is injected rather than computed here: the only platform-neutral SHA-256 is
 * asynchronous, while parsing itself is synchronous and bounded by a work budget that
 * must not be interleaved with awaits. Callers that do not already hold a digest use
 * {@link parseTrackFile}, which takes it first and then calls this.
 */
export function parseTrackFileWithDigest(
  bytes: Uint8Array,
  fileSha256: string,
  options: ParseTrackFileOptions = {},
): ParsedTrackFile {
  const limits = resolveTrackParseLimits(options.limits);
  if (bytes.byteLength === 0) throw new TrackIngestionError('TRACK_FILE_EMPTY');
  if (bytes.byteLength > limits.fileBytes) throw new TrackIngestionError('TRACK_FILE_TOO_LARGE');
  const budget = createParseBudget(limits, options.now);
  // The input buffer itself is the first charge; everything allocated from it follows.
  budget.charge(bytes.byteLength);
  const format = detectTrackFormat(bytes);
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

/**
 * One call for a caller that only has bytes: take the digest, then parse. The size check
 * runs before the digest so an oversized file is refused without hashing it.
 *
 * The caller's buffer is copied once, and that copy is what is both hashed and parsed.
 * Hashing is asynchronous, so without the copy the bytes could change between the digest
 * and the parse and the result would carry a `fileSha256` describing different content —
 * the provenance of every local-file preview depends on those being the same bytes.
 */
export async function parseTrackFile(
  bytes: Uint8Array,
  options: ParseTrackFileOptions = {},
): Promise<ParsedTrackFile> {
  const limits = resolveTrackParseLimits(options.limits);
  if (bytes.byteLength === 0) throw new TrackIngestionError('TRACK_FILE_EMPTY');
  if (bytes.byteLength > limits.fileBytes) throw new TrackIngestionError('TRACK_FILE_TOO_LARGE');
  const snapshot = new Uint8Array(bytes);
  return parseTrackFileWithDigest(snapshot, await hashTrackFileSha256(snapshot), options);
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
