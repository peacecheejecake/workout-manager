'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
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
import type { GalleryMediaKind } from '@workout/contracts/gallery';

function Gallery({
  mediaItemId,
  mediaKind,
  album,
  navigationSearch,
  renditionsEnabled,
}: {
  mediaItemId: string | null;
  mediaKind: GalleryMediaKind | null;
  album: string | null;
  navigationSearch: string | null;
  renditionsEnabled: boolean;
}) {
  const session = useAuthenticatedSession();
  const { transport } = session;
  // One reader per transport so an open viewer does not re-request on every render.
  const subtitlesReader = useMemo(() => createGallerySubtitlesReader(transport), [transport]);
  const renditionsReader = useMemo(
    () => (renditionsEnabled ? createGalleryRenditionsApi(transport) : undefined),
    [renditionsEnabled, transport],
  );
  const router = useRouter();
  const enabled = navigationSearch !== null;
  const navigationApi = useMemo(
    () => (enabled ? createGalleryNavigationApi(session.transport) : undefined),
    [enabled, session.transport],
  );
  const courseChoicesApi = useMemo(
    () => (enabled ? createGalleryCourseChoicesApi(session.transport) : undefined),
    [enabled, session.transport],
  );
  // The URL is the shareable source of the applied query; an absent or invalid
  // value is the default query with the legacy media-kind filter, never a guess.
  const externalQuery = useMemo(() => {
    if (navigationSearch === null) return undefined;
    const read = readGalleryNavigationSearch(navigationSearch);
    if (read.state === 'valid') return read.query;
    const fallback = createDefaultGalleryNavigationQuery();
    return { ...fallback, filters: { ...fallback.filters, mediaKind } };
  }, [navigationSearch, mediaKind]);
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
      {...(navigationApi === undefined || externalQuery === undefined
        ? {}
        : {
            navigation: {
              api: navigationApi,
              externalQuery,
              onNavigate: (query) =>
                router.push(`/gallery?${writeGalleryNavigationSearch(query)}`, { scroll: false }),
            },
          })}
      {...(courseChoicesApi === undefined ? {} : { courseChoicesApi })}
      mediaItemId={mediaItemId}
      mediaKind={mediaKind}
      album={album}
    />
  );
}

export function GalleryPage({
  mediaItemId = null,
  mediaKind = null,
  album = null,
  navigationSearch = null,
  renditionsEnabled = false,
}: {
  mediaItemId?: string | null;
  mediaKind?: GalleryMediaKind | null;
  album?: string | null;
  /** Raw `query=` search when owned navigation is enabled for this deployment; else null. */
  navigationSearch?: string | null;
  /** True only when the deployment enabled derived renditions (SQL144 installed). */
  renditionsEnabled?: boolean;
}) {
  return (
    <AuthenticatedWorkspace>
      <Gallery
        mediaItemId={mediaItemId}
        mediaKind={mediaKind}
        album={album}
        navigationSearch={navigationSearch}
        renditionsEnabled={renditionsEnabled}
      />
    </AuthenticatedWorkspace>
  );
}
