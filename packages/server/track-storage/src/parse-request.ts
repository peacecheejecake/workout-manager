import { buildMapPath, parseTrackFile, trackAggregates } from '@workout/track-parsing';
import { recordedTrackSchema, type ParsedTrackFile } from '@workout/contracts/tracks';

import { storedTrackSelectionSchema, type StoredTrackArtifacts } from './artifacts.js';

/**
 * What one parse request answers. The parse process (`parse-child.ts`) sends exactly this
 * back to the host; nothing else about the parse leaves it. A failure is a code only.
 */
export type ParseRequestReply =
  | { readonly ok: true; readonly artifacts: StoredTrackArtifacts }
  | { readonly ok: true; readonly file: ParsedTrackFile }
  | { readonly ok: false; readonly code: string };

function failureCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === 'string' ? code : 'TRACK_PARSE_FAILED';
}

/**
 * Answer one parse request: bytes and a selection in, the stored artifacts (or the whole
 * file) or a single error code out. It holds no database handle, no storage handle and no
 * credentials, and it never reads the file system.
 *
 * This is the whole of the parse the host runs out of process. It lives apart from the
 * process wiring so that the same function can be called in-process as the reference the
 * host's output is compared against (`parse-host.test.ts`): moving the parse into another
 * process must not change a single byte of what it produces.
 */
export async function answerParseRequest(message: unknown): Promise<ParseRequestReply> {
  const request = message as {
    bytes?: unknown;
    filename?: unknown;
    selection?: unknown;
    purpose?: unknown;
  } | null;
  const bytes = request?.bytes;
  const filename = typeof request?.filename === 'string' ? request.filename : null;
  if (!(bytes instanceof Uint8Array)) return { ok: false, code: 'TRACK_PARSE_REQUEST_INVALID' };
  // The exact range, as a plain Uint8Array: the request may arrive as a Buffer view.
  const input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The whole file, for a caller that must see recordings, routes and waypoints as three
  // separate things (course import, M2-01j). It selects nothing and merges nothing: the
  // parse result is returned as the contract describes it and the decision is the
  // caller's.
  if (request?.purpose === 'whole-file') {
    try {
      return { ok: true, file: await parseTrackFile(input, { filename }) };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    }
  }
  const selection = storedTrackSelectionSchema.safeParse(request?.selection);
  if (!selection.success) return { ok: false, code: 'TRACK_PARSE_REQUEST_INVALID' };
  try {
    const file = await parseTrackFile(input, { filename });
    const parsed = file.recorded[selection.data.recordedTrackIndex];
    if (!parsed)
      // A file holding several recordings requires an explicit selection, and a
      // selection that names nothing is an error rather than a silent first-track pick.
      return {
        ok: false,
        code: file.recorded.length === 0 ? 'TRACK_NO_TRACK_DATA' : 'TRACK_SELECTION_INVALID',
      };
    // The stored recording carries `activity-source` provenance; the local-file
    // provenance belongs to a preview and must not survive into storage.
    const stored = recordedTrackSchema.parse({
      ...parsed,
      provenance: selection.data.provenance,
    });
    const artifacts: StoredTrackArtifacts = {
      format: file.format,
      parserId: file.parserId,
      parserVersion: file.parserVersion,
      fileSha256: file.fileSha256,
      fileByteLength: file.fileByteLength,
      originalFilename: file.originalFilename,
      recordedCount: file.recorded.length,
      requiresSelection: file.requiresSelection,
      track: stored,
      mapPath: buildMapPath(stored),
      aggregates: trackAggregates(stored),
    };
    return { ok: true, artifacts };
  } catch (error) {
    return { ok: false, code: failureCode(error) };
  }
}
