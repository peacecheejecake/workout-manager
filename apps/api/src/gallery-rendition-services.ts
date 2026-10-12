import type { Database } from '@workout/server-persistence/database';
import { probeGalleryRenditionRuntimeV1In } from '@workout/server-persistence/gallery-rendition-pins-v1';
import { createGalleryRenditionReader } from '@workout/server-persistence/gallery-renditions';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import type { GalleryRenditionServices } from './gallery-rendition-routes.js';

export class GalleryRenditionCompositionError extends Error {
  constructor() {
    super('GALLERY_RENDITION_EXTENSION_UNAVAILABLE');
    this.name = 'GalleryRenditionCompositionError';
  }
}

/**
 * Startup check with the API runtime role (M2-03c): the two read RPCs are executable, no
 * worker RPC and no extension table is reachable. Fails closed instead of registering the
 * rendition routes over a missing or over-granted installation.
 */
export async function createVerifiedGalleryRenditionServices(
  database: Database,
  storage: Pick<ObjectStorage, 'open'>,
): Promise<GalleryRenditionServices> {
  if (typeof database.snapshotCatalog !== 'function') throw new GalleryRenditionCompositionError();
  const state = await database.snapshotCatalog((tx) => probeGalleryRenditionRuntimeV1In(tx, 'api'));
  if (state !== 'available') throw new GalleryRenditionCompositionError();
  return { reader: createGalleryRenditionReader(database), storage };
}
