import { createHash } from 'node:crypto';

import type { StoredFileExtension } from './keys.js';

const MEBIBYTE = 1024 * 1024;
export const MAX_PDF_BYTES = 10 * MEBIBYTE;
export const MAX_MARKDOWN_BYTES = MEBIBYTE;

export type SupportedUploadFormat = 'pdf' | 'markdown';

export interface UploadFormatPolicy {
  readonly format: SupportedUploadFormat;
  readonly extension: StoredFileExtension;
  readonly mimeType: 'application/pdf' | 'text/markdown';
  readonly maxBytes: number;
}

export interface ValidatedUpload {
  readonly format: SupportedUploadFormat;
  readonly extension: StoredFileExtension;
  readonly mimeType: UploadFormatPolicy['mimeType'];
  readonly sizeBytes: number;
  readonly sha256: string;
}

export class UploadValidationError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_UPLOAD'
      | 'FILE_TOO_LARGE'
      | 'INVALID_PDF_HEADER'
      | 'INVALID_TEXT_ENCODING'
      | 'UNSUPPORTED_FILE_TYPE'
      | 'UNSUPPORTED_TEXT_CHARACTER',
    message: string,
  ) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

export function resolveUploadPolicy(input: {
  fileName: string;
  declaredMimeType: string;
}): UploadFormatPolicy {
  const extension = input.fileName.slice(input.fileName.lastIndexOf('.') + 1).toLowerCase();
  const mimeType = input.declaredMimeType.trim().toLowerCase();
  if (extension === 'pdf' && mimeType === 'application/pdf') {
    return { format: 'pdf', extension: 'pdf', mimeType, maxBytes: MAX_PDF_BYTES };
  }
  if ((extension === 'md' || extension === 'markdown') && mimeType === 'text/markdown') {
    return { format: 'markdown', extension: 'md', mimeType, maxBytes: MAX_MARKDOWN_BYTES };
  }
  throw new UploadValidationError(
    'UNSUPPORTED_FILE_TYPE',
    'Only matching PDF (.pdf, application/pdf) and Markdown (.md/.markdown, text/markdown) files are supported.',
  );
}

function assertAllowedMarkdownCharacters(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const isAllowedAsciiWhitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
    const isControl = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    if (isControl && !isAllowedAsciiWhitespace) {
      throw new UploadValidationError(
        'UNSUPPORTED_TEXT_CHARACTER',
        'Markdown contains a disallowed control character.',
      );
    }
  }
}

export function createValidatedUploadStream(
  input: AsyncIterable<Uint8Array>,
  policy: UploadFormatPolicy,
): { readonly body: AsyncIterable<Uint8Array>; readonly result: Promise<ValidatedUpload> } {
  let resolveResult!: (result: ValidatedUpload) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<ValidatedUpload>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The stream is the primary failure channel. Attach a handler immediately so a consumer that
  // awaits stream consumption before `result` does not create a transient unhandled rejection.
  void result.catch(() => undefined);

  async function* validate(): AsyncGenerator<Uint8Array> {
    const hash = createHash('sha256');
    const decoder = policy.format === 'markdown' ? new TextDecoder('utf-8', { fatal: true }) : null;
    const pdfHeader = new Uint8Array(5);
    let pdfHeaderLength = 0;
    let sizeBytes = 0;
    try {
      for await (const value of input) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (chunk.byteLength === 0) continue;
        sizeBytes += chunk.byteLength;
        if (sizeBytes > policy.maxBytes) {
          throw new UploadValidationError(
            'FILE_TOO_LARGE',
            `Upload exceeds the ${policy.maxBytes} byte limit.`,
          );
        }
        hash.update(chunk);
        if (policy.format === 'pdf' && pdfHeaderLength < pdfHeader.byteLength) {
          const copyLength = Math.min(pdfHeader.byteLength - pdfHeaderLength, chunk.byteLength);
          pdfHeader.set(chunk.subarray(0, copyLength), pdfHeaderLength);
          pdfHeaderLength += copyLength;
        }
        if (decoder) {
          try {
            assertAllowedMarkdownCharacters(decoder.decode(chunk, { stream: true }));
          } catch (error) {
            if (error instanceof UploadValidationError) throw error;
            throw new UploadValidationError(
              'INVALID_TEXT_ENCODING',
              'Markdown must be valid UTF-8.',
            );
          }
        }
        yield chunk;
      }
      if (sizeBytes === 0)
        throw new UploadValidationError('EMPTY_UPLOAD', 'Upload must not be empty.');
      if (policy.format === 'pdf') {
        const expectedHeader = [0x25, 0x50, 0x44, 0x46, 0x2d];
        if (
          pdfHeaderLength !== expectedHeader.length ||
          expectedHeader.some((byte, index) => pdfHeader[index] !== byte)
        ) {
          throw new UploadValidationError('INVALID_PDF_HEADER', 'PDF must start with %PDF-.');
        }
      }
      if (decoder) {
        try {
          assertAllowedMarkdownCharacters(decoder.decode());
        } catch (error) {
          if (error instanceof UploadValidationError) throw error;
          throw new UploadValidationError('INVALID_TEXT_ENCODING', 'Markdown must be valid UTF-8.');
        }
      }
      resolveResult({
        format: policy.format,
        extension: policy.extension,
        mimeType: policy.mimeType,
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
