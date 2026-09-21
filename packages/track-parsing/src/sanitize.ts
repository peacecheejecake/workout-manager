import { TrackIngestionError } from './limits';

/** Control, C1 and bidirectional-override code points, checked without a control regex. */
function isUnsafeCode(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Untrusted filenames and XML metadata. Control and bidirectional-override characters are
 * removed and angle brackets are rejected, so no consumer has to escape them later.
 * Returns `null` when nothing safe and non-empty remains; the field is then absent, not "".
 */
export function sanitizeMetadataText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (/[<>]/u.test(value)) throw new TrackIngestionError('TRACK_TEXT_UNSAFE');
  const cleaned = [...value]
    .filter((character) => !isUnsafeCode(character.codePointAt(0) ?? 0))
    .join('')
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > max) throw new TrackIngestionError('TRACK_TEXT_UNSAFE');
  return cleaned;
}

const ARCHIVE_MAGIC: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x1f, 0x8b],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x52, 0x61, 0x72, 0x21],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a],
];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Content sniffing. The extension and the declared MIME type are never trusted, and
 * archives are rejected outright instead of being unpacked.
 */
export function detectTrackFormat(bytes: Uint8Array): 'fit' | 'gpx' {
  if (bytes.byteLength === 0) throw new TrackIngestionError('TRACK_FILE_EMPTY');
  for (const magic of ARCHIVE_MAGIC)
    if (startsWith(bytes, magic)) throw new TrackIngestionError('TRACK_ARCHIVE_REJECTED');
  if (
    bytes.byteLength >= 12 &&
    bytes[8] === 0x2e &&
    bytes[9] === 0x46 &&
    bytes[10] === 0x49 &&
    bytes[11] === 0x54
  )
    return 'fit';
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  while (offset < bytes.byteLength) {
    const byte = bytes[offset] ?? 0;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) offset += 1;
    else break;
  }
  if (bytes[offset] === 0x3c) return 'gpx';
  throw new TrackIngestionError('TRACK_FORMAT_UNSUPPORTED');
}
