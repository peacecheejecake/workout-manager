import { useEffect, useMemo, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { GalleryWorkspace } from '@workout/modules-gallery/gallery-workspace';
import { createGallerySubtitlesReader } from '@workout/modules-gallery/gallery-subtitles-api';
import { createGalleryRenditionsApi } from '@workout/modules-gallery/gallery-renditions-api';
import { createGalleryNavigationApi } from '@workout/modules-gallery/gallery-navigation-api';
import { createGalleryCourseChoicesApi } from '@workout/modules-gallery/gallery-course-choices-api';
import {
  createDefaultGalleryNavigationQuery,
  readGalleryNavigationSearch,
  writeGalleryNavigationSearch,
} from '@workout/modules-gallery/gallery-navigation-search';
import { galleryMediaKindSchema } from '@workout/contracts/gallery';
import type { GalleryMediaKind } from '@workout/contracts/gallery';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Navigation and renditions are mandatory members of profile27 (no separate switch). Build-time
// copy of the API's WORKOUT_RUNTIME_PROFILE: under baseline107 the API registers neither, so
// the shell keeps the legacy list and shows no rendition panel.
const profile27 = import.meta.env['VITE_WORKOUT_RUNTIME_PROFILE'] === 'installed-current-profile27';
const navigationEnabled = profile27;
const renditionsEnabled = profile27;

function Gallery({
  mediaItemId,
  mediaKind,
  album,
  initialSearch,
}: {
  mediaItemId: string | null;
  mediaKind: GalleryMediaKind | null;
  album: string | null;
  initialSearch: string;
}) {
  const session = useAuthenticatedSession();
  const { transport } = session;
  // One reader per transport so an open viewer does not re-request on every render.
  const subtitlesReader = useMemo(() => createGallerySubtitlesReader(transport), [transport]);
  const renditionsReader = useMemo(
    () => (renditionsEnabled ? createGalleryRenditionsApi(transport) : undefined),
    [transport],
  );
  // The shell owns the URL: explicit applies push history; back/forward re-read it.
  const [search, setSearch] = useState(initialSearch);
  useEffect(() => {
    if (!navigationEnabled) return;
    const read = () => setSearch(window.location.search);
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  const navigationApi = useMemo(
    () => (navigationEnabled ? createGalleryNavigationApi(session.transport) : undefined),
    [session.transport],
  );
  const courseChoicesApi = useMemo(
    () => (navigationEnabled ? createGalleryCourseChoicesApi(session.transport) : undefined),
    [session.transport],
  );
  const externalQuery = useMemo(() => {
    const read = readGalleryNavigationSearch(search.startsWith('?') ? search.slice(1) : search);
    if (read.state === 'valid') return read.query;
    const fallback = createDefaultGalleryNavigationQuery();
    return { ...fallback, filters: { ...fallback.filters, mediaKind } };
  }, [search, mediaKind]);
  return (
    <GalleryWorkspace
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      transport={session.transport}
      mediaTransfer={{
        upload: (input) => session.fileTransfer.uploadGalleryMedia(input),
        open: (input) => session.fileTransfer.openGalleryMedia(input),
      }}
      subtitlesReader={subtitlesReader}
      {...(renditionsReader === undefined ? {} : { renditionsReader })}
      {...(navigationApi === undefined
        ? {}
        : {
            navigation: {
              api: navigationApi,
              externalQuery,
              onNavigate: (query) => {
                const next = `?${writeGalleryNavigationSearch(query)}`;
                window.history.pushState(null, '', `/gallery${next}`);
                setSearch(next);
              },
            },
          })}
      {...(courseChoicesApi === undefined ? {} : { courseChoicesApi })}
      mediaItemId={mediaItemId}
      mediaKind={mediaKind}
      album={album}
    />
  );
}

export function GalleryPage({ path, query }: { path: string; query: string }) {
  const candidate = path.match(/^\/gallery\/([^/]+)\/?$/)?.[1]?.toLowerCase() ?? null;
  if (candidate !== null && !UUID.test(candidate)) {
    return <p role="alert">미디어 주소가 올바르지 않습니다.</p>;
  }
  const parameters = new URLSearchParams(query);
  const mediaKind = galleryMediaKindSchema.safeParse(parameters.get('mediaKind'));
  const album = parameters.get('album');
  return (
    <AuthenticatedWorkspace>
      <Gallery
        mediaItemId={candidate}
        mediaKind={mediaKind.success ? mediaKind.data : null}
        album={album && album.trim() ? album.trim() : null}
        initialSearch={query}
      />
    </AuthenticatedWorkspace>
  );
}
