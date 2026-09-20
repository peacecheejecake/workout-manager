import { createHash } from 'node:crypto';

import {
  GALLERY_PREVIEW_MAX_BYTES,
  galleryImageMediaTypeSchema,
  galleryMediaExtension,
  galleryMediaMaxBytes,
  galleryMediaTypeSchema,
  type GalleryMediaType,
} from '@workout/contracts/gallery';
import {
  createGalleryFinalObjectKey,
  createGalleryTemporaryObjectKey,
  type FinalObjectKey,
  type GalleryMediaExtension,
  type TemporaryObjectKey,
} from '@workout/server-media/keys';
import type { ObjectStorage, PublishResult } from '@workout/server-media/object-storage';

export type GalleryUploadOperation = 'create_item' | 'attach_preview';

export interface GalleryUploadPolicy {
  readonly mediaType: GalleryMediaType;
  readonly extension: GalleryMediaExtension;
  readonly maxBytes: number;
}

export class GalleryUploadValidationError extends Error {
  constructor(
    readonly code:
      'EMPTY_UPLOAD' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE_TYPE' | 'INVALID_MEDIA_SIGNATURE',
    message: string,
  ) {
    super(message);
    this.name = 'GalleryUploadValidationError';
  }
}

/**
 * Declared content type and file extension must agree, and the declared type
 * must be inside the explicit allowlist. Video is stored as uploaded: this
 * milestone performs no transcoding and claims no container remuxing.
 */
export function resolveGalleryUploadPolicy(input: {
  fileName: string;
  declaredMimeType: string;
  operation: GalleryUploadOperation;
}): GalleryUploadPolicy {
  const declared = input.declaredMimeType.trim().toLowerCase();
  const parsedType =
    input.operation === 'attach_preview'
      ? galleryImageMediaTypeSchema.safeParse(declared)
      : galleryMediaTypeSchema.safeParse(declared);
  if (!parsedType.success)
    throw new GalleryUploadValidationError(
      'UNSUPPORTED_FILE_TYPE',
      'Content type is not an allowed gallery media type.',
    );
  const mediaType = parsedType.data;
  const extension = galleryMediaExtension(mediaType);
  const fileExtension = input.fileName.slice(input.fileName.lastIndexOf('.') + 1).toLowerCase();
  const matches = fileExtension === extension || (extension === 'jpg' && fileExtension === 'jpeg');
  if (!matches)
    throw new GalleryUploadValidationError(
      'UNSUPPORTED_FILE_TYPE',
      'File extension and content type must agree.',
    );
  return {
    mediaType,
    extension,
    maxBytes:
      input.operation === 'attach_preview'
        ? GALLERY_PREVIEW_MAX_BYTES
        : galleryMediaMaxBytes(mediaType),
  };
}

const SIGNATURE_BYTES = 12;

function matchesSignature(header: Uint8Array, length: number, mediaType: GalleryMediaType) {
  const at = (index: number) => header[index];
  const ascii = (offset: number, text: string) =>
    [...text].every((character, index) => at(offset + index) === character.charCodeAt(0));
  switch (mediaType) {
    case 'image/jpeg':
      return length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
    case 'image/png':
      return (
        length >= 8 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte)
      );
    case 'image/webp':
      return length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'video/mp4':
      return length >= 8 && ascii(4, 'ftyp');
    case 'video/webm':
      return length >= 4 && at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3;
    default:
      return false;
  }
}

export interface ValidatedGalleryUpload {
  readonly mediaType: GalleryMediaType;
  readonly extension: GalleryMediaExtension;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Bounds are enforced while streaming so an oversized or malformed body is
 * rejected before the whole object is buffered anywhere.
 */
export function createValidatedGalleryUploadStream(
  input: AsyncIterable<Uint8Array>,
  policy: GalleryUploadPolicy,
): {
  readonly body: AsyncIterable<Uint8Array>;
  readonly result: Promise<ValidatedGalleryUpload>;
} {
  let resolveResult!: (result: ValidatedGalleryUpload) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<ValidatedGalleryUpload>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);

