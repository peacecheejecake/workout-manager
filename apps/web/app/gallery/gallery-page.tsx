'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { GalleryWorkspace } from '@workout/modules-gallery/gallery-workspace';
import type { GalleryMediaKind } from '@workout/contracts/gallery';

function Gallery({
  mediaItemId,
  mediaKind,
  album,
}: {
  mediaItemId: string | null;
  mediaKind: GalleryMediaKind | null;
  album: string | null;
}) {
  const session = useAuthenticatedSession();
  return (
    <GalleryWorkspace
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      transport={session.transport}
      mediaTransfer={{
        upload: (input) => session.fileTransfer.uploadGalleryMedia(input),
        open: (input) => session.fileTransfer.openGalleryMedia(input),
      }}
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
}: {
  mediaItemId?: string | null;
  mediaKind?: GalleryMediaKind | null;
  album?: string | null;
}) {
  return (
    <AuthenticatedWorkspace>
      <Gallery mediaItemId={mediaItemId} mediaKind={mediaKind} album={album} />
    </AuthenticatedWorkspace>
  );
}
