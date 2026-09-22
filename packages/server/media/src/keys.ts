const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SHA256_PATTERN = '[0-9a-f]{64}';

const temporaryKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/resources/(${UUID_PATTERN})/temporary/(${UUID_PATTERN})$`,
);
const finalKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/resources/(${UUID_PATTERN})/objects/uploads/(${UUID_PATTERN})/sha256/(${SHA256_PATTERN})[.](pdf|md)$`,
);
const galleryTemporaryKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/gallery/(${UUID_PATTERN})/temporary/(${UUID_PATTERN})$`,
);
const galleryFinalKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/gallery/(${UUID_PATTERN})/objects/uploads/(${UUID_PATTERN})/sha256/(${SHA256_PATTERN})[.](jpg|png|webp|mp4|webm)$`,
);
const urlTemporaryKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/resources/(${UUID_PATTERN})/url-ingestions/(${UUID_PATTERN})/temporary/(raw|parsed)$`,
);
const urlFinalKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/resources/(${UUID_PATTERN})/url-ingestions/(${UUID_PATTERN})/(raw|parsed)/sha256/(${SHA256_PATTERN})[.](html|xhtml|txt|md|json)$`,
);
// Recorded-track objects live under their activity, never under a client-supplied path.
// The original file and the two server-built derivatives each get their own key, so an
// upload that is abandoned halfway leaves three deterministic refs the cleanup manifest
// can reclaim by exact key.
const trackTemporaryKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/activities/(${UUID_PATTERN})/tracks/(${UUID_PATTERN})/temporary/(${UUID_PATTERN})/(raw|normalized|map_path)$`,
);
const trackFinalKeyPattern = new RegExp(
  `^private/v1/tenants/(${UUID_PATTERN})/activities/(${UUID_PATTERN})/tracks/(${UUID_PATTERN})/(raw|normalized|map_path)/uploads/(${UUID_PATTERN})/sha256/(${SHA256_PATTERN})[.](fit|gpx|json)$`,
);

declare const temporaryObjectKeyBrand: unique symbol;
declare const finalObjectKeyBrand: unique symbol;

export type TemporaryObjectKey = string & { readonly [temporaryObjectKeyBrand]: true };
export type FinalObjectKey = string & { readonly [finalObjectKeyBrand]: true };
export type ObjectKey = TemporaryObjectKey | FinalObjectKey;
export type StoredFileExtension = 'pdf' | 'md';
export type GalleryMediaExtension = 'jpg' | 'png' | 'webp' | 'mp4' | 'webm';
const GALLERY_MEDIA_EXTENSIONS: readonly string[] = ['jpg', 'png', 'webp', 'mp4', 'webm'];
export type UrlArtifactKind = 'raw' | 'parsed';
export type UrlArtifactExtension = 'html' | 'xhtml' | 'txt' | 'md' | 'json';
export type TrackArtifactKind = 'raw' | 'normalized' | 'map_path';
export type TrackArtifactExtension = 'fit' | 'gpx' | 'json';
const TRACK_ARTIFACT_KINDS: readonly string[] = ['raw', 'normalized', 'map_path'];

/** A derivative is always JSON; an original is always the format it was parsed as. */
function assertTrackArtifactExtension(
  artifactKind: TrackArtifactKind,
  extension: TrackArtifactExtension,
): void {
  const allowed =
    artifactKind === 'raw' ? extension === 'fit' || extension === 'gpx' : extension === 'json';
  if (!allowed) throw new InvalidObjectKeyError();
}

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

export function createGalleryTemporaryObjectKey(input: {
  tenantId: string;
  mediaItemId: string;
  uploadId: string;
}): TemporaryObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const mediaItemId = normalizeUuid(input.mediaItemId);
  const uploadId = normalizeUuid(input.uploadId);
  return `private/v1/tenants/${tenantId}/gallery/${mediaItemId}/temporary/${uploadId}` as TemporaryObjectKey;
}

export function createGalleryFinalObjectKey(input: {
  tenantId: string;
  mediaItemId: string;
  uploadId: string;
  sha256: string;
  extension: GalleryMediaExtension;
}): FinalObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const mediaItemId = normalizeUuid(input.mediaItemId);
  const uploadId = normalizeUuid(input.uploadId);
  const sha256 = input.sha256.toLowerCase();
  if (!new RegExp(`^${SHA256_PATTERN}$`).test(sha256)) throw new InvalidObjectKeyError();
  if (!GALLERY_MEDIA_EXTENSIONS.includes(input.extension)) throw new InvalidObjectKeyError();
  return `private/v1/tenants/${tenantId}/gallery/${mediaItemId}/objects/uploads/${uploadId}/sha256/${sha256}.${input.extension}` as FinalObjectKey;
}

export function createUrlTemporaryObjectKey(input: {
  tenantId: string;
  resourceId: string;
  ingestionId: string;
  artifactKind: UrlArtifactKind;
}): TemporaryObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const resourceId = normalizeUuid(input.resourceId);
  const ingestionId = normalizeUuid(input.ingestionId);
  return `private/v1/tenants/${tenantId}/resources/${resourceId}/url-ingestions/${ingestionId}/temporary/${input.artifactKind}` as TemporaryObjectKey;
}

export function createUrlFinalObjectKey(input: {
  tenantId: string;
  resourceId: string;
  ingestionId: string;
  artifactKind: UrlArtifactKind;
  sha256: string;
  extension: UrlArtifactExtension;
}): FinalObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const resourceId = normalizeUuid(input.resourceId);
  const ingestionId = normalizeUuid(input.ingestionId);
  const sha256 = input.sha256.toLowerCase();
  if (!new RegExp(`^${SHA256_PATTERN}$`).test(sha256)) throw new InvalidObjectKeyError();
  if (input.artifactKind === 'parsed' && input.extension !== 'json')
    throw new InvalidObjectKeyError();
  if (input.artifactKind === 'raw' && input.extension === 'json') throw new InvalidObjectKeyError();
  return `private/v1/tenants/${tenantId}/resources/${resourceId}/url-ingestions/${ingestionId}/${input.artifactKind}/sha256/${sha256}.${input.extension}` as FinalObjectKey;
}

export function createActivityTrackTemporaryObjectKey(input: {
  tenantId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: TrackArtifactKind;
}): TemporaryObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const activityId = normalizeUuid(input.activityId);
  const trackId = normalizeUuid(input.trackId);
  const uploadId = normalizeUuid(input.uploadId);
  if (!TRACK_ARTIFACT_KINDS.includes(input.artifactKind)) throw new InvalidObjectKeyError();
  return `private/v1/tenants/${tenantId}/activities/${activityId}/tracks/${trackId}/temporary/${uploadId}/${input.artifactKind}` as TemporaryObjectKey;
}

export function createActivityTrackFinalObjectKey(input: {
  tenantId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: TrackArtifactKind;
  sha256: string;
  extension: TrackArtifactExtension;
}): FinalObjectKey {
  const tenantId = normalizeUuid(input.tenantId);
  const activityId = normalizeUuid(input.activityId);
  const trackId = normalizeUuid(input.trackId);
  const uploadId = normalizeUuid(input.uploadId);
  const sha256 = input.sha256.toLowerCase();
  if (!new RegExp(`^${SHA256_PATTERN}$`).test(sha256)) throw new InvalidObjectKeyError();
  if (!TRACK_ARTIFACT_KINDS.includes(input.artifactKind)) throw new InvalidObjectKeyError();
  assertTrackArtifactExtension(input.artifactKind, input.extension);
  return `private/v1/tenants/${tenantId}/activities/${activityId}/tracks/${trackId}/${input.artifactKind}/uploads/${uploadId}/sha256/${sha256}.${input.extension}` as FinalObjectKey;
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
    }
  | {
      kind: 'gallery_temporary';
      tenantId: string;
      mediaItemId: string;
      uploadId: string;
    }
  | {
      kind: 'gallery_final';
      tenantId: string;
      mediaItemId: string;
      uploadId: string;
      sha256: string;
      extension: GalleryMediaExtension;
    }
  | {
      kind: 'url_temporary';
      tenantId: string;
      resourceId: string;
      ingestionId: string;
      artifactKind: UrlArtifactKind;
    }
  | {
      kind: 'url_final';
      tenantId: string;
      resourceId: string;
      ingestionId: string;
      artifactKind: UrlArtifactKind;
      sha256: string;
      extension: UrlArtifactExtension;
    }
  | {
      kind: 'track_temporary';
      tenantId: string;
      activityId: string;
      trackId: string;
      uploadId: string;
      artifactKind: TrackArtifactKind;
    }
  | {
      kind: 'track_final';
      tenantId: string;
      activityId: string;
      trackId: string;
      uploadId: string;
      artifactKind: TrackArtifactKind;
      sha256: string;
      extension: TrackArtifactExtension;
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
  const galleryTemporaryMatch = galleryTemporaryKeyPattern.exec(value);
  if (galleryTemporaryMatch) {
    const [, tenantId, mediaItemId, uploadId] = galleryTemporaryMatch;
    if (!tenantId || !mediaItemId || !uploadId) throw new InvalidObjectKeyError();
    return { kind: 'gallery_temporary', tenantId, mediaItemId, uploadId };
  }
  const galleryFinalMatch = galleryFinalKeyPattern.exec(value);
  if (galleryFinalMatch) {
    const [, tenantId, mediaItemId, uploadId, sha256, extension] = galleryFinalMatch;
    if (
      !tenantId ||
      !mediaItemId ||
      !uploadId ||
      !sha256 ||
      !extension ||
      !GALLERY_MEDIA_EXTENSIONS.includes(extension)
    )
      throw new InvalidObjectKeyError();
    return {
      kind: 'gallery_final',
      tenantId,
      mediaItemId,
      uploadId,
      sha256,
      extension: extension as GalleryMediaExtension,
    };
  }
  const urlTemporaryMatch = urlTemporaryKeyPattern.exec(value);
  if (urlTemporaryMatch) {
    const [, tenantId, resourceId, ingestionId, artifactKind] = urlTemporaryMatch;
    if (
      !tenantId ||
      !resourceId ||
      !ingestionId ||
      (artifactKind !== 'raw' && artifactKind !== 'parsed')
    )
      throw new InvalidObjectKeyError();
    return { kind: 'url_temporary', tenantId, resourceId, ingestionId, artifactKind };
  }
  const urlFinalMatch = urlFinalKeyPattern.exec(value);
  if (urlFinalMatch) {
    const [, tenantId, resourceId, ingestionId, artifactKind, sha256, extension] = urlFinalMatch;
    if (
      !tenantId ||
      !resourceId ||
      !ingestionId ||
      !sha256 ||
      (artifactKind !== 'raw' && artifactKind !== 'parsed') ||
      !extension ||
      !['html', 'xhtml', 'txt', 'md', 'json'].includes(extension) ||
      (artifactKind === 'parsed' && extension !== 'json') ||
      (artifactKind === 'raw' && extension === 'json')
    )
      throw new InvalidObjectKeyError();
    return {
      kind: 'url_final',
      tenantId,
      resourceId,
      ingestionId,
      artifactKind,
      sha256,
      extension: extension as UrlArtifactExtension,
    };
  }
  const trackTemporaryMatch = trackTemporaryKeyPattern.exec(value);
  if (trackTemporaryMatch) {
    const [, tenantId, activityId, trackId, uploadId, artifactKind] = trackTemporaryMatch;
    if (
      !tenantId ||
      !activityId ||
      !trackId ||
      !uploadId ||
      !artifactKind ||
      !TRACK_ARTIFACT_KINDS.includes(artifactKind)
    )
      throw new InvalidObjectKeyError();
    return {
      kind: 'track_temporary',
      tenantId,
      activityId,
      trackId,
      uploadId,
      artifactKind: artifactKind as TrackArtifactKind,
    };
  }
  const trackFinalMatch = trackFinalKeyPattern.exec(value);
  if (trackFinalMatch) {
    const [, tenantId, activityId, trackId, artifactKind, uploadId, sha256, extension] =
      trackFinalMatch;
    if (
      !tenantId ||
      !activityId ||
      !trackId ||
      !uploadId ||
      !sha256 ||
      !artifactKind ||
      !TRACK_ARTIFACT_KINDS.includes(artifactKind) ||
      !extension ||
      !['fit', 'gpx', 'json'].includes(extension)
    )
      throw new InvalidObjectKeyError();
    assertTrackArtifactExtension(
      artifactKind as TrackArtifactKind,
      extension as TrackArtifactExtension,
    );
    return {
      kind: 'track_final',
      tenantId,
      activityId,
      trackId,
      uploadId,
      artifactKind: artifactKind as TrackArtifactKind,
      sha256,
      extension: extension as TrackArtifactExtension,
    };
  }
  throw new InvalidObjectKeyError();
}

export function validateObjectKey(value: string): ObjectKey {
  parseObjectKey(value);
  return value as ObjectKey;
}