  async function* validate(): AsyncGenerator<Uint8Array> {
    const hash = createHash('sha256');
    const header = new Uint8Array(SIGNATURE_BYTES);
    let headerLength = 0;
    let sizeBytes = 0;
    try {
      for await (const value of input) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (chunk.byteLength === 0) continue;
        sizeBytes += chunk.byteLength;
        if (sizeBytes > policy.maxBytes)
          throw new GalleryUploadValidationError(
            'FILE_TOO_LARGE',
            `Upload exceeds the ${policy.maxBytes} byte limit.`,
          );
        hash.update(chunk);
        if (headerLength < header.byteLength) {
          const copyLength = Math.min(header.byteLength - headerLength, chunk.byteLength);
          header.set(chunk.subarray(0, copyLength), headerLength);
          headerLength += copyLength;
        }
        yield chunk;
      }
      if (sizeBytes === 0)
        throw new GalleryUploadValidationError('EMPTY_UPLOAD', 'Upload must not be empty.');
      if (!matchesSignature(header, headerLength, policy.mediaType))
        throw new GalleryUploadValidationError(
          'INVALID_MEDIA_SIGNATURE',
          'File content does not match the declared media type.',
        );
      resolveResult({
        mediaType: policy.mediaType,
        extension: policy.extension,
        sizeBytes,
        sha256: hash.digest('hex'),
      });
    } catch (error) {
      rejectResult(error);
      throw error;
    }
  }

  return { body: validate(), result };
}

export interface PreparedGalleryUpload {
  readonly temporaryKey: TemporaryObjectKey;
  readonly finalKey: FinalObjectKey;
  readonly mediaType: GalleryMediaType;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface StoredGalleryUpload {
  readonly key: FinalObjectKey;
  readonly outcome: PublishResult['outcome'];
  readonly mediaType: GalleryMediaType;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Reserve → validate into a temporary object → persist both refs durably →
 * publish. An interrupted write leaves a durably recorded ref the existing
 * cleanup manifest can reclaim; it never leaves an unreferenced object behind.
 */
export async function storeValidatedGalleryUpload(input: {
  storage: ObjectStorage;
  tenantId: string;
  mediaItemId: string;
  uploadId: string;
  policy: GalleryUploadPolicy;
  body: AsyncIterable<Uint8Array>;
  onPrepared(prepared: PreparedGalleryUpload): Promise<void>;
}): Promise<StoredGalleryUpload> {
  const temporaryKey = createGalleryTemporaryObjectKey({
    tenantId: input.tenantId,
    mediaItemId: input.mediaItemId,
    uploadId: input.uploadId,
  });
  const validated = createValidatedGalleryUploadStream(input.body, input.policy);
  let temporaryOwned = false;
  let durablyPrepared = false;
  try {
    const temporary = await input.storage.writeTemporary(temporaryKey, validated.body);
    temporaryOwned = true;
    const outcome = await validated.result;
    if (temporary.sizeBytes !== outcome.sizeBytes)
      throw new Error('Object storage reported a size that differs from the validated stream.');
    const finalKey = createGalleryFinalObjectKey({
      tenantId: input.tenantId,
      mediaItemId: input.mediaItemId,
      uploadId: input.uploadId,
      sha256: outcome.sha256,
      extension: outcome.extension,
    });
    await input.onPrepared({
      temporaryKey,
      finalKey,
      mediaType: outcome.mediaType,
      sizeBytes: outcome.sizeBytes,
      sha256: outcome.sha256,
    });
    durablyPrepared = true;
    const published = await input.storage.publishTemporary(temporaryKey, finalKey, {
      sizeBytes: outcome.sizeBytes,
      sha256: outcome.sha256,
    });
    return {
      key: published.key,
      outcome: published.outcome,
      mediaType: outcome.mediaType,
      sizeBytes: outcome.sizeBytes,
      sha256: outcome.sha256,
    };
  } catch (error) {
    if (temporaryOwned && !durablyPrepared)
      await input.storage.delete(temporaryKey).catch(() => undefined);
    void validated.result.catch(() => undefined);
    throw error;
  }
}
