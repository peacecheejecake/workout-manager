import { describe, expect, it } from 'vitest';

import {
  createFinalObjectKey,
  createTemporaryObjectKey,
  InvalidObjectKeyError,
  parseObjectKey,
  validateObjectKey,
} from '../src/keys.js';
import {
  createValidatedUploadStream,
  MAX_MARKDOWN_BYTES,
  resolveUploadPolicy,
  UploadValidationError,
} from '../src/validation.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* values;
}

async function consume(body: AsyncIterable<Uint8Array>): Promise<number> {
  let size = 0;
  for await (const chunk of body) size += chunk.byteLength;
  return size;
}

describe('private object keys', () => {
  it('builds and parses tenant/resource isolated temporary and content-addressed keys', () => {
    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId,
    });
    expect(parseObjectKey(temporary)).toEqual({
      kind: 'temporary',
      tenantId,
      resourceId,
      uploadId,
    });

    const sha256 = 'd'.repeat(64);
    const final = createFinalObjectKey({ tenantId, resourceId, uploadId, sha256, extension: 'md' });
    expect(parseObjectKey(final)).toEqual({
      kind: 'final',
      tenantId,
      resourceId,
      uploadId,
      sha256,
      extension: 'md',
    });
    expect(validateObjectKey(final)).toBe(final);
  });

  it.each([
    '../escape',
    `private/v1/tenants/${tenantId}/resources/${resourceId}/temporary/../../escape`,
    `private/v1/tenants/${tenantId}/resources/${resourceId}/objects/uploads/${uploadId}/sha256/${'z'.repeat(64)}.pdf`,
  ])('rejects unbranded traversal or malformed runtime keys: %s', (value) => {
    expect(() => parseObjectKey(value)).toThrow(InvalidObjectKeyError);
    expect(() => validateObjectKey(value)).toThrow(InvalidObjectKeyError);
  });
});

describe('central upload validation', () => {
  it('requires an allowlisted matching extension and MIME pair', () => {
    expect(
      resolveUploadPolicy({ fileName: 'guide.PDF', declaredMimeType: 'application/pdf' }),
    ).toEqual(
      expect.objectContaining({ format: 'pdf', extension: 'pdf', maxBytes: 10 * 1024 * 1024 }),
    );
    expect(
      resolveUploadPolicy({ fileName: 'notes.markdown', declaredMimeType: 'text/markdown' }),
    ).toEqual(
      expect.objectContaining({ format: 'markdown', extension: 'md', maxBytes: 1024 * 1024 }),
    );
    expect(() =>
      resolveUploadPolicy({ fileName: 'renamed.pdf', declaredMimeType: 'text/markdown' }),
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FILE_TYPE' }));
  });

  it('streams PDF chunks, including a split signature, while hashing exact bytes', async () => {
    const policy = resolveUploadPolicy({
      fileName: 'paper.pdf',
      declaredMimeType: 'application/pdf',
    });
    const validated = createValidatedUploadStream(
      chunks(Buffer.from('%P'), Buffer.from('DF-1.7\nsynthetic')),
      policy,
    );
    expect(await consume(validated.body)).toBe(18);
    await expect(validated.result).resolves.toEqual({
      format: 'pdf',
      extension: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: 18,
      sha256: '5aea7a7a5e33d66d021fd52802ceb64ac5b8f377b2be55fddca8607f093ce3ce',
    });
  });

  it('rejects a PDF without the required magic header', async () => {
    const validated = createValidatedUploadStream(
      chunks(Buffer.from('plain text')),
      resolveUploadPolicy({ fileName: 'fake.pdf', declaredMimeType: 'application/pdf' }),
    );
    await expect(consume(validated.body)).rejects.toMatchObject({ code: 'INVALID_PDF_HEADER' });
    await expect(validated.result).rejects.toMatchObject({ code: 'INVALID_PDF_HEADER' });
  });

  it('accepts split UTF-8 and rejects invalid UTF-8, NUL and non-allowlisted controls', async () => {
    const policy = resolveUploadPolicy({ fileName: 'note.md', declaredMimeType: 'text/markdown' });
    const encoded = Buffer.from('# 달리기\n메모');
    const valid = createValidatedUploadStream(
      chunks(encoded.subarray(0, 4), encoded.subarray(4)),
      policy,
    );
    await expect(consume(valid.body)).resolves.toBe(encoded.byteLength);
    await expect(valid.result).resolves.toMatchObject({
      format: 'markdown',
      sizeBytes: encoded.byteLength,
    });

    for (const content of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from('a\0b'),
      Buffer.from([0x61, 0xc2, 0x85]),
    ]) {
      const invalid = createValidatedUploadStream(chunks(content), policy);
      await expect(consume(invalid.body)).rejects.toBeInstanceOf(UploadValidationError);
      await expect(invalid.result).rejects.toBeInstanceOf(UploadValidationError);
    }
  });

  it('stops as soon as a streamed Markdown upload crosses its byte bound', async () => {
    const policy = resolveUploadPolicy({ fileName: 'note.md', declaredMimeType: 'text/markdown' });
    const validated = createValidatedUploadStream(
      chunks(new Uint8Array(MAX_MARKDOWN_BYTES).fill(0x61), new Uint8Array([0x61])),
      policy,
    );
    await expect(consume(validated.body)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(validated.result).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});
