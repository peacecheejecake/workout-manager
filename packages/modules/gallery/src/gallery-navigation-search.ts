import {
  galleryMediaNavigationQueryV2Schema,
  galleryNavigationV2Limits,
  type GalleryMediaNavigationQueryV2,
} from '@workout/contracts/gallery-navigation-v2';

const parameter = 'query';
const searchBytes = galleryNavigationV2Limits.encodedBytes * 3 + parameter.length + 2;
const byteLength = (value: string) => new TextEncoder().encode(value).length;

export function createDefaultGalleryNavigationQuery(): GalleryMediaNavigationQueryV2 {
  return {
    filters: {
      album: { mode: 'all' },
      mediaKind: null,
      activityId: null,
      courseLink: null,
      capturedDay: { mode: 'all' },
    },
    limit: 50,
    sort: 'created_desc_id_asc',
    cursor: null,
  };
}

export type GalleryNavigationSearchResult =
  | { state: 'missing'; query: GalleryMediaNavigationQueryV2 }
  | { state: 'valid'; query: GalleryMediaNavigationQueryV2 }
  | {
      state: 'invalid';
      reason: 'INVALID_SEARCH' | 'SEARCH_TOO_LARGE' | 'INVALID_QUERY';
      query: GalleryMediaNavigationQueryV2;
    };

function invalid(reason: Extract<GalleryNavigationSearchResult, { state: 'invalid' }>['reason']) {
  return {
    state: 'invalid' as const,
    reason,
    query: createDefaultGalleryNavigationQuery(),
  };
}

/** Same query=JSON convention as the Gallery transport; no tenant identity or permission is encoded. */
export function readGalleryNavigationSearch(raw: unknown): GalleryNavigationSearchResult {
  if (typeof raw !== 'string') return invalid('INVALID_SEARCH');
  if (raw.length > searchBytes || byteLength(raw) > searchBytes) return invalid('SEARCH_TOO_LARGE');
  const values = new URLSearchParams(raw).getAll(parameter);
  if (values.length === 0)
    return { state: 'missing', query: createDefaultGalleryNavigationQuery() };
  if (values.length !== 1 || values[0] === undefined) return invalid('INVALID_QUERY');
  const encoded = values[0];
  if (
    encoded.length > galleryNavigationV2Limits.encodedBytes ||
    byteLength(encoded) > galleryNavigationV2Limits.encodedBytes
  )
    return invalid('SEARCH_TOO_LARGE');
  try {
    const value: unknown = JSON.parse(encoded);
    const parsed = galleryMediaNavigationQueryV2Schema.safeParse(value);
    return parsed.success ? { state: 'valid', query: parsed.data } : invalid('INVALID_QUERY');
  } catch {
    return invalid('INVALID_QUERY');
  }
}

export class GalleryNavigationSearchError extends Error {
  constructor() {
    super('INVALID_GALLERY_NAVIGATION_QUERY');
    this.name = 'GalleryNavigationSearchError';
  }
}

/** Emit only schema-validated navigation fields; never retain unrelated URL parameters. */
export function writeGalleryNavigationSearch(raw: unknown): string {
  try {
    const parsed = galleryMediaNavigationQueryV2Schema.safeParse(raw);
    if (!parsed.success) throw new GalleryNavigationSearchError();
    return new URLSearchParams({
      [parameter]: JSON.stringify(parsed.data),
    }).toString();
  } catch {
    throw new GalleryNavigationSearchError();
  }
}
