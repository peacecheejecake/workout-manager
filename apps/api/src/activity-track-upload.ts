import { createHash } from 'node:crypto';

import { trackLimits } from '@workout/contracts/tracks';
import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  type FinalObjectKey,
  type TemporaryObjectKey,
  type TrackArtifactKind,
} from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';

export class ActivityTrackUploadValidationError extends Error {
  constructor(
    readonly code: 'EMPTY_UPLOAD' | 'FILE_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'ActivityTrackUploadValidationError';
  }
}

export interface ValidatedTrackUpload {
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Bounds are enforced while streaming, so an oversized body is refused before the whole
 * file is buffered anywhere. Nothing about the content is decided here: the format is
 * sniffed, the structure validated and the samples produced by the bounded parse worker,
 * from the bytes this function actually stored.
 */
export function createValidatedTrackUploadStream(input: AsyncIterable<Uint8Array>): {
  readonly body: AsyncIterable<Uint8Array>;
  readonly result: Promise<ValidatedTrackUpload>;
} {
  let resolveResult!: (result: ValidatedTrackUpload) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<ValidatedTrackUpload>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);

  async function* validate(): AsyncGenerator<Uint8Array> {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      for await (const value of input) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (chunk.byteLength === 0) continue;
        sizeBytes += chunk.byteLength;
        if (sizeBytes > trackLimits.fileBytes)
          throw new ActivityTrackUploadValidationError(
            'FILE_TOO_LARGE',
            `Upload exceeds the ${trackLimits.fileBytes} byte limit.`,
          );
        hash.update(chunk);
        yield chunk;
      }
      if (sizeBytes === 0)
        throw new ActivityTrackUploadValidationError('EMPTY_UPLOAD', 'Upload must not be empty.');
      resolveResult({ sizeBytes, sha256: hash.digest('hex') });
    } catch (error) {
      rejectResult(error);
      throw error;
    }
  }

  return { body: validate(), result };
}

export interface TrackObjectKeys {
  readonly temporary: TemporaryObjectKey;
  readonly final: FinalObjectKey;
}

export function activityTrackObjectKeys(input: {
  tenantId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: TrackArtifactKind;
  sha256: string;
  extension: 'fit' | 'gpx' | 'json';
}): TrackObjectKeys {
  return {
    temporary: createActivityTrackTemporaryObjectKey(input),
    final: createActivityTrackFinalObjectKey(input),
  };
}

/**
 * Read back exactly what was stored.
 *
 * The parse must see the bytes the server persisted, not a second copy of the request
 * body it kept in memory while the upload was still arriving. Reading the temporary
 * object back also bounds the buffer by a size the stream already validated.
 */
export async function readStoredObject(
  storage: ObjectStorage,
  key: TemporaryObjectKey,
  expectedSizeBytes: number,
): Promise<Uint8Array> {
  const object = await storage.open(key);
  if (object === null || object.sizeBytes !== expectedSizeBytes)
    throw new Error('TRACK_TEMPORARY_OBJECT_UNAVAILABLE');
  const bytes = new Uint8Array(expectedSizeBytes);
  let offset = 0;
  for await (const chunk of object.body) {
    if (offset + chunk.byteLength > expectedSizeBytes)
      throw new Error('TRACK_TEMPORARY_OBJECT_UNAVAILABLE');
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expectedSizeBytes) throw new Error('TRACK_TEMPORARY_OBJECT_UNAVAILABLE');
  return bytes;
}
