import type { Database } from '@workout/server-persistence/database';
import {
  createGalleryAlbumCommandRepository,
  GalleryAlbumCommandError,
} from '@workout/server-persistence/gallery-album-commands';
import { readGalleryAlbumPageIn } from '@workout/server-persistence/gallery-album-queries';
import { readGalleryNavigationPageIn } from '@workout/server-persistence/gallery-navigation-queries';
import { probeGalleryNavigationRuntimeV1In } from '@workout/server-persistence/gallery-navigation-pins-v1';
import {
  GalleryNavigationServiceError,
  type GalleryNavigationServices,
} from './gallery-navigation-routes.js';

type ServiceCode = GalleryNavigationServiceError['code'];
const commandCodes: Partial<Record<GalleryAlbumCommandError['code'], ServiceCode>> = {
  ALBUM_NOT_FOUND: 'ALBUM_NOT_FOUND',
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  COURSE_NOT_FOUND: 'COURSE_NOT_FOUND',
  ALBUM_CONFLICT: 'ALBUM_CONFLICT',
  MEDIA_ACCESS_CONFLICT: 'MEDIA_ACCESS_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  // A committed restore target, missing installation/grant or erased account
  // never becomes a write; the caller sees a finite unavailable state.
  RESTORE_PROCESSING_CLOSED: 'GALLERY_NAVIGATION_UNAVAILABLE',
  GALLERY_ALBUM_COMMAND_UNAVAILABLE: 'GALLERY_NAVIGATION_UNAVAILABLE',
  ACCOUNT_ERASED: 'GALLERY_NAVIGATION_UNAVAILABLE',
};
async function translated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GalleryAlbumCommandError) {
      const code = commandCodes[error.code];
      if (code) throw new GalleryNavigationServiceError(code);
    }
    throw error;
  }
}

/** Owned gallery navigation over the installed SQL143 extension. Ownership comes
 * only from the authenticated athlete passed by the route; each call opens its
 * own tenant transaction. Replies are validated again at the route boundary. */
export function createGalleryNavigationServices(
  database: Pick<Database, 'tenant'>,
): GalleryNavigationServices {
  const commands = createGalleryAlbumCommandRepository(database);
  return {
    navigate: (athleteId, query) =>
      database.tenant(athleteId, (tx) => readGalleryNavigationPageIn(tx, query)),
    listAlbums: (athleteId, query) =>
      database.tenant(athleteId, (tx) => readGalleryAlbumPageIn(tx, query)),
    createAlbum: (athleteId, value, key) =>
      translated(() => commands.createAlbum(athleteId, value, key)),
    renameAlbum: (athleteId, value, key) =>
      translated(() => commands.renameAlbum(athleteId, value, key)),
    deleteAlbum: (athleteId, value, key) =>
      translated(() => commands.deleteAlbum(athleteId, value, key)),
    updateMembership: (athleteId, value, key) =>
      translated(() => commands.updateMembership(athleteId, value, key)),
  };
}

export class GalleryNavigationCompositionError extends Error {
  constructor() {
    super('GALLERY_NAVIGATION_EXTENSION_UNAVAILABLE');
    this.name = 'GalleryNavigationCompositionError';
  }
}
/** Startup check with the runtime role: required privileges exist and no DML or
 * receipt access was delegated. Fails closed instead of registering a writer. */
export async function createVerifiedGalleryNavigationServices(
  database: Pick<Database, 'tenant' | 'snapshotCatalog'>,
) {
  if (typeof database.snapshotCatalog !== 'function') throw new GalleryNavigationCompositionError();
  const state = await database.snapshotCatalog((tx) => probeGalleryNavigationRuntimeV1In(tx));
  if (state !== 'available') throw new GalleryNavigationCompositionError();
  return createGalleryNavigationServices(database);
}
