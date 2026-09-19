import { createFinalObjectKey, createTemporaryObjectKey } from './keys.js';
import type { FinalObjectKey, TemporaryObjectKey } from './keys.js';
import type { ObjectStorage, PublishResult } from './object-storage.js';
import {
  createValidatedUploadStream,
  resolveUploadPolicy,
  type SupportedUploadFormat,
} from './validation.js';

export interface StoredValidatedUpload {
  readonly key: FinalObjectKey;
  readonly outcome: PublishResult['outcome'];
  readonly format: SupportedUploadFormat;
  readonly mimeType: 'application/pdf' | 'text/markdown';
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface PreparedValidatedUpload {
  readonly temporaryKey: TemporaryObjectKey;
  readonly finalKey: FinalObjectKey;
  readonly format: SupportedUploadFormat;
  readonly mimeType: 'application/pdf' | 'text/markdown';
  readonly sizeBytes: number;
  readonly sha256: string;
}

export async function storeValidatedUpload(input: {
  storage: ObjectStorage;
  tenantId: string;
  resourceId: string;
  uploadId: string;
  fileName: string;
  declaredMimeType: string;
  body: AsyncIterable<Uint8Array>;
  /** Persist both refs durably before this callback resolves. */
  onPrepared(prepared: PreparedValidatedUpload): Promise<void>;
}): Promise<StoredValidatedUpload> {
  const policy = resolveUploadPolicy(input);
  const temporaryKey = createTemporaryObjectKey({
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    uploadId: input.uploadId,
  });
  const validated = createValidatedUploadStream(input.body, policy);
  let temporaryOwned = false;
  let durablyPrepared = false;
  try {
    const temporary = await input.storage.writeTemporary(temporaryKey, validated.body);
    temporaryOwned = true;
    const result = await validated.result;
    if (temporary.sizeBytes !== result.sizeBytes) {
      throw new Error('Object storage reported a size that differs from the validated stream.');
    }
    const finalKey = createFinalObjectKey({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      uploadId: input.uploadId,
      sha256: result.sha256,
      extension: result.extension,
    });
    await input.onPrepared({
      temporaryKey,
      finalKey,
      format: result.format,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
    });
    durablyPrepared = true;
    const published = await input.storage.publishTemporary(temporaryKey, finalKey, result);
    return {
      key: published.key,
      outcome: published.outcome,
      format: result.format,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
    };
  } catch (error) {
    if (temporaryOwned && !durablyPrepared) {
      await input.storage.delete(temporaryKey).catch(() => undefined);
    }
    void validated.result.catch(() => undefined);
    throw error;
  }
}
