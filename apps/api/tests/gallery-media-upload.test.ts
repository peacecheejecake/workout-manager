import { createHash } from 'node:crypto';

import {
  createGalleryFinalObjectKey,
  createGalleryTemporaryObjectKey,
  InvalidObjectKeyError,
  parseObjectKey,
} from '@workout/server-media/keys';
import { describe, expect, it } from 'vitest';

import {
  createValidatedGalleryUploadStream,
  GalleryUploadValidationError,
  resolveGalleryUploadPolicy,
} from '../src/gallery-media-upload.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mediaItemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const mp4Bytes = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
const webmBytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

async function consume(input: {
  body: AsyncIterable<Uint8Array>;
  result: Promise<{ sizeBytes: number; sha256: string }>;
}) {
  for await (const chunk of input.body) void chunk;
  return input.result;
}

describe('gallery upload policy', () => {
  it('accepts only allowlisted image and video content types whose extension agrees', () => {
    expect(
      resolveGalleryUploadPolicy({
        fileName: 'run.MP4',
        declaredMimeType: 'video/mp4',
        operation: 'create_item',
      }),
    ).toMatchObject({ mediaType: 'video/mp4', extension: 'mp4' });
    expect(
      resolveGalleryUploadPolicy({
        fileName: 'finish.jpeg',
        declaredMimeType: 'image/jpeg',
        operation: 'create_item',
      }),
    ).toMatchObject({ mediaType: 'image/jpeg', extension: 'jpg' });
  });

  it('rejects unlisted content types, mismatched extensions and video previews', () => {
    for (const input of [
      { fileName: 'x.gif', declaredMimeType: 'image/gif', operation: 'create_item' as const },
      { fileName: 'x.pdf', declaredMimeType: 'application/pdf', operation: 'create_item' as const },
      { fileName: 'x.png', declaredMimeType: 'image/jpeg', operation: 'create_item' as const },
      { fileName: 'x.mp4', declaredMimeType: 'video/mp4', operation: 'attach_preview' as const },
    ]) {
      expect(() => resolveGalleryUploadPolicy(input)).toThrow(GalleryUploadValidationError);
    }
  });

  it('bounds previews far below the original media limits', () => {
    const preview = resolveGalleryUploadPolicy({
      fileName: 'p.jpg',
      declaredMimeType: 'image/jpeg',
      operation: 'attach_preview',
    });
    const original = resolveGalleryUploadPolicy({
      fileName: 'p.jpg',
      declaredMimeType: 'image/jpeg',
      operation: 'create_item',
    });
    expect(preview.maxBytes).toBeLessThan(original.maxBytes);
  });
});

describe('gallery upload stream validation', () => {
  it('hashes and sizes a conforming upload', async () => {
    const policy = resolveGalleryUploadPolicy({
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      operation: 'create_item',
    });
    const validated = createValidatedGalleryUploadStream(
      (async function* () {
        yield pngBytes.subarray(0, 4);
        yield pngBytes.subarray(4);
      })(),
      policy,
    );
    const result = await consume(validated);
    expect(result).toMatchObject({
      sizeBytes: pngBytes.byteLength,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
    });
  });

  it.each([
    ['image/jpeg', 'a.jpg', jpegBytes],
    ['video/mp4', 'a.mp4', mp4Bytes],
    ['video/webm', 'a.webm', webmBytes],
  ] as const)('accepts a matching %s signature', async (mimeType, fileName, bytes) => {
    const policy = resolveGalleryUploadPolicy({
      fileName,
      declaredMimeType: mimeType,
      operation: 'create_item',
    });
    const validated = createValidatedGalleryUploadStream(
      (async function* () {
        yield bytes;
      })(),
      policy,
    );
    await expect(consume(validated)).resolves.toMatchObject({ sizeBytes: bytes.byteLength });
  });

  it('rejects a body whose signature contradicts the declared content type', async () => {
    const policy = resolveGalleryUploadPolicy({
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      operation: 'create_item',
    });
    const validated = createValidatedGalleryUploadStream(
      (async function* () {
        yield jpegBytes;
      })(),
      policy,
    );
    await expect(consume(validated)).rejects.toMatchObject({ code: 'INVALID_MEDIA_SIGNATURE' });
  });

  it('rejects an empty body and one that exceeds the bound mid-stream', async () => {
    const policy = resolveGalleryUploadPolicy({
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      operation: 'attach_preview',
    });
    await expect(
      consume(createValidatedGalleryUploadStream((async function* () {})(), policy)),
    ).rejects.toMatchObject({ code: 'EMPTY_UPLOAD' });
    const oversized = createValidatedGalleryUploadStream(
      (async function* () {
        yield pngBytes;
        yield new Uint8Array(policy.maxBytes);
      })(),
      policy,
    );
    await expect(consume(oversized)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});

describe('gallery object keys', () => {
  it('round-trips tenant, media item and upload scoped keys', () => {
    const sha256 = 'a'.repeat(64);
    const temporary = createGalleryTemporaryObjectKey({ tenantId, mediaItemId, uploadId });
    const final = createGalleryFinalObjectKey({
      tenantId,
      mediaItemId,
      uploadId,
      sha256,
      extension: 'mp4',
    });
    expect(parseObjectKey(temporary)).toEqual({
      kind: 'gallery_temporary',
      tenantId,
      mediaItemId,
      uploadId,
    });
    expect(parseObjectKey(final)).toEqual({
      kind: 'gallery_final',
      tenantId,
      mediaItemId,
      uploadId,
      sha256,
      extension: 'mp4',
    });
  });

  it('refuses keys outside the gallery namespace or with an unsupported extension', () => {
    expect(() =>
      parseObjectKey(
        `private/v1/tenants/${tenantId}/gallery/${mediaItemId}/objects/uploads/${uploadId}/sha256/${'a'.repeat(64)}.pdf`,
      ),
    ).toThrow(InvalidObjectKeyError);
    expect(() => parseObjectKey(`private/v1/tenants/${tenantId}/gallery/${mediaItemId}`)).toThrow(
      InvalidObjectKeyError,
    );
  });
});
