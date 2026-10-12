import { types } from 'node:util';
import { galleryMediaReadResultSchema } from '@workout/contracts/gallery';
import {
  gallerySubtitleReadRequestV1Schema,
  gallerySubtitleReadResultV1Schema,
  type GallerySubtitleReadRequestV1,
  type GallerySubtitleReadResultV1,
} from '@workout/contracts/gallery-subtitles-v1';

/** Authoritative adapter must enforce existing gallery read authorization, authenticated tenant/RLS and
 * lifecycle/erasure fences, active owned video and exact current access revision
 * in one snapshot before reading active cues. Reads do not acquire write admission.
 * Deleted/foreign media share MEDIA_NOT_FOUND. No raw file, storage ref or URL is returned.
 */
export interface GallerySubtitlesReadPort {
  read(athleteId: string, input: GallerySubtitleReadRequestV1): Promise<unknown>; // Exact internal snapshot: { media: GalleryMediaReadResult, subtitles: unknown }.
}
export class GallerySubtitlesServiceError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'INVALID_REPLY'
      | 'MEDIA_NOT_FOUND'
      | 'MEDIA_ACCESS_CONFLICT'
      | 'GALLERY_SUBTITLES_UNAVAILABLE',
  ) {
    super(code);
  }
}

// JSON transports cannot contain proxies; injected adapters still return unknown.
function validatePlainAdapterValue(value: unknown): void {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (++count > 20_000) throw new GallerySubtitlesServiceError('INVALID_REPLY');
    if (typeof entry !== 'object' || entry === null) continue;
    if (types.isProxy(entry)) throw new GallerySubtitlesServiceError('INVALID_REPLY');
    if (seen.has(entry)) continue;
    seen.add(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (
      Array.isArray(entry)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new GallerySubtitlesServiceError('INVALID_REPLY');
    const array = Array.isArray(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (
      Reflect.ownKeys(entry).some((key) => typeof key !== 'string') ||
      Object.keys(descriptors).length - (array ? 1 : 0) > 20_000
    )
      throw new GallerySubtitlesServiceError('INVALID_REPLY');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor)) throw new GallerySubtitlesServiceError('INVALID_REPLY');
      // Array length is shape metadata, not a serialized JSON value/node.
      if (array && key === 'length') continue;
      pending.push(descriptor.value);
    }
  }
}

/** Boundary validation is preparation, not an implemented persistence adapter. */
export function createGallerySubtitlesReadService(port: GallerySubtitlesReadPort) {
  return {
    async read(athleteId: string, raw: unknown): Promise<GallerySubtitleReadResultV1> {
      const request = gallerySubtitleReadRequestV1Schema.safeParse(raw);
      if (!request.success) throw new GallerySubtitlesServiceError('INVALID_REQUEST');
      const snapshot: unknown = await port.read(athleteId, request.data);
      try {
        if (
          typeof snapshot !== 'object' ||
          snapshot === null ||
          types.isProxy(snapshot) ||
          Array.isArray(snapshot)
        )
          throw new GallerySubtitlesServiceError('INVALID_REPLY');
        const prototype: unknown = Object.getPrototypeOf(snapshot);
        const descriptors = Object.getOwnPropertyDescriptors(snapshot);
        if (
          (prototype !== Object.prototype && prototype !== null) ||
          Reflect.ownKeys(snapshot).length !== 2 ||
          !descriptors['media'] ||
          !('value' in descriptors['media']) ||
          !descriptors['subtitles'] ||
          !('value' in descriptors['subtitles'])
        )
          throw new GallerySubtitlesServiceError('INVALID_REPLY');
        const rawMedia: unknown = descriptors['media'].value;
        validatePlainAdapterValue(rawMedia);
        const media = galleryMediaReadResultSchema.safeParse(rawMedia);
        if (!media.success) throw new GallerySubtitlesServiceError('INVALID_REPLY');
        if (media.data.status !== 'available') {
          if (media.data.mediaItemId !== request.data.mediaItemId)
            throw new GallerySubtitlesServiceError('INVALID_REPLY');
          throw new GallerySubtitlesServiceError('MEDIA_NOT_FOUND');
        }
        if (media.data.item.id !== request.data.mediaItemId)
          throw new GallerySubtitlesServiceError('INVALID_REPLY');
        if (media.data.item.mediaKind !== 'video')
          throw new GallerySubtitlesServiceError('MEDIA_NOT_FOUND');
        if (media.data.item.accessRevision !== request.data.accessRevision)
          throw new GallerySubtitlesServiceError('MEDIA_ACCESS_CONFLICT');
        const rawResult: unknown = descriptors['subtitles'].value;
        validatePlainAdapterValue(rawResult);
        const result = gallerySubtitleReadResultV1Schema.safeParse(rawResult);
        if (
          !result.success ||
          result.data.mediaItemId.toLowerCase() !== request.data.mediaItemId ||
          result.data.accessRevision !== request.data.accessRevision
        )
          throw new GallerySubtitlesServiceError('INVALID_REPLY');
        return result.data;
      } catch (error) {
        if (error instanceof GallerySubtitlesServiceError) throw error;
        throw new GallerySubtitlesServiceError('INVALID_REPLY');
      }
    },
  };
}
export type GallerySubtitlesReadService = ReturnType<typeof createGallerySubtitlesReadService>;
