const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SHA256_PATTERN = '[0-9a-f]{64}';

const temporaryKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/resources/(${UUID_PATTERN})/temporary/(${UUID_PATTERN})$`,
);
const finalKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/resources/(${UUID_PATTERN})/objects/uploads/(${UUID_PATTERN})/sha256/(${SHA256_PATTERN})\\.(pdf|md)$`,
);

declare const temporaryObjectKeyBrand: unique symbol;
declare const finalObjectKeyBrand: unique symbol;

export type TemporaryObjectKey = string & { readonly [temporaryObjectKeyBrand]: true };
export type FinalObjectKey = string & { readonly [finalObjectKeyBrand]: true };
export type ObjectKey = TemporaryObjectKey | FinalObjectKey;
export type StoredFileExtension = 'pdf' | 'md';

export class InvalidObjectKeyError extends Error {
  readonly code = 'INVALID_OBJECT_KEY';

  constructor() {
    super('Object key is not a valid private storage key.');
    this.name = 'InvalidObjectKeyError';
  }
}

function normalizeUuid(value: string): string {
  const normalized = value.toLowerCase();
  if (!new RegExp(`^${UUID_PATTERN}$`).test(normalized)) throw new InvalidObjectKeyError();
  return normalized;
}

export function createTemporaryObjectKey(input: {
  tenantId: string;
  resourceId: string;
  uploadId: string;
}): TemporaryObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const resourceId = normalizeUuid(input.resourceId);
  const uploadId = normalizeUuid(input.uploadId);
  return `private/v1/tenants/${tenantId}/resources/${resourceId}/temporary/${uploadId}` as TemporaryObjectKey;
}

export function createFinalObjectKey(input: {
  tenantId: string;
  resourceId: string;
  uploadId: string;
  sha256: string;
  extension: StoredFileExtension;
}): FinalObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const resourceId = normalizeUuid(input.resourceId);
  const uploadId = normalizeUuid(input.uploadId);
  const sha256 = input.sha256.toLowerCase();
  if (!new RegExp(`^${SHA256_PATTERN}$`).test(sha256)) throw new InvalidObjectKeyError();
  return `private/v1/tenants/${tenantId}/resources/${resourceId}/objects/uploads/${uploadId}/sha256/${sha256}.${input.extension}` as FinalObjectKey;
}

export type ParsedObjectKey =
  | {
      kind: 'temporary';
      tenantId: string;
      resourceId: string;
      uploadId: string;
    }
  | {
      kind: 'final';
      tenantId: string;
      resourceId: string;
      uploadId: string;
      sha256: string;
      extension: StoredFileExtension;
    };

export function parseObjectKey(value: string): ParsedObjectKey {
  const temporaryMatch = temporaryKeyPattern.exec(value);
  if (temporaryMatch) {
    const [, tenantId, resourceId, uploadId] = temporaryMatch;
    if (!tenantId || !resourceId || !uploadId) {
      throw new InvalidObjectKeyError();
    }
    return {
      kind: 'temporary',
      tenantId,
      resourceId,
      uploadId,
    };
  }
  const finalMatch = finalKeyPattern.exec(value);
  if (finalMatch) {
    const [, tenantId, resourceId, uploadId, sha256, extension] = finalMatch;
    if (
      !tenantId ||
      !resourceId ||
      !uploadId ||
      !sha256 ||
      (extension !== 'pdf' && extension !== 'md')
    ) {
      throw new InvalidObjectKeyError();
    }
    return {
      kind: 'final',
      tenantId,
      resourceId,
      uploadId,
      sha256,
      extension,
    };
  }
  throw new InvalidObjectKeyError();
}

export function validateObjectKey(value: string): ObjectKey {
  parseObjectKey(value);
  return value as ObjectKey;
}
